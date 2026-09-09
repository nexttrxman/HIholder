#!/bin/bash
# ============================================================
# 00-roles.sh - Roles para PostgREST ( réplica del modelo Supabase )
#
#   authenticator : usuario LOGIN que usa PostgREST para conectar.
#                   Su password viene de $AUTHENTICATOR_PASSWORD (.env).
#   anon          : rol sin permisos (peticiones sin JWT -> denegadas).
#   service_role  : rol con acceso total (el Worker usa este JWT).
#
# Se ejecuta UNA sola vez, al crear el volumen pgdata.
# ============================================================
set -euo pipefail

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<EOSQL
CREATE ROLE anon NOLOGIN;
CREATE ROLE service_role NOLOGIN;
CREATE ROLE authenticator LOGIN PASSWORD '${AUTHENTICATOR_PASSWORD}';

-- PostgREST necesita cambiar a estos roles tras validar el JWT
GRANT anon, service_role TO authenticator;
EOSQL

echo "OK: roles anon / service_role / authenticator creados."
