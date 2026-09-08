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

---

## Trade Panel (v2.3)

El Trade tiene su **propia pestaña en el medio de la barra inferior**:
`Home · Missions · TRADE · Invite · Wallet` (`src/pages/Trade.jsx`).
No hay panel de trading ni en Home ni en Wallet; Home tampoco tiene los accesos
rápidos de Deposit/Withdraw (quedan dentro de Wallet).

### Nuevos endpoints del Worker

| Ruta | Body | Devuelve |
|------|------|----------|
| `POST /trade` | `{ initData, pair, amount, price }` | `{ ok, position, new_balance, mark_price }` |
| `POST /trade/close` | `{ initData, position_id, price }` | `{ ok, pnl, pnl_pct, credited, new_balance }` |
| `POST /positions` | `{ initData }` | `{ ok, positions, realized_pnl, unrealized_pnl, positions_value }` |
| `POST /trade/levels` | `{ initData, position_id, take_profit, stop_loss }` | `{ ok, take_profit, stop_loss }` |

- `pair` debe ser uno de `TRADE_CONFIG.ALLOWED_PAIRS` (`TONUSDT`, `BTCUSDT`, `ETHUSDT`,
  `TRXUSDT`, `DOGEUSDT`).
- El worker **ignora el precio del cliente** y usa el ticker público de Binance
  (`fetchMarkPrice`). Si Binance no responde, acepta el precio del chart dentro de un 2%
  de tolerancia (`isPriceWithinTolerance`).
- Fee simulado: `0.1%` por lado (`TRADE_CONFIG.FEE_RATE`).
- **Take Profit / Stop Loss**: opcionales en la orden (`take_profit`, `stop_loss`). El worker
  valida el bracket con `validateLevels` (TP arriba del entry, SL abajo) y lo guarda en la
  posición. El frontend monitorea los precios y cierra solo cuando se toca un nivel
  (`checkLevelTrigger`); el SL gana si un salto cruza ambos.
- Todo se descuenta del saldo interno de USDT mediante las RPC `open_trade` /
  `close_trade` (atómicas, en `supabase/schema.sql`).

### Migración de Supabase

Ejecutar la sección **"TRADE POSITIONS TABLE"** y siguientes de `supabase/schema.sql`:

1. `CREATE TABLE trade_positions`
2. `ALTER TABLE wallet_ledger` para permitir `trade_buy` / `trade_sell`
3. `CREATE FUNCTION open_trade(...)` y `close_trade(...)`

**v2.4 (Take Profit / Stop Loss)** — sección "ORDER LIMITS" del mismo archivo:

1. `ALTER TABLE trade_positions ADD COLUMN take_profit / stop_loss`
2. `DROP FUNCTION open_trade(TEXT, TEXT, DECIMAL, DECIMAL)` + nueva firma de 6 parámetros
3. `CREATE FUNCTION set_trade_levels(...)`

**v2.5 (claim no cobrado)** — requiere re-ejecutar la sección HOLD del schema:

Un claim que vence sin pagarse se **pierde** y el ciclo vuelve a 0 holds.
`GET /auth` marca el claim como `expired_unclaimed` y resetea
`hold_cycles.holds_completed` a 0. Antes el ciclo quedaba clavado en 3/3 y
`POST /hold` rechazaba para siempre hasta el reset de 8 h (regla en
`resolvePendingClaim`, `lib.js`). El mock de desarrollo y `WalletContext`
aplican la misma regla.

La regla ahora también vive en `expire_claims_and_cycles()` (el job de pg_cron
que corre cada minuto). Era necesario: `/auth` solo busca claims con
`status='pending'`, y el job los volteaba a `expired_unclaimed` sin tocar el
ciclo, así que en producción el job ganaba la carrera casi siempre y el usuario
quedaba en 3/3 sin claim hasta el fin de la ventana de 8 h — justo el fallo que
`resolvePendingClaim` intenta evitar. La función resetea el ciclo **antes** de
expirar el claim, y trae un `UPDATE` de reparación única para bases ya
desplegadas que hayan quedado trabadas.

También se corrigió el `EXCEPTION` del bloque que programa el job: sin
`invalid_schema_name` (3F000), ejecutar el schema sin pg_cron habilitado
abortaba todo el script en lugar de degradar en silencio.

**v2.6 (Daily Check-In)** — sección "DAILY CHECK-IN" de `supabase/schema.sql`:

1. `ALTER TABLE wallet_ledger` agrega `checkin_daily` / `checkin_weekly`
2. `CREATE TABLE checkins` (`UNIQUE(user_id, checkin_date)` = idempotencia)
3. `CREATE FUNCTION daily_checkin(p_user_id)` — acredita el premio diario y, al
   7mo día de la semana ISO, el bono semanal una sola vez

Endpoints nuevos: `POST /checkin` y `POST /checkin/status`.
Premios en `CHECKIN_CONFIG` (`cloudflare-worker/lib.js`, espejado en
`frontend/src/lib/checkin.js`): 0.05 USDT/día, 0.50 USDT a la semana.

**v2.6.1 (RLS y permisos de funciones)** — secciones "RLS" y "PERMISOS DE
FUNCIONES" al final de `supabase/schema.sql`. **Hay que re-ejecutarlas.**

Todo acceso a la base pasa por el Worker: valida el `initData` de Telegram con
HMAC-SHA256 en los 12 endpoints y usa la *service key*, que en Supabase tiene
`BYPASSRLS`. La Mini App no incluye `supabase-js` ni la *anon key*.

Dos agujeros que se cerraron:

1. **No había RLS en ninguna tabla.** Las tablas nuevas de Supabase quedan con
   RLS deshabilitado, así que la *anon key* —que es pública por diseño— daba
   lectura y escritura directa sobre `internal_wallets`. Ahora las 12 tablas
   tienen RLS habilitado **sin políticas**: `anon` y `authenticated` no ven ni
   modifican nada. Si algún día se conecta un cliente directo, hay que agregar
   políticas explícitas primero.
2. **`daily_checkin` era `SECURITY DEFINER`** y Postgres da `EXECUTE` a `PUBLIC`
   por defecto. La combinación era grave: la función corría como `postgres`, por
   encima del RLS, y cualquiera podía invocarla por
   `POST /rest/v1/rpc/daily_checkin` con cualquier `p_user_id` para acreditarse
   saldo sin pasar por Telegram ni por el Worker. Ahora es `SECURITY INVOKER` y
   las 6 RPC revocan `EXECUTE` de `PUBLIC`/`anon`/`authenticated`, dejándolo solo
   en `service_role`.

Verificado en `supabase/tests/schema.test.mjs` con roles reales: uno sin
`BYPASSRLS` (como `anon`) no ve filas, su `UPDATE` no afecta nada y recibe
`permission denied for function daily_checkin`; uno con `BYPASSRLS` (como
`service_role`) sigue viendo todo.

### Frontend

| Archivo | Rol |
|---------|-----|
| `src/services/market.js` | Klines/ticker de Binance + generador sintético de respaldo |
| `src/hooks/useMarketData.js` | Polling (6s) y auto-recuperación a datos reales |
| `src/lib/trade.js` | Espejo de la matemática del worker (validación, fee, PnL) |
| `src/contexts/TradeContext.jsx` | Posiciones, open/close, fallback a `localStorage` |
| `src/components/trade/CandleChart.jsx` | Chart de velas SVG propio (crosshair táctil + líneas TP/SL) |
| `src/components/trade/PairSelector.jsx` | Mini menú de mercados con precio y 24h |
| `src/components/trade/TradePanel.jsx` | Panel completo / compacto |

Sin `initData` de Telegram (navegador, preview) el panel opera contra el balance demo
persistido en `localStorage`, así que se puede probar el flujo completo sin backend.

### History → Wallet

La pestaña **History** desapareció de la barra inferior. Su contenido está en
**Wallet → Activity** (`WalletPage` recibe `initialSection`). La navegación inferior queda
en 5 tabs: Home, Missions, **Trade**, Invite, Wallet.

### Tests

```bash
cd frontend && npx vitest run          # 21 tests (nav, compra/cierre, TP-SL, picker, maths)
cd cloudflare-worker && node --test tests/lib.test.mjs tests/trade.test.mjs   # 51 tests
```
