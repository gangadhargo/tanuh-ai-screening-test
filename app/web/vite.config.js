import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // The app uses plain CSS, so Vite does not need to search parent folders for
  // a PostCSS configuration.
  css: { postcss: {} },
  server: {
    proxy: { '/api': 'http://localhost:3000' },
    fs: { allow: ['..'] },
  },
});
