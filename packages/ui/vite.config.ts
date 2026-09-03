import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './',
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:5757',
      '/media': 'http://127.0.0.1:5757',
      '/healthz': 'http://127.0.0.1:5757',
      '/ws': { target: 'ws://127.0.0.1:5757', ws: true },
    },
  },
  build: { outDir: 'dist' },
});
