-- Relay account reliability repair. Run once in Supabase SQL Editor.
-- Idempotent: safe to rerun; existing profiles and usernames are preserved.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  requested text := lower(coalesce(new.raw_user_meta_data ->> 'username',''));
  candidate text;
  attempt integer := 0;
begin
  if requested !~ '^[a-z0-9_]{3,24}$' then
    requested := 'user_' || substr(replace(new.id::text,'-',''),1,12);
  end if;
  loop
    candidate := case when attempt = 0 then requested
      else left(requested,24-length(attempt::text)-1)||'_'||attempt::text end;
    insert into public.profiles(id,username) values(new.id,candidate)
      on conflict (username) do nothing;
    if found then exit; end if;
    if exists(select 1 from public.profiles where id=new.id) then exit; end if;
    attempt := attempt+1;
    if attempt > 10000 then raise exception 'Unable to allocate username'; end if;
  end loop;
  return new;
end;
$$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
for each row execute function public.handle_new_user();

-- Backfill manually created Auth users without a Relay profile.
insert into public.profiles(id,username)
select u.id,'user_'||substr(replace(u.id::text,'-',''),1,19)
from auth.users u
where not exists(select 1 from public.profiles p where p.id=u.id)
on conflict do nothing;
