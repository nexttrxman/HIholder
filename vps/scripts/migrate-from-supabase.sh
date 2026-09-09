#!/usr/bin/env bash
# ============================================================
# Migra los DATOS de Supabase al VPS.
#
# Requisito: stack levantado (docker compose up -d) y .env listo.
#
# Uso:
#   export SUPABASE_DB_URL='postgres://postgres:TU_PASSWORD@db.xxxxx.supabase.co:5432/postgres'
#   ./scripts/migrate-from-supabase.sh
#
# Dónde conseguir SUPABASE_DB_URL:
#   Supabase Dashboard -> Project Settings -> Database
#   -> Connection string -> URI (usa la "Direct connection").
#   Si falla por IPv6, usa la del "Connection pooling" en
#   modo Session (puerto 5432, usuario postgres.PROJECTREF).
#
# IMPORTANTE: haz la migración FINAL en ventana de mantenimiento
# (ver GUIA-VPS.md paso 7): usuarios creados en Supabase
# DESPUÉS del dump perderían sus balances al re-crearse en el VPS.
# ============================================================
set -euo pipefail
cd "$(dirname "$0")/.."

: "${SUPABASE_DB_URL:?Exporta SUPABASE_DB_URL primero. Ver cabecera del script.}"

TABLES=(users hold_cycles holds claims claim_payments internal_wallets wallet_ledger referral_pool referrals transactions)
DB="${POSTGRES_DB:-trxkeeper}"
DUMP_FILE="/tmp/supabase-data-$(date +%Y%m%d-%H%M%S).sql"

echo "============================================================"
echo " 1/4 Vaciando tablas destino en el VPS..."
echo "============================================================"
docker compose exec -T postgres psql -U postgres -d "$DB" \
  -c "TRUNCATE ${TABLES[*]} RESTART IDENTITY CASCADE;"

echo
echo "============================================================"
echo " 2/4 Dump data-only desde Supabase..."
echo "============================================================"
DUMP_ARGS=(--data-only --no-owner --no-privileges --disable-triggers --inserts)
for t in "${TABLES[@]}"; do
  DUMP_ARGS+=(-t "public.$t")
done

if command -v pg_dump >/dev/null 2>&1; then
  echo "Usando pg_dump del host..."
  pg_dump "$SUPABASE_DB_URL" "${DUMP_ARGS[@]}" > "$DUMP_FILE"
else
  echo "Usando pg_dump del contenedor..."
  docker compose run --rm -T -e SUPABASE_DB_URL="$SUPABASE_DB_URL" postgres \
    pg_dump "$SUPABASE_DB_URL" "${DUMP_ARGS[@]}" > "$DUMP_FILE"
fi
echo "Dump guardado en $DUMP_FILE ($(du -h "$DUMP_FILE" | cut -f1))"

echo
echo "============================================================"
echo " 3/4 Restaurando en el VPS..."
echo "============================================================"
cat "$DUMP_FILE" | docker compose exec -T postgres \
  psql -U postgres -d "$DB" -v ON_ERROR_STOP=1 -q

echo
echo "============================================================"
echo " 4/4 Verificación: conteo de filas por tabla"
echo "============================================================"
for t in "${TABLES[@]}"; do
  COUNT=$(docker compose exec -T postgres psql -U postgres -d "$DB" -tA -c "SELECT COUNT(*) FROM $t;")
  printf "  %-18s %s filas\n" "$t" "$COUNT"
done

echo
echo "OK. Compara estos conteos con Supabase:"
echo "  (Supabase Dashboard -> Table Editor, o SQL: SELECT COUNT(*) FROM <tabla>;)"
