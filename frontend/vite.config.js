import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 3000,
    host: '0.0.0.0',
    allowedHosts: [
      'localhost',
      '127.0.0.1',
      '.emergentagent.com',
      '.preview.emergentagent.com',
      '.cluster-5.preview.emergentcf.cloud',
      'crypto-clean-1.cluster-5.preview.emergentcf.cloud',
    ],
  },
  build: {
    outDir: 'dist',
  },
})
