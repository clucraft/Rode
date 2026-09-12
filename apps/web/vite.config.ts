import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // In development the API and WebSocket live on the server process.
    proxy: {
      '/api': { target: 'http://localhost:8080', changeOrigin: true },
      '/ws': { target: 'ws://localhost:8080', ws: true },
      '/healthz': 'http://localhost:8080',
      '/readyz': 'http://localhost:8080',
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    // Mobile on cellular: keep the initial payload honest.
    // maplibre-gl is a lazily loaded chunk of its own (~280 KB gzipped).
    chunkSizeWarningLimit: 1200,
  },
});
