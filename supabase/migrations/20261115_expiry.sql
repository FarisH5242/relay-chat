ALTER TABLE public.conversations ADD COLUMN IF NOT EXISTS disappear_seconds integer NOT NULL DEFAULT 0 CHECK(disappear_seconds IN (0,300,3600,86400,604800));
ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS expires_at timestamptz;
CREATE INDEX IF NOT EXISTS relay_message_expiry ON public.messages(expires_at) WHERE expires_at IS NOT NULL;
CREATE OR REPLACE FUNCTION public.relay_set_expiry() RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
DECLARE duration integer;
BEGIN
 IF NEW.attachment_path IS NULL THEN
 SELECT disappear_seconds INTO duration FROM public.conversations WHERE id=NEW.conversation_id;
 IF duration>0 THEN NEW.expires_at=now()+make_interval(secs=>duration); END IF;
 END IF;
 RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS relay_message_expiry_trigger ON public.messages;
CREATE TRIGGER relay_message_expiry_trigger BEFORE INSERT ON public.messages FOR EACH ROW EXECUTE FUNCTION public.relay_set_expiry();
