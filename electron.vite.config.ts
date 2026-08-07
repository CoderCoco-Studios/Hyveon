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
        // `@pulumi/pulumi` and `@pulumi/aws` must stay external (loaded from
        // node_modules at runtime), never bundled: `@pulumi/pulumi` pulls in
        // `@grpc/grpc-js`, which owns sockets, and bundling either package
        // (60 MB / 15 MB unpacked) risks an "Electron never quits" failure —
        // a module-scope side effect or an open socket surviving into the
        // renderer's `app.close()` path, hanging Playwright's electron
        // project until the worker teardown timeout, failing every spec (see
        // the retired `@cdktf/hcl2json` externalization this repo carried
        // before the `migrate-iac-to-pulumi` change removed that dependency
        // entirely — the exact failure mode this precedent guards against).
        // electron-builder.yml ships both packages (and their transitive
        // deps) unpacked.
        // The Pulumi entries are regexes, not bare strings, because Rollup's
        // `external` array matches import ids *exactly*: the string
        // `'@pulumi/pulumi'` leaves `import ... from '@pulumi/pulumi/automation'`
        // — the subpath the Automation API is actually imported through — fully
        // bundled. That produced a 15 MB `pulumiSpike` chunk, i.e. the exact
        // "bundled SDK owns sockets" hazard the externalization exists to avoid.
        //
        // Two mechanisms now cover these two packages, and the overlap is
        // deliberate:
        //  - `externalizeDepsPlugin()` externalizes every root package.json
        //    `dependencies` entry, adding both the bare name and a
        //    `^(name1|name2)/.+` subpath regex. The root manifest declares these
        //    two packages (electron-builder only copies node_modules belonging
        //    to the app manifest's production dependency tree, and the `files`
        //    whitelist can narrow that set but never add to it), so the plugin
        //    covers them — including subpaths. When the root manifest had no
        //    `dependencies` at all, the plugin externalized *nothing*, which is
        //    why the exact-match string was the only rule in force and the
        //    subpath got bundled.
        //  - this array, which is authoritative regardless of what the root
        //    manifest happens to list — and is the *only* rule covering `semver`
        //    below, which is not a root dependency.
        //
        // The `out/main` bundle is checked after every `desktop:build` by
        // build/verify-main-bundle-externals.mjs, which fails the build if any
        // of these packages' source is found inlined. The 15 MB chunk above was
        // invisible to lint, typecheck, the unit suite and the e2e suite alike.
        //
        // `semver` must be external for the same reason, one level down.
        // `PulumiCommand.install()` takes its `version` as a `semver.SemVer`
        // instance and internally calls `semver.gt(opts.version, …)`, which
        // `instanceof`-checks the argument against *its own* copy of the class.
        // With `semver` bundled, the instance we construct comes from the
        // Rollup-inlined copy while the check runs in the external
        // `node_modules/semver`, so the two classes never match and `install()`
        // dies with `Invalid version. Must be a string. Got type "object"`.
        // Externalizing it leaves exactly one `semver` at runtime. There is a single `semver` in the runtime
        // dependency tree (7.7.4 at the root; the nested 5.x/6.x copies all
        // belong to devDependencies), so this cannot resolve to a second
        // version.
        // `@nestjs/common`'s `ValidationPipe` lazily `require()`s `class-validator`
        // and `class-transformer` inside its constructor — genuinely dead code
        // here, since nothing in `@hyveon/desktop-main` ever instantiates
        // `ValidationPipe`. Both are optional peer deps of `@nestjs/common`,
        // and both are now real (unused) dependencies of `@hyveon/desktop-main`
        // — the same treatment `@grpc/proto-loader` gets above, for the same
        // reason: this build's `output.format: 'es'` means Rollup emits a
        // top-level ESM `import` for every externalized specifier, and ESM
        // imports resolve eagerly at Node's module-load time regardless of
        // whether the binding is ever used — unlike the lazy `require()` Node
        // itself would run if this were plain CommonJS. An externalized but
        // uninstalled package therefore crashes the main process before any
        // window opens (`desktop:dev` reproduced this: `electron-vite dev`'s
        // on-the-fly SSR build reaches this code path even though a full
        // production `desktop:build` did not, because dev mode doesn't
        // tree-shake the same way). Installing the real packages — rather
        // than only listing them here — is what actually fixes it.
        external: [
          /^@pulumi\/pulumi(\/.*)?$/,
          /^@pulumi\/aws(\/.*)?$/,
          'semver',
          'class-validator',
          'class-transformer',
          'electron-updater',
        ],
        output: {
          format: 'es',
          entryFileNames: 'index.js',
        },
      },
      // Emitted as separate `.js.map` files alongside each bundle so a
      // stack trace from a running (dev or packaged) build — main, preload,
      // or renderer — can be mapped back to real TypeScript source instead
      // of a minified bundle line/column.
      sourcemap: true,
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: r('app/packages/desktop-preload/src/preload.ts'),
        output: {
          // Without an explicit format, electron-vite infers it from the
          // root package.json's "type" field — now "module" — and would
          // emit ESM here. Electron's sandboxed preload (see
          // electron-entry.ts) only supports CommonJS, so pin `cjs` and
          // give it a `.cjs` extension to keep Node's parser honest too.
          format: 'cjs',
          entryFileNames: 'preload.cjs',
        },
      },
      sourcemap: true,
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
      sourcemap: true,
    },
  },
});
