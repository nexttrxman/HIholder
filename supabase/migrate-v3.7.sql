-- =====================================================================
-- TronKeeper — MIGRACION v3.7 — depósitos TRON sin MEMO
-- =====================================================================
-- Pegar TODO este archivo en el SQL Editor de Supabase y correr.
-- Es idempotente: se puede ejecutar dos veces sin romper nada.
-- Requiere el schema/migraciones hasta v3.6.
--
-- Flujo:
--   1. El usuario envía TRX o USDT TRC-20 a la dirección central, con o sin
--      MEMO, y pega el hash de la transacción en la Mini App.
--   2. El Worker verifica en TronGrid destino, contrato, monto y confirmación.
--   3. credit_tron_deposit() acredita la wallet y guarda el hash en una
--      operación atómica e idempotente. Un hash nunca puede pagar dos veces.
--
-- La tabla no intenta inferir el usuario desde un MEMO: el user_id sale del
-- initData de Telegram validado por el Worker. El hash de la cadena es la
-- evidencia que se usa para verificar el depósito.

-- =============================================
-- v3.7 — tabla de depósitos TRON
-- =============================================
CREATE TABLE IF NOT EXISTS tron_deposits (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  tx_hash TEXT UNIQUE NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(telegram_id),
  asset TEXT NOT NULL CHECK (asset IN ('TRX', 'USDT')),
  amount DECIMAL(28, 8) NOT NULL CHECK (amount > 0),
  from_address TEXT NOT NULL,
  to_address TEXT NOT NULL,
  block_number BIGINT,
  block_timestamp TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'credited'
    CHECK (status IN ('credited', 'rejected')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  credited_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_tron_deposits_user_created
  ON tron_deposits(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tron_deposits_status
  ON tron_deposits(status);

-- =============================================
-- v3.7 — crédito atómico e idempotente
-- =============================================
CREATE OR REPLACE FUNCTION credit_tron_deposit(
  p_user_id TEXT,
  p_tx_hash TEXT,
  p_asset TEXT,
  p_amount DECIMAL,
  p_from_address TEXT,
  p_to_address TEXT,
  p_block_timestamp TIMESTAMPTZ DEFAULT NULL,
  p_block_number BIGINT DEFAULT NULL
) RETURNS JSONB AS $$
DECLARE
  v_wallet RECORD;
  v_existing RECORD;
  v_deposit RECORD;
  v_asset TEXT := upper(trim(COALESCE(p_asset, '')));
  v_before DECIMAL;
  v_after DECIMAL;
BEGIN
  IF p_user_id IS NULL OR trim(p_user_id) = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Missing user');
  END IF;
  IF p_tx_hash IS NULL OR trim(p_tx_hash) = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Missing transaction hash');
  END IF;
  IF v_asset NOT IN ('TRX', 'USDT') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Asset must be TRX or USDT');
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Deposit amount must be greater than zero');
  END IF;
  IF p_from_address IS NULL OR trim(p_from_address) = ''
     OR p_to_address IS NULL OR trim(p_to_address) = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Missing chain addresses');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM users WHERE telegram_id = p_user_id) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'User not found');
  END IF;

  -- Lock the wallet before changing it. /auth normally creates this row, but
  -- the fallback keeps the RPC safe for users created by an older deployment.
  SELECT * INTO v_wallet FROM internal_wallets
  WHERE user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO internal_wallets (user_id, usdt_balance, trx_balance, ton_balance, keep_balance)
    VALUES (p_user_id, 0, 0, 0, 0)
    RETURNING * INTO v_wallet;
  END IF;

  -- The UNIQUE(tx_hash) constraint is the second line of defence after the
  -- Worker check. ON CONFLICT makes retries return the original credit rather
  -- than creating a second ledger entry.
  INSERT INTO tron_deposits (
    tx_hash, user_id, asset, amount, from_address, to_address,
    block_number, block_timestamp, status, credited_at
  ) VALUES (
    trim(p_tx_hash), p_user_id, v_asset, p_amount, trim(p_from_address),
    trim(p_to_address), p_block_number, p_block_timestamp, 'credited', NOW()
  )
  ON CONFLICT (tx_hash) DO NOTHING
  RETURNING * INTO v_deposit;

  IF NOT FOUND THEN
    SELECT * INTO v_existing FROM tron_deposits
    WHERE tx_hash = trim(p_tx_hash) FOR UPDATE;

    IF v_existing.user_id <> p_user_id THEN
      RETURN jsonb_build_object('ok', false, 'error', 'deposit_already_claimed');
    END IF;

    v_after := CASE WHEN v_asset = 'USDT' THEN v_wallet.usdt_balance ELSE v_wallet.trx_balance END;
    RETURN jsonb_build_object(
      'ok', true,
      'already_credited', true,
      'deposit_id', v_existing.id,
      'tx_hash', v_existing.tx_hash,
      'asset', v_existing.asset,
      'amount', v_existing.amount,
      'new_balance', v_after
    );
  END IF;

  v_before := CASE WHEN v_asset = 'USDT' THEN v_wallet.usdt_balance ELSE v_wallet.trx_balance END;
  v_after := v_before + p_amount;

  IF v_asset = 'USDT' THEN
    UPDATE internal_wallets
    SET usdt_balance = v_after, updated_at = NOW()
    WHERE user_id = p_user_id;
  ELSE
    UPDATE internal_wallets
    SET trx_balance = v_after, updated_at = NOW()
    WHERE user_id = p_user_id;
  END IF;

  INSERT INTO wallet_ledger (
    user_id, operation, reference_type, reference_id,
    asset, amount, balance_before, balance_after, description
  ) VALUES (
    p_user_id, 'deposit', 'tron_deposit', trim(p_tx_hash),
    v_asset, p_amount, v_before, v_after,
    'TRON deposit verified without MEMO'
  );

  RETURN jsonb_build_object(
    'ok', true,
    'already_credited', false,
    'deposit_id', v_deposit.id,
    'tx_hash', v_deposit.tx_hash,
    'asset', v_asset,
    'amount', p_amount,
    'new_balance', v_after
  );
END;
$$ LANGUAGE plpgsql;

-- Solo el Worker entra con la service_role. La anon key jamás debe poder
-- llamar una función que acredita saldo por su cuenta.
ALTER TABLE tron_deposits ENABLE ROW LEVEL SECURITY;

REVOKE EXECUTE ON FUNCTION credit_tron_deposit(
  TEXT, TEXT, TEXT, DECIMAL, TEXT, TEXT, TIMESTAMPTZ, BIGINT
) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE EXECUTE ON FUNCTION credit_tron_deposit(
      TEXT, TEXT, TEXT, DECIMAL, TEXT, TEXT, TIMESTAMPTZ, BIGINT
    ) FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE EXECUTE ON FUNCTION credit_tron_deposit(
      TEXT, TEXT, TEXT, DECIMAL, TEXT, TEXT, TIMESTAMPTZ, BIGINT
    ) FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION credit_tron_deposit(
      TEXT, TEXT, TEXT, DECIMAL, TEXT, TEXT, TIMESTAMPTZ, BIGINT
    ) TO service_role;
  END IF;
END $$;
