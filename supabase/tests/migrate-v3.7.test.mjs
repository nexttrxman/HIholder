// Static regression checks for the v3.7 migration. The full schema test runs
// the PL/pgSQL against PostgreSQL; these checks make sure the SQL users paste
// into Supabase and the canonical schema do not drift.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(HERE, '..');
const migration = fs.readFileSync(path.join(root, 'migrate-v3.7.sql'), 'utf8');
const schema = fs.readFileSync(path.join(root, 'schema.sql'), 'utf8');

assert.match(migration, /CREATE TABLE IF NOT EXISTS tron_deposits/);
assert.match(migration, /tx_hash TEXT UNIQUE NOT NULL/);
assert.match(migration, /CREATE OR REPLACE FUNCTION credit_tron_deposit/);
assert.match(migration, /ON CONFLICT \(tx_hash\) DO NOTHING/);
assert.match(migration, /ALTER TABLE tron_deposits ENABLE ROW LEVEL SECURITY/);
assert.match(migration, /TRON deposit verified without MEMO/);

const marker = '-- =====================================================================\n-- TronKeeper — MIGRACION v3.7';
const schemaStart = schema.indexOf(marker);
assert.notEqual(schemaStart, -1, 'schema.sql must include the v3.7 block');
assert.equal(schema.slice(schemaStart).trim(), migration.trim(), 'schema.sql and migrate-v3.7.sql drifted');

console.log('PASS  v3.7 migration structure and schema drift');
