-- Backfill Relay profiles for users created manually in Supabase Auth.
-- Existing profiles and usernames are left unchanged.
-- Missing usernames get a stable, unique user_<uuid-prefix> username.
insert into public.profiles (id, username)
select u.id,
       'user_' || substr(replace(u.id::text, '-', ''), 1, 19)
from auth.users as u
where not exists (select 1 from public.profiles as p where p.id = u.id)
on conflict (id) do nothing;

-- Show the actual usernames to use in Relay's "Start chat" field.
select u.email, p.username
from auth.users as u
left join public.profiles as p on p.id = u.id
order by u.created_at desc;
