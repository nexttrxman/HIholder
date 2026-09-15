-- =============================================================================
-- MIGRACIÓN v2.9 — 1 TRX de bienvenida (bloque standalone, extraído de schema.sql)
-- =============================================================================
-- Solo lectura de schema.sql: esto es exactamente el bloque v2.9, separado para
-- poder correrlo sin ejecutar el archivo entero. Es idempotente: correrlo dos
-- veces no acredita dos veces.
--
-- Requiere que exista wallet_ledger_apply_operation_check() (chequeo 2 de
-- diagnose.sql = 11/11 funciones, así que ya está).

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
