#!/usr/bin/env bash
# ============================================================
# Restaura un backup al VPS.
# Uso: ./scripts/restore.sh backups/manual-20260101-120000.dump
#      ./scripts/restore.sh /tmp/supabase-data-xxxx.sql
#
# ATENCIÓN: vacía las tablas de negocio antes de cargar.
# ============================================================
set -euo pipefail
cd "$(dirname "$0")/.."

FILE="${1:?Uso: ./scripts/restore.sh <archivo .dump o .sql>}"
[ -f "$FILE" ] || { echo "No existe: $FILE"; exit 1; }

TABLES="users hold_cycles holds claims claim_payments internal_wallets wallet_ledger referral_pool referrals transactions"
DB="${POSTGRES_DB:-trxkeeper}"

read -p "Esto VACÍA las tablas y carga $FILE. Escribe SI para continuar: " CONFIRM
[ "$CONFIRM" = "SI" ] || { echo "Cancelado."; exit 1; }

docker compose exec -T postgres psql -U postgres -d "$DB" \
  -c "TRUNCATE $TABLES RESTART IDENTITY CASCADE;"

if [[ "$FILE" == *.dump ]]; then
  NAME="manual-restore-$(date +%Y%m%d-%H%M%S).dump"
  cp "$FILE" "./backups/$NAME"
  docker compose exec -T postgres pg_restore -U postgres -d "$DB" --data-only "/backups/$NAME"
else
  cat "$FILE" | docker compose exec -T postgres psql -U postgres -d "$DB" -v ON_ERROR_STOP=1 -q
fi

echo "OK: restauración completa. Conteos:"
for t in $TABLES; do
  COUNT=$(docker compose exec -T postgres psql -U postgres -d "$DB" -tA -c "SELECT COUNT(*) FROM $t;")
  printf "  %-18s %s filas\n" "$t" "$COUNT"
done
