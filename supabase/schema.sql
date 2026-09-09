-- =============================================
-- TronKeeper + TON Claims Schema
-- =============================================
-- IMPORTANTE: Ejecutar en orden en Supabase SQL Editor
-- =============================================

-- Enable extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_cron";

-- =============================================
-- USERS TABLE
-- =============================================
CREATE TABLE IF NOT EXISTS users (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  telegram_id TEXT UNIQUE NOT NULL,
  uid TEXT UNIQUE NOT NULL,
  username TEXT,
  first_name TEXT,
  last_name TEXT,
  ton_wallet_address TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_telegram_id ON users(telegram_id);
CREATE INDEX IF NOT EXISTS idx_users_uid ON users(uid);

-- =============================================
-- HOLD CYCLES TABLE
-- =============================================
-- Cada ciclo dura 8 horas
CREATE TABLE IF NOT EXISTS hold_cycles (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(telegram_id),
  started_at TIMESTAMPTZ DEFAULT NOW(),
  ends_at TIMESTAMPTZ NOT NULL,
  holds_completed INTEGER DEFAULT 0,
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'completed', 'expired')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  
  CONSTRAINT max_holds CHECK (holds_completed <= 3)
);

CREATE INDEX IF NOT EXISTS idx_hold_cycles_user_id ON hold_cycles(user_id);
CREATE INDEX IF NOT EXISTS idx_hold_cycles_status ON hold_cycles(status);
CREATE INDEX IF NOT EXISTS idx_hold_cycles_ends_at ON hold_cycles(ends_at);

-- =============================================
-- HOLDS TABLE
-- =============================================
CREATE TABLE IF NOT EXISTS holds (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(telegram_id),
  cycle_id UUID NOT NULL REFERENCES hold_cycles(id),
  hold_number INTEGER NOT NULL CHECK (hold_number BETWEEN 1 AND 3),
  prize_amount DECIMAL(18, 8) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  
  -- Un usuario solo puede tener un hold específico por ciclo
  UNIQUE(cycle_id, hold_number)
);

CREATE INDEX IF NOT EXISTS idx_holds_user_id ON holds(user_id);
CREATE INDEX IF NOT EXISTS idx_holds_cycle_id ON holds(cycle_id);

-- =============================================
-- CLAIMS TABLE
-- =============================================
CREATE TABLE IF NOT EXISTS claims (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  claim_id TEXT UNIQUE NOT NULL, -- Format: CLM_<timestamp>_<random>
  user_id TEXT NOT NULL REFERENCES users(telegram_id),
  cycle_id UUID NOT NULL REFERENCES hold_cycles(id),
  
  -- Montos
  total_prize DECIMAL(18, 8) NOT NULL, -- Suma de los 3 holds
  ton_fee DECIMAL(18, 8) NOT NULL, -- Fee en TON a pagar
  
  -- Estado
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'credited', 'expired_unclaimed')),
  
  -- Tiempos
  created_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  paid_at TIMESTAMPTZ,
  credited_at TIMESTAMPTZ,
  
  -- Solo un claim activo por ciclo
  CONSTRAINT one_active_claim_per_cycle UNIQUE (cycle_id)
);

CREATE INDEX IF NOT EXISTS idx_claims_user_id ON claims(user_id);
CREATE INDEX IF NOT EXISTS idx_claims_claim_id ON claims(claim_id);
CREATE INDEX IF NOT EXISTS idx_claims_status ON claims(status);
CREATE INDEX IF NOT EXISTS idx_claims_expires_at ON claims(expires_at);

-- Índice parcial para claims pendientes (evita procesar expirados)
CREATE INDEX IF NOT EXISTS idx_claims_pending ON claims(claim_id) WHERE status = 'pending';

-- =============================================
-- CLAIM PAYMENTS TABLE
-- =============================================
CREATE TABLE IF NOT EXISTS claim_payments (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  claim_id TEXT NOT NULL REFERENCES claims(claim_id),
  
  -- Datos de la transacción TON
  tx_hash TEXT UNIQUE NOT NULL, -- Previene doble procesamiento
  from_address TEXT NOT NULL,
  to_address TEXT NOT NULL,
  amount DECIMAL(18, 9) NOT NULL, -- TON tiene 9 decimales
  comment TEXT, -- Debe ser CLAIM:<claim_id>
  
  -- Validación
  is_valid BOOLEAN DEFAULT false,
  validation_error TEXT,
  
  -- Tiempos
  tx_timestamp TIMESTAMPTZ NOT NULL,
  processed_at TIMESTAMPTZ DEFAULT NOW(),
  
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_claim_payments_tx_hash ON claim_payments(tx_hash);
CREATE INDEX IF NOT EXISTS idx_claim_payments_claim_id ON claim_payments(claim_id);

-- =============================================
-- INTERNAL WALLETS TABLE
-- =============================================
-- Wallet interna del usuario (no on-chain)
CREATE TABLE IF NOT EXISTS internal_wallets (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id TEXT UNIQUE NOT NULL REFERENCES users(telegram_id),
  usdt_balance DECIMAL(18, 8) DEFAULT 0,
  trx_balance DECIMAL(18, 8) DEFAULT 0,
  ton_balance DECIMAL(18, 9) DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  
  CONSTRAINT positive_balances CHECK (
    usdt_balance >= 0 AND trx_balance >= 0 AND ton_balance >= 0
  )
);

CREATE INDEX IF NOT EXISTS idx_internal_wallets_user_id ON internal_wallets(user_id);

-- =============================================
-- WALLET LEDGER TABLE
-- =============================================
-- Historial de movimientos de la wallet interna
CREATE TABLE IF NOT EXISTS wallet_ledger (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(telegram_id),
  
  -- Tipo de operación
  operation TEXT NOT NULL CHECK (operation IN (
    'claim_credit', 'referral_bonus', 'deposit', 'withdrawal', 'fee_deduction',
    'trade_buy', 'trade_sell'
  )),
  
  -- Referencia
  reference_type TEXT, -- 'claim', 'referral', 'deposit', 'withdrawal'
  reference_id TEXT,
  
  -- Movimiento
  asset TEXT NOT NULL CHECK (asset IN ('USDT', 'TRX', 'TON')),
  amount DECIMAL(18, 9) NOT NULL,
  balance_before DECIMAL(18, 9) NOT NULL,
  balance_after DECIMAL(18, 9) NOT NULL,
  
  -- Metadata
  description TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wallet_ledger_user_id ON wallet_ledger(user_id);
CREATE INDEX IF NOT EXISTS idx_wallet_ledger_created_at ON wallet_ledger(created_at DESC);

-- =============================================
-- REFERRAL POOL TABLE
-- =============================================
CREATE TABLE IF NOT EXISTS referral_pool (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  total_pool DECIMAL(18, 8) DEFAULT 50000,
  distributed DECIMAL(18, 8) DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Insert initial pool
INSERT INTO referral_pool (total_pool, distributed) 
VALUES (50000, 0)
ON CONFLICT DO NOTHING;

-- =============================================
-- REFERRALS TABLE
-- =============================================
CREATE TABLE IF NOT EXISTS referrals (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  referrer_id TEXT NOT NULL REFERENCES users(telegram_id),
  referred_id TEXT NOT NULL REFERENCES users(telegram_id),
  referred_username TEXT,
  reward_amount DECIMAL(18, 8) DEFAULT 2,
  reward_asset TEXT DEFAULT 'TRX',
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(referrer_id, referred_id)
);

CREATE INDEX IF NOT EXISTS idx_referrals_referrer_id ON referrals(referrer_id);

-- =============================================
-- TRANSACTIONS TABLE (Legacy compatibility)
-- =============================================
CREATE TABLE IF NOT EXISTS transactions (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(telegram_id),
  type TEXT NOT NULL CHECK (type IN ('deposit', 'withdraw', 'reward', 'referral', 'claim')),
  asset TEXT NOT NULL CHECK (asset IN ('USDT', 'TRX', 'TON')),
  amount DECIMAL(18, 9) NOT NULL,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'failed')),
  tx_hash TEXT,
  to_address TEXT,
  from_address TEXT,
  description TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_transactions_user_id ON transactions(user_id);

-- =============================================
-- FUNCTIONS
-- =============================================

-- Función para actualizar updated_at
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Triggers
DROP TRIGGER IF EXISTS users_updated_at ON users;
CREATE TRIGGER users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS internal_wallets_updated_at ON internal_wallets;
CREATE TRIGGER internal_wallets_updated_at
  BEFORE UPDATE ON internal_wallets
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- =============================================
-- FUNCIÓN: Acreditar claim (atómico e idempotente)
-- =============================================
-- =============================================
-- REFERRALS (v2.7.0)
-- =============================================
-- El registro y el pago de referidos no existían: nada insertaba en referrals,
-- así que la tabla estaba siempre vacía y el panel no actualizaba nunca.
--
-- Flujo: la app se abre con ?startapp=<uid>, Telegram pone ese valor en
-- start_param dentro del initData, el Worker llama a register_referral y queda
-- una fila en status 'pending'. El pago se dispara en el PRIMER CLAIM del
-- referido: credit_claim llama a confirm_pending_referral, que marca
-- 'confirmed', acredita 2 TRX al referente y descuenta del pool.

CREATE OR REPLACE FUNCTION register_referral(
  p_referrer_uid TEXT,
  p_referred_id TEXT,
  p_referred_username TEXT DEFAULT NULL
) RETURNS JSONB AS $$
DECLARE
  v_referrer RECORD;
  v_rows INTEGER := 0;
BEGIN
  IF p_referrer_uid IS NULL OR length(trim(p_referrer_uid)) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'missing_referrer_uid');
  END IF;

  SELECT telegram_id INTO v_referrer FROM users WHERE uid = p_referrer_uid;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'referrer_not_found');
  END IF;

  IF v_referrer.telegram_id = p_referred_id THEN
    RETURN jsonb_build_object('ok', false, 'error', 'self_referral');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM users WHERE telegram_id = p_referred_id) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'referred_user_not_found');
  END IF;

  INSERT INTO referrals (
    referrer_id, referred_id, referred_username,
    reward_amount, reward_asset, status
  ) VALUES (
    v_referrer.telegram_id, p_referred_id, p_referred_username,
    2, 'TRX', 'pending'
  )
  ON CONFLICT (referrer_id, referred_id) DO NOTHING;

  GET DIAGNOSTICS v_rows = ROW_COUNT;

  RETURN jsonb_build_object(
    'ok', true,
    'registered', v_rows > 0,
    'referrer_id', v_referrer.telegram_id
  );
END;
$$ LANGUAGE plpgsql;


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

  v_before := v_wallet.trx_balance;
  v_after := v_before + v_ref.reward_amount;

  UPDATE internal_wallets SET trx_balance = v_after WHERE user_id = v_ref.referrer_id;

  INSERT INTO wallet_ledger (
    user_id, operation, reference_type, reference_id,
    asset, amount, balance_before, balance_after, description
  ) VALUES (
    v_ref.referrer_id, 'referral_bonus', 'referral', v_ref.referred_id,
    'TRX', v_ref.reward_amount, v_before, v_after,
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


CREATE OR REPLACE FUNCTION credit_claim(
  p_claim_id TEXT,
  p_tx_hash TEXT,
  p_amount DECIMAL,
  p_from_address TEXT
) RETURNS JSONB AS $$
DECLARE
  v_claim RECORD;
  v_wallet RECORD;
  v_balance_before DECIMAL;
  v_balance_after DECIMAL;
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
  
  -- Actualizar balance
  UPDATE internal_wallets 
  SET usdt_balance = v_balance_after
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
  
  -- Marcar claim como acreditado
  UPDATE claims 
  SET status = 'credited', paid_at = NOW(), credited_at = NOW()
  WHERE claim_id = p_claim_id;
  
  -- Marcar ciclo como completado
  UPDATE hold_cycles 
  SET status = 'completed'
  WHERE id = v_claim.cycle_id;
  
  -- Primer claim del usuario: pagar el referido pendiente que lo trajo.
  PERFORM confirm_pending_referral(v_claim.user_id);
  
  RETURN jsonb_build_object(
    'ok', true, 
    'credited', v_claim.total_prize,
    'new_balance', v_balance_after
  );
END;
$$ LANGUAGE plpgsql;

-- =============================================
-- CRON JOB: Expirar claims vencidos (cada minuto)
-- =============================================
-- Requiere pg_cron habilitado en Supabase:
--   Project Settings -> Database -> Extensions -> habilitar "pg_cron"
-- (En Supabase ya está disponible; CREATE EXTENSION arriba lo activa.)

-- Función reutilizable (también ejecutable manualmente)
CREATE OR REPLACE FUNCTION expire_claims_and_cycles() RETURNS void AS $$
BEGIN
  -- v2.8.1 (vuelve a la regla original): un claim que expiró sin pagarse se
  -- pierde y los 3 holds con él. El ciclo vuelve a 0 holds para que el usuario
  -- pueda holdear de nuevo enseguida, sin esperar a que termine la ventana de
  -- 8 h. El bloqueo de 8 horas rige solo tras un claim exitoso: el ciclo queda
  -- en 3/3 y /hold lo rechaza hasta que vence.
  --
  -- El UPDATE va primero y usa las filas que estamos por expirar: este job corre
  -- cada minuto y casi siempre gana la carrera contra /auth.
  UPDATE hold_cycles hc
  SET holds_completed = 0
  FROM claims c
  WHERE c.status = 'pending'
    AND c.expires_at < NOW()
    AND c.cycle_id = hc.id
    AND hc.status = 'active'
    AND hc.holds_completed > 0;

  UPDATE claims
  SET status = 'expired_unclaimed'
  WHERE status = 'pending' AND expires_at < NOW();

  UPDATE hold_cycles
  SET status = 'expired'
  WHERE status = 'active' AND ends_at < NOW();
END;
$$ LANGUAGE plpgsql;

-- Reparación única para bases ya desplegadas: una versión intermedia conservaba
-- los 3 holds tras un claim vencido y los regeneraba desde /get-claim. Eso
-- dejaba cobrar el mismo trabajo dos veces, así que los ciclos en ese estado se
-- devuelven a 0 holds y el usuario los vuelve a hacer.
UPDATE hold_cycles hc
SET holds_completed = 0
WHERE hc.status = 'active'
  AND hc.holds_completed > 0
  AND EXISTS (
    SELECT 1 FROM claims c WHERE c.cycle_id = hc.id AND c.status = 'expired_unclaimed'
  )
  AND NOT EXISTS (
    SELECT 1 FROM claims c WHERE c.cycle_id = hc.id AND c.status = 'pending'
  );

-- Programa el job una sola vez (idempotente: borra el anterior si existe)
DO $$
BEGIN
  -- Borra job previo si existe (evita duplicados al re-ejecutar el schema)
  PERFORM cron.unschedule('tronkeeper-expire-claims')
  WHERE EXISTS (
    SELECT 1 FROM cron.job WHERE jobname = 'tronkeeper-expire-claims'
  );

  PERFORM cron.schedule(
    'tronkeeper-expire-claims',
    '* * * * *',  -- cada minuto
    $cron$ SELECT expire_claims_and_cycles(); $cron$
  );
EXCEPTION WHEN undefined_table OR undefined_function OR invalid_schema_name THEN
  -- pg_cron no disponible (entorno local). Skip silently.
  -- invalid_schema_name (3F000) es lo que tira Postgres cuando el esquema "cron"
  -- no existe; sin esa condición el error escapaba y abortaba todo el script.
  RAISE NOTICE 'pg_cron not available; expire_claims_and_cycles() must be called manually.';
END $$;

-- =============================================
-- TRADE POSITIONS TABLE (simulated spot)
-- =============================================
-- Las operaciones se ejecutan contra el saldo interno de USDT: es un
-- simulador para aprender a tradear, no mueve fondos on-chain.
CREATE TABLE IF NOT EXISTS trade_positions (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(telegram_id),
  pair TEXT NOT NULL,                      -- TONUSDT, BTCUSDT, ...
  side TEXT NOT NULL DEFAULT 'buy' CHECK (side IN ('buy', 'sell')),
  qty DECIMAL(28, 12) NOT NULL CHECK (qty > 0),
  entry_price DECIMAL(28, 12) NOT NULL CHECK (entry_price > 0),
  exit_price DECIMAL(28, 12),
  cost_basis DECIMAL(28, 12) NOT NULL,     -- qty * entry_price
  take_profit DECIMAL(28, 12),             -- precio objetivo (opcional)
  stop_loss DECIMAL(28, 12),               -- precio de corte (opcional)
  fee_paid DECIMAL(28, 12) NOT NULL DEFAULT 0,   -- fee de apertura
  fee_paid_close DECIMAL(28, 12) DEFAULT 0,      -- fee de cierre
  credit DECIMAL(28, 12),                  -- USDT devuelto al cerrar
  realized_pnl DECIMAL(28, 12),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  opened_at TIMESTAMPTZ DEFAULT NOW(),
  closed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_trade_positions_user_id ON trade_positions(user_id);
CREATE INDEX IF NOT EXISTS idx_trade_positions_user_status ON trade_positions(user_id, status);
CREATE INDEX IF NOT EXISTS idx_trade_positions_opened_at ON trade_positions(opened_at DESC);

-- =============================================
-- Ledger: permitir operaciones de trading
-- (necesario en bases ya creadas con el CHECK viejo)
-- =============================================
ALTER TABLE wallet_ledger DROP CONSTRAINT IF EXISTS wallet_ledger_operation_check;
ALTER TABLE wallet_ledger ADD CONSTRAINT wallet_ledger_operation_check CHECK (operation IN (
  'claim_credit', 'referral_bonus', 'deposit', 'withdrawal', 'fee_deduction',
  'trade_buy', 'trade_sell'
));

-- =============================================
-- FUNCIÓN: abrir posición (atómica)
-- NOTA: esta firma de 4 parámetros queda reemplazada más abajo por la versión
-- con Take Profit / Stop Loss (v2.4). Se deja por historial.
-- =============================================
CREATE OR REPLACE FUNCTION open_trade(
  p_user_id TEXT,
  p_pair TEXT,
  p_amount DECIMAL,   -- USDT a invertir (notional)
  p_price DECIMAL     -- precio de fill validado por el worker
) RETURNS JSONB AS $$
DECLARE
  v_wallet RECORD;
  v_fee DECIMAL;
  v_total DECIMAL;
  v_qty DECIMAL;
  v_balance_before DECIMAL;
  v_balance_after DECIMAL;
  v_position RECORD;
  v_fee_rate CONSTANT DECIMAL := 0.001;   -- 0.1% por lado (debe coincidir con TRADE_CONFIG.FEE_RATE)
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 OR p_price IS NULL OR p_price <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Invalid amount or price');
  END IF;

  SELECT * INTO v_wallet FROM internal_wallets
  WHERE user_id = p_user_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Wallet not found');
  END IF;

  v_fee := p_amount * v_fee_rate;
  v_total := p_amount + v_fee;
  v_qty := p_amount / p_price;
  v_balance_before := v_wallet.usdt_balance;

  IF v_total > v_balance_before THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Insufficient USDT balance');
  END IF;

  v_balance_after := v_balance_before - v_total;

  INSERT INTO trade_positions (
    user_id, pair, side, qty, entry_price, cost_basis, fee_paid, status
  ) VALUES (
    p_user_id, p_pair, 'buy', v_qty, p_price, p_amount, v_fee, 'open'
  ) RETURNING * INTO v_position;

  UPDATE internal_wallets
  SET usdt_balance = v_balance_after
  WHERE user_id = p_user_id;

  INSERT INTO wallet_ledger (
    user_id, operation, reference_type, reference_id,
    asset, amount, balance_before, balance_after, description
  ) VALUES (
    p_user_id, 'trade_buy', 'trade', v_position.id::text,
    'USDT', v_total, v_balance_before, v_balance_after,
    'Buy ' || p_pair || ' @ ' || p_price
  );

  RETURN jsonb_build_object(
    'ok', true,
    'new_balance', v_balance_after,
    'position', jsonb_build_object(
      'id', v_position.id,
      'pair', v_position.pair,
      'qty', v_position.qty,
      'entry_price', v_position.entry_price,
      'cost_basis', v_position.cost_basis,
      'fee_paid', v_position.fee_paid,
      'status', v_position.status,
      'opened_at', v_position.opened_at
    )
  );
END;
$$ LANGUAGE plpgsql;

-- =============================================
-- FUNCIÓN: cerrar posición (atómica)
-- =============================================
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
-- VENDER ACTIVO DE LA WALLET INTERNA (v2.8)
-- =============================================
-- close_trade liquida una posición abierta del book simulado. Esto es otra
-- cosa: convierte a USDT un activo que el usuario ya tenía acreditado en la
-- wallet interna —típicamente el bonus de referidos en TRX— sin que haya
-- pasado por una posición. Sin esto ese saldo quedaba trabado: se veía en la
-- wallet pero no había forma de usarlo.
CREATE OR REPLACE FUNCTION sell_wallet_asset(
  p_user_id TEXT,
  p_asset TEXT,
  p_amount DECIMAL,
  p_price DECIMAL
) RETURNS JSONB AS $$
DECLARE
  v_wallet RECORD;
  v_have DECIMAL;
  v_proceeds DECIMAL;
  v_fee DECIMAL;
  v_credit DECIMAL;
  v_asset_before DECIMAL;
  v_asset_after DECIMAL;
  v_usdt_before DECIMAL;
  v_usdt_after DECIMAL;
  v_fee_rate CONSTANT DECIMAL := 0.001;
BEGIN
  IF p_asset IS NULL OR p_asset NOT IN ('TRX', 'TON') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Only TRX or TON can be sold from the wallet');
  END IF;

  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Amount must be a positive number');
  END IF;

  IF p_price IS NULL OR p_price <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Invalid price');
  END IF;

  SELECT * INTO v_wallet FROM internal_wallets
  WHERE user_id = p_user_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Wallet not found');
  END IF;

  v_have := CASE WHEN p_asset = 'TRX' THEN v_wallet.trx_balance ELSE v_wallet.ton_balance END;

  IF p_amount > v_have THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'Insufficient ' || p_asset || ' balance',
      'available', v_have
    );
  END IF;

  v_proceeds := p_amount * p_price;
  v_fee := v_proceeds * v_fee_rate;
  v_credit := v_proceeds - v_fee;

  v_asset_before := v_have;
  v_asset_after := v_have - p_amount;
  v_usdt_before := v_wallet.usdt_balance;
  v_usdt_after := v_usdt_before + v_credit;

  UPDATE internal_wallets
  SET trx_balance  = CASE WHEN p_asset = 'TRX' THEN v_asset_after ELSE trx_balance END,
      ton_balance  = CASE WHEN p_asset = 'TON' THEN v_asset_after ELSE ton_balance END,
      usdt_balance = v_usdt_after,
      updated_at   = NOW()
  WHERE user_id = p_user_id;

  -- Dos renglones: lo que sale del activo y lo que entra en USDT.
  INSERT INTO wallet_ledger (
    user_id, operation, reference_type, reference_id,
    asset, amount, balance_before, balance_after, description
  ) VALUES (
    p_user_id, 'trade_sell', 'wallet_sale', NULL,
    p_asset, p_amount, v_asset_before, v_asset_after,
    'Sell ' || p_amount || ' ' || p_asset || ' from wallet @ ' || p_price
  );

  INSERT INTO wallet_ledger (
    user_id, operation, reference_type, reference_id,
    asset, amount, balance_before, balance_after, description
  ) VALUES (
    p_user_id, 'trade_sell', 'wallet_sale', NULL,
    'USDT', v_credit, v_usdt_before, v_usdt_after,
    'Wallet sale ' || p_asset || ' -> USDT (fee ' || v_fee || ')'
  );

  RETURN jsonb_build_object(
    'ok', true,
    'asset', p_asset,
    'amount', p_amount,
    'price', p_price,
    'fee', v_fee,
    'credit', v_credit,
    'new_balance', v_usdt_after,
    'asset_balance', v_asset_after
  );
END;
$$ LANGUAGE plpgsql;

-- =============================================
-- ORDER LIMITS: Take Profit / Stop Loss (v2.4)
-- =============================================
-- Bases ya creadas: agregar las columnas si no existen.
ALTER TABLE trade_positions ADD COLUMN IF NOT EXISTS take_profit DECIMAL(28, 12);
ALTER TABLE trade_positions ADD COLUMN IF NOT EXISTS stop_loss DECIMAL(28, 12);

-- La firma de open_trade cambia (2 parametros nuevos): dropear la anterior
-- para que PostgREST no tenga dos funciones con el mismo nombre.
DROP FUNCTION IF EXISTS open_trade(TEXT, TEXT, DECIMAL, DECIMAL);

CREATE OR REPLACE FUNCTION open_trade(
  p_user_id TEXT,
  p_pair TEXT,
  p_amount DECIMAL,        -- USDT a invertir (notional)
  p_price DECIMAL,         -- precio de fill validado por el worker
  p_take_profit DECIMAL DEFAULT NULL,
  p_stop_loss DECIMAL DEFAULT NULL
) RETURNS JSONB AS $$
DECLARE
  v_wallet RECORD;
  v_fee DECIMAL;
  v_total DECIMAL;
  v_qty DECIMAL;
  v_balance_before DECIMAL;
  v_balance_after DECIMAL;
  v_position RECORD;
  v_fee_rate CONSTANT DECIMAL := 0.001;   -- 0.1% por lado (debe coincidir con TRADE_CONFIG.FEE_RATE)
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 OR p_price IS NULL OR p_price <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Invalid amount or price');
  END IF;

  -- Regla de negocio: en un LONG el TP va arriba del entry y el SL abajo.
  IF p_take_profit IS NOT NULL AND p_take_profit <= p_price THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Take Profit must be above the entry price');
  END IF;
  IF p_stop_loss IS NOT NULL AND p_stop_loss >= p_price THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Stop Loss must be below the entry price');
  END IF;

  SELECT * INTO v_wallet FROM internal_wallets
  WHERE user_id = p_user_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Wallet not found');
  END IF;

  v_fee := p_amount * v_fee_rate;
  v_total := p_amount + v_fee;
  v_qty := p_amount / p_price;
  v_balance_before := v_wallet.usdt_balance;

  IF v_total > v_balance_before THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Insufficient USDT balance');
  END IF;

  v_balance_after := v_balance_before - v_total;

  INSERT INTO trade_positions (
    user_id, pair, side, qty, entry_price, cost_basis, fee_paid,
    take_profit, stop_loss, status
  ) VALUES (
    p_user_id, p_pair, 'buy', v_qty, p_price, p_amount, v_fee,
    p_take_profit, p_stop_loss, 'open'
  ) RETURNING * INTO v_position;

  UPDATE internal_wallets
  SET usdt_balance = v_balance_after
  WHERE user_id = p_user_id;

  INSERT INTO wallet_ledger (
    user_id, operation, reference_type, reference_id,
    asset, amount, balance_before, balance_after, description
  ) VALUES (
    p_user_id, 'trade_buy', 'trade', v_position.id::text,
    'USDT', v_total, v_balance_before, v_balance_after,
    'Buy ' || p_pair || ' @ ' || p_price
  );

  RETURN jsonb_build_object(
    'ok', true,
    'new_balance', v_balance_after,
    'position', jsonb_build_object(
      'id', v_position.id,
      'pair', v_position.pair,
      'qty', v_position.qty,
      'entry_price', v_position.entry_price,
      'cost_basis', v_position.cost_basis,
      'fee_paid', v_position.fee_paid,
      'take_profit', v_position.take_profit,
      'stop_loss', v_position.stop_loss,
      'status', v_position.status,
      'opened_at', v_position.opened_at
    )
  );
END;
$$ LANGUAGE plpgsql;

-- =============================================
-- FUNCIÓN: editar TP/SL de una posición abierta
-- =============================================
CREATE OR REPLACE FUNCTION set_trade_levels(
  p_user_id TEXT,
  p_position_id UUID,
  p_take_profit DECIMAL,
  p_stop_loss DECIMAL
) RETURNS JSONB AS $$
DECLARE
  v_pos RECORD;
BEGIN
  SELECT * INTO v_pos FROM trade_positions
  WHERE id = p_position_id AND user_id = p_user_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Position not found');
  END IF;
  IF v_pos.status <> 'open' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Position already closed');
  END IF;
  IF p_take_profit IS NOT NULL AND p_take_profit <= v_pos.entry_price THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Take Profit must be above the entry price');
  END IF;
  IF p_stop_loss IS NOT NULL AND p_stop_loss >= v_pos.entry_price THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Stop Loss must be below the entry price');
  END IF;

  UPDATE trade_positions
  SET take_profit = p_take_profit, stop_loss = p_stop_loss
  WHERE id = p_position_id;

  RETURN jsonb_build_object(
    'ok', true,
    'take_profit', p_take_profit,
    'stop_loss', p_stop_loss
  );
END;
$$ LANGUAGE plpgsql;

-- =============================================
-- DAILY CHECK-IN  (v2.6)
-- =============================================
-- Botón de check-in diario en Missions. Un premio chico por día y un premio
-- semanal al completar 7 días de la semana ISO. Todo queda en Supabase.

-- 1) Nuevas operaciones permitidas en el ledger
ALTER TABLE wallet_ledger DROP CONSTRAINT IF EXISTS wallet_ledger_operation_check;
ALTER TABLE wallet_ledger ADD CONSTRAINT wallet_ledger_operation_check CHECK (operation IN (
  'claim_credit', 'referral_bonus', 'deposit', 'withdrawal', 'fee_deduction',
  'trade_buy', 'trade_sell', 'checkin_daily', 'checkin_weekly'
));

-- 2) Una fila por usuario por día UTC. El UNIQUE es lo que hace idempotente
--    al endpoint: dos clicks rápidos no pueden acreditar dos veces.
CREATE TABLE IF NOT EXISTS checkins (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  checkin_date DATE NOT NULL,
  streak INT NOT NULL DEFAULT 1,
  week_key TEXT NOT NULL,                 -- semana ISO, ej. '2026-W37'
  weekly_bonus_paid BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (user_id, checkin_date)
);

CREATE INDEX IF NOT EXISTS idx_checkins_user_date ON checkins(user_id, checkin_date DESC);

-- 3) Check-in atómico: acredita el premio diario y, al llegar al 7mo día de la
--    semana ISO, el bono semanal (una sola vez por semana).
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
  v_before  NUMERIC;
  v_after   NUMERIC;
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
      'weekly_complete', v_days >= 7
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
  UPDATE internal_wallets
     SET usdt_balance = v_after, updated_at = now()
   WHERE user_id = p_user_id;
  INSERT INTO wallet_ledger
    (user_id, operation, reference_type, reference_id, asset, amount,
     balance_before, balance_after, description)
  VALUES
    (p_user_id, 'checkin_daily', 'checkin', v_today::text, 'USDT', v_daily,
     v_before, v_after, 'Daily check-in reward');

  -- Bono semanal: 7 días distintos de la misma semana ISO, una sola vez.
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
    UPDATE internal_wallets
       SET usdt_balance = v_after, updated_at = now()
     WHERE user_id = p_user_id;
    INSERT INTO wallet_ledger
      (user_id, operation, reference_type, reference_id, asset, amount,
       balance_before, balance_after, description)
    VALUES
      (p_user_id, 'checkin_weekly', 'checkin', v_week, 'USDT', v_weekly,
       v_before, v_after, 'Weekly check-in bonus (7 days)');
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
    'new_balance', v_after
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- =============================================
-- DONE
-- =============================================



-- =============================================
-- RLS (v2.6.1): defensa en profundidad
-- =============================================
-- Todo acceso a la base pasa por el Worker: valida el initData de Telegram con
-- HMAC-SHA256 (lib.js validateInitData) en los 12 endpoints antes de tocar una
-- tabla, y autentica contra PostgREST con la service key, que en Supabase tiene
-- BYPASSRLS. La Mini App nunca recibe la anon key (no hay supabase-js en
-- frontend/package.json).
--
-- Por eso estas tablas quedan con RLS habilitado y SIN políticas: los roles
-- anon y authenticated no leen ni escriben nada, ni siquiera si la anon key se
-- filtrara. Verificado en supabase/tests/schema.test.mjs con un rol real sin
-- BYPASSRLS.
--
-- Si algún día se conecta un cliente directo a Supabase, hay que agregar
-- políticas explícitas ACÁ primero. No habilitar el acceso sin ellas.
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'users', 'hold_cycles', 'holds', 'claims', 'claim_payments',
    'internal_wallets', 'wallet_ledger', 'referral_pool', 'referrals',
    'transactions', 'trade_positions', 'checkins'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

-- =============================================
-- PERMISOS DE FUNCIONES (v2.6.1)
-- =============================================
-- Postgres otorga EXECUTE a PUBLIC por defecto, y Supabase expone las funciones
-- de public/ vía PostgREST. Con la anon key (que es pública por diseño) eso
-- permitía invocar estas RPC directamente, saltándose la validación de initData
-- del Worker. Se revoca de PUBLIC/anon/authenticated y se deja solo al
-- service_role, que es el que usa el Worker.
--
-- Además daily_checkin era SECURITY DEFINER: corría como postgres, o sea POR
-- ENCIMA del RLS, así que el bloque anterior no la cubría. Con RLS habilitado y
-- el Worker usando service_role (que tiene BYPASSRLS) no hace falta, y dejarla
-- era un camino para acreditarse saldo sin autenticar.
ALTER FUNCTION daily_checkin(TEXT) SECURITY INVOKER;

REVOKE EXECUTE ON FUNCTION
  credit_claim(TEXT, TEXT, DECIMAL, TEXT),
  open_trade(TEXT, TEXT, DECIMAL, DECIMAL, DECIMAL, DECIMAL),
  close_trade(TEXT, UUID, DECIMAL),
  set_trade_levels(TEXT, UUID, DECIMAL, DECIMAL),
  daily_checkin(TEXT),
  expire_claims_and_cycles(),
  register_referral(TEXT, TEXT, TEXT),
  confirm_pending_referral(TEXT),
  sell_wallet_asset(TEXT, TEXT, DECIMAL, DECIMAL)
FROM PUBLIC;

DO $$
DECLARE
  f TEXT;
  funcs TEXT[] := ARRAY[
    'credit_claim(TEXT, TEXT, DECIMAL, TEXT)',
    'open_trade(TEXT, TEXT, DECIMAL, DECIMAL, DECIMAL, DECIMAL)',
    'close_trade(TEXT, UUID, DECIMAL)',
    'set_trade_levels(TEXT, UUID, DECIMAL, DECIMAL)',
    'daily_checkin(TEXT)',
    'expire_claims_and_cycles()',
    'register_referral(TEXT, TEXT, TEXT)',
    'confirm_pending_referral(TEXT)',
    'sell_wallet_asset(TEXT, TEXT, DECIMAL, DECIMAL)'
  ];
  r TEXT;
BEGIN
  FOREACH f IN ARRAY funcs LOOP
    -- anon/authenticated solo existen en Supabase; en Postgres liso, no.
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM %I', f, r);
      END IF;
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
    END IF;
  END LOOP;
END $$;
