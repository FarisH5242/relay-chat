ALTER TABLE public.messages DROP CONSTRAINT IF EXISTS messages_sender_id_fkey;
ALTER TABLE public.messages ADD CONSTRAINT messages_sender_id_fkey FOREIGN KEY(sender_id) REFERENCES public.profiles(id) ON DELETE CASCADE;
REVOKE INSERT, UPDATE, DELETE ON public.profiles FROM anon, authenticated;
