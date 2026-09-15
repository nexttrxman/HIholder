import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { buildManifest, DEV_APP_URL, PROD_APP_URL } from './tonconnect.manifest.js'

// Sirve el manifiesto con el origen real de la petición. Detrás del proxy del
// preview el esquema llega en x-forwarded-proto, no en la conexión local.
function serveManifest(req, res, appUrl, { preferHost = false } = {}) {
  const host = req.headers.host
  const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim()
  const url = preferHost && host ? `${proto}://${host}` : appUrl
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.end(JSON.stringify(buildManifest(url), null, 2))
}

// Sirve /tonconnect-manifest.json desde el propio origen. TonConnect lo
// descarga antes de conectar; si falla, el claim muere con "manifest not
// found". Generarlo acá garantiza que `url` sea el origen real del deploy
// (VITE_APP_URL) en vez de un host ajeno.
function tonconnectManifest() {
  let appUrl = DEV_APP_URL
  return {
    name: 'tonconnect-manifest',
    config(_config, { mode }) {
      const env = loadEnv(mode, process.cwd(), '')
      const configured = (env.VITE_APP_URL || '').replace(/\/+$/, '')
      if (configured) {
        appUrl = configured
      } else if (mode === 'production') {
        appUrl = PROD_APP_URL
      }
      if (mode === 'production') {
        console.log(`[tonconnect-manifest] url del manifiesto: ${appUrl}`)
      }
    },
    configureServer(server) {
      server.middlewares.use('/tonconnect-manifest.json', (req, res) => {
        serveManifest(req, res, appUrl)
      })
    },
    // `vite preview` sirve dist/, donde el asset quedó con la url de
    // producción. Se pisa con el host real de la petición para que el preview
    // local declare su propio origen y no el dominio desplegado.
    configurePreviewServer(server) {
      server.middlewares.use('/tonconnect-manifest.json', (req, res) => {
        serveManifest(req, res, appUrl, { preferHost: true })
      })
    },
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'tonconnect-manifest.json',
        source: JSON.stringify(buildManifest(appUrl), null, 2),
      })
    },
  }
}

export default defineConfig({
  plugins: [react(), tonconnectManifest()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
    // React must resolve to exactly one copy. A second one (or a half-updated
    // pre-bundle) makes every hook throw "Cannot read properties of null
    // (reading 'useState')" and the whole tree unmounts to a blank screen.
    dedupe: ['react', 'react-dom'],
  },
  // Declared up front so the optimizer never discovers a new dep mid-session
  // and invalidates the ?v= hashes of an already-loaded page. A stale hash
  // answers 504 "Outdated Optimize Dep" and leaves the browser with a module
  // graph mixed across two optimization runs.
  optimizeDeps: {
    include: [
      'react',
      'react-dom',
      'react-dom/client',
      'react/jsx-runtime',
      'react/jsx-dev-runtime',
      'framer-motion',
      'lucide-react',
      '@tonconnect/ui-react',
    ],
  },
  server: {
    port: 3000,
    host: '0.0.0.0',
    allowedHosts: [
      'localhost',
      '127.0.0.1',
      '.arena.site',
      '.e2b.app',
      '.emergentagent.com',
      '.preview.emergentagent.com',
      '.cluster-5.preview.emergentcf.cloud',
      'crypto-clean-1.cluster-5.preview.emergentcf.cloud',
    ],
  },
  build: {
    outDir: 'dist',
  },
  // The preview serves the production build. Unlike the dev server it has no
  // dependency pre-bundle, so there are no ?v= hashes to go stale behind a
  // caching proxy and no CJS interop that can hand a component a null React.
  preview: {
    host: '0.0.0.0',
    port: 3000,
    strictPort: true,
    allowedHosts: [
      'localhost',
      '127.0.0.1',
      '.arena.site',
      '.e2b.app',
      '.emergentagent.com',
      '.preview.emergentagent.com',
      '.cluster-5.preview.emergentcf.cloud',
      'crypto-clean-1.cluster-5.preview.emergentcf.cloud',
    ],
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: './vitest.setup.js',
    css: false,
  },
})
