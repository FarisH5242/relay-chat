-- Run this once in Supabase SQL Editor for an existing Relay database.
-- Keep signups working when the requested username is already taken.
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
