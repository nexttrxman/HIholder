# TronKeeper - Deploy en Cloudflare Pages

## Configuración EXACTA para Cloudflare Pages

### Build settings:
| Campo | Valor |
|-------|-------|
| Framework preset | `Create React App` |
| Build command | `yarn build` |
| Build output directory | `build` |
| Root directory | `frontend` |

### Environment variables (OBLIGATORIAS):
```
NPM_FLAGS=--legacy-peer-deps
NODE_VERSION=18
YARN_VERSION=1.22.22
REACT_APP_WORKER_URL=https://tu-worker.workers.dev
REACT_APP_TELEGRAM_BOT_URL=https://t.me/TU_BOT
REACT_APP_DEPOSIT_ADDRESS=TU_WALLET_TRON
```

### ⚠️ IMPORTANTE: Usar YARN, no NPM
Cloudflare detectará el `yarn.lock` y usará yarn automáticamente.

Si sigue fallando con npm, agrega esta variable:
```
NPM_FLAGS=--legacy-peer-deps
```

## Solución a errores comunes

### Error: ERESOLVE unable to resolve dependency tree
**Causa:** npm no puede resolver date-fns
**Solución:** Ya está arreglado. El archivo `.npmrc` tiene `legacy-peer-deps=true`

### Error: Module not found
**Causa:** Cloudflare usa npm por defecto
**Solución:** Asegúrate de que `yarn.lock` esté en el repo

## Verificar antes de pushear a GitHub

1. ✅ `yarn.lock` debe estar en el repo
2. ✅ `.npmrc` con `legacy-peer-deps=true`
3. ✅ `date-fns` versión `^3.6.0` (no 4.x)
4. ❌ NO incluir `node_modules/`
5. ❌ NO incluir `build/`

## Estructura del repo

```
tu-repo/
├── frontend/           ← Root directory en Cloudflare
│   ├── .npmrc          ← Importante
│   ├── yarn.lock       ← Importante
│   ├── package.json
│   ├── src/
│   └── public/
├── cloudflare-worker/
└── supabase/
```
