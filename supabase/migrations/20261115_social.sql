alter table public.profiles add column if not exists bio text default ''; 
alter table public.profiles add column if not exists status text default '';
create index if not exists relay_messages_conversation_created_idx on public.messages(conversation_id,created_at desc);
