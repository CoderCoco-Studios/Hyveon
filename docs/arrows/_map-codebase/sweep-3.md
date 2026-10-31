# Sweep 3 — `app/packages/web/src/` (excluding `components/`)

Scope: 80 tracked files enumerated with `git ls-files app/packages/web/src | grep -v '^app/packages/web/src/components/'` (13,491 lines). All 80 read.

## app/packages/web/src (root files)

```yaml
- path: app/packages/web/src/main.tsx
  purpose: Renderer entry point — installs error/console forwarding, mounts <App/> inside StrictMode + ErrorBoundary.
  exports: none (side-effect module)
  dependencies: react, react-dom/client; ./app.component (App); ./components/error-boundary.component (ErrorBoundary); ./lib/report-renderer-error.utils (installGlobalErrorReporting, installConsoleForwarding); ./index.css
  data_shapes: none
  side_effects: wraps console.*, adds window error/unhandledrejection listeners, starts a 2s flush interval (via lib), renders into #root
  role: entry point / bootstrap
  observations:
    - createRoot passes `onCaughtError: () => undefined` to suppress React's duplicate console.error of boundary-caught errors that console forwarding would otherwise re-log (main.tsx:10-16).
    - Non-null assertion on `document.getElementById('root')!` (main.tsx:10).

- path: app/packages/web/src/app.component.tsx
  purpose: Root component — gates the app behind the first-run wizard, then renders HashRouter routes inside polling + game-status providers.
  exports: default App; (internal) useWizardCompleted hook
  dependencies: react-router-dom (HashRouter, Routes, Route); components/app-layout (AppLayout); all 12 pages under ./pages; polling/PollingProvider, polling/GameStatusProvider; components/ui/sonner (Toaster); components/first-run-wizard (FirstRunWizard); window.hyveon.wizard.getState
  data_shapes: `{ wizardCompleted: boolean }` from wizard.getState
  side_effects: IPC wizard.getState once on mount
  role: UI root component / router
  observations:
    - Fail-open: missing bridge or missing `.wizard` namespace → lazy initial state `true` (skip wizard); rejection → `true` (app.component.tsx:39-53).
    - Optional chaining on `window.hyveon?.wizard` is deliberate for chromium-e2e stub bridges that lack `.wizard` (app.component.tsx:33-40).
    - Returns `null` while the wizard check is in flight (app.component.tsx:87).
    - `onComplete` flips local state rather than re-fetching wizard state (app.component.tsx:81-88).
    - HashRouter chosen over BrowserRouter because packaged renderer loads via `file:///C:/...` (app.component.tsx:71-77).
    - Routes: `/`, `/costs`, `/discord`, `/logs`, `/logs/infrastructure`, `/iac`, `/iac/history`, `/iac/history/:runId`, `/settings`, `/games`, `/games/:name`, `/audit` (app.component.tsx:97-108).
    - Providers (Polling, GameStatus) only mount after the wizard is complete — nothing polls pre-bootstrap (app.component.tsx:65-68, 91-92).

- path: app/packages/web/src/app.component.test.tsx
  purpose: Tests the first-run gate.
  role: test (jsdom)
  observations: Pins: no bridge → shell immediately; bridge without `.wizard` → shell; in-flight → empty DOM; completed → shell; not completed → wizard; rejected → shell (fail-open); wizard onComplete → shell without refetch. All children mocked (app.component.test.tsx:11-38). Mocks do not include `./pages/infrastructure-logs.page.js` (real module loaded).

- path: app/packages/web/src/api.service.ts
  purpose: Typed facade over the `window.hyveon` IPC bridge; re-exports shared/preload types and declares web-only DTOs.
  exports: `api` object (env, games, status, statusGame, start, stop, costsEstimate, filesMgrStatus/Start/Stop, folderPick/Rescan/GetSelection/SetSelection/ClearSelection/StartUpload/CancelUpload/ConfirmOverwrite/GetProgress/CleanupStrayHelpers/OnProgress, createGame/updateGame/deleteGame, getGameDraft/saveGameDraft/updateGameDraftStepIndex/clearGameDraft, discordConfig/SaveCredentials/AddGuild/RemoveGuild/RegisterCommands/SaveAdmins/SavePermission/DeletePermission, diagnosticsTail/LogPath/ExportBundle/ShowInFolder, drift, audit, cloudHealthList/Fix/DownloadPolicy/OpenPolicyConsole); interfaces GameStatus, ActionResult, GameEstimate, CostEstimates, GameWizardDraft, StoredGameWizardDraft, FileMgrStatus, FileMgrCredentials, FileMgrResult, DiscordAction, DiscordAdmins, DiscordGamePermission, DiscordConfigRedacted, DiscordMutationResult, EnvInfo; type re-exports of ~30 @hyveon/shared types (GameServer*, GameWrite*, Drift*, Audit*), @hyveon/shared/folderUpload types, @hyveon/desktop-preload CloudHealth*/OpenConsoleResult.
  dependencies: @hyveon/shared, @hyveon/shared/folderUpload, @hyveon/desktop-preload (types only); window.hyveon bridge namespaces env, games(+draft), costs, files, folderUpload, discord, diagnostics, drift, audit, cloudHealth
  data_shapes: GameStatus.state 'running'|'starting'|'stopped'|'not_deployed'|'error'; DiscordConfigRedacted with botTokenSet/publicKeySet booleans, baseAllowedGuilds/baseAdmins, interactionsEndpointUrl; GameWizardDraft (ports, volumes, file_seeds, environment, command, pinnedHostname?, https, webPort?, healthCheck{… authType none|raw|basic|bearer, secretSet})
  side_effects: IPC (every method)
  role: renderer API client / IPC facade
  observations:
    - Header states no fetch/no bearer token — IPC only (api.service.ts:1-4).
    - `hyveon()` throws if bridge absent; every wrapper `async` so the throw becomes a rejection (api.service.ts:263-280).
    - `folderOnProgress` is deliberately synchronous to return the unsubscribe handle (api.service.ts:308-310).
    - `GameWizardDraft` comment says "Mirrors `WizardDraft` in components/add-game-wizard/wizard-form.utils.ts … keep this copy in sync" — a flagged duplication per .claude/rules/duplication.md (api.service.ts:141-143).
    - Casts on getGameDraft (preload has optional `ports[].visibility`) and discord config/permissions (`string[]` vs `DiscordAction[]`) (api.service.ts:273-276, 314-316, 323-353).
    - FileMgrStatus doc comment references `GET /api/files/:game` — stale HTTP-era wording (api.service.ts:187).
    - FileMgrResult.credentials: one-time plaintext FileBrowser credential shown once (api.service.ts:195-205).
    - Not every bridge namespace is wrapped here: logs, iac/pulumi, settings, wizard, deploymentConfig, awsProfile etc. are called directly via window.hyveon by hooks/pages.

- path: app/packages/web/src/api.service.test.ts
  purpose: Tests `api.*` delegation to window.hyveon namespaces.
  role: test (vitest)
  observations: Pins each wrapper's bridge method + args; `costsActual` must not exist (api.service.test.ts:124-126); folderOnProgress returns unsubscribe synchronously; missing bridge → rejection with "window.hyveon IPC bridge is unavailable". Does not cover cloudHealth*, diagnosticsExportBundle/ShowInFolder, or draft methods. Mock includes `logs`, `listGuilds`, `getAdmins`, `getPermissions` that api.service doesn't call.

- path: app/packages/web/src/globals.d.ts
  purpose: Side-effect import of @hyveon/desktop-preload to pull in the `Window.hyveon` augmentation.
  exports: none
  role: type declaration
  observations: Explicitly forbids hand-declaring `interface Window` here (globals.d.ts:7-8).

- path: app/packages/web/src/window.d.ts
  purpose: Comment-only placeholder pointing to globals.d.ts.
  role: type declaration (empty)
  observations: 2 lines, no code — vestigial file (window.d.ts:1-2).

- path: app/packages/web/src/testing-matchers.d.ts
  purpose: Pulls @testing-library/jest-dom/vitest matcher types into the package's tsc program.
  role: type declaration
  observations: Duplicates vitest.d.ts — both do `import '@testing-library/jest-dom/vitest'` with near-identical explanatory comments (testing-matchers.d.ts:15, vitest.d.ts:13).

- path: app/packages/web/src/vitest.d.ts
  purpose: Same jest-dom matcher type augmentation as testing-matchers.d.ts.
  role: type declaration
  observations: Duplicate of testing-matchers.d.ts (see above); lacks `export {}`.

- path: app/packages/web/src/vite-env.d.ts
  purpose: `/// <reference types="vite/client" />`.
  role: type declaration

- path: app/packages/web/src/index.css
  purpose: Tailwind v4 entry + design tokens + legacy CSS vars and button classes.
  exports: CSS tokens `--color-*` (bg, surface, surface-2, border, card, foreground, muted-foreground, primary, primary-light, cyan, cyan-light, orange, pink, green, amber, red), `--font-ui` (Outfit), `--font-mono` (DM Mono), `--radius-*`; legacy `--bg`, `--surface`, … ; classes .btn-sm/.btn-start/.btn-stop/.btn-secondary
  dependencies: tailwindcss, tw-animate-css
  role: stylesheet
  observations:
    - `--color-card` (#1a1d2e) exists to match Electron `titleBarOverlay` colour hard-coded in electron-entry.ts — cross-file coupling (index.css:11-17).
    - Legacy vars and global `button` styles retained "for unmigrated components" (index.css:46-59, 81-99); global `button {border:none; padding…}` applies to every button.
    - Token values duplicated between @theme and :root legacy block.
    - prefers-reduced-motion clamps all animations/transitions (index.css:73-79).
```

## app/packages/web/src/lib

```yaml
- path: app/packages/web/src/lib/ansi.utils.ts
  purpose: Parse ANSI-escaped terminal lines into styled segments; strip ANSI.
  exports: AnsiSegment, FG_COLOR_CLASS, parseAnsiLine, stripAnsi
  dependencies: none
  data_shapes: AnsiSegment { text, bold, colorClass: string|null }
  side_effects: none (pure)
  role: utility
  observations:
    - Single regex handles CSI, OSC, nF/Fp escapes; non-SGR sequences discarded; truncated escapes left as text (ansi.utils.ts:34).
    - Only 16 standard fg colours mapped to design tokens; 38/48 extended colour params consumed but ignored (ansi.utils.ts:41-58, 95-102).
    - Adjacent identical-style segments coalesced (ansi.utils.ts:127-135).
- path: app/packages/web/src/lib/ansi.utils.test.ts
  role: test
  observations: Pins SGR colour/bold/reset, combined `1;31`, ignore unknown codes, drop cursor/clear-line/DEC private/OSC/nF/Fp sequences, coalescing, 256/truecolor ignored, truncated sequence preserved; stripAnsi equivalents.

- path: app/packages/web/src/lib/bridge.utils.ts
  purpose: Two user-facing "bridge unavailable" string constants.
  exports: BRIDGE_UNAVAILABLE, SETTINGS_BRIDGE_UNAVAILABLE
  role: constants
  observations: Two wordings of the same message kept deliberately to avoid an unreviewed UI string change (bridge.utils.ts:4-8). A third wording lives in api.service.ts:267.

- path: app/packages/web/src/lib/confirm-skip.utils.ts
  purpose: Session-scoped "don't ask again" set for confirmation dialogs.
  exports: isSuppressed, suppress
  side_effects: module-level mutable Set (resets on reload)
  role: utility (state)

- path: app/packages/web/src/lib/format.utils.ts
  purpose: Formatting helpers.
  exports: formatTimestamp, formatUsd, formatBytes, formatDuration
  side_effects: none
  role: utility
  observations: formatUsd pins `en-US` locale so `.` decimal is OS-independent; `precise` uses 4 digits below $1 (format.utils.ts:7-24). formatBytes binary units (format.utils.ts:27-37).

- path: app/packages/web/src/lib/report-renderer-error.utils.ts
  purpose: Forward renderer errors and console output to the main-process log via the diagnostics bridge.
  exports: reportRendererError, installGlobalErrorReporting, installConsoleForwarding
  dependencies: @hyveon/desktop-preload types (RendererConsoleLevel, RendererLogEntry); window.hyveon.diagnostics.reportError / reportLog
  data_shapes: RendererLogEntry { level, message }; reportLog(entries, droppedCount?)
  side_effects: IPC, window event listeners, console monkey-patching, setInterval(2s)
  role: utility / diagnostics
  observations:
    - Constants: flush every 2000 ms, ≤50 entries/flush, queue cap 200 (report-renderer-error.utils.ts:14-20).
    - In-flight entries reserved against queue cap so failed batches can be requeued at the front (oldest-first) (report-renderer-error.utils.ts:33, 67-85).
    - `flushInFlight` gate prevents a newer batch submitting while older one pending (report-renderer-error.utils.ts:42, 97-100).
    - Bridge missing at flush tick → queue kept, nothing sent (report-renderer-error.utils.ts:104-107).
    - Capacity check precedes JSON.stringify so dropped calls pay no serialization cost (report-renderer-error.utils.ts:67-72).
    - isErrorLike duck-types cross-realm errors (report-renderer-error.utils.ts:4-11); but installGlobalErrorReporting's unhandledrejection path uses `instanceof Error` (report-renderer-error.utils.ts:171-172) — inconsistent with the duck-typing elsewhere.
    - installConsoleForwarding is idempotent via module flag; no-op if bridge absent at install time (report-renderer-error.utils.ts:177-193). installGlobalErrorReporting is not idempotent (adds listeners every call).
    - setInterval handle never cleared (report-renderer-error.utils.ts:208).
- path: app/packages/web/src/lib/report-renderer-error.utils.test.ts
  role: test
  observations: Pins reportError delegation and rejection swallowing; window error / unhandledrejection forwarding; console forwarding batching (50/flush), queue cap 200 + dropped count, requeue on reject/sync throw, in-flight reservation, no concurrent flush, bridge disappearance tolerance, cross-realm Error via node:vm, hostile getter safety, no stringify for dropped calls. Uses vi.resetModules + dynamic import to reset module state.

- path: app/packages/web/src/lib/rollback-diff.utils.ts
  purpose: One-sentence summary of a DeploymentConfigDiff for the rollback confirmation dialog.
  exports: formatDiffSummary
  dependencies: @hyveon/shared DeploymentConfigDiff
  role: utility
  observations: Empty diff → "No configuration differences detected." (rollback-diff.utils.ts:43-45); doc refers to `RollbackAction` (in components/) for the optional-diff contract (rollback-diff.utils.ts:8-10).
- path: app/packages/web/src/lib/rollback-diff.utils.test.ts
  role: test
  observations: Pins empty-diff sentence, combined sentence format, singular "game server", fields-only, servers-only.

- path: app/packages/web/src/lib/snowflake.utils.ts
  purpose: Re-export isSnowflake from @hyveon/shared; parseSnowflakes bulk-paste splitter.
  exports: isSnowflake, parseSnowflakes
  role: utility
  observations: See duplication with pages/discord/snowflake.utils.ts.

- path: app/packages/web/src/lib/utils.utils.ts
  purpose: `cn()` Tailwind class merge (clsx + tailwind-merge).
  exports: cn
  role: utility (shadcn convention)
```

## app/packages/web/src/hooks

```yaml
- path: app/packages/web/src/hooks/use-app-region-style.hook.ts
  purpose: Returns `{WebkitAppRegion: mode}` style only when `window.hyveon.window` exists (Electron custom title bar drag regions).
  exports: useAppRegionStyle(mode: 'drag'|'no-drag')
  dependencies: window.hyveon.window (presence check only)
  side_effects: none
  role: React hook (pure, not really a hook — no React hooks inside)
  observations: Named as a hook but calls no React hooks (use-app-region-style.hook.ts:16-18).

- path: app/packages/web/src/hooks/use-click-outside.hook.ts
  purpose: Close a popover on outside mousedown or Escape.
  exports: useClickOutside(ref, onClose, enabled)
  side_effects: document mousedown/keydown listeners while enabled
  role: React hook
- path: app/packages/web/src/hooks/use-click-outside.hook.test.ts
  role: test
  observations: Pins outside-mousedown closes, inside-child doesn't, Escape closes, other keys don't, disabled attaches nothing, unmount and enabled→false remove listeners.

- path: app/packages/web/src/hooks/use-copied-reset.hook.ts
  purpose: Transient "copied" flag auto-reset after `resetMs` (default 1500).
  exports: useCopiedReset
  side_effects: setTimeout (cleared on unmount / re-arm)
  role: React hook

- path: app/packages/web/src/hooks/use-deployment-settings.hook.ts
  purpose: Load/validate/save state machine for top-level DeploymentConfig settings (everything except gameServers).
  exports: SettingsDraft, LoadState, UseDeploymentSettingsResult, useDeploymentSettings
  dependencies: @hyveon/shared (DEPLOYMENT_CONFIG_DEFAULTS, validateDeploymentSettingsPatch, DeploymentSettingsGetResult, DeploymentSettingsValidationIssue, TopLevelDeploymentSettings); sonner toast; lib/bridge.utils BRIDGE_UNAVAILABLE; window.hyveon.iac.settings.get/update
  data_shapes: SettingsDraft (all strings / string[]: projectName, awsRegion, vpcCidr, hostedZoneName, dnsTtl, watchdogIntervalMinutes, watchdogIdleChecks, watchdogMinPackets, baseAllowedGuilds, baseAdminUserIds, baseAdminRoleIds, discordApplicationId, auditTableName, runsTableName); update({patch, expectedVersionId}) → ok|validation|conflict|setup_incomplete|error
  side_effects: IPC iac.settings.get/update; toast on success
  role: React hook (state machine)
  observations:
    - Always sends last-read etag as expectedVersionId; refuses to save if etag is falsy to avoid an unconditional overwrite (use-deployment-settings.hook.ts:22-32, 299-316).
    - Live client validation uses the same shared validateDeploymentSettingsPatch the server runs (use-deployment-settings.hook.ts:14-18, 287).
    - Server-reported issues override live issues until next edit (use-deployment-settings.hook.ts:280-288).
    - draftFromSettings defends against incomplete IPC payloads with DEPLOYMENT_CONFIG_DEFAULTS; hostedZoneName falls back to '' (use-deployment-settings.hook.ts:116-139).
    - mountedRef re-armed in effect body (StrictMode-correct) (use-deployment-settings.hook.ts:206-212).
    - Bridge guard checks `window.hyveon?.iac?.settings` because the chromium e2e HTTP bridge shim lacks `iac` (use-deployment-settings.hook.ts:171-184).
    - Doc says "see the module doc's empty-string-means-computed-default handling" but the module doc contains no such section — dangling reference (use-deployment-settings.hook.ts:148-150).
    - No dedicated test file in scope.

- path: app/packages/web/src/hooks/use-diagnostics-tail.hook.ts
  purpose: Polls diagnostics.tail + diagnostics.path every 5 s with pause/resume of rendering.
  exports: UseDiagnosticsTailResult, useDiagnosticsTail
  dependencies: api.diagnosticsTail, api.diagnosticsLogPath
  side_effects: IPC polling (setInterval 5000)
  role: React hook
  observations:
    - Pausing does not stop polling; snapshots are stashed in a ref and applied whole on resume (snapshot not delta) (use-diagnostics-tail.hook.ts:27-35, 58-60, 95-104).
    - Sequence counter discards out-of-order responses (use-diagnostics-tail.hook.ts:50, 54-57).
    - Errors suppressed while paused (use-diagnostics-tail.hook.ts:67-70).
    - Own setInterval rather than PollingProvider registry.
    - Doc says "last 500 lines" — count is set server-side, not here (use-diagnostics-tail.hook.ts:23-24).

- path: app/packages/web/src/hooks/use-file-manager.hook.ts
  purpose: FileBrowser helper-task lifecycle for the file-manager modal (open/close/start/stop + reactive polling).
  exports: FILE_MANAGER_POLLER ('filemgr'), FILE_MANAGER_INTERVAL_MS (5000), useFileManager
  dependencies: api.filesMgrStatus/Start/Stop; polling-provider usePollingActions().register
  data_shapes: FileMgrStatus, FileMgrCredentials
  side_effects: IPC files.list/start/stop; registers poller in PollingProvider
  role: React hook
  observations:
    - Poller registered only while transitioning (status 'starting' or pendingStart/pendingStop) (use-file-manager.hook.ts:123-136).
    - pendingStart/pendingStop cover ECS eventual-consistency windows after runTask/stopTask (use-file-manager.hook.ts:16-27).
    - Credentials held separately from status so polling doesn't wipe them; cleared on stop/close/open (use-file-manager.hook.ts:39-44, 82, 94, 115).
    - gameRef synced in effect (not during render) (use-file-manager.hook.ts:48-55).
    - fetchOnce / start / stop have no try/catch — an IPC rejection becomes an unhandled promise (`void fetchOnce`) (use-file-manager.hook.ts:57-59, 83, 97-118).
    - No explicit return type (use-file-manager.hook.ts:32).
- path: app/packages/web/src/hooks/use-file-manager.hook.test.ts
  role: test
  observations: Pins initial nulls, open fetches status, close clears, start/stop no-op without active game, message from API even on failure, credentials stored only on success and cleared on close, poller registered for 'starting' only, not for 'stopped'.

- path: app/packages/web/src/hooks/use-game-actions.hook.ts
  purpose: Start/Stop orchestration for a game card with toasts, Undo-on-stop, and delayed refresh.
  exports: UseGameActionsResult, useGameActions(game, onRefresh)
  dependencies: api.start/stop; sonner toast
  side_effects: IPC games.start/stop; toasts; setTimeout 3000 ms refresh
  role: React hook
  observations:
    - Refresh always scheduled even on failure so card isn't left disabled (use-game-actions.hook.ts:68-71, 110-112).
    - Stop toast has 5 s "Undo" action that calls api.start (use-game-actions.hook.ts:85-104); on early `return` for !success the finally still schedules refresh.
    - Undo success schedules refresh but does not set busy=true (use-game-actions.hook.ts:96).

- path: app/packages/web/src/hooks/use-iac-run.hook.ts
  purpose: Plan/apply/destroy run submission state machine + live log streaming via iac.runs.streamLogs.
  exports: Conflict type ('preview'|'up'|'destroy'|'rollback'), RunLogState, UseIacRunResult, useIacRun(kind); internal useIacRunLog
  dependencies: @hyveon/shared errMessage; @hyveon/desktop-preload types (HyveonStreamHandle, IacPlanAck, IacRunKind, IacRunChunk, IacRunRecord, IacStaleLockInfo, RunDetailStatus, RunLock); lib/bridge.utils; window.hyveon.iac.runs.streamLogs/get
  data_shapes: IacPlanAck {started, runId?, conflict?, staleLock?, runLock?, error?}; runs.get → {found, status, record?}
  side_effects: IPC stream + runs.get
  role: React hook
  observations:
    - CHUNK_WINDOW_SIZE 300 "mirrors WINDOW_SIZE in use-log-tail.hook.ts" — duplicated constant flagged by comment (use-iac-run.hook.ts:23-24).
    - Log state tagged by runId so a run switch discards old output at render time; late chunks from a superseded stream ignored (use-iac-run.hook.ts:55-93).
    - Stream errors surfaced in log.error separately from run failure (use-iac-run.hook.ts:101-109).
    - After stream end, runs.get fetches terminal status; `found:false` → error for every kind (use-iac-run.hook.ts:198-220).
    - submit resets record to null on every submission (use-iac-run.hook.ts:228-233); unified from previously-duplicated per-kind copies (use-iac-run.hook.ts:168-175).
    - reset() doesn't clear inFlight (use-iac-run.hook.ts:256-264).
    - Conflict doc says values are `preview`/`up` but the type also lists destroy/rollback (use-iac-run.hook.ts:15-21).

- path: app/packages/web/src/hooks/use-log-tail.hook.ts
  purpose: Shared live-tail engine for game and Lambda logs — snapshot + stream, pause/buffer, autoscroll, age label, windowed live/historical viewport with backward/forward paging.
  exports: LogLine, LogTailApi, NO_HYVEON_LOG_TAIL_API, UseLogTailResult, useLogTail(target, api)
  dependencies: @hyveon/shared errMessage; @hyveon/desktop-preload types (HyveonStreamHandle, LogChunk, LogEventLine, NewerLogsPage, OlderLogsPage); lib/bridge.utils; ./use-now-tick
  data_shapes: LogLine {text, receivedAt, timestamp?, eventId?}; getOlder → {lines, atOldest}; getNewer(target, after, limit, excludeEventIds) → {lines, hasMore}
  side_effects: IPC via injected api (window.hyveon.logs or logs.lambda); 10 s tick
  role: React hook (engine)
  observations:
    - WINDOW_SIZE 300, AGE_TICK_MS 10000, bottom pin 24px, near-top 50px (use-log-tail.hook.ts:16-21).
    - Live lines buffered (capped 300) while paused or in historical mode (use-log-tail.hook.ts:259-273).
    - Scroll near top → loadOlder enters historical mode, records liveInterruptedAt, prepends older page, evicts from bottom (use-log-tail.hook.ts:386-428).
    - Forward cursor derived from current newest-visible line with eventId multiset exclusion (mirrors LogsService.fetchAcrossStreams) — fixes a stale-scalar gap bug (use-log-tail.hook.ts:430-460).
    - Forward paging never switches back to live; only jumpToLatest does, discarding the buffer (use-log-tail.hook.ts:470-472, 547-576).
    - Resume from pause in historical mode does not flush buffer (use-log-tail.hook.ts:582-594).
    - windowGenerationRef discards stale getOlder/getNewer/jump results (use-log-tail.hook.ts:250-257).
    - Initial get failure → error "Could not load initial logs; trying live stream." and still streams (use-log-tail.hook.ts:346-350).
    - Target-change effect calls setState inside an async IIFE at its top, before any await (use-log-tail.hook.ts:325-332) — effectively synchronous-in-effect setState.
    - Doc references "design.md D6" (an OpenSpec change design) (use-log-tail.hook.ts:149).
    - formatAge here is a local relative-time formatter; other relative-time formatting lives elsewhere (polling-indicator) — possible duplication.
- path: app/packages/web/src/hooks/use-log-tail.hook.test.ts
  role: test
  observations: Pins snapshot seed + stream on mount, empty target no-op, pause buffer/flush, target-change reset + cancel, get-reject still streams, stream error message, historical mode entry/prepend, getOlder boundary from snapshot timestamp, bottom eviction at 300, atOldest stops calls, live buffering in historical mode, getNewer boundary + excludeEventIds, repeated forward paging, jumpToLatest discards buffer, target change resets mode, stale getOlder discarded after target change / jumpToLatest, "Bug 2 regression" forward cursor after eviction (use-log-tail.hook.test.ts:422).

- path: app/packages/web/src/hooks/use-now-tick.hook.ts
  purpose: Returns Date.now() refreshed every intervalMs.
  exports: useNowTick
  side_effects: setInterval
  role: React hook

- path: app/packages/web/src/hooks/use-run-history.hook.ts
  purpose: Paged fetch of IaC run history with status filter (server-side via status-index GSI).
  exports: StatusFilter, UseRunHistoryResult, useRunHistory
  dependencies: @hyveon/desktop-preload RunHistoryRecord/RunHistoryStatus; window.hyveon.iac.runs.list; lib/bridge.utils
  data_shapes: list({limit:25, before?, status?}) → {records, nextBefore?}
  side_effects: IPC
  role: React hook
  observations:
    - Page state tagged with its filter so a filter change invalidates at render time (use-run-history.hook.ts:29-48).
    - requestSeqRef guards stale load-more results; loadingMore cleared unconditionally in finally (fixed stuck-disabled bug) (use-run-history.hook.ts:58, 110-119).
    - Error messages lose the underlying error (catch ignores err) (use-run-history.hook.ts:74-84, 106-109).
- path: app/packages/web/src/hooks/use-run-history.hook.test.ts
  role: test
  observations: Pins first-page fetch limit 25, loadMore with `before`, filter refetch, stale loadMore discarded, loadingMore cleared after supersession.
```

## app/packages/web/src/polling

```yaml
- path: app/packages/web/src/polling/polling-provider.component.tsx
  purpose: Named-poller registry with split contexts (stable actions vs. 1 Hz state), staleness helper, and usePoller subscription hook.
  exports: PollerState, STALE_MULTIPLIER (2), PollingProvider, usePollingActions, usePollingState, usePoller(name, fn, intervalMs, enabled?), isStale(state, now?)
  dependencies: react; ../hooks/use-now-tick
  data_shapes: PollerState {intervalMs, firstAttemptAt, lastSuccessAt, lastAttemptAt, loading, error}; internal fnsRef entry {fn, intervalMs, timerId, inFlight, regId: symbol}
  side_effects: setInterval per poller; 1 Hz heartbeat
  role: React context provider / polling infrastructure
  observations:
    - runOne skips if in flight and resets the interval timer on every run (manual or automatic) so "next refresh in" is accurate (polling-provider.component.tsx:113-118).
    - Errors are swallowed into per-poller `error` (polling-provider.component.tsx:140-145).
    - register replaces a same-named prior registration and runs immediately; cleanup keyed on a stable Symbol regId (fixes a former timerId-comparison leak) (polling-provider.component.tsx:152-195).
    - Re-registration preserves firstAttemptAt/lastSuccessAt/lastAttemptAt (polling-provider.component.tsx:168-178).
    - isStale uses firstAttemptAt for never-succeeded pollers so a perpetually failing poller still goes stale (polling-provider.component.tsx:303-315).
    - Doc for usePollingState says "`pollers` + `tick`" but the field is `now` — stale wording (polling-provider.component.tsx:255-256).
    - Two pollers may not share a name; later registration silently takes over.
- path: app/packages/web/src/polling/polling-provider.component.test.ts
  role: test
  observations: Pins isStale only: undefined → false, pre-first-attempt false, strict `>` at 2× boundary, never-succeeded measured from firstAttemptAt, retries don't defer staleness.

- path: app/packages/web/src/polling/game-status-provider.component.tsx
  purpose: App-wide game status + cost estimate context; registers the 'status' poller.
  exports: GAME_STATUS_POLLER ('status'), GAME_STATUS_INTERVAL_MS (20000 or VITE_STATUS_POLL_MS ≥1000), GameStatusProvider, useGameStatus
  dependencies: api.status, api.statusGame, api.costsEstimate; ./polling-provider usePoller
  data_shapes: {statuses: GameStatus[], estimates: CostEstimates|null, loading, error, refresh, refreshGame}
  side_effects: IPC games.status polled; costs.estimate once on mount
  role: React context provider
  observations:
    - Build-time env override VITE_STATUS_POLL_MS (game-status-provider.component.tsx:16-29) — raw import.meta.env read in module scope.
    - Rethrows after setting local error so the registry also records it (game-status-provider.component.tsx:71-76).
    - Cost estimates fetched once because costs.estimate calls EcsService.getTaskDefinition per game (game-status-provider.component.tsx:54-58, 84-86); failure swallowed silently.
    - refreshGame replaces only an existing entry; a game not already in `statuses` is never added (game-status-provider.component.tsx:88-91); errors propagate to caller.
- path: app/packages/web/src/polling/game-status-provider.component.test.tsx
  role: test
  observations: Pins status fetched on mount, costsEstimate called exactly once, useGameStatus throws outside provider, loading clears on rejection, error surfaced both locally and on registry poller entry and cleared on next success.

- path: app/packages/web/src/polling/polling-indicator.component.tsx
  purpose: "Updated Xs ago" indicator with spinner, tooltip next-refresh countdown, red Stale pill.
  exports: PollingIndicator({name='status', className})
  dependencies: lucide-react RefreshCw; components/ui/tooltip; lib/utils cn; ./polling-provider (isStale, usePollingState, PollerState)
  side_effects: none
  role: UI component
  observations:
    - Uses provider `now` instead of Date.now() for render purity (polling-indicator.component.tsx:19-23).
    - sr-only stable text separate from per-tick visible text, role="status" aria-live polite (polling-indicator.component.tsx:38-52, 60-73).
    - Local formatAgo duplicates use-log-tail's formatAge with different rounding (round vs floor, no hours) (polling-indicator.component.tsx:96-102 vs hooks/use-log-tail.hook.ts:137-145).
    - Lives in polling/ rather than components/.
- path: app/packages/web/src/polling/polling-indicator.component.test.tsx
  role: test
  observations: Pins "Not polling" for unknown name, "Updated" after poll, registry cleanup on unmount (regId regression), role=status, tooltip "next refresh in Ns".
```

## app/packages/web/src/test-utils

```yaml
- path: app/packages/web/src/test-utils/render-page.utils.tsx
  purpose: Render a routed page inside PollingProvider → GameStatusProvider → MemoryRouter.
  exports: renderPage(ui, {initialEntries?, ...RenderOptions})
  dependencies: @testing-library/react; react-router-dom MemoryRouter; polling providers
  role: test utility
  observations:
    - Doc says "Pair with `vi.mock('../api.js')`" but the module is `api.service.js` — stale reference (render-page.utils.tsx:20).
    - Mentions "without standing up the full Nest server" — legacy HTTP-era wording (render-page.utils.tsx:25).
    - Contract: routed pages only, per-component specs use plain render (render-page.utils.tsx:23-27; cited by .claude/rules/testing-conventions.md).
    - Order differs from production: production nests HashRouter inside providers too, but uses HashRouter vs MemoryRouter here.

- path: app/packages/web/src/test-utils/stream-handle.test-utils.ts
  purpose: Adapt an async generator into a HyveonStreamHandle for mocking streaming bridge methods.
  exports: toStreamHandleMock
  dependencies: @hyveon/desktop-preload HyveonStreamHandle
  role: test utility
  observations: cancel() calls generator.return() so component cleanup really stops the mock stream (stream-handle.test-utils.ts:29-31); references bridgeStream in preload.ts (stream-handle.test-utils.ts:7-8).
```

## app/packages/web/src/pages

```yaml
- path: app/packages/web/src/pages/audit.page.tsx
  purpose: `/audit` — paged table of audit entries (game config mutations) with Load more.
  exports: AuditPage
  dependencies: api.audit; components AuditEntryRow, InlineSpinner, PageHeader, SectionCard, AsyncContent, ui Table/Button; PollingIndicator
  data_shapes: AuditPageResult {entries: AuditEntry[], nextBefore?}; AuditEntry keyed by `sk`
  side_effects: IPC audit.list
  role: routed page
  observations:
    - PAGE_SIZE 25 (audit.page.tsx:19); same pagination shape as useRunHistory but inlined in the page rather than a hook — near-duplicate paging logic (audit.page.tsx:28-80 vs hooks/use-run-history.hook.ts).
    - cancelledRef re-armed false at mount (StrictMode-safe) (audit.page.tsx:44).
    - loadMore has no stale-request guard beyond unmount (audit.page.tsx:63-80).
    - PollingIndicator shown though page doesn't poll audit — it reflects the global 'status' poller (audit.page.tsx:85).
    - Error rendered twice possible: AsyncContent error + inline `{error && <p>}` (audit.page.tsx:89-115).

- path: app/packages/web/src/pages/costs.page.tsx
  purpose: `/costs` — sortable/filterable per-game Fargate cost estimate table + link-out to AWS Cost Explorer.
  exports: CostsPage; internal useEstimatesTable, useCostEstimates, GameSwatch, EstimateCard, EstimateTableRow, CostExplorerCallout, EstimatesTable, SortableHeader
  dependencies: api.costsEstimate; lib/format formatUsd; lib/utils cn; ui Card/Button/Input/Table; PageHeader, SectionCard, AsyncContent, PollingIndicator; lucide icons
  data_shapes: CostEstimates.games Record<game, GameEstimate>
  side_effects: IPC costs.estimate once on mount; external link to console.aws.amazon.com
  role: routed page
  observations:
    - No Cost Explorer API calls — references openspec/changes/remove-cost-explorer-calls and design.md D4 (costs.page.tsx:39-40, 165-168, 186-190).
    - Fetches costs.estimate itself even though GameStatusProvider already holds `estimates` — duplicate IPC fetch (costs.page.tsx:169-183 vs polling/game-status-provider.component.tsx:84-86).
    - Default sort $/hr desc; new column defaults asc for game, desc for numerics (costs.page.tsx:50-100).
    - Game colours assigned by sorted index over 9 tokens (costs.page.tsx:27-37, 198-204).
    - Fetch failure silently leaves an empty state (no error UI) (costs.page.tsx:178).
    - $/day assumes 24 h, $/month 4 h/day × 30 (costs.page.tsx:310).

- path: app/packages/web/src/pages/dashboard.page.tsx
  purpose: `/` — pending-changes banner, KPI strip, filterable GameCard grid, file-manager modal.
  exports: DashboardPage; internal StatusErrorCard, NoGamesCard
  dependencies: useGameStatus; useFileManager; components GameCard, KpiStrip, FileManagerModal, PendingChangesBanner, EmptyStateCard, AsyncContent, ui Input/Button; PollingIndicator
  side_effects: indirect (providers, file manager IPC)
  role: routed page
  observations:
    - Filter matches game name or hostname/publicIp (dashboard.page.tsx:27-34).
    - Error card distinguishes failed fetch from "no games" (dashboard.page.tsx:106-125).
    - Hard-coded docs URL https://codercoco-studios.github.io/Hyveon/setup (dashboard.page.tsx:148).
    - Doc says watchdog lives at `/settings` (dashboard.page.tsx:18-19).

- path: app/packages/web/src/pages/game-detail.page.tsx
  purpose: `/games/:name` — read-only declared config for one game, with Edit toggle, Remove button, folder upload card.
  exports: GameDetailPage; internal Field, ConfigTableCard<T>
  dependencies: api.games; components GameStatusBadges, FolderUploadCard, EditGameForm, PageHeader, RemoveGameButton, ui Button/Card/Table; PollingIndicator
  data_shapes: GameListEntry {name, declared, deployed, drift, config?: GameServer (image, cpu, memory, https, webPort?, ports[{container, protocol, visibility?}], volumes, environment?, file_seeds?, connect_message?)}
  side_effects: IPC games.list
  role: routed page
  observations:
    - Three states: not found / ghost (deployed, no config) / declared (game-detail.page.tsx:86-98).
    - games.list failure collapses into "not found" (setGames([])) — no error message (game-detail.page.tsx:119-121).
    - https games show a separate "Web port" card (Caddy upstream on 443) and the ports table is retitled "Additional ports", hidden when empty (game-detail.page.tsx:201-231).
    - Port visibility 'internal' rendered as "VPC-only" (game-detail.page.tsx:227).
    - Save replaces whole merged list from GameWriteSuccess.games without refetch (game-detail.page.tsx:131-134).
    - Environment variable values rendered in plain text (game-detail.page.tsx:255).

- path: app/packages/web/src/pages/games.page.tsx
  purpose: `/games` — table of declared/deployed games, AddGameWizard entry points, autosaved-draft resume/discard banner.
  exports: GamesPage; internal formatPorts
  dependencies: api.games, api.getGameDraft, api.clearGameDraft; components AddGameWizard, GameStatusBadges, PendingChangesBanner, PageHeader, SectionCard, AsyncContent, ui Table/Button; PollingIndicator
  side_effects: IPC games.list, games.draft.get/clear
  role: routed page
  observations:
    - AddGameWizard mounted up to three times (header, empty state, resumed instance); triggers hidden while resuming so only one instance autosaves into the single `addGameWizardDraft` slot (games.page.tsx:39-69, 145-149, 170-177, 190-194).
    - Resumed draft normalises missing webPort to null (games.page.tsx:172).
    - After resumed wizard closes, draft re-fetched from disk (games.page.tsx:130-137).
    - formatPorts prepends `<webPort> (web)` for https games (games.page.tsx:18-23).
    - Doc mentions "deployed tfstate view" — legacy Terraform wording; infra is Pulumi (games.page.tsx:27-28).
    - handleDiscardDraft has no error handling (games.page.tsx:117-120).
    - JSX block comment inside header is multi-line (games.page.tsx:145-148).

- path: app/packages/web/src/pages/iac-history.page.tsx
  purpose: `/iac/history` — run history table with kind (client-side) and status (server-side GSI) filters, Load more, rollback navigation.
  exports: IacHistoryPage
  dependencies: useRunHistory; components RunHistoryRow, RollbackResult type (rollback-action), InlineSpinner, PageHeader, SectionCard, AsyncContent, ui Button/Table; react-router useNavigate
  side_effects: IPC via hook; navigation to `/iac` with state {configVersionId, rolledBackFrom}
  role: routed page
  observations:
    - Kind filter client-side, status filter server-side (iac-history.page.tsx:29-35, 42).
    - Rollback navigates to `/iac` with RollbackNavState (iac-history.page.tsx:44-50).
    - Status filter options omit 'awaiting_approval' etc. — only success/failed/aborted (iac-history.page.tsx:81-84).
    - Raw `<select>` elements with copied Tailwind class strings (iac-history.page.tsx:63-85) — a pattern flagged in .claude/rules/typescript-conventions.md.
    - Doc references "task 9.5" (iac-history.page.tsx:23-24) — task-number in comment.
    - Imports ui via relative `../components/ui/*.js` path while most pages use `@/components/ui/*`.

- path: app/packages/web/src/pages/iac-run-detail.page.tsx
  purpose: `/iac/history/:runId` — read-only detail for one finished run with log fallback ladder.
  exports: IacRunDetailPage; internal useHistoryRecord, useRunLogLadder, textToChunks
  dependencies: window.hyveon.iac.runs.list/streamLogs/logUrl; global fetch; components AnsiLogViewer, RunStatusBadge, PartialApplyBadge, RolledBackFromLink, ErrorBanner, LoadingState, PageHeader, ChangeSummaryStatus; lib/format formatTimestamp
  data_shapes: RunHistoryRecord {runId, kind, status, startedAt, completedAt, changeSummary, partialApply?, rolledBackFrom?, approvedBy?, approvedAt?, logInline?, logS3Key?}
  side_effects: IPC; network fetch of a presigned S3 URL from the renderer
  role: routed page
  observations:
    - Record lookup scans the newest 200 runs (no get-by-id API) — a run older than that shows "not found" (iac-run-detail.page.tsx:15-22, 49-53).
    - Log ladder: replay stream → record.logInline → presigned URL via logUrl(logS3Key) + fetch → none (iac-run-detail.page.tsx:74-156).
    - Renderer performs an HTTP fetch to S3 — the only network fetch in scope; notable given "no HTTP transport" invariant is about the app's own API (iac-run-detail.page.tsx:143-146).
    - Stream that completes with zero chunks falls through to inline/S3 (iac-run-detail.page.tsx:126-129).
    - Never offers Approve/Apply controls (iac-run-detail.page.tsx:172-177).

- path: app/packages/web/src/pages/iac.page.tsx
  purpose: `/iac` — Pulumi plan → live log → approve → plan-hash-gated apply flow, rollback auto-plan, destroy section.
  exports: IacPage; internal RollbackNavState, isRollbackNavState, APPROVAL_WINDOW_MS, isApprovalExpired, PartialApplyBanner
  dependencies: useIacRun (×2: plan, apply); useNowTick(30s); window.hyveon.iac.plan/approve/apply; @hyveon/shared errMessage; components AnsiLogViewer, ErrorBanner, PageHeader, RolledBackFromLink, DestroySection (iac-destroy-section), SubmissionBanners, ChangeSummaryStatus, ui Button; sonner toast
  data_shapes: IacPlanPayload {configVersionId?, rolledBackFrom?}; approve({planRunId}) → {approved, approvedBy?, approvedAt?, error?}; apply({planRunId, planHash})
  side_effects: IPC; toasts; history.replace to clear location.state
  role: routed page
  observations:
    - APPROVAL_WINDOW_MS (15 min) and isApprovalExpired duplicated from @hyveon/shared/runs.ts "rather than importing @hyveon/shared into the renderer bundle" — yet the same file imports errMessage from @hyveon/shared (iac.page.tsx:6, 41-53). Contradictory justification; a flagged "mirrors X" duplication.
    - Rollback nav state auto-submits a plan once (ref guard) and clears location.state (iac.page.tsx:127-136).
    - Successful (re)plan clears approval and resets apply run (iac.page.tsx:109-125).
    - Apply gated on approval present, not expired, planHash present, no apply run yet (iac.page.tsx:181); backend is authoritative.
    - partialApply checked independently of failed/aborted; shows PartialApplyBanner with "Start over" instead of retry (iac.page.tsx:55-82, 183-190, 304-310).
    - Approve button disabled unless status 'awaiting_approval' (iac.page.tsx:237).
    - useCallback deps use `planRun.submit`/`applyRun.reset` member access (iac.page.tsx:124, 164, 171).
    - Doc mentions destroy is useIacRun's third consumer; here only plan/apply call useIacRun — destroy lives in DestroySection (components/) (iac.page.tsx:99-100; hooks/use-iac-run.hook.ts:166).
    - Multi-line JSX block comment (iac.page.tsx:327-331).

- path: app/packages/web/src/pages/infrastructure-logs.page.tsx
  purpose: `/logs/infrastructure` — live tail of a selected Lambda function's CloudWatch logs.
  exports: InfrastructureLogsPage; internal toLogTailApi
  dependencies: @hyveon/shared LAMBDA_FUNCTION_KEYS/LambdaFunctionKey; @hyveon/desktop-preload HyveonLambdaLogsApi; useLogTail, NO_HYVEON_LOG_TAIL_API; components LogTailView, ui Button
  side_effects: IPC window.hyveon.logs.lambda.*
  role: routed page
  observations:
    - Adapter casts string→LambdaFunctionKey; get() omits `limit` when undefined to keep call arity exact for tests (infrastructure-logs.page.tsx:19-32).
    - toLogTailApi creates a new object every render (tolerated by useLogTail's apiRef) (infrastructure-logs.page.tsx:45-48).
    - Default selection 'watchdog'; comment says "fixed 5-option" set (infrastructure-logs.page.tsx:39, 43, 58) — count lives in @hyveon/shared, while CLAUDE.md lists six Lambda packages.

- path: app/packages/web/src/pages/logs.page.tsx
  purpose: `/logs` — live tail of a selected game's CloudWatch logs with game combobox and navigation-state preselection.
  exports: LogsPage; internal LogsNavState, gameFromLocationState
  dependencies: api.games; useLogTail, NO_HYVEON_LOG_TAIL_API; components GameCombobox, LogTailView, ui Button; react-router useLocation
  side_effects: IPC games.list, window.hyveon.logs.*
  role: routed page
  observations:
    - Preselect game from `location.state.game` captured once in a ref (GameCard "Logs" link) (logs.page.tsx:10-24, 36-41, 58-61).
    - Passes window.hyveon.logs directly as LogTailApi (logs.page.tsx:47).
    - Games-list failure takes precedence over tail errors (logs.page.tsx:72).

- path: app/packages/web/src/pages/settings.page.tsx
  purpose: `/settings` — watchdog panel, cloud health, Pulumi engine version + Reconfigure (re-runs FirstRunWizard), auto-update toggle/check/download/install, deployment settings form, diagnostics.
  exports: SettingsPage; internal EngineVersionState, AutoUpdateState, ManualCheckState, engineVersionLabel, manualCheckFailed, downloadableVersion, formatAppVersion, appVersionLabel, manualCheckLabel, RELEASES_URL
  dependencies: @hyveon/shared PULUMI_ENGINE_VERSION, ManualUpdateCheckResult; window.hyveon.iac.settings.engineVersion/autoUpdateGet/autoUpdateUpdate/autoUpdateCheck/autoUpdateDownload (stream)/autoUpdateInstall; components DiagnosticsPanel, DeploymentSettingsForm, WatchdogPanel, FirstRunWizard (mode 'reconfigure'), CloudHealthSection, SettingsRow, PageHeader, ui Button; lib/bridge.utils SETTINGS_BRIDGE_UNAVAILABLE
  side_effects: IPC; external link to GitHub Releases; triggers quit-and-install
  role: routed page
  observations:
    - Absent bridge routed through Promise.reject so setState only happens in callbacks (settings.page.tsx:145-170).
    - Engine version null → "Not yet provisioned", rejection → "Unable to determine" (settings.page.tsx:36-43).
    - Auto-update write failure keeps last confirmed value with writeError (settings.page.tsx:180-196).
    - Download only on explicit operator action; streamed progress; install failure surfaced as download-failed (settings.page.tsx:214-244).
    - Auto-update toggle applies on next app start (settings.page.tsx:295-300, 315).
    - Reconfiguring replaces the whole page body with FirstRunWizard (settings.page.tsx:250-258).
    - Imports `../components/DiagnosticsPanel.js` — PascalCase filename, inconsistent with kebab-case `*.component.tsx` convention (settings.page.tsx:4).
    - Comment says manual check triggers `iac.settings.autoUpdate.check` but the method called is `autoUpdateCheck` (settings.page.tsx:331 vs 206).
    - Page function is ~250 lines with several state machines — over the ~200-line component guideline in typescript-conventions.md (settings.page.tsx:139-386).
    - No unmount guards on async setState calls.
```

## app/packages/web/src/pages/discord

```yaml
- path: app/packages/web/src/pages/discord/discord.page.tsx
  purpose: `/discord` — setup wizard + tabs (Credentials, Guilds, Admins, Per-Game Permissions) for the serverless Discord bot.
  exports: DiscordPage
  dependencies: ./use-discord-config, ./serverless-badge, ./setup-wizard, ./credentials-section, ./guilds-section, ./admins-section, ./permissions-section; components PageHeader, ui Tabs; PollingIndicator
  side_effects: indirect IPC via hook
  role: routed page
  observations:
    - Any config load error rendered as "infrastructure not deployed yet" (discord.page.tsx:39-61) — every failure mode collapses into one message.
    - Sections re-keyed on server-side values so drafts resync after save (discord.page.tsx:87-90, 107-108).
    - Doc mentions replacing old `DiscordPanel` on the dashboard — historical note (discord.page.tsx:16-17).

- path: app/packages/web/src/pages/discord/use-discord-config.hook.ts
  purpose: Fetch/refresh/mutate lifecycle for Discord config; busy flag, toasts, setup-wizard latch.
  exports: useDiscordConfig
  dependencies: api.games, api.discordConfig/SaveCredentials/AddGuild/RemoveGuild/RegisterCommands/SaveAdmins/SavePermission/DeletePermission; sonner toast
  data_shapes: DiscordConfigRedacted, DiscordMutationResult
  side_effects: IPC discord.*, games.list; toasts
  role: React hook
  observations:
    - Wizard visibility = latched-once-with-zero-guilds AND not all steps done (use-discord-config.hook.ts:26-29, 63-78).
    - wrap() refreshes config after each mutation, toasts, rethrows; every public mutation then `.catch(() => undefined)` (use-discord-config.hook.ts:84-98, 143-176).
    - wrapRegisterResult inspects `result.success` because DiscordCommandRegistrar.registerForGuild never throws (exceptions don't cross the Nest/Electron IPC boundary reliably) (use-discord-config.hook.ts:100-141).
    - registerCommands does not refresh config afterward (unlike wrap) (use-discord-config.hook.ts:121-141).
    - Seven near-identical one-line mutation wrappers (use-discord-config.hook.ts:143-176).
    - games.list failure silently ignored → permissions tab shows "No games configured" (use-discord-config.hook.ts:31-35).
    - No unmount guards; no explicit return type (use-discord-config.hook.ts:21).
    - Broken parenthetical in comment "(declared + deployed view," (use-discord-config.hook.ts:32-33).

- path: app/packages/web/src/pages/discord/credentials-section.component.tsx
  purpose: Credentials tab — Client ID (snowflake-validated), write-only Bot Token and Public Key, copyable Interactions Endpoint URL.
  exports: CredentialsSection; internal SecretField
  dependencies: ./snowflake.utils isSnowflake; hooks/use-copied-reset; ui Button/Card/Input/Label; navigator.clipboard
  side_effects: clipboard write
  role: UI component
  observations:
    - Empty token/public key = leave existing secret untouched; only non-empty fields sent (credentials-section.component.tsx:46-53, 141-145).
    - Client ID validated client-side because DiscordCommandRegistrar silently fails with a malformed ID (credentials-section.component.tsx:33-44).
    - Secret inputs cleared immediately after onSave regardless of outcome (credentials-section.component.tsx:51-52).
    - Clipboard write promise not awaited; "Copied" shown even if write fails (credentials-section.component.tsx:58-59).
    - Missing interactions URL directs operator to plan/apply on /iac (credentials-section.component.tsx:120-128).

- path: app/packages/web/src/pages/discord/guilds-section.component.tsx
  purpose: Guilds tab — merged base + dynamic allowlist, add form, per-row register/remove, "register in all guilds".
  exports: GuildsSection
  dependencies: ./add-guild-form, ./guild-row; components ConfirmDialog; ui Button/Card/Table
  role: UI component
  observations:
    - Dedupes base and dynamic lists; base wins (locked) (guilds-section.component.tsx:33-53).
    - "registered" badge is session-local state only — not persisted, resets on reload (guilds-section.component.tsx:30, 64-69).
    - Register-all runs sequentially and continues past failures (guilds-section.component.tsx:71-84).
    - Remove uses type-to-confirm dialog with the guild ID (guilds-section.component.tsx:94).
- path: app/packages/web/src/pages/discord/guild-row.component.tsx
  purpose: Table row with registered/base badges and Register/Remove buttons.
  exports: GuildRow
  role: UI component
  observations: Locked (base) rows are registerable but not removable; tooltip says edit "Base allowed guild IDs" on Settings then plan+apply (guild-row.component.tsx:47-58).
- path: app/packages/web/src/pages/discord/add-guild-form.component.tsx
  purpose: Guild ID input with snowflake and duplicate validation.
  exports: AddGuildForm
  role: UI component
  observations: Error copy "17–20 digit Discord snowflakes" (add-guild-form.component.tsx:30); Enter submits.

- path: app/packages/web/src/pages/discord/admins-section.component.tsx
  purpose: Admins tab — editable admin user/role ID chip lists with remove confirmation; read-only base admins below.
  exports: AdminsSection
  dependencies: components ConfirmDialog, SnowflakeChipsInput; lib/confirm-skip isSuppressed; ./base-admins-panel
  role: UI component
  observations:
    - Dirty check via JSON.stringify order-sensitive comparison (admins-section.component.tsx:28-30).
    - Remove confirmation skippable per session via confirmKey 'remove-admin' (admins-section.component.tsx:40, 68).
    - Duplicate onRemoveChip handlers for user/role differ only by list (admins-section.component.tsx:67-73, 82-88).
- path: app/packages/web/src/pages/discord/base-admins-panel.component.tsx
  purpose: Read-only display of base-config admin IDs.
  exports: BaseAdminsPanel; internal ChipList
  role: UI component
  observations: Doc calls base config "Pulumi-applied" (base-admins-panel.component.tsx:20), while settings hook says base admins are edited in the Settings form (deployment config) — both true but phrased differently.

- path: app/packages/web/src/pages/discord/permissions-section.component.tsx
  purpose: Per-game permissions table — users/roles chips + start/stop/status checkboxes, per-row Save/Clear.
  exports: PermissionsSection; internal PermissionRow, ALL_ACTIONS
  dependencies: components ConfirmDialog, SnowflakeChipsInput; lib/confirm-skip; ui Card/Button/Table
  role: UI component
  observations:
    - Row keyed on JSON of server entry so it reinitialises after Save/Clear (permissions-section.component.tsx:73-80).
    - Actions dirty check order-insensitive; user/role order-sensitive (permissions-section.component.tsx:118-121).
    - Raw `<input type="checkbox">` with copied Tailwind class string (also in settings.page.tsx:325) (permissions-section.component.tsx:151-156).
    - Clear dialog copy says "recoverable from infrastructure-as-code" (permissions-section.component.tsx:134) — permissions are runtime DynamoDB-backed via IPC, so whether that holds is unclear since permissions are written at runtime through discord.putPermission IPC, not by the infra program.
    - `void onDelete()` on a function typed to return void (permissions-section.component.tsx:137, 177).

- path: app/packages/web/src/pages/discord/serverless-badge.component.tsx
  purpose: Header badge: ready / not applied yet / awaiting credentials.
  exports: ServerlessBadge
  role: UI component
  observations: Final 'incomplete' branch is unreachable given the preceding conditions (serverless-badge.component.tsx:13-17).

- path: app/packages/web/src/pages/discord/setup-wizard.component.tsx
  purpose: Four-step Discord setup checklist with live checks.
  exports: SetupWizard
  role: UI component
  observations:
    - Step 3 "done" = interactionsEndpointUrl exists, not that the operator actually pasted it into Discord (setup-wizard.component.tsx:46).
    - Step 4 done = any guild allowlisted, not that commands were registered (setup-wizard.component.tsx:55).
    - Link text "docs/docs/setup.md" points to the published docs URL (setup-wizard.component.tsx:89-97); uses `React.ReactNode` without importing React (setup-wizard.component.tsx:11).
    - Array-index keys (setup-wizard.component.tsx:73).

- path: app/packages/web/src/pages/discord/snowflake.utils.ts
  purpose: Re-export of lib/snowflake.utils (isSnowflake, parseSnowflakes) for this directory.
  exports: isSnowflake, parseSnowflakes
  role: utility (re-export shim)
  observations: Pure indirection layer — a re-export of a re-export (lib/snowflake.utils re-exports isSnowflake from @hyveon/shared) (snowflake.utils.ts:6; lib/snowflake.utils.ts:1-3).
```

## app/packages/web/src/pages — page tests

All page specs mount through `renderPage()` (Polling → GameStatus → MemoryRouter) and `vi.mock('../api.service.js')`, so each also stubs `api.status` and `api.costsEstimate` for `GameStatusProvider`.

```yaml
- path: app/packages/web/src/pages/audit.page.test.tsx
  purpose: Spec for AuditPage.
  role: test (jsdom, routed page)
  observations: Pins `audit({limit:25})` on mount, loading/empty/error states, row columns (actor/action/game/versionId), expand/collapse before/after JSON diff, Load more visibility and `before: nextBefore` append. `entryFixture` helper lacks TSDoc (audit.page.test.tsx:58).

- path: app/packages/web/src/pages/costs.page.test.tsx
  purpose: Spec for CostsPage.
  role: test
  observations: Pins heading + PollingIndicator, rows per game, absence of actual-spend total/delta/stacked chart (Cost Explorer removal regression), exact Cost Explorer console URL.

- path: app/packages/web/src/pages/dashboard.page.test.tsx
  purpose: Spec for DashboardPage.
  role: test
  observations: Pins pending-changes banner on drift, indicator next to filter, `costsActual` never called (mock keeps a method that no longer exists on api), card per game, no-games CTA links, error card with Retry distinct from no-games, filter narrowing. Test name says "returned by /api/status" — stale HTTP wording (dashboard.page.test.tsx:75).

- path: app/packages/web/src/pages/game-detail.page.test.tsx
  purpose: Spec for GameDetailPage.
  role: test
  observations: Pins Seed-from-folder card (Upload disabled until folder chosen), In sync / Config drift / Undeclared chips, Container/Ports/Volumes/Env/File seeds/Connect message sections, https Web port vs Additional ports, VPC-only vs Public visibility, Edit toggle with disabled Name, saved change reflected without refetch, Remove dialog, ghost game hides Edit/Remove, unknown name message.

- path: app/packages/web/src/pages/games.page.test.tsx
  purpose: Spec for GamesPage.
  role: test
  observations: Pins row columns, `30000 (web), 30001/udp` port formatting, Pending deploy / Config drift / Undeclared chips with em-dash ghost columns, detail links, empty state with second Add game CTA, wizard dialog opening from both triggers, banner-above-table ordering, draft Resume (lands on "Step 3 of 6: Networking" with prefilled earlier steps), no stray trigger after resume-close, banner restored after close, header trigger hidden while resuming, Discard clears draft.

- path: app/packages/web/src/pages/iac.page.test.tsx
  purpose: Spec for IacPage (plan/approve/apply, lock recovery, destroy, partial apply, rollback).
  role: test
  observations:
    - Pins plan streaming + structured changeSummary (not scraped from log), "Change summary unavailable" vs "No changes — N unchanged", BUSY banner for conflict 'up'.
    - Run-lock clear: only when ack carries runLock (apply/destroy, never plan); mintToken bound to `expectedRunId` (TOCTOU), clear with confirmation token, no auto-resubmit; stale token and changed-lock failures keep banner (iac.page.test.tsx:212-347).
    - Stale Pulumi lock: banner names stack/holder/pid/age, confirm dialog before `iac.lock.clear`, success returns to idle with no residual error (iac.page.test.tsx:349-433).
    - Apply only after approval; apply called with {planRunId, planHash}; not-found apply record error; approval >15 min → expired + Re-approve.
    - Destroy (#307): typed phrase "destroy infrastructure" gate, mintDestroyToken then destroy({confirmationToken}), fresh token each attempt, BUSY banner without log view (iac.page.test.tsx:508-629).
    - Partial apply banner for both failed and aborted, single Start over (iac.page.test.tsx:631-745).
    - Rollback (#112) auto-submits tagged plan from location.state (iac.page.test.tsx:747-808).
    - Two lock namespaces stubbed: `iac.lock.*` (Pulumi stale lock) and `iac.runs.lock.*` (durable RunLock) (iac.page.test.tsx:32-40). Comment references "Task 9.3" (iac.page.test.tsx:691).

- path: app/packages/web/src/pages/iac-history.page.test.tsx
  purpose: Spec for IacHistoryPage.
  role: test
  observations: Pins row render, empty state, Load more with `before`, server-side status filter, client-side kind filter with no extra fetch, row link to `/iac/history/:runId`, approvedBy or em dash, change summary three-way states, partial badge, Rollback button only for apply rows with configVersionId, rollback.resolve → confirm dialog naming version, resolve failure inline alert, confirm → navigate('/iac', {state:{configVersionId, rolledBackFrom}}), rollback badge for rolledBackFrom rows.

- path: app/packages/web/src/pages/iac-run-detail.page.test.tsx
  purpose: Spec for IacRunDetailPage.
  role: test
  observations: Pins not-found message, status/kind/approver, log ladder (stream replay → logInline → logUrl + fetch), non-ok presigned fetch treated as no log (doesn't render S3 error body), no Approve/Apply controls, rolled-back-from link, change summary states, partial badge. Stubs global `fetch`.

- path: app/packages/web/src/pages/infrastructure-logs.page.test.tsx
  purpose: Spec for InfrastructureLogsPage.
  role: test
  observations: Pins 5 function buttons (watchdog, health-check, dns-updater, interactions, followup), default 'watchdog' get, switching re-fetches, previous stream handle cancelled. Comment claims GameStatusProvider calls `games` on mount — it doesn't (infrastructure-logs.page.test.tsx:9-11).

- path: app/packages/web/src/pages/logs.page.test.tsx
  purpose: Spec for LogsPage.
  role: test
  observations: Pins heading + Live badge, seeded lines, Pause/Resume and Live/Paused badge, search highlights with <mark> but never filters, "5 lines · oldest" footer, logs.get/stream called with game only (no AbortSignal), live chunks appended, scroll-away disables autoscroll and suppresses scrollTop writes, scroll-back re-enables, preselection from location.state with fallback to first game.

- path: app/packages/web/src/pages/settings.page.test.tsx
  purpose: Spec for SettingsPage.
  role: test
  observations:
    - Pins section headings, DiagnosticsPanel (mocked), deployment form loads hosted zone, engine-version three states, App Version/Unknown/Unavailable, auto-update toggle read/write/failed-write retention/disabled on read failure, manual check states + manual-download link, Download & Install progress / Restart & Install / failure retry.
    - Reconfigure: wizard opens on pick-cloud with Edit affordances, only edited steps sent to wizard.saveState, stack.initialize called with no args, prefill failure doesn't clobber, Cancel commits nothing (settings.page.test.tsx:471-594).
    - apiMock includes `config`/`saveConfig` not present on api.service (stale) (settings.page.test.tsx:10-11); fixture bucket name 'renamed-tfstate' (Terraform-era naming) (settings.page.test.tsx:532); comment references "Group 7" (settings.page.test.tsx:493).

- path: app/packages/web/src/pages/discord/discord.page.test.tsx
  purpose: Spec for DiscordPage and its tabs.
  role: test
  observations: Pins configured header + indicator, four tabs, SetupWizard shown only with zero guilds, unavailable copy on reject, indicator visible while loading, Clear-permissions confirm then delete, guild remove with type-to-confirm, Register success/failure/rejection badge + guild-scoped toasts, partial bulk failure, credentials save toasts (incl. non-Error fallback), cleared Client ID omitted from payload, admin chip remove confirmation. Test names reference "/api/discord/config" — stale HTTP wording (discord.page.test.tsx:111, 118).
```

## Observed behaviours

- The renderer talks to the main process only through `window.hyveon` IPC; `api.service.ts` has no fetch and no bearer token — app/packages/web/src/api.service.ts:1-4, 263-271.
- Every `api.*` wrapper is `async`, so a missing bridge surfaces as a rejected promise, not a synchronous throw — app/packages/web/src/api.service.ts:278-280.
- Not every IPC namespace goes through `api`: `iac.*`, `logs.*`, `wizard.*`, `iac.settings.*` are called directly on `window.hyveon` by hooks/pages — app/packages/web/src/hooks/use-iac-run.hook.ts:74, app/packages/web/src/hooks/use-deployment-settings.hook.ts:250, app/packages/web/src/pages/logs.page.tsx:47.
- The only HTTP request the renderer makes is a `fetch` of a presigned S3 log URL on the run-detail page — app/packages/web/src/pages/iac-run-detail.page.tsx:143-146.
- The first-run gate fails open: no bridge, no `.wizard` namespace, or a rejected `wizard.getState` all render the dashboard — app/packages/web/src/app.component.tsx:39-53.
- Polling/GameStatus providers mount only after the wizard is complete, so nothing polls before bootstrap — app/packages/web/src/app.component.tsx:87-92.
- Routing uses HashRouter because the packaged renderer loads from `file://` with a drive letter — app/packages/web/src/app.component.tsx:71-77.
- Renderer errors (`error`, `unhandledrejection`, ErrorBoundary) forward to `diagnostics.reportError`; React's duplicate `onCaughtError` log is suppressed — app/packages/web/src/main.tsx:8-16, app/packages/web/src/lib/report-renderer-error.utils.ts:150-174.
- `console.log/info/warn/error` are wrapped and batched to `diagnostics.reportLog` every 2 s, ≤50 per flush, queue cap 200, with drop counting and oldest-first requeue on failure — app/packages/web/src/lib/report-renderer-error.utils.ts:14-20, 67-138, 190-209.
- Console forwarding is a no-op when the bridge is absent at install time — app/packages/web/src/lib/report-renderer-error.utils.ts:190-193.
- Game status is polled every 20 s by default (`VITE_STATUS_POLL_MS` override, min 1000) under poller name 'status', above the router so it continues on every route — app/packages/web/src/polling/game-status-provider.component.tsx:14-29, 45-58, 82.
- Cost estimates load once per provider mount, not per poll, because `costs.estimate` calls ECS per game — app/packages/web/src/polling/game-status-provider.component.tsx:54-58, 84-86.
- The polling registry skips a tick if the same poller is still in flight and resets its timer on every run, manual or automatic — app/packages/web/src/polling/polling-provider.component.tsx:113-118.
- A poller is "stale" after more than 2× its interval without success, measured from the first attempt if it has never succeeded — app/packages/web/src/polling/polling-provider.component.tsx:66-67, 303-315.
- Poller cleanup is keyed on a per-registration Symbol, so a newer registration under the same name is never removed by an older cleanup — app/packages/web/src/polling/polling-provider.component.tsx:159-194.
- The file-manager poller (5 s) is registered only while the helper task is starting or a start/stop is pending — app/packages/web/src/hooks/use-file-manager.hook.ts:123-136.
- FileBrowser one-time credentials from `files.start` stay visible for the modal session and are cleared on stop/close/open — app/packages/web/src/hooks/use-file-manager.hook.ts:39-44, 97-118.
- Game Start/Stop always schedules a 3 s delayed per-game status refresh, even on failure; Stop offers a 5 s Undo toast that calls Start — app/packages/web/src/hooks/use-game-actions.hook.ts:6, 43-52, 85-112.
- Log tail keeps at most 300 lines; live lines are buffered (also capped at 300) while paused or in historical mode — app/packages/web/src/hooks/use-log-tail.hook.ts:16, 259-273.
- Scrolling within 50 px of the top loads older CloudWatch pages and switches to historical mode; scrolling to the bottom in historical mode pages forward; only "Jump to latest" returns to live and discards the buffer — app/packages/web/src/hooks/use-log-tail.hook.ts:386-428, 475-499, 514-576.
- The forward page cursor uses the newest visible line's timestamp plus every eventId at that timestamp as an exclusion list — app/packages/web/src/hooks/use-log-tail.hook.ts:448-460.
- A failed initial log snapshot still starts the live stream, with the message "Could not load initial logs; trying live stream." — app/packages/web/src/hooks/use-log-tail.hook.ts:346-350.
- `/logs` and `/logs/infrastructure` share `useLogTail`; the latter adapts `logs.lambda` and offers 5 fixed Lambda keys, defaulting to 'watchdog' — app/packages/web/src/pages/infrastructure-logs.page.tsx:19-48, app/packages/web/src/pages/infrastructure-logs.page.test.tsx:48.
- `/logs` preselects the game from `location.state.game` (set by GameCard), else the first listed game — app/packages/web/src/pages/logs.page.tsx:41, 58-61.
- Diagnostics tail polls every 5 s; while paused it keeps polling but holds the latest snapshot until resume — app/packages/web/src/hooks/use-diagnostics-tail.hook.ts:4, 27-35, 95-104.
- IaC flow: plan → stream log → `runs.get` for terminal status → approve → apply with `{planRunId, planHash}` — app/packages/web/src/pages/iac.page.tsx:109-164, app/packages/web/src/hooks/use-iac-run.hook.ts:198-220.
- A successful re-plan clears any approval and resets the apply run — app/packages/web/src/pages/iac.page.tsx:116-120.
- Approval is treated as expired after 15 minutes on the client (Apply disabled, Re-approve offered); the backend check is authoritative — app/packages/web/src/pages/iac.page.tsx:41-53, 181, 259-264.
- A `partialApply: true` apply record (failed or aborted) shows "Apply stopped partway through" and only a Start over action, never a retry — app/packages/web/src/pages/iac.page.tsx:55-82, 190, 304-310.
- A run record missing after its stream ends is reported as an error for every run kind — app/packages/web/src/hooks/use-iac-run.hook.ts:205-210.
- IaC run-log chunks are capped at 300 in memory — app/packages/web/src/hooks/use-iac-run.hook.ts:24, 99.
- Rollback from history navigates to `/iac` with `{configVersionId, rolledBackFrom}` state, and `/iac` auto-submits one tagged plan, then clears the state — app/packages/web/src/pages/iac-history.page.tsx:45-50, app/packages/web/src/pages/iac.page.tsx:131-136.
- Run history status filtering is server-side (status-index GSI) and kind filtering is client-side; page size 25 — app/packages/web/src/hooks/use-run-history.hook.ts:6, 64, app/packages/web/src/pages/iac-history.page.tsx:29-35, 42.
- Run detail finds its record by scanning the latest 200 runs, and resolves logs via stream replay → inline → presigned URL → none — app/packages/web/src/pages/iac-run-detail.page.tsx:22, 49-53, 117-155.
- Deployment settings saves always send the last-read etag as `expectedVersionId` and refuse to save without one; a conflict shows a reload message and never retries — app/packages/web/src/hooks/use-deployment-settings.hook.ts:299-346.
- Deployment settings validation runs the same shared `validateDeploymentSettingsPatch` on the client as on the server — app/packages/web/src/hooks/use-deployment-settings.hook.ts:14-18, 287.
- Auto-update toggle changes take effect on the next app start; download and install happen only on an explicit operator click — app/packages/web/src/pages/settings.page.tsx:214-244, 295-315.
- Settings "Reconfigure" replaces the page with FirstRunWizard in reconfigure mode; only steps the operator edited are saved — app/packages/web/src/pages/settings.page.tsx:250-258, app/packages/web/src/pages/settings.page.test.tsx:487-525.
- Discord secrets never come back to the renderer; only `botTokenSet`/`publicKeySet` booleans are exposed, and blank token/key inputs leave stored secrets unchanged — app/packages/web/src/api.service.ts:223-243, app/packages/web/src/pages/discord/credentials-section.component.tsx:46-53.
- Base-config guilds and admins appear read-only/locked in the Discord UI; base guilds can still be registered — app/packages/web/src/pages/discord/guilds-section.component.tsx:37-53, app/packages/web/src/pages/discord/guild-row.component.tsx:47-58.
- Command registration resolves `{success:false}` rather than throwing, and the "registered" badge is session-only; bulk registration runs sequentially and continues past failures — app/packages/web/src/pages/discord/use-discord-config.hook.ts:121-141, app/packages/web/src/pages/discord/guilds-section.component.tsx:64-84.
- The Discord setup wizard latches open the first time a config arrives with zero guilds and closes once all four steps are satisfied — app/packages/web/src/pages/discord/use-discord-config.hook.ts:26-29, 51, 63-78.
- Confirmation dialogs can be suppressed for the rest of the JS session through a module-level Set — app/packages/web/src/lib/confirm-skip.utils.ts:1-13, app/packages/web/src/pages/discord/admins-section.component.tsx:68.
- The add-game wizard draft lives in a single autosave slot; GamesPage hides other wizard triggers while a resumed draft is open to avoid two instances racing — app/packages/web/src/pages/games.page.tsx:58-69, 149, 170-177.
- An https game's `webPort` is shown as the Caddy upstream on 443, separate from "Additional ports" — app/packages/web/src/pages/game-detail.page.tsx:201-231, app/packages/web/src/pages/games.page.tsx:18-23.
- `formatUsd` uses the `en-US` locale so the decimal separator does not depend on the OS — app/packages/web/src/lib/format.utils.ts:7-24.
- ANSI handling covers the 16 standard foreground colours, bold, and reset; other escape sequences are removed and truncated sequences are left as text — app/packages/web/src/lib/ansi.utils.ts:34-137.
- The Costs page makes no Cost Explorer API calls and only links to the console — app/packages/web/src/pages/costs.page.tsx:39-40, 186-190.

## Cross-scope references

**Into `app/packages/web/src/components/` (sweep scope excluded):**
- Shell and app-level: `AppLayout`, `ErrorBoundary`, `ui/sonner` `Toaster`, `first-run-wizard/FirstRunWizard` (app.component.tsx, main.tsx, settings.page.tsx).
- `ui/*` primitives: Button, Card, Input, Label, Table, Tabs, Badge, Tooltip (all pages, polling-indicator).
- Page building blocks: PageHeader, SectionCard, AsyncContent, EmptyStateCard, LoadingState/InlineSpinner, ErrorBanner, ConfirmDialog, SnowflakeChipsInput.
- Dashboard: GameCard, KpiStrip, FileManagerModal, PendingChangesBanner.
- Games: `add-game-wizard/AddGameWizard` (games.page; `GameWizardDraft` in api.service.ts mirrors `add-game-wizard/wizard-form.utils.ts` `WizardDraft`), GameStatusBadges, `edit-game-form/EditGameForm`, RemoveGameButton, `folder-upload/FolderUploadCard`.
- IaC: AnsiLogViewer (+`AnsiLogChunk` type), ChangeSummaryStatus, SubmissionBanners, `iac-destroy-section` DestroySection, RolledBackFromLink, RunHistoryRow, `rollback-action` RollbackResult/RollbackAction (rollback-diff.utils is used by it), RunStatusBadge, PartialApplyBadge.
- Logs: LogTailView, GameCombobox.
- Settings: WatchdogPanel, CloudHealthSection, SettingsRow, DeploymentSettingsForm (uses `useDeploymentSettings`), `DiagnosticsPanel` (likely uses `useDiagnosticsTail`).
- Audit: AuditEntryRow.
- Hooks/utilities consumed by components (outside scope): `useGameActions`, `useClickOutside`, `useAppRegionStyle`, `useCopiedReset`, `useNowTick`, `useDeploymentSettings`, `useDiagnosticsTail`, `formatBytes`/`formatDuration`/`formatTimestamp`, `parseAnsiLine`/`stripAnsi`, `parseSnowflakes`, `cn`, `isSuppressed`/`suppress`, `reportRendererError` (ErrorBoundary), `formatDiffSummary` (RollbackAction), `usePoller`/`usePollingState`/`isStale` (LIVE badge etc.), `use-guided-iam.hook.ts` cited as the StrictMode mountedRef reference pattern.

**Into `@hyveon/shared`:**
- Types: GameServer*, GameWrite*, GameListEntry, Drift*, Audit*, DeploymentConfigDiff, DeploymentSettings*, TopLevelDeploymentSettings, ManualUpdateCheckResult, LambdaFunctionKey; `@hyveon/shared/folderUpload` Folder* types.
- Values: `errMessage`, `isSnowflake`, `DEPLOYMENT_CONFIG_DEFAULTS`, `validateDeploymentSettingsPatch`, `LAMBDA_FUNCTION_KEYS`, `PULUMI_ENGINE_VERSION`.
- Mirrored rather than imported: `APPROVAL_WINDOW_MS` / `isApprovalExpired` from `@hyveon/shared/runs.ts` (iac.page.tsx:41-53).

**Into `@hyveon/desktop-preload` (types + `Window.hyveon` augmentation via globals.d.ts):**
- HyveonApi namespaces used: env, games(+draft), costs, files, folderUpload, discord, diagnostics (tail, path, exportBundle, showInFolder, reportError, reportLog), drift, audit, cloudHealth, wizard.getState, window (presence), logs (+lambda: get/stream/getOlder/getNewer), iac (plan, approve, apply, runs.get/list/streamLogs/logUrl, settings.get/update/engineVersion/autoUpdate*).
- Types: HyveonStreamHandle, LogChunk, LogEventLine, Older/NewerLogsPage, IacPlanAck, IacPlanPayload, IacRunKind, IacRunChunk, IacRunRecord, IacStaleLockInfo, RunDetailStatus, RunLock, RunHistoryRecord, RunHistoryStatus, HyveonLambdaLogsApi, RendererConsoleLevel, RendererLogEntry, CloudHealth*, OpenConsoleResult, AwsProfileSummary; `bridgeStream` in preload.ts (cited by stream-handle.test-utils).

**Into desktop-main (named in comments/contracts, reached over IPC):**
- `IacController` / `PulumiOperationInFlightError` / `RunLockHeldError` (use-iac-run.hook.ts:15-21), `IacSettingsController.update`, `DeploymentConfigService.getTopLevelSettings/putRawConfig`, `RemoteFileStore` (use-deployment-settings.hook.ts), `EcsService.getTaskDefinition` (game-status-provider), `LogsService.fetchAcrossStreams` / `getRecentLogs` (use-log-tail, logs.page.test), `DiscordCommandRegistrar.registerForGuild` (use-discord-config, credentials-section), `PulumiService.clearStaleLock/initializeStack`, `RunService.mintLockClearConfirmationToken` (iac.page.test), `desktop-main/src/updater.ts` `initUpdater` (settings.page.tsx:296-299), `electron-entry.ts` titleBarOverlay colour (index.css:11-17), `listTasksByStartedBy` (use-file-manager).

**Test infrastructure outside scope:**
- `app/vitest.setup.ts` registers jest-dom matchers (testing-matchers.d.ts, vitest.d.ts).
- `e2e/fixtures/hyveon-http-bridge.ts` `installHyveonHttpBridge()` chromium shim without `iac`/`wizard` namespaces — the reason for several optional-chaining guards (use-deployment-settings.hook.ts:176-177, app.component.tsx:33-38).

**OpenSpec/docs referenced:** `openspec/changes/remove-cost-explorer-calls` and its design.md D4 (costs.page.tsx); "design.md D6" shared log-tail engine (use-log-tail.hook.ts:149, logs.page.tsx:30); `openspec/specs/desktop-only-operator-surface` (implied by api.service.ts header); published docs `https://codercoco-studios.github.io/Hyveon/setup` (dashboard.page.tsx:148, setup-wizard.component.tsx:90); GitHub Releases URL (settings.page.tsx:79).

## Cross-cutting observations (duplication / drift)

- Flagged "mirrors / keep in sync" copies (per `.claude/rules/duplication.md` these comments are the bug report): `GameWizardDraft` ↔ `WizardDraft` (api.service.ts:141-143); `APPROVAL_WINDOW_MS`/`isApprovalExpired` ↔ `@hyveon/shared/runs.ts` (iac.page.tsx:41-53); `CHUNK_WINDOW_SIZE` ↔ `WINDOW_SIZE` (use-iac-run.hook.ts:23-24).
- Two relative-time formatters with different rounding: `formatAge` (use-log-tail.hook.ts:137-145) and `formatAgo` (polling-indicator.component.tsx:96-102).
- Cursor pagination written twice: inline in AuditPage (audit.page.tsx:28-80) and in `useRunHistory` (use-run-history.hook.ts).
- `costs.estimate` fetched both by GameStatusProvider and CostsPage (game-status-provider.component.tsx:84-86, costs.page.tsx:169-183).
- Duplicate jest-dom type shims: testing-matchers.d.ts and vitest.d.ts; empty window.d.ts.
- Three "bridge unavailable" wordings (lib/bridge.utils.ts:2, 8; api.service.ts:267).
- Snowflake helpers re-exported twice (pages/discord/snowflake.utils.ts → lib/snowflake.utils.ts → @hyveon/shared).
- Raw `<select>`/checkbox markup with copied Tailwind classes (iac-history.page.tsx:63-85, permissions-section.component.tsx:151-156, settings.page.tsx:319-326).
- Leftover HTTP/Terraform wording: "GET /api/files/:game" (api.service.ts:187), "Nest server"/`../api.js` (render-page.utils.tsx:20, 25), "tfstate view" (games.page.tsx:27-28), test names with `/api/status`, `/api/discord/config` (dashboard.page.test.tsx:75, discord.page.test.tsx:111, 118), 'renamed-tfstate' (settings.page.test.tsx:532), stale mocks `costsActual`, `config`, `saveConfig`.
- Task/issue numbers in comments: "task 9.5" (iac-history.page.tsx:23-24), "Task 9.3" (iac.page.test.tsx:691), "Group 7" (settings.page.test.tsx:493) — against the comment-verbosity rule.
- Import-path style is mixed: `@/components/ui/*` alias vs relative `../components/ui/*.js` (iac.page.tsx:7, iac-history.page.tsx:4-5, settings.page.tsx:10 vs dashboard.page.tsx:11-14).
