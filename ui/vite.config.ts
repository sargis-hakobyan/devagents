import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

// Built assets are served by the DevAgents service itself under /ui; the Vite dev server is a
// developer convenience that proxies API calls to a running service on the default port.
const proxyTarget = `http://127.0.0.1:${process.env.DEVAGENTS_PORT ?? 4310}`;
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: '/ui/',
  plugins: [preact()],
  build: { outDir: '../dist/ui', emptyOutDir: true, sourcemap: false, target: 'es2022' },
  server: {
    port: 5173, strictPort: true, host: '127.0.0.1',
    proxy: Object.fromEntries(['/tasks', '/projects', '/agents', '/teams', '/overview', '/status', '/health', '/ui/session', '/ui/logout', '/ui/login'].map(p => [p, { target: proxyTarget, changeOrigin: true }])),
  },
});
