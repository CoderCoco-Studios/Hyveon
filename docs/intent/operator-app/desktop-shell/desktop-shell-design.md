---
parent: operator-app
prefix: APP-SHELL
---

# Desktop Shell

## Context and Design Philosophy

Hyveon's operator surface is a single Electron window; there is no web console and no HTTP API (`openspec/specs/desktop-only-operator-surface`, CLAUDE.md "The desktop app has no HTTP transport").
This leaf exists to give the operator that one window: start Electron, build the Nest container every IPC controller lives in, open a `BrowserWindow` whose title bar is the app's own header, gate the renderer on the first-run wizard, and then render a routed shell (sidebar, top bar, Settings) on top of an app-wide polling registry.

The leaf owns six strands:

- **Process start and composition root**: `electron-entry.ts` (Electron main entry), `main.ts` (`bootstrap()`), `app.module.ts` (root Nest module) and `modules/cloud-provider.module.ts` (cloud token bindings), all under `app/packages/desktop-main/src/`.
- **Window chrome**: `BrowserWindow` options and macOS traffic-light handling (`electron-entry.ts:104-158`), `WindowService` and `WindowController` (`services/WindowService.ts`, `controllers/window.controller.ts`), and the renderer's spacers and Linux buttons (`web/src/components/window-chrome.component.tsx`).
- **Renderer shell**: `main.tsx`, `app.component.tsx` (first-run gate plus route table), `app-layout`, `app-nav`, `app-topbar` (under `app/packages/web/src/`).
- **Polling heartbeat**: `polling/polling-provider.component.tsx`, `polling-indicator.component.tsx`, `hooks/use-now-tick.hook.ts`.
- **The Settings host page**: `pages/settings.page.tsx` and `components/settings-row.component.tsx`.
- **Carried presentation code**: the `components/ui/*` primitives, the shared building blocks (`section-card`, `async-content`, `confirm-dialog`, `page-header` and peers), `lib/{utils,format,confirm-skip}.utils.ts`, `DESIGN.md`, `index.css` tokens, and the app icon pipeline (`build/generate-icons.mjs`, `build/icon*`, `web/public/favicon*`).

What it deliberately does not own:

- The transport itself: `ipc-main-bridge.ts`, `rpc-error-message.filter.ts`, `desktop-preload/src/preload.ts` (including the `window.hyveon.window` namespace at `preload.ts:644-651`) and `web/src/api.service.ts` belong to `operator-app/ipc-bridge`. This leaf starts the bridge (`main.ts:43-56`) and consumes it.
- The first-run wizard component, `ElectronStoreService` and credential resolution (`operator-app/wizard-and-bootstrap`); the gate here only decides whether to render the wizard.
- Renderer error reporting and the `ErrorBoundary` that `main.tsx:8-21` mounts (`operator-app/diagnostics`).
- The updater and packaging (`operator-app/app-update-and-release`: `updater.ts`, `electron-builder.yml`); `electron-entry.ts:221` only calls `initUpdater`.
- Each Settings section's content: watchdog panel (`game-runtime/watchdog`), cloud health and Reconfigure wizard (`wizard-and-bootstrap`), deployment settings form (`deployment-config`), diagnostics panel (`diagnostics`), engine version source (`iac/engine`), update channels (`app-update-and-release`).
- `ConfigService` and stack outputs (`iac/engine`) and the game-status poller registered under `PollingProvider` (`game-runtime/task-and-dns`).

CLAUDE.md invariants that live here:

- **No HTTP transport.** `main.ts:18-23` refuses to start outside an Electron main process, and `bootstrap()` creates only an IPC microservice (`main.ts:44-47`).
- **Secrets never reach the renderer.** Not enforced here (the bridge enforces it), but every renderer surface in this leaf reads only redacted shapes through `window.hyveon`.
- **The `@hyveon/shared` barrel stays free of new AWS SDK imports.** `settings.page.tsx:2-3` imports `PULUMI_ENGINE_VERSION` and a type from the barrel into the renderer, so the renderer bundle inherits whatever the barrel pulls in.
- **Every IPC handler logs on entry** (`.claude/rules/logging.md`): `WindowController` does (`window.controller.ts:18,25,32,39`).

## Process Start and Composition Root

Start-up is a fixed sequence split across two files.

1. Module load of `main.ts` (imported by `electron-entry.ts`) calls `applyFixPath()` (`main.ts:12`), which re-reads the login shell `PATH` on macOS and Linux so GUI launches can find `node`, `aws` and similar tools, and is a no-op on Windows (`fix-path-bootstrap.ts:39-44`).
2. `main.ts:18-23` throws if `process.versions.electron` is absent, then a top-level `await import('electron')` creates the winston logger under `userData/logs` (`main.ts:25-26`).
3. `electron-entry.ts:208` clears the application menu (`Menu.setApplicationMenu(null)`), justified in place as "a single-purpose operator console, not a document editor" (`:206-207`).
4. Inside `app.whenReady()` (`electron-entry.ts:210`), `bootstrap()` creates the Nest microservice with `BridgedElectronIPCTransport`, registers `RpcErrorMessageFilter` before `listen()`, then calls `registerIpcMainBridges` (`main.ts:43-56`).
5. On success it logs test mode if `HYVEON_TEST_MODE=1` (`electron-entry.ts:213-215`, `env.ts:12-14`), fires `initUpdater` with its own `.catch` (`electron-entry.ts:221-223`), installs the helper quit hook with the container's `HelperSessionRegistry` (`:225`; the hook itself is `helper-task`'s `helper-quit-hook.ts`), creates the window and attaches it to `WindowService` (`:227-228`), and registers a macOS `activate` handler that re-creates and re-attaches the window when none is open (`:236-240`).
6. A Nest bootstrap failure logs and quits (`electron-entry.ts:242-245`); so does a renderer load failure (`:198-201`). `window-all-closed` quits except on macOS (`:250-252`).

Divergence from the logging rule: the four failure paths above (`electron-entry.ts:49,199,222,243`) use `console.error`, not the winston logger, so window-open, renderer-load, updater-init and Nest-bootstrap failures never reach the log file that `.claude/rules/logging.md` calls the only record.

`createWindow()` (`electron-entry.ts:167-204`) opens a 1200x800 window with the resolved icon (`resolveWindowIcon`, `:30-37`, falls back to Electron's default icon when neither the packaged nor the repo copy exists), `contextIsolation: true` and `sandbox: true`, and the preload at `out/preload/preload.cjs` (`:179`). It loads `ELECTRON_RENDERER_URL` in dev, otherwise `out/renderer/index.html` (`:191-194`, `env.ts:20-22`). `setDefaultBrowserOpener` denies every `window.open` and hands the URL to `shell.openExternal` (`:44-51`).

### Root module

`AppModule` (`app.module.ts:67-121`) imports thirteen feature modules (`AwsModule`, `DiscordModule`, `DeploymentConfigModule`, `RunRecordModule`, `PulumiEngineModule`, `PulumiWorkspaceModule`, `PulumiServiceModule`, `WizardModule`, `ElectronStoreModule`, `FolderUploadModule`, `NativeDialogModule`, `VolumeFilesModule`, `VolumeFilesApiModule`), registers sixteen controllers (`VolumeFilesController` replaced the removed `FilesController`), and provides eight loose providers (one factory token plus seven classes): `DIAGNOSTICS_LOG_DIR`, `DiagnosticsService`, `DiagnosticsBundleService`, `DriftService`, `GamesWriteService`, `GameWizardDraftService`, `AuditService`, `WindowService`. `DIAGNOSTICS_LOG_DIR` resolves to `userData/logs` under Electron and to `DIAGNOSTICS_LOG_DIR` or `os.tmpdir()` in plain Node (`:102-112`), which is how the integration-test server builds the same container without Electron.

`RunRecordModule` is imported directly because `PulumiService` resolves `RUN_RECORD_PERSISTER`/`RUN_LOCK_SERVICE` lazily with `ModuleRef.get(token, { strict: false })` (`app.module.ts:59-65`).

The module's doc comment is stale in two places: it says `PulumiEngineModule`/`PulumiWorkspaceModule` have "no controller of their own yet" (`app.module.ts:51-53`) although `iac-settings.controller.ts` serves `iac.settings.engineVersion`, and its module list (`:43-46`) omits `FolderUploadModule`, `NativeDialogModule`, `VolumeFilesModule` and `VolumeFilesApiModule` (imported at `:78-81`).

`NativeDialogModule` provides and exports `NativeDialogService`, the one wrapper around Electron's native dialogs: `pickDirectory`, `pickFiles` and `pickSavePath` each lazily `import('electron')` and resolve to the cancelled value (`null` or `[]`) when `process.versions.electron` is absent, so the plain-Node integration harness can build the container (`NativeDialogService.ts:11-56`). It is a standalone module so every dialog consumer imports it instead of owning a copy (`native-dialog.module.ts:4-7`); the consumers are `FolderScanService` and the volume-file transfers (`helper-task`) and `DiagnosticsController`'s bundle export (`operator-app/diagnostics`), which previously required `electron` itself.

### Cloud provider bindings

`CloudProviderModule` (`modules/cloud-provider.module.ts:246-305`) binds seven symbol tokens (`cloud-provider.tokens.ts:12-30`) through factories that each call `resolveCloudBindings(config)` (`:219-226`), which looks up `CLOUD_BINDINGS[config.getActiveCloud()]` and throws `Unsupported cloud provider` for an unregistered cloud. Only `aws` is populated (`:193-211`). Consumers inject the token and depend on the `@hyveon/shared` interface, so adding a cloud is one registry entry (`:228-240`).

| Token | AWS class | Config resolver | Region source |
|---|---|---|---|
| `CLOUD_PROVIDER` | via `createAwsCloudProvider` | (in `EcsService.ts`, `task-and-dns`) | n/a here |
| `SECRETS_STORE` | `AwsSecretsStore` | inline closures | `config.getRegion()` (`:198`) |
| `REMOTE_FILE_STORE` | `AwsRemoteFileStore` | `resolveDeploymentConfigFileStoreConfig` (`:73-80`) | `config.getRegion()` (`:80`) |
| `DISCORD_RECEIVER` | `AwsDiscordEventReceiver` | none | n/a |
| `AUDIT_LOG_STORE` | `AwsAuditLogStore` | `resolveAuditLogStoreConfig` (`:101-109`) | `outputs.awsRegion ?? getRegion()` (`:109`) |
| `DISCORD_CONFIG_STORE` | `AwsDiscordConfigStore` | `resolveDiscordConfigStoreConfig` (`:123-131`) | `outputs.awsRegion ?? getRegion()` (`:131`) |
| `RUN_RECORD_STORE` | `AwsRunRecordStore` | `resolveRunRecordStoreConfig` (`:163-184`) | `outputs.awsRegion ?? getRegion()` (`:180`) |

Every store receives a lazy resolver closure rather than a resolved config, so the container builds on a fresh install with no stack outputs. `RUN_RECORD_STORE` injects `REMOTE_FILE_STORE` so its resolver can fall back to `resolvePreApplyRunsTableName(remoteFileStore)` before the first apply (`:174-175`, `:285-293`). Every row's region resolves through `config.getRegion()`, the install's one region (`IAC-ENGINE-REGION-002`, owned by `iac/engine`; `docs/high-level-design.md`, decision 10); the audit, Discord-config and run-record rows still prefer `outputs.awsRegion`, which is that spec's open gap. The secrets-store binding resolves credentials twice per call, once for credentials and once for the signature (`:199-200`).

## Window Chrome

The title bar is the app's own header on every platform, with each OS keeping its native control convention (`openspec/specs/custom-title-bar/spec.md`; archived design `2026-08-14-add-custom-title-bar/design.md` D1-D7).

| Platform | `BrowserWindow` options (`electron-entry.ts:104-117`) | Window controls | Renderer reservation |
|---|---|---|---|
| macOS | `titleBarStyle: 'hidden'`, `trafficLightPosition: { x: 252, y: 20 }` | Native traffic lights | `TrafficLightSpacer` `w-20` (`window-chrome.component.tsx:18-21`) |
| Windows | `titleBarStyle: 'hidden'`, `titleBarOverlay: { color: '#1a1d2e', symbolColor: '#e1e4ed', height: 56 }` | Native overlay, including snap flyout | `TitlebarOverlaySpacer` width `calc(100vw - env(titlebar-area-width, 100vw))` (`:38-47`) |
| Linux | `titleBarStyle: 'hidden'` only | App-drawn minimize, maximize/restore, close (`WindowControls`, `:57-120`) | Buttons sit in the header's trailing group (`app-topbar.component.tsx:131`) |

On macOS the traffic-light position depends on whether the 240 px sidebar is visible. `wireTrafficLightResizeHandling` (`electron-entry.ts:146-158`) divides `getBounds().width` by the zoom factor and switches between `{ x: 252, y: 20 }` and `{ x: 12, y: 20 }` at the 768 px `md` breakpoint, on `resize` and on `zoom-changed`. The geometry (768, 240, 56 and the two colours) is baked into the main process and must match `app-layout`'s `w-60`/`hidden md:flex`, the header's `h-14`, and `index.css`'s `--color-card`/`--color-foreground` (`index.css:11-20`). Nothing pins the two packages together; the `electron-entry.ts:96-100` comment names `--color-surface` while `index.css:11-17` says `bg-card` exists specifically to equal the overlay literal.

### Drag regions

The header is the drag handle (`app-topbar.component.tsx:92-95`, `useAppRegionStyle('drag')`), with `no-drag` on the hamburger, LIVE pill, avatar and window buttons. On macOS the sidebar brand block is also a drag region (`app-layout.component.tsx:68-76`) and the skip-to-content link opts out (`:48-52`). Two mechanisms coexist: inline `WebkitAppRegion` styles in `app-layout` and `window-chrome` (`window-chrome.component.tsx:89`), and the `useAppRegionStyle` helper (`use-app-region-style.hook.ts:16-18`), which is named as a hook but calls no React hook. The helper returns `undefined` without `window.hyveon.window`, which is how the renderer meets "degrades safely outside Electron"; the inline brand-block style also checks for the bridge (`app-layout.component.tsx:72`), but the inline `no-drag` on the skip link and Linux buttons does not.

### Window IPC

| Channel | Direction | Handler | Behaviour |
|---|---|---|---|
| `window.minimize` | renderer to main | `WindowController.minimize` (`window.controller.ts:16-20`) | `win.minimize()` |
| `window.toggleMaximize` | renderer to main | `:23-27` | maximize or unmaximize based on `win.isMaximized()` (`WindowService.ts:69-80`) |
| `window.close` | renderer to main | `:30-34` | `win.close()` |
| `window.isMaximized` | renderer to main | `:37-41` | returns state, `false` on no window or error (`WindowService.ts:98-106`) |
| `window.maximizedChange` | main to renderer push | `WindowService.pushMaximizedChange` (`:117-124`) | `webContents.send` on native `maximize`/`unmaximize`; not a `@MessagePattern` because the bridge only carries request/response |

`WindowService` holds no window until `attach()` (`WindowService.ts:29-52`); every method is a no-op without one, and a `closed` listener with an identity check nulls the reference so a macOS re-activation does not leave the service pointing at a destroyed window (`:41-48`). Every failure is caught and logged at `warn` (`:50,60,78,88,103,122`). `WindowControls` seeds its maximize state from `isMaximized()` but lets any live push win if it lands first (`window-chrome.component.tsx:61-84`), and does neither on macOS or Windows.

## Renderer Shell

`main.tsx` installs global error reporting and console forwarding, then mounts `<App>` inside `StrictMode` and `ErrorBoundary`, suppressing React's `onCaughtError` console echo so a caught render error is reported once (`main.tsx:8-23`).

### First-run gate

`useWizardCompleted` (`app.component.tsx:28-61`) reads `window.hyveon.wizard.getState()` once on mount. It returns `null` while the call is in flight (the app renders nothing, `:88`), `false` when setup is incomplete (renders only `FirstRunWizard`, no router and no polling, `:89`), and `true` otherwise. It fails open: a missing `window.hyveon.wizard` (the chromium e2e stub bridge) or a rejected `getState()` both yield `true` and the dashboard renders. The doc comment states this is deliberate: a failed IPC call "must never lock an otherwise-working install out of its own dashboard" (`:22-26`). The same policy also means a fresh install whose wizard IPC fails silently skips setup with no operator-visible signal. On completion the wizard calls `onComplete`, which flips a local flag rather than re-reading state (`:82-86`).

### Route table and navigation

Once past the gate, `App` renders `PollingProvider` > `GameStatusProvider` > `HashRouter` > `AppLayout` > `Routes` (`app.component.tsx:91-116`). `HashRouter` is chosen because the packaged renderer loads from `file://` and `BrowserRouter` fails to match against a Windows drive-letter path (`:72-78`).

| Route | Page | Sidebar entry (`app-nav.component.tsx`) |
|---|---|---|
| `/` | `DashboardPage` | Monitoring > Dashboard (`:21`) |
| `/logs`, `/logs/infrastructure` | `LogsPage`, `InfrastructureLogsPage` | Monitoring > Logs > Game Logs, Infra Logs (`:44-51`) |
| `/costs` | `CostsPage` | Monitoring > Costs (`:22`) |
| `/games` | `GamesPage` | Configuration > Games (`:54`) |
| `/discord` | `DiscordPage` | Configuration > Discord (`:55`) |
| `/iac` | `IacPage` | Configuration > Infrastructure (`:56`) |
| `/audit` | `AuditPage` | Configuration > Audit (`:57`) |
| `/settings` | `SettingsPage` | Configuration > Settings (`:58`) |
| `/games/:name`, `/games/:name/files`, `/iac/history`, `/iac/history/:runId` | detail pages | none (reached from their parent page) |

Every top-level route has a sidebar entry, which satisfies the `desktop-only-operator-surface` requirement "Every routed screen is reachable from the sidebar". Active state is exact-or-prefix for top-level items (`app-nav.component.tsx:90,110`) and exact for the log children (`:102`). For Dashboard the prefix test is `startsWith('//')`, which never matches, so Dashboard is active only on `/`; the outcome is right but the expression is accidental, and the Monitoring list indexes `monitoringItems[0]` and `[1]` by position (`:87-113`).

`AppLayout` (`app-layout.component.tsx:18-125`) renders a 240 px desktop sidebar (`hidden md:flex w-60`, `:57`) and an always-mounted mobile drawer that is open only while `menuOpenForPath` equals the current path, so navigation closes it without an effect (`:21-26,98-125`). The brand block markup is duplicated between sidebar and drawer (`:77-82`, `:108-113`) and reads "Game Servers", while the top bar heading reads "Hyveon" (`app-topbar.component.tsx:112`).

### Top bar

`AppTopbar` (`app-topbar.component.tsx:80-137`) carries the traffic-light spacer, the mobile hamburger, the "Hyveon" heading, the env pill, Refresh-all, the LIVE indicator, a decorative `aria-hidden` "OP" avatar, the Linux window controls and the Windows overlay spacer. The env pill text comes from `api.env()` in `AppLayout` as `"<environment> · <region>"`; on rejection the error goes to `console.error` and the pill shows `local`, the same text as a real local environment (`app-layout.component.tsx:28-34`). The LIVE indicator is cyan and pulsing when any poller is fresh, dimmed when all are stale, and "Connecting" otherwise (`app-topbar.component.tsx:43-55`).

## Polling Heartbeat

`PollingProvider` (`polling/polling-provider.component.tsx:79-242`) is a registry of named pollers shared by the whole shell. It splits into two contexts so registering components do not re-render every second: a stable actions context (`register`, `refresh`, `refreshAll`) and a state context (`pollers`, `now`) (`:34-64,229-234`).

| Field (`PollerState`) | Meaning |
|---|---|
| `intervalMs` | Poll period supplied at registration |
| `firstAttemptAt`, `lastAttemptAt`, `lastSuccessAt` | Epoch ms; preserved across a same-name re-registration (`:168-178`) |
| `loading`, `error` | In-flight flag and last thrown error, cleared on success (`:135-145`) |

Lifecycle of one poller:

1. `register(name, fn, intervalMs)` clears any previous timer under that name, silently replacing that poller, starts a `setInterval`, seeds state, runs `fn` once immediately, and returns a cleanup that only removes the entry if its `regId` still owns it (`:152-197`).
2. `runOne` skips if the poller is already in flight, otherwise restarts its interval so the next automatic tick lands one full interval after this attempt, then records success or the thrown error (`:113-150`). Errors are swallowed into state, never rethrown.
3. `refreshAll` runs every registered poller concurrently (`:206-208`), wired to the top bar's Refresh-all button.
4. `isStale` is true once more than `2 x intervalMs` has passed since the last success, or since the first attempt if none ever succeeded (`:303-315`).

A 1 Hz `useNowTick(1000)` heartbeat (`:210-215`) supplies `now` so relative-time labels and staleness re-evaluate without each consumer running its own timer. `usePoller` (`:273-301`) is the hook form; it holds `fn` in a ref so callers can pass inline closures, and re-registers only when `name`, `intervalMs` or `enabled` change. Today its only consumer is `GameStatusProvider` (`game-status-provider.component.tsx:82`). `PollingIndicator` renders per-poller "Xs ago" with its own `formatAgo` (`polling-indicator.component.tsx:96-102`).

Polling does not pause when the window is hidden or minimised; nothing in the provider reads `document.visibilityState` or window focus. The `usePollingState` doc comment says the slice carries `tick` (`:256`) but the field is `now` (`:60`).

## Settings Host Page and Carried Presentation Code

`SettingsPage` (`pages/settings.page.tsx`) is a host. It renders, in order: Watchdog Configuration (`WatchdogPanel`, `:268-272`), Cloud Health (`CloudHealthSection`, `:274-278`), Cloud Setup (engine version row plus a Reconfigure button, `:286-293`), Updates (auto-update toggle, check, download, install, `:295-371`), General (`DeploymentSettingsForm`, `:373-377`) and Diagnostics (`DiagnosticsPanel`, `:379-383`). Reconfigure replaces the whole page with `FirstRunWizard mode="reconfigure"` until it completes or is cancelled (`:250-258`).

The page hosts the engine-version row (`APP-SHELL-SET-003`) and the Updates rows, whose behaviour is specified by `app-update-and-release` (`APP-UPDATE-UI-*`) while their code lives in this file (`docs/high-level-design.md`, "Spec ownership across segments"). Each row models its IPC call as `'loading' | ready | 'error'` so a real failure renders different copy from an expected `null` ("Not yet provisioned") (`:15-57`). An absent `window.hyveon.iac.settings` is routed through the same rejected-promise path as an IPC failure (`:145-170`). A failed auto-update write keeps the last confirmed value and sets `writeError` rather than dropping to `'error'` (`:180-196`). Download consumes the streaming `autoUpdateDownload()` iterator and mirrors percent progress; install failures surface like a failed download (`:219-244`). These rows call `window.hyveon.iac.settings` directly, not the `api.*` facade the rest of the renderer uses.

The rest of the leaf is presentation code with no behaviour of its own beyond conformance to `DESIGN.md` and `index.css` tokens. Current drift:

- `index.css`'s `@theme` declares no `--color-accent`, `--color-background` or `--color-muted` (`index.css:5-44`), yet `hover:bg-accent` (`window-chrome.component.tsx:94,102`, `app-layout.component.tsx:118`, `app-topbar.component.tsx:107`), `bg-background` (`app-layout.component.tsx:40`) and `bg-muted` (`app-topbar.component.tsx:59`) are used. Tailwind generates no utility for an undeclared token, so these hover fills and the LIVE pill background do not render. Only a legacy `:root --accent` exists (`index.css:54`).
- `DESIGN.md:23` lists `--color-muted-foreground` as `#8b90a5`; `index.css:21` sets `#9398ad`, and `DESIGN.md` omits `--color-card`.
- `WindowControls`' close button uses raw Tailwind reds (`window-chrome.component.tsx:114`) instead of `--color-red`.
- `components/ui/dropdown-menu.component.tsx` has no importer, and `button.component.tsx` defines identical `destructive` and `stop` variants (arrow doc finding 15).

The icon pipeline is a build-time script: `npm run icons:generate` (root `package.json:49`) rasterises `build/icon.svg` and, for sizes at or below 24 px, `build/icon-small.svg` with `sharp` and `png2icons` into `build/icon.png` (1024x1024), `icon.ico` (7 sizes), `icon.icns`, and `web/public/favicon.svg`, `favicon-32.png`, `apple-touch-icon.png` (`build/generate-icons.mjs:2-15,22-30`). Outputs are committed. `electron-builder.yml:222-223` copies `icon.png` into resources for `resolveWindowIcon`, and `:249,254,266` wire the per-platform installer icons. `desktop:build` also runs `build/verify-main-bundle-externals.mjs` (root `package.json:46`), which fails the build if `@pulumi/*` or `semver` get inlined into the main bundle.

## Decisions & Alternatives

| Decision | Chosen | Alternatives Considered | Rationale |
|---|---|---|---|
| Native dialogs | One `NativeDialogService` in a standalone `NativeDialogModule` | Each consumer lazily requires `electron` itself (the earlier `DiagnosticsController.showSaveDialog` pattern) | Shared, guarded import for every dialog consumer (`native-dialog.module.ts:4-7`, `NativeDialogService.ts:11-14`). |
| Title bar placement | Merge into the existing top header | Separate ~32 px strip above the header | Saves vertical space for dashboards and logs (archived `add-custom-title-bar/design.md` D1). |
| macOS window controls | Native traffic lights repositioned into the header, re-positioned at runtime across the 768 px breakpoint and on zoom | App-drawn buttons on every platform | Matches macOS expectations and keeps OS zoom, hover and accessibility behaviour (D2). |
| Windows and Linux controls | Native `titleBarOverlay` on Windows; app-drawn buttons on Linux | One shared custom button set on both | Keeps the Windows 11 snap flyout; Linux app-drawn for implementation simplicity, native overlay left to a future change (D3). |
| Window IPC shape | `WindowController`/`WindowService` with four request/response channels plus a `window.maximizedChange` push | Raw `ipcMain.handle` in `electron-entry.ts`; separate maximize/unmaximize channels | Keeps the single controller pattern and the log-on-entry rule; `toggleMaximize` spares the renderer from tracking state (D4, D5). |
| Platform detection in the renderer | Preload exposes `platform` from `process.platform`; renderer feature-detects `window.hyveon?.window` | IPC round-trip for platform; build-time `IS_ELECTRON` flag | Platform is static per session; one bundle serves Electron and the chromium e2e tier (D6, D7). |
| Router | `HashRouter` | `BrowserRouter` | `BrowserRouter` fails to match routes under a Windows `file://` drive-letter path (`app.component.tsx:72-78`). |
| First-run gate failure policy | Fail open: skip the wizard when the bridge is missing or `getState()` rejects | Fail closed (show the wizard or an error) | A failed IPC call must never lock a working install out of its dashboard (`app.component.tsx:22-26`). |
| Application menu | `Menu.setApplicationMenu(null)` | Electron's default File/Edit/View/Window menu | Single-purpose operator console with no document actions (`electron-entry.ts:206-207`). |
| External links | Deny every new window; open the URL in the OS browser | Allow Electron child windows | Links such as AWS Cost Explorer belong in the operator's browser (`electron-entry.ts:39-45`); keeping app content to one sandboxed window appears to be the intent `[inferred]`. |
| Cloud binding seam | `CLOUD_BINDINGS` registry keyed by `getActiveCloud()`, factories receive lazy config resolvers | Inject concrete AWS classes directly | Adding a cloud is one registry entry, not a call-site hunt (`cloud-provider.module.ts:186-192,228-240`); lazy resolvers let the container build before any stack exists `[inferred]`. |
| Polling model | One app-wide named-poller registry with split action/state contexts and a shared 1 Hz heartbeat | Per-component `setInterval` | Avoids per-consumer timers and re-render storms (`polling-provider.component.tsx:34-38,210-215`); global Refresh-all and the LIVE pill need one registry `[inferred]`. |
| Staleness threshold | 2 x interval without success | Fixed wall-clock threshold | Scales with each poller's cadence `[inferred]`; the 2x factor itself is undocumented (`polling-provider.component.tsx:66`). |
| Overlay colours and traffic-light geometry | Hard-coded literals in `electron-entry.ts` matched by hand to `index.css` and Tailwind classes | Read from the renderer at runtime | "No runtime theme switching yet" (`electron-entry.ts:98-100`). |
| Settings page composition | Host page rendering sections owned by other leaves; update rows call `window.hyveon.iac.settings` directly | Route every call through `api.*`; one component per section owning its own bridge calls | Unknown; direct calls predate or bypass the facade `[inferred]`. |

## Open Questions & Future Decisions

### Resolved

1. ✅ Windows `titleBarOverlay` height: 56 px, matching the header's `h-14` (archived `add-custom-title-bar/design.md` Open Questions; implemented at `electron-entry.ts:113`).
2. ✅ Linux button glyphs: `lucide-react` `Minus`, `Square`/`Copy`, `X` (same Open Questions; `window-chrome.component.tsx:2,96-116`).
3. ✅ Region source for the cloud bindings: every store resolves its region through `config.getRegion()`, never `outputs.awsRegion`, because an install has one region (`IAC-ENGINE-REGION-002`; `docs/high-level-design.md`, decision 10).

### Deferred

1. Undeclared Tailwind tokens: should `--color-accent`, `--color-background` and `--color-muted` be declared in `index.css`'s `@theme`, or the classes replaced, so hover fills and the LIVE pill background render (`index.css:5-44`; `window-chrome.component.tsx:94,102`, `app-layout.component.tsx:40,118`, `app-topbar.component.tsx:59,107`)?
2. First-run gate: is fail-open the intended policy for a rejected `wizard.getState()` as well as for a missing bridge, and if so should the operator be told that setup state could not be read (`app.component.tsx:40-54`)? Sweep-3 filed this as a bug; the code documents it as deliberate.
3. Should main-process failure paths in `electron-entry.ts:49,199,222,243` log through winston so they reach the log file?
4. Should the overlay colours and traffic-light geometry come from one shared source, or be pinned to `index.css` and the Tailwind layout by a test (`electron-entry.ts:60-70,113`; `index.css:11-21`)? The `electron-entry.ts:96-100` comment also names `--color-surface` where `index.css` uses `--color-card` for the header.
5. Which file is authoritative for tokens, `DESIGN.md` or `index.css` (`DESIGN.md:23` vs `index.css:21`; `--color-card` missing from `DESIGN.md`)?
6. Should an `api.env()` failure render distinctly from a genuine `local` environment in the env pill (`app-layout.component.tsx:28-34`)?
7. Pre-apply run lock: `cloud-provider.module.ts:174-175` lets `AwsRunRecordStore` resolve its table before the first apply, but whether `RunService` takes the lock pre-apply is open in `iac/run`. Is the store-side fallback sufficient?
8. Should the secrets-store binding resolve credentials once per call instead of twice (`cloud-provider.module.ts:199-200`)?
9. Test gaps: `resolveDiscordConfigStoreConfig` has no test in `cloud-provider.module.test.ts`, and `electron-entry.test.ts` asserts neither the external-link redirect nor the `zoom-changed` re-position. Should they be covered?
10. Stale comments: `app.module.ts:43-53` (engine module "no controller yet", missing `FolderUploadModule`, `NativeDialogModule`, `VolumeFilesModule`, `VolumeFilesApiModule`), `polling-provider.component.tsx:256` (`tick` vs `now`), `window-chrome.component.tsx:7` (cites archived design "(D2)"), `electron-clean-quit.spec.ts:11-14` (says `@cdktf/hcl2json` is still external). Fix in place?
11. Duplicate poller names: should `register()` warn or throw instead of silently replacing a same-name poller (`polling-provider.component.tsx:154-157`)? Relatedly, after a same-name re-registration the old run's `finally` clears `inFlight` on the new entry (`:146-148`), which appears able to admit a concurrent fetch `[inferred]`.
12. Should polling pause while the window is hidden or minimised? No visibility handling exists in `polling-provider.component.tsx`.
13. Drag regions: collapse the inline `WebkitAppRegion` styles and `useAppRegionStyle` into one mechanism, and rename the helper since it is not a hook (`use-app-region-style.hook.ts:16-18`; `app-layout.component.tsx:51,71-75`; `window-chrome.component.tsx:89`)? The inline `no-drag` styles also skip the bridge check the helper performs.
14. Branding: should the sidebar say "Game Servers" or "Hyveon", and should the duplicated brand block be extracted (`app-layout.component.tsx:77-82,108-113`; `app-topbar.component.tsx:112`)?
15. Navigation: replace positional `monitoringItems[n]` and the `startsWith('//')` Dashboard check with explicit items (`app-nav.component.tsx:87-113`)?
16. Dead and duplicated primitives: remove `dropdown-menu.component.tsx` (no importer) and merge `button.component.tsx`'s `stop` into `destructive` (`:13-14,25-26`)? Sweep-2 also reports the input class string copied into `native-select` and `textarea` `[unverified]`.
17. Relative-time formatting: `polling-indicator.component.tsx:96-102` has its own formatter separate from `use-log-tail.hook.ts`; should they share one helper (`lib/format.utils.ts`)?
18. Should the Settings update rows go through the `api.*` facade like the rest of the renderer instead of calling `window.hyveon.iac.settings` directly (`settings.page.tsx:150,161,181,205,222,237`)?
19. Linux native title bar: the archived design names migrating Linux to Electron's native `titleBarOverlay` as a future change (D3). Is that still planned, and would it retire `WindowControls` and the `window.*` request channels?
20. Is the decorative "OP" avatar (`app-topbar.component.tsx:122-129`) compatible with "the chrome exposes no non-functional controls"? It is `aria-hidden` and not a control, but it implies an account feature that does not exist.

## References

- Arrow doc: `docs/arrows/operator-app/desktop-shell.md`
- EARS specs: `docs/intent/operator-app/desktop-shell/desktop-shell-specs.md`
- OpenSpec (owned): `openspec/specs/custom-title-bar/spec.md`, `openspec/specs/app-icon/spec.md`
- OpenSpec (cited, UI-integrity requirements only): `openspec/specs/desktop-only-operator-surface/spec.md`
- Archived design: `openspec/changes/archive/2026-08-14-add-custom-title-bar/design.md`
- Active change touching the Settings host: `openspec/changes/add-user-initiated-update-install/` (primary leaf `app-update-and-release`)
- Rules: `.claude/rules/logging.md`
- Design system: `app/packages/web/DESIGN.md`, `app/packages/web/src/index.css`
- Docs pages: `docs/docs/components/management-app.md`, `docs/docs/app/index.md`, `docs/docs/app/settings.md`, `docs/docs/architecture.md`
- Neighbouring leaf designs: `docs/intent/operator-app/ipc-bridge/ipc-bridge-design.md`, `docs/intent/operator-app/wizard-and-bootstrap/wizard-and-bootstrap-design.md`, `docs/intent/operator-app/diagnostics/diagnostics-design.md`, `docs/intent/operator-app/app-update-and-release/app-update-and-release-design.md`, `docs/intent/iac/engine/engine-design.md`, `docs/intent/game-runtime/task-and-dns/task-and-dns-design.md`, `docs/intent/game-runtime/watchdog/watchdog-design.md`, `docs/intent/deployment-config/deployment-config-design.md`
