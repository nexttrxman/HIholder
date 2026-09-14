-- =====================================================================
-- TronKeeper — MIGRACION v3.4 — mision de compartir + manuales por periodo
-- =====================================================================
-- Pegar TODO este archivo en el SQL Editor de Supabase y correr.
-- Es idempotente: se puede ejecutar dos veces sin romper nada.
-- Requiere v2.9 + v3.0 + v3.1 + v3.2 + v3.3 aplicados (diagnose.sql lo confirma).
--
-- Que hace:
--   1. social_missions.share_text: texto para el boton "Share on Telegram".
--   2. request/approve/reject manuales ahora respetan `repeat` (weekly/daily),
--      no solo 'once'. Retrocompatible con First Deposit.
--   3. Mision tg_share: compartir en Telegram, 0.20 USDT + 500 KEEP, semanal,
--      aprobacion manual.
--
-- v3.4 — misiones para compartir + manuales por periodo
-- =============================================
-- 1) share_text: si la mision trae texto aca, el frontend muestra un boton
--    "Share on Telegram" que abre el selector de Telegram con el link de
--    referido y este texto. Agregar una mision de compartir es un INSERT.
ALTER TABLE social_missions ADD COLUMN IF NOT EXISTS share_text TEXT;

-- 2) MISIONES MANUALES POR PERIODO. Hasta v3.3 request/approve/reject
--    hardcodeaban period='', asi que una mision manual solo podia ser
--    'once' (First Deposit): tras el primer pago, request devolvia
--    'already' para siempre. Ahora el periodo se calcula desde `repeat`
--    (daily=hoy UTC, weekly=semana ISO, igual que complete_social_mission)
--    y approve/reject operan sobre la solicitud 'pending' cualquiera sea
--    su periodo. Retrocompatible: las 'once' siguen usando period=''.
CREATE OR REPLACE FUNCTION request_manual_mission(
  p_user_id TEXT,
  p_mission_id TEXT
) RETURNS JSONB AS $$
DECLARE
  v_mission RECORD;
  v_row user_social_missions%ROWTYPE;
  v_period TEXT;
BEGIN
  SELECT * INTO v_mission FROM social_missions
   WHERE id = p_mission_id AND enabled AND verify = 'manual';
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Unknown mission');
  END IF;

  v_period := CASE v_mission.repeat
    WHEN 'daily'  THEN (now() AT TIME ZONE 'UTC')::date::text
    WHEN 'weekly' THEN to_char(now() AT TIME ZONE 'UTC', 'IYYY-"W"IW')
    ELSE ''
  END;

  -- ¿Ya cobrada o pedida en este periodo?
  SELECT * INTO v_row FROM user_social_missions
   WHERE user_id = p_user_id AND mission_id = p_mission_id AND period = v_period;
  IF FOUND THEN
    IF v_row.status = 'paid' THEN
      RETURN jsonb_build_object('ok', false, 'error', 'already');
    END IF;
    RETURN jsonb_build_object('ok', true, 'pending', true);
  END IF;

  -- No puede haber mas de una solicitud pendiente por usuario+mision.
  SELECT * INTO v_row FROM user_social_missions
   WHERE user_id = p_user_id AND mission_id = p_mission_id AND status = 'pending';
  IF FOUND THEN
    RETURN jsonb_build_object('ok', true, 'pending', true);
  END IF;

  BEGIN
    INSERT INTO user_social_missions
      (user_id, mission_id, period, status, reward_usdt, reward_keep)
    VALUES (p_user_id, p_mission_id, v_period, 'pending',
            v_mission.reward_usdt, COALESCE(v_mission.reward_keep, 0));
  EXCEPTION WHEN unique_violation THEN
    RETURN jsonb_build_object('ok', true, 'pending', true);
  END;

  RETURN jsonb_build_object('ok', true, 'pending', true);
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION approve_mission_request(
  p_user_id TEXT,
  p_mission_id TEXT
) RETURNS JSONB AS $$
DECLARE
  v_row user_social_missions%ROWTYPE;
  v_mission RECORD;
  v_before DECIMAL(18, 8);
  v_after DECIMAL(18, 8);
  v_keep INT;
  v_keep_before DECIMAL(18, 8);
  v_keep_after DECIMAL(18, 8);
BEGIN
  SELECT * INTO v_row FROM user_social_missions
   WHERE user_id = p_user_id AND mission_id = p_mission_id AND status = 'pending'
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'No pending request');
  END IF;

  SELECT * INTO v_mission FROM social_missions WHERE id = p_mission_id;

  v_keep := CASE WHEN v_row.reward_keep > 0 THEN v_row.reward_keep
                 ELSE 500 + floor(random() * 701)::int END;

  SELECT usdt_balance, keep_balance INTO v_before, v_keep_before FROM internal_wallets
   WHERE user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO internal_wallets (user_id, usdt_balance)
    VALUES (p_user_id, 0)
    RETURNING usdt_balance, keep_balance INTO v_before, v_keep_before;
  END IF;
  v_after := v_before + v_row.reward_usdt;
  v_keep_after := v_keep_before + v_keep;

  UPDATE internal_wallets
     SET usdt_balance = v_after, keep_balance = v_keep_after, updated_at = NOW()
   WHERE user_id = p_user_id;

  INSERT INTO wallet_ledger (
    user_id, operation, reference_type, reference_id, asset, amount,
    balance_before, balance_after, description
  ) VALUES (
    p_user_id, 'mission_reward', 'social_mission', NULLIF(v_row.period, ''), 'USDT',
    v_row.reward_usdt, v_before, v_after, format('Mission approved: %s', v_mission.title)
  );

  INSERT INTO wallet_ledger (
    user_id, operation, reference_type, reference_id, asset, amount,
    balance_before, balance_after, description
  ) VALUES (
    p_user_id, 'mission_reward', 'social_mission', NULLIF(v_row.period, ''), 'KEEP',
    v_keep, v_keep_before, v_keep_after, format('Mission KEEP approved: %s', v_mission.title)
  );

  UPDATE user_social_missions
     SET status = 'paid', reward_keep = v_keep, completed_at = NOW()
   WHERE user_id = p_user_id AND mission_id = p_mission_id AND period = v_row.period;

  RETURN jsonb_build_object('ok', true, 'reward', v_row.reward_usdt,
    'keep_reward', v_keep, 'keep_balance', v_keep_after);
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION reject_mission_request(
  p_user_id TEXT,
  p_mission_id TEXT
) RETURNS JSONB AS $$
DECLARE
  v_count INT;
BEGIN
  DELETE FROM user_social_missions
   WHERE user_id = p_user_id AND mission_id = p_mission_id AND status = 'pending';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count = 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'No pending request');
  END IF;
  RETURN jsonb_build_object('ok', true);
END;
$$ LANGUAGE plpgsql;

-- 3) MISION: compartir en Telegram. Telegram no permite verificar
--    historias/estados, asi que verify='manual' (el admin aprueba en
--    /admin). Repetible semanal: 0.50 USDT + 1500 KEEP por semana ISO.
INSERT INTO social_missions
  (id, platform, title, description, url, reward_usdt, verify, chat_id,
   enabled, sort, reward_keep, repeat, goal, progress_type, share_text)
VALUES
  ('tg_share', 'telegram', 'Share on Telegram',
   'Share TronKeeper on your Telegram story or status, then request review.',
   '', 0.50, 'manual', NULL, true, 14, 1500, 'weekly', NULL, NULL,
   '🎁 I''m earning daily on Keeper — Hold, Claim, Trade and get paid. Join me!')
ON CONFLICT (id) DO UPDATE SET
  platform      = EXCLUDED.platform,
  title         = EXCLUDED.title,
  description   = EXCLUDED.description,
  url           = EXCLUDED.url,
  reward_usdt   = EXCLUDED.reward_usdt,
  verify        = EXCLUDED.verify,
  enabled       = EXCLUDED.enabled,
  sort          = EXCLUDED.sort,
  reward_keep   = EXCLUDED.reward_keep,
  repeat        = EXCLUDED.repeat,
  goal          = EXCLUDED.goal,
  progress_type = EXCLUDED.progress_type,
  share_text    = EXCLUDED.share_text;
