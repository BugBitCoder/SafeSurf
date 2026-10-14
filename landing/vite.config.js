import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

/**
 * The showcase runs the REAL detection code, not a reimplementation.
 *
 * `@safesurf` aliases to extension/shared/ — the same modules the extension
 * itself loads. If the demo and the product ever disagreed, the demo would be
 * lying, which is exactly what a landing page must never do.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@safesurf': fileURLToPath(new URL('../extension/shared', import.meta.url)),
    },
  },
  server: { port: 5173, open: true },
  build: {
    outDir: 'dist',
    // No CDN, no analytics, no remote fonts. The page's privacy claim has to
    // hold for the page making the claim.
    assetsInlineLimit: 8192,
  },
});