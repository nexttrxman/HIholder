// Retiros (v3.0): cola manual, sin clave privada en el Worker.
//
// Lo que estos tests cuidan de verdad es que el saldo se descuente exactamente
// una vez y que un rechazo devuelva exactamente lo que se cobró. Un error de
// signo o un reintegro doble acá es plata.
//
//   cd supabase/tests && npm install && node withdrawal.test.mjs
import EmbeddedPostgres from 'embedded-postgres';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA = path.resolve(HERE, '..', 'schema.sql');
const DATADIR = path.join(HERE, 'pgdata-withdraw');
const PORT = Number(process.env.PGWD_PORT || 55444);

const results = [];
let failures = 0;
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  → ${detail}` : ''}`);
};
const eq = (name, a, b) => check(name, String(a) === String(b), `got ${a}, want ${b}`);
const close = (name, a, b, tol = 1e-6) =>
  check(name, Math.abs(Number(a) - Number(b)) <= tol, `got ${a}, want ~${b}`);

const db = new EmbeddedPostgres({
  databaseDir: DATADIR, user: 'postgres', password: 'postgres',
  port: PORT, persistent: false,
});
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

// Un usuario con saldo suficiente para los casos felices.
await q(`INSERT INTO users (telegram_id, uid) VALUES ('7001','TK_WD')`);
await q(`INSERT INTO internal_wallets (user_id, usdt_balance, trx_balance, ton_balance)
         VALUES ('7001', 100, 50, 0)`);

const wallet = async (uid = '7001') => one(
  `SELECT usdt_balance::numeric u, trx_balance::numeric t FROM internal_wallets WHERE user_id=$1`, [uid]);
const req = async (uid = '7001', status = null) => one(
  `SELECT id, asset, amount::numeric a, fee_trx::numeric f, status
   FROM withdrawal_requests WHERE user_id=$1 ${status ? `AND status=$2` : ''}
   ORDER BY created_at DESC LIMIT 1`, status ? [uid, status] : [uid]);
const call = (uid, asset, amount, addr) =>
  one(`SELECT request_withdrawal($1,$2,$3,$4) AS r`, [uid, asset, amount, addr]);

const ADDR = 'TQrZ8wBsFZ3Q1dK9Yz1xYz1xYz1xYz1xYz';

// Un usuario fresco por escenario: encadenar saldos entre pruebas hace que un
// error en la primera desplace todas las expectativas siguientes y el test
// "pase" por casualidad o falle por el motivo equivocado.
let seq = 0;
const freshUser = async (usdt, trx) => {
  const uid = `71${String(++seq).padStart(2, '0')}`;
  await q(`INSERT INTO users (telegram_id, uid) VALUES ($1, $2)`, [uid, `TK_${uid}`]);
  await q(`INSERT INTO internal_wallets (user_id, usdt_balance, trx_balance, ton_balance)
           VALUES ($1, $2, $3, 0)`, [uid, usdt, trx]);
  return uid;
};

// ---- 1) Retiro de USDT: descuenta el monto Y el fee en TRX -----------------
let r = await call('7001', 'USDT', 20, ADDR);
eq('USDT: ok', r.r.ok, true);
eq('USDT: queda pending', r.r.status, 'pending');
eq('USDT: fee 5.5', r.r.fee_trx, '5.5');

let w = await wallet();
close('USDT: 100 - 20 = 80', w.u, 80);
close('USDT: el fee sale de TRX (50 - 5.5 = 44.5)', w.t, 44.5);

let rows = (await q(`SELECT operation, asset, amount::numeric FROM wallet_ledger
                     WHERE user_id='7001' ORDER BY created_at`)).rows;
eq('USDT: 2 filas de ledger', rows.length, 2);
eq('USDT: fila withdrawal', rows[0].operation, 'withdrawal');
close('USDT: withdrawal -20 USDT', rows[0].amount, -20);
eq('USDT: fila fee_deduction', rows[1].operation, 'fee_deduction');
close('USDT: fee -5.5 TRX', rows[1].amount, -5.5);

// ---- 2) Validaciones --------------------------------------------------------
close('saldo USDT sin tocar', (await wallet()).u, 80);
r = await call('7001', 'USDT', 1000, ADDR);
eq('USDT: rechaza saldo insuficiente', r.r.ok, false);
r = await call('7001', 'USDT', 2, ADDR);
eq('USDT: rechaza por debajo del mínimo (5)', r.r.ok, false);
r = await call('7001', 'BTC', 1, ADDR);
eq('rechaza un asset que no existe', r.r.ok, false);
r = await call('7001', 'USDT', 10, 'Tcorto');
eq('rechaza una dirección inválida', r.r.ok, false);
r = await call('7001', 'USDT', -5, ADDR);
eq('rechaza monto negativo', r.r.ok, false);
close('nada de eso descontó USDT', (await wallet()).u, 80);

// ---- 3) Fee insuficiente ----------------------------------------------------
await q(`UPDATE internal_wallets SET trx_balance = 1 WHERE user_id='7001'`);
r = await call('7001', 'USDT', 10, ADDR);
eq('sin TRX para el fee: rechaza', r.r.ok, false);
close('y no descuenta el USDT', (await wallet()).u, 80);
await q(`UPDATE internal_wallets SET trx_balance = 50 WHERE user_id='7001'`);

// ---- 4) Retiro de TRX: monto y fee de la misma bolsa ------------------------
r = await call('7001', 'TRX', 10, ADDR);
eq('TRX: ok', r.r.ok, true);
w = await wallet();
close('TRX: 50 - 10 - 5.5 = 34.5', w.t, 34.5);
close('TRX: no toca el USDT', w.u, 80);

r = await call('7001', 'TRX', 40, ADDR);
eq('TRX: rechaza si no alcanza para monto + fee', r.r.ok, false);

// ---- 5) Tope de solicitudes pendientes --------------------------------------
// Ya hay 2 pending. max_pending_per_user = 3.
await call('7001', 'USDT', 5, ADDR);
eq('llega al tope (3 pending)',
  (await one(`SELECT count(*)::int n FROM withdrawal_requests
              WHERE user_id='7001' AND status='pending'`)).n, 3);
r = await call('7001', 'USDT', 5, ADDR);
eq('la 4ta solicitud se rechaza', r.r.ok, false);

// ---- 6) resolve_withdrawal: paid NO reintegra ------------------------------
{
  const uid = await freshUser(100, 50);
  const r0 = await call(uid, 'USDT', 20, ADDR);
  eq('paid: se creó el pedido', r0.r.ok, true);

  const res = await one(`SELECT resolve_withdrawal($1,'paid','TX123','ok') AS r`, [r0.r.request_id]);
  eq('paid: ok', res.r.ok, true);

  const w = await wallet(uid);
  close('paid: NO reintegra USDT (queda 80)', w.u, 80);
  close('paid: NO reintegra el fee (queda 44.5)', w.t, 44.5);
  eq('paid: tx_id guardado',
    (await one(`SELECT tx_id FROM withdrawal_requests WHERE id=$1`, [r0.r.request_id])).tx_id, 'TX123');
}

// ---- 7) rejected reintegra monto y fee --------------------------------------
{
  const uid = await freshUser(100, 50);
  const r0 = await call(uid, 'USDT', 20, ADDR);
  let w = await wallet(uid);
  close('rejected: estado previo USDT 80', w.u, 80);
  close('rejected: estado previo TRX 44.5', w.t, 44.5);

  const res = await one(`SELECT resolve_withdrawal($1,'rejected','motivo') AS r`, [r0.r.request_id]);
  eq('rejected: ok', res.r.ok, true);
  eq('rejected: refunded', res.r.refunded, true);

  w = await wallet(uid);
  close('rejected: reintegra los 20 USDT (vuelve a 100)', w.u, 100);
  close('rejected: reintegra los 5.5 TRX de fee (vuelve a 50)', w.t, 50);
}

// ---- 7b) rejected sobre un retiro de TRX reintegra monto + fee juntos -------
{
  const uid = await freshUser(0, 50);
  const r0 = await call(uid, 'TRX', 10, ADDR);
  close('TRX: descontó 15.5 (queda 34.5)', (await wallet(uid)).t, 34.5);

  await one(`SELECT resolve_withdrawal($1,'cancelled') AS r`, [r0.r.request_id]);
  close('cancelled TRX: vuelve a 50', (await wallet(uid)).t, 50);
}

// ---- 8) No se puede resolver dos veces --------------------------------------
{
  const uid = await freshUser(100, 50);
  const r0 = await call(uid, 'USDT', 10, ADDR);
  await one(`SELECT resolve_withdrawal($1,'rejected') AS r`, [r0.r.request_id]);
  const twice = await one(`SELECT resolve_withdrawal($1,'paid','TX999') AS r`, [r0.r.request_id]);
  eq('no se resuelve dos veces', twice.r.ok, false);
  close('y el segundo intento no reintegra de nuevo', (await wallet(uid)).u, 100);
}

// ---- 9) El ledger no miente: la suma cuadra con la wallet -------------------
{
  const uid = await freshUser(100, 50);
  await call(uid, 'USDT', 20, ADDR);
  await call(uid, 'TRX', 10, ADDR);

  const w = await wallet(uid);
  const ledU = Number((await one(`SELECT COALESCE(sum(amount),0)::numeric s FROM wallet_ledger
                                  WHERE user_id=$1 AND asset='USDT'`, [uid])).s);
  const ledT = Number((await one(`SELECT COALESCE(sum(amount),0)::numeric s FROM wallet_ledger
                                  WHERE user_id=$1 AND asset='TRX'`, [uid])).s);

  close('ledger USDT = saldo - inicial', ledU, Number(w.u) - 100);
  // El fee y el monto del retiro TRX salen los dos de trx_balance, así que la
  // suma del ledger de TRX tiene que explicar todo el movimiento.
  close('ledger TRX = saldo - inicial', ledT, Number(w.t) - 50);
}

// ---- 10) Permisos: no ejecutables por PUBLIC --------------------------------
eq('request_withdrawal NO ejecutable por PUBLIC',
  (await one(`SELECT has_function_privilege('public'::name,
      'request_withdrawal(TEXT,TEXT,DECIMAL,TEXT)'::regprocedure, 'EXECUTE') AS p`)).p, false);
eq('resolve_withdrawal NO ejecutable por PUBLIC',
  (await one(`SELECT has_function_privilege('public'::name,
      'resolve_withdrawal(UUID,TEXT,TEXT,TEXT)'::regprocedure, 'EXECUTE') AS p`)).p, false);

// ---- 11) withdrawal_settings() expone la config para que la UI no hardcodee -
const cfg = await one(`SELECT withdrawal_settings() AS s`);
eq('settings: fee 5.5', cfg.s.fee_trx, '5.5');
eq('settings: min USDT 5', cfg.s.min_usdt, '5');
eq('settings: min TRX 10', cfg.s.min_trx, '10');

// ---- 12) RLS activo en las tablas nuevas ------------------------------------
eq('withdrawal_requests con RLS',
  (await one(`SELECT relrowsecurity r FROM pg_class WHERE oid='withdrawal_requests'::regclass`)).r, true);
eq('withdrawal_config con RLS',
  (await one(`SELECT relrowsecurity r FROM pg_class WHERE oid='withdrawal_config'::regclass`)).r, true);

await client.end();
await db.stop();
console.log(`\n${results.length - failures}/${results.length} verificaciones OK`);
process.exit(failures ? 1 : 0);
