import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'app',
  plugins: [react()],
  server: { host: '127.0.0.1', proxy: { '/api': 'http://127.0.0.1:7317' } },
  build: { outDir: '../dist', emptyOutDir: true },
  optimizeDeps: { exclude: ['onnxruntime-web'] },
  worker: { format: 'es' },
});
