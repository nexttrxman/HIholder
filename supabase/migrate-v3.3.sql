-- =====================================================================
-- TronKeeper — MIGRACION v3.3 — premios fijos, claim semanal TON, misiones reales
-- =====================================================================
-- Pegar TODO este archivo en el SQL Editor de Supabase y correr.
-- Es idempotente: se puede ejecutar dos veces sin romper nada.
-- Requiere v2.9 + v3.0 + v3.1 + v3.2 aplicados (diagnose.sql lo confirma).
--
-- Que hace:
--   * check-in diario fijo: 0.15 USDT + 500 KEEP (sin sorteo)
--   * semana de 7 dias: abre un CLAIM semanal (1.5 USDT + 2000 KEEP) que se
--     cobra pagando 0.15 TON via TonConnect; vence al fin de la semana ISO
--   * claims acepta claim_type='weekly' (cycle_id pasa a ser nullable)
--   * credit_claim: el semanal paga 2000 KEEP fijos
--   * misiones reales: First Deposit (1 USDT + 3000 KEEP, aprobacion manual),
--     Daily Holder (0.10 USDT, diaria), Social Butterfly (0.50 USDT, semanal),
--     Big Earner (2.00 USDT, unica) — progreso verificado en el servidor
--   * user_social_missions: PK (user, mision, periodo) + estado pending/paid
--   * bonus de referido pasa de 2 TRX a 2 USDT (premios no pagan TRX)
--   * permisos: solo service_role ejecuta las funciones nuevas
--
-- El cuerpo de esta migracion es byte a byte el bloque v3.3 de schema.sql.
-- =====================================================================

-- =============================================
-- v3.3 — check-in de premios fijos, claim semanal por TON y misiones reales
-- =============================================
-- Economia nueva (todo paga USDT + KEEP; los premios NO pagan TRX):
--   check-in diario        0.15 USDT + 500 KEEP fijos (sin sorteo)
--   semana de 7 dias       1.5 USDT + 2000 KEEP mediante CLAIM: al 7mo dia se
--                          abre un claim semanal (claims.claim_type='weekly'),
--                          el usuario paga 0.15 TON por TonConnect para cobrarlo
--                          y vence al FIN de la semana ISO (lunes 00:00 UTC).
--   mision First Deposit   1 USDT + 3000 KEEP fijos, verify='manual': el
--                          usuario la solicita y el admin la aprueba cuando
--                          ve el deposito (min 5 TRX o 1 USDT, solo exhibido).
--   mision Daily Holder    0.10 USDT + 500–1200 KEEP, repetible diaria
--                          (3 holds iniciados hoy — tabla holds).
--   mision Social Butterfly 0.50 USDT + 500–1200 KEEP, repetible semanal
--                          (5 amigos referidos en la semana ISO).
--   mision Big Earner      2.00 USDT + 500–1200 KEEP, unica
--                          (10 USDT ganados en claims de holds).
--   bonus de referido      2 USDT (antes 2 TRX).
-- Las misiones sociales existentes (canal/comunidad) no cambian: siguen
-- pagando 0.4 USDT + 500–1200 KEEP aleatorios con verify='telegram_member'.

-- 1) claims: ahora tambien acepta claims semanales (sin ciclo de hold).
ALTER TABLE claims ALTER COLUMN cycle_id DROP NOT NULL;
ALTER TABLE claims ADD COLUMN IF NOT EXISTS claim_type TEXT NOT NULL DEFAULT 'hold';
ALTER TABLE claims DROP CONSTRAINT IF EXISTS claims_claim_type_check;
ALTER TABLE claims ADD CONSTRAINT claims_claim_type_check
  CHECK (claim_type IN ('hold', 'weekly'));
ALTER TABLE claims ADD COLUMN IF NOT EXISTS week_key TEXT;
-- Un unico claim semanal por usuario y semana ISO.
CREATE UNIQUE INDEX IF NOT EXISTS uq_weekly_claim_per_week
  ON claims (user_id, week_key) WHERE claim_type = 'weekly';

-- 2) CHECK-IN v3.3: diario fijo 0.15 USDT + 500 KEEP; el dia 7 abre el claim
--    semanal (1.5 USDT + 2000 KEEP) en vez de acreditar el bono directo.
CREATE OR REPLACE FUNCTION daily_checkin(p_user_id TEXT)
RETURNS JSON AS $$
DECLARE
  v_today   DATE   := (now() AT TIME ZONE 'UTC')::date;
  v_week    TEXT   := to_char(now() AT TIME ZONE 'UTC', 'IYYY-"W"IW');
  v_wallet  internal_wallets%ROWTYPE;
  v_prev    checkins%ROWTYPE;
  v_streak  INT;
  v_days    INT;
  v_daily   CONSTANT NUMERIC := 0.15;   -- premio diario fijo (USDT)
  v_weekly  CONSTANT NUMERIC := 1.50;   -- premio semanal (USDT), via claim TON
  v_keep    CONSTANT INT := 500;        -- KEEP diario fijo
  v_before  NUMERIC;
  v_after   NUMERIC;
  v_kb      NUMERIC;
  v_claim_id TEXT;
  v_claim_exp TIMESTAMPTZ;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM users WHERE telegram_id = p_user_id) THEN
    RETURN json_build_object('ok', FALSE, 'error', 'user_not_found');
  END IF;

  -- ¿Ya hizo check-in hoy?
  SELECT streak INTO v_streak FROM checkins
    WHERE user_id = p_user_id AND checkin_date = v_today;
  IF FOUND THEN
    SELECT count(*) INTO v_days FROM checkins
      WHERE user_id = p_user_id AND week_key = v_week;
    SELECT claim_id, expires_at INTO v_claim_id, v_claim_exp FROM claims
      WHERE user_id = p_user_id AND claim_type = 'weekly'
        AND week_key = v_week AND status = 'pending';
    RETURN json_build_object(
      'ok', FALSE, 'error', 'already_checked_in',
      'streak', v_streak, 'days_this_week', v_days,
      'daily_reward', v_daily, 'weekly_bonus', 0,
      'weekly_bonus_amount', v_weekly,
      'weekly_complete', v_days >= 7,
      'keep_reward', 0, 'keep_weekly', 0,
      'weekly_claim_id', v_claim_id,
      'weekly_claim_expires', v_claim_exp
    );
  END IF;

  -- La racha sólo continúa desde ayer; si no, vuelve a 1.
  SELECT * INTO v_prev FROM checkins
    WHERE user_id = p_user_id AND checkin_date = v_today - 1;
  IF FOUND THEN
    v_streak := v_prev.streak + 1;
  ELSE
    v_streak := 1;
  END IF;

  INSERT INTO checkins (user_id, checkin_date, streak, week_key)
  VALUES (p_user_id, v_today, v_streak, v_week);

  SELECT * INTO v_wallet FROM internal_wallets WHERE user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO internal_wallets (user_id, usdt_balance)
    VALUES (p_user_id, 0) RETURNING * INTO v_wallet;
  END IF;

  -- Premio diario fijo: 0.15 USDT + 500 KEEP.
  v_before := v_wallet.usdt_balance;
  v_after  := v_before + v_daily;
  v_kb     := v_wallet.keep_balance + v_keep;
  UPDATE internal_wallets
     SET usdt_balance = v_after, keep_balance = v_kb, updated_at = now()
   WHERE user_id = p_user_id;
  INSERT INTO wallet_ledger
    (user_id, operation, reference_type, reference_id, asset, amount,
     balance_before, balance_after, description)
  VALUES
    (p_user_id, 'checkin_daily', 'checkin', v_today::text, 'USDT', v_daily,
     v_before, v_after, 'Daily check-in reward');
  INSERT INTO wallet_ledger
    (user_id, operation, reference_type, reference_id, asset, amount,
     balance_before, balance_after, description)
  VALUES
    (p_user_id, 'checkin_daily', 'checkin', v_today::text, 'KEEP', v_keep,
     v_wallet.keep_balance, v_kb, 'Daily check-in KEEP reward');

  -- Semana completa: 7 días distintos de la misma semana ISO abren UN claim
  -- semanal (1.5 USDT + 2000 KEEP) que se cobra pagando 0.15 TON via
  -- TonConnect. Ya no se acredita directo: si el usuario no lo cobra antes
  -- del lunes 00:00 UTC, expire_claims_and_cycles() lo pierde.
  SELECT count(*) INTO v_days FROM checkins
    WHERE user_id = p_user_id AND week_key = v_week;

  IF v_days >= 7 AND NOT EXISTS (
       SELECT 1 FROM claims
        WHERE user_id = p_user_id AND claim_type = 'weekly' AND week_key = v_week
     ) THEN
    v_claim_id  := 'CLM_' || floor(extract(epoch from clock_timestamp()) * 1000)::bigint
                   || '_' || upper(substr(md5(random()::text), 1, 6));
    v_claim_exp := (date_trunc('week', now() AT TIME ZONE 'UTC')
                    + interval '7 days') AT TIME ZONE 'UTC';
    INSERT INTO claims
      (claim_id, user_id, cycle_id, total_prize, ton_fee, status,
       expires_at, claim_type, week_key)
    VALUES
      (v_claim_id, p_user_id, NULL, v_weekly, 0.15, 'pending',
       v_claim_exp, 'weekly', v_week);
    UPDATE checkins SET weekly_bonus_paid = TRUE
      WHERE user_id = p_user_id AND checkin_date = v_today;
  END IF;

  -- Si quedó un claim semanal vivo de esta semana, lo reportamos para que la
  -- UI muestre el CTA de cobro (también cuando el 7mo día fue uno anterior).
  IF v_claim_id IS NULL THEN
    SELECT claim_id, expires_at INTO v_claim_id, v_claim_exp FROM claims
      WHERE user_id = p_user_id AND claim_type = 'weekly'
        AND week_key = v_week AND status = 'pending';
  END IF;

  RETURN json_build_object(
    'ok', TRUE,
    'streak', v_streak,
    'days_this_week', v_days,
    'daily_reward', v_daily,
    'weekly_bonus', 0,
    'weekly_bonus_amount', v_weekly,
    'weekly_complete', v_days >= 7,
    'new_balance', v_after,
    'keep_reward', v_keep,
    'keep_weekly', 0,
    'keep_balance', v_kb,
    'weekly_claim_id', v_claim_id,
    'weekly_claim_expires', v_claim_exp
  );
END;
$$ LANGUAGE plpgsql;

-- 3) CREDIT_CLAIM v3.3: el claim semanal paga 2000 KEEP fijos (el de holds
--    sigue sorteando 500–2500). El resto del flujo es identico: el Worker ya
--    valida el pago TON on-chain y llama a esta funcion sin cambios.
CREATE OR REPLACE FUNCTION credit_claim(
  p_claim_id TEXT,
  p_tx_hash TEXT,
  p_amount DECIMAL,
  p_from_address TEXT,
  p_cooldown_hours INTEGER DEFAULT 8
) RETURNS JSONB AS $$
DECLARE
  v_claim RECORD;
  v_wallet RECORD;
  v_balance_before DECIMAL;
  v_balance_after DECIMAL;
  v_keep INT;
  v_keep_before DECIMAL;
  v_keep_after DECIMAL;
BEGIN
  SELECT * INTO v_claim FROM claims
  WHERE claim_id = p_claim_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Claim not found');
  END IF;

  IF v_claim.status = 'credited' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Claim already credited');
  END IF;

  IF v_claim.status = 'expired_unclaimed' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Claim expired');
  END IF;

  IF NOW() > v_claim.expires_at THEN
    UPDATE claims SET status = 'expired_unclaimed' WHERE claim_id = p_claim_id;
    RETURN jsonb_build_object('ok', false, 'error', 'Claim expired');
  END IF;

  IF EXISTS (SELECT 1 FROM claim_payments WHERE tx_hash = p_tx_hash) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Transaction already processed');
  END IF;

  SELECT * INTO v_wallet FROM internal_wallets
  WHERE user_id = v_claim.user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    INSERT INTO internal_wallets (user_id, usdt_balance)
    VALUES (v_claim.user_id, 0)
    RETURNING * INTO v_wallet;
  END IF;

  v_balance_before := v_wallet.usdt_balance;
  v_balance_after := v_balance_before + v_claim.total_prize;
  -- Semanal: 2000 KEEP fijos. Holds: sorteo 500–2500 (sin cambios).
  v_keep := CASE WHEN v_claim.claim_type = 'weekly'
                 THEN 2000
                 ELSE 500 + floor(random() * 2001)::int END;
  v_keep_before := v_wallet.keep_balance;
  v_keep_after := v_keep_before + v_keep;

  UPDATE internal_wallets
  SET usdt_balance = v_balance_after, keep_balance = v_keep_after
  WHERE user_id = v_claim.user_id;

  INSERT INTO claim_payments (
    claim_id, tx_hash, from_address, to_address, amount, comment,
    is_valid, tx_timestamp
  ) VALUES (
    p_claim_id, p_tx_hash, p_from_address,
    'UQCydneDGeAcamdCFS6e13Z2xoxwA5DsLkFONRdp-cavw-Th',
    p_amount, 'CLAIM:' || p_claim_id, true, NOW()
  );

  INSERT INTO wallet_ledger (
    user_id, operation, reference_type, reference_id,
    asset, amount, balance_before, balance_after, description
  ) VALUES (
    v_claim.user_id, 'claim_credit', 'claim', p_claim_id,
    'USDT', v_claim.total_prize, v_balance_before, v_balance_after,
    CASE WHEN v_claim.claim_type = 'weekly'
         THEN 'Weekly check-in prize (7 days)'
         ELSE 'Claim reward for 3 holds' END
  );

  INSERT INTO wallet_ledger (
    user_id, operation, reference_type, reference_id,
    asset, amount, balance_before, balance_after, description
  ) VALUES (
    v_claim.user_id, 'claim_credit', 'claim', p_claim_id,
    'KEEP', v_keep, v_keep_before, v_keep_after,
    CASE WHEN v_claim.claim_type = 'weekly'
         THEN 'Weekly check-in KEEP prize'
         ELSE 'Claim KEEP bonus' END
  );

  UPDATE claims
  SET status = 'credited', paid_at = NOW(), credited_at = NOW()
  WHERE claim_id = p_claim_id;

  -- El claim semanal no tiene ciclo: con cycle_id NULL este UPDATE no toca
  -- nada y el usuario sigue holdeando sin cooldown extra.
  UPDATE hold_cycles
  SET status = 'completed',
      holds_completed = 3,
      ends_at = NOW() + make_interval(hours => GREATEST(COALESCE(p_cooldown_hours, 8), 0))
  WHERE id = v_claim.cycle_id;

  PERFORM confirm_pending_referral(v_claim.user_id);

  RETURN jsonb_build_object(
    'ok', true,
    'credited', v_claim.total_prize,
    'new_balance', v_balance_after,
    'keep_credited', v_keep,
    'keep_balance', v_keep_after,
    'claim_type', v_claim.claim_type
  );
END;
$$ LANGUAGE plpgsql;

-- 4) MISIONES: repetibles (diaria/semanal), KEEP fijo por mision y progreso
--    verificable en el servidor.
ALTER TABLE social_missions ADD COLUMN IF NOT EXISTS reward_keep INT;
ALTER TABLE social_missions ADD COLUMN IF NOT EXISTS repeat TEXT NOT NULL DEFAULT 'once';
ALTER TABLE social_missions DROP CONSTRAINT IF EXISTS social_missions_repeat_check;
ALTER TABLE social_missions ADD CONSTRAINT social_missions_repeat_check
  CHECK (repeat IN ('once', 'daily', 'weekly'));
ALTER TABLE social_missions ADD COLUMN IF NOT EXISTS goal INT;
ALTER TABLE social_missions ADD COLUMN IF NOT EXISTS progress_type TEXT;
ALTER TABLE social_missions DROP CONSTRAINT IF EXISTS social_missions_progress_type_check;
ALTER TABLE social_missions ADD CONSTRAINT social_missions_progress_type_check
  CHECK (progress_type IN ('holds_today', 'referrals_week', 'hold_earnings'));
ALTER TABLE social_missions DROP CONSTRAINT IF EXISTS social_missions_verify_check;
ALTER TABLE social_missions ADD CONSTRAINT social_missions_verify_check
  CHECK (verify IN ('telegram_member', 'honor', 'manual', 'progress'));

-- Las 4 misiones nuevas (upsert: re-correr la migracion las deja canonicas).
INSERT INTO social_missions
  (id, platform, title, description, url, reward_usdt, verify, chat_id,
   enabled, sort, reward_keep, repeat, goal, progress_type)
VALUES
  ('first_deposit', 'app', 'First Deposit',
   'Make your first deposit (min 5 TRX or 1 USDT). We review it manually.',
   '', 1.00, 'manual', NULL, true, 10, 3000, 'once', NULL, NULL),
  ('daily_hold', 'app', 'Daily Holder',
   'Start 3 holds today.',
   '', 0.10, 'progress', NULL, true, 11, NULL, 'daily', 3, 'holds_today'),
  ('weekly_referral', 'app', 'Social Butterfly',
   'Invite 5 friends this week.',
   '', 0.50, 'progress', NULL, true, 12, NULL, 'weekly', 5, 'referrals_week'),
  ('big_earner', 'app', 'Big Earner',
   'Earn $10 total from holds.',
   '', 2.00, 'progress', NULL, true, 13, NULL, 'once', 10, 'hold_earnings')
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
  progress_type = EXCLUDED.progress_type;

-- 5) user_social_missions: una fila por (usuario, mision, periodo) + estado
--    para las solicitudes manuales. Periodo: '' unica, 'YYYY-MM-DD' diaria,
--    'IYYY-"W"IW' semanal.
ALTER TABLE user_social_missions ADD COLUMN IF NOT EXISTS period TEXT NOT NULL DEFAULT '';
ALTER TABLE user_social_missions ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'paid';
ALTER TABLE user_social_missions DROP CONSTRAINT IF EXISTS user_social_missions_status_check;
ALTER TABLE user_social_missions ADD CONSTRAINT user_social_missions_status_check
  CHECK (status IN ('pending', 'paid'));
ALTER TABLE user_social_missions DROP CONSTRAINT IF EXISTS user_social_missions_pkey;
ALTER TABLE user_social_missions ADD PRIMARY KEY (user_id, mission_id, period);

-- 6) COMPLETE_SOCIAL_MISSION v3.3: periodo segun repeat y KEEP fijo cuando la
--    mision lo define (reward_keep), sorteo 500–1200 cuando no.
CREATE OR REPLACE FUNCTION complete_social_mission(
  p_user_id TEXT,
  p_mission_id TEXT
) RETURNS JSONB AS $$
DECLARE
  v_mission RECORD;
  v_row user_social_missions%ROWTYPE;
  v_period TEXT;
  v_before DECIMAL(18, 8);
  v_after DECIMAL(18, 8);
  v_keep INT;
  v_keep_before DECIMAL(18, 8);
  v_keep_after DECIMAL(18, 8);
BEGIN
  SELECT * INTO v_mission FROM social_missions
   WHERE id = p_mission_id AND enabled;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Unknown or disabled mission');
  END IF;

  -- Las manuales solo se pagan via approve_mission_request (defensa doble:
  -- el Worker tampoco llama aca con verify='manual').
  IF v_mission.verify = 'manual' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'manual_review');
  END IF;

  v_period := CASE v_mission.repeat
    WHEN 'daily'  THEN (now() AT TIME ZONE 'UTC')::date::text
    WHEN 'weekly' THEN to_char(now() AT TIME ZONE 'UTC', 'IYYY-"W"IW')
    ELSE ''
  END;

  SELECT * INTO v_row FROM user_social_missions
   WHERE user_id = p_user_id AND mission_id = p_mission_id AND period = v_period;
  IF FOUND THEN
    RETURN jsonb_build_object('ok', false,
      'error', CASE WHEN v_row.status = 'paid' THEN 'already' ELSE 'pending' END);
  END IF;

  v_keep := COALESCE(v_mission.reward_keep, 500 + floor(random() * 701)::int);

  BEGIN
    INSERT INTO user_social_missions
      (user_id, mission_id, period, status, reward_usdt, reward_keep)
    VALUES (p_user_id, p_mission_id, v_period, 'paid', v_mission.reward_usdt, v_keep);
  EXCEPTION WHEN unique_violation THEN
    RETURN jsonb_build_object('ok', false, 'error', 'already');
  END;

  SELECT usdt_balance, keep_balance INTO v_before, v_keep_before FROM internal_wallets
   WHERE user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'No wallet');
  END IF;
  v_after := v_before + v_mission.reward_usdt;
  v_keep_after := v_keep_before + v_keep;

  UPDATE internal_wallets
     SET usdt_balance = v_after, keep_balance = v_keep_after, updated_at = NOW()
   WHERE user_id = p_user_id;

  INSERT INTO wallet_ledger (
    user_id, operation, reference_type, reference_id, asset, amount,
    balance_before, balance_after, description
  ) VALUES (
    p_user_id, 'mission_reward', 'social_mission', NULLIF(v_period, ''), 'USDT',
    v_mission.reward_usdt, v_before, v_after, format('Mission: %s', v_mission.title)
  );

  INSERT INTO wallet_ledger (
    user_id, operation, reference_type, reference_id, asset, amount,
    balance_before, balance_after, description
  ) VALUES (
    p_user_id, 'mission_reward', 'social_mission', NULLIF(v_period, ''), 'KEEP',
    v_keep, v_keep_before, v_keep_after, format('Mission KEEP: %s', v_mission.title)
  );

  RETURN jsonb_build_object(
    'ok', true, 'reward', v_mission.reward_usdt,
    'keep_reward', v_keep, 'keep_balance', v_keep_after, 'period', v_period
  );
END;
$$ LANGUAGE plpgsql;

-- 7) MISION MANUAL (First Deposit): el usuario solicita, el admin aprueba o
--    rechaza. La solicitud vive como fila 'pending' en user_social_missions.
CREATE OR REPLACE FUNCTION request_manual_mission(
  p_user_id TEXT,
  p_mission_id TEXT
) RETURNS JSONB AS $$
DECLARE
  v_mission RECORD;
  v_row user_social_missions%ROWTYPE;
BEGIN
  SELECT * INTO v_mission FROM social_missions
   WHERE id = p_mission_id AND enabled AND verify = 'manual';
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Unknown mission');
  END IF;

  SELECT * INTO v_row FROM user_social_missions
   WHERE user_id = p_user_id AND mission_id = p_mission_id AND period = '';
  IF FOUND THEN
    IF v_row.status = 'paid' THEN
      RETURN jsonb_build_object('ok', false, 'error', 'already');
    END IF;
    RETURN jsonb_build_object('ok', true, 'pending', true);
  END IF;

  BEGIN
    INSERT INTO user_social_missions
      (user_id, mission_id, period, status, reward_usdt, reward_keep)
    VALUES (p_user_id, p_mission_id, '', 'pending',
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
   WHERE user_id = p_user_id AND mission_id = p_mission_id AND period = ''
   FOR UPDATE;
  IF NOT FOUND OR v_row.status <> 'pending' THEN
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
    p_user_id, 'mission_reward', 'social_mission', NULL, 'USDT', v_row.reward_usdt,
    v_before, v_after, format('Mission approved: %s', v_mission.title)
  );

  INSERT INTO wallet_ledger (
    user_id, operation, reference_type, reference_id, asset, amount,
    balance_before, balance_after, description
  ) VALUES (
    p_user_id, 'mission_reward', 'social_mission', NULL, 'KEEP', v_keep,
    v_keep_before, v_keep_after, format('Mission KEEP approved: %s', v_mission.title)
  );

  UPDATE user_social_missions
     SET status = 'paid', reward_keep = v_keep, completed_at = NOW()
   WHERE user_id = p_user_id AND mission_id = p_mission_id AND period = '';

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
   WHERE user_id = p_user_id AND mission_id = p_mission_id
     AND period = '' AND status = 'pending';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count = 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'No pending request');
  END IF;
  RETURN jsonb_build_object('ok', true);
END;
$$ LANGUAGE plpgsql;

-- Para la UI de admin: quien pidio que, con cuanto se le pagaria.
CREATE OR REPLACE FUNCTION list_pending_mission_requests()
RETURNS TABLE(
  user_id TEXT, username TEXT, first_name TEXT,
  mission_id TEXT, title TEXT,
  reward_usdt NUMERIC, reward_keep INT, requested_at TIMESTAMPTZ
) AS $$
  SELECT m.user_id, u.username, u.first_name,
         m.mission_id, s.title, m.reward_usdt, m.reward_keep, m.completed_at
  FROM user_social_missions m
  JOIN social_missions s ON s.id = m.mission_id
  LEFT JOIN users u ON u.telegram_id = m.user_id
  WHERE m.status = 'pending'
  ORDER BY m.completed_at ASC;
$$ LANGUAGE sql;

-- 8) PROGRESO de las misiones automaticas: una sola fuente de verdad que el
--    Worker consulta para mostrar la barra y para decidir el verify.
CREATE OR REPLACE FUNCTION mission_progress(p_user_id TEXT)
RETURNS JSONB AS $$
DECLARE
  v_today DATE := (now() AT TIME ZONE 'UTC')::date;
  v_week_start TIMESTAMPTZ := date_trunc('week', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
  v_holds INT;
  v_refs INT;
  v_earn NUMERIC;
BEGIN
  SELECT count(*)::int INTO v_holds FROM holds
   WHERE user_id = p_user_id AND (created_at AT TIME ZONE 'UTC')::date = v_today;

  SELECT count(*)::int INTO v_refs FROM referrals
   WHERE referrer_id = p_user_id AND created_at >= v_week_start;

  SELECT COALESCE(SUM(total_prize), 0) INTO v_earn FROM claims
   WHERE user_id = p_user_id AND status = 'credited' AND claim_type = 'hold';

  RETURN jsonb_build_object(
    'holds_today', v_holds,
    'referrals_week', v_refs,
    'hold_earnings', v_earn
  );
END;
$$ LANGUAGE plpgsql;

-- 9) REFERIDOS en USDT: los premios no pagan TRX.
ALTER TABLE referrals ALTER COLUMN reward_asset SET DEFAULT 'USDT';
UPDATE referrals SET reward_asset = 'USDT' WHERE reward_asset = 'TRX' AND status = 'pending';

CREATE OR REPLACE FUNCTION confirm_pending_referral(
  p_user_id TEXT
) RETURNS JSONB AS $$
DECLARE
  v_ref RECORD;
  v_wallet RECORD;
  v_pool RECORD;
  v_has_pool BOOLEAN := false;
  v_before DECIMAL;
  v_after DECIMAL;
BEGIN
  SELECT * INTO v_ref FROM referrals
  WHERE referred_id = p_user_id AND status = 'pending'
  ORDER BY created_at
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', true, 'confirmed', false);
  END IF;

  -- Si el pool se agotó la fila queda 'pending' y se reintenta en el próximo
  -- claim, en vez de marcarla confirmada sin pagarla.
  SELECT * INTO v_pool FROM referral_pool ORDER BY id LIMIT 1 FOR UPDATE;
  v_has_pool := FOUND;
  IF v_has_pool AND v_pool.distributed + v_ref.reward_amount > v_pool.total_pool THEN
    RETURN jsonb_build_object('ok', true, 'confirmed', false, 'pool_exhausted', true);
  END IF;

  UPDATE referrals SET status = 'confirmed' WHERE id = v_ref.id;

  SELECT * INTO v_wallet FROM internal_wallets
  WHERE user_id = v_ref.referrer_id FOR UPDATE;

  IF NOT FOUND THEN
    INSERT INTO internal_wallets (user_id, usdt_balance, trx_balance, ton_balance)
    VALUES (v_ref.referrer_id, 0, 0, 0)
    RETURNING * INTO v_wallet;
  END IF;

  v_before := v_wallet.usdt_balance;
  v_after := v_before + v_ref.reward_amount;

  UPDATE internal_wallets SET usdt_balance = v_after WHERE user_id = v_ref.referrer_id;

  INSERT INTO wallet_ledger (
    user_id, operation, reference_type, reference_id,
    asset, amount, balance_before, balance_after, description
  ) VALUES (
    v_ref.referrer_id, 'referral_bonus', 'referral', v_ref.referred_id,
    'USDT', v_ref.reward_amount, v_before, v_after,
    'Referral bonus: ' || COALESCE(v_ref.referred_username, v_ref.referred_id)
  );

  IF v_has_pool THEN
    UPDATE referral_pool
    SET distributed = distributed + v_ref.reward_amount, updated_at = NOW()
    WHERE id = v_pool.id;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'confirmed', true,
    'referrer_id', v_ref.referrer_id,
    'reward_amount', v_ref.reward_amount
  );
END;
$$ LANGUAGE plpgsql;

-- 10) PERMISOS v3.3: las funciones nuevas mueven plata o leen datos de
--     usuarios; solo el Worker (service_role) las puede ejecutar.
DO $$
DECLARE
  f TEXT;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'request_manual_mission(TEXT, TEXT)',
    'approve_mission_request(TEXT, TEXT)',
    'reject_mission_request(TEXT, TEXT)',
    'list_pending_mission_requests()',
    'mission_progress(TEXT)'
  ]
  LOOP
    IF to_regprocedure(f) IS NOT NULL THEN
      EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', f);
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM authenticated', f);
      END IF;
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM anon', f);
      END IF;
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
      END IF;
    END IF;
  END LOOP;
END $$;
