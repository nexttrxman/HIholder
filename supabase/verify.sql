-- =============================================================================
-- VERIFICACIÓN POST-DEPLOY DE supabase/schema.sql
-- =============================================================================
-- Pegar esto en el SQL Editor de Supabase y ejecutar. No modifica nada:
-- la parte A es de solo lectura y la parte B corre dentro de una transacción
-- que termina en ROLLBACK.
--
-- Qué confirma:
--   A) estructura: tablas, funciones con la firma correcta, constraints, RLS,
--      permisos de los RPC, job de pg_cron y tablas legacy que se renombraron
--   B) humo: ejercita de verdad register_referral, credit_claim (incluido el
--      cooldown de 8 h y el pago al referente), sell_wallet_asset, open_trade,
--      set_trade_levels, close_trade y daily_checkin
-- =============================================================================

-- -----------------------------------------------------------------------------
-- PARTE A — ESTRUCTURA
-- -----------------------------------------------------------------------------
WITH esperado(tabla) AS (
  VALUES ('users'),('hold_cycles'),('holds'),('claims'),('claim_payments'),
         ('internal_wallets'),('wallet_ledger'),('transactions'),('checkins'),
         ('referrals'),('referral_pool'),('trade_positions')
),
tablas AS (
  SELECT e.tabla,
         to_regclass('public.' || e.tabla) IS NOT NULL AS existe,
         COALESCE((SELECT c.relrowsecurity FROM pg_class c
                   JOIN pg_namespace n ON n.oid = c.relnamespace
                   WHERE n.nspname='public' AND c.relname = e.tabla), false) AS rls
  FROM esperado e
),
esperado_fn(nombre, firma) AS (
  VALUES
    ('credit_claim',           'p_claim_id text, p_tx_hash text, p_amount numeric, p_from_address text, p_cooldown_hours integer'),
    ('register_referral',      'p_referrer_uid text, p_referred_id text, p_referred_username text'),
    ('confirm_pending_referral','p_user_id text'),
    ('expire_claims_and_cycles',''),
    ('daily_checkin',          'p_user_id text'),
    ('sell_wallet_asset',      'p_user_id text, p_asset text, p_amount numeric, p_price numeric'),
    ('open_trade',             'p_user_id text, p_pair text, p_amount numeric, p_price numeric, p_take_profit numeric, p_stop_loss numeric'),
    ('close_trade',            'p_user_id text, p_position_id uuid, p_price numeric'),
    ('set_trade_levels',       'p_user_id text, p_position_id uuid, p_take_profit numeric, p_stop_loss numeric')
),
funciones AS (
  SELECT e.nombre,
         EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                 WHERE n.nspname='public' AND p.proname = e.nombre
                   AND pg_get_function_identity_arguments(p.oid) = e.firma) AS existe
  FROM esperado_fn e
),
permisos AS (
  -- Los RPC son SECURITY DEFINER: si PUBLIC/anon/authenticated conservan
  -- EXECUTE, cualquiera puede acreditarse un claim sin pagar.
  --
  -- Se consulta pg_roles en vez de pasar el nombre como texto: en esa posición
  -- el literal 'public' deja ambigua la firma de has_function_privilege y Postgres
  -- falla con "expected a left parenthesis". anon/authenticated solo existen en
  -- Supabase, por eso el EXISTS: en una base local se evalúan los que haya.
  SELECT count(*) AS filtrados
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname='public'
    AND p.proname IN ('credit_claim','register_referral','confirm_pending_referral',
                      'expire_claims_and_cycles','daily_checkin','sell_wallet_asset',
                      'open_trade','close_trade','set_trade_levels')
    AND (
      has_function_privilege('public'::name, p.oid, 'EXECUTE')
      OR EXISTS (
        SELECT 1 FROM pg_roles r
        WHERE r.rolname IN ('anon', 'authenticated')
          AND has_function_privilege(r.oid, p.oid, 'EXECUTE')
      )
    )
),
legacy AS (
  SELECT string_agg(table_name, ', ' ORDER BY table_name) AS renombradas
  FROM information_schema.tables
  WHERE table_schema='public' AND table_name LIKE '%\_legacy'
),
cron AS (
  SELECT to_regclass('cron.job') IS NOT NULL AS disponible
)
SELECT 'tabla ' || tabla AS chequeo, existe::text AS resultado, 'true' AS esperado,
       CASE WHEN existe THEN 'OK' ELSE 'FALTA' END AS estado
FROM tablas
UNION ALL
SELECT 'RLS activo en ' || tabla, rls::text, 'true',
       CASE WHEN rls THEN 'OK' ELSE 'SIN RLS' END
FROM tablas
UNION ALL
SELECT 'función ' || nombre, existe::text, 'true',
       CASE WHEN existe THEN 'OK' ELSE 'FALTA O FIRMA DISTINTA' END
FROM funciones
UNION ALL
SELECT 'credit_claim de 4 params eliminada (si no, llamada ambigua)',
       (SELECT count(*)::text FROM pg_proc WHERE proname='credit_claim'
        AND pg_get_function_identity_arguments(oid) =
            'p_claim_id text, p_tx_hash text, p_amount numeric, p_from_address text'),
       '0', 'ver arriba'
UNION ALL
SELECT 'UNIQUE(referrer_id, referred_id) en referrals',
       (SELECT count(*)::text FROM pg_constraint
        WHERE conrelid='referrals'::regclass AND contype='u'
          AND pg_get_constraintdef(oid) ILIKE '%referrer_id%referred_id%'),
       '1', 'ver arriba'
UNION ALL
SELECT 'UNIQUE(cycle_id) en claims (un claim activo por ciclo)',
       (SELECT count(*)::text FROM pg_constraint
        WHERE conrelid='claims'::regclass AND contype='u'
          AND pg_get_constraintdef(oid) ILIKE '%cycle_id%'),
       '1', 'ver arriba'
UNION ALL
SELECT 'RPC sin EXECUTE para PUBLIC/anon/authenticated',
       (SELECT filtrados::text FROM permisos), '0', 'ver arriba'
UNION ALL
SELECT 'tablas renombradas a *_legacy por la migración',
       COALESCE((SELECT renombradas FROM legacy), '(ninguna)'), '-', 'informativo'
UNION ALL
SELECT 'pg_cron disponible', (SELECT disponible::text FROM cron), 'true en Supabase', 'ver arriba'
ORDER BY 1;

-- Job programado. cron.job no existe si la extensión pg_cron no está habilitada
-- en el proyecto, así que se consulta por SQL dinámico en vez de reventar.
DO $$
BEGIN
  IF to_regclass('cron.job') IS NULL THEN
    RAISE NOTICE 'pg_cron no está habilitado: expire_claims_and_cycles() no se ejecuta solo. Habilitá la extensión en Database > Extensions y volvé a correr schema.sql.';
    RETURN;
  END IF;
  PERFORM 1 FROM cron.job WHERE jobname = 'tronkeeper-expire-claims';
  IF FOUND THEN
    RAISE NOTICE 'PASS  job pg_cron tronkeeper-expire-claims programado';
  ELSE
    RAISE NOTICE 'FAIL  pg_cron está habilitado pero el job no existe';
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- PARTE B — HUMO (transaccional: termina en ROLLBACK, no deja datos)
-- -----------------------------------------------------------------------------
BEGIN;

CREATE TEMP TABLE _v (nombre TEXT, ok BOOLEAN, detalle TEXT) ON COMMIT DROP;

DO $$
DECLARE
  v_ref TEXT := 'ZZ_VERIFY_REF';
  v_inv TEXT := 'ZZ_VERIFY_INV';
  v_r JSONB;
  v_cyc UUID;
  v_pos UUID;
  v_horas NUMERIC;
  v_estado TEXT;
  v_holds INT;
  v_trx NUMERIC;
  v_usdt NUMERIC;
BEGIN
  INSERT INTO users (telegram_id, uid, username) VALUES (v_ref, 'ZZVREF', 'referente');
  INSERT INTO users (telegram_id, uid, username) VALUES (v_inv, 'ZZVINV', 'invitado');

  -- 1) referido -------------------------------------------------------------
  v_r := register_referral('ZZVREF', v_inv, 'invitado');
  INSERT INTO _v VALUES ('register_referral acepta el alta', COALESCE((v_r->>'ok')::boolean, false), v_r::text);
  INSERT INTO _v VALUES ('register_referral la deja pending',
    (SELECT status FROM referrals WHERE referred_id = v_inv) = 'pending', '');
  INSERT INTO _v VALUES ('register_referral pone 2 TRX',
    (SELECT reward_amount FROM referrals WHERE referred_id = v_inv) = 2, '');

  v_r := register_referral('ZZVINV', v_inv, NULL);
  INSERT INTO _v VALUES ('register_referral rechaza auto-referido',
    COALESCE(v_r->>'error','') = 'self_referral', v_r::text);

  -- 2) ciclo completo + claim ----------------------------------------------
  INSERT INTO hold_cycles (user_id, ends_at, holds_completed, status)
  VALUES (v_inv, NOW() + INTERVAL '6 hours', 3, 'active') RETURNING id INTO v_cyc;
  INSERT INTO claims (claim_id, user_id, cycle_id, total_prize, ton_fee, status, expires_at)
  VALUES ('CLM_ZZV', v_inv, v_cyc, 0.60, 0.15, 'pending', NOW() + INTERVAL '10 minutes');

  v_r := credit_claim('CLM_ZZV', 'TX_ZZV', 0.15, '0:zz', 8);
  INSERT INTO _v VALUES ('credit_claim acredita', COALESCE((v_r->>'ok')::boolean, false), v_r::text);

  SELECT ROUND(EXTRACT(EPOCH FROM (ends_at - NOW())) / 3600.0, 2), status, holds_completed
    INTO v_horas, v_estado, v_holds
  FROM hold_cycles WHERE id = v_cyc;
  INSERT INTO _v VALUES ('credit_claim cierra el ciclo', v_estado = 'completed', v_estado);
  INSERT INTO _v VALUES ('credit_claim lo deja en 3/3', v_holds = 3, v_holds::text);
  INSERT INTO _v VALUES ('credit_claim aplica el cooldown de 8 h',
    v_horas BETWEEN 7.9 AND 8.01, v_horas || ' h');

  v_r := credit_claim('CLM_ZZV', 'TX_ZZV_2', 0.15, '0:zz', 8);
  INSERT INTO _v VALUES ('credit_claim no acredita dos veces',
    COALESCE((v_r->>'ok')::boolean, true) = false, v_r::text);

  -- 3) el referente cobra en el primer claim del invitado -------------------
  SELECT trx_balance INTO v_trx FROM internal_wallets WHERE user_id = v_ref;
  INSERT INTO _v VALUES ('el referente recibió 2 TRX', v_trx = 2, COALESCE(v_trx::text,'sin wallet'));
  INSERT INTO _v VALUES ('el referido pasó a confirmed',
    (SELECT status FROM referrals WHERE referred_id = v_inv) = 'confirmed', '');
  INSERT INTO _v VALUES ('quedó el asiento en wallet_ledger',
    EXISTS (SELECT 1 FROM wallet_ledger
            WHERE user_id = v_ref AND operation = 'referral_bonus' AND asset = 'TRX'), '');

  -- 4) venta del saldo de la wallet ----------------------------------------
  v_r := sell_wallet_asset(v_ref, 'TRX', 1, 0.30);
  INSERT INTO _v VALUES ('sell_wallet_asset vende TRX', COALESCE((v_r->>'ok')::boolean, false), v_r::text);
  SELECT usdt_balance INTO v_usdt FROM internal_wallets WHERE user_id = v_ref;
  INSERT INTO _v VALUES ('sell_wallet_asset acredita USDT neto de fee',
    v_usdt BETWEEN 0.29 AND 0.30, v_usdt::text);
  v_r := sell_wallet_asset(v_ref, 'USDT', 1, 1);
  INSERT INTO _v VALUES ('sell_wallet_asset rechaza vender USDT',
    COALESCE((v_r->>'ok')::boolean, true) = false, v_r::text);

  -- 5) trading --------------------------------------------------------------
  -- El usuario de prueba no tiene saldo: open_trade lo rechaza con
  -- 'Insufficient USDT balance' y los tres chequeos siguientes caen en cascada.
  UPDATE internal_wallets SET usdt_balance = usdt_balance + 500 WHERE user_id = v_ref;

  v_r := open_trade(v_ref, 'TONUSDT', 50, 1.39, 1.50, 1.30);
  INSERT INTO _v VALUES ('open_trade abre posición', COALESCE((v_r->>'ok')::boolean, false), v_r::text);
  -- open_trade devuelve la posición anidada en 'position', no 'position_id'.
  v_pos := (v_r->'position'->>'id')::uuid;
  v_r := set_trade_levels(v_ref, v_pos, 1.55, 1.28);
  INSERT INTO _v VALUES ('set_trade_levels actualiza TP/SL', COALESCE((v_r->>'ok')::boolean, false), v_r::text);
  v_r := close_trade(v_ref, v_pos, 1.45);
  INSERT INTO _v VALUES ('close_trade cierra y realiza PnL', COALESCE((v_r->>'ok')::boolean, false), v_r::text);
  -- trade_positions.pair es TEXT sin CHECK: la lista blanca de pares vive en el
  -- Worker (ALLOWED_PAIRS en cloudflare-worker/lib.js), no en la base. No se
  -- puede verificar acá; se deja constancia para que nadie asuma lo contrario.
  INSERT INTO _v VALUES ('trade_positions.pair no tiene CHECK (la validación es del Worker)',
    NOT EXISTS (SELECT 1 FROM pg_constraint
                WHERE conrelid='trade_positions'::regclass
                  AND contype = 'c'
                  AND pg_get_constraintdef(oid) ILIKE '%pair%'), '');
  -- Ojo con contype: sin el filtro, el NOT NULL pair también matchea y el
  -- chequeo da FAIL aunque no haya ningún CHECK.

  -- 6) check-in (daily_checkin devuelve json, no jsonb) ---------------------
  v_r := daily_checkin(v_inv)::jsonb;
  INSERT INTO _v VALUES ('daily_checkin paga el día', COALESCE((v_r->>'ok')::boolean, false), v_r::text);
  v_r := daily_checkin(v_inv)::jsonb;
  INSERT INTO _v VALUES ('daily_checkin rechaza el segundo check-in del día',
    COALESCE(v_r->>'error','') = 'already_checked_in', v_r::text);
END $$;

-- Resultado del humo. Cualquier FAIL significa que el deploy no está completo.
SELECT CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS estado, nombre, detalle
FROM _v ORDER BY ok, nombre;

SELECT count(*) FILTER (WHERE ok) || ' / ' || count(*) ||
       CASE WHEN bool_and(ok) THEN '  — todo OK' ELSE '  — HAY FALLAS' END AS resumen_humo
FROM _v;

ROLLBACK;
