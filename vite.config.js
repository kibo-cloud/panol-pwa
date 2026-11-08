// Vite para la app web (web/): sin framework, sin código en línea en el HTML (CSP
// `script-src 'self'`), y xlsx/jspdf servidos desde vendor/ con SRI calculado al compilar.
import { defineConfig } from 'vite';
import { panolVendor } from './web/scripts/vendor-plugin.js';

const API = process.env.PANOL_API || 'http://127.0.0.1:3000';

export default defineConfig({
  root: 'web',
  publicDir: 'public',
  base: '/',
  plugins: [panolVendor()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Nada en línea: fuentes e imágenes como archivos (la CSP no permite data: en fuentes).
    assetsInlineLimit: 0,
    modulePreload: { polyfill: false },
    cssCodeSplit: false,
    sourcemap: false,
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    // La API (incluido el flujo SSE) va al servidor Fastify.
    proxy: { '/api': { target: API, changeOrigin: false, ws: false } },
  },
});
