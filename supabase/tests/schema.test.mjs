// Verificación real de supabase/schema.sql contra un PostgreSQL embebido.
// Levanta un Postgres de verdad (initdb + pg_ctl), carga el schema entero y
// ejercita las funciones que llama el worker. Es la única prueba que cubre el
// plpgsql: los tests del worker no tocan SQL.
//
//   cd supabase/tests && npm install && npm test
//
// Tiene su propio package.json a propósito: no toca el node_modules del
// frontend ni el del worker.
import EmbeddedPostgres from 'embedded-postgres';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA = process.env.SCHEMA_PATH || path.resolve(HERE, '..', 'schema.sql');
const LIBJS = pathToFileURL(path.resolve(HERE, '..', '..', 'cloudflare-worker', 'lib.js')).href;
const DATADIR = path.join(HERE, 'pgdata');
const PORT = Number(process.env.PGTEST_PORT || 55432);
const results = [];
let failures = 0;

function check(name, ok, detail) {
  results.push({ name, ok, detail });
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  → ${detail}` : ''}`);
}

const eq = (name, actual, expected) =>
  check(name, String(actual) === String(expected), `got ${actual}, want ${expected}`);

const near = (name, actual, expected, tol = 0.000001) =>
  check(name, Math.abs(Number(actual) - expected) <= tol, `got ${actual}, want ~${expected}`);

const db = new EmbeddedPostgres({
  databaseDir: DATADIR,
  user: 'postgres',
  password: 'postgres',
  port: PORT,
  persistent: false,
});

await db.initialise();
await db.start();
const client = new pg.Client(`postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`);
await client.connect();
const q = (sql, p) => client.query(sql, p);
const one = async (sql, p) => (await q(sql, p)).rows[0];

// ---- 1) El schema completo tiene que cargar -------------------------------
let sql = fs.readFileSync(SCHEMA, 'utf8');
// pg_cron no existe fuera de Supabase; el schema ya prevé ese caso (EXCEPTION
// WHEN undefined_function). Solo salteamos el CREATE EXTENSION, que es lo único
// que abortaría la carga. En Supabase está habilitado desde el panel.
sql = sql.replace('CREATE EXTENSION IF NOT EXISTS "pg_cron";', '-- pg_cron: solo en Supabase');
let loadError = null;
try {
  await q(sql);
} catch (e) {
  loadError = e;
}
check('schema.sql carga de punta a punta', !loadError, loadError ? `${loadError.message}` : `${sql.split(String.fromCharCode(10)).length} líneas`);
if (loadError) {
  console.log('\nNo se puede continuar sin el schema cargado.');
  await client.end(); await db.stop();
  process.exit(1);
}

// Las 5 funciones que llama el worker tienen que existir con esa firma
for (const [fn, args] of [
  ['credit_claim', 'p_claim_id text, p_tx_hash text, p_amount numeric, p_from_address text'],
  ['open_trade', 'p_user_id text, p_pair text, p_amount numeric, p_price numeric, p_take_profit numeric, p_stop_loss numeric'],
  ['close_trade', 'p_user_id text, p_position_id uuid, p_price numeric'],
  ['set_trade_levels', 'p_user_id text, p_position_id uuid, p_take_profit numeric, p_stop_loss numeric'],
  ['daily_checkin', 'p_user_id text'],
  ['expire_claims_and_cycles', ''],
]) {
  const r = await one(
    `SELECT count(*)::int n FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname=$1
       AND pg_get_function_identity_arguments(p.oid) = $2`,
    [fn, args],
  );
  eq(`existe ${fn}(${args})`, r.n, 1);
}
// La firma vieja de 4 params tiene que haber sido dropeada (si no, ambigüedad)
const old = await one(
  `SELECT count(*)::int n FROM pg_proc WHERE proname='open_trade'
   AND pg_get_function_identity_arguments(oid)='p_user_id text, p_pair text, p_amount numeric, p_price numeric'`,
);
eq('open_trade de 4 params fue eliminada', old.n, 0);

// ---- helpers de seed ------------------------------------------------------
let seq = 0;
async function seedUser(balance = 0) {
  const id = `tg_${++seq}_${Date.now() % 100000}`;
  await q(`INSERT INTO users (telegram_id, uid) VALUES ($1, $2)`, [id, `uid_${id}`]);
  await q(`INSERT INTO internal_wallets (user_id, usdt_balance) VALUES ($1, $2)`, [id, balance]);
  return id;
}

// ---- 2) EL BUG DEL CRON: claim expirado sin reclamar ---------------------
{
  const u = await seedUser(0);
  const cyc = await one(
    `INSERT INTO hold_cycles (user_id, ends_at, holds_completed, status)
     VALUES ($1, NOW() + INTERVAL '6 hours', 3, 'active') RETURNING id`, [u]);
  await q(
    `INSERT INTO claims (claim_id, user_id, cycle_id, total_prize, ton_fee, status, expires_at)
     VALUES ('CLM_TEST_1', $1, $2, 0.18, 0.05, 'pending', NOW() - INTERVAL '1 minute')`,
    [u, cyc.id]);

  await q(`SELECT expire_claims_and_cycles()`);

  const claim = await one(`SELECT status FROM claims WHERE claim_id='CLM_TEST_1'`);
  eq('cron: claim pasa a expired_unclaimed', claim.status, 'expired_unclaimed');

  const c = await one(`SELECT holds_completed FROM hold_cycles WHERE id=$1`, [cyc.id]);
  // v2.7.1: ya no se pierden. El claim expirado se regenera desde /get-claim
  // con el mismo premio acumulado, en vez de obligar a esperar las 8 h.
  eq('cron: el ciclo conserva los 3 holds (regla v2.7.1)', c.holds_completed, 3);
}

// ---- 3) open_trade / close_trade ----------------------------------------
{
  const u = await seedUser(250);
  const r = await one(`SELECT open_trade($1,'TONUSDT',50,3.5,NULL,NULL) AS r`, [u]);
  const bal = await one(`SELECT usdt_balance FROM internal_wallets WHERE user_id=$1`, [u]);
  near('open_trade: 250 - 50 - fee 0.05 = 199.95', bal.usdt_balance, 199.95, 0.0001);

  const pos = await one(`SELECT * FROM trade_positions WHERE user_id=$1 AND status='open'`, [u]);
  near('open_trade: qty = 50/3.5 = 14.285714', pos.qty, 14.2857142857, 0.0001);
  near('open_trade: fee 0.1%', pos.fee_paid, 0.05, 0.0001);
  near('open_trade: cost_basis', pos.cost_basis, 50, 0.0001);
  eq('open_trade: status', pos.status, 'open');

  // TP/SL guardados
  const r2 = await one(`SELECT open_trade($1,'BTCUSDT',100,60000,63000,58200) AS r`, [u]);
  const p2 = await one(`SELECT take_profit, stop_loss FROM trade_positions WHERE user_id=$1 AND pair='BTCUSDT'`, [u]);
  near('open_trade: guarda take_profit', p2.take_profit, 63000, 0.01);
  near('open_trade: guarda stop_loss', p2.stop_loss, 58200, 0.01);

  // bracket inválido: devuelve {ok:false,error}, no RAISE
  const badTp = await one(`SELECT open_trade($1,'ETHUSDT',50,3000,2900,3100) AS r`, [u]);
  eq('open_trade: rechaza TP por debajo de la entrada', badTp.r.error, 'Take Profit must be above the entry price');
  const badSl = await one(`SELECT open_trade($1,'ETHUSDT',50,3000,3300,3100) AS r`, [u]);
  eq('open_trade: rechaza SL por encima de la entrada', badSl.r.error, 'Stop Loss must be below the entry price');
  eq('open_trade: el envelope marca ok=false', badTp.r.ok, false);

  // cierre total al mismo precio: -0.05 apertura -0.05 cierre = -0.10
  const beforeClose = await one(`SELECT usdt_balance FROM internal_wallets WHERE user_id=$1`, [u]);
  near('saldos: 250 -50.05 (TON) -100.10 (BTC) = 99.85', beforeClose.usdt_balance, 99.85, 0.0001);
  const c = await one(`SELECT close_trade($1,$2,3.5) AS r`, [u, pos.id]);
  near('close_trade: devuelve 49.95 (50 menos fee)', c.r.credit, 49.95, 0.0001);
  const bal2 = await one(`SELECT usdt_balance FROM internal_wallets WHERE user_id=$1`, [u]);
  near('close_trade: 99.85 + 49.95 = 149.80', bal2.usdt_balance, 149.80, 0.0001);
  const cp = await one(`SELECT status, realized_pnl, credit FROM trade_positions WHERE id=$1`, [pos.id]);
  eq('close_trade: posición cerrada', cp.status, 'closed');
  near('close_trade: realized_pnl -0.10', cp.realized_pnl, -0.10, 0.0001);

  // cerrar dos veces
  const twice = await one(`SELECT close_trade($1,$2,3.5) AS r`, [u, pos.id]);
  eq('close_trade: no se puede cerrar dos veces', twice.r.error, 'Position already closed');

  // saldo insuficiente
  const noFunds = await one(`SELECT open_trade($1,'TONUSDT',999999,3.5,NULL,NULL) AS r`, [u]);
  eq('open_trade: rechaza saldo insuficiente', noFunds.r.error, 'Insufficient USDT balance');
  const noWallet = await one(`SELECT open_trade('tg_inexistente','TONUSDT',10,3.5,NULL,NULL) AS r`);
  eq('open_trade: usuario sin wallet', noWallet.r.error, 'Wallet not found');
  const ghost = await one(`SELECT close_trade($1,'00000000-0000-0000-0000-000000000000',3.5) AS r`, [u]);
  eq('close_trade: posición inexistente', ghost.r.error, 'Position not found');

  // set_trade_levels
  const openPos = await one(`SELECT id FROM trade_positions WHERE user_id=$1 AND status='open'`, [u]);
  await q(`SELECT set_trade_levels($1,$2,63000,58200)`, [u, openPos.id]);
  const lv = await one(`SELECT take_profit, stop_loss FROM trade_positions WHERE id=$1`, [openPos.id]);
  near('set_trade_levels: actualiza TP', lv.take_profit, 63000, 0.01);
  near('set_trade_levels: actualiza SL', lv.stop_loss, 58200, 0.01);

  // El ledger es lo que muestra la pestaña Activity: tiene que quedar trazado.
  const led = {};
  for (const r of (await q(`SELECT operation, count(*)::int n FROM wallet_ledger WHERE user_id=$1 GROUP BY operation`, [u])).rows) {
    led[r.operation] = r.n;
  }
  eq('ledger: 2 compras registradas (trade_buy)', led.trade_buy, 2);
  eq('ledger: 1 venta registrada (trade_sell)', led.trade_sell, 1);
  const sell = await one(`SELECT amount, balance_after FROM wallet_ledger WHERE user_id=$1 AND operation='trade_sell'`, [u]);
  near('ledger: la venta acredita 49.95', sell.amount, 49.95, 0.0001);
  near('ledger: balance_after cuadra con la wallet', sell.balance_after, 149.80, 0.0001);
}

// ---- 4) daily_checkin ----------------------------------------------------
{
  const u = await seedUser(10);
  const r1 = await one(`SELECT daily_checkin($1) AS r`, [u]);
  eq('checkin: primer día streak=1', r1.r.streak, 1);
  near('checkin: acredita 0.05', (await one(`SELECT usdt_balance b FROM internal_wallets WHERE user_id=$1`, [u])).b, 10.05, 0.000001);

  const r2 = await one(`SELECT daily_checkin($1) AS r`, [u]);
  const rows = await one(`SELECT count(*)::int n FROM checkins WHERE user_id=$1`, [u]);
  eq('checkin: dos llamadas el mismo día = 1 fila', rows.n, 1);
  near('checkin: no paga dos veces', (await one(`SELECT usdt_balance b FROM internal_wallets WHERE user_id=$1`, [u])).b, 10.05, 0.000001);

  // streak que continúa desde ayer
  const u2 = await seedUser(0);
  await q(`INSERT INTO checkins (user_id, checkin_date, streak, week_key)
           VALUES ($1, ((now() AT TIME ZONE 'UTC')::date - 1), 1, to_char(now() AT TIME ZONE 'UTC','IYYY-"W"IW'))`, [u2]);
  const r3 = await one(`SELECT daily_checkin($1) AS r`, [u2]);
  eq('checkin: streak continúa desde ayer', r3.r.streak, 2);

  // semana completa -> bono 0.50 una sola vez
  const u3 = await seedUser(0);
  await q(`INSERT INTO checkins (user_id, checkin_date, streak, week_key)
           SELECT $1, d, 1, to_char(now() AT TIME ZONE 'UTC','IYYY-"W"IW')
           FROM generate_series(
             date_trunc('week', (now() AT TIME ZONE 'UTC')::date)::date,
             date_trunc('week', (now() AT TIME ZONE 'UTC')::date)::date + 6,
             INTERVAL '1 day') d
           WHERE d::date <> (now() AT TIME ZONE 'UTC')::date`, [u3]);
  const days = await one(`SELECT count(*)::int n FROM checkins WHERE user_id=$1`, [u3]);
  eq('checkin: 6 días previos sembrados', days.n, 6);
  const r4 = await one(`SELECT daily_checkin($1) AS r`, [u3]);
  near('checkin: 7mo día paga el bono semanal 0.50 + 0.05',
    (await one(`SELECT usdt_balance b FROM internal_wallets WHERE user_id=$1`, [u3])).b, 0.55, 0.000001);
  const r5 = await one(`SELECT daily_checkin($1) AS r`, [u3]);
  near('checkin: el bono semanal no se repite',
    (await one(`SELECT usdt_balance b FROM internal_wallets WHERE user_id=$1`, [u3])).b, 0.55, 0.000001);

  // el week_key generado por SQL tiene que coincidir con el de lib.js
  const wk = await one(`SELECT to_char(now() AT TIME ZONE 'UTC','IYYY-"W"IW') AS k`);
  const { summarizeCheckins } = await import(LIBJS);
  // Supabase REST devuelve checkin_date como texto 'YYYY-MM-DD'; node-postgres lo
  // daría como objeto Date, que es otra cosa. Se castea para probar el caso real.
  const ciRows = (await q(`SELECT to_char(checkin_date,'YYYY-MM-DD') AS checkin_date, week_key, weekly_bonus_paid FROM checkins WHERE user_id=$1 ORDER BY checkin_date`, [u3])).rows;
  const sum = summarizeCheckins(ciRows, new Date());
  eq('checkin: week_key SQL == formato de lib.js', ciRows[0].week_key, wk.k);
  eq('checkin: lib.js cuenta 7 días esta semana', sum.days_this_week, 7);
  eq('checkin: lib.js dice weekly_complete', sum.weekly_complete, true);
  eq('checkin: lib.js dice ya hecho hoy', sum.checked_in_today, true);
  const cl = {};
  for (const r of (await q(`SELECT operation, count(*)::int n FROM wallet_ledger WHERE user_id=$1 GROUP BY operation`, [u3])).rows) {
    cl[r.operation] = r.n;
  }
  eq('ledger: checkin_daily registrado', cl.checkin_daily, 1);
  eq('ledger: checkin_weekly registrado una sola vez', cl.checkin_weekly, 1);
}

// ---- 5) constraints de integridad ---------------------------------------
{
  const u = await seedUser(100);
  let neg = null;
  try { await q(`UPDATE internal_wallets SET usdt_balance = -1 WHERE user_id=$1`, [u]); }
  catch (e) { neg = e.message; }
  check('wallet: el CHECK impide saldo negativo', !!neg, neg ? 'positive_balances' : 'permitió -1');

  let dupClaim = null;
  const cyc = await one(`INSERT INTO hold_cycles (user_id, ends_at) VALUES ($1, NOW() + INTERVAL '6 hours') RETURNING id`, [u]);
  await q(`INSERT INTO claims (claim_id,user_id,cycle_id,total_prize,ton_fee,expires_at) VALUES ('A',$1,$2,0.1,0.05,NOW()+INTERVAL '15 min')`, [u, cyc.id]);
  try {
    await q(`INSERT INTO claims (claim_id,user_id,cycle_id,total_prize,ton_fee,expires_at) VALUES ('B',$1,$2,0.1,0.05,NOW()+INTERVAL '15 min')`, [u, cyc.id]);
  } catch (e) { dupClaim = e.message; }
  check('claims: un solo claim activo por ciclo', !!dupClaim, dupClaim ? 'one_active_claim_per_cycle' : 'permitió 2');

}


// ---- 5b) sell_wallet_asset: vender el saldo TRX/TON de la wallet ---------
// Sin esto el bonus de referidos en TRX quedaba trabado: se veía en la wallet
// pero el único SELL del panel cerraba posiciones del book simulado.
{
  const u = await seedUser(100);
  await q(`UPDATE internal_wallets SET trx_balance = 6 WHERE user_id=$1`, [u]);

  // 6 TRX a 0.30 = 1.80 de proceeds, fee 0.1% = 0.0018 -> 1.7982
  const r = await one(`SELECT sell_wallet_asset($1,'TRX',6,0.30) AS r`, [u]);
  eq('sell_wallet_asset: ok', r.r.ok, true);
  near('sell_wallet_asset: fee 0.1% de un solo lado', r.r.fee, 0.0018, 0.0001);
  near('sell_wallet_asset: credit 1.80 - 0.0018', r.r.credit, 1.7982, 0.0001);

  const w = await one(`SELECT usdt_balance, trx_balance FROM internal_wallets WHERE user_id=$1`, [u]);
  near('sell_wallet_asset: 100 + 1.7982 de USDT', w.usdt_balance, 101.7982, 0.0001);
  near('sell_wallet_asset: el TRX salió de la wallet', w.trx_balance, 0, 0.0001);

  const led = await one(
    `SELECT count(*)::int n FROM wallet_ledger WHERE user_id=$1 AND reference_type='wallet_sale'`, [u]);
  eq('sell_wallet_asset: escribe 2 renglones en el ledger (sale TRX, entra USDT)', led.n, 2);

  // venta parcial
  await q(`UPDATE internal_wallets SET trx_balance = 10 WHERE user_id=$1`, [u]);
  const part = await one(`SELECT sell_wallet_asset($1,'TRX',4,0.50) AS r`, [u]);
  near('sell_wallet_asset: venta parcial acredita 2.00 - 0.002', part.r.credit, 1.998, 0.0001);
  const w2 = await one(`SELECT trx_balance FROM internal_wallets WHERE user_id=$1`, [u]);
  near('sell_wallet_asset: quedan 6 TRX', w2.trx_balance, 6, 0.0001);

  // rechazos
  const over = await one(`SELECT sell_wallet_asset($1,'TRX',999,0.30) AS r`, [u]);
  eq('sell_wallet_asset: rechaza vender más de lo que hay', over.r.error, 'Insufficient TRX balance');
  const badAsset = await one(`SELECT sell_wallet_asset($1,'USDT',1,0.30) AS r`, [u]);
  eq('sell_wallet_asset: USDT no se vende contra sí mismo',
     badAsset.r.error, 'Only TRX or TON can be sold from the wallet');
  eq('sell_wallet_asset: rechaza monto 0', (await one(`SELECT sell_wallet_asset($1,'TRX',0,0.30) AS r`, [u])).r.ok, false);
  eq('sell_wallet_asset: rechaza precio 0', (await one(`SELECT sell_wallet_asset($1,'TRX',1,0) AS r`, [u])).r.ok, false);
  eq('sell_wallet_asset: usuario sin wallet',
     (await one(`SELECT sell_wallet_asset('tg_inexistente','TRX',1,0.30) AS r`)).r.error, 'Wallet not found');

  // el CHECK de saldo no negativo sigue cubriendo la columna
  let negativeBlocked = false;
  try { await q(`UPDATE internal_wallets SET trx_balance = -1 WHERE user_id=$1`, [u]); }
  catch (e) { negativeBlocked = true; }
  check('sell_wallet_asset: la wallet sigue sin admitir saldo negativo', negativeBlocked);
}

// ---- 6) REFERIDOS: registro en pending y pago en el primer claim ----------
// Antes no existía nada de esto: ninguna consulta insertaba en referrals, así
// que la tabla estaba siempre vacía y el panel no actualizaba nunca.
{
  const referrer = await seedUser(0);
  const referred = await seedUser(0);
  const refUid = (await one(`SELECT uid FROM users WHERE telegram_id = $1`, [referrer])).uid;

  // uid inexistente / vacío
  eq('register_referral: uid desconocido', (await one(
    `SELECT register_referral($1,$2,NULL) AS r`, ['no_existe', referred])).r.error, 'referrer_not_found');
  eq('register_referral: uid vacío', (await one(
    `SELECT register_referral($1,$2,NULL) AS r`, ['   ', referred])).r.error, 'missing_referrer_uid');

  // auto-referido
  eq('register_referral: rechaza auto-referido', (await one(
    `SELECT register_referral($1,$2,NULL) AS r`, [refUid, referrer])).r.error, 'self_referral');

  // referido inexistente
  eq('register_referral: referido inexistente', (await one(
    `SELECT register_referral($1,$2,NULL) AS r`, [refUid, 'tg_nadie'])).r.error, 'referred_user_not_found');

  // registro correcto
  const reg = (await one(`SELECT register_referral($1,$2,$3) AS r`, [refUid, referred, 'ana'])).r;
  eq('register_referral: registra', reg.registered, true);
  eq('register_referral: apunta al referente correcto', reg.referrer_id, referrer);

  const row = await one(`SELECT * FROM referrals WHERE referred_id = $1`, [referred]);
  eq('referrals: status inicial pending', row.status, 'pending');
  eq('referrals: recompensa 2', parseFloat(row.reward_amount), 2);
  eq('referrals: activo TRX', row.reward_asset, 'TRX');

  // idempotente por el UNIQUE(referrer_id, referred_id)
  const again = (await one(`SELECT register_referral($1,$2,NULL) AS r`, [refUid, referred])).r;
  eq('register_referral: segunda llamada no duplica', again.registered, false);
  eq('referrals: sigue habiendo una sola fila',
    (await one(`SELECT COUNT(*)::int AS n FROM referrals WHERE referred_id = $1`, [referred])).n, 1);

  // todavía no se pagó nada
  eq('referrer: sin TRX antes del claim',
    parseFloat((await one(`SELECT trx_balance FROM internal_wallets WHERE user_id = $1`, [referrer])).trx_balance), 0);

  // El pago lo dispara credit_claim, no una llamada manual.
  const cyc = await one(
    `INSERT INTO hold_cycles (user_id, ends_at, holds_completed, status)
     VALUES ($1, NOW() + INTERVAL '6 hours', 3, 'active') RETURNING id`, [referred]);
  await q(
    `INSERT INTO claims (claim_id, user_id, cycle_id, total_prize, ton_fee, status, expires_at)
     VALUES ('CLM_REF_1', $1, $2, 0.18, 0.05, 'pending', NOW() + INTERVAL '10 minutes')`,
    [referred, cyc.id]);

  const credited = (await one(
    `SELECT credit_claim('CLM_REF_1','TXHASH_REF',0.05,'0:aa') AS r`)).r;
  eq('credit_claim: acredita el claim', credited.ok, true);

  eq('referrer: 2 TRX tras el primer claim del referido',
    parseFloat((await one(`SELECT trx_balance FROM internal_wallets WHERE user_id = $1`, [referrer])).trx_balance), 2);
  eq('referrals: pasa a confirmed',
    (await one(`SELECT status FROM referrals WHERE referred_id = $1`, [referred])).status, 'confirmed');

  const led = await one(
    `SELECT * FROM wallet_ledger WHERE user_id = $1 AND operation = 'referral_bonus'`, [referrer]);
  eq('ledger: fila referral_bonus', led.asset, 'TRX');
  eq('ledger: monto 2', parseFloat(led.amount), 2);
  eq('ledger: balance después', parseFloat(led.balance_after), 2);
  eq('ledger: referencia al referido', led.reference_id, referred);

  eq('pool: distributed subió 2',
    parseFloat((await one(`SELECT distributed FROM referral_pool ORDER BY id LIMIT 1`)).distributed), 2);

  // no se paga dos veces
  const second = (await one(`SELECT confirm_pending_referral($1) AS r`, [referred])).r;
  eq('confirm_pending_referral: sin pendiente no paga', second.confirmed, false);
  eq('referrer: sigue en 2 TRX',
    parseFloat((await one(`SELECT trx_balance FROM internal_wallets WHERE user_id = $1`, [referrer])).trx_balance), 2);

  // un segundo claim del mismo usuario no vuelve a pagar
  const cyc2 = await one(
    `INSERT INTO hold_cycles (user_id, ends_at, holds_completed, status)
     VALUES ($1, NOW() + INTERVAL '6 hours', 3, 'active') RETURNING id`, [referred]);
  await q(
    `INSERT INTO claims (claim_id, user_id, cycle_id, total_prize, ton_fee, status, expires_at)
     VALUES ('CLM_REF_2', $1, $2, 0.18, 0.05, 'pending', NOW() + INTERVAL '10 minutes')`,
    [referred, cyc2.id]);
  await one(`SELECT credit_claim('CLM_REF_2','TXHASH_REF_2',0.05,'0:aa') AS r`);
  eq('referrer: un segundo claim no paga de nuevo',
    parseFloat((await one(`SELECT trx_balance FROM internal_wallets WHERE user_id = $1`, [referrer])).trx_balance), 2);

  // sin pendiente: no hace nada y no rompe
  const loner = await seedUser(0);
  eq('confirm_pending_referral: usuario sin referente',
    (await one(`SELECT confirm_pending_referral($1) AS r`, [loner])).r.confirmed, false);

  // pool agotado: queda pending para reintentar, no se marca confirmada sin pagar
  const r2 = await seedUser(0);
  const d2 = await seedUser(0);
  const uid2 = (await one(`SELECT uid FROM users WHERE telegram_id = $1`, [r2])).uid;
  await one(`SELECT register_referral($1,$2,NULL) AS r`, [uid2, d2]);
  await q(`UPDATE referral_pool SET distributed = total_pool`);
  const exhausted = (await one(`SELECT confirm_pending_referral($1) AS r`, [d2])).r;
  eq('pool agotado: no confirma', exhausted.confirmed, false);
  eq('pool agotado: lo dice', exhausted.pool_exhausted, true);
  eq('pool agotado: la fila sigue pending',
    (await one(`SELECT status FROM referrals WHERE referred_id = $1`, [d2])).status, 'pending');
  eq('pool agotado: el referente no cobra',
    parseFloat((await one(`SELECT trx_balance FROM internal_wallets WHERE user_id = $1`, [r2])).trx_balance), 0);

  // y cuando hay lugar de nuevo, se paga
  await q(`UPDATE referral_pool SET distributed = 0`);
  const recovered = (await one(`SELECT confirm_pending_referral($1) AS r`, [d2])).r;
  eq('pool con lugar: confirma el pendiente', recovered.confirmed, true);
  eq('pool con lugar: el referente cobra',
    parseFloat((await one(`SELECT trx_balance FROM internal_wallets WHERE user_id = $1`, [r2])).trx_balance), 2);

  await q(`UPDATE referral_pool SET distributed = 0`);
}

// ---- 7) RLS: anon no ve nada, service_role sí ----------------------------
{
  // Las 12 tablas tienen que tener RLS habilitado
  const rlsOff = (await q(`
    SELECT relname FROM pg_class
    WHERE relname IN ('users','hold_cycles','holds','claims','claim_payments',
                      'internal_wallets','wallet_ledger','referral_pool','referrals',
                      'transactions','trade_positions','checkins')
      AND relrowsecurity = false`)).rows;
  eq('RLS: habilitado en las 12 tablas', rlsOff.length, 0);

  // Ninguna función sensible puede ser ejecutada por PUBLIC
  const perms = (await q(`
    SELECT p.proname, p.prosecdef,
           has_function_privilege('public', p.oid, 'EXECUTE') AS pub
    FROM pg_proc p
    WHERE p.proname IN ('credit_claim','open_trade','close_trade',
                        'set_trade_levels','daily_checkin','expire_claims_and_cycles',
                        'register_referral','confirm_pending_referral')`)).rows;
  eq('RPC: las 8 funciones sensibles existen', perms.length, 8);
  eq('RPC: ninguna queda ejecutable por PUBLIC', perms.filter((r) => r.pub).length, 0);
  eq('RPC: ninguna es SECURITY DEFINER', perms.filter((r) => r.prosecdef).length, 0);

  const u = await seedUser(500);
  for (const r of ['anon_probe', 'service_probe']) {
    await q(`REASSIGN OWNED BY ${r} TO postgres`).catch(() => {});
    await q(`DROP OWNED BY ${r}`).catch(() => {});
    await q(`DROP ROLE IF EXISTS ${r}`).catch(() => {});
  }
  await q(`CREATE ROLE anon_probe LOGIN NOBYPASSRLS PASSWORD 'probe'`);
  await q(`CREATE ROLE service_probe LOGIN BYPASSRLS PASSWORD 'probe'`);
  await q(`GRANT USAGE ON SCHEMA public TO anon_probe, service_probe`);
  await q(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO anon_probe, service_probe`);
  // A anon_probe NO se le da EXECUTE a propósito: el schema se lo revoca a
  // PUBLIC/anon, y eso es lo que se verifica más abajo.
  await q(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO service_probe`);
  await q(`GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO anon_probe, service_probe`);

  const base = `postgresql://`;  // usuario:clave abajo
  const asAnon = new pg.Client(`${base}anon_probe:probe@127.0.0.1:${PORT}/postgres`);
  const asSvc = new pg.Client(`${base}service_probe:probe@127.0.0.1:${PORT}/postgres`);
  await asAnon.connect();
  await asSvc.connect();

  const anonWallets = await asAnon.query(`SELECT count(*)::int n FROM internal_wallets`);
  eq('RLS: anon no ve ninguna wallet', anonWallets.rows[0].n, 0);
  const anonUsers = await asAnon.query(`SELECT count(*)::int n FROM users`);
  eq('RLS: anon no ve ningún usuario', anonUsers.rows[0].n, 0);
  const anonClaims = await asAnon.query(`SELECT count(*)::int n FROM claims`);
  eq('RLS: anon no ve ningún claim', anonClaims.rows[0].n, 0);

  // anon intenta regalarse saldo: RLS filtra la fila, no toca nada
  const steal = await asAnon.query(`UPDATE internal_wallets SET usdt_balance = 999999 WHERE user_id = $1`, [u]);
  eq('RLS: el UPDATE de anon no afecta filas', steal.rowCount, 0);
  near('RLS: el saldo real queda intacto',
    (await one(`SELECT usdt_balance b FROM internal_wallets WHERE user_id=$1`, [u])).b, 500, 0.000001);

  // anon intenta auto-acreditarse un check-in
  let anonCheckin = null;
  try { anonCheckin = await asAnon.query(`SELECT daily_checkin($1) AS r`, [u]); }
  catch (e) { anonCheckin = { error: e.message }; }
  check('RLS: anon no puede ejecutar daily_checkin', /permission denied/i.test(anonCheckin?.error || ''),
    anonCheckin?.error ? anonCheckin.error.slice(0, 55) : 'se ejecutó');
  near('RLS: el check-in de anon no acredita nada',
    (await one(`SELECT usdt_balance b FROM internal_wallets WHERE user_id=$1`, [u])).b, 500, 0.000001);

  // anon no puede ni leer al usuario por RPC
  let anonLedger = null;
  try { anonLedger = (await asAnon.query(`SELECT count(*)::int n FROM wallet_ledger`)).rows[0].n; }
  catch (e) { anonLedger = 'error'; }
  eq('RLS: anon no ve el ledger', anonLedger, 0);

  // service_probe (BYPASSRLS, como el service_role de Supabase) sí ve todo
  const svcWallets = await asSvc.query(`SELECT count(*)::int n FROM internal_wallets`);
  check('RLS: un rol con BYPASSRLS sí ve las wallets', svcWallets.rows[0].n > 0, `${svcWallets.rows[0].n} filas`);

  await asAnon.end();
  await asSvc.end();
  // DROP ROLE falla si el rol conserva privilegios: se revocan primero.
  await q(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon_probe, service_probe`);
  await q(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon_probe, service_probe`);
  await q(`REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM anon_probe, service_probe`);
  await q(`REVOKE USAGE ON SCHEMA public FROM anon_probe, service_probe`);
  await q(`DROP ROLE anon_probe`);
  await q(`DROP ROLE service_probe`);
}

console.log(`\n${results.length - failures}/${results.length} verificaciones OK`);
await client.end();
await db.stop();
process.exit(failures ? 1 : 0);
