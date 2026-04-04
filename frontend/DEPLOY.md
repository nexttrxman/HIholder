# TronKeeper - Deploy en Cloudflare Pages (Vite)

## Configuración para Cloudflare Pages

| Campo | Valor |
|-------|-------|
| Framework preset | `None` |
| Build command | `npm run build` |
| Build output directory | `dist` |
| Root directory | `frontend` |

## Environment variables en Cloudflare:

```
VITE_WORKER_URL=https://tu-worker.workers.dev
VITE_TELEGRAM_BOT_URL=https://t.me/TU_BOT
VITE_DEPOSIT_ADDRESS=TU_WALLET_TRON
```

## Notas

- Vite usa `import.meta.env.VITE_*` en lugar de `process.env.REACT_APP_*`
- Build output es `dist/` (no `build/`)
- Build toma ~2 segundos vs ~30 segundos con CRA
