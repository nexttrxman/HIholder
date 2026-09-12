// Misiones sociales (v3.1): config-driven, pago unico, verificacion real de
// Telegram del lado del Worker. Aca se fija lo que la base garantiza sola:
// que la mision pague exactamente una vez y que los permisos queden cerrados.
//
//   cd supabase/tests && npm install && node social-missions.test.mjs
import EmbeddedPostgres from 'embedded-postgres';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA = path.resolve(HERE, '..', 'schema.sql');
const DATADIR = path.join(HERE, 'pgdata-social');
const PORT = Number(process.env.PGSM_PORT || 55466);

let failures = 0;
const check = (name, ok, detail) => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  → ${detail}` : ''}`);
};
const eq = (name, a, b) => check(name, String(a) === String(b), `got ${a}, want ${b}`);

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

// ---- 1) Config sembrada -----------------------------------------------------
eq('dos misiones de Telegram habilitadas',
  (await one(`SELECT count(*) c FROM social_missions WHERE verify='telegram_member' AND enabled`)).c, 2);
eq('tres placeholders disabled',
  (await one(`SELECT count(*) c FROM social_missions WHERE enabled=false`)).c, 3);
eq('recompensa 0.4 USDT',
  Number((await one(`SELECT reward_usdt r FROM social_missions WHERE id='tg_channel'`)).r), 0.4);
eq('el chat del canal es el del usuario',
  (await one(`SELECT chat_id c FROM social_missions WHERE id='tg_channel'`)).c, '@KeeperExchange');

await q(`INSERT INTO users (telegram_id, uid) VALUES ('8001','TK_SM')`);
await q(`INSERT INTO internal_wallets (user_id, usdt_balance, trx_balance) VALUES ('8001', 10, 0)`);
const bal = async () => (await one(`SELECT usdt_balance::numeric u FROM internal_wallets WHERE user_id='8001'`)).u;
const call = async (uid, mid) => (await one(`SELECT complete_social_mission($1,$2) AS r`, [uid, mid])).r;

// ---- 2) Pago unico ----------------------------------------------------------
const r1 = await call('8001', 'tg_channel');
eq('primer cobro ok', r1.ok, true);
eq('paga 0.4', Number(r1.reward), 0.4);
eq('saldo 10 -> 10.4', Number(await bal()), 10.4);

const led = await one(`SELECT operation, amount::numeric a, description d FROM wallet_ledger
                       WHERE user_id='8001' AND operation='mission_reward'`);
eq('ledger mission_reward', led.operation, 'mission_reward');
eq('ledger +0.4', Number(led.a), 0.4);
check('descripcion con el titulo', /Follow the channel/.test(led.d), led.d);

const r2 = await call('8001', 'tg_channel');
eq('segundo cobro rechazado', r2.ok, false);
eq('motivo already', r2.error, 'already');
eq('saldo no se mueve al reintentar', Number(await bal()), 10.4);

// ---- 3) Bordes --------------------------------------------------------------
eq('placeholder disabled no paga', (await call('8001', 'instagram')).ok, false);
eq('mision inexistente no paga', (await call('8001', 'nope')).ok, false);
eq('el saldo sigue intacto tras los rechazos', Number(await bal()), 10.4);
eq('una sola fila en user_social_missions',
  (await one(`SELECT count(*) c FROM user_social_missions WHERE user_id='8001'`)).c, 1);

// ---- 4) Permisos ------------------------------------------------------------
eq('authenticated NO ejecuta complete_social_mission',
  (await one(`SELECT has_function_privilege('authenticated','complete_social_mission(text,text)','EXECUTE') p`)).p, false);
eq('anon NO ejecuta complete_social_mission',
  (await one(`SELECT has_function_privilege('anon','complete_social_mission(text,text)','EXECUTE') p`)).p, false);
eq('service_role SI ejecuta',
  (await one(`SELECT has_function_privilege('service_role','complete_social_mission(text,text)','EXECUTE') p`)).p, true);

await client.end();
await db.stop();
console.log(`\n${failures === 0 ? 'TODO OK' : failures + ' FALLOS'}`);
process.exit(failures ? 1 : 0);
