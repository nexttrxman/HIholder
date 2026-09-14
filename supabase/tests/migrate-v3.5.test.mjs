// Ruta REAL de migracion v3.5: base = schema.sql hasta v3.4 (lo que tiene la
// base del usuario una vez aplicado v3.4) + migrate-v3.5.sql.
//
//   1. Que el archivo que va al SQL Editor funcione SOBRE ESA BASE.
//   2. Que sea idempotente: se puede pegar dos veces sin romper nada.
//   3. Drift: el cuerpo de migrate-v3.5.sql es byte a byte el bloque v3.5 de
//      schema.sql, igual que se verifica para v3.0..v3.4.
//   4. Humo funcional: el claim que vence sin cobrarse cierra el ciclo con
//      cooldown de 8 h y los holds se quedan en 3/3 (la regla vieja los
//      devolvia a 0 y dejaba holdear al instante — el bug del usuario).
//
//   cd supabase/tests && npm install && npm run test:migrate-v35
import EmbeddedPostgres from 'embedded-postgres';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = 55475;
const strip = (s) =>
  s.replace('CREATE EXTENSION IF NOT EXISTS "pg_cron";', '-- pg_cron')
   .replace(/DO \$\$\s*BEGIN[\s\S]*?cron\.schedule[\s\S]*?\$\$;/, '-- bloque pg_cron omitido (solo arnes)');

let failures = 0;
const check = (n, ok, d) => { if (!ok) failures++; console.log(`${ok?'PASS':'FAIL'}  ${n}${d?`  -> ${d}`:''}`); };

// ---- Drift: schema.sql vs migrate-v3.5.sql (sin levantar postgres) ----
{
  const schemaLines = fs.readFileSync(path.resolve(HERE,'..','schema.sql'),'utf8').split('\n');
  const migLines = fs.readFileSync(path.resolve(HERE,'..','migrate-v3.5.sql'),'utf8').split('\n');
  const s35 = schemaLines.findIndex((l) => l.startsWith('-- v3.5 — cooldown'));
  const mi = migLines.findIndex((l) => l.startsWith('-- v3.5 — cooldown'));
  // v3.5 es el ultimo bloque: llega al EOF de schema.sql.
  const cuerpo = schemaLines.slice(s35);
  check('migrate-v3.5.sql no se desincronizo de schema.sql',
    s35 >= 0 && mi >= 0 && JSON.stringify(migLines.slice(mi, mi + cuerpo.length)) === JSON.stringify(cuerpo),
    `schema.sql:${s35 + 1}.. vs migrate-v3.5.sql:${mi + 1}`);
  check('migrate-v3.5.sql termina donde termina schema.sql',
    migLines.length - (mi + cuerpo.length) <= 1,
    `${migLines.length} vs ${mi + cuerpo.length}`);
}

const db = new EmbeddedPostgres({ databaseDir: path.join(HERE,'pgdata-migrate-v35'), user:'postgres', password:'postgres', port: PORT, persistent:false });
await db.initialise(); await db.start();
const c = new pg.Client(`postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`);
await c.connect();
const one = async (s,p) => (await c.query(s,p)).rows[0];

// Base: schema.sql SIN el bloque v3.5 = el estado real tras v3.4.
const full = fs.readFileSync(path.resolve(HERE,'..','schema.sql'),'utf8');
const markerIdx = full.indexOf('-- v3.5 — cooldown');
const sepIdx = full.lastIndexOf('-- =============================================', markerIdx);
const cut = full.slice(0, sepIdx);
await c.query(strip(cut));
console.log('--- base aplicada: schema.sql hasta v3.4 ---');

let seq = 0;
const seedUser = async () => {
  const id = `u35_${++seq}`;
  await c.query(`INSERT INTO users (telegram_id, uid) VALUES ($1,$1)`, [id]);
  return id;
};
// Ciclo activo 3/3 con un claim pendiente vencido (el escenario del bug).
const seedStaleClaim = async () => {
  const u = await seedUser();
  const cyc = await one(
    `INSERT INTO hold_cycles (user_id, ends_at, holds_completed, status)
     VALUES ($1, NOW() + INTERVAL '6 hours', 3, 'active') RETURNING id`, [u]);
  await c.query(
    `INSERT INTO claims (claim_id, user_id, cycle_id, total_prize, ton_fee, status, expires_at)
     VALUES ($1, $2, $3, 0.18, 0.05, 'pending', NOW() - INTERVAL '1 minute')`,
    [`CLM35_${seq}`, u, cyc.id]);
  return { u, cycleId: cyc.id, claimId: `CLM35_${seq}` };
};

// ---- La base tiene la regla VIEJA (holds a 0): confirma que el corte es real
{
  const s = await seedStaleClaim();
  await c.query(`SELECT expire_claims_and_cycles()`);
  const cyc = await one(`SELECT holds_completed, status FROM hold_cycles WHERE id=$1`, [s.cycleId]);
  check('base v3.4: la regla vieja devolvia el ciclo a 0 holds',
    Number(cyc.holds_completed) === 0 && cyc.status === 'active', JSON.stringify(cyc));
}

// ---- Aplicar la migracion v3.5 ----
const mig = fs.readFileSync(path.resolve(HERE,'..','migrate-v3.5.sql'),'utf8');
await c.query(mig);
console.log('--- migrate-v3.5.sql aplicado ---');

// ---- Regla nueva: el vencimiento sin cobrar cierra el ciclo con cooldown ----
{
  const s = await seedStaleClaim();
  await c.query(`SELECT expire_claims_and_cycles()`);

  const claim = await one(`SELECT status FROM claims WHERE claim_id=$1`, [s.claimId]);
  check('v3.5: el claim pasa a expired_unclaimed', claim.status === 'expired_unclaimed', claim.status);

  const cyc = await one(`SELECT holds_completed, status, ends_at FROM hold_cycles WHERE id=$1`, [s.cycleId]);
  check('v3.5: los holds se quedan en 3/3', Number(cyc.holds_completed) === 3, String(cyc.holds_completed));
  check('v3.5: el ciclo se cierra como expired', cyc.status === 'expired', cyc.status);
  const h = (new Date(cyc.ends_at).getTime() - Date.now()) / 3600000;
  check('v3.5: el cooldown dura 8 h', h > 7.9 && h <= 8.01, `${h.toFixed(3)} h`);
}

// ---- No toca lo que no debe ----
{
  // Ciclo activo 3/3 con el claim todavia VIVO: sin cambios.
  const s = await seedStaleClaim();
  await c.query(`UPDATE claims SET expires_at = NOW() + INTERVAL '10 minutes' WHERE claim_id=$1`, [s.claimId]);
  await c.query(`SELECT expire_claims_and_cycles()`);
  const cyc = await one(`SELECT status FROM hold_cycles WHERE id=$1`, [s.cycleId]);
  const cl = await one(`SELECT status FROM claims WHERE claim_id=$1`, [s.claimId]);
  check('v3.5: claim vivo no se toca', cl.status === 'pending' && cyc.status === 'active',
    `${cl.status}/${cyc.status}`);
}
{
  // Ciclo activo 2/3 sin claims y con la ventana vencida: expira, SIN cooldown.
  const u = await seedUser();
  const cyc = await one(
    `INSERT INTO hold_cycles (user_id, ends_at, holds_completed, status)
     VALUES ($1, NOW() - INTERVAL '1 hour', 2, 'active') RETURNING id, ends_at`, [u]);
  await c.query(`SELECT expire_claims_and_cycles()`);
  const after = await one(`SELECT status, ends_at FROM hold_cycles WHERE id=$1`, [cyc.id]);
  check('v3.5: ciclo incompleto con ventana vencida solo expira (sin cooldown)',
    after.status === 'expired' && new Date(after.ends_at).getTime() < Date.now(),
    `${after.status} ${after.ends_at.toISOString()}`);
}
{
  // Standby legitimo (completed con ends_at futuro, post-claim): intacto.
  const u = await seedUser();
  const cyc = await one(
    `INSERT INTO hold_cycles (user_id, ends_at, holds_completed, status)
     VALUES ($1, NOW() + INTERVAL '5 hours', 3, 'completed') RETURNING id`, [u]);
  await c.query(`SELECT expire_claims_and_cycles()`);
  const after = await one(`SELECT status FROM hold_cycles WHERE id=$1`, [cyc.id]);
  check('v3.5: el standby tras cobrar no se toca', after.status === 'completed', after.status);
}

// ---- Reparacion unica: ciclo 3/3 con premio perdido entra en cooldown ----
{
  const u = await seedUser();
  const cyc = await one(
    `INSERT INTO hold_cycles (user_id, ends_at, holds_completed, status)
     VALUES ($1, NOW() - INTERVAL '30 minutes', 3, 'active') RETURNING id`, [u]);
  await c.query(
    `INSERT INTO claims (claim_id, user_id, cycle_id, total_prize, ton_fee, status, expires_at)
     VALUES ('CLM35_REP', $1, $2, 0.20, 0.05, 'expired_unclaimed', NOW() - INTERVAL '1 hour')`,
    [u, cyc.id]);
  await c.query(mig); // segunda pasada = reparacion sobre estado legacy
  const after = await one(`SELECT status, holds_completed, ends_at FROM hold_cycles WHERE id=$1`, [cyc.id]);
  const h = (new Date(after.ends_at).getTime() - Date.now()) / 3600000;
  check('v3.5: la reparacion cierra el ciclo legacy 3/3 con cooldown',
    after.status === 'expired' && Number(after.holds_completed) === 3 && h > 7.9 && h <= 8.01,
    `${after.status} ${after.holds_completed} ${h.toFixed(3)} h`);
}

// ---- Idempotencia: pegar el archivo otra vez no rompe ni estira nada ----
{
  const s = await seedStaleClaim();
  await c.query(`SELECT expire_claims_and_cycles()`);
  const before = await one(`SELECT ends_at FROM hold_cycles WHERE id=$1`, [s.cycleId]);
  await c.query(mig);
  await c.query(`SELECT expire_claims_and_cycles()`);
  const after = await one(`SELECT status, ends_at FROM hold_cycles WHERE id=$1`, [s.cycleId]);
  check('v3.5: re-ejecutar no estira el cooldown en marcha',
    after.status === 'expired' && Math.abs(new Date(after.ends_at) - new Date(before.ends_at)) < 5000,
    `${after.ends_at.toISOString()}`);
}

await c.end(); await db.stop();
console.log(`\n${failures===0 ? 'TODO OK' : failures+' FALLOS'}`);
process.exit(failures?1:0);
