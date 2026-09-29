import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Панел дар /admin/ аз ҳамон сервери API дода мешавад (cookie-и HttpOnly бе CORS).
// Дар рушд: `npm run dev` ва backend дар http://localhost:8080.
export default defineConfig({
  base: '/admin/',
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    chunkSizeWarningLimit: 800,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:8080', changeOrigin: false },
    },
  },
});
