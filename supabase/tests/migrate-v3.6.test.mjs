// Ruta REAL de migracion v3.6: base = schema.sql hasta v3.5 (lo que tiene la
// base del usuario una vez aplicado v3.5) + migrate-v3.6.sql.
//
//   1. Que el archivo que va al SQL Editor funcione SOBRE ESA BASE.
//   2. Que sea idempotente: se puede pegar dos veces sin romper nada.
//   3. Drift: el cuerpo de migrate-v3.6.sql es byte a byte el bloque v3.6 de
//      schema.sql, igual que se verifica para v3.0..v3.5.
//   4. Humo funcional: el claim que vence sin firmarse devuelve el ciclo a 0
//      holds (disponible enseguida) y la reparacion libera los ciclos que la
//      regla v3.5 bloqueo 8 h por un vencimiento sin cobrar.
//
//   cd supabase/tests && npm install && npm run test:migrate-v36
import EmbeddedPostgres from 'embedded-postgres';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = 55476;
const strip = (s) =>
  s.replace('CREATE EXTENSION IF NOT EXISTS "pg_cron";', '-- pg_cron')
   .replace(/DO \$\$\s*BEGIN[\s\S]*?cron\.schedule[\s\S]*?\$\$;/, '-- bloque pg_cron omitido (solo arnes)');

let failures = 0;
const check = (n, ok, d) => { if (!ok) failures++; console.log(`${ok?'PASS':'FAIL'}  ${n}${d?`  -> ${d}`:''}`); };

// ---- Drift: schema.sql vs migrate-v3.6.sql (sin levantar postgres) ----
{
  const schemaLines = fs.readFileSync(path.resolve(HERE,'..','schema.sql'),'utf8').split('\n');
  const migLines = fs.readFileSync(path.resolve(HERE,'..','migrate-v3.6.sql'),'utf8').split('\n');
  const s36 = schemaLines.findIndex((l) => l.startsWith('-- v3.6 —'));
  const mi = migLines.findIndex((l) => l.startsWith('-- v3.6 —'));
  // v3.6 es el ultimo bloque: llega al EOF de schema.sql.
  const cuerpo = schemaLines.slice(s36);
  check('migrate-v3.6.sql no se desincronizo de schema.sql',
    s36 >= 0 && mi >= 0 && JSON.stringify(migLines.slice(mi, mi + cuerpo.length)) === JSON.stringify(cuerpo),
    `schema.sql:${s36 + 1}.. vs migrate-v3.6.sql:${mi + 1}`);
  check('migrate-v3.6.sql termina donde termina schema.sql',
    migLines.length - (mi + cuerpo.length) <= 1,
    `${migLines.length} vs ${mi + cuerpo.length}`);
}

const db = new EmbeddedPostgres({ databaseDir: path.join(HERE,'pgdata-migrate-v36'), user:'postgres', password:'postgres', port: PORT, persistent:false });
await db.initialise(); await db.start();
const c = new pg.Client(`postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`);
await c.connect();
const one = async (s,p) => (await c.query(s,p)).rows[0];

// Base: schema.sql SIN el bloque v3.6 = el estado real tras v3.5.
const full = fs.readFileSync(path.resolve(HERE,'..','schema.sql'),'utf8');
const markerIdx = full.indexOf('-- v3.6 —');
const sepIdx = full.lastIndexOf('-- =============================================', markerIdx);
const cut = full.slice(0, sepIdx);
await c.query(strip(cut));
console.log('--- base aplicada: schema.sql hasta v3.5 ---');

let seq = 0;
const seedUser = async () => {
  const id = `u36_${++seq}`;
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
    [`CLM36_${seq}`, u, cyc.id]);
  return { u, cycleId: cyc.id, claimId: `CLM36_${seq}` };
};

// ---- La base tiene la regla v3.5 (cooldown 8 h): confirma el corte ----
{
  const s = await seedStaleClaim();
  await c.query(`SELECT expire_claims_and_cycles()`);
  const cyc = await one(`SELECT holds_completed, status FROM hold_cycles WHERE id=$1`, [s.cycleId]);
  check('base v3.5: la regla anterior cerraba el ciclo con cooldown',
    Number(cyc.holds_completed) === 3 && cyc.status === 'expired', JSON.stringify(cyc));
  // Dejarlo como ciclo encajado: la reparacion de v3.6 debe liberarlo.
}

// ---- Aplicar la migracion v3.6 ----
const mig = fs.readFileSync(path.resolve(HERE,'..','migrate-v3.6.sql'),'utf8');
await c.query(mig);
console.log('--- migrate-v3.6.sql aplicado ---');

// ---- Reparacion: el ciclo encajado por v3.5 vuelve a active con 0 holds ----
{
  const stuck = (await c.query(
    `SELECT hc.id, hc.status, hc.holds_completed, hc.ends_at FROM hold_cycles hc
     WHERE hc.status='active' AND hc.holds_completed=0`)).rows;
  check('v3.6: la reparacion libero el ciclo encajado por v3.5',
    stuck.length === 1 && new Date(stuck[0].ends_at) > new Date(), JSON.stringify(stuck[0]));
}

// ---- Regla nueva: el vencimiento sin firmar devuelve el ciclo a 0 ----
{
  const s = await seedStaleClaim();
  await c.query(`SELECT expire_claims_and_cycles()`);

  const claim = await one(`SELECT status FROM claims WHERE claim_id=$1`, [s.claimId]);
  check('v3.6: el claim pasa a expired_unclaimed', claim.status === 'expired_unclaimed', claim.status);

  const cyc = await one(`SELECT holds_completed, status FROM hold_cycles WHERE id=$1`, [s.cycleId]);
  check('v3.6: el ciclo vuelve a 0 holds', Number(cyc.holds_completed) === 0, String(cyc.holds_completed));
  check('v3.6: el ciclo sigue activo (hold disponible enseguida)', cyc.status === 'active', cyc.status);
}

// ---- No toca lo que no debe ----
{
  // Claim vivo: sin cambios.
  const s = await seedStaleClaim();
  await c.query(`UPDATE claims SET expires_at = NOW() + INTERVAL '10 minutes' WHERE claim_id=$1`, [s.claimId]);
  await c.query(`SELECT expire_claims_and_cycles()`);
  const cl = await one(`SELECT status FROM claims WHERE claim_id=$1`, [s.claimId]);
  const cyc = await one(`SELECT holds_completed FROM hold_cycles WHERE id=$1`, [s.cycleId]);
  check('v3.6: claim vivo no se toca', cl.status === 'pending' && Number(cyc.holds_completed) === 3,
    `${cl.status}/${cyc.holds_completed}`);
}
{
  // Standby legitimo (completed con ends_at futuro, post-cobro): intacto.
  const u = await seedUser();
  const cyc = await one(
    `INSERT INTO hold_cycles (user_id, ends_at, holds_completed, status)
     VALUES ($1, NOW() + INTERVAL '5 hours', 3, 'completed') RETURNING id`, [u]);
  await c.query(`SELECT expire_claims_and_cycles()`);
  await c.query(mig); // la reparacion tampoco debe tocarlo
  const after = await one(`SELECT status, holds_completed FROM hold_cycles WHERE id=$1`, [cyc.id]);
  check('v3.6: el cooldown post-cobro no se toca',
    after.status === 'completed' && Number(after.holds_completed) === 3, JSON.stringify(after));
}

// ---- Idempotencia: pegar el archivo otra vez no rompe nada ----
{
  const s = await seedStaleClaim();
  await c.query(mig);
  await c.query(`SELECT expire_claims_and_cycles()`);
  const cyc = await one(`SELECT holds_completed, status FROM hold_cycles WHERE id=$1`, [s.cycleId]);
  check('v3.6: re-ejecutar la migracion es seguro',
    Number(cyc.holds_completed) === 0 && cyc.status === 'active', JSON.stringify(cyc));
}

await c.end(); await db.stop();
console.log(`\n${failures===0 ? 'TODO OK' : failures+' FALLOS'}`);
process.exit(failures?1:0);
