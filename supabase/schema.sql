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
  UPDATE claims
  SET status = 'expired_unclaimed'
  WHERE status = 'pending' AND expires_at < NOW();

  UPDATE hold_cycles
  SET status = 'expired'
  WHERE status = 'active' AND ends_at < NOW();
END;
$$ LANGUAGE plpgsql;

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
EXCEPTION WHEN undefined_table OR undefined_function THEN
  -- pg_cron no disponible (entorno local). Skip silently.
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
-- DONE
-- =============================================

