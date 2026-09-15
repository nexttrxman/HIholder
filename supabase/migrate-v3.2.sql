-- =====================================================================
-- TronKeeper — MIGRACION v3.2 — $KEEP: moneda propia + recompensas
-- =====================================================================
-- Pegar TODO este archivo en el SQL Editor de Supabase y correr.
-- Es idempotente: se puede ejecutar dos veces sin romper nada.
-- Requiere v2.9 + v3.0 + v3.1 aplicados (diagnose.sql lo confirma).
--
-- Que hace:
--   * internal_wallets.keep_balance + CHECK de saldos positivos
--   * wallet_ledger acepta asset 'KEEP'
--   * user_social_missions.reward_keep
--   * managed_prices / managed_price_ticks + precio KEEPUSDT sembrado
--     (0.00036, banda 0.00012–0.0006, walk ±2% por minuto)
--   * buy_keep(), managed_price_tick(), managed_price_candles()
--   * daily_checkin/complete_social_mission/credit_claim pagan KEEP
--     (500–1200 / 500–1200 / 500–2500)
--   * close_trade rechaza KEEPUSDT (KEEP no se vende)
--   * RLS + permisos: solo service_role ejecuta las funciones nuevas
--
-- El cuerpo de esta migracion es byte a byte el bloque v3.2 de schema.sql.
-- Para manejar el precio a mano:
--   UPDATE managed_prices SET price = 0.0003, floor_price = 0.0003,
--     cap_price = 0.0003 WHERE pair = 'KEEPUSDT';   -- floor=cap lo fija
-- =====================================================================

-- =============================================
-- v3.2 — $KEEP: moneda propia + reestructura de recompensas
-- =============================================
-- $KEEP es el token del proyecto. Se acredita como recompensa y ademas se
-- puede COMPRAR en Trade con el USDT interno. No se puede vender: ni desde
-- la wallet (sell_wallet_asset solo acepta TRX/TON, sin cambios) ni cerrando
-- posiciones (close_trade rechaza KEEPUSDT por defensa en profundidad; el
-- Worker ni siquiera abre posiciones de KEEP).
--
-- Recompensas en KEEP (enteros, aleatorios por evento):
--   check-in diario          500–1200  (el bono semanal paga otros 500–1200)
--   mision social            500–1200
--   claim cobrado (3 holds)  500–2500
-- Cada pago queda como renglon propio del wallet_ledger con asset='KEEP' y la
-- MISMA operation que su premio en USDT (checkin_daily/checkin_weekly/
-- mission_reward/claim_credit), asi Activity los agrupa sin vocabulario nuevo.
--
-- Precio de KEEP: lo maneja el proyecto, NO un exchange. Vive en
-- managed_prices dentro de una banda [floor_price, cap_price]; un walk de
-- ±walk_step cada walk_seconds lo mueve dentro de la banda para que el
-- grafico este vivo. Para fijar el precio a mano:
--   UPDATE managed_prices SET price = 0.0003, floor_price = 0.0003,
--     cap_price = 0.0003 WHERE pair = 'KEEPUSDT';
-- (con floor = cap el walk no lo mueve). El Worker usa SIEMPRE este precio
-- como mark: el que manda el cliente solo se acepta dentro del 2% de tolerancia.

-- Saldo KEEP en la wallet interna.
ALTER TABLE internal_wallets
  ADD COLUMN IF NOT EXISTS keep_balance DECIMAL(18, 8) NOT NULL DEFAULT 0;

ALTER TABLE internal_wallets DROP CONSTRAINT IF EXISTS positive_balances;
ALTER TABLE internal_wallets
  ADD CONSTRAINT positive_balances CHECK (
    usdt_balance >= 0 AND trx_balance >= 0 AND ton_balance >= 0 AND keep_balance >= 0
  );

-- El ledger acepta el activo KEEP. Solo se AGREGA un valor a la lista, asi que
-- el CHECK nuevo valida contra el historial existente sin problema.
ALTER TABLE wallet_ledger DROP CONSTRAINT IF EXISTS wallet_ledger_asset_check;
ALTER TABLE wallet_ledger
  ADD CONSTRAINT wallet_ledger_asset_check CHECK (asset IN ('USDT', 'TRX', 'TON', 'KEEP'));

-- Cuanto KEEP pago cada mision (las completadas antes de v3.2 quedan en 0).
ALTER TABLE user_social_missions
  ADD COLUMN IF NOT EXISTS reward_keep INTEGER NOT NULL DEFAULT 0;

-- =============================================
-- PRECIOS MANEJADOS (KEEP)
-- =============================================
CREATE TABLE IF NOT EXISTS managed_prices (
  pair TEXT PRIMARY KEY,
  price NUMERIC(28, 12) NOT NULL CHECK (price > 0),
  floor_price NUMERIC(28, 12) NOT NULL CHECK (floor_price > 0),
  cap_price NUMERIC(28, 12) NOT NULL CHECK (cap_price > 0),
  walk_step NUMERIC(6, 4) NOT NULL DEFAULT 0.02 CHECK (walk_step >= 0),
  walk_seconds INT NOT NULL DEFAULT 60 CHECK (walk_seconds > 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT band_ordered CHECK (floor_price <= cap_price)
);

CREATE TABLE IF NOT EXISTS managed_price_ticks (
  id BIGSERIAL PRIMARY KEY,
  pair TEXT NOT NULL,
  ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  price NUMERIC(28, 12) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_managed_ticks_pair_ts ON managed_price_ticks (pair, ts);

INSERT INTO managed_prices (pair, price, floor_price, cap_price, walk_step, walk_seconds)
VALUES ('KEEPUSDT', 0.00036, 0.00012, 0.0006, 0.02, 60)
ON CONFLICT (pair) DO NOTHING;

-- Avanza el walk si paso walk_seconds desde el ultimo tick y devuelve el
-- precio vigente. Idempotente dentro de la ventana: dos llamadas seguidas
-- devuelven el mismo precio.
CREATE OR REPLACE FUNCTION managed_price_tick(p_pair TEXT)
RETURNS JSONB AS $$
DECLARE
  v_row  managed_prices%ROWTYPE;
  v_now  TIMESTAMPTZ := NOW();
  v_next NUMERIC;
BEGIN
  SELECT * INTO v_row FROM managed_prices WHERE pair = p_pair FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Unknown pair');
  END IF;

  IF v_row.updated_at <= v_now - make_interval(secs => v_row.walk_seconds) THEN
    v_next := v_row.price * (1 + (random() * 2 - 1) * v_row.walk_step);
    v_next := GREATEST(v_row.floor_price, LEAST(v_row.cap_price, v_next));
    v_next := round(v_next, 12);
    UPDATE managed_prices SET price = v_next, updated_at = v_now WHERE pair = p_pair;
    INSERT INTO managed_price_ticks (pair, ts, price) VALUES (p_pair, v_now, v_next);
    v_row.price := v_next;
    v_row.updated_at := v_now;
    -- Historial acotado: con un tick por minuto, 72 h son ~4300 filas por par.
    DELETE FROM managed_price_ticks
     WHERE pair = p_pair AND ts < v_now - INTERVAL '72 hours';
  END IF;

  RETURN jsonb_build_object(
    'ok', true, 'pair', p_pair, 'price', v_row.price,
    'floor', v_row.floor_price, 'cap', v_row.cap_price,
    'updated_at', v_row.updated_at
  );
END;
$$ LANGUAGE plpgsql;

-- Velas OHLC desde los ticks, mas el ultimo precio y el cambio 24 h. Es lo
-- que sirve el Worker en /price para el grafico de KEEP.
CREATE OR REPLACE FUNCTION managed_price_candles(
  p_pair TEXT,
  p_bucket_seconds INT,
  p_limit INT DEFAULT 60
) RETURNS JSONB AS $$
DECLARE
  v_tick   JSONB;
  v_candles JSONB;
  v_price  NUMERIC;
  v_prev   NUMERIC;
  v_from   TIMESTAMPTZ;
BEGIN
  IF p_bucket_seconds IS NULL OR p_bucket_seconds <= 0 OR p_limit IS NULL OR p_limit <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Invalid bucket or limit');
  END IF;

  v_tick := managed_price_tick(p_pair);
  IF NOT (v_tick->>'ok')::boolean THEN
    RETURN v_tick;
  END IF;

  SELECT price INTO v_price FROM managed_prices WHERE pair = p_pair;

  v_from := NOW() - make_interval(secs => p_bucket_seconds * p_limit);

  SELECT COALESCE(jsonb_agg(
           jsonb_build_object('t', bucket_ms, 'o', o, 'h', h, 'l', l, 'c', c, 'v', v)
           ORDER BY bucket_ms), '[]'::jsonb)
    INTO v_candles
  FROM (
    SELECT (extract(epoch FROM date_bin(
              make_interval(secs => p_bucket_seconds), ts, TIMESTAMPTZ '2000-01-01'
            )) * 1000)::bigint AS bucket_ms,
           (array_agg(price ORDER BY ts ASC))[1] AS o,
           max(price) AS h,
           min(price) AS l,
           (array_agg(price ORDER BY ts DESC))[1] AS c,
           count(*) AS v
    FROM managed_price_ticks
    WHERE pair = p_pair AND ts >= v_from
    GROUP BY 1
  ) g;

  SELECT price INTO v_prev
  FROM managed_price_ticks
  WHERE pair = p_pair AND ts >= NOW() - INTERVAL '24 hours'
  ORDER BY ts ASC
  LIMIT 1;

  RETURN jsonb_build_object(
    'ok', true,
    'pair', p_pair,
    'mode', 'managed',
    'price', v_price,
    'floor', (SELECT floor_price FROM managed_prices WHERE pair = p_pair),
    'cap', (SELECT cap_price FROM managed_prices WHERE pair = p_pair),
    'change_percent', CASE WHEN COALESCE(v_prev, 0) > 0
                           THEN (v_price - v_prev) / v_prev * 100
                           ELSE 0 END,
    'candles', v_candles
  );
END;
$$ LANGUAGE plpgsql;

-- =============================================
-- COMPRA DE KEEP (spot, sin posicion)
-- =============================================
-- Gasta USDT interno y acredita keep_balance al precio manejado. Fee 0.1%,
-- la misma que el resto del book simulado. No existe la operacion inversa:
-- KEEP no se vende.
CREATE OR REPLACE FUNCTION buy_keep(
  p_user_id TEXT,
  p_amount DECIMAL,     -- USDT a gastar (notional)
  p_price DECIMAL       -- precio manejado validado por el Worker
) RETURNS JSONB AS $$
DECLARE
  v_wallet       RECORD;
  v_fee          DECIMAL;
  v_total        DECIMAL;
  v_qty          DECIMAL;
  v_usdt_before  DECIMAL;
  v_usdt_after   DECIMAL;
  v_keep_before  DECIMAL;
  v_keep_after   DECIMAL;
  v_fee_rate     CONSTANT DECIMAL := 0.001;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 OR p_price IS NULL OR p_price <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Invalid amount or price');
  END IF;

  SELECT * INTO v_wallet FROM internal_wallets
  WHERE user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Wallet not found');
  END IF;

  v_fee   := p_amount * v_fee_rate;
  v_total := p_amount + v_fee;
  v_qty   := round(p_amount / p_price, 8);

  IF v_total > v_wallet.usdt_balance THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Insufficient USDT balance');
  END IF;

  v_usdt_before := v_wallet.usdt_balance;
  v_usdt_after  := v_usdt_before - v_total;
  v_keep_before := v_wallet.keep_balance;
  v_keep_after  := v_keep_before + v_qty;

  UPDATE internal_wallets
     SET usdt_balance = v_usdt_after,
         keep_balance = v_keep_after,
         updated_at   = NOW()
   WHERE user_id = p_user_id;

  -- Dos renglones: el USDT que sale y el KEEP que entra.
  INSERT INTO wallet_ledger (
    user_id, operation, reference_type, reference_id,
    asset, amount, balance_before, balance_after, description
  ) VALUES (
    p_user_id, 'trade_buy', 'trade', NULL,
    'USDT', v_total, v_usdt_before, v_usdt_after,
    'Buy KEEP @ ' || p_price
  );

  INSERT INTO wallet_ledger (
    user_id, operation, reference_type, reference_id,
    asset, amount, balance_before, balance_after, description
  ) VALUES (
    p_user_id, 'trade_buy', 'trade', NULL,
    'KEEP', v_qty, v_keep_before, v_keep_after,
    'Buy KEEP @ ' || p_price
  );

  RETURN jsonb_build_object(
    'ok', true,
    'qty', v_qty,
    'fee', v_fee,
    'price', p_price,
    'usdt_balance', v_usdt_after,
    'keep_balance', v_keep_after
  );
END;
$$ LANGUAGE plpgsql;

-- Defensa en profundidad: el Worker no abre posiciones de KEEP (no esta en
-- ALLOWED_PAIRS), pero si alguna existiera, no se puede liquidar.
CREATE OR REPLACE FUNCTION close_trade(
  p_user_id TEXT,
  p_position_id UUID,
  p_price DECIMAL
) RETURNS JSONB AS $$
DECLARE
  v_pos RECORD;
  v_wallet RECORD;
  v_proceeds DECIMAL;
  v_fee DECIMAL;
  v_credit DECIMAL;
  v_pnl DECIMAL;
  v_balance_before DECIMAL;
  v_balance_after DECIMAL;
  v_fee_rate CONSTANT DECIMAL := 0.001;
BEGIN
  IF p_price IS NULL OR p_price <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Invalid exit price');
  END IF;

  SELECT * INTO v_pos FROM trade_positions
  WHERE id = p_position_id AND user_id = p_user_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Position not found');
  END IF;

  IF v_pos.status <> 'open' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Position already closed');
  END IF;

  -- KEEP no se vende, ni siquiera como posicion.
  IF v_pos.pair = 'KEEPUSDT' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'KEEP cannot be sold');
  END IF;

  SELECT * INTO v_wallet FROM internal_wallets
  WHERE user_id = p_user_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Wallet not found');
  END IF;

  v_proceeds := v_pos.qty * p_price;
  v_fee := v_proceeds * v_fee_rate;
  v_credit := v_proceeds - v_fee;
  v_pnl := v_credit - v_pos.cost_basis - v_pos.fee_paid;
  v_balance_before := v_wallet.usdt_balance;
  v_balance_after := v_balance_before + v_credit;

  UPDATE trade_positions
  SET status = 'closed', exit_price = p_price, fee_paid_close = v_fee,
      credit = v_credit, realized_pnl = v_pnl, closed_at = NOW()
  WHERE id = p_position_id;

  UPDATE internal_wallets
  SET usdt_balance = v_balance_after
  WHERE user_id = p_user_id;

  INSERT INTO wallet_ledger (
    user_id, operation, reference_type, reference_id,
    asset, amount, balance_before, balance_after, description
  ) VALUES (
    p_user_id, 'trade_sell', 'trade', p_position_id::text,
    'USDT', v_credit, v_balance_before, v_balance_after,
    'Sell ' || v_pos.pair || ' @ ' || p_price || ' (PnL ' || v_pnl || ')'
  );

  RETURN jsonb_build_object(
    'ok', true,
    'pnl', v_pnl,
    'pnl_pct', CASE WHEN (v_pos.cost_basis + v_pos.fee_paid) > 0
                    THEN v_pnl / (v_pos.cost_basis + v_pos.fee_paid) ELSE 0 END,
    'credit', v_credit,
    'new_balance', v_balance_after
  );
END;
$$ LANGUAGE plpgsql;

-- =============================================
-- CHECK-IN DIARIO con KEEP (v3.2)
-- =============================================
CREATE OR REPLACE FUNCTION daily_checkin(p_user_id TEXT)
RETURNS JSON AS $$
DECLARE
  v_today   DATE   := (now() AT TIME ZONE 'UTC')::date;
  v_week    TEXT   := to_char(now() AT TIME ZONE 'UTC', 'IYYY-"W"IW');
  v_wallet  internal_wallets%ROWTYPE;
  v_prev    checkins%ROWTYPE;
  v_streak  INT;
  v_days    INT;
  v_daily   CONSTANT NUMERIC := 0.05;   -- premio por día (USDT)
  v_weekly  CONSTANT NUMERIC := 0.50;   -- bono semanal  (USDT)
  v_keep    INT;                        -- KEEP diario   (500–1200)
  v_keep_w  INT;                        -- KEEP semanal (500–1200)
  v_before  NUMERIC;
  v_after   NUMERIC;
  v_kb      NUMERIC;
  v_paid    BOOLEAN := FALSE;
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
    RETURN json_build_object(
      'ok', FALSE, 'error', 'already_checked_in',
      'streak', v_streak, 'days_this_week', v_days,
      'daily_reward', v_daily, 'weekly_bonus', v_weekly,
      'weekly_complete', v_days >= 7,
      'keep_reward', 0, 'keep_weekly', 0
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

  -- Premio diario
  v_before := v_wallet.usdt_balance;
  v_after  := v_before + v_daily;
  v_keep   := 500 + floor(random() * 701)::int;   -- 500–1200
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

  -- Bono semanal: 7 días distintos de la misma semana ISO, una sola vez.
  v_keep_w := 0;
  SELECT count(*) INTO v_days FROM checkins
    WHERE user_id = p_user_id AND week_key = v_week;

  IF v_days >= 7 AND NOT EXISTS (
       SELECT 1 FROM wallet_ledger
        WHERE user_id = p_user_id
          AND operation = 'checkin_weekly'
          AND reference_id = v_week
     ) THEN
    v_before := v_after;
    v_after  := v_after + v_weekly;
    v_keep_w := 500 + floor(random() * 701)::int; -- 500–1200
    v_kb     := v_kb + v_keep_w;
    UPDATE internal_wallets
       SET usdt_balance = v_after, keep_balance = v_kb, updated_at = now()
     WHERE user_id = p_user_id;
    INSERT INTO wallet_ledger
      (user_id, operation, reference_type, reference_id, asset, amount,
       balance_before, balance_after, description)
    VALUES
      (p_user_id, 'checkin_weekly', 'checkin', v_week, 'USDT', v_weekly,
       v_before, v_after, 'Weekly check-in bonus (7 days)');
    INSERT INTO wallet_ledger
      (user_id, operation, reference_type, reference_id, asset, amount,
       balance_before, balance_after, description)
    VALUES
      (p_user_id, 'checkin_weekly', 'checkin', v_week, 'KEEP', v_keep_w,
       v_kb - v_keep_w, v_kb, 'Weekly check-in KEEP bonus (7 days)');
    v_paid := TRUE;
    UPDATE checkins SET weekly_bonus_paid = TRUE
      WHERE user_id = p_user_id AND checkin_date = v_today;
  END IF;

  RETURN json_build_object(
    'ok', TRUE,
    'streak', v_streak,
    'days_this_week', v_days,
    'daily_reward', v_daily,
    'weekly_bonus', CASE WHEN v_paid THEN v_weekly ELSE 0 END,
    'weekly_bonus_amount', v_weekly,
    'weekly_complete', v_days >= 7,
    'new_balance', v_after,
    'keep_reward', v_keep,
    'keep_weekly', v_keep_w,
    'keep_balance', v_kb
  );
END;
$$ LANGUAGE plpgsql;

-- =============================================
-- CLAIM con bonus KEEP (v3.2)
-- =============================================
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
  -- Lock the claim row
  SELECT * INTO v_claim FROM claims
  WHERE claim_id = p_claim_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Claim not found');
  END IF;

  -- Verificar que no esté ya acreditado
  IF v_claim.status = 'credited' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Claim already credited');
  END IF;

  -- Verificar que no haya expirado
  IF v_claim.status = 'expired_unclaimed' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Claim expired');
  END IF;

  IF NOW() > v_claim.expires_at THEN
    UPDATE claims SET status = 'expired_unclaimed' WHERE claim_id = p_claim_id;
    RETURN jsonb_build_object('ok', false, 'error', 'Claim expired');
  END IF;

  -- Verificar que el tx_hash no se haya procesado
  IF EXISTS (SELECT 1 FROM claim_payments WHERE tx_hash = p_tx_hash) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Transaction already processed');
  END IF;

  -- Obtener/crear wallet interna
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
  v_keep := 500 + floor(random() * 2001)::int;   -- 500–2500
  v_keep_before := v_wallet.keep_balance;
  v_keep_after := v_keep_before + v_keep;

  -- Actualizar balance
  UPDATE internal_wallets
  SET usdt_balance = v_balance_after, keep_balance = v_keep_after
  WHERE user_id = v_claim.user_id;

  -- Registrar pago
  INSERT INTO claim_payments (
    claim_id, tx_hash, from_address, to_address, amount, comment,
    is_valid, tx_timestamp
  ) VALUES (
    p_claim_id, p_tx_hash, p_from_address,
    'UQCydneDGeAcamdCFS6e13Z2xoxwA5DsLkFONRdp-cavw-Th',
    p_amount, 'CLAIM:' || p_claim_id, true, NOW()
  );

  -- Registrar en ledger
  INSERT INTO wallet_ledger (
    user_id, operation, reference_type, reference_id,
    asset, amount, balance_before, balance_after, description
  ) VALUES (
    v_claim.user_id, 'claim_credit', 'claim', p_claim_id,
    'USDT', v_claim.total_prize, v_balance_before, v_balance_after,
    'Claim reward for 3 holds'
  );

  INSERT INTO wallet_ledger (
    user_id, operation, reference_type, reference_id,
    asset, amount, balance_before, balance_after, description
  ) VALUES (
    v_claim.user_id, 'claim_credit', 'claim', p_claim_id,
    'KEEP', v_keep, v_keep_before, v_keep_after,
    'Claim KEEP bonus'
  );

  -- Marcar claim como acreditado
  UPDATE claims
  SET status = 'credited', paid_at = NOW(), credited_at = NOW()
  WHERE claim_id = p_claim_id;

  -- El ciclo se cierra y queda BLOQUEADO p_cooldown_hours: ends_at pasa a ser el
  -- momento en que se puede volver a holdear, y /auth no abre un ciclo nuevo
  -- mientras no haya pasado.
  UPDATE hold_cycles
  SET status = 'completed',
      holds_completed = 3,
      ends_at = NOW() + make_interval(hours => GREATEST(COALESCE(p_cooldown_hours, 8), 0))
  WHERE id = v_claim.cycle_id;

  -- Primer claim del usuario: pagar el referido pendiente que lo trajo.
  PERFORM confirm_pending_referral(v_claim.user_id);

  RETURN jsonb_build_object(
    'ok', true,
    'credited', v_claim.total_prize,
    'new_balance', v_balance_after,
    'keep_credited', v_keep,
    'keep_balance', v_keep_after
  );
END;
$$ LANGUAGE plpgsql;

-- =============================================
-- MISION SOCIAL con KEEP (v3.2)
-- =============================================
CREATE OR REPLACE FUNCTION complete_social_mission(
  p_user_id TEXT,
  p_mission_id TEXT
) RETURNS JSONB AS $$
DECLARE
  v_mission RECORD;
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

  IF EXISTS (SELECT 1 FROM user_social_missions
              WHERE user_id = p_user_id AND mission_id = p_mission_id) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'already');
  END IF;

  v_keep := 500 + floor(random() * 701)::int;   -- 500–1200

  BEGIN
    INSERT INTO user_social_missions (user_id, mission_id, reward_usdt, reward_keep)
    VALUES (p_user_id, p_mission_id, v_mission.reward_usdt, v_keep);
  EXCEPTION WHEN unique_violation THEN
    -- Carrera: dos verify simultaneos. Uno gana, el otro no cobra.
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
    p_user_id, 'mission_reward', 'social_mission', NULL, 'USDT', v_mission.reward_usdt,
    v_before, v_after, format('Mission: %s', v_mission.title)
  );

  INSERT INTO wallet_ledger (
    user_id, operation, reference_type, reference_id, asset, amount,
    balance_before, balance_after, description
  ) VALUES (
    p_user_id, 'mission_reward', 'social_mission', NULL, 'KEEP', v_keep,
    v_keep_before, v_keep_after, format('Mission KEEP: %s', v_mission.title)
  );

  RETURN jsonb_build_object(
    'ok', true, 'reward', v_mission.reward_usdt,
    'keep_reward', v_keep, 'keep_balance', v_keep_after
  );
END;
$$ LANGUAGE plpgsql;

-- =============================================
-- RLS + PERMISOS v3.2
-- =============================================
ALTER TABLE managed_prices ENABLE ROW LEVEL SECURITY;
ALTER TABLE managed_price_ticks ENABLE ROW LEVEL SECURITY;

-- Las tres funciones nuevas mueven plata o leen el precio manejado: solo el
-- Worker (service_role) las puede llamar.
DO $$
DECLARE
  f TEXT;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'buy_keep(TEXT, DECIMAL, DECIMAL)',
    'managed_price_tick(TEXT)',
    'managed_price_candles(TEXT, INT, INT)'
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
