-- Server-side quotas and bans for Aluetoo AI.
-- The browser cannot read or modify usage rows; only the Edge Function service role can consume quota.
CREATE TABLE IF NOT EXISTS public.aluetoo_ai_usage (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  model_key text NOT NULL CHECK (model_key IN ('fast-lite','super-fast','pro')),
  window_started_at timestamptz NOT NULL DEFAULT now(),
  request_count integer NOT NULL DEFAULT 0 CHECK (request_count >= 0),
  PRIMARY KEY (user_id, model_key)
);

ALTER TABLE public.aluetoo_ai_usage ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.aluetoo_ai_usage FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.aluetoo_ai_usage TO service_role;

CREATE OR REPLACE FUNCTION public.aluetoo_consume_ai_quota(
  p_user_id uuid,
  p_model_key text
)
RETURNS TABLE (
  allowed boolean,
  reason text,
  used integer,
  quota_limit integer,
  bonus_remaining integer,
  reset_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_banned boolean := false;
  v_bonus integer := 0;
  v_limit integer;
  v_used integer;
  v_window timestamptz;
  v_allow boolean := false;
  v_reason text := 'ok';
BEGIN
  IF p_user_id IS NULL OR p_model_key NOT IN ('fast-lite','super-fast','pro') THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = '22023';
  END IF;

  v_limit := CASE p_model_key
    WHEN 'fast-lite' THEN 20
    WHEN 'super-fast' THEN 10
    WHEN 'pro' THEN 5
  END;

  INSERT INTO public.user_controls (user_id)
  VALUES (p_user_id)
  ON CONFLICT (user_id) DO NOTHING;

  SELECT uc.is_banned, uc.bonus_messages
  INTO v_banned, v_bonus
  FROM public.user_controls AS uc
  WHERE uc.user_id = p_user_id
  FOR UPDATE;

  IF COALESCE(v_banned, false) THEN
    RETURN QUERY SELECT false, 'banned'::text, 0, v_limit,
      COALESCE(v_bonus,0), now() + interval '6 hours';
    RETURN;
  END IF;

  INSERT INTO public.aluetoo_ai_usage AS usage_row
    (user_id, model_key, window_started_at, request_count)
  VALUES (p_user_id, p_model_key, now(), 1)
  ON CONFLICT (user_id, model_key) DO UPDATE
    SET window_started_at = CASE
          WHEN usage_row.window_started_at <= now() - interval '6 hours' THEN now()
          ELSE usage_row.window_started_at
        END,
        request_count = CASE
          WHEN usage_row.window_started_at <= now() - interval '6 hours' THEN 1
          ELSE usage_row.request_count + 1
        END
  RETURNING usage_row.request_count, usage_row.window_started_at
  INTO v_used, v_window;

  IF v_used <= v_limit THEN
    v_allow := true;
  ELSIF p_model_key = 'fast-lite' AND COALESCE(v_bonus,0) > 0 THEN
    UPDATE public.user_controls
      SET bonus_messages = bonus_messages - 1,
          updated_at = now()
      WHERE user_id = p_user_id
      RETURNING bonus_messages INTO v_bonus;
    v_allow := true;
  ELSE
    UPDATE public.aluetoo_ai_usage
      SET request_count = GREATEST(request_count - 1, 0)
      WHERE user_id = p_user_id AND model_key = p_model_key;
    v_used := GREATEST(v_used - 1, 0);
    v_reason := 'quota_exceeded';
  END IF;

  RETURN QUERY SELECT v_allow, v_reason, v_used, v_limit,
    COALESCE(v_bonus,0), v_window + interval '6 hours';
END;
$$;

REVOKE ALL ON FUNCTION public.aluetoo_consume_ai_quota(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.aluetoo_consume_ai_quota(uuid, text) TO service_role;
