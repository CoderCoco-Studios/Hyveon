import { defineConfig, externalizeDepsPlugin, swcPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

/** Resolve a path relative to this config file, regardless of cwd. */
const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  main: {
    // `@nestjs/microservices` is bundled into the main process here, and its
    // optional-transport loader statically pulls in `@grpc/proto-loader`. Even
    // though we use a custom Electron IPC transport (never gRPC), that import
    // is hoisted to a top-level `import` in the ES bundle and must resolve at
    // startup or the main process throws ERR_MODULE_NOT_FOUND before any window
    // opens. `@grpc/proto-loader` is therefore a required dependency of
    // `@hyveon/desktop-main` despite appearing unused — do not remove it.
    //
    // `swcPlugin()` swaps electron-vite's default esbuild transform for SWC
    // for this build only. Nest's DI container relies on TypeScript's
    // `emitDecoratorMetadata` (enabled in `app/tsconfig.base.json`) to read
    // constructor parameter types at runtime via `reflect-metadata`. esbuild
    // does not implement `emitDecoratorMetadata` — it strips decorators
    // without emitting the `design:paramtypes` metadata, so every
    // `@Injectable()`/`@Controller()` constructor loses its parameter types
    // and Nest can't resolve providers, crashing the main process at
    // bootstrap. SWC's decorator transform does emit that metadata, so it's
    // used here in place of esbuild. The renderer and preload builds don't
    // use Nest DI and stay on the default esbuild transform.
    plugins: [externalizeDepsPlugin(), swcPlugin()],
    build: {
      rollupOptions: {
        input: r('app/packages/desktop-main/src/electron-entry.ts'),
        // `@cdktf/hcl2json` must stay external (loaded from node_modules at
        // runtime), never bundled, for two reasons:
        //  1. Its wasm bridge reads `main.wasm.gz` relative to its own module
        //     file (`join(__dirname, '..', 'main.wasm.gz')`). Bundled, that
        //     resolves to `out/main.wasm.gz`, which doesn't exist — the read
        //     rejects and every later `parse()` call awaits a `ready` flag
        //     that never flips, so `games.list` would hang forever.
        //  2. The bundled copy of its Go `wasm_exec` glue runs module-scope
        //     side effects at app startup that prevent Electron from ever
        //     quitting — `app.close()` in Playwright's electron project then
        //     hangs until the worker teardown timeout, failing every spec.
        // The external package also keeps the patch-package fix
        // (patches/@cdktf+hcl2json+0.21.0.patch) in effect. electron-builder.yml
        // packages the module (and its transitive deps) into the installer.
        //
        // `@pulumi/pulumi` and `@pulumi/aws` follow the same precedent from the
        // start rather than discovering the failure mode in CI: `@pulumi/pulumi`
        // pulls in `@grpc/grpc-js`, which owns sockets, and bundling either
        // package (60 MB / 15 MB unpacked) risks the exact "Electron never
        // quits" failure the hcl2json incident produced. electron-builder.yml
        // ships both packages (and their transitive deps) unpacked.
        // The Pulumi entries are regexes, not bare strings, because Rollup's
        // `external` array matches import ids *exactly*: the string
        // `'@pulumi/pulumi'` leaves `import ... from '@pulumi/pulumi/automation'`
        // — the subpath the Automation API is actually imported through — fully
        // bundled. That was observed as a 15 MB `pulumiSpike` chunk during the
        // task 1.3 spike, i.e. the exact "bundled SDK owns sockets" hazard the
        // externalization exists to avoid. `externalizeDepsPlugin()` does not
        // cover it either: it reads `dependencies` from the root package.json,
        // which has none (every workspace dependency is bundled by design), so
        // this array is the only thing keeping these packages external.
        //
        // `semver` must be external for the same reason, one level down.
        // `PulumiCommand.install()` takes its `version` as a `semver.SemVer`
        // instance and internally calls `semver.gt(opts.version, …)`, which
        // `instanceof`-checks the argument against *its own* copy of the class.
        // With `semver` bundled, the instance we construct comes from the
        // Rollup-inlined copy while the check runs in the external
        // `node_modules/semver`, so the two classes never match and `install()`
        // dies with `Invalid version. Must be a string. Got type "object"`
        // (observed during the task 1.3 spike). Externalizing it leaves exactly
        // one `semver` at runtime. There is a single `semver` in the runtime
        // dependency tree (7.7.4 at the root; the nested 5.x/6.x copies all
        // belong to devDependencies), so this cannot resolve to a second
        // version.
        external: [
          '@cdktf/hcl2json',
          /^@pulumi\/pulumi(\/.*)?$/,
          /^@pulumi\/aws(\/.*)?$/,
          'semver',
        ],
        output: {
          format: 'es',
          entryFileNames: 'index.js',
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: r('app/packages/desktop-preload/src/preload.ts'),
      },
    },
  },
  renderer: {
    root: r('app/packages/web'),
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': r('app/packages/web/src'),
      },
    },
    build: {
      rollupOptions: {
        input: r('app/packages/web/index.html'),
      },
    },
  },
});
