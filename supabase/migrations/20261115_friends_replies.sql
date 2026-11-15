create table if not exists public.relay_friends (requester uuid references public.profiles(id) on delete cascade, recipient uuid references public.profiles(id) on delete cascade, accepted boolean not null default false, primary key(requester,recipient), check(requester<>recipient)); 
alter table public.relay_friends enable row level security;
create unique index if not exists relay_friend_pair on public.relay_friends(least(requester,recipient),greatest(requester,recipient));
alter table public.messages add column if not exists reply_to uuid references public.messages(id) on delete set null;
create table if not exists public.relay_reactions(message_id uuid references public.messages(id) on delete cascade,user_id uuid references public.profiles(id) on delete cascade,emoji text not null,primary key(message_id,user_id,emoji));
alter table public.relay_reactions enable row level security;