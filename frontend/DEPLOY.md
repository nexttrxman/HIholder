# TronKeeper - Deploy en Cloudflare Pages

## Configuración en Cloudflare Pages

### Build settings:
- **Framework preset:** Create React App
- **Build command:** `yarn build`
- **Build output directory:** `build`
- **Root directory:** `frontend` (si subes todo el repo)

### Environment variables (en Cloudflare Pages):
```
REACT_APP_WORKER_URL=https://tu-worker.workers.dev
REACT_APP_TELEGRAM_BOT_URL=https://t.me/TU_BOT
REACT_APP_DEPOSIT_ADDRESS=TU_WALLET_TRON
NODE_VERSION=18
```

### Node version:
Cloudflare Pages usa Node 12 por defecto. Agrega:
- Variable: `NODE_VERSION` = `18`

## Estructura de carpetas para GitHub

```
tu-repo/
├── frontend/          ← Sube solo esta carpeta a Pages
│   ├── src/
│   ├── public/
│   ├── package.json
│   └── ...
├── cloudflare-worker/
│   ├── worker.js
│   └── wrangler.toml
└── supabase/
    └── schema.sql
```

## Opción alternativa: subir solo frontend

Si prefieres subir solo el frontend:

1. Copia la carpeta `frontend` a un nuevo repo
2. En Cloudflare Pages:
   - Root directory: `/` (vacío o /)
   - Build command: `yarn build`
   - Output: `build`

## Verificar antes de subir

1. Eliminar `node_modules/` (está en .gitignore)
2. Eliminar `build/` (se genera en Cloudflare)
3. Verificar que `.env` NO esté en el repo (usa variables de Cloudflare)

## Troubleshooting

### Error: Module not found
- Verifica que `package.json` no tenga dependencias de URLs externas
- Asegúrate de usar `yarn` no `npm`

### Error: Node version
- Agrega `NODE_VERSION=18` en environment variables

### Build timeout
- Cloudflare Pages tiene límite de 20 minutos
- El build de este proyecto toma ~30 segundos
