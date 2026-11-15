CREATE TABLE IF NOT EXISTS public.relay_scheduled (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 conversation_id uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
 sender_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
 body text NOT NULL CHECK(char_length(body) BETWEEN 1 AND 2000),
 send_at timestamptz NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','sent','failed'))
);
ALTER TABLE public.relay_scheduled ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS relay_scheduled_due ON public.relay_scheduled(send_at) WHERE state='pending';
CREATE OR REPLACE FUNCTION public.relay_deliver_scheduled(p_id uuid) RETURNS SETOF public.messages
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE job public.relay_scheduled%ROWTYPE;
BEGIN
 SELECT * INTO job FROM public.relay_scheduled WHERE id=p_id AND state='pending' AND send_at<=now() FOR UPDATE SKIP LOCKED;
 IF NOT FOUND THEN RETURN; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.conversation_members WHERE conversation_id=job.conversation_id AND user_id=job.sender_id) OR EXISTS(SELECT 1 FROM public.conversation_members m JOIN public.relay_blocks b ON (b.blocker=job.sender_id AND b.blocked=m.user_id) OR (b.blocked=job.sender_id AND b.blocker=m.user_id) WHERE m.conversation_id=job.conversation_id) THEN
 UPDATE public.relay_scheduled SET state='failed' WHERE id=p_id; RETURN;
 END IF;
 UPDATE public.relay_scheduled SET state='sent' WHERE id=p_id;
 RETURN QUERY INSERT INTO public.messages(conversation_id,sender_id,body) VALUES(job.conversation_id,job.sender_id,job.body) RETURNING *;
END; $$;
REVOKE ALL ON FUNCTION public.relay_deliver_scheduled(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.relay_deliver_scheduled(uuid) TO service_role;
