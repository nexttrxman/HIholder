# TronKeeper - Guía de Integración

## Arquitectura

```
┌─────────────────────┐     ┌─────────────────────┐     ┌─────────────────────┐
│  Telegram Mini App  │────▶│  Cloudflare Worker  │────▶│      Supabase       │
│  (React Frontend)   │     │  (API + Validation) │     │   (PostgreSQL DB)   │
└─────────────────────┘     └─────────────────────┘     └─────────────────────┘
        │                            │
        │ initData                   │ BOT_TOKEN (validate)
        │                            │ SUPA_URL
        └────────────────────────────│ SUPA_SERVICE_KEY
```

## Archivos Modificados

| Archivo | Cambio |
|---------|--------|
| `/app/frontend/src/services/api.js` | Conectado a endpoints reales, eliminados mocks |
| `/app/cloudflare-worker/worker.js` | Worker completo con todas las rutas |
| `/app/cloudflare-worker/wrangler.toml` | Config de Wrangler |
| `/app/supabase/schema.sql` | Schema completo de la DB |

## Setup Paso a Paso

### 1. Supabase

1. Ve a [supabase.com](https://supabase.com) y crea un proyecto
2. Ve a **SQL Editor**
3. Copia y ejecuta todo el contenido de `/app/supabase/schema.sql`
4. Ve a **Settings → API** y copia:
   - `Project URL` → será tu `SUPA_URL`
   - `service_role key` → será tu `SUPA_SERVICE_KEY`

### 2. Cloudflare Worker

```bash
cd /app/cloudflare-worker

# Instalar wrangler
npm install -g wrangler

# Login a Cloudflare
wrangler login

# Configurar secrets
wrangler secret put BOT_TOKEN
# Pega tu Telegram Bot Token

wrangler secret put SUPA_URL
# Pega tu Supabase Project URL (ej: https://xxxxx.supabase.co)

wrangler secret put SUPA_SERVICE_KEY
# Pega tu Supabase service_role key

# Deploy
wrangler deploy
```

### 3. Frontend

Actualiza `/app/frontend/.env`:

```env
REACT_APP_WORKER_URL=https://tu-worker.tu-subdomain.workers.dev
REACT_APP_TELEGRAM_BOT_URL=https://t.me/TU_BOT
REACT_APP_DEPOSIT_ADDRESS=TU_WALLET_ADDRESS
```

Deploy a Cloudflare Pages:

```bash
cd /app/frontend
yarn build

# Sube el folder 'build' a Cloudflare Pages
# O usa wrangler:
npx wrangler pages deploy build --project-name=tronkeeper
```

## Variables de Entorno

### Cloudflare Worker (Secrets)

| Variable | Descripción |
|----------|-------------|
| `BOT_TOKEN` | Token del bot de Telegram (de @BotFather) |
| `SUPA_URL` | URL de tu proyecto Supabase |
| `SUPA_SERVICE_KEY` | Service role key de Supabase |

### Frontend (.env)

| Variable | Descripción |
|----------|-------------|
| `REACT_APP_WORKER_URL` | URL del Cloudflare Worker |
| `REACT_APP_TELEGRAM_BOT_URL` | URL del bot (https://t.me/TU_BOT) |
| `REACT_APP_DEPOSIT_ADDRESS` | Wallet TRON para depósitos |

## Endpoints del Worker

### POST /auth
Autentica usuario con initData de Telegram.

**Request:**
```json
{ "initData": "telegram_init_data_string" }
```

**Response:**
```json
{
  "ok": true,
  "user": {
    "uid": "TK123456",
    "usdt_balance": 12.50,
    "trx_balance": 24.50,
    "total_earned": 12.50,
    "wins": 45,
    "holds_count": 2,
    "holds_reset_at": "2024-01-15T10:00:00Z",
    "total_refs": 8,
    "trx_refs": 16.00
  }
}
```

### POST /claim
Reclama reward de Hold to Earn.

**Request:**
```json
{ "initData": "...", "prize": 0.05 }
```

**Response:**
```json
{
  "ok": true,
  "total": 12.55,
  "wins": 46,
  "holdsCount": 3
}
```

### POST /transactions
Obtiene historial de transacciones.

**Request:**
```json
{ "initData": "...", "limit": 50, "offset": 0, "type": "all" }
```

**Response:**
```json
{
  "ok": true,
  "transactions": [
    {
      "id": "uuid",
      "type": "reward",
      "asset": "USDT",
      "amount": 0.05,
      "status": "confirmed",
      "timestamp": 1705312800000,
      "description": "Hold to Earn reward"
    }
  ]
}
```

### POST /withdraw
Solicita retiro.

**Request:**
```json
{
  "initData": "...",
  "asset": "USDT",
  "amount": 10.00,
  "toAddress": "TXyz123..."
}
```

**Response:**
```json
{
  "ok": true,
  "status": "pending",
  "txId": "uuid",
  "message": "Withdrawal request submitted."
}
```

### POST /referrals
Obtiene stats del pool de referidos.

**Request:**
```json
{ "initData": "..." }
```

**Response:**
```json
{
  "ok": true,
  "pool": {
    "total_pool": 50000,
    "remaining": 38450,
    "your_earnings": 16.00
  },
  "referrals": [
    { "id": "uuid", "referred_user": "john", "reward": 2, "date": "2024-01-15" }
  ]
}
```

## Cómo Probar

### 1. Health Check del Worker
```bash
curl https://tu-worker.workers.dev/health
# Debe responder: {"ok":true,"service":"TronKeeper API","version":"1.0.0"}
```

### 2. Probar desde Telegram
1. Abre tu bot en Telegram
2. Inicia la Mini App
3. La app debe cargar y mostrar tu balance

### 3. Probar endpoints manualmente (con initData real)
```bash
# Necesitas un initData válido de Telegram
curl -X POST https://tu-worker.workers.dev/auth \
  -H "Content-Type: application/json" \
  -d '{"initData":"query_id=xxx&user=...&hash=..."}'
```

## Tablas de Supabase

| Tabla | Descripción |
|-------|-------------|
| `users` | Usuarios (telegram_id, balances, stats) |
| `transactions` | Historial de transacciones |
| `withdrawals` | Solicitudes de retiro |
| `referrals` | Relaciones de referidos |
| `referral_pool` | Pool global de 50,000 TRX |
| `claims` | Historial de claims Hold to Earn |
| `missions` | Definición de misiones |
| `user_missions` | Progreso de misiones por usuario |
| `deposits` | Depósitos entrantes |

## Flujo de Autenticación

1. Usuario abre Mini App en Telegram
2. Telegram inyecta `window.Telegram.WebApp` con `initData`
3. Frontend envía `initData` al Worker en `/auth`
4. Worker valida firma HMAC-SHA256 con `BOT_TOKEN`
5. Si válido, busca/crea usuario en Supabase
6. Retorna datos del usuario al frontend

## Notas Importantes

- **NUNCA** expongas `SUPA_SERVICE_KEY` en el frontend
- El frontend solo conoce la URL del Worker
- Toda la lógica de DB está en el Worker
- Los retiros quedan en estado `pending` para procesamiento manual
- El pool de referidos se inicializa con 50,000 TRX
