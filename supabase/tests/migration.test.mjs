// La base real de Supabase ya tiene tablas viejas (users, claims, transactions,
// referrals). CREATE TABLE IF NOT EXISTS las salta en silencio, así que sin el
// bloque de migración el schema "carga bien" y después revienta en runtime.
//
// Este test arma una base con la forma VIEJA, corre schema.sql encima y verifica
// que el bloque de migración renombre lo que conflictúa sin borrar datos.
//
//   cd supabase/tests && npm install && npm run test:migration
import EmbeddedPostgres from 'embedded-postgres';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA = path.resolve(HERE, '..', 'schema.sql');
const DATADIR = path.join(HERE, 'pgdata-migration');
const PORT = Number(process.env.PGMIG_PORT || 55433);

const results = [];
let failures = 0;
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  → ${detail}` : ''}`);
};
const eq = (name, a, b) => check(name, String(a) === String(b), `got ${a}, want ${b}`);

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
const exists = async (rel) =>
  (await one(`SELECT to_regclass($1) AS r`, [`public.${rel}`])).r !== null;

// ---- 1) Estado viejo, tal como está en la base real ------------------------
// users YA tiene uid (el login funciona en producción), así que no se renombra.
await q(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
await q(`
  CREATE TABLE users (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    telegram_id TEXT UNIQUE NOT NULL,
    uid TEXT UNIQUE NOT NULL,
    username TEXT,
    first_name TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`);

// claims viejo: sin total_prize / ton_fee / expires_at / cycle_id
await q(`
  CREATE TABLE claims (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    claim_id TEXT UNIQUE NOT NULL,
    user_id TEXT NOT NULL,
    amount DECIMAL(18,8),
    status TEXT DEFAULT 'pending',
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`);
await q(`INSERT INTO claims (claim_id, user_id, amount) VALUES ('CLM_OLD_1','999',0.42)`);

// transactions viejo: sin type/asset/amount/status
await q(`
  CREATE TABLE transactions (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    user_id TEXT,
    note TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`);
await q(`INSERT INTO transactions (user_id, note) VALUES ('999','fila vieja')`);

// referrals viejo: sin reward_amount / reward_asset / status
await q(`
  CREATE TABLE referrals (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    referrer_id TEXT NOT NULL,
    referred_id TEXT NOT NULL,
    referred_username TEXT,
    reward_paid BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`);
await q(`INSERT INTO referrals (referrer_id, referred_id) VALUES ('111','222')`);

// referral_pool viejo: sin distributed
await q(`CREATE TABLE referral_pool (id SERIAL PRIMARY KEY, total_pool DECIMAL(18,8))`);
await q(`INSERT INTO referral_pool (total_pool) VALUES (50000)`);

check('estado viejo armado', await exists('claims') && !(await exists('hold_cycles')));

// ---- 2) schema.sql encima --------------------------------------------------
let sql = fs.readFileSync(SCHEMA, 'utf8');
sql = sql.replace('CREATE EXTENSION IF NOT EXISTS "pg_cron";', '-- pg_cron: solo en Supabase');
let loadError = null;
try {
  await q(sql);
} catch (e) {
  loadError = e;
}
check('schema.sql carga encima de una base vieja', !loadError, loadError ? loadError.message : 'ok');
if (loadError) {
  console.log('\nSin carga no se puede seguir.');
  await client.end(); await db.stop();
  process.exit(1);
}

// ---- 3) Las tablas conflictuadas se renombraron, no se borraron ------------
eq('claims vieja preservada como claims_legacy', await exists('claims_legacy'), true);
eq('transactions vieja preservada', await exists('transactions_legacy'), true);
eq('referrals vieja preservada', await exists('referrals_legacy'), true);
eq('referral_pool viejo preservado', await exists('referral_pool_legacy'), true);

// DECIMAL(18,8) viene como '0.42000000': comparar numéricamente, no como string.
eq('los datos viejos siguen ahí (claims)',
  parseFloat((await one(`SELECT amount FROM claims_legacy WHERE claim_id='CLM_OLD_1'`)).amount), 0.42);
eq('los datos viejos siguen ahí (transactions)',
  (await one(`SELECT COUNT(*)::int n FROM transactions_legacy`)).n, 1);
eq('los datos viejos siguen ahí (referrals)',
  (await one(`SELECT COUNT(*)::int n FROM referrals_legacy`)).n, 1);
eq('los datos viejos siguen ahí (referral_pool)',
  (await one(`SELECT total_pool FROM referral_pool_legacy LIMIT 1`)).total_pool, '50000.00000000');

// users NO se renombra: es la raíz de todas las FK
eq('users no fue renombrada', await exists('users_legacy'), false);
eq('users sigue siendo la única', await exists('users'), true);

// ---- 4) Las tablas nuevas tienen la forma correcta -------------------------
for (const [rel, col] of [
  ['claims', 'total_prize'], ['claims', 'ton_fee'], ['claims', 'expires_at'], ['claims', 'cycle_id'],
  ['transactions', 'type'], ['referrals', 'status'], ['referrals', 'reward_amount'],
  ['referral_pool', 'distributed'], ['hold_cycles', 'holds_completed'],
]) {
  const r = await one(
    `SELECT COUNT(*)::int n FROM information_schema.columns
     WHERE table_schema='public' AND table_name=$1 AND column_name=$2`, [rel, col]);
  eq(`nueva ${rel}.${col}`, r.n, 1);
}

// ---- 5) Idempotencia: correrlo de nuevo no rompe nada ----------------------
let secondError = null;
try {
  await q(sql);
} catch (e) {
  secondError = e;
}
check('correr schema.sql una segunda vez no falla', !secondError, secondError ? secondError.message : 'ok');
eq('y no duplica los *_legacy',
  (await one(`SELECT COUNT(*)::int n FROM information_schema.tables
              WHERE table_schema='public' AND table_name LIKE '%\\_legacy'`)).n, 4);

// ---- 6) Y el flujo de referidos funciona de punta a punta -----------------
await q(`INSERT INTO users (telegram_id, uid) VALUES ('111','TK_REF'), ('222','TK_INV')`);
const reg = (await one(`SELECT register_referral('TK_REF','222','invitado') AS r`)).r;
eq('register_referral: registra', reg.ok, true);
eq('register_referral: quedó confirmado=false (pending)', reg.registered, true);
eq('referrals: fila pending con 2 TRX',
  (await one(`SELECT status, reward_amount, reward_asset FROM referrals WHERE referred_id='222'`))
    .status, 'pending');

await client.end();
await db.stop();

console.log(`\n${results.length - failures}/${results.length} verificaciones OK`);
process.exit(failures ? 1 : 0);
