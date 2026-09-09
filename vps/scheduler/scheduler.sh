#!/bin/sh
# ============================================================
# scheduler.sh - 2 tareas en segundo plano:
#   1. Cada 60s: llama a /rpc/expire_claims_and_cycles
#      (reemplaza al pg_cron de Supabase)
#   2. Cada 24h: pg_dump completo a /backups (retención 7 días)
# ============================================================
set -eu

: "${POSTGREST_URL:?falta POSTGREST_URL}"
: "${SERVICE_ROLE_KEY:?falta SERVICE_ROLE_KEY}"
: "${POSTGRES_PASSWORD:?falta POSTGRES_PASSWORD}"
: "${POSTGRES_DB:=trxkeeper}"

BACKUP_DIR=/backups
mkdir -p "$BACKUP_DIR"

expire_loop() {
  while true; do
    CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
      "$POSTGREST_URL/rpc/expire_claims_and_cycles" \
      -H "apikey: $SERVICE_ROLE_KEY" \
      -H "Authorization: Bearer $SERVICE_ROLE_KEY" \
      -H "Content-Type: application/json" \
      -d '{}' || echo "000")
    echo "$(date -u +%FT%TZ) expire_claims -> HTTP $CODE"
    sleep 60
  done
}

backup_loop() {
  while true; do
    TS=$(date -u +%Y%m%d-%H%M%S)
    echo "$(date -u +%FT%TZ) backup iniciado: trxkeeper-$TS.dump"
    if PGPASSWORD="$POSTGRES_PASSWORD" pg_dump -h postgres -U postgres \
        -d "$POSTGRES_DB" -F c -f "$BACKUP_DIR/trxkeeper-$TS.dump"; then
      echo "$(date -u +%FT%TZ) backup OK: trxkeeper-$TS.dump"
    else
      echo "$(date -u +%FT%TZ) backup FALLO!"
    fi
    # Retención: borra backups de más de 7 días
    find "$BACKUP_DIR" -name 'trxkeeper-*.dump' -mtime +7 -delete
    find "$BACKUP_DIR" -name 'manual-*.dump' -mtime +7 -delete
    sleep 86400
  done
}

echo "scheduler iniciado (DB=$POSTGRES_DB)"
expire_loop &
backup_loop &
wait
