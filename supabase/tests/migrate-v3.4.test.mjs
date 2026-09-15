// Ruta REAL de migracion v3.4: base = schema.sql hasta v3.3 (lo que tiene la
// base del usuario una vez aplicado v3.3) + migrate-v3.4.sql.
//
//   1. Que el archivo que va al SQL Editor funcione SOBRE ESA BASE.
//   2. Que sea idempotente: se puede pegar dos veces sin romper nada.
//   3. Drift: el cuerpo de migrate-v3.4.sql es byte a byte el bloque v3.4 de
//      schema.sql, igual que se verifica para v3.0/v3.1/v3.2/v3.3.
//   4. Humo funcional: share_text existe, tg_share sembrada, y las misiones
//      manuales ahora respetan `repeat` (semanal) sin romper First Deposit.
//
//   cd supabase/tests && npm install && npm run test:migrate-v34
import EmbeddedPostgres from 'embedded-postgres';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = 55474;
const strip = (s) =>
  s.replace('CREATE EXTENSION IF NOT EXISTS "pg_cron";', '-- pg_cron')
   .replace(/DO \$\$\s*BEGIN[\s\S]*?cron\.schedule[\s\S]*?\$\$;/, '-- bloque pg_cron omitido (solo arnes)');

let failures = 0;
const check = (n, ok, d) => { if (!ok) failures++; console.log(`${ok?'PASS':'FAIL'}  ${n}${d?`  -> ${d}`:''}`); };

// ---- Drift: schema.sql vs migrate-v3.4.sql (sin levantar postgres) ----
{
  const schemaLines = fs.readFileSync(path.resolve(HERE,'..','schema.sql'),'utf8').split('\n');
  const migLines = fs.readFileSync(path.resolve(HERE,'..','migrate-v3.4.sql'),'utf8').split('\n');
  const s34 = schemaLines.findIndex((l) => l.startsWith('-- v3.4 — misiones'));
  const mi = migLines.findIndex((l) => l.startsWith('-- v3.4 — misiones'));
  // Desde v3.5 el bloque v3.4 ya no llega al EOF de schema.sql: termina donde
  // empieza el bloque v3.5 (su marca, precedida de separadora y linea en blanco).
  const s35 = schemaLines.findIndex((l) => l.startsWith('-- v3.5 — cooldown'));
  let end34 = s35 >= 0 ? s35 - 2 : schemaLines.length;
  while (end34 > 0 && schemaLines[end34 - 1].trim() === '') end34 -= 1;
  const cuerpo = schemaLines.slice(s34, end34);
  check('migrate-v3.4.sql no se desincronizo de schema.sql',
    s34 >= 0 && mi >= 0 && JSON.stringify(migLines.slice(mi, mi + cuerpo.length)) === JSON.stringify(cuerpo),
    `schema.sql:${s34 + 1}.. vs migrate-v3.4.sql:${mi + 1}`);
  check('migrate-v3.4.sql termina donde termina su bloque',
    migLines.length - (mi + cuerpo.length) <= 1,
    `${migLines.length} vs ${mi + cuerpo.length}`);
}

const db = new EmbeddedPostgres({ databaseDir: path.join(HERE,'pgdata-migrate-v34'), user:'postgres', password:'postgres', port: PORT, persistent:false });
await db.initialise(); await db.start();
const c = new pg.Client(`postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`);
await c.connect();
const one = async (s,p) => (await c.query(s,p)).rows[0];

// Base: schema.sql SIN el bloque v3.4 = el estado real tras v3.3.
const full = fs.readFileSync(path.resolve(HERE,'..','schema.sql'),'utf8');
const markerIdx = full.indexOf('-- v3.4 — misiones');
const sepIdx = full.lastIndexOf('-- =============================================', markerIdx);
const cut = full.slice(0, sepIdx);
await c.query(strip(cut));
console.log('--- base aplicada: schema.sql hasta v3.3 ---');

check('la base NO tiene social_missions.share_text',
  Number((await one(`SELECT count(*) c FROM information_schema.columns
    WHERE table_name='social_missions' AND column_name='share_text'`)).c) === 0);
check('la base NO tiene la mision tg_share',
  Number((await one(`SELECT count(*) c FROM social_missions WHERE id='tg_share'`)).c) === 0);

// migrate-v3.4, dos veces (idempotencia)
await c.query(strip(fs.readFileSync(path.resolve(HERE,'..','migrate-v3.4.sql'),'utf8')));
console.log('--- migrate-v3.4 aplicado ---');
await c.query(strip(fs.readFileSync(path.resolve(HERE,'..','migrate-v3.4.sql'),'utf8')));
check('migrate-v3.4 es idempotente', true);

// ---- Estructura post-migracion ----
check('social_missions.share_text existe',
  Number((await one(`SELECT count(*) c FROM information_schema.columns
    WHERE table_name='social_missions' AND column_name='share_text'`)).c) === 1);

const ts = await one(`SELECT reward_usdt, reward_keep, verify, repeat, share_text, enabled, platform
  FROM social_missions WHERE id='tg_share'`);
check('tg_share: 0.50 USDT + 1500 KEEP, manual, semanal, con share_text',
  Number(ts.reward_usdt)===0.5 && ts.reward_keep===1500 && ts.verify==='manual'
    && ts.repeat==='weekly' && ts.enabled===true && typeof ts.share_text==='string' && ts.share_text.length>0,
  JSON.stringify(ts));

// ---- Flujo manual SEMANAL (lo nuevo de v3.4) ----
const u = '99501';
await c.query(`INSERT INTO users (telegram_id, uid) VALUES ($1,$1)`, [u]);
await c.query(`INSERT INTO internal_wallets (user_id, usdt_balance, keep_balance) VALUES ($1, 0, 0)`, [u]);

let r = (await one(`SELECT request_manual_mission($1,'tg_share') AS r`, [u])).r;
check('request tg_share -> pending', r.ok===true && r.pending===true, JSON.stringify(r));

const prow = await one(`SELECT period, status FROM user_social_missions
  WHERE user_id=$1 AND mission_id='tg_share'`, [u]);
check('solicitud pendiente con periodo ISO (no vacio)',
  /^\d{4}-W\d{2}$/.test(prow.period) && prow.status==='pending', JSON.stringify(prow));

r = (await one(`SELECT request_manual_mission($1,'tg_share') AS r`, [u])).r;
check('re-request misma semana -> pending (no duplica)', r.ok===true && r.pending===true, JSON.stringify(r));
check('una sola fila para tg_share',
  Number((await one(`SELECT count(*) c FROM user_social_missions WHERE user_id=$1 AND mission_id='tg_share'`, [u])).c) === 1);

const ap = (await one(`SELECT approve_mission_request($1,'tg_share') AS r`, [u])).r;
check('approve paga 0.50 USDT + 1500 KEEP',
  ap.ok===true && Number(ap.reward)===0.5 && Number(ap.keep_reward)===1500, JSON.stringify(ap));
const w = await one(`SELECT usdt_balance, keep_balance FROM internal_wallets WHERE user_id=$1`, [u]);
check('wallet refleja el pago',
  Number(w.usdt_balance)===0.5 && Number(w.keep_balance)===1500, JSON.stringify(w));
check('la fila queda paid con el periodo ISO',
  (await one(`SELECT status s FROM user_social_missions WHERE user_id=$1 AND mission_id='tg_share'`, [u])).s === 'paid');

r = (await one(`SELECT request_manual_mission($1,'tg_share') AS r`, [u])).r;
check('misma semana tras cobrar -> already', r.ok===false && r.error==='already', JSON.stringify(r));

const led = await one(`SELECT count(*) c FROM wallet_ledger
  WHERE user_id=$1 AND operation='mission_reward' AND asset IN ('USDT','KEEP')`, [u]);
check('ledger USDT + KEEP de la mision aprobada', Number(led.c)===2, String(led.c));

// ---- Rechazo ----
const u3 = '99503';
await c.query(`INSERT INTO users (telegram_id, uid) VALUES ($1,$1)`, [u3]);
await c.query(`INSERT INTO internal_wallets (user_id, usdt_balance) VALUES ($1, 0)`, [u3]);
await one(`SELECT request_manual_mission($1,'tg_share') AS r`, [u3]);
const rj = (await one(`SELECT reject_mission_request($1,'tg_share') AS r`, [u3])).r;
check('reject elimina la solicitud pendiente', rj.ok===true, JSON.stringify(rj));
check('sin pendiente tras reject',
  Number((await one(`SELECT count(*) c FROM user_social_missions
    WHERE user_id=$1 AND mission_id='tg_share' AND status='pending'`, [u3])).c) === 0);

// ---- Retrocompatibilidad: First Deposit (once) sigue igual ----
const u2 = '99502';
await c.query(`INSERT INTO users (telegram_id, uid) VALUES ($1,$1)`, [u2]);
await c.query(`INSERT INTO internal_wallets (user_id, usdt_balance, keep_balance) VALUES ($1, 0, 0)`, [u2]);
r = (await one(`SELECT request_manual_mission($1,'first_deposit') AS r`, [u2])).r;
check('First Deposit request -> pending', r.ok===true && r.pending===true, JSON.stringify(r));
const fdrow = await one(`SELECT period FROM user_social_missions WHERE user_id=$1 AND mission_id='first_deposit'`, [u2]);
check('First Deposit usa periodo vacio (once)', fdrow.period==='', JSON.stringify(fdrow));
const ap2 = (await one(`SELECT approve_mission_request($1,'first_deposit') AS r`, [u2])).r;
check('First Deposit paga 1 USDT + 3000 KEEP',
  ap2.ok===true && Number(ap2.reward)===1 && Number(ap2.keep_reward)===3000, JSON.stringify(ap2));
r = (await one(`SELECT request_manual_mission($1,'first_deposit') AS r`, [u2])).r;
check('First Deposit tras cobrar -> already (una sola vez)', r.ok===false && r.error==='already', JSON.stringify(r));

// ---- Permisos: CREATE OR REPLACE conserva el REVOKE de v3.3 ----
const acl = await one(`SELECT count(*) c FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public'
    AND p.proname IN ('request_manual_mission','approve_mission_request','reject_mission_request')
    AND has_function_privilege('public', p.oid, 'EXECUTE')`);
check('las funciones reemplazadas siguen sin ser publicas', Number(acl.c)===0, String(acl.c));

await c.end(); await db.stop();
console.log(`\n${failures===0 ? 'TODO OK' : failures+' FALLOS'}`);
process.exit(failures?1:0);
