-- Relay 2.1: private attachments, avatars and read receipts
alter table public.profiles add column if not exists avatar_path text;
alter table public.messages add column if not exists attachment_path text;
alter table public.messages add column if not exists attachment_name text;
alter table public.conversation_members add column if not exists last_read_at timestamptz;
create index if not exists messages_attachment_path_idx on public.messages(attachment_path) where attachment_path is not null;
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values ('relay-files','relay-files',false,2097152,array['image/png','image/jpeg','image/webp','image/gif','application/pdf','text/plain'])
on conflict(id) do update set public=false,file_size_limit=2097152,allowed_mime_types=excluded.allowed_mime_types;
-- The private bucket has no public storage policies. Only the service-role API
-- can upload or sign URLs after authenticating the user and checking membership.
