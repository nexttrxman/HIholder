import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
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
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: './vitest.setup.js',
    css: false,
  },
})
