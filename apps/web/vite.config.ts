import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * `npm run dev` serves the client with hot reload and proxies the API to an
 * `open-agent web` already running on its default port (or
 * `OPEN_AGENT_WEB_PORT`). Open the Vite URL with the `?token=` from that
 * server's startup line.
 */
export default defineConfig({
  root: 'src/client',
  plugins: [react()],
  build: { outDir: '../../dist/client', emptyOutDir: true },
  server: {
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${process.env.OPEN_AGENT_WEB_PORT ?? 7373}`,
        changeOrigin: true,
        // The server refuses POSTs from any origin but its own, and in
        // development the page's origin is Vite's. The token still has to match.
        configure: (proxy) => proxy.on('proxyReq', (req) => req.removeHeader('origin')),
      },
    },
  },
})
