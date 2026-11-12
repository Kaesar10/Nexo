import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import packageJson from './package.json' with { type: 'json' }

/**
 * Proxy de desarrollo.
 * - `npm run dev`      → habla con el puente real (server/) en 127.0.0.1:8790.
 * - `npm run dev:mock` → habla con el mock (mock/server.mjs) en 127.0.0.1:8791.
 * Puedes forzar otro destino con la variable de entorno VITE_API_PROXY.
 *
 * En producción no hay proxy: la app se sirve desde el mismo origen que la API,
 * así que el cliente usa base '' (mismo origen).
 */
export default defineConfig(({ mode }) => {
  const proxyTarget =
    process.env.VITE_API_PROXY ??
    (mode === 'mock' ? 'http://127.0.0.1:8791' : 'http://127.0.0.1:8790')

  return {
    plugins: [react()],
    define: {
      __APP_VERSION__: JSON.stringify(packageJson.version),
    },
    server: {
      host: true,
      allowedHosts: true,
      port: 5173,
      proxy: {
        '/api': {
          target: proxyTarget,
          changeOrigin: true,
        },
      },
    },
    preview: {
      host: true,
      allowedHosts: true,
    },
    build: {
      target: 'es2022',
      cssTarget: 'chrome100',
    },
  }
})
