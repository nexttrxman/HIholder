#!/usr/bin/env bash
# Backup manual inmediato a ./backups/manual-<fecha>.dump
# (además del automático diario del scheduler)
set -euo pipefail
cd "$(dirname "$0")/.."

DB="${POSTGRES_DB:-trxkeeper}"
FILE="/backups/manual-$(date +%Y%m%d-%H%M%S).dump"

docker compose exec -T postgres pg_dump -U postgres -d "$DB" -F c -f "$FILE"
echo "OK: backup creado en ./backups/$(basename "$FILE")"
ls -lh ./backups/ | tail -5
