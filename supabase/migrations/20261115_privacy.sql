ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS hide_online boolean NOT NULL DEFAULT false;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS allow_calls boolean NOT NULL DEFAULT true;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS allow_friend_requests boolean NOT NULL DEFAULT true;
