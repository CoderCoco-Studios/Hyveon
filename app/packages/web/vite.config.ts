import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: [
      { find: '@', replacement: fileURLToPath(new URL('./src', import.meta.url)) },
      // @hyveon/shared's package.json `exports` map points only at `dist/`,
      // so a standalone `vite build` (or `vite preview`'s dev server) run
      // straight from a clean checkout — without first running `npm run
      // build -w @hyveon/shared` — fails to resolve the value imports the
      // renderer takes from it (errMessage, PULUMI_ENGINE_VERSION, etc.).
      // Aliasing to source mirrors tsconfig.json's `paths` entry for the same
      // package and vitest.config.ts's existing alias, and must be ordered
      // before the bare `@hyveon/shared` entry — Vite/Rollup match aliases in
      // array order, and the bare specifier would otherwise shadow this one.
      {
        find: '@hyveon/shared/gameServerValidator',
        replacement: fileURLToPath(new URL('../shared/src/gameServerValidator.ts', import.meta.url)),
      },
      {
        find: '@hyveon/shared/secrets/secretsStore',
        replacement: fileURLToPath(new URL('../shared/src/secrets/secretsStore.ts', import.meta.url)),
      },
      { find: '@hyveon/shared', replacement: fileURLToPath(new URL('../shared/src/index.ts', import.meta.url)) },
      // Same problem, same fix, for @hyveon/desktop-preload: tsconfig.json
      // already source-aliases it for typechecking (its comment covers the
      // history), but `use-reconfigure-answers.hook.ts` imports the value
      // `GUIDED_PROFILE_NAME` from it, not just types — so `vite build` needs
      // its own alias too, or bundling fails the same way `@hyveon/shared`
      // did before the aliases above.
      {
        find: '@hyveon/desktop-preload',
        replacement: fileURLToPath(new URL('../desktop-preload/src/index.ts', import.meta.url)),
      },
    ],
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Loaded once from local disk by the packaged Electron app, not fetched
    // per-visit over a network — the default 500 kB warning targets
    // network-loaded SPAs and doesn't reflect this app's cost model. Vendor
    // deps are still split out below; this only covers the remaining
    // first-party app-code chunk.
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        manualChunks: {
          react: ['react', 'react-dom', 'react-router-dom'],
          'radix-ui': [
            '@radix-ui/react-alert-dialog',
            '@radix-ui/react-dialog',
            '@radix-ui/react-dropdown-menu',
            '@radix-ui/react-label',
            '@radix-ui/react-select',
            '@radix-ui/react-slot',
            '@radix-ui/react-tabs',
            '@radix-ui/react-tooltip',
          ],
        },
      },
    },
  },
});
