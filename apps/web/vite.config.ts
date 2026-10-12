import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const port = Number(process.env.WEB_PORT ?? 5173);
const apiPort = Number(process.env.API_PORT ?? 4100);
const workerPort = Number(process.env.WORKER_PORT ?? 4101);
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (/node_modules\/(react|react-dom|scheduler)\//.test(id))
            return 'react-runtime';
        },
      },
    },
  },
  server: {
    host: '127.0.0.1',
    port,
    strictPort: true,
    proxy: {
      '/api': { target: `http://127.0.0.1:${apiPort}` },
      '/worker-health': {
        target: `http://127.0.0.1:${workerPort}`,
        rewrite: () => '/ready',
      },
    },
  },
});
