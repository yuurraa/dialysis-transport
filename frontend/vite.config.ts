import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    // Windows file updates may briefly expose an empty file to hot reload.
    watch: { awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 25 } },
    proxy: { '/api': 'http://localhost:3000' },
  },
});
