create table public.profiles (id uuid primary key references auth.users(id) on delete cascade, username text not null unique check(username ~ '^[a-z0-9_]{3,24}$'), created_at timestamptz default now());
create table public.conversations (id uuid primary key default gen_random_uuid(), created_at timestamptz default now());
create table public.conversation_members (conversation_id uuid references public.conversations(id) on delete cascade, user_id uuid references public.profiles(id) on delete cascade, primary key(conversation_id,user_id));
create table public.messages (id uuid primary key default gen_random_uuid(), conversation_id uuid not null references public.conversations(id) on delete cascade, sender_id uuid not null references public.profiles(id), body text not null check (char_length(body) between 1 and 2000), created_at timestamptz default now());
create index messages_recent on public.messages(conversation_id,created_at desc);
create index members_by_user on public.conversation_members(user_id);
alter table public.profiles enable row level security;
alter table public.conversations enable row level security;
alter table public.conversation_members enable row level security;
alter table public.messages enable row level security;
create policy "Profiles visible to signed in users" on public.profiles for select to authenticated using(true);
create policy "Users create own profile" on public.profiles for insert to authenticated with check(auth.uid() = id);

-- Automatically provision profiles for signups, including email-confirmation flows.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  requested_username text;
  candidate text;
  suffix integer := 0;
begin
  requested_username := lower(coalesce(new.raw_user_meta_data ->> 'username', ''));
  if requested_username !~ '^[a-z0-9_]{3,24}$' then
    requested_username := 'user_' || substr(replace(new.id::text, '-', ''), 1, 12);
  end if;

  loop
    candidate := case
      when suffix = 0 then requested_username
      else left(requested_username, 24 - length(suffix::text) - 1) || '_' || suffix::text
    end;
    begin
      insert into public.profiles (id, username) values (new.id, candidate);
      exit;
    exception when unique_violation then
      -- A duplicate username should not roll back auth.users creation.
      -- A duplicate profile ID is a separate integrity error.
      if exists (select 1 from public.profiles where id = new.id) then
        raise;
      end if;
      suffix := suffix + 1;
    end;
  end loop;
  return new;
end;
$$;
create trigger on_auth_user_created
after insert on auth.users
for each row execute procedure public.handle_new_user();
