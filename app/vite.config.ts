import { defineConfig } from 'vite';

// Renderer only; main/preload are bundled by scripts/electron-build.mjs.
export default defineConfig({
  root: 'renderer',
  base: './',
  // Hand-tracking runtime (WASM + model), filled in by scripts/mediapipe-assets.mjs.
  publicDir: '../assets/public',
  server: { port: 5173, strictPort: false },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    target: 'chrome140',
    // three.js alone is ~500 kB; this is a local desktop app, not a web page.
    chunkSizeWarningLimit: 1000,
  },
});
