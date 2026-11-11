import { readFileSync } from 'node:fs';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { defineConfig } from 'vitest/config';

/**
 * Extra seed data for a private local demo: `virtual:lse-demo-seed` is the JSON file named by
 * LSE_DEMO_SEED (kept outside the repo), or empty. Public builds never set it.
 */
function demoSeed(): Plugin {
  const id = 'virtual:lse-demo-seed';
  return {
    name: 'lse-demo-seed',
    resolveId: (s) => (s === id ? `\0${id}` : null),
    load: (s) => {
      if (s !== `\0${id}`) return null;
      const file = process.env.LSE_DEMO_SEED;
      const json = file ? readFileSync(file, 'utf8') : '{"bills":[],"statement":null}';
      return `export default ${json};`;
    },
  };
}

/** The single-file demo has no public folder: inline the icon, drop the home-screen icon link. */
function inlineIcons(): Plugin {
  return {
    name: 'lse-inline-icons',
    transformIndexHtml: (html) =>
      html
        .replace(
          'href="/icon-192.png"',
          `href="data:image/png;base64,${readFileSync('public/icon-192.png').toString('base64')}"`,
        )
        .replace(/\s*<link rel="apple-touch-icon"[^>]*>/, ''),
  };
}

export default defineConfig(({ mode }) => {
  // One HTML file that opens from a folder (file://): hash routes, no service worker, demo data.
  const local = mode === 'local-demo';
  return {
    base: local ? './' : '/',
    // Set here, not in a .env file (those are git-ignored), so the build is reproducible.
    define: local
      ? { 'import.meta.env.VITE_DEMO': '"1"', 'import.meta.env.VITE_HASH_ROUTER': '"1"' }
      : {},
    publicDir: local ? false : 'public',
    plugins: [
      react(),
      demoSeed(),
      ...(local ? [inlineIcons(), viteSingleFile()] : []),
      VitePWA({
        disable: local,
        registerType: 'prompt',
        includeAssets: ['icon-192.png', 'icon-512.png', 'apple-touch-icon.png'],
        manifest: {
          name: 'LSE Trade',
          short_name: 'LSE Trade',
          description: 'Jobs, quotes and invoices for Little Sark Electric',
          theme_color: '#0a84ff',
          background_color: '#f2f2f7',
          display: 'standalone',
          orientation: 'portrait',
          start_url: '/',
          icons: [
            { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
            { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
            {
              src: 'icon-maskable-192.png',
              sizes: '192x192',
              type: 'image/png',
              purpose: 'maskable',
            },
            {
              src: 'icon-maskable-512.png',
              sizes: '512x512',
              type: 'image/png',
              purpose: 'maskable',
            },
          ],
        },
        workbox: {
          // App shell is cached so the app opens with no signal. API data caching and the
          // offline write queue arrive with the offline data layer milestone.
          navigateFallback: '/index.html',
          navigateFallbackDenylist: [/^\/api\//],
          globPatterns: ['**/*.{js,css,html,svg,woff2}'],
        },
      }),
    ],
    server: {
      port: 5173,
      host: '127.0.0.1',
      strictPort: true,
      proxy: { '/api': 'http://127.0.0.1:8787' },
    },
    preview: { port: 4173, strictPort: true, proxy: { '/api': 'http://127.0.0.1:8787' } },
    build: local
      ? {
          target: 'es2022',
          sourcemap: false,
          assetsInlineLimit: 100_000_000,
          chunkSizeWarningLimit: 100_000,
        }
      : { target: 'es2022', sourcemap: true },
    test: {
      environment: 'jsdom',
      include: ['src/**/*.test.{ts,tsx}'],
      setupFiles: ['src/test-setup.ts'],
    },
  };
});
