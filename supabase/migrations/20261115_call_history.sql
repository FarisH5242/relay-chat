CREATE TABLE IF NOT EXISTS public.relay_call_history (
 id uuid PRIMARY KEY,
 caller uuid REFERENCES public.profiles(id) ON DELETE CASCADE NOT NULL,
 callee uuid REFERENCES public.profiles(id) ON DELETE CASCADE NOT NULL,
 video boolean NOT NULL,
 started_at timestamptz NOT NULL,
 accepted_at timestamptz,
 ended_at timestamptz NOT NULL,
 reason text NOT NULL
);
ALTER TABLE public.relay_call_history ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS relay_calls_caller_idx ON public.relay_call_history(caller,ended_at DESC);
CREATE INDEX IF NOT EXISTS relay_calls_callee_idx ON public.relay_call_history(callee,ended_at DESC);
