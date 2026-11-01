# Arrow: desktop-shell

The window the operator holds: Electron entry and Nest composition root, title bar and navigation, app icon, shared UI building blocks, the Settings host page and the polling heartbeat.

## Status

**MAPPED** — mapped 2026-10-30 (git SHA `5c55a380`), not yet audited.
Spec-backed surfaces (custom title bar, app icon, sidebar coverage) match the code; the leaf also carries about 30 presentation primitives and the Settings host page whose only requirement is conformance to `DESIGN.md`, and that conformance has drifted.

## References

### HLD
- `docs/high-level-design.md`
- `docs/intent/operator-app/operator-app-design.md` (sub-HLD)

### LLD
- `docs/intent/operator-app/desktop-shell/desktop-shell-design.md`

### EARS
- `docs/intent/operator-app/desktop-shell/desktop-shell-specs.md` (90 specs)

### Tests
- `app/packages/desktop-main/src/controllers/window.controller.test.ts`
- `app/packages/desktop-main/src/electron-entry.test.ts`
- `app/packages/desktop-main/src/fix-path-bootstrap.test.ts`
- `app/packages/desktop-main/src/main.test.ts`
- `app/packages/desktop-main/src/modules/cloud-provider.module.test.ts`
- `app/packages/desktop-main/src/services/NativeDialogService.test.ts`
- `app/packages/desktop-main/src/services/WindowService.test.ts`
- `app/packages/web/e2e/specs/electron-clean-quit.spec.ts`
- `app/packages/web/e2e/specs/electron-smoke.spec.ts`
- `app/packages/web/e2e/specs/polling.spec.ts`
- `app/packages/web/e2e/specs/settings.spec.ts`
- `app/packages/web/src/app.component.test.tsx`
- `app/packages/web/src/components/app-layout.component.test.tsx`
- `app/packages/web/src/components/confirm-dialog.component.test.tsx`
- `app/packages/web/src/components/ui/form-field.component.test.tsx`
- `app/packages/web/src/components/ui/native-select.component.test.tsx`
- `app/packages/web/src/components/ui/textarea.component.test.tsx`
- `app/packages/web/src/hooks/use-click-outside.hook.test.ts`
- `app/packages/web/src/pages/settings.page.test.tsx`
- `app/packages/web/src/polling/polling-indicator.component.test.tsx`
- `app/packages/web/src/polling/polling-provider.component.test.ts`

### Code

**`@hyveon/desktop-main`** (`app/packages/desktop-main/src/`)
- `electron-entry.ts`, `main.ts`, `env.ts`, `fix-path-bootstrap.ts`
- `app.module.ts`, `modules/cloud-provider.module.ts`, `modules/cloud-provider.tokens.ts`
- `app/packages/desktop-main/src/services/NativeDialogService.ts`, `modules/native-dialog.module.ts`
- `app/packages/desktop-main/src/services/WindowService.ts`, `controllers/window.controller.ts`

**`@hyveon/web`** (`app/packages/web/`)
- Entry and routing: `index.html`, `app/packages/web/src/main.tsx`, `app/packages/web/src/app.component.tsx`, `app/packages/web/src/index.css`, `app/packages/web/src/vite-env.d.ts`
- Chrome and navigation: `app/packages/web/src/components/app-layout.component.tsx`, `app/packages/web/src/components/app-nav.component.tsx`, `app/packages/web/src/components/app-topbar.component.tsx`, `app/packages/web/src/components/window-chrome.component.tsx`, `app/packages/web/src/hooks/use-app-region-style.hook.ts`
- Polling heartbeat: `app/packages/web/src/polling/polling-provider.component.tsx`, `app/packages/web/src/polling/polling-indicator.component.tsx`, `app/packages/web/src/hooks/use-now-tick.hook.ts`
- Settings host: `app/packages/web/src/pages/settings.page.tsx`, `app/packages/web/src/components/settings-row.component.tsx`
- Shared building blocks: `app/packages/web/src/components/async-content.component.tsx`, `confirm-dialog.component.tsx`, `empty-state-card.component.tsx`, `error-banner.component.tsx`, `inline-alert.component.tsx`, `loading-state.component.tsx`, `page-header.component.tsx`, `section-card.component.tsx`
- Primitives (`app/packages/web/src/components/ui/`): `alert-dialog`, `badge`, `button`, `card`, `dialog`, `dropdown-menu`, `form-field`, `input`, `label`, `native-select`, `select`, `sonner`, `table`, `tabs`, `textarea`, `tooltip` (each `*.component.tsx`)
- Utilities: `app/packages/web/src/lib/utils.utils.ts`, `app/packages/web/src/lib/format.utils.ts`, `app/packages/web/src/lib/confirm-skip.utils.ts`, `app/packages/web/src/hooks/use-click-outside.hook.ts`, `app/packages/web/src/hooks/use-copied-reset.hook.ts`
- Design system: `DESIGN.md`, `components.json`
- Icons: `app/packages/web/public/favicon.svg`, `public/favicon-32.png`, `public/apple-touch-icon.png`
- Page objects: `app/packages/web/e2e/pages/AppLayout.ts`, `e2e/pages/SettingsPage.ts`

**Outside `app/packages`**
- `electron.vite.config.ts`
- `build/icon.svg`, `build/icon-small.svg`, `build/icon.icns`, `build/icon.ico`, `build/icon.png`, `build/generate-icons.mjs`, `build/verify-main-bundle-externals.mjs`

### Cited from other leaves
- `operator-app/ipc-bridge`: `app/packages/desktop-main/src/ipc-main-bridge.ts`, `rpc-error-message.filter.ts` (started by `main.ts`), `app/packages/desktop-preload/src/preload.ts` (`window.hyveon.window` namespace), `app/packages/web/src/api.service.ts` (`api.env()` in `app-layout`), `app/packages/web/src/lib/bridge.utils.ts`, `app/packages/web/e2e/fixtures/hyveon-http-bridge.ts` (the stub bridge `app.component.tsx` guards for).
- `iac/engine`: `app/packages/desktop-main/src/services/ConfigService.ts` (`getActiveCloud`, `getRegion`, `getStackOutputs` used by `cloud-provider.module.ts`), `controllers/env.controller.ts` (topbar env pill), `app/packages/shared/src/pulumiVersion.ts` (Settings engine-version row).
- `operator-app/app-update-and-release`: `app/packages/desktop-main/src/updater.ts` (`initUpdater` from `electron-entry.ts`), `electron-builder.yml` (icons, `extraResources` icon copy), `.github/workflows/package.yml`, `app/packages/desktop-main/src/controllers/iac-settings.controller.ts` auto-update channels (hosted in `deployment-config`'s controller until they move to a controller `app-update-and-release` owns).
- `operator-app/wizard-and-bootstrap`: `first-run-wizard.component.tsx` (rendered by the first-run gate and Settings Reconfigure), `ElectronStoreService.ts`, `awsCredentialSource.ts` (credentials in every cloud-provider factory), `cloud-health-section.component.tsx`.
- `operator-app/diagnostics`: `app/packages/web/src/components/error-boundary.component.tsx`, `lib/report-renderer-error.utils.ts` (mounted in `main.tsx`), `DiagnosticsPanel.tsx` (Settings section), `app/packages/desktop-main/src/logger.ts`.
- `game-runtime/task-and-dns`: `app/packages/web/src/polling/game-status-provider.component.tsx` (registered under `PollingProvider`), `app/packages/desktop-main/src/services/EcsService.ts` (`createAwsCloudProvider`).
- `game-runtime/watchdog`: `app/packages/web/src/components/watchdog-panel.component.tsx` (Settings section).
- `helper-task`: `app/packages/desktop-main/src/helper-quit-hook.ts` and `services/volumeFiles/HelperSessionRegistry.ts` (`installHelperQuitHook` wired from `electron-entry.ts:225`), `modules/volume-files.module.ts`, `modules/volume-files-api.module.ts`, `controllers/volume-files.controller.ts` (imported/registered by `app.module.ts:80-81,88`), `app/packages/web/src/pages/volume-files.page.tsx` (`/games/:name/files` route, `app.component.tsx:109`); `FolderScanService` and `volumeFiles/transferOps.ts` / `VolumeFilesService.ts` consume `NativeDialogService`.
- `operator-app/diagnostics`: `app/packages/desktop-main/src/controllers/diagnostics.controller.ts` consumes `NativeDialogService.pickSavePath` for the bundle export dialog (`diagnostics.controller.ts:85-88`).
- `deployment-config`: `app/packages/web/src/components/deployment-settings-form.component.tsx` (Settings section).
- `deployment-config`: `app/packages/shared/src/deploymentConfig.ts` `resolvePreApplyRunsTableName` (pre-apply runs-table fallback in `cloud-provider.module.ts:175`); `iac/run` owns the lock question it feeds.
- Constraint only: `app/packages/shared/src/index.ts` barrel (CLAUDE.md "barrel stays free of new AWS SDK imports"); `settings.page.tsx:2-3` imports from it in the renderer.

### OpenSpec sources
- `openspec/specs/custom-title-bar/spec.md` (owned)
- `openspec/specs/app-icon/spec.md` (owned)
- `openspec/specs/desktop-only-operator-surface/spec.md` (cited: UI-integrity requirements only; the no-HTTP, mock-seam and streaming requirements belong to `ipc-bridge`)
- Active change `openspec/changes/add-user-initiated-update-install/` touches the Settings host page; primary leaf is `app-update-and-release`. Shipped, not synced, unarchived, 11/11 tasks.

## Architecture

**Purpose:** Give the operator one window. Start Electron, build the Nest container, create the `BrowserWindow` with per-platform chrome, gate the renderer on the first-run wizard, then render a routed shell (sidebar, top bar, Settings) on top of an app-wide polling registry.

**Key Components:**
1. `electron-entry.ts`: Electron main entry: clears the menu (`:208`), bootstraps Nest inside `app.whenReady()` (`:210-246`) and, after the updater, installs the helper quit hook (`:225`), creates the window with `titleBarStyle: 'hidden'` plus macOS `trafficLightPosition` / Windows `titleBarOverlay` (`platformWindowChromeOptions`, `:104-117`), re-positions macOS traffic lights on resize and zoom (`:146-158`), resolves the window icon (`:30-37`), routes `target="_blank"` to the OS browser (`:46-53`).
2. `main.ts`: `applyFixPath()`, refuses to run outside Electron (`:18-23`), creates the winston logger under `userData/logs` (`:25-26`), `bootstrap()` creates the IPC microservice, registers `RpcErrorMessageFilter`, then calls `registerIpcMainBridges` (`:43-56`).
3. `app.module.ts`: Nest composition root: 13 feature modules, 16 IPC controllers, 7 loose providers including `WindowService` (`:67-121`).
4. `modules/cloud-provider.module.ts`: binds the seven cloud tokens (`cloud-provider.tokens.ts`) to `@hyveon/cloud-aws` through `CLOUD_BINDINGS` keyed by `ConfigService.getActiveCloud()` (`:193-226`, `:246-305`); lazy config resolvers including the pre-apply runs-table fallback (`:163-184`).
5. `app/packages/desktop-main/src/services/WindowService.ts` + `controllers/window.controller.ts`: `window.minimize|toggleMaximize|close|isMaximized` channels (`window.controller.ts:16-41`); `maximize`/`unmaximize` pushed as `window.maximizedChange` via `webContents.send` (`WindowService.ts:117-124`).
6. `app/packages/web/src/main.tsx` + `app.component.tsx`: mounts React with `ErrorBoundary` and global error/console forwarding (`main.tsx:6-23`); first-run gate on `wizard.getState()` (`app.component.tsx:28-61`); `HashRouter` route table of 13 routes (`:97-111`).
7. `app-layout`, `app-nav`, `app-topbar`, `window-chrome` components: sidebar plus mobile drawer (`app-layout.component.tsx:57-125`), nav groups Monitoring / Logs / Configuration (`app-nav.component.tsx:21-59`), top bar with env pill, Refresh-all and LIVE (`app-topbar.component.tsx:80-137`), Linux-only app-drawn window buttons and mac/win spacers (`window-chrome.component.tsx:18-120`).
8. `polling/polling-provider.component.tsx`: named-poller registry split across stable-actions and 1 Hz state contexts (`:79-242`), `usePoller` (`:273-301`), `isStale` at 2x interval (`:304-315`); `polling-indicator` renders per-poller age.
9. `pages/settings.page.tsx`: host page: engine version, auto-update toggle / check / download / install (direct `window.hyveon.iac.settings` calls, `:145-260`), then `WatchdogPanel`, `CloudHealthSection`, `DeploymentSettingsForm`, `DiagnosticsPanel` (`:271-382`).
10. App icon pipeline: `build/generate-icons.mjs` (`npm run icons:generate`, root `package.json:49`) produces `build/icon.*` and `app/packages/web/public/favicon*`; `index.html:7-10` links the favicons; `electron-builder.yml:222-266` packages them.
11. `build/verify-main-bundle-externals.mjs`: second half of `desktop:build` (root `package.json:46`); fails the build when `@pulumi/*` or `semver` get inlined into the main bundle.
12. `services/NativeDialogService.ts` + `modules/native-dialog.module.ts`: the one wrapper around Electron's open/save dialogs (`pickDirectory`, `pickFiles`, `pickSavePath`, `NativeDialogService.ts:22-56`), lazily importing `electron` and resolving to the cancelled value (`null` / `[]`) outside Electron; exported by a standalone module so folder scan, diagnostics export and volume-file transfers share it (`native-dialog.module.ts:4-12`).

## Spec Coverage

| OpenSpec capability | requirements | scenarios | notes |
|---|---|---|---|
| `custom-title-bar` | 5 | 16 | Owned. Purpose is still "TBD". Hidden title bar, mac traffic lights, Windows overlay, Linux app-drawn buttons, safe browser degradation and the five window channels all present in code (`electron-entry.ts:104-117`, `window-chrome.component.tsx`, `WindowService.ts`). |
| `app-icon` | 3 | 5 | Owned. Assets, `electron-builder.yml` wiring and favicon all present; "approved master artwork" scenarios are process, not code. |
| `desktop-only-operator-surface` | 2 of 11 | 5 of 32 | Cited. Carried here: "Every routed screen is reachable from the sidebar" and "The chrome exposes no non-functional controls" (its "placeholder statistics" scenario is about the game card, owned by `task-and-dns`). The rest belongs to `ipc-bridge`, `iac/engine`, `deployment-config` and the docs index. |

**OpenSpec summary:** Per the clustering recommendation, `APP-SHELL` EARS cover window chrome, app icon, polling heartbeat and route table / first-run gate; the primitives are carried code bound by `DESIGN.md`.

| Category | Spec IDs | Implemented | Deferred | Gaps |
|---|---|---|---|---|
| Process Start and Composition Root | `APP-SHELL-BOOT-001` to `APP-SHELL-BOOT-016` | 15 | 0 | 1 |
| Cloud Provider Bindings | `APP-SHELL-BIND-001` to `APP-SHELL-BIND-004` | 4 | 0 | 0 |
| Window Chrome | `APP-SHELL-CHROME-001` to `APP-SHELL-CHROME-014` | 12 | 1 | 1 |
| Window-Control IPC | `APP-SHELL-WINIPC-001` to `APP-SHELL-WINIPC-013` | 13 | 0 | 0 |
| App Icon | `APP-SHELL-ICON-001` to `APP-SHELL-ICON-005` | 5 | 0 | 0 |
| First-Run Gate | `APP-SHELL-GATE-001` to `APP-SHELL-GATE-006` | 5 | 0 | 1 |
| Routing and Navigation | `APP-SHELL-NAV-001` to `APP-SHELL-NAV-009` | 8 | 0 | 1 |
| Top Bar | `APP-SHELL-TOP-001` to `APP-SHELL-TOP-004` | 3 | 0 | 1 |
| Polling Heartbeat | `APP-SHELL-POLL-001` to `APP-SHELL-POLL-009` | 9 | 0 | 0 |
| Settings Host Page | `APP-SHELL-SET-001` to `APP-SHELL-SET-003` | 3 | 0 | 0 |
| UI Integrity and Design Tokens | `APP-SHELL-UI-001` to `APP-SHELL-UI-007` | 4 | 0 | 3 |

**Summary:** 81 of 89 active specs implemented; 1 deferred; 8 gaps.

## Key Findings

1. **First-run gate fails open by design**: `app.component.tsx:40-54` renders the dashboard (wizard skipped) when `window.hyveon.wizard` is missing or `getState()` rejects. The doc comment at `:22-26` states this is intentional ("must never lock an otherwise-working install out"). Sweep-3 files it as a bug; the code shows it is a deliberate trade-off that also hides a real IPC failure from a fresh install. Needs an explicit decision in EARS.
2. **Sidebar covers the route table**: all 9 top-level routes in `app.component.tsx:98-110` have a nav entry in `app-nav.component.tsx:21-59`; `/iac/history`, `/iac/history/:runId` `/games/:name` and `/games/:name/files` are detail routes. The `desktop-only-operator-surface` sidebar requirement holds. The `CostsPage.ts` TODO claiming Costs is absent from the sidebar is stale (§6 disagreement, owned by `task-and-dns`).
3. **Dashboard active check is exact-match in effect**: `app-nav.component.tsx:90` tests `startsWith('//')`, which never matches, so Dashboard is active only on `/`. The behaviour is correct; the expression is misleading, and `:87-113` index `monitoringItems[0]`/`[1]` by position.
4. **Title-bar colours and geometry are hard-coded twice**: `electron-entry.ts:113` hard-codes `#1a1d2e`/`#e1e4ed`/`56`; `index.css:11-17` declares `--color-card` specifically to keep `bg-card` equal to that literal. `electron-entry.ts:60-70` bakes the 768 px breakpoint and the 240 px sidebar width (`w-60`) into traffic-light positions. Any theme or layout change must edit both packages.
5. **Undeclared Tailwind tokens render nothing**: `index.css` `@theme` declares no `--color-accent`, `--color-background` or `--color-muted`, yet `hover:bg-accent` (`window-chrome.component.tsx:94,102`, `app-layout.component.tsx:118`, `app-topbar.component.tsx:107`, `app-nav.component.tsx:147`), `bg-background` (`app-layout.component.tsx:40`) and `bg-muted` (`app-topbar.component.tsx:59`) are used. Only the legacy `:root --accent` exists (`index.css:54`). Hover fills and the LIVE pill background are therefore absent. `window-chrome.component.tsx:114` uses raw Tailwind reds instead of `--color-red`.
6. **`DESIGN.md` has drifted from `index.css`**: `DESIGN.md` lists `--color-muted-foreground` as `#8b90a5`; `index.css` sets `#9398ad`. `DESIGN.md` also omits `--color-card`.
7. **Two drag-region mechanisms**: `app-layout.component.tsx:51,71-75` writes `WebkitAppRegion` inline while `app-topbar` uses `useAppRegionStyle` (`use-app-region-style.hook.ts:16-18`), which is named as a hook but calls no React hook. The brand block markup is duplicated (`app-layout.component.tsx:77-82` and `:108-113`), and the sidebar brand reads "Game Servers" while the top bar `h1` reads "Hyveon" (`app-topbar.component.tsx:112`).
8. **Env pill failure is silent**: `app-layout.component.tsx:29` sends an `api.env()` rejection to `console.error` and the pill falls back to `local` (`:32-34`), indistinguishable from a real local environment.
9. **Polling registry quirks**: same-name `register()` silently replaces the prior poller (`polling-provider.component.tsx:154-157`); the `usePollingState` doc says the slice carries `tick` but the field is `now` (`:256` vs `:60`). `polling-indicator.component.tsx:96-102` has its own relative-time formatter, separate from `use-log-tail.hook.ts` (sweep-1 `[unverified]` on that second copy's rounding).
10. **Stale comments in the composition root**: `app.module.ts:51-53` says `PulumiEngineModule` has "no controller of their own yet", but `iac-settings.controller.ts:210` serves `iac.settings.engineVersion` from `PulumiEngineService`. The module doc list at `:43-46` omits `FolderUploadModule`, `NativeDialogModule`, `VolumeFilesModule` and `VolumeFilesApiModule` (imported at `:78-81`). `window-chrome.component.tsx:7` cites design decision "(D2)" from an archived change.
11. **Three cloud bindings read the region from stack outputs**: the remote file store and secrets store use `config.getRegion()` (`cloud-provider.module.ts:80,198`), while the audit, Discord and runs stores prefer `outputs.awsRegion` (`:109,131,180`). An install has one region, resolved only through `getRegion()` (`docs/high-level-design.md`, decision 10; `IAC-ENGINE-REGION-002`, owned by `iac/engine`). Credentials are resolved twice per secrets-store call (`:199-200`). `resolveDiscordConfigStoreConfig` has no test in `cloud-provider.module.test.ts` (verified: no reference).
12. **Pre-apply run lock fallback is store-side only**: `cloud-provider.module.ts:174-175` lets `AwsRunRecordStore` resolve the runs table before the first apply; whether `RunService` actually takes the lock pre-apply is the `iac/run` open question (§6), cited here.
13. **Main-process errors bypass winston**: `electron-entry.ts:49,199,222,243` use `console.error`, so window-open, renderer-load, updater-init and Nest-bootstrap failures never reach the log file that `.claude/rules/logging.md` treats as the only record. `main.ts:25` uses a top-level `await import('electron')`.
14. **Stale e2e rationale**: `electron-clean-quit.spec.ts:11-14` says `@cdktf/hcl2json` and `@pulumi/pulumi` are "both" marked external; `electron.vite.config.ts:42` and `verify-main-bundle-externals.mjs` describe hcl2json as retired.
15. **Dead and duplicated primitives**: `app/packages/web/src/components/ui/dropdown-menu.component.tsx` has no importer (verified). `button.component.tsx:13-14` and `:25-26` define identical `destructive` and `stop` variants. Sweep-2 notes the input class string copied into `native-select` and `textarea` `[unverified]`. `electron-entry.test.ts` mocks `setWindowOpenHandler` and `openExternal` but no test asserts the external-link redirect or the `zoom-changed` re-position.

Note: the inventory digest lists "`electron-entry.ts:94` Linux no native chrome (PR #531 TODO)". There is no TODO in the code; `:94` simply documents that Linux gets app-drawn buttons, which is what `custom-title-bar` requires. The planned move to a native Linux overlay lives outside the repo.

## Work Required

Spec IDs cite the open (`[ ]`) gap specs in `docs/intent/operator-app/desktop-shell/desktop-shell-specs.md`; items with no matching gap spec carry none.

### Must Fix
1. Declare the missing `--color-accent`, `--color-background` and `--color-muted` tokens (or replace the classes) so hover states and the LIVE pill render (finding 5). (specs: `APP-SHELL-UI-004`)
2. Decide and record the first-run gate's failure policy; if fail-open stays, surface the IPC failure to the operator instead of silently skipping setup (finding 1). (specs: `APP-SHELL-GATE-006`)

### Should Fix
3. Resolve the audit, Discord-config and run-record store regions through `config.getRegion()` instead of preferring `outputs.awsRegion` (finding 11). The spec is owned by `iac/engine` and tracked in `docs/arrows/iac/engine.md`, Work Required. (specs: `IAC-ENGINE-REGION-002`)
4. Route main-process `console.error` calls through the winston logger (finding 13). (specs: `APP-SHELL-BOOT-008`)
5. Derive the Windows overlay colours and traffic-light geometry from one shared source, or add a test pinning them to `index.css` (finding 4).
6. Reconcile `DESIGN.md` with `index.css` (finding 6). (specs: `APP-SHELL-UI-006`)
7. Fix stale comments in `app.module.ts`, `polling-provider.component.tsx:256`, `window-chrome.component.tsx:7`, `electron-clean-quit.spec.ts:11-14` (findings 9, 10, 14).
8. Add tests for `resolveDiscordConfigStoreConfig`, the external-link opener and the zoom re-position (findings 11, 15).
9. Show env-pill fetch failure distinctly from `local` (finding 8). (specs: `APP-SHELL-TOP-002`)

### Nice to Have
10. Collapse the two drag-region mechanisms; rename `useAppRegionStyle` to a plain function; extract the brand block and settle the "Game Servers" vs "Hyveon" label (finding 7). (specs: `APP-SHELL-NAV-009`)
11. Remove `dropdown-menu.component.tsx`; merge `stop` into `destructive` (finding 15).
12. Replace positional `monitoringItems[n]` and the `startsWith('//')` check in `app-nav` (finding 3).
13. Warn or throw on duplicate poller names (finding 9).
