// Ruta REAL de migracion: la base del usuario (schema.sql hasta v2.9, que es lo
// que diagnose.sql le confirmo con 15/15) + migrate-v3.0.sql.
//
// Sirve para dos cosas:
//   1. Que el archivo que va al SQL Editor funcione SOBRE ESA BASE, no sobre un
//      schema.sql que ya trae v3.0 dentro.
//   2. Que sea idempotente: se puede pegar dos veces sin romper nada.
//
//   cd supabase/tests && npm install && npm run test:migrate-v3
import EmbeddedPostgres from 'embedded-postgres';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = 55455;
// El schema base trae un DO que llama a cron.unschedule(). Su EXCEPTION captura
// undefined_table/undefined_function, pero sin pg_cron el error real es
// invalid_schema_name (3F000), que no esta en la lista: revienta. En el Supabase
// real pg_cron SI esta habilitado (diagnose mostro jobid 4), asi que esto es un
// problema solo del arnes. Se saca el bloque entero.
const strip = (s) =>
  s.replace('CREATE EXTENSION IF NOT EXISTS "pg_cron";', '-- pg_cron')
   .replace(/DO \$\$\s*BEGIN[\s\S]*?cron\.schedule[\s\S]*?\$\$;/, '-- bloque pg_cron omitido (solo arnes)');

let failures = 0;
const check = (n, ok, d) => { if (!ok) failures++; console.log(`${ok?'PASS':'FAIL'}  ${n}${d?`  -> ${d}`:''}`); };

const db = new EmbeddedPostgres({ databaseDir: path.join(HERE,'pgdata-migrate-v3'), user:'postgres', password:'postgres', port: PORT, persistent:false });
await db.initialise(); await db.start();
const c = new pg.Client(`postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`);
await c.connect();

// Base: schema.sql SIN el bloque v3.0. Eso es exactamente el estado de la base
// real del usuario: diagnose.sql le dio 15/15, o sea que tiene v2.4..v2.9 y la
// funcion wallet_ledger_apply_operation_check(), pero nada de v3.0.
// (El schema de 90003c1 NO sirve de base: no trae esa funcion y migrate-v2.9
// la necesita. La base real esta mas adelante que ese commit.)
// El cuerpo de migrate-v3.0.sql DEBE ser el bloque v3.0 de schema.sql sin cambios.
// Si alguien toca uno y no el otro, el SQL Editor recibe algo que los tests no
// probaron. Esta verificacion hace que la desincronizacion falle la suite.
{
  const schemaLines = fs.readFileSync(path.resolve(HERE,'..','schema.sql'),'utf8').split('\n');
  const migLines = fs.readFileSync(path.resolve(HERE,'..','migrate-v3.0.sql'),'utf8').split('\n');
  const si = schemaLines.findIndex((l) => l.startsWith('-- v3.0 — RETIROS'));
  const mi = migLines.findIndex((l) => l.startsWith('-- v3.0 — RETIROS'));
  const cuerpo = schemaLines.slice(si);
  check('migrate-v3.0.sql no se desincronizo de schema.sql',
    si >= 0 && mi >= 0 && JSON.stringify(migLines.slice(mi, mi + cuerpo.length)) === JSON.stringify(cuerpo),
    `schema.sql:${si + 1} vs migrate-v3.0.sql:${mi + 1}`);
}

const full = fs.readFileSync(path.resolve(HERE,'..','schema.sql'),'utf8');
const cut = full.slice(0, full.indexOf('-- v3.0 — RETIROS'));
await c.query(strip(cut));
console.log('--- base aplicada: schema.sql hasta v2.9, sin v3.0 ---');
const antes = (await c.query(`SELECT count(*) c FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND (p.proname LIKE '%withdrawal%')`)).rows[0];
check('la base NO tiene nada de withdrawal', Number(antes.c)===0, `${antes.c} funciones`);

// 3) migrate-v3.0.sql (lo que va a correr ahora)
await c.query(strip(fs.readFileSync(path.resolve(HERE,'..','migrate-v3.0.sql'),'utf8')));
console.log('--- migrate-v3.0 aplicado ---');

const one = async (s,p) => (await c.query(s,p)).rows[0];

// El SELECT final de verificacion
const v = (await c.query(`SELECT n, estado FROM (
  SELECT 1 n, CASE WHEN to_regclass('public.withdrawal_requests') IS NOT NULL THEN 'OK' ELSE 'FALTA' END estado
  UNION ALL SELECT 2, CASE WHEN to_regclass('public.withdrawal_config') IS NOT NULL THEN 'OK' ELSE 'FALTA' END
  UNION ALL SELECT 3, CASE WHEN (SELECT fee_trx FROM withdrawal_config WHERE id=1)=5.5 THEN 'OK' ELSE 'FALTA' END
  UNION ALL SELECT 4, CASE WHEN (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN ('withdrawal_settings','request_withdrawal','resolve_withdrawal'))=3 THEN 'OK' ELSE 'FALTA' END
  UNION ALL SELECT 5, CASE WHEN (SELECT count(*) FROM pg_class WHERE relname IN ('withdrawal_requests','withdrawal_config') AND relrowsecurity)=2 THEN 'OK' ELSE 'FALTA' END) x ORDER BY n`)).rows;
for (const r of v) check(`verificacion #${r.n}`, r.estado==='OK', r.estado);

// Idempotencia: correrlo dos veces no debe romper
await c.query(strip(fs.readFileSync(path.resolve(HERE,'..','migrate-v3.0.sql'),'utf8')));
check('migrate-v3.0 es idempotente', true);
check('la config sigue siendo 1 fila tras re-correlo', Number((await one('SELECT count(*) c FROM withdrawal_config')).c)===1);

// Un retiro de punta a punta sobre la base migrada
// internal_wallets.user_id es TEXT -> users(telegram_id), no el UUID.
const u = '99001';
await c.query(`INSERT INTO users (telegram_id, uid, username) VALUES ($1,'u99001','mig')`, [u]);
await c.query(`INSERT INTO internal_wallets (user_id, usdt_balance, trx_balance) VALUES ($1, 100, 20)`, [u]);

// La funcion devuelve UNA fila cuyo nombre de columna es el de la funcion.
const r1 = (await one(`SELECT request_withdrawal($1,'USDT',50,$2) AS r`, [u,'TQrZ8wBsFZ3Q1dK9Yz1xYz1xYz1xYz1xYz'])).r;
check('request_withdrawal ok', r1.ok===true, JSON.stringify(r1));
check('queda en pending', r1.status==='pending', String(r1.status));
check('el fee cobrado es 5.5', Number(r1.fee_trx)===5.5, String(r1.fee_trx));
const w = await one(`SELECT usdt_balance, trx_balance FROM internal_wallets WHERE user_id=$1`, [u]);
check('debito USDT 100->50', Number(w.usdt_balance)===50, String(w.usdt_balance));
check('debito TRX 20->14.5 (el fee se cobra aunque sea USDT)', Number(w.trx_balance)===14.5, String(w.trx_balance));

// El CHECK del ledger acepta 'withdrawal' y 'fee_deduction' sobre la base migrada
const ops = (await c.query(`SELECT operation, amount FROM wallet_ledger WHERE user_id=$1 ORDER BY created_at, id`, [u])).rows;
check('ledger tiene withdrawal + fee_deduction', ops.some(o=>o.operation==='withdrawal') && ops.some(o=>o.operation==='fee_deduction'), ops.map(o=>o.operation).join(','));

// Rechazo -> devolucion
const id = (await one(`SELECT id FROM withdrawal_requests WHERE user_id=$1`, [u])).id;
const res = (await one(`SELECT resolve_withdrawal($1,'rejected','no','test') AS r`, [id])).r;
check('resolve rejected ok', res.ok===true, JSON.stringify(res));
check('marca refunded', res.refunded===true, String(res.refunded));
const w2 = await one(`SELECT usdt_balance, trx_balance FROM internal_wallets WHERE user_id=$1`, [u]);
check('devolvio los 50 USDT', Number(w2.usdt_balance)===100, String(w2.usdt_balance));
check('devolvio los 5.5 TRX', Number(w2.trx_balance)===20, String(w2.trx_balance));

await c.end(); await db.stop();
console.log(`\n${failures===0 ? 'TODO OK' : failures+' FALLOS'}`);
process.exit(failures?1:0);
