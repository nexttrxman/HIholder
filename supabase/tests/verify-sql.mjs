import EmbeddedPostgres from 'embedded-postgres';
import fs from 'node:fs';
import pg from 'pg';
const PORT = 55440, DIR = './pgdata-verify';
const db = new EmbeddedPostgres({ databaseDir: DIR, user:'postgres', password:'postgres', port:PORT, persistent:false });
await db.initialise(); await db.start();
const c = new pg.Client(`postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`);
c.on('notice', n => { if (/PASS|FAIL|pg_cron/.test(n.message)) console.log('  ' + n.message); });
await c.connect();
await c.query(fs.readFileSync('../schema.sql','utf8').replace('CREATE EXTENSION IF NOT EXISTS "pg_cron";','-- x'));
console.log('=== schema.sql cargado ===\n');
const v = fs.readFileSync('../verify.sql','utf8');
// node-pg devuelve solo el último result set de un multi-statement, así que se
// corre por bloques. Los cortes son los marcadores del propio archivo.
const cortes = [
  v.indexOf('-- PARTE A'),
  v.indexOf('DO $$\nBEGIN\n  IF to_regclass(\'cron.job\')'),
  v.indexOf('BEGIN;\n\nCREATE TEMP TABLE _v'),
];
const bloques = [
  ['PARTE A — estructura', v.slice(cortes[0], cortes[1])],
  ['job pg_cron',          v.slice(cortes[1], cortes[2])],
  ['PARTE B — humo',       v.slice(cortes[2])],
];
let fallas = 0;
for (const [nombre, sql] of bloques) {
  if (!sql.trim()) continue;
  console.log(`\n--- ${nombre} ---`);
  try {
    const res = await c.query(sql);
    const sets = Array.isArray(res) ? res : [res];
    for (const r of sets) {
      if (!r.rows?.length) continue;
      for (const row of r.rows) console.log('   ', JSON.stringify(row));
      fallas += r.rows.filter(x => /FAIL|FALTA|SIN RLS|HAY FALLAS/.test(JSON.stringify(x))).length;
    }
  } catch (e) { console.log('   ERROR:', e.message); fallas++; }
}
process.exitCode = fallas ? 1 : 0;
console.log(`\n=== ${fallas ? fallas + ' filas en FAIL' : 'sin FAIL'} ===`);
await c.end(); await db.stop();
