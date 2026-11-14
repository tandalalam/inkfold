import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  // Relative base so the same build works on Tailscale (/) and GitHub Pages (/<repo>/).
  base: './',
  build: { target: 'es2022', chunkSizeWarningLimit: 3000 },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      includeAssets: ['icons/*.png', 'pdfjs/**/*'],
      manifest: {
        name: 'Inkfold',
        short_name: 'Inkfold',
        description: 'Handwritten notebooks and PDF annotation for iPad',
        display: 'standalone',
        orientation: 'any',
        start_url: './',
        scope: './',
        background_color: '#f4f2ee',
        theme_color: '#f4f2ee',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,mjs,css,html,png,svg,bcmap,pfb,ttf,wasm,icc,webmanifest}'],
        maximumFileSizeToCacheInBytes: 12 * 1024 * 1024,
        navigateFallback: 'index.html',
      },
    }),
  ],
});
