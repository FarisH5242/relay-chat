ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS read_receipts boolean NOT NULL DEFAULT true;
CREATE TABLE IF NOT EXISTS public.relay_blocks (blocker uuid REFERENCES public.profiles(id) ON DELETE CASCADE, blocked uuid REFERENCES public.profiles(id) ON DELETE CASCADE, PRIMARY KEY(blocker,blocked), CHECK(blocker<>blocked));
ALTER TABLE public.relay_blocks ENABLE ROW LEVEL SECURITY;
CREATE TABLE IF NOT EXISTS public.relay_reports (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), reporter uuid REFERENCES public.profiles(id) ON DELETE SET NULL, reported uuid REFERENCES public.profiles(id) ON DELETE SET NULL, reason text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE public.relay_reports ENABLE ROW LEVEL SECURITY;
