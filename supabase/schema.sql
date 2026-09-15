-- =============================================
-- TronKeeper + TON Claims Schema
-- =============================================
-- IMPORTANTE: Ejecutar en orden en Supabase SQL Editor
-- =============================================

-- Enable extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_cron";

-- =============================================
-- 0. MIGRACIÓN PROTEGIDA DE TABLAS PREEXISTENTES
-- =============================================
-- CREATE TABLE IF NOT EXISTS NO migra: si la tabla ya existe con otra forma, la
-- saltea en silencio y las funciones quedan referenciando columnas que no están.
-- El error recién aparece en runtime, adentro de un RPC, y se ve como un
-- "no funciona" sin causa aparente.
--
-- Este bloque revisa cada tabla que podría preexistir y, si le falta algo, la
-- renombra a <tabla>_legacy SIN BORRAR NADA. Si ya tiene la forma correcta no la
-- toca: el script es idempotente y se puede correr varias veces.
DO $$
DECLARE
  v_missing TEXT;
BEGIN
  -- users es la raíz de todas las FK. No se renombra nunca: si le falta uid,
  -- que explote acá con un mensaje claro en vez de corromper referencias.
  IF to_regclass('public.users') IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_schema='public' AND table_name='users' AND column_name='uid') THEN
      RAISE EXCEPTION 'users existe sin la columna uid. Revisala a mano antes de correr este script.';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_schema='public' AND table_name='users' AND column_name='ton_wallet_address') THEN
      ALTER TABLE public.users ADD COLUMN ton_wallet_address TEXT;
      RAISE NOTICE 'users: agregada ton_wallet_address';
    END IF;
  END IF;

  -- claims
  IF to_regclass('public.claims') IS NOT NULL THEN
    SELECT string_agg(c.col, ', ' ORDER BY c.col) INTO v_missing
    FROM (VALUES ('claim_id'),('cycle_id'),('total_prize'),('ton_fee'),('expires_at')) AS c(col)
    WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.columns x
      WHERE x.table_schema='public' AND x.table_name='claims' AND x.column_name = c.col);
    IF v_missing IS NOT NULL THEN
      -- claim_payments referencia claims(claim_id): si se renombra una, se
      -- renombra la otra, o CREATE TABLE IF NOT EXISTS dejaría la FK apuntando
      -- a la tabla legacy.
      IF to_regclass('public.claim_payments') IS NOT NULL THEN
        EXECUTE 'ALTER TABLE public.claim_payments RENAME TO claim_payments_legacy';
        RAISE NOTICE 'claim_payments -> claim_payments_legacy (se movió junto con claims)';
      END IF;
      EXECUTE 'ALTER TABLE public.claims RENAME TO claims_legacy';
      RAISE NOTICE 'claims -> claims_legacy (faltaban: %)', v_missing;
    END IF;
  END IF;

  -- transactions
  IF to_regclass('public.transactions') IS NOT NULL THEN
    SELECT string_agg(c.col, ', ' ORDER BY c.col) INTO v_missing
    FROM (VALUES ('type'),('asset'),('amount'),('status')) AS c(col)
    WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.columns x
      WHERE x.table_schema='public' AND x.table_name='transactions' AND x.column_name = c.col);
    IF v_missing IS NOT NULL THEN
      EXECUTE 'ALTER TABLE public.transactions RENAME TO transactions_legacy';
      RAISE NOTICE 'transactions -> transactions_legacy (faltaban: %)', v_missing;
    END IF;
  END IF;

  -- referrals
  IF to_regclass('public.referrals') IS NOT NULL THEN
    SELECT string_agg(c.col, ', ' ORDER BY c.col) INTO v_missing
    FROM (VALUES ('reward_amount'),('reward_asset'),('status')) AS c(col)
    WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.columns x
      WHERE x.table_schema='public' AND x.table_name='referrals' AND x.column_name = c.col);
    IF v_missing IS NOT NULL THEN
      EXECUTE 'ALTER TABLE public.referrals RENAME TO referrals_legacy';
      RAISE NOTICE 'referrals -> referrals_legacy (faltaban: %)', v_missing;
    END IF;
  END IF;

  -- referral_pool
  IF to_regclass('public.referral_pool') IS NOT NULL THEN
    SELECT string_agg(c.col, ', ' ORDER BY c.col) INTO v_missing
    FROM (VALUES ('total_pool'),('distributed')) AS c(col)
    WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.columns x
      WHERE x.table_schema='public' AND x.table_name='referral_pool' AND x.column_name = c.col);
    IF v_missing IS NOT NULL THEN
      EXECUTE 'ALTER TABLE public.referral_pool RENAME TO referral_pool_legacy';
      RAISE NOTICE 'referral_pool -> referral_pool_legacy (faltaban: %)', v_missing;
    END IF;
  END IF;
END $$;

-- =============================================
-- HELPER: CHECK de wallet_ledger.operation tolerante al historial viejo
-- =============================================
-- ALTER TABLE ... ADD CONSTRAINT ... CHECK (...) valida las filas que ya están.
-- Una base creada con un schema anterior tiene operaciones que la lista nueva no
-- contempla, y el ADD revienta con 23514 abortando todo el script.
--
-- Con NOT VALID el CHECK se aplica solo a las filas nuevas: el historial viejo
-- no bloquea el deploy y a partir de ahora se valida igual. La función avisa qué
-- valores quedaron afuera, para normalizarlos y validar del todo cuando se quiera:
--
--   ALTER TABLE wallet_ledger VALIDATE CONSTRAINT wallet_ledger_operation_check;
CREATE OR REPLACE FUNCTION wallet_ledger_apply_operation_check(permitidas TEXT[])
RETURNS TEXT AS $$
DECLARE
  v_fuera TEXT;
BEGIN
  IF to_regclass('public.wallet_ledger') IS NULL THEN
    RETURN 'wallet_ledger no existe todavía';
  END IF;

  SELECT string_agg(DISTINCT operation, ', ' ORDER BY operation)
    INTO v_fuera
  FROM wallet_ledger
  WHERE operation <> ALL (permitidas);

  ALTER TABLE wallet_ledger DROP CONSTRAINT IF EXISTS wallet_ledger_operation_check;

  IF v_fuera IS NULL THEN
    EXECUTE format(
      'ALTER TABLE wallet_ledger ADD CONSTRAINT wallet_ledger_operation_check CHECK (operation = ANY (%L))',
      permitidas);
    RETURN 'CHECK validado';
  END IF;

  EXECUTE format(
    'ALTER TABLE wallet_ledger ADD CONSTRAINT wallet_ledger_operation_check CHECK (operation = ANY (%L)) NOT VALID',
    permitidas);

  RAISE NOTICE 'wallet_ledger: % fila(s) con operation fuera de la lista nueva: %. CHECK agregado como NOT VALID (las filas nuevas se validan igual). Para validarlo del todo, normalizá esos valores y corré ALTER TABLE wallet_ledger VALIDATE CONSTRAINT wallet_ledger_operation_check;',
    (SELECT count(*) FROM wallet_ledger WHERE operation <> ALL (permitidas)), v_fuera;

  RETURN 'CHECK NOT VALID (historial viejo: ' || v_fuera || ')';
END;
$$ LANGUAGE plpgsql;

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


-- Se cambia la firma (agrega p_cooldown_hours), y en Postgres CREATE OR REPLACE
-- con otra lista de argumentos crea una SOBRECARGA en vez de reemplazar: las dos
-- versiones convivirían y la llamada de 4 parámetros quedaría ambigua.
DROP FUNCTION IF EXISTS credit_claim(TEXT, TEXT, DECIMAL, TEXT);

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
  
  -- El ciclo se cierra y queda BLOQUEADO p_cooldown_hours: ends_at pasa a ser el
  -- momento en que se puede volver a holdear, y /auth no abre un ciclo nuevo
  -- mientras no haya pasado.
  --
  -- Antes solo se marcaba 'completed'. Como /auth creaba un ciclo fresco cuando
  -- no encontraba ninguno activo, el usuario podía holdear de nuevo apenas
  -- recargaba la app, sin esperar las 8 horas.
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
-- ADD CONSTRAINT ... CHECK valida las filas existentes. En una base con
-- historial viejo eso aborta TODO el script con 23514 y, como el SQL Editor
-- corre en una transacción, no se aplica nada. Se delega en el bloque único del
-- final del archivo, que agrega el CHECK como NOT VALID si hay filas fuera de la
-- lista.
SELECT wallet_ledger_apply_operation_check(ARRAY[
  'claim_credit', 'referral_bonus', 'deposit', 'withdrawal', 'fee_deduction',
  'trade_buy', 'trade_sell'
]);

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
SELECT wallet_ledger_apply_operation_check(ARRAY[
  'claim_credit', 'referral_bonus', 'deposit', 'withdrawal', 'fee_deduction',
  'trade_buy', 'trade_sell', 'checkin_daily', 'checkin_weekly'
]);

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
  credit_claim(TEXT, TEXT, DECIMAL, TEXT, INTEGER),
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
    'credit_claim(TEXT, TEXT, DECIMAL, TEXT, INTEGER)',
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

-- =============================================
-- v2.9 — SALDO INICIAL DE 1 TRX
-- =============================================
-- Todo usuario arranca con 1 TRX (CONFIG.SIGNUP_TRX_BONUS en el Worker crea las
-- wallets nuevas con ese valor). Los usuarios creados antes de este cambio
-- arrancaron en 0 y se les acredita acá.
--
-- Idempotencia: el criterio es la fila de ledger, NO el saldo. Un saldo de 0
-- puede ser legítimo (alguien que ya se gastó el TRX de bienvenida), así que
-- mirar el saldo lo acreditaría dos veces.
--
-- 'signup_bonus' se suma a la lista de operaciones permitidas. Se usa el helper
-- wallet_ledger_apply_operation_check() y NO un ALTER a mano por dos motivos:
--   1. el helper agrega el CHECK como NOT VALID si hay historial viejo que no
--      encaja, en vez de abortar el script entero con 23514;
--   2. la lista tiene que repetirse COMPLETA. Un ALTER a mano con solo las
--      operaciones "nuevas" reemplaza el constraint y se lleva puestas
--      'checkin_daily' y 'checkin_weekly', que agrega el bloque de v2.6 — o sea
--      que daily_checkin() pasaría a violar el CHECK en cada llamado.
SELECT wallet_ledger_apply_operation_check(ARRAY[
  'claim_credit', 'referral_bonus', 'deposit', 'withdrawal', 'fee_deduction',
  'trade_buy', 'trade_sell', 'checkin_daily', 'checkin_weekly', 'signup_bonus'
]);

-- Usuarios sin wallet: /auth la crea en el primer login, pero si alguno quedó
-- afuera se le abre en 0 y el bloque de abajo le da el TRX como a cualquiera.
INSERT INTO internal_wallets (user_id, usdt_balance, trx_balance, ton_balance)
SELECT u.telegram_id, 0, 0, 0
FROM users u
WHERE NOT EXISTS (
  SELECT 1 FROM internal_wallets w WHERE w.user_id = u.telegram_id
);

-- Acredita el TRX y escribe su fila de ledger en UNA sola sentencia: el UPDATE
-- y el INSERT ven el mismo snapshot, así que el NOT EXISTS se evalúa una vez.
-- Si se hicieran por separado, el INSERT crearía las filas que el UPDATE usa
-- como criterio y el segundo bloque no encontraría a nadie.
WITH faltantes AS (
  SELECT w.user_id
  FROM internal_wallets w
  WHERE NOT EXISTS (
    SELECT 1 FROM wallet_ledger l
    WHERE l.user_id = w.user_id AND l.operation = 'signup_bonus'
  )
), acreditados AS (
  UPDATE internal_wallets w
  SET trx_balance = w.trx_balance + 1
  FROM faltantes f
  WHERE w.user_id = f.user_id
  RETURNING w.user_id, w.trx_balance AS despues
)
INSERT INTO wallet_ledger (
  user_id, operation, reference_type, asset, amount,
  balance_before, balance_after, description
)
SELECT user_id, 'signup_bonus', 'signup', 'TRX', 1,
       despues - 1, despues, 'Signup bonus: 1 TRX'
FROM acreditados;

-- =============================================
-- v3.0 — RETIROS (cola manual)
-- =============================================
-- No hay clave privada en el Worker: el usuario pide el retiro, el saldo y el
-- fee se descuentan en el momento (así no se puede gastar dos veces lo mismo),
-- y la transferencia on-chain la hace un humano desde la tesorería y marca la
-- fila como 'paid'.
--
-- El fee se cobra SIEMPRE en TRX (WITHDRAWAL_FEE_TRX = 5.5), tanto para retiros
-- de USDT como de TRX. Con 1 TRX de bienvenida nadie puede retirar hasta juntar
-- la diferencia: es a propósito.

CREATE TABLE IF NOT EXISTS withdrawal_requests (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(telegram_id),
  asset TEXT NOT NULL CHECK (asset IN ('USDT', 'TRX')),
  amount DECIMAL(18, 8) NOT NULL CHECK (amount > 0),
  fee_trx DECIMAL(18, 8) NOT NULL CHECK (fee_trx >= 0),
  to_address TEXT NOT NULL,
  -- pending  -> en la cola, esperando que alguien lo pague
  -- paid     -> transferido on-chain, tx_id cargado
  -- rejected -> no se pagó; el saldo ya fue devuelto por reject_withdrawal()
  -- cancelled-> el usuario lo canceló antes de que se pagara; saldo devuelto
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'paid', 'rejected', 'cancelled')),
  tx_id TEXT,
  note TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_withdrawal_requests_user
  ON withdrawal_requests(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_withdrawal_requests_pending
  ON withdrawal_requests(status) WHERE status = 'pending';

-- Montos mínimos y fee. En un solo lugar para que el Worker y la UI no se
-- desincronicen: el Worker lee esto por RPC, no lo hardcodea.
CREATE TABLE IF NOT EXISTS withdrawal_config (
  id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  fee_trx DECIMAL(18, 8) NOT NULL DEFAULT 5.5,
  min_usdt DECIMAL(18, 8) NOT NULL DEFAULT 10,
  min_trx DECIMAL(18, 8) NOT NULL DEFAULT 10,
  max_pending_per_user INT NOT NULL DEFAULT 3
);
INSERT INTO withdrawal_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE OR REPLACE FUNCTION withdrawal_settings() RETURNS JSONB AS $$
  SELECT jsonb_build_object(
    'fee_trx', fee_trx, 'min_usdt', min_usdt,
    'min_trx', min_trx, 'max_pending_per_user', max_pending_per_user
  ) FROM withdrawal_config WHERE id = 1;
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION request_withdrawal(
  p_user_id TEXT,
  p_asset TEXT,
  p_amount DECIMAL,
  p_to_address TEXT
) RETURNS JSONB AS $$
DECLARE
  v_wallet RECORD;
  v_cfg RECORD;
  v_pending INT;
  v_before DECIMAL(18, 8);
  v_after DECIMAL(18, 8);
  v_fee_before DECIMAL(18, 8);
  v_fee_after DECIMAL(18, 8);
  v_id UUID;
BEGIN
  IF p_user_id IS NULL OR trim(p_user_id) = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Missing user');
  END IF;
  IF upper(COALESCE(p_asset, '')) NOT IN ('USDT', 'TRX') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Asset must be USDT or TRX');
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Amount must be greater than zero');
  END IF;
  IF p_to_address IS NULL OR length(trim(p_to_address)) < 26 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Invalid destination address');
  END IF;

  SELECT * INTO v_cfg FROM withdrawal_config WHERE id = 1;

  -- Tope de solicitudes pendientes: sin esto un usuario puede llenar la cola de
  -- pedidos que después hay que rechazar uno por uno.
  SELECT count(*)::int INTO v_pending
  FROM withdrawal_requests
  WHERE user_id = p_user_id AND status = 'pending';

  IF v_pending >= v_cfg.max_pending_per_user THEN
    RETURN jsonb_build_object('ok', false,
      'error', 'Too many pending withdrawals. Wait for them to be processed.');
  END IF;

  IF upper(p_asset) = 'USDT' AND p_amount < v_cfg.min_usdt THEN
    RETURN jsonb_build_object('ok', false,
      'error', format('Minimum withdrawal is %s USDT', v_cfg.min_usdt));
  END IF;
  IF upper(p_asset) = 'TRX' AND p_amount < v_cfg.min_trx THEN
    RETURN jsonb_build_object('ok', false,
      'error', format('Minimum withdrawal is %s TRX', v_cfg.min_trx));
  END IF;

  -- FOR UPDATE: sin el lock, dos requests simultáneos leen el mismo saldo y los
  -- dos pasan la validación. Es la forma clásica de duplicar un retiro.
  SELECT * INTO v_wallet FROM internal_wallets
  WHERE user_id = p_user_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Wallet not found');
  END IF;

  -- El fee siempre sale del saldo TRX, aunque el retiro sea de USDT.
  IF v_wallet.trx_balance < v_cfg.fee_trx THEN
    RETURN jsonb_build_object('ok', false,
      'error', format('Withdrawal fee is %s TRX and your TRX balance is not enough',
                      v_cfg.fee_trx));
  END IF;

  IF upper(p_asset) = 'USDT' THEN
    IF v_wallet.usdt_balance < p_amount THEN
      RETURN jsonb_build_object('ok', false, 'error', 'Insufficient USDT balance');
    END IF;
    v_before := v_wallet.usdt_balance;
    v_after := v_before - p_amount;
  ELSE
    -- Retiro de TRX: el monto Y el fee salen de la misma bolsa.
    IF v_wallet.trx_balance < p_amount + v_cfg.fee_trx THEN
      RETURN jsonb_build_object('ok', false,
        'error', 'Insufficient TRX balance (amount + 5.5 TRX fee)');
    END IF;
    v_before := v_wallet.trx_balance;
    v_after := v_before - p_amount - v_cfg.fee_trx;
  END IF;

  v_fee_before := v_wallet.trx_balance;
  v_fee_after := v_fee_before - v_cfg.fee_trx;

  -- Descuenta el activo retirado.
  --
  -- En el caso USDT hay que escribir DOS columnas: el monto sale de
  -- usdt_balance y el fee sale de trx_balance. La primera versión de este bloque
  -- actualizaba solo usdt_balance y el fee quedaba escrito en el ledger pero
  -- sin descontar del saldo — el ledger mentía y el fee era gratis.
  IF upper(p_asset) = 'USDT' THEN
    UPDATE internal_wallets
    SET usdt_balance = v_after,
        trx_balance  = v_fee_after,
        updated_at   = NOW()
    WHERE user_id = p_user_id;
  ELSE
    -- TRX: v_after ya incluye monto + fee (v_before - p_amount - fee_trx).
    UPDATE internal_wallets SET trx_balance = v_after, updated_at = NOW()
    WHERE user_id = p_user_id;
  END IF;

  INSERT INTO wallet_ledger (
    user_id, operation, reference_type, reference_id, asset, amount,
    balance_before, balance_after, description
  ) VALUES (
    p_user_id, 'withdrawal', 'withdrawal', NULL, upper(p_asset), -p_amount,
    v_before, v_after, format('Withdrawal request: %s %s', p_amount, upper(p_asset))
  );

  -- El fee va en su propia fila de ledger: si un día hay que devolverlo
  -- (rechazo o cancelación), se sabe exactamente cuánto era.
  INSERT INTO wallet_ledger (
    user_id, operation, reference_type, reference_id, asset, amount,
    balance_before, balance_after, description
  ) VALUES (
    p_user_id, 'fee_deduction', 'withdrawal', NULL, 'TRX', -v_cfg.fee_trx,
    v_fee_before, v_fee_after, 'Withdrawal network fee'
  );

  INSERT INTO withdrawal_requests (user_id, asset, amount, fee_trx, to_address)
  VALUES (p_user_id, upper(p_asset), p_amount, v_cfg.fee_trx, trim(p_to_address))
  RETURNING id INTO v_id;

  RETURN jsonb_build_object(
    'ok', true, 'request_id', v_id, 'asset', upper(p_asset),
    'amount', p_amount, 'fee_trx', v_cfg.fee_trx, 'status', 'pending'
  );
END;
$$ LANGUAGE plpgsql;

-- Devuelve el saldo cuando un retiro no se paga. Lo hace la persona que rechaza
-- o el usuario que cancela; sin esto el dinero queda descontado para siempre.
CREATE OR REPLACE FUNCTION resolve_withdrawal(
  p_request_id UUID,
  p_status TEXT,          -- 'paid' | 'rejected' | 'cancelled'
  p_tx_id TEXT DEFAULT NULL,
  p_note TEXT DEFAULT NULL
) RETURNS JSONB AS $$
DECLARE
  v_req RECORD;
  v_wallet RECORD;
BEGIN
  IF lower(COALESCE(p_status, '')) NOT IN ('paid', 'rejected', 'cancelled') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Status must be paid, rejected or cancelled');
  END IF;

  SELECT * INTO v_req FROM withdrawal_requests
  WHERE id = p_request_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Request not found');
  END IF;
  IF v_req.status <> 'pending' THEN
    RETURN jsonb_build_object('ok', false,
      'error', format('Request is already %s', v_req.status));
  END IF;

  IF lower(p_status) = 'paid' THEN
    UPDATE withdrawal_requests
    SET status = 'paid', tx_id = p_tx_id, note = p_note, resolved_at = NOW()
    WHERE id = p_request_id;
    RETURN jsonb_build_object('ok', true, 'status', 'paid');
  END IF;

  -- rejected / cancelled: reintegra el monto y el fee.
  SELECT * INTO v_wallet FROM internal_wallets
  WHERE user_id = v_req.user_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Wallet not found');
  END IF;

  IF v_req.asset = 'USDT' THEN
    UPDATE internal_wallets
    SET usdt_balance = usdt_balance + v_req.amount,
        trx_balance = trx_balance + v_req.fee_trx,
        updated_at = NOW()
    WHERE user_id = v_req.user_id;
  ELSE
    UPDATE internal_wallets
    SET trx_balance = trx_balance + v_req.amount + v_req.fee_trx,
        updated_at = NOW()
    WHERE user_id = v_req.user_id;
  END IF;

  INSERT INTO wallet_ledger (
    user_id, operation, reference_type, reference_id, asset, amount,
    balance_before, balance_after, description
  ) VALUES (
    v_req.user_id, 'deposit', 'withdrawal', p_request_id::text, v_req.asset,
    v_req.amount, 0, v_req.amount,
    format('Refund of %s withdrawal %s', lower(p_status), p_request_id)
  );

  UPDATE withdrawal_requests
  SET status = lower(p_status), note = p_note, resolved_at = NOW()
  WHERE id = p_request_id;

  RETURN jsonb_build_object('ok', true, 'status', lower(p_status), 'refunded', true);
END;
$$ LANGUAGE plpgsql;

-- RLS: como el resto, solo entra service_role desde el Worker.
ALTER TABLE withdrawal_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE withdrawal_config ENABLE ROW LEVEL SECURITY;

-- Permisos de las funciones de v2.9/v3.0. El bloque equivalente del inicio del
-- archivo corre antes de que estas existan, así que van acá.
DO $$
DECLARE
  f TEXT;
  funcs TEXT[] := ARRAY[
    'wallet_ledger_apply_operation_check(TEXT[])',
    'withdrawal_settings()',
    'request_withdrawal(TEXT, TEXT, DECIMAL, TEXT)',
    'resolve_withdrawal(UUID, TEXT, TEXT, TEXT)'
  ];
  r TEXT;
BEGIN
  FOREACH f IN ARRAY funcs LOOP
    IF to_regprocedure(f) IS NULL THEN
      CONTINUE;
    END IF;
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

-- request_withdrawal y resolve_withdrawal mueven plata: no deben ser
-- ejecutables por PUBLIC. Los otros dos son de lectura/configuración.
REVOKE EXECUTE ON FUNCTION request_withdrawal(TEXT, TEXT, DECIMAL, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION resolve_withdrawal(UUID, TEXT, TEXT, TEXT) FROM PUBLIC;
-- withdrawal_settings() es de solo lectura, pero el Worker entra siempre con
-- service_role, así que no hay motivo para dejarla abierta. Revocarla cuesta
-- cero y mantiene la auditoría sin excepciones que después hay que justificar.
REVOKE EXECUTE ON FUNCTION withdrawal_settings() FROM PUBLIC;
DO $$ BEGIN
  IF to_regprocedure('wallet_ledger_apply_operation_check(TEXT[])') IS NOT NULL THEN
    EXECUTE 'REVOKE EXECUTE ON FUNCTION wallet_ledger_apply_operation_check(TEXT[]) FROM PUBLIC';
  END IF;
END $$;

-- =============================================
-- v3.1 — MISIONES SOCIALES (one-time)
-- =============================================
-- Config-driven: agregar una mision nueva es un INSERT, no un deploy. Las de
-- Telegram se verifican DE VERDAD: el Worker pregunta a la Bot API
-- getChatMember(chat_id, user_id) con el telegram_id que sale del initData
-- validado, asi que desde la consola no se puede mentir. El bot tiene que
-- estar como admin del canal/grupo para que Telegram le deje ver miembros.
--
-- verify:
--   'telegram_member'  pregunta a Telegram si el usuario esta en chat_id.
--   'honor'            el usuario confirma; one-time por PK. Para redes sin
--                      API de follows (cuando se decida usarlas asi).
--   'manual'           revision humana. El Worker la rechaza hasta que exista
--                      la UI de admin; queda como placeholder habilitable.
--
-- Las filas de instagram/youtube/x van sembradas pero disabled: es el
-- placeholder que se pidio para proximas misiones de este estilo.

CREATE TABLE IF NOT EXISTS social_missions (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL,
  reward_usdt DECIMAL(18, 8) NOT NULL DEFAULT 0.4,
  verify TEXT NOT NULL DEFAULT 'telegram_member'
    CHECK (verify IN ('telegram_member', 'honor', 'manual')),
  chat_id TEXT,
  enabled BOOLEAN NOT NULL DEFAULT true,
  sort INT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS user_social_missions (
  user_id TEXT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  mission_id TEXT NOT NULL REFERENCES social_missions(id) ON DELETE CASCADE,
  reward_usdt DECIMAL(18, 8) NOT NULL,
  completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, mission_id)
);

INSERT INTO social_missions
  (id, platform, title, description, url, reward_usdt, verify, chat_id, enabled, sort)
VALUES
  ('tg_channel', 'telegram', 'Follow the channel',
   'Official announcements of Keeper Exchange.',
   'https://t.me/KeeperExchange', 0.4, 'telegram_member', '@KeeperExchange', true, 1),
  ('tg_community', 'telegram', 'Join the community',
   'Chat with other holders.',
   'https://t.me/KeeperExchange_CHAT', 0.4, 'telegram_member', '@KeeperExchange_CHAT', true, 2),
  -- Placeholders para proximas misiones: se habilitan con un UPDATE
  -- (enabled = true) cuando existan las cuentas y se decida el verify.
  ('instagram', 'instagram', 'Follow on Instagram', '', 'https://instagram.com', 0.4, 'manual', NULL, false, 3),
  ('youtube', 'youtube', 'Subscribe on YouTube', '', 'https://youtube.com', 0.4, 'manual', NULL, false, 4),
  ('x', 'x', 'Follow on X', '', 'https://x.com', 0.4, 'manual', NULL, false, 5)
ON CONFLICT (id) DO NOTHING;

-- Paga la mision una sola vez. La PK de user_social_missions es la garantia
-- anti-doble-cobro; el segundo intento cae en unique_violation y devuelve
-- 'already' sin tocar el saldo.
CREATE OR REPLACE FUNCTION complete_social_mission(
  p_user_id TEXT,
  p_mission_id TEXT
) RETURNS JSONB AS $$
DECLARE
  v_mission RECORD;
  v_before DECIMAL(18, 8);
  v_after DECIMAL(18, 8);
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

  BEGIN
    INSERT INTO user_social_missions (user_id, mission_id, reward_usdt)
    VALUES (p_user_id, p_mission_id, v_mission.reward_usdt);
  EXCEPTION WHEN unique_violation THEN
    -- Carrera: dos verify simultaneos. Uno gana, el otro no cobra.
    RETURN jsonb_build_object('ok', false, 'error', 'already');
  END;

  SELECT usdt_balance INTO v_before FROM internal_wallets
   WHERE user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'No wallet');
  END IF;
  v_after := v_before + v_mission.reward_usdt;

  UPDATE internal_wallets SET usdt_balance = v_after, updated_at = NOW()
   WHERE user_id = p_user_id;

  INSERT INTO wallet_ledger (
    user_id, operation, reference_type, reference_id, asset, amount,
    balance_before, balance_after, description
  ) VALUES (
    p_user_id, 'mission_reward', 'social_mission', NULL, 'USDT', v_mission.reward_usdt,
    v_before, v_after, format('Mission: %s', v_mission.title)
  );

  RETURN jsonb_build_object('ok', true, 'reward', v_mission.reward_usdt);
END;
$$ LANGUAGE plpgsql;

ALTER TABLE social_missions ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_social_missions ENABLE ROW LEVEL SECURITY;

-- El ledger acepta 'mission_reward'. Se reescribe la CHECK con la lista
-- COMPLETA: el helper avisa si algun valor quedo afuera.
SELECT wallet_ledger_apply_operation_check(ARRAY[
  'claim_credit', 'referral_bonus', 'deposit', 'withdrawal', 'fee_deduction',
  'trade_buy', 'trade_sell', 'checkin_daily', 'checkin_weekly', 'signup_bonus',
  'mission_reward'
]);

-- Permisos v3.1: complete_social_mission mueve plata; solo service_role.
DO $$
BEGIN
  IF to_regprocedure('complete_social_mission(TEXT, TEXT)') IS NOT NULL THEN
    EXECUTE 'REVOKE EXECUTE ON FUNCTION complete_social_mission(TEXT, TEXT) FROM PUBLIC';
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      EXECUTE 'REVOKE EXECUTE ON FUNCTION complete_social_mission(TEXT, TEXT) FROM authenticated';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE 'REVOKE EXECUTE ON FUNCTION complete_social_mission(TEXT, TEXT) FROM anon';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
      EXECUTE 'GRANT EXECUTE ON FUNCTION complete_social_mission(TEXT, TEXT) TO service_role';
    END IF;
  END IF;
END $$;

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
   'Make your first TON deposit (minimum 0.1 TON). We review the chain comment automatically.',
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

-- =============================================
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

-- =============================================
-- v3.5 — cooldown tras el vencimiento sin cobrar
-- =============================================
-- Reporte del usuario: dejo vencer 3 claims sin cobrar y el boton de HOLD
-- quedo disponible de nuevo al instante, sin cooldown. Regla nueva: dejar
-- vencer el premio cuesta lo mismo que cobrarlo. El ciclo se cierra con
-- cooldown de 8 h (ends_at = NOW() + 8h) y holds_completed se queda en 3/3.
-- El worker (/auth y /hold) y el frontend aplican la misma regla.
--
-- 1) Reemplaza expire_claims_and_cycles (la version v2.8.1 reseteaba a 0).
-- 2) Reparacion unica: cierra los ciclos 3/3 cuyo premio ya se perdio.

CREATE OR REPLACE FUNCTION expire_claims_and_cycles() RETURNS void AS $$
BEGIN
  -- Claims que expiraron sin pagarse: el premio se pierde.
  UPDATE claims
  SET status = 'expired_unclaimed'
  WHERE status = 'pending' AND expires_at < NOW();

  -- v3.5: esos ciclos se cierran con el mismo cooldown de 8 h que un claim
  -- exitoso. Los holds se quedan en 3/3, asi el boton sigue bloqueado hasta
  -- que pase la ventana. Solo toca ciclos activos: no estira el cooldown de
  -- un ciclo ya en espera, ni toca los 'completed' (el standby tras cobrar
  -- lo maneja credit_claim).
  UPDATE hold_cycles hc
  SET status = 'expired',
      ends_at = NOW() + make_interval(hours => 8)
  WHERE hc.status = 'active'
    AND hc.holds_completed >= 3
    AND NOT EXISTS (
      SELECT 1 FROM claims c WHERE c.cycle_id = hc.id AND c.status = 'pending'
    )
    AND EXISTS (
      SELECT 1 FROM claims c WHERE c.cycle_id = hc.id AND c.status = 'expired_unclaimed'
    );

  -- Ciclos activos cuya ventana de 8 h paso sin completarse: expiran.
  UPDATE hold_cycles
  SET status = 'expired'
  WHERE status = 'active' AND ends_at < NOW();
END;
$$ LANGUAGE plpgsql;

-- Reparacion unica para bases donde la regla vieja ya corria: cubre el caso
-- danino, ciclo activo 3/3 cuyo premio ya se perdio (expired_unclaimed o
-- pendiente vencido). Entra en cooldown de inmediato para que nadie siga
-- holdeando sin cobrar. No toca ciclos que en el pasado ya volvieron a 0
-- holds (ese tiempo ya se perdio) ni ventanas vencidas hace rato.
UPDATE claims
SET status = 'expired_unclaimed'
WHERE status = 'pending' AND expires_at < NOW();

UPDATE hold_cycles hc
SET status = 'expired',
    ends_at = NOW() + make_interval(hours => 8)
WHERE hc.status = 'active'
  AND hc.holds_completed >= 3
  AND NOT EXISTS (
    SELECT 1 FROM claims c WHERE c.cycle_id = hc.id AND c.status = 'pending'
  )
  AND EXISTS (
    SELECT 1 FROM claims c WHERE c.cycle_id = hc.id AND c.status = 'expired_unclaimed'
  );

-- =============================================
-- v3.6 — el vencimiento sin firmar libera el hold (regla final)
-- =============================================
-- Decision final de producto: el cooldown de 8 h es SOLO para el claim
-- cobrado (el usuario firmo y pago con la wallet). Si la ventana de 15
-- minutos pasa sin firmar, el premio se pierde y el ciclo vuelve a 0 holds:
-- el boton de HOLD se reabre enseguida. (Reviente de la regla v3.5, que
-- aplicaba 8 h tambien al vencimiento: la ventana de 15 min ya es castigo.)
--
-- 1) expire_claims_and_cycles vuelve a resetear los holds a 0.
-- 2) Reparacion unica: libera los ciclos que la regla v3.5 (o el Worker
--    3.6/3.7) dejo en cooldown de 8 h por un vencimiento sin cobrar.

CREATE OR REPLACE FUNCTION expire_claims_and_cycles() RETURNS void AS $$
BEGIN
  -- v3.6 (regla final): el claim que expiro sin pagarse se pierde y los 3
  -- holds con el. El ciclo vuelve a 0 holds para que el usuario pueda
  -- holdear de nuevo enseguida. El bloqueo de 8 horas rige solo tras un
  -- claim exitoso: el ciclo queda en 3/3 y /hold lo rechaza hasta que vence.
  --
  -- El UPDATE va primero y usa las filas que estamos por expirar: este job
  -- corre cada minuto y casi siempre gana la carrera contra /auth.
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

-- Reparacion unica para bases donde la regla v3.5 llego a correr (cron o
-- Worker 3.6/3.7): ciclos cerrados como 'expired' con cooldown de 8 h por un
-- vencimiento sin cobrar. Vuelven a 'active' con 0 holds y ventana nueva.
-- El filtro por ends_at futuro deja intactos los cooldowns ya cumplidos, y
-- el standby legitimo post-cobro no se toca porque es 'completed', no
-- 'expired', y su claim no es 'expired_unclaimed'.
UPDATE hold_cycles hc
SET status = 'active',
    holds_completed = 0,
    ends_at = NOW() + make_interval(hours => 8)
WHERE hc.status = 'expired'
  AND hc.ends_at > NOW()
  AND EXISTS (
    SELECT 1 FROM claims c WHERE c.cycle_id = hc.id AND c.status = 'expired_unclaimed'
  )
  AND NOT EXISTS (
    SELECT 1 FROM claims c WHERE c.cycle_id = hc.id AND c.status = 'pending'
  );
-- =====================================================================
-- TronKeeper — MIGRACION v3.7 — depósitos TON por código MEMO
-- =====================================================================
-- Pegar TODO este archivo en el SQL Editor de Supabase y correr.
-- Es idempotente y requiere schema/migraciones hasta v3.6.
--
-- Flujo:
--   1. En signup el Worker asigna un código DEP:<6 caracteres> al usuario.
--   2. El usuario envía TON a la tesorería con ese comentario exacto.
--   3. El cron del Worker consulta TonCenter cada dos minutos, acredita los
--      ingresos que coinciden y conserva evidencia de los que no coinciden.
--   4. El hash de TON es la clave idempotente: un ingreso nunca paga dos veces.

-- =============================================
-- Códigos individuales de depósito
-- =============================================
CREATE TABLE IF NOT EXISTS deposit_codes (
  user_id TEXT PRIMARY KEY REFERENCES users(telegram_id) ON DELETE CASCADE,
  code TEXT UNIQUE NOT NULL
    CHECK (code ~ '^DEP:[A-Z0-9]{6}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_deposit_codes_code ON deposit_codes(code);

-- =============================================
-- Ingresos TON acreditados
-- =============================================
CREATE TABLE IF NOT EXISTS ton_deposit_txs (
  tx_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(telegram_id),
  from_address TEXT NOT NULL,
  amount NUMERIC(28, 9) NOT NULL CHECK (amount >= 0.1),
  comment TEXT NOT NULL CHECK (comment ~ '^DEP:[A-Z0-9]{6}$'),
  tx_timestamp TIMESTAMPTZ NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ton_deposit_txs_user_processed
  ON ton_deposit_txs(user_id, processed_at DESC);

-- =============================================
-- Ingresos sin coincidencia automática
-- =============================================
CREATE TABLE IF NOT EXISTS unmatched_deposits (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  tx_hash TEXT UNIQUE NOT NULL,
  from_address TEXT NOT NULL,
  amount NUMERIC(28, 9) NOT NULL CHECK (amount > 0),
  comment TEXT NOT NULL DEFAULT '',
  tx_timestamp TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'credited', 'rejected')),
  user_id TEXT REFERENCES users(telegram_id),
  resolution_note TEXT,
  resolved_by TEXT,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_unmatched_deposits_status_created
  ON unmatched_deposits(status, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_unmatched_deposits_tx_hash
  ON unmatched_deposits(tx_hash);

-- =============================================
-- Crédito TON atómico, con First Deposit automático
-- =============================================
CREATE OR REPLACE FUNCTION credit_ton_deposit(
  p_user_id TEXT,
  p_tx_hash TEXT,
  p_from_address TEXT,
  p_amount NUMERIC,
  p_comment TEXT,
  p_tx_timestamp TIMESTAMPTZ,
  p_unmatched_id UUID DEFAULT NULL
) RETURNS JSONB AS $$
DECLARE
  v_wallet internal_wallets%ROWTYPE;
  v_existing ton_deposit_txs%ROWTYPE;
  v_deposit ton_deposit_txs%ROWTYPE;
  v_unmatched unmatched_deposits%ROWTYPE;
  v_mission social_missions%ROWTYPE;
  v_mission_row user_social_missions%ROWTYPE;
  v_comment TEXT := BTRIM(COALESCE(p_comment, ''));
  v_tx_hash TEXT := BTRIM(COALESCE(p_tx_hash, ''));
  v_from_address TEXT := BTRIM(COALESCE(p_from_address, ''));
  v_tx_timestamp TIMESTAMPTZ := COALESCE(p_tx_timestamp, NOW());
  v_ton_before NUMERIC;
  v_ton_after NUMERIC;
  v_usdt_before NUMERIC;
  v_usdt_after NUMERIC;
  v_keep_before NUMERIC;
  v_keep_after NUMERIC;
  v_first_usdt NUMERIC := 0;
  v_first_keep NUMERIC := 0;
  v_first_deposit BOOLEAN := FALSE;
  v_mission_inserted BOOLEAN := FALSE;
  v_inserted_user TEXT;
BEGIN
  IF p_user_id IS NULL OR BTRIM(p_user_id) = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Missing user');
  END IF;
  IF v_tx_hash = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Missing transaction hash');
  END IF;
  IF v_from_address = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Missing source address');
  END IF;
  IF p_amount IS NULL OR p_amount < 0.1 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Minimum TON deposit is 0.1');
  END IF;
  IF v_comment !~ '^DEP:[A-Z0-9]{6}$' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Invalid deposit code');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM users WHERE telegram_id = p_user_id) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'User not found');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM deposit_codes
    WHERE user_id = p_user_id AND code = v_comment
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Deposit code does not belong to user');
  END IF;

  -- El admin nunca puede cambiar la evidencia de cadena: al resolver un
  -- unmatched se vuelve a leer y bloquear la misma fila.
  IF p_unmatched_id IS NOT NULL THEN
    SELECT * INTO v_unmatched
    FROM unmatched_deposits
    WHERE id = p_unmatched_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', false, 'error', 'Unmatched deposit not found');
    END IF;
    IF v_unmatched.status <> 'pending' THEN
      RETURN jsonb_build_object('ok', false, 'error', 'Unmatched deposit already resolved');
    END IF;
    IF v_unmatched.tx_hash <> v_tx_hash
       OR v_unmatched.from_address <> v_from_address
       OR v_unmatched.amount <> p_amount
       OR v_unmatched.comment <> v_comment THEN
      RETURN jsonb_build_object('ok', false, 'error', 'Chain evidence mismatch');
    END IF;
  END IF;

  -- tx_hash es la frontera idempotente. ON CONFLICT espera a una eventual
  -- carrera concurrente y luego devuelve la fila que ganó.
  INSERT INTO ton_deposit_txs (
    tx_hash, user_id, from_address, amount, comment, tx_timestamp
  ) VALUES (
    v_tx_hash, p_user_id, v_from_address, p_amount, v_comment, v_tx_timestamp
  )
  ON CONFLICT (tx_hash) DO NOTHING
  RETURNING * INTO v_deposit;

  IF NOT FOUND THEN
    SELECT * INTO v_existing
    FROM ton_deposit_txs
    WHERE tx_hash = v_tx_hash
    FOR UPDATE;

    IF v_existing.user_id <> p_user_id THEN
      RETURN jsonb_build_object('ok', false, 'error', 'deposit_already_claimed');
    END IF;

    IF p_unmatched_id IS NOT NULL THEN
      UPDATE unmatched_deposits
      SET status = 'credited', user_id = p_user_id,
          resolved_by = 'ton_cron', resolved_at = NOW()
      WHERE id = p_unmatched_id AND status = 'pending';
    END IF;

    SELECT ton_balance INTO v_ton_after
    FROM internal_wallets WHERE user_id = p_user_id;
    RETURN jsonb_build_object(
      'ok', true,
      'already_credited', true,
      'tx_hash', v_existing.tx_hash,
      'amount', v_existing.amount,
      'new_balance', COALESCE(v_ton_after, 0),
      'first_deposit_credited', false
    );
  END IF;

  -- Bloquea la wallet antes de calcular los saldos de los tres activos. Todo
  -- lo que sigue queda en la misma transacción del RPC.
  SELECT * INTO v_wallet
  FROM internal_wallets
  WHERE user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    INSERT INTO internal_wallets (
      user_id, usdt_balance, trx_balance, ton_balance, keep_balance
    ) VALUES (p_user_id, 0, 0, 0, 0)
    RETURNING * INTO v_wallet;
  END IF;

  v_ton_before := COALESCE(v_wallet.ton_balance, 0);
  v_ton_after := v_ton_before + p_amount;
  UPDATE internal_wallets
  SET ton_balance = v_ton_after, updated_at = NOW()
  WHERE user_id = p_user_id;

  INSERT INTO wallet_ledger (
    user_id, operation, reference_type, reference_id,
    asset, amount, balance_before, balance_after, description
  ) VALUES (
    p_user_id, 'deposit', 'ton_deposit', v_tx_hash,
    'TON', p_amount, v_ton_before, v_ton_after,
    'TON deposit matched by MEMO'
  );

  -- El primer ingreso valida y paga First Deposit automáticamente. Si el
  -- usuario ya había creado una solicitud manual, se transforma en paid sin
  -- volver a pagarla.
  SELECT * INTO v_mission
  FROM social_missions
  WHERE id = 'first_deposit' AND enabled
  FOR SHARE;

  IF FOUND THEN
    INSERT INTO user_social_missions (
      user_id, mission_id, period, status, reward_usdt, reward_keep
    ) VALUES (
      p_user_id, 'first_deposit', '', 'paid',
      v_mission.reward_usdt, COALESCE(v_mission.reward_keep, 3000)
    )
    ON CONFLICT (user_id, mission_id, period) DO NOTHING
    RETURNING user_id INTO v_inserted_user;
    v_mission_inserted := v_inserted_user IS NOT NULL;

    SELECT * INTO v_mission_row
    FROM user_social_missions
    WHERE user_id = p_user_id AND mission_id = 'first_deposit' AND period = ''
    FOR UPDATE;

    IF v_mission_inserted OR v_mission_row.status = 'pending' THEN
      v_first_usdt := v_mission_row.reward_usdt;
      v_first_keep := COALESCE(v_mission_row.reward_keep, 3000);
      UPDATE user_social_missions
      SET status = 'paid', reward_keep = v_first_keep, completed_at = NOW()
      WHERE user_id = p_user_id AND mission_id = 'first_deposit' AND period = '';
    END IF;

    IF v_first_usdt > 0 OR v_first_keep > 0 THEN
      v_usdt_before := COALESCE(v_wallet.usdt_balance, 0);
      v_keep_before := COALESCE(v_wallet.keep_balance, 0);
      v_usdt_after := v_usdt_before + v_first_usdt;
      v_keep_after := v_keep_before + v_first_keep;

      UPDATE internal_wallets
      SET usdt_balance = v_usdt_after,
          keep_balance = v_keep_after,
          updated_at = NOW()
      WHERE user_id = p_user_id;

      IF v_first_usdt > 0 THEN
        INSERT INTO wallet_ledger (
          user_id, operation, reference_type, reference_id, asset, amount,
          balance_before, balance_after, description
        ) VALUES (
          p_user_id, 'mission_reward', 'social_mission', v_tx_hash, 'USDT',
          v_first_usdt, v_usdt_before, v_usdt_after,
          'First Deposit mission approved automatically'
        );
      END IF;
      IF v_first_keep > 0 THEN
        INSERT INTO wallet_ledger (
          user_id, operation, reference_type, reference_id, asset, amount,
          balance_before, balance_after, description
        ) VALUES (
          p_user_id, 'mission_reward', 'social_mission', v_tx_hash, 'KEEP',
          v_first_keep, v_keep_before, v_keep_after,
          'First Deposit KEEP reward approved automatically'
        );
      END IF;
      v_first_deposit := TRUE;
    END IF;
  END IF;

  IF p_unmatched_id IS NOT NULL THEN
    UPDATE unmatched_deposits
    SET status = 'credited', user_id = p_user_id,
        resolved_by = 'admin', resolved_at = NOW()
    WHERE id = p_unmatched_id AND status = 'pending';
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'already_credited', false,
    'tx_hash', v_deposit.tx_hash,
    'amount', v_deposit.amount,
    'new_balance', v_ton_after,
    'first_deposit_credited', v_first_deposit,
    'first_deposit_usdt', v_first_usdt,
    'first_deposit_keep', v_first_keep
  );
END;
$$ LANGUAGE plpgsql;

-- Solo el Worker entra con service_role. Las claves anon/authenticated no
-- pueden crear un saldo ni resolver evidencia de cadena.
ALTER TABLE deposit_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE ton_deposit_txs ENABLE ROW LEVEL SECURITY;
ALTER TABLE unmatched_deposits ENABLE ROW LEVEL SECURITY;

REVOKE EXECUTE ON FUNCTION credit_ton_deposit(
  TEXT, TEXT, TEXT, NUMERIC, TEXT, TIMESTAMPTZ, UUID
) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE EXECUTE ON FUNCTION credit_ton_deposit(
      TEXT, TEXT, TEXT, NUMERIC, TEXT, TIMESTAMPTZ, UUID
    ) FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE EXECUTE ON FUNCTION credit_ton_deposit(
      TEXT, TEXT, TEXT, NUMERIC, TEXT, TIMESTAMPTZ, UUID
    ) FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION credit_ton_deposit(
      TEXT, TEXT, TEXT, NUMERIC, TEXT, TIMESTAMPTZ, UUID
    ) TO service_role;
  END IF;
END $$;
