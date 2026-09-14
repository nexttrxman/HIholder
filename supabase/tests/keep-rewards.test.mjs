// $KEEP (v3.2): recompensas en KEEP del check-in, las misiones sociales y el
// claim, compra de KEEP con precio manejado y la regla "KEEP no se vende".
// Corre contra schema.sql completo (como social-missions.test.mjs).
//
//   cd supabase/tests && npm install && npm run test:keep
import EmbeddedPostgres from 'embedded-postgres';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA = path.resolve(HERE, '..', 'schema.sql');
const DATADIR = path.join(HERE, 'pgdata-keep');
const PORT = Number(process.env.PGKEEP_PORT || 55468);

let failures = 0;
const check = (name, ok, detail) => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  → ${detail}` : ''}`);
};
const eq = (name, a, b) => check(name, String(a) === String(b), `got ${a}, want ${b}`);
const near = (name, a, b, tol = 0.0001) =>
  check(name, Math.abs(Number(a) - Number(b)) <= tol, `got ${a}, want ~${b}`);

const db = new EmbeddedPostgres({ databaseDir: DATADIR, user: 'postgres', password: 'postgres', port: PORT, persistent: false });
await db.initialise();
await db.start();
const client = new pg.Client(`postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`);
await client.connect();
const q = (sql, p) => client.query(sql, p);
const one = async (sql, p) => (await q(sql, p)).rows[0];

for (const r of ['anon', 'authenticated', 'service_role']) {
  await q(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}')
           THEN CREATE ROLE ${r} NOLOGIN; END IF; END $$;`);
}
await q('CREATE EXTENSION IF NOT EXISTS "uuid-ossp";');
let sql = fs.readFileSync(SCHEMA, 'utf8');
sql = sql.replace('CREATE EXTENSION IF NOT EXISTS "pg_cron";', '-- pg_cron: solo en Supabase');
await q(sql);

let seq = 0;
async function seedUser(usdt = 0) {
  const id = `keep_${++seq}_${Date.now() % 100000}`;
  await q(`INSERT INTO users (telegram_id, uid) VALUES ($1, $2)`, [id, `uid_${id}`]);
  await q(`INSERT INTO internal_wallets (user_id, usdt_balance) VALUES ($1, $2)`, [id, usdt]);
  return id;
}
const wallet = async (u) => one(`SELECT usdt_balance, keep_balance FROM internal_wallets WHERE user_id=$1`, [u]);

// ---- 0) Semilla del precio manejado ----------------------------------------
{
  const row = await one(`SELECT price, floor_price, cap_price, walk_step, walk_seconds
                          FROM managed_prices WHERE pair='KEEPUSDT'`);
  check('KEEPUSDT sembrado', !!row);
  near('precio inicial 0.00036', row.price, 0.00036, 1e-9);
  near('banda inferior 0.00012', row.floor_price, 0.00012, 1e-9);
  near('banda superior 0.0006', row.cap_price, 0.0006, 1e-9);
}

// ---- 1) Check-in diario paga KEEP (v3.3: 0.15 USDT + 500 KEEP fijos) ------
{
  const u = await seedUser(10);
  const r1 = (await one(`SELECT daily_checkin($1) AS r`, [u])).r;
  eq('checkin ok', r1.ok, true);
  const k = Number(r1.keep_reward);
  eq('checkin: KEEP fijo 500 (v3.3)', k, 500);
  eq('checkin: saldo KEEP = keep_reward', Number((await wallet(u)).keep_balance), k);
  const ledger = (await q(`SELECT asset, amount FROM wallet_ledger
                            WHERE user_id=$1 AND operation='checkin_daily'`, [u])).rows;
  eq('checkin: dos renglones (USDT + KEEP)', ledger.length, 2);
  check('checkin: renglon KEEP por el monto', ledger.some((l) => l.asset === 'KEEP' && Number(l.amount) === k));
  check('checkin: USDT fijo 0.15 (v3.3)', ledger.some((l) => l.asset === 'USDT' && Number(l.amount) === 0.15));
  near('checkin: USDT acreditado', (await wallet(u)).usdt_balance, 10.15);

  const r2 = (await one(`SELECT daily_checkin($1) AS r`, [u])).r;
  eq('checkin: segundo intento = already_checked_in', r2.error, 'already_checked_in');
  eq('checkin: ya hecho no paga KEEP', Number(r2.keep_reward), 0);
  eq('checkin: saldo KEEP no cambia', Number((await wallet(u)).keep_balance), k);

  // v3.3: la semana completa NO paga directo; abre un claim semanal que al
  // cobrarse (credit_claim) acredita 1.5 USDT + 2000 KEEP FIJOS.
  const u3 = await seedUser(0);
  await q(`INSERT INTO checkins (user_id, checkin_date, streak, week_key)
           SELECT $1, d, 1, to_char(now() AT TIME ZONE 'UTC','IYYY-"W"IW')
           FROM generate_series(
             date_trunc('week', (now() AT TIME ZONE 'UTC')::date)::date,
             date_trunc('week', (now() AT TIME ZONE 'UTC')::date)::date + 6,
             INTERVAL '1 day') d
           WHERE d::date <> (now() AT TIME ZONE 'UTC')::date`, [u3]);
  const r3 = (await one(`SELECT daily_checkin($1) AS r`, [u3])).r;
  const kd = Number(r3.keep_reward);
  eq('semanal: KEEP diario sigue siendo 500', kd, 500);
  eq('semanal: ya no hay keep_weekly directo', Number(r3.keep_weekly), 0);
  const claimId = r3.weekly_claim_id;
  check('semanal: se abrio el claim semanal', Boolean(claimId), String(claimId));
  eq('semanal: saldo KEEP = solo el diario', Number((await wallet(u3)).keep_balance), kd);
  const wk0 = (await q(`SELECT count(*)::int n FROM wallet_ledger
                        WHERE user_id=$1 AND operation='checkin_weekly'`, [u3])).rows[0];
  eq('semanal: no hay renglones checkin_weekly', wk0.n, 0);

  // Cobro del claim semanal: 1.5 USDT + 2000 KEEP fijos.
  const rc = (await one(`SELECT credit_claim($1, 'TX_KRW', 0.15, '0:aa') AS r`, [claimId])).r;
  eq('semanal: credit_claim ok', rc.ok, true);
  eq('semanal: KEEP del claim FIJO 2000', Number(rc.keep_credited), 2000);
  eq('semanal: saldo KEEP = 500 + 2000', Number((await wallet(u3)).keep_balance), kd + 2000);
  const wk = (await q(`SELECT asset, amount FROM wallet_ledger
                        WHERE user_id=$1 AND operation='claim_credit'`, [u3])).rows;
  eq('semanal: dos renglones claim_credit (USDT + KEEP)', wk.length, 2);
  check('semanal: renglon USDT por 1.5', wk.some((l) => l.asset === 'USDT' && Number(l.amount) === 1.5));
  check('semanal: renglon KEEP por 2000', wk.some((l) => l.asset === 'KEEP' && Number(l.amount) === 2000));
}

// ---- 2) Mision social paga KEEP --------------------------------------------
{
  const u = await seedUser(5);
  const r = (await one(`SELECT complete_social_mission($1,$2) AS r`, [u, 'tg_channel'])).r;
  eq('mision ok', r.ok, true);
  const k = Number(r.keep_reward);
  check('mision: KEEP entre 500 y 1200', Number.isInteger(k) && k >= 500 && k <= 1200, String(k));
  eq('mision: saldo KEEP', Number((await wallet(u)).keep_balance), k);
  eq('mision: queda registrado en user_social_missions',
    Number((await one(`SELECT reward_keep k FROM user_social_missions WHERE user_id=$1`, [u])).k), k);
  const ledger = (await q(`SELECT asset, amount FROM wallet_ledger
                            WHERE user_id=$1 AND operation='mission_reward'`, [u])).rows;
  eq('mision: dos renglones (USDT + KEEP)', ledger.length, 2);
  check('mision: renglon KEEP por el monto', ledger.some((l) => l.asset === 'KEEP' && Number(l.amount) === k));

  const again = (await one(`SELECT complete_social_mission($1,'tg_channel') AS r`, [u])).r;
  eq('mision: segundo cobro = already', again.error, 'already');
  eq('mision: no paga KEEP de nuevo', Number((await wallet(u)).keep_balance), k);
}

// ---- 3) Claim pagado acredita el bonus KEEP --------------------------------
{
  const u = await seedUser(0);
  const cyc = await one(
    `INSERT INTO hold_cycles (user_id, ends_at, holds_completed, status)
     VALUES ($1, NOW() + INTERVAL '6 hours', 3, 'active') RETURNING id`, [u]);
  await q(
    `INSERT INTO claims (claim_id, user_id, cycle_id, total_prize, ton_fee, status, expires_at)
     VALUES ('CLM_KEEP_1', $1, $2, 0.72, 0.15, 'pending', NOW() + INTERVAL '10 minutes')`,
    [u, cyc.id]);

  const r = (await one(
    `SELECT credit_claim('CLM_KEEP_1','TXHASH_KEEP','0.15','UQfrom',8) AS r`)).r;
  eq('claim ok', r.ok, true);
  near('claim: USDT acreditado', r.credited, 0.72);
  const k = Number(r.keep_credited);
  check('claim: KEEP entre 500 y 2500', Number.isInteger(k) && k >= 500 && k <= 2500, String(k));
  eq('claim: saldo KEEP', Number((await wallet(u)).keep_balance), k);
  const ledger = (await q(`SELECT asset, amount FROM wallet_ledger
                            WHERE user_id=$1 AND operation='claim_credit'`, [u])).rows;
  eq('claim: dos renglones (USDT + KEEP)', ledger.length, 2);
  check('claim: renglon KEEP por el monto', ledger.some((l) => l.asset === 'KEEP' && Number(l.amount) === k));

  const twice = (await one(`SELECT credit_claim('CLM_KEEP_1','TXHASH_KEEP2','0.15','UQfrom',8) AS r`)).r;
  eq('claim: no se acredita dos veces', twice.ok, false);
  eq('claim: saldo KEEP no cambia', Number((await wallet(u)).keep_balance), k);
}

// ---- 4) buy_keep ------------------------------------------------------------
{
  const u = await seedUser(50);
  const r = (await one(`SELECT buy_keep($1, 10, 0.0004) AS r`, [u])).r;
  eq('buy_keep ok', r.ok, true);
  near('buy_keep: qty = 10/0.0004 = 25000', r.qty, 25000, 0.001);
  near('buy_keep: fee 0.1% = 0.01', r.fee, 0.01, 1e-9);
  near('buy_keep: USDT 50 - 10.01', r.usdt_balance, 39.99, 0.0001);
  near('buy_keep: saldo KEEP 25000', r.keep_balance, 25000, 0.001);
  const ledger = (await q(`SELECT asset, amount FROM wallet_ledger
                            WHERE user_id=$1 AND operation='trade_buy' ORDER BY created_at, id`, [u])).rows;
  eq('buy_keep: dos renglones (USDT sale, KEEP entra)', ledger.length, 2);
  near('buy_keep: renglon USDT = 10.01', ledger[0].amount, 10.01, 1e-9);
  near('buy_keep: renglon KEEP = 25000', ledger[1].amount, 25000, 0.001);

  const poor = (await one(`SELECT buy_keep($1, 1000, 0.0004) AS r`, [u])).r;
  eq('buy_keep: sin saldo = error', poor.ok, false);
  eq('buy_keep: mensaje de saldo', poor.error, 'Insufficient USDT balance');
}

// ---- 5) KEEP no se vende -----------------------------------------------------
{
  const u = await seedUser(100);
  await q(`UPDATE internal_wallets SET keep_balance = 5000 WHERE user_id=$1`, [u]);
  const sell = (await one(`SELECT sell_wallet_asset($1,'KEEP',100,0.0004) AS r`, [u])).r;
  eq('sell_wallet_asset rechaza KEEP', sell.ok, false);
  eq('sell_wallet_asset: solo TRX/TON', sell.error, 'Only TRX or TON can be sold from the wallet');
  eq('el saldo KEEP queda intacto', Number((await wallet(u)).keep_balance), 5000);

  // Defensa en profundidad: si existiera una posicion KEEPUSDT, no se liquida.
  const pos = await one(
    `INSERT INTO trade_positions (user_id, pair, side, qty, entry_price, cost_basis, fee_paid, status)
     VALUES ($1,'KEEPUSDT','buy',1000,0.0004,0.4,0.0004,'open') RETURNING id`, [u]);
  const close = (await one(`SELECT close_trade($1,$2,0.0005) AS r`, [u, pos.id])).r;
  eq('close_trade rechaza KEEPUSDT', close.ok, false);
  eq('close_trade: mensaje', close.error, 'KEEP cannot be sold');
  eq('la posicion sigue abierta',
    (await one(`SELECT status s FROM trade_positions WHERE id=$1`, [pos.id])).s, 'open');

  // Y una posicion normal se sigue pudiendo cerrar (no se rompio nada).
  const pos2 = await one(
    `INSERT INTO trade_positions (user_id, pair, side, qty, entry_price, cost_basis, fee_paid, status)
     VALUES ($1,'BTCUSDT','buy',0.001,50000,50,0.05,'open') RETURNING id`, [u]);
  const close2 = (await one(`SELECT close_trade($1,$2,51000) AS r`, [u, pos2.id])).r;
  eq('close_trade de otro par sigue funcionando', close2.ok, true);
}

// ---- 6) Precio manejado -------------------------------------------------------
{
  const t1 = (await one(`SELECT managed_price_tick('KEEPUSDT') AS r`)).r;
  eq('tick ok', t1.ok, true);
  const p1 = Number(t1.price);
  check('tick: dentro de la banda', p1 >= 0.00012 && p1 <= 0.0006, String(p1));

  const t2 = (await one(`SELECT managed_price_tick('KEEPUSDT') AS r`)).r;
  eq('tick: throttle, segunda llamada = mismo precio', Number(t2.price), p1);

  // Precio fijado a mano (floor = cap): el walk no lo mueve.
  await q(`UPDATE managed_prices SET price=0.0003, floor_price=0.0003, cap_price=0.0003,
           updated_at = NOW() - INTERVAL '10 minutes' WHERE pair='KEEPUSDT'`);
  const t3 = (await one(`SELECT managed_price_tick('KEEPUSDT') AS r`)).r;
  near('tick: con banda fija el precio no se mueve', t3.price, 0.0003, 1e-12);
  // El walk respeta la banda aunque la ultima actualizacion sea vieja.
  await q(`UPDATE managed_prices SET price=0.00036, floor_price=0.00012, cap_price=0.0006,
           updated_at = NOW() - INTERVAL '10 minutes' WHERE pair='KEEPUSDT'`);
  for (let i = 0; i < 30; i++) {
    await q(`UPDATE managed_prices SET updated_at = NOW() - INTERVAL '10 minutes' WHERE pair='KEEPUSDT'`);
    const t = (await one(`SELECT managed_price_tick('KEEPUSDT') AS r`)).r;
    const p = Number(t.price);
    if (!(p >= 0.00012 && p <= 0.0006)) {
      check(`walk #${i} dentro de la banda`, false, String(p));
      break;
    }
    if (i === 29) check('walk: 30 ticks seguidos dentro de la banda', true);
  }

  const bad = (await one(`SELECT managed_price_tick('NOPE') AS r`)).r;
  eq('tick: par desconocido = error', bad.ok, false);
}

// ---- 7) Velas del precio manejado --------------------------------------------
{
  const r = (await one(`SELECT managed_price_candles('KEEPUSDT', 60, 30) AS r`)).r;
  eq('candles ok', r.ok, true);
  eq('candles: modo managed', r.mode, 'managed');
  check('candles: trae velas', Array.isArray(r.candles) && r.candles.length > 0, `n=${r.candles?.length}`);
  const c0 = r.candles[0];
  check('candles: ohlcv completo', ['t','o','h','l','c','v'].every((k) => c0[k] !== undefined), JSON.stringify(c0));
  check('candles: high >= low', Number(c0.h) >= Number(c0.l));
  check('candles: precio vigente positivo', Number(r.price) > 0, String(r.price));
  const bad = (await one(`SELECT managed_price_candles('KEEPUSDT', 0, 30) AS r`)).r;
  eq('candles: bucket invalido = error', bad.ok, false);
}

// ---- 8) Permisos: solo service_role ------------------------------------------
{
  for (const fn of ['buy_keep(text, numeric, numeric)', 'managed_price_tick(text)',
                    'managed_price_candles(text, integer, integer)']) {
    for (const role of ['anon', 'authenticated']) {
      const priv = (await one(
        `SELECT has_function_privilege($1, $2::regprocedure, 'EXECUTE') p`, [role, fn])).p;
      eq(`${fn}: sin EXECUTE para ${role}`, priv, false);
    }
    const priv = (await one(
      `SELECT has_function_privilege('service_role', $1::regprocedure, 'EXECUTE') p`, [fn])).p;
    eq(`${fn}: EXECUTE para service_role`, priv, true);
  }
}

await client.end();
await db.stop();
console.log(`\n${failures === 0 ? 'TODO OK' : failures + ' FALLOS'}`);
process.exit(failures ? 1 : 0);
