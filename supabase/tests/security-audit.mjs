/**
 * Auditoría de seguridad de supabase/schema.sql contra un PostgreSQL real.
 *
 * A diferencia de verify.sql (que confirma que el deploy quedó completo), esto
 * busca configuraciones peligrosas. Cada chequeo imprime lo que encontró, no
 * solo PASS/FAIL: una auditoría que no muestra la evidencia no se puede revisar.
 *
 * Uso: cd supabase/tests && npm i && node security-audit.mjs
 * Sale con código 1 si aparece algún hallazgo de severidad ALTA.
 */
import EmbeddedPostgres from 'embedded-postgres';
import fs from 'node:fs';
import pg from 'pg';

const PORT = 55441;
const DIR = './pgdata-audit';
const db = new EmbeddedPostgres({
  databaseDir: DIR, user: 'postgres', password: 'postgres', port: PORT, persistent: false,
});
await db.initialise();
await db.start();

const c = new pg.Client(`postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`);
await c.connect();

let schema = fs.readFileSync('../schema.sql', 'utf8');
// pg_cron no existe en un Postgres pelado; schema.sql ya lo tolera, pero la
// extensión se comenta para no depender de ella.
schema = schema.replace('CREATE EXTENSION IF NOT EXISTS "pg_cron";', '-- x');

// Supabase crea estos roles; un Postgres local no. Se crean para que los
// chequeos de permisos tengan sobre qué evaluar.
for (const r of ['anon', 'authenticated', 'service_role']) {
  await c.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}')
    THEN CREATE ROLE ${r} NOLOGIN; END IF; END $$;`).catch(() => {});
}

await c.query(schema);
console.log('=== schema.sql cargado en PostgreSQL real ===\n');

const hallazgos = [];
const report = (sev, titulo, filas, nota) => {
  const icon = sev === 'ALTA' ? '🔴' : sev === 'MEDIA' ? '🟡' : '🟢';
  console.log(`${icon} [${sev}] ${titulo}`);
  if (nota) console.log(`   ${nota}`);
  if (!filas || filas.length === 0) {
    console.log('   (ninguno)\n');
  } else {
    for (const f of filas) console.log(`   - ${f}`);
    console.log('');
  }
  if (sev === 'ALTA' && filas && filas.length > 0) hallazgos.push(titulo);
};

const q = async (sql) => (await c.query(sql)).rows;

// ---------------------------------------------------------------------------
// 1. SECURITY DEFINER
// ---------------------------------------------------------------------------
// Una función SECURITY DEFINER corre con los privilegios de su dueño
// (normalmente postgres). Si además no pinea search_path, cualquiera que pueda
// crear un objeto en un esquema anterior del path puede secuestrar cualquier
// función u operador que la función llame sin calificar.
const definer = await q(`
  SELECT n.nspname || '.' || p.proname || '(' ||
         pg_get_function_identity_arguments(p.oid) || ')' AS firma,
         r.rolname AS duenio,
         COALESCE(array_to_string(p.proconfig, ', '), '(sin SET)') AS config
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  JOIN pg_roles r ON r.oid = p.proowner
  WHERE p.prosecdef AND n.nspname NOT IN ('pg_catalog','information_schema')
  ORDER BY 1`);

report(
  definer.some((d) => d.config === '(sin SET)') ? 'ALTA' : 'MEDIA',
  'Funciones SECURITY DEFINER',
  definer.map((d) => `${d.firma} — dueño: ${d.duenio} — search_path: ${d.config}`),
  'Corren con los privilegios del dueño. Si no pinean search_path, son secuestrables.'
);

// ---------------------------------------------------------------------------
// 2. EXECUTE para roles no privilegiados
// ---------------------------------------------------------------------------
// Los RPC mutan saldos. Si PUBLIC/anon/authenticated conservan EXECUTE,
// cualquiera con la anon key (que es pública por diseño) puede acreditarse.
// 'PUBLIC' no es un rol: es un pseudo-rol, así que has_function_privilege()
// revienta con "role PUBLIC does not exist". Se consulta el ACL directamente.
//
// El detalle que importa: proacl IS NULL significa "privilegios por defecto", y
// el default de PostgreSQL para funciones INCLUYE EXECUTE para PUBLIC. O sea
// que una función recién creada sin GRANTs explícitos es ejecutable por
// cualquiera. acldefault() materializa ese default para poder verlo.
const perms = [];
const aclRows = await q(`
  SELECT n.nspname || '.' || p.proname || '(' ||
         pg_get_function_identity_arguments(p.oid) || ')' AS firma,
         a.grantee,
         COALESCE(gr.rolname, CASE WHEN a.grantee = 0 THEN 'PUBLIC' END) AS destino
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  -- El LATERAL va ANTES del join a pg_roles: si no, gr referencia "a" antes de
  -- que exista y Postgres tira "missing FROM-clause entry for table a".
  CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) AS a
  LEFT JOIN pg_roles gr ON gr.oid = a.grantee
  WHERE n.nspname = 'public'
    AND a.privilege_type = 'EXECUTE'
    AND (a.grantee = 0 OR gr.rolname IN ('anon','authenticated'))
  ORDER BY 1`);
for (const r of aclRows) {
  perms.push(`${r.firma}  →  ${r.destino}${r.destino === 'PUBLIC' ? '  (proacl por defecto)' : ''}`);
}

// No todas las funciones expuestas son iguales. uuid_generate_v4() o el helper
// de un trigger no mueven plata; credit_claim sí. La severidad ALTA se reserva
// para las que tocan saldos, que son las que el schema revokea explícitamente.
const SENSIBLES = [
  'credit_claim', 'register_referral', 'confirm_pending_referral',
  'expire_claims_and_cycles', 'daily_checkin', 'sell_wallet_asset',
  'open_trade', 'close_trade', 'set_trade_levels',
];
const sensiblesExpuestas = perms.filter((p) => SENSIBLES.some((f) => p.includes('.' + f + '(')));

report(
  sensiblesExpuestas.length ? 'ALTA' : 'MEDIA',
  sensiblesExpuestas.length
    ? 'RPC SENSIBLES con EXECUTE para PUBLIC/anon/authenticated'
    : 'Funciones con EXECUTE para PUBLIC (ninguna sensible)',
  sensiblesExpuestas.length ? sensiblesExpuestas : perms,
  sensiblesExpuestas.length
    ? 'CRÍTICO: la anon key de Supabase es pública por diseño. Cualquiera podría acreditarse.'
    : 'Esperado: utilidades del sistema (uuid-ossp, helpers de trigger). Las 9 que mueven plata están revokeadas.'
);

// ---------------------------------------------------------------------------
// 3. RLS
// ---------------------------------------------------------------------------
const rlsOff = await q(`
  SELECT c.relname
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity
  ORDER BY 1`);

report(rlsOff.length ? 'ALTA' : 'MEDIA', 'Tablas sin RLS', rlsOff.map((r) => r.relname),
  'El Worker usa service_role (que bypasea RLS), pero sin RLS cualquier otra anon key lee todo.');

const policies = await q(`
  SELECT schemaname || '.' || tablename || ' → ' || policyname AS p
  FROM pg_policies WHERE schemaname = 'public' ORDER BY 1`);

report('INFO', 'Policies de RLS definidas', policies.map((p) => p.p),
  'RLS sin policies = nadie entra salvo service_role. Es lo buscado acá.');

// ---------------------------------------------------------------------------
// 4. Permisos de tabla para anon/authenticated
// ---------------------------------------------------------------------------
const tableGrants = [];
for (const rol of ['anon', 'authenticated']) {
  // GROUP BY sobre la expresión concatenada revienta porque incluye un
  // agregado ("aggregate functions are not allowed in GROUP BY"). Se agrupa
  // por las columnas base y se concatena después.
  const rows = await q(`
    SELECT table_name,
           string_agg(DISTINCT privilege_type, ',' ORDER BY privilege_type) AS g
    FROM information_schema.role_table_grants
    WHERE grantee = '${rol}' AND table_schema = 'public'
    GROUP BY table_name ORDER BY table_name`);
  for (const r of rows) tableGrants.push(`public.${r.table_name} → ${r.g}  →  ${rol}`);
}

report(tableGrants.length ? 'ALTA' : 'MEDIA', 'Tablas con permisos para anon/authenticated', tableGrants,
  'Esperado: ninguno. Todo el acceso va por el Worker con service_role.');

// ---------------------------------------------------------------------------
// 5. ¿Puede anon/authenticated crear objetos? (precondición del secuestro)
// ---------------------------------------------------------------------------
const canCreate = await q(`
  SELECT r.rolname,
         has_database_privilege(r.rolname, current_database(), 'CREATE') AS create_db,
         has_schema_privilege(r.rolname, 'public', 'CREATE') AS create_schema
  FROM pg_roles r WHERE r.rolname IN ('anon','authenticated') ORDER BY 1`);

report(
  canCreate.some((r) => r.create_db || r.create_schema) ? 'ALTA' : 'MEDIA',
  'Roles no privilegiados que pueden crear objetos',
  canCreate.map((r) => `${r.rolname}: CREATE en BD=${r.create_db}, CREATE en public=${r.create_schema}`),
  'Si pueden crear en public, el search_path sin pinear es explotable de verdad.'
);

// ---------------------------------------------------------------------------
// 6. Triggers (código que corre sin que nadie lo llame)
// ---------------------------------------------------------------------------
const triggers = await q(`
  SELECT event_object_table || ' → ' || trigger_name || ' (' ||
         string_agg(DISTINCT event_manipulation, '/') || ')' AS t
  FROM information_schema.triggers
  WHERE trigger_schema = 'public'
  GROUP BY event_object_table, trigger_name ORDER BY 1`);

report('INFO', 'Triggers', triggers.map((t) => t.t),
  'Informativo: los triggers corren implícitamente y son un lugar fácil de esconder lógica.');

// ---------------------------------------------------------------------------
// 7. Extensiones
// ---------------------------------------------------------------------------
const exts = await q(`SELECT extname || ' ' || extversion AS e FROM pg_extension ORDER BY 1`);
report('INFO', 'Extensiones instaladas', exts.map((e) => e.e));

// ---------------------------------------------------------------------------
await c.end();
await db.stop();

console.log('='.repeat(60));
if (hallazgos.length === 0) {
  console.log('Sin hallazgos de severidad ALTA.');
} else {
  console.log(`HALLAZGOS DE SEVERIDAD ALTA: ${hallazgos.length}`);
  for (const h of hallazgos) console.log(`  - ${h}`);
}
process.exit(hallazgos.length === 0 ? 0 : 1);
