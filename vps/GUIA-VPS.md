# Guía: migrar la DB de Supabase a un VPS propio (arquitectura híbrida)

Esta guía te lleva de cero a producción: alquilar el VPS, montar PostgreSQL +
API REST compatible con Supabase, migrar tus datos y apuntar el Worker al VPS.

> **Idea clave:** tu Worker de Cloudflare habla con Supabase usando una API REST
> estándar (PostgREST: `/rest/v1/<tabla>` y `/rest/v1/rpc/<funcion>`). Vamos a
> replicar **ese mismo API** en tu VPS, así que **no hay que cambiar ni una
> línea de código**: solo actualizar 2 secrets del Worker.

## Arquitectura final

```
Telegram Mini App (React)
        │  HTTPS
        ▼
Cloudflare Worker (SIN CAMBIOS de código)
  │  solo cambian 2 secrets:
  │   SUPA_URL         -> https://db.tudominio.com
  │   SUPA_SERVICE_KEY -> tu nuevo JWT
  ▼
┌──────────────── VPS (Hetzner, ~20 €/mes, costo fijo) ────────────────┐
│  Caddy (HTTPS auto) -> PostgREST (API /rest/v1/*) -> PostgreSQL 16   │
│  scheduler: expira claims cada minuto + backup diario a ./backups    │
└──────────────────────────────────────────────────────────────────────┘
```

---

## 0. Proveedor recomendado: Hetzner

| Proveedor | Plan equivalente (4 vCPU / 16 GB / NVMe) | Precio aprox. | Opinión |
|---|---|---|---|
| **Hetzner CCX23** ✅ | 4 vCPU, 16 GB RAM, 160 GB NVMe | **~19,50 €/mes** | Mejor precio/rendimiento. NVMe real, red excelente, snapshots baratos. |
| Contabo VPS M/L | 6-8 vCPU, 16-24 GB, SSD | ~9-14 €/mes | Más barato pero CPU compartida/saturada y discos más lentos. Riesgoso para una DB con picos. |
| DigitalOcean | 4 vCPU, 16 GB, 200 GB | ~96 $/mes | Fácil de usar pero 4-5x más caro por lo mismo. |

**Mi recomendación:** Hetzner **CCX23** para empezar (sobra para cientos de miles
de usuarios registrados). Si el crecimiento es agresivo, **CCX33** (8 vCPU /
32 GB, ~35 €/mes). Escalar después es un resize desde el panel.

**Región:** elige la más cercana a la mayoría de tus usuarios (cada request del
Worker viaja al VPS):
- Usuarios en LatAm / Europa → **Falkenstein** (fsn1) o Núremberg.
- Usuarios en Asia → **Singapur** (sin).

### Comparativa de costos

| | Supabase Pro | VPS propio (Hetzner CCX23) |
|---|---|---|
| Base | 25 $/mes | ~19,50 €/mes |
| Usuarios extra / MAU | de pago por tramos | **ilimitados, 0 €** |
| Egress extra | de pago | 20 TB incluidos |
| Backups automáticos | de pago (PITR) | incluidos (diarios + snapshot) |
| **Total estimado** | crece con usuarios | **fijo ~20 €/mes** |

### Nota sobre 2 millones de usuarios

2M de usuarios *registrados* caben sin problema en un solo VPS (la tabla
`users` ocuparía ~1-2 GB con índices). Lo que escala el costo no es el registro
sino la **actividad diaria**: `holds`, `claims` y `wallet_ledger` crecen por uso.
Este stack está preparado para eso:

1. PostgreSQL tuneado para NVMe + pool de 25 conexiones en PostgREST
   (PostgREST multiplexa miles de requests HTTP sobre ese pool).
2. Script de retención mensual (`scripts/retention.sql`) para purgar ciclos
   viejos.
3. Camino de escalado claro (ver Paso 11): más RAM/CPU con un resize, réplicas
   de lectura después, y PostgREST escala horizontal sin estado.

Empieza con CCX23 + monitoreo de disco/RAM y sube a CCX33 cuando el uso
sostenido de RAM supere el 70%.

---

## 1. Requisitos previos

- [ ] Cuenta en [hetzner.com/cloud](https://www.hetzner.com/cloud).
- [ ] Un dominio (ya tienes): usarás el subdominio `db.tudominio.com`.
- [ ] Acceso a tu proyecto Supabase (para el connection string y verificar conteos).
- [ ] `wrangler` instalado y logueado (ya lo usaste para el Worker).
- [ ] Una clave SSH en tu PC (`~/.ssh/id_ed25519.pub`). Si no tienes:
  `ssh-keygen -t ed25519`.

---

## 2. Crear el VPS en Hetzner (10 min)

1. Entra a **Hetzner Cloud Console → New Project** (ej: `tronkeeper`).
2. **Add Server:**
   - Location: Falkenstein (o Singapur, ver arriba).
   - Image: **Ubuntu 24.04**.
   - Type: **Shared x86 → CCX23** (4 vCPU / 16 GB).
   - Networking: IPv4 + IPv6 activados.
   - SSH keys: añade tu clave pública.
   - Backups: ✅ actívalos (+20%, snapshots automáticos diarios).
3. En **Firewalls → Create**: permite entrante `22/tcp` (tu IP mejor que
   `0.0.0.0/0` si tienes IP fija), `80/tcp` y `443/tcp` desde `0.0.0.0/0` +
   `::/0`. Asigna el firewall al servidor.
4. Anota la **IPv4** del servidor (ej: `65.21.200.10`).

---

## 3. DNS: `db.tudominio.com` → IP del VPS

En tu proveedor DNS (recomendado: Cloudflare):

| Tipo | Nombre | Valor | Proxy |
|---|---|---|---|
| A | `db` | `65.21.200.10` (tu IP) | 🟠 Proxied (recomendado: anti-DDoS + WAF gratis) |
| AAAA | `db` | `2a01:...` (tu IPv6) | 🟠 Proxied |

> Con el proxy naranja de Cloudflare, Caddy igual obtiene su certificado
> Let's Encrypt sin problema (el challenge HTTP pasa a través).

Verifica propagación desde tu PC:

```bash
nslookup db.tudominio.com
```

---

## 4. Preparar el servidor (20 min)

Conéctate:

```bash
ssh root@65.21.200.10   # tu IP
```

Ejecuta (copia y pega bloque por bloque):

```bash
# --- Actualizaciones + herramientas ---
apt-get update && apt-get upgrade -y
apt-get install -y ca-certificates curl gnupg ufw fail2ban

# --- Docker oficial ---
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
  https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  > /etc/apt/sources.list.d/docker.list
apt-get update && apt-get install -y docker-ce docker-ce-cli containerd.io \
  docker-buildx-plugin docker-compose-plugin postgresql-client
docker compose version   # debe mostrar v2.x

# --- Firewall del servidor ---
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
ufw status

# --- SSH solo con clave (pega TU clave pública) ---
mkdir -p ~/.ssh && chmod 700 ~/.ssh
echo 'PEGA_AQUI_TU_id_ed25519.pub' >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys
sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config
systemctl reload ssh
```

> ⚠️ No cierres esta sesión SSH hasta probar en OTRA terminal que puedes entrar
> sin contraseña. Si algo falla, la sesión abierta te salva.

---

## 5. Subir el proyecto al VPS

```bash
# En el VPS:
apt-get install -y git
git clone https://github.com/nexttrxman/HIholder.git
cd HIholder/vps
```

(Si el repo es privado, usa una deploy key o `gh auth login`.)

---

## 6. Generar secretos y configurar `.env`

```bash
cd ~/HIholder/vps
cp .env.example .env

# 1. Passwords (hex, seguros para URLs y SQL)
openssl rand -hex 32   # -> POSTGRES_PASSWORD
openssl rand -hex 32   # -> AUTHENTICATOR_PASSWORD (distinto del anterior)

# 2. JWT_SECRET + SERVICE_ROLE_KEY
python3 scripts/generate-jwt.py
```

Edita `.env` y completa los 4 valores + tu dominio:

```bash
nano .env
# POSTGRES_PASSWORD=...
# AUTHENTICATOR_PASSWORD=...
# JWT_SECRET=...
# SERVICE_ROLE_KEY=...
# DB_DOMAIN=db.tudominio.com
```

> Guarda una copia de estos secretos en tu gestor de contraseñas.
> El `SERVICE_ROLE_KEY` lo necesitarás también para el Worker (paso 8).

---

## 7. Levantar el stack y verificar

```bash
cd ~/HIholder/vps
docker compose up -d --build
sleep 15
docker compose ps
docker compose logs --tail=30 postgres
```

Verificación end-to-end del API (desde el VPS; reemplaza con tus valores):

```bash
export DB_DOMAIN='db.tudominio.com'
export KEY='TU_SERVICE_ROLE_KEY'

# 1. HTTPS + PostgREST responden (debe devolver [] o datos, NO 401)
curl -s "https://$DB_DOMAIN/rest/v1/users?select=telegram_id&limit=1" \
  -H "apikey: $KEY" -H "Authorization: Bearer $KEY"

# 2. Sin JWT debe FALLAR (401/403) -> seguridad OK
curl -s -o /dev/null -w "%{http_code}\n" "https://$DB_DOMAIN/rest/v1/users?select=telegram_id&limit=1"

# 3. RPC de expiración (debe devolver 204 = éxito sin contenido)
curl -s -o /dev/null -w "%{http_code}\n" -X POST \
  "https://$DB_DOMAIN/rest/v1/rpc/expire_claims_and_cycles" \
  -H "apikey: $KEY" -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" -d '{}'
```

Si (1) devuelve JSON y (2) devuelve 401/403 y (3) devuelve 204: **el stack funciona**.

Mira también que el scheduler esté expirando cada minuto:

```bash
docker compose logs --tail=5 scheduler
# ... expire_claims -> HTTP 204
```

---

## 8. Migrar los datos de Supabase (ventana de mantenimiento)

### 8.1 Consigue el connection string

Supabase Dashboard → **Project Settings → Database → Connection string → URI**:

```
postgres://postgres:TU_DB_PASSWORD@db.xxxxx.supabase.co:5432/postgres
```

> La contraseña es la del proyecto (no tu login). Si la perdiste, usa
> **Reset database password** en esa misma pantalla.
> Si el dump falla por red/IPv6, usa la URI de **Connection pooling → Session
> mode** (puerto 5432, usuario `postgres.PROJECTREF`), que va por IPv4.

### 8.2 Ventana de mantenimiento (importante)

Anuncia ~15-30 min de mantenimiento del bot. ¿Por qué? Usuarios creados en
Supabase **después** del dump se re-crearían en el VPS con balance 0 al hacer
`/auth`. Para evitar cualquier pérdida de balances:

1. Dump + restore (este paso).
2. Cambiar secrets del Worker (paso 9) inmediatamente después.
3. Verificar y reabrir.

### 8.3 Ejecutar la migración

```bash
cd ~/HIholder/vps
export SUPABASE_DB_URL='postgres://postgres:XXX@db.xxxxx.supabase.co:5432/postgres'
./scripts/migrate-from-supabase.sh
```

El script: vacía el VPS → dump data-only de Supabase → restaura → muestra
conteos por tabla. **Compara los conteos** con Supabase
(`SELECT COUNT(*) FROM users;` etc. en el SQL Editor). Deben coincidir.

---

## 9. Apuntar el Worker al VPS (2 min, cero código)

Desde tu PC (donde tengas `wrangler`):

```bash
cd cloudflare-worker

# Nuevo URL del API de datos
echo 'https://db.tudominio.com' | wrangler secret put SUPA_URL

# Nuevo JWT service_role (el SERVICE_ROLE_KEY del .env del VPS)
echo 'TU_SERVICE_ROLE_KEY' | wrangler secret put SUPA_SERVICE_KEY

# Re-deploy para aplicar (y por seguridad, confirma versión)
wrangler deploy

# Salud del Worker (sigue igual)
curl https://tu-worker.workers.dev/health
```

> Los nombres `SUPA_URL` / `SUPA_SERVICE_KEY` se mantienen a propósito: el
> código del Worker no cambia. Por dentro ahora apuntan a tu VPS.

---

## 10. Pruebas end-to-end (checklist)

- [ ] Abrir el bot en Telegram → la Mini App carga y muestra tu balance real.
- [ ] Hacer 1 Hold → se registra (mira el contador).
- [ ] Completar 3 holds → se genera el claim con `claim_id`.
- [ ] Pagar el fee TON → `/verify-payment` acredita el USDT.
- [ ] Revisar Historial y Referidos en la app.
- [ ] En el VPS, ver logs sin errores:
  `docker compose logs --tail=50 postgrest caddy scheduler`
- [ ] Esperar 24h y comprobar que existe un backup en `./backups/`.

**Mantén Supabase activo 1-2 semanas** como red de seguridad (plan gratis
suficiente si pausas el proyecto después, o déjalo hasta confirmar todo).

### Rollback (si algo sale mal)

```bash
# Volver a Supabase en 1 minuto: restaura los 2 secrets viejos
echo 'https://xxxxx.supabase.co' | wrangler secret put SUPA_URL
echo 'TU_SUPABASE_SERVICE_ROLE_KEY' | wrangler secret put SUPA_SERVICE_KEY
wrangler deploy
```

---

## 11. Operación y mantenimiento

### Backups: regla 3-2-1 simplificada

1. **Automático diario** en el VPS: `./backups/trxkeeper-<fecha>.dump`
   (retención 7 días, lo hace el scheduler).
2. **Snapshot de Hetzner**: activado en el paso 2 (restaura todo el disco).
3. **Copia externa semanal** (recomendado): descarga un backup a tu PC o a un
   Storage Box:
   ```bash
   scp root@TU_VPS:~/HIholder/vps/backups/trxkeeper-*.dump ./mis-backups/
   ```

Backup manual en cualquier momento: `./scripts/backup.sh`
Restaurar: `./scripts/restore.sh backups/<archivo>.dump`

### Limpieza mensual (importante con muchos usuarios)

```bash
cat scripts/retention.sql | docker compose exec -T postgres psql -U postgres -d trxkeeper
```
Borra holds/claims/ciclos cerrados de más de 180 días. No toca balances ni
historial financiero.

### Actualizar el sistema (mensual)

```bash
apt-get update && apt-get upgrade -y
cd ~/HIholder && git pull
cd vps && docker compose pull && docker compose up -d
docker image prune -f
```

### Monitoreo mínimo

```bash
docker compose ps                       # estado
docker compose logs -f --tail=100       # logs en vivo
df -h                                   # disco (alerta si > 75%)
free -h                                 # RAM
docker stats --no-stream                # CPU/RAM por contenedor
```

Queries lentas (>1s) quedan en el log de Postgres:
```bash
docker compose logs postgres | grep "duration:"
```

Opcional (recomendado): instala **Uptime Kuma** en el mismo VPS para alertas por
Telegram si `https://db.tudominio.com` cae:
```bash
docker run -d --restart=always -p 127.0.0.1:3001:3001 --name uptime-kuma louislam/uptime-kuma:1
# + túnel SSH para verlo: ssh -L 3001:localhost:3001 root@TU_VPS
```

### Cuándo escalar (camino para 2M+)

| Señal | Acción |
|---|---|
| RAM sostenida > 70% | Resize a CCX33 (panel Hetzner, 5 min downtime) |
| Disco > 70% | Resize de disco + `retention.sql` |
| CPU > 70% en picos | CCX33/CCX43, o réplica de lectura para `/transactions` y `/referrals` |
| Necesitas alta disponibilidad | 2º VPS + réplica streaming + PgBouncer |

---

## 12. Troubleshooting

| Síntoma | Causa probable | Solución |
|---|---|---|
| `curl https://db...` → 000/timeout | DNS no propagado o firewall | `nslookup db...`; revisa firewall Hetzner + `ufw status` |
| `401 Unauthorized` con KEY | JWT mal copiado / JWT_SECRET con espacios | Regenera con `generate-jwt.py`, sin saltos de línea en `.env`; `docker compose up -d postgrest` |
| PostgREST log: `password authentication failed` | AUTHENTICATOR_PASSWORD distinto al del init | ⚠️ El init solo corre la 1ª vez: si cambiaste el password después, entra a Postgres y haz `ALTER ROLE authenticator PASSWORD 'nuevo'` |
| `curl` al Worker → error DB | Secrets viejos en Worker | Repite paso 9 y `wrangler deploy` |
| `migrate` falla: `could not translate host` | IPv6 Supabase desde Docker | Usa la URI del pooler Session mode (IPv4), o instala `postgresql-client` y corre el dump desde el host |
| Disco creciendo rápido | Logs o ledger | `docker system df`; logs ya rotan a 30 MB/contenedor; ejecuta `retention.sql` |
| Contenedor `scheduler` reiniciando | Falta SERVICE_ROLE_KEY en `.env` | `docker compose logs scheduler`; completa `.env` y `up -d` |

### Reset total (empezar de cero, ¡borra TODO!)

```bash
docker compose down -v   # borra contenedores Y el volumen pgdata
rm -f backups/*.dump
docker compose up -d --build
```

---

## 13. Checklist de seguridad final

- [ ] `.env` con secretos únicos (nunca el ejemplo) y **fuera de git** (ya está en `.gitignore`? verifica).
- [ ] Postgres solo en `127.0.0.1:5432` (ver `docker compose ps` / `ss -tlnp`).
- [ ] SSH solo con clave (`PasswordAuthentication no`).
- [ ] UFW activo + firewall de Hetzner con 22/80/443.
- [ ] fail2ban corriendo (`systemctl status fail2ban`).
- [ ] Backups: diario local ✅ + snapshot Hetzner ✅ + copia externa ☐.
- [ ] Supabase en pausa/eliminado solo DESPUÉS de 1-2 semanas estables.

¡Listo! Costo fijo ~20 €/mes, usuarios ilimitados. 🚀
