// Static regression checks for the v3.7 TON MEMO migration. The full schema
// test runs the PL/pgSQL against PostgreSQL; these checks keep the copy-paste
// migration, canonical schema and the Worker contract aligned.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(HERE, '..');
const migration = fs.readFileSync(path.join(root, 'migrate-v3.7.sql'), 'utf8');
const schema = fs.readFileSync(path.join(root, 'schema.sql'), 'utf8');

for (const table of ['deposit_codes', 'ton_deposit_txs', 'unmatched_deposits']) {
  assert.match(migration, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
}
assert.match(migration, /code TEXT UNIQUE NOT NULL/);
assert.match(migration, /code ~ '\^DEP:\[A-Z0-9\]\{6\}\$'/);
assert.match(migration, /tx_hash TEXT PRIMARY KEY/);
assert.match(migration, /CREATE OR REPLACE FUNCTION credit_ton_deposit/);
assert.match(migration, /ON CONFLICT \(tx_hash\) DO NOTHING/);
assert.match(migration, /TON deposit matched by MEMO/);
assert.match(migration, /First Deposit mission approved automatically/);
assert.match(migration, /IF p_amount >= 1 THEN/);
assert.match(migration, /Make your first deposit \(min 1GRAM or 1 USDT\)\. \(review automatico con la wallet\)/);
assert.match(migration, /reward_usdt = 2\.50/);
assert.match(migration, /reward_keep = 5000/);
assert.match(migration, /ALTER TABLE deposit_codes ENABLE ROW LEVEL SECURITY/);
assert.match(migration, /REVOKE EXECUTE ON FUNCTION credit_ton_deposit/);

assert.doesNotMatch(migration, /tron_deposits|credit_tron_deposit|TRON.*deposit/i);

const marker = '-- =====================================================================\n-- TronKeeper — MIGRACION v3.7';
const schemaStart = schema.indexOf(marker);
assert.notEqual(schemaStart, -1, 'schema.sql must include the v3.7 block');
assert.equal(schema.slice(schemaStart).trim(), migration.trim(), 'schema.sql and migrate-v3.7.sql drifted');

console.log('PASS  v3.7 TON MEMO migration structure and schema drift');
