import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  build: {
    // Express serves dist/dashboard; empty it on each build so stale hashed
    // assets never linger.
    outDir: '../dist/dashboard',
    emptyOutDir: true,
  },
  server: {
    // `npm run dev` inside dashboard/ proxies API calls to the CLI server.
    proxy: {
      '/api': 'http://localhost:3000',
    },
  },
});
