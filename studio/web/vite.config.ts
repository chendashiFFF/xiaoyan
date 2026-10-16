import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const server = 'http://127.0.0.1:5180';

export default defineConfig({
  plugins: [react()],
  build: { rollupOptions: { input: { studio: 'index.html', characters: 'characters/index.html', video: 'video/index.html' } } },
  server: {
    port: 5173,
    strictPort: true,
    proxy: { '/api': server, '/media': server, '/exports': server, '/files': server, '/fonts': server },
  },
});
