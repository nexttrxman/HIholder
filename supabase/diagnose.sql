-- =============================================================================
-- DIAGNÓSTICO: ¿qué partes de schema.sql ya están aplicadas en este proyecto?
-- =============================================================================
-- SOLO LECTURA. No crea, no altera, no borra nada. Es seguro correrlo cuando
-- quieras.
--
-- Es UNA sola sentencia a propósito: el SQL Editor de Supabase muestra
-- únicamente el resultado de la ÚLTIMA, así que varias sentencias sueltas
-- parecen "no haber hecho nada".
--
-- Cómo leerlo:
--   OK        -> aplicado, no hay que hacer nada
--   FALTA     -> no aplicado: hay que correr schema.sql (o el bloque indicado)
--   REVISAR   -> aplicado pero de una forma que conviene mirar a mano
--
-- Si aparece algún FALTA, correr supabase/schema.sql completo es seguro: está
-- escrito para ser reejecutable (CREATE TABLE IF NOT EXISTS, ALTER ... IF NOT
-- EXISTS, DROP ... IF EXISTS, y la acreditación del TRX es idempotente por
-- fila de ledger). Verificar después con supabase/verify.sql.

WITH
-- Tablas que el schema debe dejar creadas
tablas_esperadas(t) AS (VALUES
  ('users'),('internal_wallets'),('wallet_ledger'),('transactions'),
  ('holds'),('hold_cycles'),('claims'),('claim_payments'),
  ('referrals'),('referral_pool'),('trade_positions'),('checkins')
),
tablas_presentes AS (
  SELECT t,
         to_regclass('public.' || t) IS NOT NULL AS existe
  FROM tablas_esperadas
),
-- Funciones que el schema define
funcs_esperadas(f) AS (VALUES
  ('credit_claim'),('register_referral'),('confirm_pending_referral'),
  ('expire_claims_and_cycles'),('daily_checkin'),('sell_wallet_asset'),
  ('open_trade'),('close_trade'),('set_trade_levels'),
  ('update_updated_at'),('wallet_ledger_apply_operation_check')
),
funcs_presentes AS (
  SELECT f,
         EXISTS (
           SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'public' AND p.proname = f
         ) AS existe
  FROM funcs_esperadas
),
rls AS (
  SELECT count(*)::int AS total,
         count(*) FILTER (WHERE c.relrowsecurity)::int AS con_rls
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'r'
    AND c.relname IN (SELECT t FROM tablas_esperadas)
),
ledger_check AS (
  SELECT pg_get_constraintdef(oid) AS def
  FROM pg_constraint
  WHERE conrelid = 'public.wallet_ledger'::regclass AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%operation%'
  LIMIT 1
),
bonus AS (
  SELECT
    (SELECT count(*)::int FROM internal_wallets) AS wallets,
    (SELECT count(*)::int FROM wallet_ledger WHERE operation = 'signup_bonus') AS acreditados,
    (SELECT count(*)::int FROM internal_wallets WHERE trx_balance >= 1) AS con_trx
),
legacy AS (
  SELECT count(*)::int AS n
  FROM information_schema.tables
  WHERE table_schema = 'public' AND table_name LIKE '%\_legacy'
),
dinero_publicas AS (
  SELECT count(*)::int AS n
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname IN ('credit_claim','register_referral','confirm_pending_referral',
                      'expire_claims_and_cycles','daily_checkin','sell_wallet_asset',
                      'open_trade','close_trade','set_trade_levels')
    AND has_function_privilege('public'::name, p.oid, 'EXECUTE')
)

SELECT * FROM (
  SELECT 1 AS "#", 'Tablas creadas' AS chequeo,
         (SELECT count(*)::text FROM tablas_presentes WHERE existe) || ' / 12' AS valor,
         '12 / 12' AS esperado,
         CASE WHEN (SELECT count(*) FROM tablas_presentes WHERE existe) = 12
              THEN 'OK' ELSE 'FALTA' END AS estado
  UNION ALL
  SELECT 2, 'Funciones creadas',
         (SELECT count(*)::text FROM funcs_presentes WHERE existe) || ' / 11',
         '11 / 11',
         CASE WHEN (SELECT count(*) FROM funcs_presentes WHERE existe) = 11
              THEN 'OK' ELSE 'FALTA' END
  UNION ALL
  -- Dos open_trade = overload ambiguo: llamar con 4 argumentos revienta con
  -- "function open_trade(...) is not unique". El schema dropea la firma vieja
  -- antes de crear la nueva, así que debe dar exactamente 1.
  SELECT 3, 'open_trade: una sola firma (sin overload)',
         (SELECT count(*)::text FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname='public' AND p.proname='open_trade'),
         '1',
         CASE WHEN (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                    WHERE n.nspname='public' AND p.proname='open_trade') = 1
              THEN 'OK' ELSE 'REVISAR' END
  UNION ALL
  -- v2.4: Take Profit / Stop Loss
  SELECT 4, 'trade_positions.take_profit / stop_loss (v2.4)',
         (SELECT count(*)::text FROM information_schema.columns
          WHERE table_schema='public' AND table_name='trade_positions'
            AND column_name IN ('take_profit','stop_loss')) || ' / 2',
         '2 / 2',
         CASE WHEN (SELECT count(*) FROM information_schema.columns
                    WHERE table_schema='public' AND table_name='trade_positions'
                      AND column_name IN ('take_profit','stop_loss')) = 2
              THEN 'OK' ELSE 'FALTA' END
  UNION ALL
  SELECT 5, 'users.ton_wallet_address',
         CASE WHEN EXISTS (SELECT 1 FROM information_schema.columns
                           WHERE table_schema='public' AND table_name='users'
                             AND column_name='ton_wallet_address')
              THEN 'si' ELSE 'no' END,
         'si',
         CASE WHEN EXISTS (SELECT 1 FROM information_schema.columns
                           WHERE table_schema='public' AND table_name='users'
                             AND column_name='ton_wallet_address')
              THEN 'OK' ELSE 'FALTA' END
  UNION ALL
  -- v2.6: check-in diario
  SELECT 6, 'daily_checkin() existe (v2.6)',
         CASE WHEN (SELECT existe FROM funcs_presentes WHERE f='daily_checkin')
              THEN 'si' ELSE 'no' END, 'si',
         CASE WHEN (SELECT existe FROM funcs_presentes WHERE f='daily_checkin')
              THEN 'OK' ELSE 'FALTA' END
  UNION ALL
  SELECT 7, 'CHECK del ledger acepta checkin_daily (v2.6)',
         CASE WHEN (SELECT def FROM ledger_check) LIKE '%checkin_daily%'
              THEN 'si' ELSE 'no' END, 'si',
         CASE WHEN (SELECT def FROM ledger_check) LIKE '%checkin_daily%'
              THEN 'OK' ELSE 'FALTA' END
  UNION ALL
  -- v2.8: venta de activo desde la wallet interna
  SELECT 8, 'sell_wallet_asset() existe (v2.8)',
         CASE WHEN (SELECT existe FROM funcs_presentes WHERE f='sell_wallet_asset')
              THEN 'si' ELSE 'no' END, 'si',
         CASE WHEN (SELECT existe FROM funcs_presentes WHERE f='sell_wallet_asset')
              THEN 'OK' ELSE 'FALTA' END
  UNION ALL
  -- v2.8.1: un claim no cobrado pierde los 3 holds y el ciclo vuelve a 0.
  -- Se verifica leyendo el cuerpo de la función, no su existencia: la función
  -- puede existir en la versión vieja, que dejaba el ciclo trabado en 3/3.
  SELECT 9, 'expire_claims_and_cycles() reinicia los holds (v2.8.1)',
         CASE WHEN EXISTS (
                SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                WHERE n.nspname='public' AND p.proname='expire_claims_and_cycles'
                  AND p.prosrc LIKE '%holds_completed = 0%')
              THEN 'si' ELSE 'no' END, 'si',
         CASE WHEN EXISTS (
                SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                WHERE n.nspname='public' AND p.proname='expire_claims_and_cycles'
                  AND p.prosrc LIKE '%holds_completed = 0%')
              THEN 'OK' ELSE 'FALTA' END
  UNION ALL
  -- v2.9: 1 TRX de bienvenida
  SELECT 10, 'CHECK del ledger acepta signup_bonus (v2.9)',
         CASE WHEN (SELECT def FROM ledger_check) LIKE '%signup_bonus%'
              THEN 'si' ELSE 'no' END, 'si',
         CASE WHEN (SELECT def FROM ledger_check) LIKE '%signup_bonus%'
              THEN 'OK' ELSE 'FALTA' END
  UNION ALL
  SELECT 11, 'TRX de bienvenida acreditado (v2.9)',
         (SELECT acreditados::text FROM bonus) || ' de ' || (SELECT wallets::text FROM bonus) || ' wallets',
         'wallets = acreditados',
         CASE WHEN (SELECT wallets FROM bonus) = (SELECT acreditados FROM bonus)
              THEN 'OK' ELSE 'FALTA' END
  UNION ALL
  -- Seguridad (v2.6.1)
  SELECT 12, 'RLS activo en todas las tablas',
         (SELECT con_rls::text FROM rls) || ' / ' || (SELECT total::text FROM rls),
         'iguales',
         CASE WHEN (SELECT con_rls FROM rls) = (SELECT total FROM rls)
              THEN 'OK' ELSE 'FALTA' END
  UNION ALL
  SELECT 13, 'Funciones de plata NO ejecutables por PUBLIC',
         (SELECT n::text FROM dinero_publicas), '0',
         CASE WHEN (SELECT n FROM dinero_publicas) = 0 THEN 'OK' ELSE 'FALTA' END
  UNION ALL
  -- El pg_cron es lo que expira los claims cada minuto. Tras el fix de /hold ya
  -- no es imprescindible, pero conviene tenerlo.
  --
  -- OJO: acá solo se puede mirar si la EXTENSION existe, usando to_regclass().
  -- Leer cron.job directamente dentro de este SELECT revienta en PARSE TIME con
  -- "relation cron.job does not exist" cuando pg_cron no está habilitado, y se
  -- lleva puesto el diagnóstico entero. El estado del job va en la segunda
  -- sentencia, al final del archivo.
  SELECT 14, 'pg_cron instalado',
         CASE WHEN to_regclass('cron.job') IS NULL THEN 'no' ELSE 'si' END,
         'si',
         CASE WHEN to_regclass('cron.job') IS NULL THEN 'REVISAR' ELSE 'OK' END
  UNION ALL
  -- Si quedaron tablas *_legacy, la migración renombró las viejas porque
  -- conflictuaban. No es un error, pero conviene saberlo.
  SELECT 15, 'Tablas *_legacy de la migración',
         (SELECT n::text FROM legacy), '0',
         CASE WHEN (SELECT n FROM legacy) = 0 THEN 'OK' ELSE 'REVISAR' END
) AS diagnostico
ORDER BY "#";


-- =============================================================================
-- SEGUNDA SENTENCIA (opcional): estado del job de pg_cron.
-- =============================================================================
-- Correr SOLO si la fila 14 de arriba dijo "si". Si pg_cron no está habilitado
-- esto da error "relation cron.job does not exist", y ese error ES la respuesta.
-- Está separado a propósito: mezclado en el SELECT de arriba, la referencia a
-- cron.job se resuelve al parsear y rompe todo el diagnóstico.
SELECT jobid, jobname, schedule, active,
       (SELECT count(*) FROM cron.job_run_details d
        WHERE d.jobid = j.jobid AND d.status = 'succeeded')  AS exitos,
       (SELECT count(*) FROM cron.job_run_details d
        WHERE d.jobid = j.jobid AND d.status = 'failed')     AS fallidos,
       (SELECT max(end_time) FROM cron.job_run_details d
        WHERE d.jobid = j.jobid)                             AS ultima_ejecucion
FROM cron.job j
WHERE j.jobname = 'tronkeeper-expire-claims';
