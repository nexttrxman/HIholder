-- ============================================================================
-- MIGRACION v3.0 — RETIROS (cola manual)
-- ============================================================================
-- Correlo en Supabase -> SQL Editor, DESPUES de migrate-v2.9.sql y ANTES de
-- redeployar el Worker. Si no, POST /withdraw falla porque la funcion
-- request_withdrawal() no existe.
--
-- Es idempotente: se puede correr varias veces sin romper nada.
-- No borra ni modifica datos existentes.
--
-- Que crea:
--   withdrawal_requests   la cola: pending | paid | rejected | cancelled
--   withdrawal_config     una fila: fee 5.5 TRX, min USDT 5, min TRX 10,
--                         max 3 pedidos pendientes por usuario
--   withdrawal_settings() lee la config (para que la UI no invente el fee)
--   request_withdrawal()  valida y debita en UNA transaccion
--   resolve_withdrawal()  cierra el pedido; si lo rechazan, DEVUELVE el dinero
--
-- El Worker NO firma nada en cadena y NO necesita clave privada nueva.
--
-- El cuerpo de este archivo ES el bloque v3.0 de supabase/schema.sql, sin
-- cambios: si se toca uno, se toca el otro.
--
-- Al final hay un SELECT de verificacion: debe devolver 5 filas, todas "OK".
-- (El SQL Editor muestra solo el resultado de la ULTIMA sentencia.)
-- ============================================================================

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

-- ============================================================================
-- VERIFICACION — debe devolver 5 filas, todas "OK"
-- ============================================================================
SELECT * FROM (
  SELECT 1 AS n, 'tabla withdrawal_requests' AS que,
    CASE WHEN to_regclass('public.withdrawal_requests') IS NOT NULL
         THEN 'OK' ELSE 'FALTA' END AS estado
  UNION ALL
  SELECT 2, 'tabla withdrawal_config',
    CASE WHEN to_regclass('public.withdrawal_config') IS NOT NULL
         THEN 'OK' ELSE 'FALTA' END
  UNION ALL
  SELECT 3, 'config cargada (fee 5.5)',
    CASE WHEN (SELECT fee_trx FROM withdrawal_config WHERE id = 1) = 5.5
         THEN 'OK' ELSE 'FALTA' END
  UNION ALL
  SELECT 4, 'funciones (deben ser 3)',
    CASE WHEN (SELECT count(*) FROM pg_proc p
               JOIN pg_namespace n ON n.oid = p.pronamespace
               WHERE n.nspname = 'public'
                 AND p.proname IN ('withdrawal_settings','request_withdrawal','resolve_withdrawal')) = 3
         THEN 'OK' ELSE 'FALTA' END
  UNION ALL
  SELECT 5, 'RLS activa en las 2 tablas',
    CASE WHEN (SELECT count(*) FROM pg_class
               WHERE relname IN ('withdrawal_requests','withdrawal_config')
                 AND relrowsecurity) = 2
         THEN 'OK' ELSE 'FALTA' END
) v ORDER BY n;
