import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const packageJson = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
) as { version?: string };
const appVersion = String(packageJson.version || '0.0.0');

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  plugins: [
    react(),
    tailwindcss(),
  ],
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          router: ['react-router-dom'],
          query: ['@tanstack/react-query'],
          icons: ['lucide-react'],
          date: ['date-fns'],
        },
      },
    },
  },
  server: {
    proxy: {
      '/api': 'http://localhost:3000'
    }
  }
});
