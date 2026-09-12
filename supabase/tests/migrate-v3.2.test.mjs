// Ruta REAL de migracion v3.2: base = schema.sql hasta v3.1 (lo que tiene la
// base del usuario una vez aplicados v3.0 y v3.1) + migrate-v3.2.sql.
//
//   1. Que el archivo que va al SQL Editor funcione SOBRE ESA BASE.
//   2. Que sea idempotente: se puede pegar dos veces sin romper nada.
//   3. Drift: el cuerpo de migrate-v3.2.sql es byte a byte el bloque v3.2 de
//      schema.sql, igual que se verifica para v3.0/v3.1.
//
//   cd supabase/tests && npm install && npm run test:keep
import EmbeddedPostgres from 'embedded-postgres';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = 55467;
const strip = (s) =>
  s.replace('CREATE EXTENSION IF NOT EXISTS "pg_cron";', '-- pg_cron')
   .replace(/DO \$\$\s*BEGIN[\s\S]*?cron\.schedule[\s\S]*?\$\$;/, '-- bloque pg_cron omitido (solo arnes)');

let failures = 0;
const check = (n, ok, d) => { if (!ok) failures++; console.log(`${ok?'PASS':'FAIL'}  ${n}${d?`  -> ${d}`:''}`); };

// ---- Drift: schema.sql vs migrate-v3.2.sql (sin levantar postgres) ----
{
  const schemaLines = fs.readFileSync(path.resolve(HERE,'..','schema.sql'),'utf8').split('\n');
  const migLines = fs.readFileSync(path.resolve(HERE,'..','migrate-v3.2.sql'),'utf8').split('\n');
  // Igual que en v3.0/v3.1: se compara desde la linea del MARCADOR hasta EOF
  // (la separadora que la precede queda fuera de la comparacion).
  const s32 = schemaLines.findIndex((l) => l.startsWith('-- v3.2 — $KEEP'));
  const mi = migLines.findIndex((l) => l.startsWith('-- v3.2 — $KEEP'));
  const cuerpo = schemaLines.slice(s32);
  check('migrate-v3.2.sql no se desincronizo de schema.sql',
    s32 >= 0 && mi >= 0 && JSON.stringify(migLines.slice(mi, mi + cuerpo.length)) === JSON.stringify(cuerpo),
    `schema.sql:${s32 + 1}.. vs migrate-v3.2.sql:${mi + 1}`);
  check('migrate-v3.2.sql termina donde termina schema.sql',
    migLines.length - (mi + cuerpo.length) <= 1,
    `${migLines.length} vs ${mi + cuerpo.length}`);
}

const db = new EmbeddedPostgres({ databaseDir: path.join(HERE,'pgdata-migrate-v32'), user:'postgres', password:'postgres', port: PORT, persistent:false });
await db.initialise(); await db.start();
const c = new pg.Client(`postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`);
await c.connect();
const one = async (s,p) => (await c.query(s,p)).rows[0];

// Base: schema.sql SIN el bloque v3.2 = el estado real tras v3.1.
const full = fs.readFileSync(path.resolve(HERE,'..','schema.sql'),'utf8');
const markerIdx = full.indexOf('-- v3.2 — $KEEP');
const sepIdx = full.lastIndexOf('-- =============================================', markerIdx);
const cut = full.slice(0, sepIdx);
await c.query(strip(cut));
console.log('--- base aplicada: schema.sql hasta v3.1 ---');

const sinKeep = await one(`SELECT count(*) c FROM information_schema.columns
  WHERE table_name='internal_wallets' AND column_name='keep_balance'`);
check('la base NO tiene keep_balance', Number(sinKeep.c)===0, `${sinKeep.c}`);

// migrate-v3.2, dos veces (idempotencia)
await c.query(strip(fs.readFileSync(path.resolve(HERE,'..','migrate-v3.2.sql'),'utf8')));
console.log('--- migrate-v3.2 aplicado ---');
await c.query(strip(fs.readFileSync(path.resolve(HERE,'..','migrate-v3.2.sql'),'utf8')));
check('migrate-v3.2 es idempotente', true);

// Verificacion post-migracion
check('keep_balance existe', Number((await one(`SELECT count(*) c FROM information_schema.columns
  WHERE table_name='internal_wallets' AND column_name='keep_balance'`)).c)===1);
check('el ledger acepta KEEP', (await one(`SELECT convalidated v FROM pg_constraint
  WHERE conname='wallet_ledger_asset_check'`)).v===true);
check('managed_prices sembrada', Number((await one(`SELECT count(*) c FROM managed_prices WHERE pair='KEEPUSDT'`)).c)===1);
check('funciones nuevas presentes', Number((await one(`SELECT count(*) c FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname IN ('buy_keep','managed_price_tick','managed_price_candles')`)).c)===3);
check('RLS en las tablas de precio', Number((await one(`SELECT count(*) c FROM pg_class
  WHERE relname IN ('managed_prices','managed_price_ticks') AND relrowsecurity`)).c)===2);

// Humo funcional sobre la base migrada (no sobre schema.sql completo)
const u = '88001';
await c.query(`INSERT INTO users (telegram_id, uid, username) VALUES ($1,'u88001','keep')`, [u]);
await c.query(`INSERT INTO internal_wallets (user_id, usdt_balance) VALUES ($1, 25)`, [u]);

const tick = (await one(`SELECT managed_price_tick('KEEPUSDT') AS r`)).r;
check('managed_price_tick ok', tick.ok===true, JSON.stringify(tick));
const px = Number(tick.price);
check('precio dentro de la banda', px >= 0.00012 && px <= 0.0006, String(px));

const buy = (await one(`SELECT buy_keep($1, 10, $2) AS r`, [u, px])).r;
check('buy_keep ok sobre la base migrada', buy.ok===true, JSON.stringify(buy));
check('debito USDT con fee', Number(buy.usdt_balance)===25-10.01, String(buy.usdt_balance));
check('keep acreditado', Number(buy.keep_balance) > 0, String(buy.keep_balance));

await c.end(); await db.stop();
console.log(`\n${failures===0 ? 'TODO OK' : failures+' FALLOS'}`);
process.exit(failures?1:0);
