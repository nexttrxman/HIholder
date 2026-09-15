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

  -- El depósito siempre conserva su valor en GRAM (ton_balance). Solo un
  -- primer ingreso de al menos 1 GRAM puede completar First Deposit; un
  -- ingreso menor sigue siendo válido para la wallet, pero no cobra la misión.
  IF p_amount >= 1 THEN
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

-- =====================================================================
-- v3.7 canonical mission sync: GRAM wallet review and weekly referrals
-- =====================================================================
-- v3.3 is the source seed for new databases; this idempotent sync also fixes
-- installations that already ran v3.3 before the GRAM rename.
ALTER TABLE social_missions DROP CONSTRAINT IF EXISTS social_missions_verify_check;
ALTER TABLE social_missions ADD CONSTRAINT social_missions_verify_check
  CHECK (verify IN ('telegram_member', 'honor', 'manual', 'automatic', 'progress'));

UPDATE social_missions
SET description = 'Make your first deposit (min 1GRAM or 1 USDT). (review automatico con la wallet)',
    reward_usdt = 1.00,
    verify = 'automatic',
    reward_keep = 3000,
    repeat = 'once',
    goal = NULL,
    progress_type = NULL
WHERE id = 'first_deposit';

UPDATE social_missions
SET description = 'Invite 5 friends this week.',
    reward_usdt = 2.50,
    reward_keep = 5000,
    verify = 'progress',
    repeat = 'weekly',
    goal = 5,
    progress_type = 'referrals_week'
WHERE id = 'weekly_referral';
