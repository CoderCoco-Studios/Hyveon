# Sweep 1: app/packages/web/src/components (top-level files + subdirectories A-Z, a-g)

Scope: `git ls-files app/packages/web/src/components | awk -F/ '$6 ~ /^[A-Za-g]/'` (93 files). Note the awk filter also matches top-level files in `components/` whose names start A-Z/a-g, so those are included here.

## app/packages/web/src/components

```yaml
- path: app/packages/web/src/components/DiagnosticsPanel.tsx
  purpose: Settings-page panel tailing the app's own local main-process log file with search, pause/resume, autoscroll, bundle export and stray-helper cleanup.
  exports: DiagnosticsPanel
  dependencies: useDiagnosticsTail (../hooks/use-diagnostics-tail.hook.js), ErrorBanner, ExportBundleButton, StrayHelpersButton (./stray-helpers-button.component.js), LogLineList (./log-line-display.component.js), ui/Button, ui/Input, lucide-react
  data_shapes: consumes { lines: string[], logPath, loading, error, paused, togglePause } from the hook
  side_effects: none directly (polling/IPC lives in the hook); DOM scrollTop mutation
  role: UI component
  observations:
    - Doc says last 500 lines, polling every 5 s — both are implemented in the hook, not here (DiagnosticsPanel.tsx:12-13).
    - Autoscroll effect gated on !paused even though lines don't change while paused; comment says the guard is deliberate (DiagnosticsPanel.tsx:23-30).
    - Only file in this directory using PascalCase filename instead of the `*.component.tsx` convention.

- path: app/packages/web/src/components/DiagnosticsPanel.test.tsx
  purpose: jsdom tests for DiagnosticsPanel incl. the embedded ExportBundleButton.
  exports: none
  dependencies: vitest, @testing-library/react, user-event; mocks ../api.service.js (diagnosticsTail, diagnosticsLogPath, diagnosticsExportBundle, diagnosticsShowInFolder)
  data_shapes: SAMPLE_LINES string[], { lines }, { path }, export results { status: 'written'|'cancelled'|'error' }
  side_effects: none (fake timers)
  role: test
  observations:
    - Pins: loading text, path display, 5 s polling (DiagnosticsPanel.test.tsx:90-109), paused view frozen while polling continues (:138-160), resume swaps to latest snapshot without duplicates (:162-188), autoscroll only while unpaused (:190-233), stray-helper button present (:71-76), export loading/success/show-in-folder/cancel-silent/error/reject (:235-314).
    - StrayHelpersButton is not mocked; the api mock has no stray-helper method (:8-13).

- path: app/packages/web/src/components/ansi-log-viewer.component.tsx
  purpose: Scrollable box rendering streamed Pulumi output chunks as ANSI-coloured spans, auto-pinned to bottom unless the user scrolls up.
  exports: AnsiLogViewer, AnsiLogChunk (interface), AnsiLogViewerProps
  dependencies: parseAnsiLine (../lib/ansi.utils.js), cn (../lib/utils.utils.js)
  data_shapes: AnsiLogChunk { stream: 'stdout'|'stderr'; line: string } — comment says it mirrors IacRunChunk (ansi-log-viewer.component.tsx:5)
  side_effects: DOM scrollTop writes
  role: UI component
  observations:
    - Pinned threshold 24 px (ansi-log-viewer.component.tsx:21); pin state recomputed on every scroll event (:44-49).
    - AnsiLogChunk is a structural duplicate of IacRunChunk declared locally ("Mirrors `IacRunChunk`", :5).
    - Uses array index as React key for lines and segments (:65, :67).
    - `stream` field is never read — stderr lines render identically to stdout (:64-71).

- path: app/packages/web/src/components/ansi-log-viewer.component.test.tsx
  purpose: Tests AnsiLogViewer empty state, ordering, ANSI colouring, and scroll pinning.
  exports: none
  dependencies: vitest, @testing-library/react
  data_shapes: AnsiLogChunk fixtures
  side_effects: none
  role: test
  observations:
    - Pins red ANSI -> `text-[var(--color-red)]` class (ansi-log-viewer.component.test.tsx:37-41), pause on scroll-away and resume on scroll-back (:54-85).

- path: app/packages/web/src/components/app-layout.component.tsx
  purpose: Navigation shell — desktop sidebar, mobile off-canvas drawer, top bar, skip link, and `<main>` for routed pages.
  exports: AppLayout; re-exports RefreshAllButton, LiveIndicator from ./app-topbar.component.js
  dependencies: api.env() (../api.service.js, EnvInfo), NavSections (./app-nav.component.js), AppTopbar, react-router-dom useLocation, cn, lucide-react
  data_shapes: EnvInfo { environment, region } -> envLabel `${environment} · ${region}` or 'local'
  side_effects: IPC via api.env() on mount; console.error on failure; reads window.hyveon.window.platform
  role: UI component (layout)
  observations:
    - Mobile drawer state stores the pathname it was opened on, so route changes close it without an effect (app-layout.component.tsx:21-26).
    - Brand block is a drag region only on darwin, read directly from window.hyveon (:71-75), whereas topbar uses useAppRegionStyle hook — two mechanisms for the same concern.
    - Skip link explicitly no-drag (:48-51).
    - Brand block ("Game Servers" + Server icon) is duplicated between desktop sidebar and mobile drawer header (:77-82 vs :108-113).
    - Sidebar brand text is "Game Servers" while top bar h1 is "Hyveon" (app-topbar.component.tsx:112).
    - Back-compat re-export comment says "test and other consumers"; only app-layout.component.test.tsx imports these from here (:139-141).
    - `api.env().then(setEnv).catch(console.error)` — rejection logged to console only, not to main-process log (:29).

- path: app/packages/web/src/components/app-layout.component.test.tsx
  purpose: Tests AppLayout nav, mobile drawer, RefreshAllButton/LiveIndicator, and Electron window-chrome (drag regions, controls, spacers).
  exports: none
  dependencies: PollingProvider/usePollingActions (../polling/polling-provider.component.js), MemoryRouter; mocks ../api.service.js (env -> null); stubs global `hyveon.window`
  data_shapes: window.hyveon.window { platform, minimize, toggleMaximize, close, isMaximized, onMaximizedChange }
  side_effects: patches CSSStyleDeclaration.prototype globally for -webkit-app-region (app-layout.component.test.tsx:302-318)
  role: test
  observations:
    - Pins: Refresh disabled with empty registry (:33-41), Logs group children & active state (:85-125), no Servers/Metrics/Alerts entries (:177-189), no top-bar search (:191-202), LIVE cyan pulse after success (:216-233), drawer open/close/close-on-nav (:236-284), header drag + children no-drag (:340-386), Linux-only window controls (:388-459), win32 titleBarOverlay spacer uses 100vw not 100% (:461-498), darwin traffic-light spacer (:524-602), brand block drag only on darwin (:604-688), minimize/close/maximize->restore icon swap (:690-780).
    - The identical `vi.stubGlobal('hyveon', { window: {...} })` literal is repeated ~17 times (e.g. :341-350, :365-374, :389-398 ...).

- path: app/packages/web/src/components/app-nav.component.tsx
  purpose: Sidebar/drawer navigation sections (Monitoring with a Logs group, Configuration).
  exports: NavSections, types NavItem, NavGroup
  dependencies: react-router-dom Link, cn, lucide-react icons
  data_shapes: NavItem { to, icon, label }; NavGroup { label, icon, children }
  side_effects: none
  role: UI component
  observations:
    - Routes: / Dashboard, /logs Game Logs, /logs/infrastructure Infra Logs, /costs, /games, /discord, /iac Infrastructure, /audit, /settings (app-nav.component.tsx:20-59).
    - Monitoring items accessed by hard-coded index monitoringItems[0]/[1] so the Logs group can sit between them (:87-113).
    - Dashboard active check `currentPath.startsWith('//')` for to='/' — effectively exact-match only (:90).
    - Logs children use exact match only (:102), others prefix match (:125).
    - `prefix` prop exists to keep heading ids unique since desktop and mobile nav coexist (:66-69).

- path: app/packages/web/src/components/app-topbar.component.tsx
  purpose: Top bar with env pill, hamburger, global Refresh, LIVE indicator, avatar placeholder and Electron window chrome.
  exports: RefreshAllButton, LiveIndicator, AppTopbar
  dependencies: usePollingActions, usePollingState, isStale (../polling/polling-provider.component.js), useAppRegionStyle (../hooks/use-app-region-style.hook.js), TrafficLightSpacer/TitlebarOverlaySpacer/WindowControls (./window-chrome.component.js), ui/Button via `@/` alias
  data_shapes: pollers record { loading, lastSuccessAt, ... }, `now` heartbeat
  side_effects: triggers refreshAll() on all registered pollers
  role: UI component
  observations:
    - Refresh disabled when no pollers registered (app-topbar.component.tsx:25).
    - LIVE: cyan pulse if any fresh poller, dim if all stale, neutral otherwise; relies on provider's 1 Hz `now` (:39-55).
    - Avatar "OP" is a decorative placeholder (:122-129).
    - Mixed import styles: `@/components/ui/button.component` alias vs relative `.js` imports in the same file (:2-6).

- path: app/packages/web/src/components/async-content.component.tsx
  purpose: Shared loading -> error -> empty -> content switch for list/table sections.
  exports: AsyncContent, AsyncContentProps
  dependencies: cn, lucide Loader2
  data_shapes: props { loading, error?, isEmpty, emptyMessage, errorMessage?, children, className? }
  side_effects: none
  role: UI component (pure)
  observations:
    - Error only displaces content while isEmpty; stale content stays on failed refresh (async-content.component.tsx:49, :23-30).

- path: app/packages/web/src/components/audit-entry-row.component.tsx
  purpose: One /audit table row with expandable before/after JSON diff.
  exports: AuditEntryRow
  dependencies: AuditAction/AuditEntry types (../api.service.js), ui Badge/Button/Table, formatTimestamp (@/lib/format.utils), cn
  data_shapes: AuditEntry { timestamp, actor, action, game, versionId?, before, after }
  side_effects: none
  role: UI component
  observations:
    - ACTION_BADGE_VARIANT is a Record<AuditAction,…> so new actions are compile errors (audit-entry-row.component.tsx:17-29).
    - cn() wraps a single static class string twice with no conditional parts (:88-90, :100-102); Before/After blocks are duplicated markup (:83-106).
    - colSpan hard-coded 6 (:81).

- path: app/packages/web/src/components/audit-entry-row.component.test.tsx
  purpose: Tests summary columns, em-dash versionId, expand/collapse diff, and badge colour per action.
  exports: none
  dependencies: vitest, RTL, user-event
  data_shapes: AuditEntry fixtures
  side_effects: none
  role: test
  observations:
    - it.each over all 8 actions pins badge class; comment notes a past bug where only 3 of 8 actions were mapped (audit-entry-row.component.test.tsx:131-141).

- path: app/packages/web/src/components/change-summary-status.component.tsx
  purpose: Renders a Pulumi ChangeSummary as "unavailable", "no changes", or grouped op-count badges.
  exports: ChangeSummaryStatus
  dependencies: ChangeSummary, OpType types from @hyveon/desktop-preload; ui Badge
  data_shapes: ChangeSummary (Partial<Record<OpType, number>>)
  side_effects: none
  role: UI component (pure)
  observations:
    - Imports types from @hyveon/desktop-preload rather than @hyveon/shared, while the doc points at `@hyveon/shared/src/changeSummary.ts` (change-summary-status.component.tsx:1, :36-37).
    - Empty `{}` treated as "unavailable", even for a genuinely empty stack (deliberate per :42-49).
    - Ops bucketed: create(+replacement/import/import-replacement), update, replace, delete(+delete-replaced), other(read/refresh/discard/...), same (:12-27, :86-91).
    - Non-null assertion `summary!` after the availability check (:80).

- path: app/packages/web/src/components/cloud-health-section.component.tsx
  purpose: Settings-page AWS prerequisite checklist with per-row Fix and an IAM-policy-update remediation panel.
  exports: CloudHealthSection (HealthBadge, PolicyUpdatePanel, HealthRow internal)
  dependencies: api.cloudHealthList/cloudHealthFix/cloudHealthOpenPolicyConsole/cloudHealthDownloadPolicy (../api.service.js), CloudHealthCheckSummary/CloudHealthFixResult types, errMessage (@hyveon/shared), ui Button/Badge/Input
  data_shapes: CloudHealthCheckSummary { id, label, status: 'ok'|'missing'|'error', message? }; CloudHealthFixResult { outcome: 'fixed'|'failed'|'needsPolicyUpdate', message?, policyJson?, policyConsoleUrl? }; OpenConsoleResult { opened, url }
  side_effects: IPC calls; navigator.clipboard.writeText; main-side writes a file / opens browser
  role: UI component
  observations:
    - No polling — mount + manual Refresh only (cloud-health-section.component.tsx:213-219).
    - Successful fix triggers full list refresh via onFixed (:172-174, :268).
    - Distinguishes IPC rejection (listError/fixError) from modeled AWS failures (:160-163, :221-224).
    - Comment says fallback URL pattern "mirrors guided-iam-step.component.tsx" (:40-43) — duplicated pattern flagged by comment.
    - Copy-to-clipboard failure silently swallowed (:94-98).
    - Remediation copy hard-codes the policy name `HyveonDeployAll` (:82-83).

- path: app/packages/web/src/components/cloud-health-section.component.test.tsx
  purpose: Tests CloudHealthSection rows, Fix outcomes, console open/fallback, download, and IPC rejection paths.
  exports: none
  dependencies: mocks ../api.service.js (4 cloudHealth* methods)
  data_shapes: check summaries, fix results
  side_effects: none
  role: test
  observations:
    - Pins: needsPolicyUpdate shows IAM console + no "CloudFormation" text (cloud-health-section.component.test.tsx:57-75), list re-fetched after fix (:44-55), fallback URL shown in input (:93-106).

- path: app/packages/web/src/components/confirm-dialog.component.tsx
  purpose: Generic destructive-action AlertDialog with optional type-to-confirm and session "don't ask again".
  exports: ConfirmDialog (ConfirmDialogBody internal)
  dependencies: ui/alert-dialog (Radix/shadcn), ui/Input, suppress (../lib/confirm-skip.utils.js)
  data_shapes: props { open, onOpenChange, title, description, onConfirm, confirmLabel?, confirmKey?, typeToConfirm? }
  side_effects: writes module-level session suppression store via suppress()
  role: UI component
  observations:
    - Body keyed by String(open) so per-opening state resets via remount, not an effect (confirm-dialog.component.tsx:44-54).
    - Suppression only recorded when confirmKey set and checkbox ticked (:78).

- path: app/packages/web/src/components/confirm-dialog.component.test.tsx
  purpose: Tests ConfirmDialog render, confirm/cancel, type-to-confirm gating, suppression, custom label.
  exports: none
  dependencies: mocks ../lib/confirm-skip.utils.js with a Set
  data_shapes: none notable
  side_effects: none
  role: test
  observations: Pins cancel calls onOpenChange(false) without onConfirm (confirm-dialog.component.test.tsx:48-53).

- path: app/packages/web/src/components/deployment-settings-form.component.tsx
  purpose: Field layout for the Settings "General" deployment-settings editor (project, region, VPC, DNS, watchdog tuning, Discord base allowlists, table names).
  exports: DeploymentSettingsForm
  dependencies: useDeploymentSettings (../hooks/use-deployment-settings.hook.js), DeploymentSettingsValidationIssue (@hyveon/shared), FormField/Input/Label/Button, SnowflakeChipsInput (./snowflake-chips-input.component.js)
  data_shapes: draft { projectName, awsRegion, vpcCidr, hostedZoneName, dnsTtl, discordApplicationId, watchdogIntervalMinutes, watchdogIdleChecks, watchdogMinPackets, baseAllowedGuilds[], baseAdminUserIds[], baseAdminRoleIds[], auditTableName, runsTableName }; issues { path, message }[]
  side_effects: none directly (hook does IPC)
  role: UI component
  observations:
    - loadState branches: loading / setup_incomplete / error-or-no-draft with Retry (deployment-settings-form.component.tsx:39-66).
    - Conflict banner with Reload button (optimistic locking lives in the hook) (:70-83).
    - messagesForField matches `field` or `field[N]` paths (:19-21).
    - Watchdog values stated as baked into Lambda at deploy time (:144-147); base allowlists described as Pulumi-applied floor in `BASE#discord` row (:196-200).
    - Table-name placeholders derive `${projectName||'hyveon'}-audit/-runs` (:247, :257).
    - The red alert banner markup is hand-written three times (:54-60, :71-82, :265-271) rather than using ErrorBanner; also duplicated in edit-game-form.component.tsx:189-195.

- path: app/packages/web/src/components/deployment-settings-form.component.test.tsx
  purpose: Tests the form + its hook end-to-end against a stubbed window.hyveon.iac.settings bridge.
  exports: none
  dependencies: stubs global hyveon.iac.settings.get/update; mocks sonner toast
  data_shapes: SETTINGS fixture; get -> { ok, settings, etag } | { ok:false, code }; update -> { ok, settings, etag, versionId } | { ok:false, code:'validation'|'conflict'|'setup_incomplete' }
  side_effects: none
  role: test
  observations:
    - Bypasses api.service and stubs window.hyveon directly (deployment-settings-form.component.test.tsx:10-18), implying the hook calls the bridge, not `api`.
    - Pins: StrictMode double mount (:64-72), validation messages "Must not be empty.", CIDR, positive integer (:98-141), defensive defaults for missing arrays/numerics (:143-183), expectedVersionId = last etag (:199-219), conflict no auto-retry (:237-256), refuse save without etag (:303-316), success toast 'Deployment settings saved' (:218).

- path: app/packages/web/src/components/empty-state-card.component.tsx
  purpose: Icon + title + description + optional CTA card for empty/error states.
  exports: EmptyStateCard, EmptyStateCardProps, EmptyStateCardTone
  dependencies: ui Card*, cn, LucideIcon type
  data_shapes: tone 'neutral'|'error'
  side_effects: none
  role: UI component (pure)
  observations: Used only by dashboard.page.tsx per grep.

- path: app/packages/web/src/components/error-banner.component.tsx
  purpose: Red tinted inline banner with role="alert".
  exports: ErrorBanner, ErrorBannerProps
  dependencies: cn
  data_shapes: children ReactNode
  side_effects: none
  role: UI component (pure)
  observations: Widely reused (folder-upload, export-bundle, DiagnosticsPanel, iac pages) but not by deployment-settings-form or edit-game-form, which inline equivalent markup.

- path: app/packages/web/src/components/error-boundary.component.tsx
  purpose: Top-level React error boundary that shows a fallback and forwards crashes to the main-process log.
  exports: ErrorBoundary (class)
  dependencies: errMessage (@hyveon/shared), reportRendererError (../lib/report-renderer-error.utils.js)
  data_shapes: State { error: unknown }
  side_effects: reportRendererError(message, combinedStack, 'boundary') -> main-process log via bridge
  role: UI component (error boundary)
  observations:
    - Doc states window.onerror/unhandledrejection in main.tsx don't see React-caught render errors, so this is the only logging path (error-boundary.component.tsx:13-20).
    - Stack and componentStack joined with "\n\nComponent stack:" separator (:47-49).
    - Fallback has no reset/retry; directs to Settings → Logs or restart (:60-62).
    - Truthiness check `if (this.state.error)` means a thrown falsy value (e.g. `throw 0`) would not render the fallback (:55).

- path: app/packages/web/src/components/error-boundary.component.test.tsx
  purpose: Tests ErrorBoundary children passthrough, fallback, and reportRendererError call.
  exports: none
  dependencies: mocks ../lib/report-renderer-error.utils.js
  data_shapes: none
  side_effects: none
  role: test
  observations: Pins source tag 'boundary' (error-boundary.component.test.tsx:56).

- path: app/packages/web/src/components/export-bundle-button.component.tsx
  purpose: "Export diagnostics bundle" button with success (Show in folder) / error banners.
  exports: ExportBundleButton
  dependencies: api.diagnosticsExportBundle, api.diagnosticsShowInFolder (../api.service.js), ErrorBanner, ui/Button
  data_shapes: ExportBundleState 'idle'|'loading'|{status:'success',path}|{status:'error',message}; IPC result { status: 'written'|'cancelled'|'error', path?, message? }
  side_effects: IPC — main writes a bundle file via save dialog; reveals file in OS file manager
  role: UI component
  observations:
    - Dialog cancel returns to idle silently (export-bundle-button.component.tsx:43-44).
    - showInFolder promise result ignored with `void` — failures invisible (:56).
    - Error normalization inline `err instanceof Error ? … : 'Failed to export…'` rather than errMessage (:49).

- path: app/packages/web/src/components/file-manager-modal.component.tsx
  purpose: Presentational modal for launching/stopping the per-game FileBrowser helper task and showing its URL and one-time credentials.
  exports: FileManagerModal
  dependencies: FileMgrStatus, FileMgrCredentials types (../api.service.js); lifecycle lives in useFileManager (per doc, file-manager-modal.component.tsx:16-19)
  data_shapes: FileMgrStatus { game, state: 'running'|'starting'|'stopped'|..., url? }; FileMgrCredentials { username, password }
  side_effects: document keydown listener (Escape closes)
  role: UI component
  observations:
    - Styled with inline style objects and legacy CSS vars/classes (`--text-dim`, `--accent`, `--surface`, `btn-start btn-sm`) instead of Tailwind/ui primitives used elsewhere (:36-113).
    - Escape listener registered even when `game` is null (effect runs before the early `return null`) (:23-29).
    - `React.CSSProperties` used without importing React — relies on global React namespace types (:96, :106).
    - One-time password rendered in plain `<code>` in the renderer (:69-70); "shown once" per copy (:67).
    - Status text "checking again in 5 seconds" hard-codes the hook's poll interval (:92).
    - Not a Radix dialog: no focus trap / role="dialog" (:36-37).

- path: app/packages/web/src/components/file-manager-modal.component.test.tsx
  purpose: Tests FileManagerModal states, credentials block, button enablement, and close triggers.
  exports: none
  dependencies: vitest, RTL
  data_shapes: FileMgrStatus fixtures
  side_effects: none
  role: test
  observations: Pins backdrop-only click closes (file-manager-modal.component.test.tsx:155-172) and running-without-url shows no link (:50-55).

- path: app/packages/web/src/components/game-card.component.tsx
  purpose: Dashboard card for one game — state badge, hostname/IP copy, stats, Start/Stop/Files/Logs actions.
  exports: GameCard
  dependencies: useGameActions (../hooks/use-game-actions.hook.js), ConfirmDialog, isSuppressed (../lib/confirm-skip.utils.js), GameStatus/GameEstimate types, formatUsd, ui Card/Button/Badge, react-router Link
  data_shapes: GameStatus { game, state: running|starting|stopped|not_deployed|error, message?, hostname?, publicIp?, taskArn? }; GameEstimate { costPerHour }
  side_effects: navigator.clipboard.writeText; start/stop IPC via hook; navigates to /logs with state { game }
  role: UI component
  observations:
    - Doc says card schedules a 3 s onRefresh after start/stop — implemented in the hook, not this file (game-card.component.tsx:128-130).
    - `error` is startable (:150, :132-134).
    - `disabled={!canStart || busy}` inside the `canStart ?` branch makes `!canStart` always false (:235-240); same for `!canStop` in the else branch (:258) — but else branch covers all non-startable states and canStop covers running|starting, which is the complete complement, so equivalent.
    - Stop confirmation bypassed when 'stop-server' is suppressed for the session (:252-256, :165).
    - "Last run" stat shows a static per-state label ('Live','Booting','—'), not an actual last-run time (:55, :63, :71, :228).
    - Clipboard write promise rejection unhandled (`void navigator.clipboard.writeText`) (:195).
    - aria-live announcement on state transitions (:143-148, :170).

- path: app/packages/web/src/components/game-card.component.test.tsx
  purpose: Tests GameCard stats, error-state recovery, Start/Stop per state, Stop confirmation/suppression, and toasts from useGameActions.
  exports: none
  dependencies: mocks ../api.service.js (start, stop), ../lib/confirm-skip.utils.js, sonner
  data_shapes: GameStatus fixtures; { success, message } action results
  side_effects: none
  role: test
  observations:
    - Pins: no Players tile (game-card.component.test.tsx:85-89), success:false -> error toast not success (:259-273), stop success toast carries an Undo action (:292-304), unknown error fallback description 'An unknown error occurred' (:247-257).
    - Identical beforeEach block repeated in 5 describe blocks (:69-75, :93-99, :131-137, :169-175, :219-225).

- path: app/packages/web/src/components/game-combobox.component.tsx
  purpose: Searchable game selector popover built on plain elements.
  exports: GameCombobox
  dependencies: useClickOutside (../hooks/use-click-outside.hook.js), cn, lucide icons
  data_shapes: props { games: string[], value, onChange, className? }
  side_effects: document listeners via hook; focuses input on open
  role: UI component
  observations:
    - Case-insensitive substring filter (game-combobox.component.tsx:25-29).
    - No listbox/option ARIA roles; items are plain buttons (:82-93).
    - Escape handling is delegated to useClickOutside per comment (:31-36).

- path: app/packages/web/src/components/game-combobox.component.test.tsx
  purpose: Tests trigger labels, open/filter/empty, select-closes, Escape-closes.
  exports: none
  dependencies: vitest, RTL, user-event
  data_shapes: string[] games
  side_effects: none
  role: test
  observations: none

- path: app/packages/web/src/components/game-status-badges.component.tsx
  purpose: Single drift chip summarizing declared/deployed/config-drift for a game row.
  exports: GameStatusBadges, GameStatusBadgesProps, GameStatusDrift
  dependencies: ui Badge/BadgeProps, DriftKind/DriftChangedField types (../api.service.js)
  data_shapes: GameStatusDrift { kind: DriftKind, changedFields? }
  side_effects: none
  role: UI component (pure)
  observations:
    - Plural name "Badges" but renders exactly one Badge (game-status-badges.component.tsx:44-48).
    - `!declared && !deployed` falls through to "Undeclared" (:71), documented as impossible (:37-39).
    - Only config_drift is surfaced; pending_create/pending_delete under declared&&deployed show "In sync" (:62-66).
    - GameStatusDrift locally re-declares the shape of `GameListEntry.drift` from @hyveon/shared (:4-8).

- path: app/packages/web/src/components/game-status-badges.component.test.tsx
  purpose: Tests the four drift-chip states, the changed-fields tooltip, and non-config drift kinds.
  exports: none
  dependencies: vitest, RTL
  data_shapes: { declared, deployed, drift? } props
  side_effects: none
  role: test
  observations:
    - Pins colour classes per chip (green/amber/red) (game-status-badges.component.test.tsx:6-36), title 'image, cpu' tooltip (:38-42), pending_create under declared+deployed still "In sync" (:44-50).
```

## app/packages/web/src/components/edit-game-form

```yaml
- path: app/packages/web/src/components/edit-game-form/edit-game-form.component.tsx
  purpose: Flat edit form for an already-declared game, reusing the add-wizard step components stacked in SectionCards; saves via api.updateGame.
  exports: EditGameForm, EditGameFormProps
  dependencies: api.games, api.updateGame, types GameWriteSuccess/RedactedGameServer/UpdateGamePayload (../../api.service.js); IdentityStep, ResourcesStep, NetworkingStep, StorageStep, EnvironmentStep, draftFromGameServer/draftToPayload/validateStep/WizardDraft (../add-game-wizard/*); GameServerValidationIssue (@hyveon/shared/gameServerValidator); SectionCard; react-router Link
  data_shapes: WizardDraft (incl. healthCheck, ports, https, webPort); UpdateGamePayload { name, config }; GameWriteResult { ok:true,… } | { ok:false, code:'validation'(issues)|'conflict'|'not_found'|'setup_incomplete'|'error'(message) }
  side_effects: IPC games.list on mount and games.update on save; writes deployment-config.json in S3 via main (per hint text)
  role: UI component (form)
  observations:
    - Name field read-only; rename is out of scope (edit-game-form.component.tsx:6-7, :159).
    - Other declared games fetched for cross-game port-collision, excluding self by name (:62-78).
    - validateStep('review', …, 'edit') skips create-time DNS-safe name check for legacy names (:106-110).
    - Server issues replace live issues until the next patch (:111, :85-89).
    - patchHealthCheck uses functional setState to avoid lost batched patches (:91-104).
    - mountedRef re-armed in effect for StrictMode (:49-56); also a `cancelled` flag in the games effect — two guards (:63-77).
    - Inline red alert markup duplicates deployment-settings-form's banner rather than ErrorBanner (:189-195).
    - Hint: saving only updates deployment-config.json; apply via /iac (:198-204).
    - Module doc says "Submits via api.updateGame" and component doc says "games.update submit handler" (:8, :39).

- path: app/packages/web/src/components/edit-game-form/edit-game-form.component.test.tsx
  purpose: Tests EditGameForm prefill, read-only name, payload shape per edit, server failure handling, https/webPort behaviour, and batched health-check patches.
  exports: none
  dependencies: mocks ../../api.service.js (games, updateGame); partially mocks ../add-game-wizard/networking-step.component.js to capture onHealthCheckChange
  data_shapes: RedactedGameServer fixture; expected payload config
  side_effects: none
  role: test
  observations:
    - Pins: StrictMode still runs collision check (edit-game-form.component.test.tsx:85-104), pinnedHostname round-trip / omitted when absent (:121-137), legacy underscore name saveable (:145-171), batched health-check patches both applied (:209-231), removing all env vars sends environment: undefined (:251-265), port visibility 'internal' persisted (:267-284), https false not carried forward (:346-359), webPort excluded from additional ports and required when https (:378-404).
    - Unedited payload has `file_seeds: undefined` even though fixture had `[]` (:59, :73).
```

## app/packages/web/src/components/folder-upload

```yaml
- path: app/packages/web/src/components/folder-upload/folder-include-tree.component.tsx
  purpose: Lazily-expanding tri-state checkbox tree for choosing which scanned folder entries to upload.
  exports: FolderIncludeTree, FolderIncludeTreeProps (TriStateCheckbox, TreeRow internal)
  dependencies: FolderScanNode (@hyveon/shared/folderUpload), formatBytes (../../lib/format.utils.js), nodeState/selectedFileSet/toggleNode/TriState (./folder-seed.utils.js)
  data_shapes: FolderScanNode { name, kind:'file'|'dir', size, relPath, children? }; include: string[]
  side_effects: sets input.indeterminate imperatively
  role: UI component
  observations:
    - Directory children render only when expanded (folder-include-tree.component.tsx:58, :90).
    - Empty directories are not selectable (:63, :84).
    - nodeState walks all descendant files per row on every render (via filesUnder) — O(n·depth) on large trees (:62; folder-seed.utils.ts:18-24).

- path: app/packages/web/src/components/folder-upload/folder-include-tree.component.test.tsx
  purpose: Tests checked/mixed display, parent toggle semantics, expand + child toggle, disabled.
  exports: none
  dependencies: makeScan (./folder-upload.test-utils.js)
  data_shapes: scan fixture
  side_effects: none
  role: test
  observations: Pins mixed via aria-checked="mixed" and indeterminate (folder-include-tree.component.test.tsx:18-24).

- path: app/packages/web/src/components/folder-upload/folder-seed-section.component.tsx
  purpose: "Seed from folder" section (picker, include tree, destination field, summary) shared by the add-game wizard Storage step and the game page.
  exports: FolderSeedSection, FolderSeedSectionProps
  dependencies: validateDestination/VolumeLike (@hyveon/shared/folderUpload), FolderIncludeTree, summarizeSelection, FolderSeedState (./use-folder-seed.hook.js), ErrorBanner, FormField/Input/Button, formatBytes
  data_shapes: FolderSeedState; FolderScanResult { scanId, rootName, tree, fileCount, totalBytes, skippedLinks }
  side_effects: calls seed.load() on mount (IPC restore)
  role: UI component
  observations:
    - Separate from inline file_seeds rows (folder-seed-section.component.tsx:32).
    - Destination validated only when non-empty (:43).
    - Summary notes skipped symbolic links (:97-98).

- path: app/packages/web/src/components/folder-upload/folder-seed-section.component.test.tsx
  purpose: Tests the section over a real useFolderSeed: default select-all + persist, summary, destination validation, restore on mount, no persist without name, pick error, discardPersisted semantics.
  exports: none
  dependencies: mocks ../../api.service.js (folderPick, folderRescan, folderGetSelection, folderSetSelection, folderClearSelection)
  data_shapes: stored selection { localPath, include, destination }
  side_effects: none
  role: test
  observations:
    - Pins destination errors 'inside one of the game volume paths' and 'without ".."' from shared validateDestination (folder-seed-section.component.test.tsx:71-91).
    - discardPersisted waits for in-flight save before clearing (:132-152); failed clear retried once on next discard (:154-169); reset alone does not clear (:171-178).
    - Harness has `const [shown] = useState(true)` that never changes (:26-27).

- path: app/packages/web/src/components/folder-upload/folder-seed.utils.ts
  purpose: Pure tree-selection helpers: descendants, effective file set, tri-state, include compression, toggle, summary.
  exports: TriState, filesUnder, selectedFileSet, nodeState, compressInclude, selectAll, toggleNode, summarizeSelection
  dependencies: planUpload, FolderScanNode (@hyveon/shared/folderUpload)
  data_shapes: include string[] of relPaths; Set<string> of file relPaths
  side_effects: none
  role: utility
  observations:
    - Effective selection delegated to shared planUpload so renderer and main agree (folder-seed.utils.ts:13-15, :67-69).
    - compressInclude never lists the root; full selection = top-level children (:26-45).

- path: app/packages/web/src/components/folder-upload/folder-seed.utils.test.ts
  purpose: Unit tests for folder-seed.utils.
  exports: none
  dependencies: vitest
  data_shapes: local file()/dir() fixture builders
  side_effects: none
  role: test
  observations: file()/dir() builders (folder-seed.utils.test.ts:13-27) duplicate fileNode()/dirNode() in folder-upload.test-utils.ts:4-18.

- path: app/packages/web/src/components/folder-upload/folder-upload-card.component.tsx
  purpose: Game-page card that owns the seed selection, upload start (with open-file-manager handling), blockers, and progress meter.
  exports: FolderUploadCard, FolderUploadCardProps
  dependencies: api.statusGame, api.folderGetSelection, api.folderStartUpload, api.filesMgrStop (../../api.service.js); validateDestination/VolumeLike; useFolderSeed; useFolderUploadProgress; FolderSeedSection; FolderUploadProgressMeter; SectionCard; ErrorBanner
  data_shapes: start result { started: true, runId } | { started: false, error }; GameStatus.state
  side_effects: IPC; may stop the FileBrowser helper task (ECS StopTask in main)
  role: UI component
  observations:
    - Detects open file-manager session by regex /already open/i on the error string (folder-upload-card.component.tsx:25, :87) — coupled to main's message text.
    - Upload blocked when not deployed or server running/starting (:118-120); selection kept when not deployed (:119).
    - Server status fetched once on mount and after each settled run; no polling (:46-66, :108-111).
    - `running` phase set (folder-upload-card.component.tsx:113) duplicates `active` in folder-upload-progress-meter.component.tsx:97.
    - stopHelperAndRetry calls start() which reads the seed captured in its closure (:97-106).
    - Unreadable remembered folder message when scan null but lastRun present (:127-131).

- path: app/packages/web/src/components/folder-upload/folder-upload-card.component.test.tsx
  purpose: Tests FolderUploadCard start with restored selection, blockers, guard errors, helper-open stop+retry, push progress, resume flows, settled refresh, unsubscribe.
  exports: none
  dependencies: mocks ../../api.service.js (statusGame, filesMgrStop, folder* incl. folderOnProgress push subscription)
  data_shapes: progress snapshots via makeProgress
  side_effects: none
  role: test
  observations:
    - Pins helper-open error text "A file manager session is already open for 'minecraft'. Stop it first, then retry." (folder-upload-card.component.test.tsx:93), filesMgrStop only after operator confirms (:99-103), other-game progress ignored (:115-120), resume after restart (:129-139), Resume disabled when rescan fails (:141-150), unsubscribe on unmount (:170-175).

- path: app/packages/web/src/components/folder-upload/folder-upload-progress-meter.component.tsx
  purpose: Determinate progress meter for a folder upload with phase, %, bytes, files, rate, ETA, Cancel, Resume/Retry, verification failures, and last-run summary.
  exports: FolderUploadProgressMeter, FolderUploadProgressMeterProps
  dependencies: api.folderCancelUpload; OverwriteConfirmation; FolderUploadLastRun/FolderUploadPhase/FolderUploadProgress (@hyveon/shared/folderUpload); formatBytes/formatDuration/formatTimestamp; ErrorBanner
  data_shapes: FolderUploadProgress { game, phase, bytesDone, bytesTotal, filesDone, filesTotal, currentPath?, bytesPerSecond, etaSeconds?, error?, overwrite? }; FolderUploadLastRun { status, completedAt, files, bytes }
  side_effects: IPC cancel
  role: UI component
  observations:
    - Percent capped at 99 until phase 'done' (folder-upload-progress-meter.component.tsx:98-99).
    - 'starting-helper' shows no percent and aria-valuenow undefined (:109, :117, :122).
    - Verification failure detected by string prefix 'Verification failed: ' and split on ', ' (:37-43) — coupled to main's error format; Retry vs Resume label chosen from that (:203).
    - onSettled fired once per run via settledFor ref; reset on starting-helper/awaiting/uploading but not verifying (:57-67).
    - During awaiting-confirmation with an overwrite summary the plain Cancel is hidden in favour of OverwriteConfirmation's Cancel (:161-167).
    - Cancel errors swallowed (only re-enables button) (:69-76).

- path: app/packages/web/src/components/folder-upload/folder-upload-progress-meter.component.test.tsx
  purpose: Tests each phase's rendering, cancel, resume/retry, settle-once, last-run, and overwrite-confirmation interplay.
  exports: none
  dependencies: mocks ../../api.service.js (folderCancelUpload, folderConfirmOverwrite)
  data_shapes: makeProgress snapshots
  side_effects: none
  role: test
  observations: Pins 99% while verifying (folder-upload-progress-meter.component.test.tsx:41-45), 'Upload verified: 3 files, 1000 B.' (:50), single Cancel during overwrite prompt that calls folderConfirmOverwrite(false) not folderCancelUpload (:136-146), timeout message in cancelled state (:154-163).

- path: app/packages/web/src/components/folder-upload/folder-upload.test-utils.ts
  purpose: Shared fixture builders for folder-upload tests.
  exports: fileNode, dirNode, makeScan, makeProgress
  dependencies: FolderScanNode/FolderScanResult/FolderUploadProgress types (@hyveon/shared/folderUpload)
  data_shapes: scan of Config/{a,b}.json + Data/w.db (1030 B, 3 files, 1 skipped link, rootName 'FoundryVTT'); progress default mid-upload 500/1000
  side_effects: none
  role: test helper
  observations: Not a `.test.` file so it is part of the non-test source glob (folder-upload.test-utils.ts:1); builders duplicated in folder-seed.utils.test.ts.

- path: app/packages/web/src/components/folder-upload/overwrite-confirmation.component.tsx
  purpose: Inline alertdialog asking whether to overwrite volume files whose size differs, before any write.
  exports: OverwriteConfirmation, OverwriteConfirmationProps
  dependencies: api.folderConfirmOverwrite; OverwriteSummary (@hyveon/shared/folderUpload); formatBytes; ui Button
  data_shapes: OverwriteSummary { conflictCount, identicalCount, newCount, otherExistingCount, samples: { relPath, existingSize, newSize }[] }
  side_effects: IPC answer to paused main-side run
  role: UI component
  observations:
    - Buttons stay disabled after a resolved answer; only re-enabled if resolved:false or rejection (overwrite-confirmation.component.tsx:28-38).
    - Fixed element id "overwrite-confirmation-title" — would collide if two render on one page (:43, :47).
    - Shows "and N more" for samples beyond the list (:26, :61).

- path: app/packages/web/src/components/folder-upload/overwrite-confirmation.component.test.tsx
  purpose: Tests counts/singularization, sample listing, confirm/decline, and send-failure recovery.
  exports: none
  dependencies: mocks ../../api.service.js (folderConfirmOverwrite)
  data_shapes: OverwriteSummary fixture
  side_effects: none
  role: test
  observations: none

- path: app/packages/web/src/components/folder-upload/use-folder-seed.hook.ts
  purpose: Hook owning the seed-from-folder selection (scan, include, destination, lastRun) with persistence to main per game.
  exports: useFolderSeed, UseFolderSeedOptions, FolderSeedState
  dependencies: api.folderSetSelection, folderGetSelection, folderRescan, folderPick, folderClearSelection; types FolderScanResult, FolderUploadRequest (../../api.service.js); validateDestination, FolderUploadLastRun, VolumeLike (@hyveon/shared/folderUpload); selectAll
  data_shapes: persisted { game, scanId, include, destination } and stored { localPath?, include, destination, lastRun? }; FolderUploadRequest { game, scanId, include, destination }
  side_effects: IPC persistence on every include/destination change; native folder dialog via main
  role: React hook
  observations:
    - Persists only when game non-empty, scan present and destination valid (use-folder-seed.hook.ts:77).
    - load runs once per game (loadedFor ref) and aborts if a live scan already exists; rescans remembered folder after restart (:98-114); failures silent (:111-113).
    - pick defaults destination to first volume's container_path (:59, :122).
    - persistedAs tracks every name saved under so a wizard rename can be cleaned up; discardPersisted awaits in-flight saves first (:62-65, :160-176).
    - request() returns null without game/scan/destination but does not validate destination (validation is done by the card) (:155-158).
    - Each setInclude/setDestination triggers an un-debounced IPC write (:134-148).
    - Hook lives under components/ rather than web/src/hooks/ where other hooks live.

- path: app/packages/web/src/components/folder-upload/use-folder-upload-progress.hook.ts
  purpose: Follows the folder-upload progress push channel for one game, restoring the current snapshot on mount.
  exports: useFolderUploadProgress
  dependencies: api.folderOnProgress (push subscription), api.folderGetProgress; FolderUploadProgress
  data_shapes: { game, progress } snapshot keyed by game
  side_effects: IPC subscribe/unsubscribe
  role: React hook
  observations:
    - Pushed snapshots win over a late initial getProgress answer via pushedRef (use-folder-upload-progress.hook.ts:17-18, :36).
    - Snapshot keyed by game so switching games never shows stale data (:15-16, :47).
    - Subscription errors swallowed ("No bridge") (:30-32).
```

## app/packages/web/src/components/add-game-wizard

```yaml
- path: app/packages/web/src/components/add-game-wizard/add-game-wizard.component.tsx
  purpose: Self-contained "Add game" Radix Dialog shell that walks six steps, validates live, submits via api.createGame, and orchestrates autosave + folder-seed lifecycle.
  exports: AddGameWizard (function component), AddGameWizardProps (initialDraft?, initialStepIndex?, hideTrigger?, onClose?)
  dependencies: react (useState/useEffect/useRef), react-router-dom useNavigate, sonner toast, lucide-react Plus/Loader2; '@/components/ui/button.component', '@/components/ui/dialog.component'; ../../api.service.js (api.games, api.createGame, api.clearGameDraft; type GameServer); ./identity-step, ./resources-step, ./networking-step, ./storage-step, ./environment-step, ./review-step; ../folder-upload/folder-seed-section.component.js (FolderSeedSection); ../folder-upload/use-folder-seed.hook.js (useFolderSeed: reset/persistAs/discardPersisted/scan); ./use-wizard-draft-autosave.hook.js; ./wizard-form.utils.js (WIZARD_STEPS, createEmptyWizardDraft, draftToPayload, stepForIssuePath, validateStep); type GameServerValidationIssue from @hyveon/shared/gameServerValidator
  data_shapes: WizardDraft state; stepIndex number; existingGames GameServer[] (from api.games() entries' .config); serverIssues GameServerValidationIssue[] | null; GameWriteResult branches ok | code in validation/conflict/not_found/setup_incomplete/error; CreateGamePayload {name, config}
  side_effects: IPC via api.games() on every open (:148-163), api.createGame (:252), api.clearGameDraft (:272); folder-seed persist/discard IPC via useFolderSeed (:180, :261); autosave IPC via hook; toast.success (:262); router navigate to /games/<name> (:274); DOM scrollTop reset on step change (:141-143)
  role: UI component (dialog/wizard shell, container)
  observations:
    - Dialog open state seeded from initialDraft !== undefined rather than a controlled prop so the dialog's own onOpenChange stays the single close source (add-game-wizard.component.tsx:103-109).
    - openRef mirrors open synchronously so a late createGame result after Escape/overlay close is dropped (add-game-wizard.component.tsx:117-122, :258, :295, :299).
    - handleOpenChange (dialog-initiated close) discards the persisted folder selection; successful submit closes via applyOpen(false) directly so the selection is kept (add-game-wizard.component.tsx:177-193, :273).
    - patchHealthCheck merges via functional setDraft updater to avoid stale-closure loss of a batched patch (add-game-wizard.component.tsx:207-221); patchDraft uses functional updater too (:204).
    - Every patch clears serverIssues and submitError (add-game-wizard.component.tsx:200-205); serverIssues replace liveIssues entirely while set (:223-228); on review all server issues show, otherwise filtered per step.
    - Next/Submit disabled whenever stepIssues non-empty (add-game-wizard.component.tsx:230, :354, :359); Back disabled at step 0 or while submitting (:350).
    - Validation failure jumps to the step of the FIRST issue's path only (add-game-wizard.component.tsx:279-284); conflict/not_found/setup_incomplete/error and thrown errors set submitError and jump to Review (:286-297).
    - clearGameDraft is awaited before close/navigate to avoid racing the games-page resume banner (add-game-wizard.component.tsx:267-272).
    - Success toast copy differs on whether a folder was scanned (add-game-wizard.component.tsx:262-266).
    - api.games() failure silently falls back to [] existing games — collision checks then pass client-side (add-game-wizard.component.tsx:157-159).
    - The storage step renders FolderSeedSection beside StorageStep, with folderSeed hook state hoisted here so it survives step navigation (add-game-wizard.component.tsx:133-135, :339-344).
    - Module doc says autosave ~1s and clear only on success (add-game-wizard.component.tsx:9-15); ReviewStep gets submitError, other steps do not.

- path: app/packages/web/src/components/add-game-wizard/add-game-wizard.component.test.tsx
  purpose: jsdom/RTL tests for AddGameWizard shell behaviours.
  exports: none
  dependencies: vitest, @testing-library/react, user-event; mocks ../../api.service.js (games, createGame, get/save/updateStepIndex/clearGameDraft, folderPick/GetSelection/Rescan/SetSelection/ClearSelection), sonner, react-router-dom useNavigate; wraps NetworkingStep to capture onHealthCheckChange; ../folder-upload/folder-upload.test-utils.js makeScan
  data_shapes: GameWriteResult fixtures; WizardDraft initialDraft fixtures
  side_effects: none (fake timers in autosave block)
  role: test
  observations:
    - Pins: Next disabled on blank/invalid identity; scroll reset on step change; success toast+navigate+close; https webPort required then submitted, omitted when https toggled off; folder seed kept across steps, persisted under final name on submit, cleared on Escape cancel, kept on create, not persisted without pick; validation failure jumps to Identity; conflict stays on Review with alert; autosave none-when-empty, after ~1s, flush on unmount and Escape, none while submitting, clear only on success; batched health-check patches; resume prefill; resumed step-only nav uses updateGameDraftStepIndex not saveGameDraft; field edit on resumed draft triggers saveGameDraft; onClose fires.
    - fillResourcesStep's doc claims both sliders render unset, but createEmptyWizardDraft defaults cpu=1024/memory=2048, so the pointerUp commits are no-ops (isUnset false) and the default pairing is what passes (add-game-wizard.component.test.tsx:101-115 vs wizard-form.utils.ts:187-193).

- path: app/packages/web/src/components/add-game-wizard/use-wizard-draft-autosave.hook.ts
  purpose: RxJS debounce-autosave hook persisting the wizard draft/step index with flush/reset/markFieldEdited handle.
  exports: useWizardDraftAutosave, UseWizardDraftAutosaveOptions, UseWizardDraftAutosaveResult
  dependencies: react (useEffect/useRef/useState), rxjs Subject/merge, rxjs/operators debounceTime/filter; ../../api.service.js (api.saveGameDraft, api.updateGameDraftStepIndex); type WizardDraft
  data_shapes: DraftSaveEvent {draft, stepIndex, hasFieldEdit} (:32-36)
  side_effects: IPC api.saveGameDraft(draft, stepIndex) (:169) or api.updateGameDraftStepIndex(stepIndex) (:172)
  role: React hook
  observations:
    - Header warns effects must not be reordered: unmount-flush effect declared before subscribe effect so its cleanup runs first while subscription is live (use-wizard-draft-autosave.hook.ts:10-15, :143-152).
    - hasFieldEditRef gates full saves so a resumed (redacted) draft never overwrites unredacted on-disk values on mere navigation; step-only changes use updateGameDraftStepIndex (use-wizard-draft-autosave.hook.ts:73-86, :168-173).
    - hasStoredDraftRef seeded from hasStoredDraftInitially, set true after first full save (use-wizard-draft-autosave.hook.ts:88-93, :170).
    - submittingRef re-checked at debounce fire time via filter placed after debounceTime(1000) (use-wizard-draft-autosave.hook.ts:95-105, :160-165).
    - flush$ bypasses debounce and submitting gate (use-wizard-draft-autosave.hook.ts:107-121, :166).
    - Subjects created via useState lazy initializer as create-once storage (use-wizard-draft-autosave.hook.ts:120-121).
    - saveGameDraft/updateGameDraftStepIndex results are fire-and-forget (`void`), errors unhandled here (use-wizard-draft-autosave.hook.ts:169, :172).
    - Doc mentions "finding E5" extraction origin (use-wizard-draft-autosave.hook.ts:3).

- path: app/packages/web/src/components/add-game-wizard/wizard-form.utils.ts
  purpose: WizardDraft type family, draft<->GameServer/payload converters, issue-path→step routing, and client validation delegating to the shared validateGameServer.
  exports: WIZARD_STEPS, WizardStep, WizardMode, WizardDraftPort, WizardDraftVolume, WizardDraftFileSeed, WizardDraftEnvironmentVariable, WizardDraftHealthCheck, WizardDraft, DEFAULT_WIZARD_CPU (1024), DEFAULT_WIZARD_MEMORY (2048), createEmptyWizardDraft, draftFromGameServer, draftToPayload, stepForIssuePath, validateWizardDraft, validateStep, canAdvance, validateIdentityStep/ResourcesStep/NetworkingStep/StorageStep/EnvironmentStep/ReviewStep, messageFor
  dependencies: @hyveon/shared/gameServerValidator (validateGameServer, validateHealthCheckAuthInput, checkConnectMessagePlaceholders, isValidIcmpType, GAME_NAME_PATTERN, GAME_NAME_PATTERN_DESCRIPTION, GameServerValidationIssue); @hyveon/shared (ADD_GAME_WIZARD_STEPS, AddGameWizardStep); types from ../../api.service.js (CreateGamePayload, GameServer, GameServerHealthCheck, GameServerHealthCheckCondition, GameServerHealthCheckAuthWriteInput, GameServerHealthCheckWriteInput, RedactedGameServer)
  data_shapes: WizardDraft (snake_case mirror of GameServer + pinnedHostname?, https, webPort, healthCheck draft with authType none/raw/basic/bearer and write-only username/password/token + secretSet) (:153-174, :109-125); CreateGamePayload {name, config}
  side_effects: none (pure)
  role: utility / validation module
  observations:
    - WIZARD_STEPS re-exported from @hyveon/shared ADD_GAME_WIZARD_STEPS, also GameWizardDraftService's stepIndex range source (wizard-form.utils.ts:35-46).
    - 'edit' mode skips name validation entirely to tolerate legacy pre-pattern names (wizard-form.utils.ts:48-60, :435-438).
    - Default draft seeds a data→/data volume and 1 vCPU/2 GiB (wizard-form.utils.ts:176-205).
    - draftFromGameServer coerces https with === true because hcl2json may return unevaluated strings (wizard-form.utils.ts:214-221, :244) — references @cdktf/hcl2json even though IaC moved to Pulumi.
    - draftFromGameServer blanks secretArn/username/password/token and sets authType from secretSet + redacted authType, fallback 'raw' (wizard-form.utils.ts:257-262).
    - Health-check auth write convention: undefined = keep, null = clear (none + secretSet), object = set; basic submits if either field non-blank (wizard-form.utils.ts:277-337).
    - parseHealthCheckValue coerces "true"/"false"/"null"/numeric strings to JSON scalars (wizard-form.utils.ts:268-275).
    - draftToPayload and toProposedEntry are near-duplicate bodies (ports/volumes/file_seeds/environment/command mapping) with small differences: payload trims connect_message, proposed passes untrimmed; proposed always includes pinnedHostname key; payload uses ?? 0 fallbacks (wizard-form.utils.ts:348-383 vs :463-493).
    - toStructuralHealthCheckPreview strips auth for basic/bearer/null because the persisted schema requires secretArn which doesn't exist client-side (wizard-form.utils.ts:495-518).
    - checkIcmpPortType replaces the shared checkIcmpPortRules issue at the same path to avoid duplicate bullets (wizard-form.utils.ts:533-556, :594-596).
    - On any validateGameServer failure, connect_message placeholders re-checked and issues deduped by path+message (wizard-form.utils.ts:593-605, :608-628).
    - Name placeholder '__draft__' used when name blank so port self-exclusion never matches a real game (wizard-form.utils.ts:62-63, :591).
    - stepForIssuePath routes by first path segment; unknown → review (wizard-form.utils.ts:395-419).
    - Module doc references "#99" and "POST /api/games" although the app has no HTTP transport (wizard-form.utils.ts:2, :340).

- path: app/packages/web/src/components/add-game-wizard/wizard-form.utils.test.ts
  purpose: Unit tests for wizard-form.utils converters, routing and validators.
  exports: none
  dependencies: vitest; ./wizard-form.utils.js; type RedactedGameServer
  data_shapes: WizardDraft / RedactedGameServer fixtures
  side_effects: none
  role: test
  observations:
    - Pins: default draft shape; stepForIssuePath mapping incl. environment/command/pinnedHostname; name required/pattern/collision and edit-mode skip; image required; connect_message placeholder caught even when structurally incomplete; Fargate cpu/memory pairing; intra-draft port collision case-insensitive protocol (TCP vs tcp) and cross-game collision naming the other game, no self-collision; ICMP range single issue; https webPort required/reserved 80/443/duplicate tcp port/ignored when https off, still flagged with empty volumes; volumes min-1, absolute paths; round-trip draftFromGameServer→draftToPayload; authType restore and legacy 'raw' fallback; pinnedHostname omission/passthrough; https string coercion; visibility public omitted on submit; auth undefined/null/object conventions; env token unknown/ipv4-requires-command; canAdvance.
    - Coercion test cites "design D6" (wizard-form.utils.test.ts:604).

- path: app/packages/web/src/components/add-game-wizard/identity-step.component.tsx
  purpose: Identity step form (name, image, connect_message).
  exports: IdentityStep, IdentityStepProps
  dependencies: '@/components/ui/form-field.component' FormField, '@/components/ui/input.component' Input; types GameServerValidationIssue, WizardDraft
  data_shapes: patch Partial<Pick<WizardDraft,'name'|'image'|'connect_message'>>
  side_effects: none
  role: UI component (presentational)
  observations:
    - nameDisabled prop for reuse by EditGameForm (identity-step.component.tsx:14-21, :45).
    - Local errorFor duplicates messageFor from wizard-form.utils (identity-step.component.tsx:35 vs wizard-form.utils.ts:716-718).

- path: app/packages/web/src/components/add-game-wizard/identity-step.component.test.tsx
  purpose: Tests IdentityStep render/onChange/error display.
  exports: none
  dependencies: vitest, RTL, user-event
  data_shapes: WizardDraft fixtures
  side_effects: none
  role: test
  observations:
    - Pins value rendering, per-field onChange patch, error message by exact path, no aria-invalid without matching issue.

- path: app/packages/web/src/components/add-game-wizard/resources-step.component.tsx
  purpose: vCPU/memory range sliders indexing Fargate tier tables with live hourly cost.
  exports: ResourcesStep, ResourcesStepChange
  dependencies: @hyveon/shared/gameServerValidator (getFargateCpuOptions, getFargateMemoryOptions, estimateFargateHourlyCost); ../../lib/format.utils.js formatUsd
  data_shapes: change {cpu, memory} always both
  side_effects: none
  role: UI component (presentational)
  observations:
    - Sliders hold indexes into option arrays; unset renders at index 0 (resources-step.component.tsx:70-101).
    - onPointerUp commits only when value is null; onKeyUp commits for index<0 on RANGE_COMMIT_KEYS only (Tab excluded) (resources-step.component.tsx:33-68).
    - cpu change resets memory to null if not valid for new tier (resources-step.component.tsx:108-114).
    - Memory slider disabled when cpu null (resources-step.component.tsx:167).
    - Cost formatted 4 digits, no grouping, "/hr while running" (resources-step.component.tsx:189-193).
    - Inline issues.find for cpu/memory errors duplicates messageFor (resources-step.component.tsx:103-104).
    - Props interface is non-exported `Props` (resources-step.component.tsx:16).

- path: app/packages/web/src/components/add-game-wizard/resources-step.component.test.tsx
  purpose: Tests ResourcesStep slider/commit/cost behaviour.
  exports: none
  dependencies: vitest, RTL fireEvent, shared Fargate helpers
  data_shapes: none
  side_effects: none
  role: test
  observations:
    - Pins slider bounds, memory pairings, disabled memory without cpu, pointerUp/keyUp commit on unset, Tab not committing, memory reset on incompatible cpu, 16 vCPU 8 GiB step, cost text, out-of-table cpu=100 not overwritten by pointerUp but correctable by arrow key.

- path: app/packages/web/src/components/add-game-wizard/networking-step.component.tsx
  purpose: Networking step: port row editor, HTTPS (Caddy) toggle + web port field, health-check toggle hosting HealthCheckFields.
  exports: NetworkingStep, NetworkingStepProps
  dependencies: lucide-react AlertTriangle; '@/components/ui/button|form-field|input|label|native-select'; '@/lib/utils.utils' cn; ./health-check-fields.component.js; ./wizard-form.utils.js messageFor/types
  data_shapes: WizardDraftPort[] {container|null, protocol, visibility}; webPort number|null; WizardDraftHealthCheck patch
  side_effects: none
  role: UI component (presentational)
  observations:
    - Protocol options tcp/udp/icmp; switching a blank row to icmp prefills container 8 (networking-step.component.tsx:36-40, :237-246).
    - Row highlight matches ports[i] or ports[i].* prefixes (networking-step.component.tsx:70-81).
    - HTTPS callout states 443/80 open for whole stack and ACME issuance on first boot (networking-step.component.tsx:137-150).
    - Web port field and "Additional ports (optional)" heading only while https (networking-step.component.tsx:152-187).
    - Health-check gets webPort only when https on (networking-step.component.tsx:320).
    - Row keys are array indexes (networking-step.component.tsx:200).
    - Doc refers to openspec change `replace-alb-with-caddy-sidecar` (networking-step.component.tsx:17).

- path: app/packages/web/src/components/add-game-wizard/networking-step.component.test.tsx
  purpose: Tests NetworkingStep rows, HTTPS toggle, web port, ICMP, health-check auth selector.
  exports: none
  dependencies: vitest, RTL, user-event; createEmptyWizardDraft
  data_shapes: port fixtures
  side_effects: none
  role: test
  observations:
    - Pins add/remove/edit rows, visibility internal, row-scoped error highlight (row & field paths), HTTPS callout text and aria-describedby, web port number/null, webPort issue aria-invalid, web port listed first in health-check port options, icmp prefill/no-overwrite/hint/relabel, auth fields per authType, "credential is already set" with secretSet.

- path: app/packages/web/src/components/add-game-wizard/health-check-fields.component.tsx
  purpose: Health-check subsection fields (scheme/port/method/timeout/path/jsonPath/operator/value) and credential fields per authType.
  exports: HealthCheckFields, HealthCheckFieldsProps, HealthCheckAuthFieldsProps (HealthCheckAuthFields itself is not exported)
  dependencies: '@/components/ui/form-field|input|native-select'; ./wizard-form.utils.js messageFor/types
  data_shapes: Partial<WizardDraftHealthCheck> patches
  side_effects: none
  role: UI component (presentational)
  observations:
    - Option lists: scheme http/https, method GET/POST/PUT/PATCH/HEAD, operators equals/notEquals/greaterThan/lessThan/contains/exists, auth none/raw/basic/bearer (health-check-fields.component.tsx:22-37).
    - Port is a select of declared container ports + optional web port; values coerced via Number (health-check-fields.component.tsx:84-103).
    - Comparison value hidden for operator exists (health-check-fields.component.tsx:178-189).
    - timeoutMs and activeWhen.value use aria-invalid only, the value error rendered separately as role=alert; no error text for timeoutMs (health-check-fields.component.tsx:129, :184, :191-195).
    - Credential values never shown; placeholders indicate re-enter when secretSet (health-check-fields.component.tsx:214-223, :259, :284, :300, :321).
    - Raw ARN: operator-managed lifecycle; basic/bearer: app-created Secrets Manager secret (health-check-fields.component.tsx:264-266, :305-307, :326-328).
    - basic/bearer hint copy repeated twice verbatim (health-check-fields.component.tsx:305-307, :326-328).
    - Header says it was extracted from networking-step (health-check-fields.component.tsx:5).

- path: app/packages/web/src/components/add-game-wizard/storage-step.component.tsx
  purpose: Storage step row editors for volumes (min 1) and optional file_seeds.
  exports: StorageStep, StorageStepProps
  dependencies: '@/components/ui/button|form-field|input|textarea'; '@/lib/utils.utils' cn; ./wizard-form.utils.js messageFor/types
  data_shapes: {volumes} / {file_seeds} patches; WizardDraftVolume, WizardDraftFileSeed
  side_effects: none
  role: UI component (presentational)
  observations:
    - Last volume's Remove disabled and removeVolume guards length<=1 (storage-step.component.tsx:59-62, :103, :212).
    - Array-level `volumes` issue rendered as banner (storage-step.component.tsx:53, :90-94).
    - File-seed row border red only on path error (storage-step.component.tsx:247-250).
    - Volume description says "EFS-backed" (storage-step.component.tsx:86).

- path: app/packages/web/src/components/add-game-wizard/storage-step.component.test.tsx
  purpose: Tests StorageStep volume/file-seed row editing and error placement.
  exports: none
  dependencies: vitest, RTL, user-event
  data_shapes: draft fixtures
  side_effects: none
  role: test
  observations:
    - Pins last-volume remove disabled (and no-op on forced click), add/remove/update volumes, volumes banner, indexed errors per row, file seeds add/remove-to-zero/update all fields, path error border.

- path: app/packages/web/src/components/add-game-wizard/environment-step.component.tsx
  purpose: Environment step: env var rows, start-command argument rows, and Pin hostname switch/field.
  exports: EnvironmentStep, EnvironmentStepProps
  dependencies: @hyveon/shared/envTokens HYVEON_ENV_TOKENS; '@/components/ui/button|form-field|input|label'; ./wizard-form.utils.js messageFor/types
  data_shapes: patches {environment} / {command: string[]} / {pinnedHostname: string|undefined}
  side_effects: none
  role: UI component (presentational)
  observations:
    - Pin hostname toggle seeds from draft.name.trim() when enabled, undefined when off (environment-step.component.tsx:75-77).
    - Hint text documents publicAddress/publicIpv4 tokens and that ipv4 requires a start command and /bin/sh (environment-step.component.tsx:89-93, :157-160).
    - Pin hostname helper text says enabling on existing game requires re-accepting EULA (environment-step.component.tsx:27-28).
    - Command argument has both FormField label and explicit aria-label (environment-step.component.tsx:175, :183).
    - Module doc mentions only environment rows, not command/pinnedHostname (environment-step.component.tsx:1-13).

- path: app/packages/web/src/components/add-game-wizard/environment-step.component.test.tsx
  purpose: Tests EnvironmentStep rows, command args, and Pin hostname.
  exports: none
  dependencies: vitest, RTL, user-event
  data_shapes: draft fixtures
  side_effects: none
  role: test
  observations:
    - Pins empty state, add/edit/remove env rows, name and value errors (aria-invalid), token hint, add argument, command-level and command[i] errors, pin hostname switch on (name or ''), field editable, off→undefined, pinnedHostname error.

- path: app/packages/web/src/components/add-game-wizard/review-step.component.tsx
  purpose: Read-only summary of the draft plus outstanding issues and submit error alerts.
  exports: ReviewStep, ReviewStepProps
  dependencies: lucide-react AlertTriangle; '@/components/section-card.component' SectionCard; types
  data_shapes: WizardDraft, issues[], submitError string|null
  side_effects: none
  role: UI component (presentational)
  observations:
    - Environment variables and pinned hostname are rendered inside the "Storage" SectionCard; there is no Environment card, and `command` is not summarized at all (review-step.component.tsx:122-168).
    - Env var values are shown in plain text (review-step.component.tsx:157-160).
    - Credential row reports "Set" only for secretSet or non-blank secretArn — freshly typed basic/bearer credentials display "Not set" (review-step.component.tsx:109-112).
    - Health-check request shown as `${method} ${scheme}://…:${port}${path}` (review-step.component.tsx:101-104).
    - Issue list keyed by index and shows message only (no path) (review-step.component.tsx:179-181).
    - Doc says optional blanks omitted; volumes empty shows placeholder (review-step.component.tsx:34-49, :124-125).

- path: app/packages/web/src/components/add-game-wizard/review-step.component.test.tsx
  purpose: Tests ReviewStep summary rendering, omissions, HTTPS, issues and submit error alerts.
  exports: none
  dependencies: vitest, RTL
  data_shapes: draft fixtures
  side_effects: none
  role: test
  observations:
    - Pins all-field rendering, omission of blank connect_message/file_seeds/environment/pinnedHostname, long value wrap classes, port/volume placeholders, VPC-only/Public labels, HTTPS Enabled/Disabled, issues alert list, submit error alert, web port shown apart from "Additional ports" list.
```

## app/packages/web/src/components/first-run-wizard

```yaml
- path: app/packages/web/src/components/first-run-wizard/first-run-wizard.component.tsx
  purpose: Full-page shell for the 5-step first-run / Reconfigure wizard; owns step index (via hook), cloud choice, save bookkeeping, guided-credentials detection, Start-over reset, and the shared Back/Next/Cancel footer.
  exports: FirstRunWizard, FirstRunWizardProps (internal-only WizardStepPanel, CompletedStepSummary)
  dependencies: useWizardProgress, useAwsCredentialsForm, useBootstrapResources, useReconfigureAnswers + isGuidedProfile, STEP_LABELS/WIZARD_STEPS (wizard.utils), PickCloudStep, GuidedIamStep, CredentialsStep, BootstrapStep, StackInitializationStep, WizardStepSidebar, ConfirmDialog (../confirm-dialog.component), InlineAlert, ui/Button, BRIDGE_UNAVAILABLE (@/lib/bridge.utils), lucide-react CheckCircle2
  data_shapes: props {onComplete?, mode?: 'first-run'|'reconfigure', onCancel?}; guidedCredentials {profile, region}|null; saveState payloads {activeCloud} / {aws:{profile?,region?}} / {bootstrap:{stateBucket,configurationBucket}}
  side_effects: IPC window.hyveon.wizard.getState (mount + after guided completion), wizard.saveState (goNext per step, first-run only), wizard.reset + window.location.reload (Start over)
  role: UI component (wizard shell)
  observations:
    - Per-step persistence only in 'first-run': pick-cloud (:296-299) and credentials (:307-313) saves are awaited and block advance on failure; bootstrap save is fire-and-forget `.catch(() => {})` (:314-321).
    - Credentials save skipped when guidedCredentials is set, to avoid overwriting guided profile with `{profile:'', region:undefined}` (:300-313).
    - Next hidden for stack-init and for non-collapsed guided-iam (:251); Next enabled unconditionally on collapsed Reconfigure steps (:231-239).
    - `stepCollapsed` is computed once for the active step and passed to every WizardStepPanel (:231, :344, :354, :368, :402); harmless because inactive panels return null (:499).
    - Start over is first-run only and disabled while guided-iam is busy (:440-449); reset reloads the window rather than resetting local state (:138-153).
    - handleGuidedIamComplete awaits refreshGuidedCredentials before goNext to avoid a one-frame flicker (:182-186).
    - saveError alert passed only to pick-cloud and credentials panels (:347, :371); guided-iam and bootstrap render their own errors (:474-475).
    - Sidebar rendered only in first-run mode (:332).
    - Satisfied-summary principal is a hardcoded label 'AWS account (guided setup)' (:393).
    - Inner markup at :334-457 is indented one level less than its parent `<div>` (formatting inconsistency).

- path: app/packages/web/src/components/first-run-wizard/first-run-wizard.component.test.tsx
  purpose: jsdom/vitest integration test of the wizard shell with stubbed window.hyveon and a stubbed GuidedIamStep.
  exports: none
  dependencies: FirstRunWizard, GUIDED_PROFILE_NAME (@hyveon/desktop-preload), toStreamHandleMock (../../test-utils/stream-handle.test-utils), @testing-library/react, user-event, vitest
  data_shapes: hyveonMock with wizard.* and iac.stack.initialize
  side_effects: vi.stubGlobal('hyveon'), redefines window.location in one test (:920-935)
  role: test
  observations:
    - Pins: pick-cloud save/failure/Back-disabled-while-saving (:211-246); credentials gating/region defaulting/paste flow invalidation (:248-404); bootstrap gating incl. runsTable and deploymentConfig failures blocking Next (:441-494); IAM check non-blocking (:534-546); bootstrap names saved on advance (:548-563); stack-init Next hidden + Finish (:566-612); resume-on-mount incl. stack-init clamp to bootstrap (:641-649) and save-gated-until-resume-settles (:651-667); guided sub-state preserved/not resurrected (:669-692, :715-745); guided satisfied summary/no clobbering save (:747-789); Reconfigure guided-iam pre-completion (:792-822); commit payload omits collapsed steps (:825-880); sidebar absent in reconfigure (:884-894); Start over (:897-948).
    - Stale comments: :78-91 say bootstrapDeploymentConfig/bootstrapRunsTable "never gates bootstrapComplete/Next", contradicted by tests at :441 and :484 and by use-bootstrap-resources.hook.ts:243-246.
    - Comment references "#Group 7, Task 4" and "finding D8"/"final-review Finding 1" (:42, :123, :670, :826).

- path: app/packages/web/src/components/first-run-wizard/use-wizard-progress.hook.ts
  purpose: Owns stepIndex plus resume-on-mount (wizard.getProgress) and save-on-change (wizard.saveProgress) effects; first-run only.
  exports: useWizardProgress, UseWizardProgressResult, type WizardStep (re-export)
  dependencies: WIZARD_STEPS (wizard.utils), WizardProgress type (@hyveon/desktop-preload), react
  data_shapes: WizardProgress {step, guidedIam?: {subState, hasBootstrapKey}}
  side_effects: IPC wizard.getProgress (mount), wizard.saveProgress (every step change)
  role: React hook
  observations:
    - Resume clamped to at most 'bootstrap' so stack-init never auto-runs on relaunch (:91-92).
    - resumeSettledRef gates the save effect until resume settles; set in same microtask as setStepIndex (:61, :99-103, :140).
    - Save payload includes guidedIamInitialProgress when step==='guided-iam' (:141-142); clearGuidedIamProgress prevents stale re-save after Back (:150).
    - No bridge -> marks settled and stays at step 0 (:83-86); failures swallowed (:105-108, :143).
    - Comment says "finding D5" (:3).

- path: app/packages/web/src/components/first-run-wizard/use-aws-credentials-form.hook.ts
  purpose: Credentials-step form state: profile list fetch, profile/paste mode, paste-flow safeStorage save, completeness gate and save payload derivation.
  exports: useAwsCredentialsForm, UseAwsCredentialsFormResult
  dependencies: CredentialMode/PasteField types (credentials-step.component), AwsProfileSummary (@hyveon/desktop-preload), BRIDGE_UNAVAILABLE
  data_shapes: AwsProfileSummary[] {profileName, region?}; saveCredentials input {accessKeyId, secretAccessKey, region?} -> {profileName}; toStatePayload -> {profile?, region?}
  side_effects: IPC wizard.listAwsProfiles (mount), wizard.saveCredentials (on "Save credentials")
  role: React hook
  observations:
    - Paste submit runs immediately, not deferred to Next (:118-138).
    - Editing any paste field clears pastedProfileName, invalidating a prior save (:111-116).
    - selectProfile defaults region from the profile's configured region or '' (:105-109).
    - isFormComplete requires non-empty region in both modes (:146-149).
    - Returns a fresh object every render; useReconfigureAnswers relies on setters being stable (see use-reconfigure-answers.hook.ts:175-183).

- path: app/packages/web/src/components/first-run-wizard/use-bootstrap-resources.hook.ts
  purpose: State + IPC orchestration for the bootstrap step: two S3 buckets, run-history table, initial deployment-config seed, and IAM dry-run.
  exports: useBootstrapResources, UseBootstrapResourcesResult, BootstrapSideResourceState, BootstrapIamCheckState
  dependencies: defaultBootstrapResourceNames/BootstrapResourceKey/BootstrapResourceState (wizard.utils), IamCheckResult (@hyveon/desktop-preload), BRIDGE_UNAVAILABLE
  data_shapes: names/statuses keyed stateBucket|configurationBucket; BootstrapResult-like {status, message?}; IamCheckResult
  side_effects: IPC wizard.bootstrapStateBucket, bootstrapConfigurationBucket, bootstrapDeploymentConfig, bootstrapRunsTable, simulateIamPermissions
  role: React hook
  observations:
    - State bucket, config bucket, runs table run concurrently in one Promise.all (:155-219); deploymentConfig seed is chained after config bucket returns created/exists (:180-196).
    - Config bucket non-success or throw marks seed 'failed' with explanatory message (:180-183, :203-204).
    - `complete` requires both buckets AND runsTable AND deploymentConfig created/exists (:243-246); IAM check never gates.
    - Bridge-missing path marks all four failed (:135-146).
    - `result.status as BootstrapResourceState` casts backend status (:158, :176, :189, :211).
    - Docstring on runsTable references "runsTableStatus's prior doc comment in the shell" which no longer exists in the shell (:39).
    - No lockTable call by design (:116-118).

- path: app/packages/web/src/components/first-run-wizard/use-reconfigure-answers.hook.ts
  purpose: Reconfigure-mode bookkeeping: pre-collapsed steps, one-shot prefill from wizard.getState, and buffered commit of only edited steps.
  exports: useReconfigureAnswers, isGuidedProfile, ReconfigureCredentialsParams, UseReconfigureAnswersOptions, UseReconfigureAnswersResult
  dependencies: GUIDED_PROFILE_NAME + AwsProfileSummary (@hyveon/desktop-preload), CloudOption, CredentialMode, BootstrapResourceKey/WizardStep, BRIDGE_UNAVAILABLE
  data_shapes: WizardState-like {activeCloud?, aws?: {profile?, region?}, bootstrap?}; commit payload {activeCloud?, aws?, bootstrap?}
  side_effects: IPC wizard.getState (prefill, reconfigure only), wizard.saveState (commit)
  role: React hook
  observations:
    - RECONFIGURE_PRE_COMPLETED_STEPS = pick-cloud, credentials, bootstrap (:29); guided-iam added only if aws.profile === GUIDED_PROFILE_NAME (:150-151).
    - Prefill waits for profiles or profilesError before firing, then applies once via prefillAppliedRef (:134-137).
    - Non-~/.aws profile is assumed to be a pasted `creds.aws.<profile>` entry (:153-164).
    - commitReconfigureAnswers omits collapsed steps; no-op if payload empty; throws if bridge missing (:215-231).
    - guided-iam edits are not part of the commit payload (:219-228); commit does not consult the shell's guidedCredentials, so an Edit-opened credentials step that still shows the guided summary would send toStatePayload() of the untouched form (appears to differ from first-run's guard at first-run-wizard.component.tsx:307).
    - eslint-disable for exhaustive-deps with justification (:175-184).
    - Comments reference findings D4/D7/D8/D9 and "once D9 lands" though D9 (useAwsCredentialsForm) already exists (:6-9, :45).

- path: app/packages/web/src/components/first-run-wizard/use-guided-iam.hook.ts
  purpose: Phase machine + IPC orchestration for guided-IAM provisioning (template render, console open, key intake, mint-then-revoke rotation, manual revoke), with resume and sub-state persistence.
  exports: useGuidedIam, GuidedIamPhase, UseGuidedIamOptions, UseGuidedIamResult
  dependencies: WizardProgress (@hyveon/desktop-preload), BRIDGE_UNAVAILABLE, useCopiedReset (../../hooks/use-copied-reset.hook)
  data_shapes: GuidedIamPhase region|template|intake|rotating|verification-failed|delete-failed; subState not-started|template-written|awaiting-key-intake|rotation-pending|complete; rotate result {status:'complete'}|{status:'verification-failed', error}|{status:'delete-failed', consoleUrl}; revoke result {revoked, message?}
  side_effects: IPC wizard.getState, saveProgress, guidedIamPrepareTemplate, guidedIamOpenConsole, guidedIamSubmitBootstrapKey, guidedIamRotate, guidedIamRevokeBootstrapKey; navigator.clipboard.writeText
  role: React hook
  observations:
    - Bootstrap key kept only in memory; secret field cleared after capture; saveProgress only receives hasBootstrapKey boolean (:26-30, :152, :407-411).
    - persistProgress swallows errors (:191-198).
    - mountedRef re-armed in effect for StrictMode remount (:168-174).
    - busy = submitting || rotating || revoking, reported via onBusyChange, reset to false on unmount (:177-183).
    - Resume: rotation-pending always lands on intake even without region (:234-241); template-written/awaiting-key-intake land on template if region recoverable else region screen with note (:243-250). awaiting-key-intake resumes to template, not intake.
    - Region recovered from wizard.getState().aws.region only (:221-232).
    - Template render effect has no synchronous setState; preparingTemplate is derived (:139, :268-287).
    - runRotation takes region explicitly to avoid stale closure (:331-343); verification-failed does not re-persist (:363-370).
    - onRetryRotation no-ops if bootstrapKey null (:424).
    - Disclosed scope reduction: no reveal-in-file-manager, copy-path only (:461-474).

- path: app/packages/web/src/components/first-run-wizard/guided-iam-step.component.tsx
  purpose: Guided-IAM step component; renders a resuming spinner or one screen per phase from useGuidedIam.
  exports: GuidedIamStep, GuidedIamStepProps
  dependencies: useGuidedIam, AWS_REGIONS/AwsRegionInfo (@hyveon/shared), WizardProgress, five GuidedIam*Screen components (imported via '@/components/first-run-wizard/...' alias), lucide Loader2
  data_shapes: REGIONS_BY_CONTINENT Array<[continent, AwsRegionInfo[]]>
  side_effects: none directly (via hook)
  role: UI component
  observations:
    - REGIONS_BY_CONTINENT computed at module load (:12-20).
    - Single switch guarantees one phase's markup in DOM at a time, cited as relied upon by guided-iam-wizard.spec.ts (:94-96).
    - intake and rotating share GuidedIamIntakeScreen (:129-145).
    - Docstring references docs/superpowers/plans/bootstrap-7-wizard-ui.md (:47) — file exists.
    - Imports siblings with '@/components/first-run-wizard/...' alias while other files use './...' (:4-8).

- path: app/packages/web/src/components/first-run-wizard/guided-iam-step.component.test.tsx
  purpose: jsdom tests of GuidedIamStep's full phase flow with stubbed window.hyveon.
  exports: none
  dependencies: GuidedIamStep, testing-library, vitest; stubs Element.prototype pointer-capture/scrollIntoView for Radix Select (:8-15)
  data_shapes: hyveonMock.wizard guided-IAM methods
  side_effects: vi.stubGlobal, navigator.clipboard override
  role: test
  observations:
    - Pins: skip-to-manual persists nothing (:75-83); empty region rejected (:85-92); not-started/template-written/awaiting-key-intake/rotation-pending/complete persistence order (:94-108, :152-169, :251-306); secrets never in saveProgress (:166-168, :308-311); template retry (:171-186); no-clipboard safe (:188-199); console open/URL fallback/error non-blocking (:201-249); intake validation failure (:314-327); verification-failed retry reuses key without re-intake and does not re-persist (:331-387); delete-failed has no bypass, revoke success/retry (:389-465); resume semantics incl. rotation-pending never to region screen (:468-611).

- path: app/packages/web/src/components/first-run-wizard/guided-iam-region-screen.component.tsx
  purpose: Region phase screen: Radix Select of AWS regions grouped by continent with "Other" manual entry, plus guided vs "I already have credentials" choice.
  exports: GuidedIamRegionScreen, GuidedIamRegionScreenProps, OTHER_REGION_VALUE
  dependencies: AwsRegionInfo (@hyveon/shared), ui/select, Input, Label, Button, InlineAlert
  data_shapes: props
  side_effects: none
  role: UI component (presentational)
  observations:
    - OTHER_REGION_VALUE='__other__' sentinel because Radix forbids empty-string item value (:17-18); selecting it switches to free-text and clears region (:73-77).
    - Prop doc points to "guided-iam-step.component.tsx's resume effect" but the effect lives in use-guided-iam.hook.ts:217 (:22).

- path: app/packages/web/src/components/first-run-wizard/guided-iam-template-screen.component.tsx
  purpose: Template phase screen: render spinner/error+Retry, template path with copy, Open AWS Console with URL fallback, Continue to key entry.
  exports: GuidedIamTemplateScreen, GuidedIamTemplateScreenProps
  dependencies: InlineAlert, Button, Input, Label, lucide icons
  data_shapes: props
  side_effects: none
  role: UI component (presentational)
  observations:
    - Console and Continue actions only render once templatePath is set (:83, :116); console error does not block Continue.

- path: app/packages/web/src/components/first-run-wizard/guided-iam-intake-screen.component.tsx
  purpose: Intake/rotating screen: region, access key ID, secret (password) inputs, rotation-pending resume banner, submit or rotating spinner.
  exports: GuidedIamIntakeScreen, GuidedIamIntakeScreenProps
  dependencies: InlineAlert, Button, Input, Label, lucide Loader2
  data_shapes: props
  side_effects: none
  role: UI component (presentational)
  observations:
    - Inputs disabled while rotating or submitting (:40); submit button replaced by spinner during rotation (:86-96).

- path: app/packages/web/src/components/first-run-wizard/guided-iam-verification-failed-screen.component.tsx
  purpose: verification-failed screen: error alert plus Retry rotation.
  exports: GuidedIamVerificationFailedScreen, GuidedIamVerificationFailedScreenProps
  dependencies: InlineAlert, Button, lucide RotateCcw
  data_shapes: props
  side_effects: none
  role: UI component (presentational)
  observations:
    - Falls back to 'Key rotation failed verification.' when rotationError is null (:19).

- path: app/packages/web/src/components/first-run-wizard/guided-iam-delete-failed-screen.component.tsx
  purpose: delete-failed screen: warns bootstrap key still live, links IAM console URL, offers "Revoke now".
  exports: GuidedIamDeleteFailedScreen, GuidedIamDeleteFailedScreenProps
  dependencies: InlineAlert, Button, lucide icons
  data_shapes: props
  side_effects: external link target=_blank (:31-38)
  role: UI component (presentational)
  observations:
    - No bypass/continue action; only Revoke now (:44-47).

- path: app/packages/web/src/components/first-run-wizard/credentials-step.component.tsx
  purpose: Presentational credentials step: profile picker + region, or paste-keys form; or a satisfied summary when guided provisioning already set credentials.
  exports: CredentialsStep, CredentialsStepProps, CredentialMode, PasteField
  dependencies: AwsProfileSummary, InlineAlert, Button, Input, Label
  data_shapes: props
  side_effects: none
  role: UI component (presentational)
  observations:
    - Satisfied summary replaces the whole form, with "Switch to a different source" escape hatch (:99-116).
    - Uses a native <select> for profiles (:160-172), unlike the Radix Select in the guided region screen.
    - Docstring says "the parent wizard shell owns all state, the listAwsProfiles/saveCredentials IPC calls" (:71-73) — now owned by useAwsCredentialsForm hook.
    - Doc mentions "#Group 7" (:47).

- path: app/packages/web/src/components/first-run-wizard/credentials-step.component.test.tsx
  purpose: Presentational tests for CredentialsStep.
  exports: none
  dependencies: CredentialsStep, testing-library
  data_shapes: SAMPLE_PROFILES
  side_effects: none
  role: test
  observations:
    - Pins satisfied summary/escape hatch (:42-78), profile dropdown/loading/empty/error/region (:79-125), mode toggle aria-pressed (:127-142), paste form fields/save/disabled/error/confirmation (:144-188).

- path: app/packages/web/src/components/first-run-wizard/bootstrap-step.component.tsx
  purpose: Presentational bootstrap step: two editable bucket rows, read-only run-history table and initial-configuration rows, run/re-run button, IAM check panel.
  exports: BootstrapStep, BootstrapStepProps (internal ResourceRow, StatusRow, StatusBadge)
  dependencies: IamCheckPanel, BootstrapResourceKey/State (wizard.utils), IamCheckResult, Button, Badge, Input, lucide icons
  data_shapes: props
  side_effects: none
  role: UI component (presentational)
  observations:
    - Name input disabled once resource succeeded or while bootstrapping (:162).
    - "Public access blocked" is shown purely as a function of created/exists status, not separate state (:126-139, :165-170).
    - Button label switches to "Re-run bootstrap" if any of the 4 statuses is created/exists (:114-118).
    - Docstring says it provisions "the two backend resources" and "only the two bootstrap resources ... gates" (:64-72) and onRunBootstrap doc says "both bootstrap operations" (:29); body text says three resources (:92) and gating actually includes 4 items (use-bootstrap-resources.hook.ts:243-246) — stale docs.

- path: app/packages/web/src/components/first-run-wizard/bootstrap-step.component.test.tsx
  purpose: Presentational tests for BootstrapStep and its IamCheckPanel states.
  exports: none
  dependencies: BootstrapStep, IamCheckResult, testing-library
  data_shapes: NAMES, PENDING fixtures
  side_effects: navigator.clipboard override (:197)
  role: test
  observations:
    - Pins rows/names, name-change, run click, failure message, PAB shown only for created/exists, sibling independence, disabled while bootstrapping, runs-table and initial-config rows, Re-run label, IAM passed/missing/copy/warning (renders 'ecs:*' from HYVEON_DEPLOY_ALL_ACTIONS)/error (:44-227).

- path: app/packages/web/src/components/first-run-wizard/iam-check-panel.component.tsx
  purpose: IAM permission dry-run panel with run/re-run and passed/missing/warning/error states.
  exports: IamCheckPanel, IamCheckPanelProps
  dependencies: HYVEON_DEPLOY_ALL_ACTIONS (@hyveon/shared), IamCheckResult, InlineAlert, Button
  data_shapes: IamCheckResult {status: passed|missing|warning, policyJson?, message?, origin, blocking}
  side_effects: navigator.clipboard.writeText (copy policy JSON)
  role: UI component
  observations:
    - Missing state rendered only if policyJson present (:50).
    - Warning state renders full HYVEON_DEPLOY_ALL_ACTIONS list and points to docs/docs/setup.md HyveonDeployAll (:78-93).
    - Clipboard call assumes navigator.clipboard exists (no guard) (:66), unlike use-guided-iam.hook.ts:476.
    - IamCheckResult.blocking/origin fields are not consulted here.

- path: app/packages/web/src/components/first-run-wizard/stack-init-step.component.tsx
  purpose: Final step: streams iac.stack.initialize() phase events into a 3-row checklist, Retry on failure, Finish setup calls onBeforeFinish then wizard.complete.
  exports: StackInitializationStep, StackInitializationStepProps, StackInitPhaseState, StackInitStatus
  dependencies: HyveonStreamHandle/StackInitPhase/StackInitPhaseEvent (@hyveon/desktop-preload), InlineAlert, Button, BRIDGE_UNAVAILABLE
  data_shapes: StackInitPhaseEvent {phase: engine|plugins|operation, status: start|end}; run state {attempt, phases, status, errorMessage}
  side_effects: IPC stream window.hyveon.iac.stack.initialize(), handle.cancel(); wizard.complete
  role: UI component (stateful)
  observations:
    - setTimeout(0) debounce so StrictMode remount yields exactly one real initialize call; cancel() only stops consumption, not backend op (:118-122).
    - Run state tagged with attempt so Retry shows clean slate without sync setState in effect (:75-91).
    - Any non-'start' event status is treated as 'done' (:152).
    - On stream throw, the last started phase is marked failed (:128-144).
    - Finish disabled until status==='success' (:217); onBeforeFinish rejection prevents wizard.complete (:175-176).
    - Doc says onBeforeFinish is skipped in first-run "which already persists pick-cloud/credentials" (:46-47) — omits bootstrap which is also persisted (first-run-wizard.component.tsx:314-321).
    - PHASE_ORDER said to mirror PulumiProvisioningPhase in PulumiEngineService.ts (:14-22).

- path: app/packages/web/src/components/first-run-wizard/stack-init-step.component.test.tsx
  purpose: Tests StackInitializationStep streaming, StrictMode single-call, retry, finish ordering.
  exports: none
  dependencies: StackInitializationStep, toStreamHandleMock, StrictMode
  data_shapes: StackInitPhaseEvent generators
  side_effects: vi.stubGlobal
  role: test
  observations:
    - Pins: all phases pending initially, initialize() called with no args, exactly once under StrictMode, Finish gated on success, failure error+Retry re-invokes, onBeforeFinish awaited before complete, complete failure shows error (:42-221).
    - The "in progress then done" test (:82-106) only asserts label text presence, not icon state.

- path: app/packages/web/src/components/first-run-wizard/pick-cloud-step.component.tsx
  purpose: Presentational cloud picker; only AWS in v1, rendered as radio-role buttons.
  exports: PickCloudStep, PickCloudStepProps, CloudOption ('aws')
  dependencies: lucide CheckCircle2
  data_shapes: CLOUD_OPTIONS list
  side_effects: none
  role: UI component (presentational)
  observations:
    - Docstring calls it the "Second step" (:20) but it is index 0 in WIZARD_STEPS (first step).

- path: app/packages/web/src/components/first-run-wizard/pick-cloud-step.component.test.tsx
  purpose: Tests PickCloudStep renders single AWS radio, checked, footer, onSelect('aws').
  exports: none
  dependencies: PickCloudStep
  data_shapes: none
  side_effects: none
  role: test
  observations: Pins single-option rendering and aria-checked (:11-33).

- path: app/packages/web/src/components/first-run-wizard/wizard-step-sidebar.component.tsx
  purpose: Non-interactive progress list (completed/current/upcoming) shown at md+ breakpoint.
  exports: WizardStepSidebar, WizardStepSidebarProps
  dependencies: cn (@/lib/utils.utils), WizardStep
  data_shapes: steps, currentIndex, labels
  side_effects: none
  role: UI component (presentational)
  observations:
    - Hidden below md (:28); aria-current='step' on current (:36); no interactive roles by design (:19-22).

- path: app/packages/web/src/components/first-run-wizard/wizard-step-sidebar.component.test.tsx
  purpose: Tests sidebar state attributes and non-interactivity.
  exports: none
  dependencies: WizardStepSidebar
  data_shapes: STEPS/LABELS fixtures (hardcoded 5-step list, :6)
  side_effects: none
  role: test
  observations: Pins data-state completed/current/upcoming, aria-current, zero buttons/links (:16-67).

- path: app/packages/web/src/components/first-run-wizard/wizard.utils.ts
  purpose: Pure helpers: re-exports WIZARD_STEPS/WizardStep, STEP_LABELS, bootstrap resource key/state types, default resource names.
  exports: WIZARD_STEPS, WizardStep, STEP_LABELS, BootstrapResourceKey, BootstrapResourceState, defaultBootstrapResourceNames
  dependencies: WIZARD_STEPS/WizardStep (@hyveon/shared)
  data_shapes: {stateBucket: `${p}-tfstate`, configurationBucket: `${p}-config`}
  side_effects: none (pure)
  role: utility
  observations:
    - Default state bucket suffix is '-tfstate' (:46) even though the backend is Pulumi (legacy naming).
    - Default project name 'hyveon' said to match PULUMI_PROJECT_NAME in desktop-main PulumiWorkspaceService.ts (:36-43) — duplicated literal, not imported.
    - BootstrapResourceKey deliberately excludes a lock table (:19-26).

- path: app/packages/web/src/components/first-run-wizard/wizard.utils.test.ts
  purpose: Tests defaultBootstrapResourceNames default and custom project name.
  exports: none
  dependencies: defaultBootstrapResourceNames
  data_shapes: none
  side_effects: none
  role: test
  observations: Pins 'hyveon-tfstate'/'hyveon-config' defaults (:5-17).
```

## Observed behaviours

### Top-level components, edit-game-form, folder-upload

- Diagnostics log tail polls every 5 s and freezes the displayed snapshot while paused; resume jumps straight to the latest fetched snapshot — app/packages/web/src/components/DiagnosticsPanel.test.tsx:90-109, :138-188 (implementation in use-diagnostics-tail.hook, referenced from DiagnosticsPanel.tsx:19).
- Diagnostics bundle export: save-dialog cancel is a silent no-op returning to idle; written path offers "Show in folder" — app/packages/web/src/components/export-bundle-button.component.tsx:40-50, :73-85.
- Pulumi log viewer auto-scrolls only while within 24 px of the bottom; scrolling up pauses auto-scroll — app/packages/web/src/components/ansi-log-viewer.component.tsx:21, :37-49.
- Change summary of `{}` or all-zero counts renders "Change summary unavailable", never "no changes"; only `{same:N}` renders "No changes" — app/packages/web/src/components/change-summary-status.component.tsx:51-60, :75-84.
- Mobile nav drawer auto-closes on any route change because it stores the pathname it was opened on — app/packages/web/src/components/app-layout.component.tsx:25-26.
- Electron window chrome: header is a drag region and interactive children are no-drag; macOS brand block is also draggable; Linux gets app-drawn min/max/close; win32 reserves titleBarOverlay space — app/packages/web/src/components/app-topbar.component.tsx:89-94, app-layout.component.tsx:71-75, app-layout.component.test.tsx:388-602.
- Global Refresh triggers every registered poller and is disabled with none registered; LIVE dot is cyan when any poller is fresh, dim when all stale — app/packages/web/src/components/app-topbar.component.tsx:13-32, :39-55.
- Cloud Health runs on mount and manual Refresh only (no polling); a `fixed` outcome re-fetches the whole list — app/packages/web/src/components/cloud-health-section.component.tsx:213-219, :172-174, :268.
- Cloud Health `needsPolicyUpdate` shows the required HyveonDeployAll JSON with copy, open-IAM-console (fallback URL text if browser can't open) and download-to-disk — app/packages/web/src/components/cloud-health-section.component.tsx:37-149.
- ConfirmDialog "Don't ask again for this session" stores the key in a module-level session store; GameCard skips the stop dialog when 'stop-server' is suppressed — app/packages/web/src/components/confirm-dialog.component.tsx:77-80, game-card.component.tsx:252-256.
- Game card treats `error` state as startable; Stop shown for running/starting — app/packages/web/src/components/game-card.component.tsx:150-151.
- Stop success shows a toast with an Undo action; `success:false` results produce error toasts — app/packages/web/src/components/game-card.component.test.tsx:259-304.
- Deployment settings save sends the last-read etag as expectedVersionId; a conflict shows a reload message without retrying; a missing etag refuses to save — app/packages/web/src/components/deployment-settings-form.component.test.tsx:199-219, :237-256, :303-316.
- Watchdog tuning fields are documented as baked into the watchdog Lambda and only effective after the next apply — app/packages/web/src/components/deployment-settings-form.component.tsx:144-147.
- Edit-game save only writes deployment-config.json; operator must apply via /iac — app/packages/web/src/components/edit-game-form/edit-game-form.component.tsx:198-204.
- Edit-game validation excludes the edited game from port-collision checks and skips DNS-safe name validation for legacy names — app/packages/web/src/components/edit-game-form/edit-game-form.component.tsx:62-78, :106-110.
- Edit-game failure branches (validation/conflict/not_found/setup_incomplete/error) keep the operator's draft untouched — app/packages/web/src/components/edit-game-form/edit-game-form.component.tsx:137-147.
- Error boundary forwards render crashes (message + stack + component stack) to the main-process log with source 'boundary' — app/packages/web/src/components/error-boundary.component.tsx:44-51.
- Folder seed persists selection to main on every include/destination change, but only when the game has a name and the destination is inside a declared volume — app/packages/web/src/components/folder-upload/use-folder-seed.hook.ts:77, :134-148.
- After an app restart, the remembered folder is re-scanned by main; if it can't be read, Resume stays disabled and a message is shown — app/packages/web/src/components/folder-upload/use-folder-seed.hook.ts:107-110, folder-upload-card.component.tsx:127-131.
- Folder upload is blocked unless the game is deployed and its server is stopped — app/packages/web/src/components/folder-upload/folder-upload-card.component.tsx:118-120, :155.
- An open file-manager session (detected by /already open/i) prompts the operator to stop it, then retries the upload — app/packages/web/src/components/folder-upload/folder-upload-card.component.tsx:25, :86-88, :97-106.
- Progress bar never shows 100% before phase `done` (capped at 99) — app/packages/web/src/components/folder-upload/folder-upload-progress-meter.component.tsx:98-99.
- Upload pauses at `awaiting-confirmation` when existing files differ in size; Overwrite continues, Cancel ends with nothing written — app/packages/web/src/components/folder-upload/overwrite-confirmation.component.tsx:17-38.
- Drift chip: declared+deployed -> In sync / Config drift (tooltip lists changed fields); declared only -> Pending deploy; deployed only -> Undeclared — app/packages/web/src/components/game-status-badges.component.tsx:57-72.

### add-game-wizard

- Wizard steps are fixed and ordered from `@hyveon/shared` `ADD_GAME_WIZARD_STEPS` (identity, resources, networking, storage, environment, review) — wizard-form.utils.ts:43, add-game-wizard.component.tsx:54-61.
- Existing games are re-fetched via `api.games()` every time the dialog opens; failure yields an empty list — add-game-wizard.component.tsx:148-163.
- Client validation delegates to shared `validateGameServer` with a `'__draft__'` placeholder name when the name is blank — wizard-form.utils.ts:591-592.
- Name must be non-empty, match `GAME_NAME_PATTERN`, and not collide with an existing game (create mode only) — wizard-form.utils.ts:435-460.
- Image must be non-blank client-side even though the shared schema allows empty string — wizard-form.utils.ts:520-531.
- Next/Submit is disabled while the current step has any issue; Review shows every issue — add-game-wizard.component.tsx:223-230, wizard-form.utils.ts:645-648.
- Issue-to-step routing uses the first path segment; unknown families route to review — wizard-form.utils.ts:395-419.
- Server `validation` result jumps to the first issue's step; other failure codes and thrown errors land on Review with submitError — add-game-wizard.component.tsx:278-297.
- Any draft edit clears server-reported issues and submit error — add-game-wizard.component.tsx:200-205.
- On success: folder seed persisted under final name, toast, awaited `clearGameDraft`, close, navigate to `/games/<name>` — add-game-wizard.component.tsx:260-275.
- Dialog-initiated close (Escape/overlay/Cancel) discards persisted folder seed, flushes autosave, resets wizard, calls onClose — add-game-wizard.component.tsx:177-193.
- Late createGame results after the dialog closed are ignored via openRef — add-game-wizard.component.tsx:258, :295.
- Autosave debounces 1000 ms and is suppressed at fire time while submitting — use-wizard-draft-autosave.hook.ts:160-165.
- No autosave until a field edit or a pre-existing stored draft — use-wizard-draft-autosave.hook.ts:184-188.
- Step-only navigation on a resumed draft calls `updateGameDraftStepIndex`, never `saveGameDraft`, to avoid overwriting unredacted secrets on disk with redacted blanks — use-wizard-draft-autosave.hook.ts:73-86, :168-173.
- Unmount flushes pending draft through a ref to the latest flush; effect order is load-bearing — use-wizard-draft-autosave.hook.ts:138-152.
- New draft defaults: cpu 1024, memory 2048, one `data`→`/data` volume, healthCheck disabled with timeoutMs 2000 — wizard-form.utils.ts:176-205, :128-146.
- Ports with visibility `public` omit the field in payload; `internal` sent explicitly — wizard-form.utils.ts:359-363.
- `webPort` is included in payload only when https is on — wizard-form.utils.ts:379, :490.
- `pinnedHostname` sent only when defined; `''` is passed through so validation blocks it — wizard-form.utils.ts:377; environment-step.component.tsx:75-77.
- Health-check auth: `none`+secretSet→`null` (clear), blank credential fields→`undefined` (keep), filled→typed object — wizard-form.utils.ts:324-337.
- Health-check comparison value parsed to boolean/null/number/string; omitted for `exists` — wizard-form.utils.ts:268-307.
- ICMP port rows: type must be 0-255, blank row switched to icmp prefilled with 8 — wizard-form.utils.ts:545-556; networking-step.component.tsx:239-245.
- Resources sliders index Fargate tier tables so every position is a valid pairing; changing cpu nulls incompatible memory — resources-step.component.tsx:108-114.
- Last remaining volume cannot be removed — storage-step.component.tsx:59-62.
- Enabling HTTPS warns that 443/80 open for the whole stack and ACME runs on first boot — networking-step.component.tsx:144-147.
- Health-check credential values never displayed; only secretSet indicator — health-check-fields.component.tsx:214-223.

### first-run-wizard

- Wizard steps are fixed order pick-cloud → guided-iam → credentials → bootstrap → stack-init, sourced from @hyveon/shared WIZARD_STEPS — wizard.utils.ts:6-17.
- Resume-on-mount jumps to the persisted step but never past `bootstrap`, so stack init never auto-runs on relaunch — use-wizard-progress.hook.ts:90-92; pinned by first-run-wizard.component.test.tsx:641-649.
- Step progress is saved on every step change, but only after the resume read has settled — use-wizard-progress.hook.ts:139-144.
- Resume and progress persistence run only in `first-run` mode, never in `reconfigure` — use-wizard-progress.hook.ts:82, :140.
- In first-run, advancing past pick-cloud and credentials awaits `wizard.saveState` and stays on the step if it fails — first-run-wizard.component.tsx:296-313.
- The bootstrap resource names are saved fire-and-forget on advance and failures are ignored — first-run-wizard.component.tsx:314-321.
- The credentials save is skipped when guided-IAM credentials are active, so the guided profile is not overwritten — first-run-wizard.component.tsx:307.
- Credentials Next requires a non-empty region in both profile and paste modes (or guided credentials) — use-aws-credentials-form.hook.ts:146-149; first-run-wizard.component.tsx:226.
- Pasted keys are saved via `wizard.saveCredentials` immediately on click, and editing any paste field afterwards invalidates that save — use-aws-credentials-form.hook.ts:111-138.
- The state bucket, configuration bucket and run-history table bootstrap concurrently; the deployment-config seed runs only after the config bucket reports created/exists — use-bootstrap-resources.hook.ts:155-219.
- Bootstrap Next is gated on all four of: both buckets, the runs table and the config seed — use-bootstrap-resources.hook.ts:243-246.
- The IAM permission dry-run never gates progression — use-bootstrap-resources.hook.ts:223-239; first-run-wizard.component.test.tsx:534-546.
- Guided-IAM key material lives only in hook memory; `saveProgress` receives only `subState` and the `hasBootstrapKey` boolean — use-guided-iam.hook.ts:152, :191-198, :410.
- Guided-IAM sub-state is persisted in order not-started → template-written → awaiting-key-intake → rotation-pending → complete — use-guided-iam.hook.ts:298, :278, :326, :410, :358.
- A verification-failed rotation does not change the persisted sub-state (it stays rotation-pending) — use-guided-iam.hook.ts:363-370.
- A rotation-pending resume always lands on the intake screen, even with no recoverable region — use-guided-iam.hook.ts:234-241.
- The delete-failed screen offers no bypass; completion requires a successful `guidedIamRevokeBootstrapKey` — use-guided-iam.hook.ts:431-454; guided-iam-delete-failed-screen.component.tsx:44-47.
- "Start over" is disabled while guided-IAM has an AWS-mutating call in flight (submitting/rotating/revoking) — use-guided-iam.hook.ts:177-183; first-run-wizard.component.tsx:445.
- "Start over" calls `wizard.reset` and then `window.location.reload()`, first-run only — first-run-wizard.component.tsx:144-159, :440.
- The shared Next button is hidden on stack-init and on a non-collapsed guided-iam step — first-run-wizard.component.tsx:251.
- Reconfigure pre-collapses pick-cloud/credentials/bootstrap, and collapses guided-iam only when aws.profile === GUIDED_PROFILE_NAME ('hyveon-guided') — use-reconfigure-answers.hook.ts:29, :150-151.
- Reconfigure prefill runs once, after the profile list settles; non-~/.aws profiles are treated as pasted-key profiles — use-reconfigure-answers.hook.ts:134-165.
- Reconfigure commits a single `saveState` containing only Edit-opened steps, called as onBeforeFinish before `wizard.complete` — use-reconfigure-answers.hook.ts:215-231; first-run-wizard.component.tsx:426; pinned at first-run-wizard.component.test.tsx:825-880.
- Stack init is debounced with setTimeout(0) so StrictMode triggers exactly one `iac.stack.initialize()`; on throw, the last started phase is marked failed — stack-init-step.component.tsx:118-145.
- Finish setup is enabled only after a successful stream, and a rejected onBeforeFinish blocks `wizard.complete` — stack-init-step.component.tsx:167-183, :217.
- The step sidebar shows only in first-run mode and at md+ widths, and is not interactive — first-run-wizard.component.tsx:332; wizard-step-sidebar.component.tsx:28.

## Cross-scope references

### Top-level components, edit-game-form, folder-upload

Outbound (my files call into):
- `../api.service.js` (`api` facade over window.hyveon IPC): env, cloudHealthList/Fix/OpenPolicyConsole/DownloadPolicy, diagnosticsExportBundle/ShowInFolder (and diagnosticsTail/diagnosticsLogPath via the hook), games, updateGame, statusGame, filesMgrStop, folderPick/Rescan/GetSelection/SetSelection/ClearSelection/StartUpload/CancelUpload/ConfirmOverwrite/GetProgress/OnProgress (push subscription), start/stop (via useGameActions). Types: EnvInfo, CloudHealthCheckSummary, CloudHealthFixResult, AuditAction, AuditEntry, FileMgrStatus, FileMgrCredentials, GameStatus, GameEstimate, DriftKind, DriftChangedField, GameWriteSuccess, RedactedGameServer, UpdateGamePayload, FolderScanResult, FolderUploadRequest, FolderUploadProgress.
- `window.hyveon` directly: `window.hyveon.window.platform` (app-layout.component.tsx:72); deployment-settings test stubs `window.hyveon.iac.settings.get/update`, indicating use-deployment-settings.hook calls the bridge directly.
- `@hyveon/shared`: errMessage, DeploymentSettingsValidationIssue; `@hyveon/shared/gameServerValidator` (GameServerValidationIssue); `@hyveon/shared/folderUpload` (FolderScanNode, FolderScanResult, VolumeLike, validateDestination, planUpload, FolderUploadLastRun, FolderUploadPhase, FolderUploadProgress, OverwriteSummary).
- `@hyveon/desktop-preload`: ChangeSummary, OpType types (change-summary-status.component.tsx:1).
- Hooks in web/src/hooks: useDiagnosticsTail, useDeploymentSettings, useGameActions, useClickOutside, useAppRegionStyle.
- Polling: PollingProvider, usePollingActions, usePollingState, isStale (../polling/polling-provider.component.js).
- Libs: ../lib/ansi.utils (parseAnsiLine), ../lib/utils.utils (cn), ../lib/format.utils (formatUsd, formatTimestamp, formatBytes, formatDuration), ../lib/confirm-skip.utils (suppress, isSuppressed), ../lib/report-renderer-error.utils (reportRendererError).
- Out-of-scope components: ui/* (button, input, badge, card, table, alert-dialog, form-field, label), section-card, snowflake-chips-input, stray-helpers-button, log-line-display (LogLineList), window-chrome (TrafficLightSpacer, TitlebarOverlaySpacer, WindowControls), add-game-wizard/* (IdentityStep, ResourcesStep, NetworkingStep, StorageStep, EnvironmentStep, wizard-form.utils draftFromGameServer/draftToPayload/validateStep/WizardDraft).
- External libs: react-router-dom, lucide-react, sonner (toast, via useGameActions/useDeploymentSettings), Radix alert-dialog (via ui).

Inbound (outside callers of my files, from grep of non-test sources):
- DiagnosticsPanel, CloudHealthSection, DeploymentSettingsForm -> pages/settings.page.tsx (DeploymentSettingsForm also referenced in watchdog-panel.component.tsx).
- AnsiLogViewer -> pages/iac.page.tsx, pages/iac-run-detail.page.tsx, components/iac-destroy-section.component.tsx.
- ChangeSummaryStatus -> pages/iac.page.tsx, pages/iac-history.page.tsx, pages/iac-run-detail.page.tsx, components/run-history-row.component.tsx, components/iac-destroy-section.component.tsx.
- AppLayout -> app.component.tsx. ErrorBoundary -> main.tsx.
- AsyncContent -> pages/audit, games, dashboard, costs, iac-history; components/section-card.component.tsx.
- AuditEntryRow -> pages/audit.page.tsx.
- ConfirmDialog -> pages/discord/{permissions,admins,guilds}-section, components/iac-destroy-section, rollback-action, remove-game-button, submission-banners, first-run-wizard/first-run-wizard.
- EmptyStateCard, FileManagerModal, GameCard -> pages/dashboard.page.tsx (GameCard name also appears in logs.page.tsx, polling/game-status-provider, api.service.ts).
- ErrorBanner -> pages/iac.page.tsx, iac-run-detail.page.tsx, components/iac-destroy-section, stray-helpers-button, log-tail-view, submission-banners.
- EditGameForm, FolderUploadCard, GameStatusBadges -> pages/game-detail.page.tsx (GameStatusBadges also pages/games.page.tsx).
- FolderSeedSection, useFolderSeed -> components/add-game-wizard/add-game-wizard.component.tsx.
- GameCombobox -> pages/logs.page.tsx.
- RefreshAllButton/LiveIndicator re-export from app-layout: only app-layout.component.test.tsx.

### add-game-wizard

- `@hyveon/shared/gameServerValidator`: validateGameServer, validateHealthCheckAuthInput, checkConnectMessagePlaceholders, isValidIcmpType, GAME_NAME_PATTERN(_DESCRIPTION), getFargateCpuOptions, getFargateMemoryOptions, estimateFargateHourlyCost, GameServerValidationIssue (wizard-form.utils.ts:15-23; resources-step.component.tsx:2-7). Comments reference its internal `checkIcmpPortRules` and `gameServerSchema.volumes.min(1)`.
- `@hyveon/shared`: ADD_GAME_WIZARD_STEPS, AddGameWizardStep (wizard-form.utils.ts:24); `@hyveon/shared/envTokens` HYVEON_ENV_TOKENS (environment-step.component.tsx:16); `gamesWrite.ts` auth write convention referenced in doc (wizard-form.utils.ts:282).
- `app/packages/web/src/api.service.ts`: `api.games`, `api.createGame` → `hyveon().games.create`, `api.saveGameDraft` → `games.draft.save`, `api.updateGameDraftStepIndex` → `games.draft.updateStepIndex`, `api.clearGameDraft` → `games.draft.clear` (api.service.ts:311-321); types CreateGamePayload, GameServer, RedactedGameServer, GameServerHealthCheck*; api.service.ts:138-146 declares `GameWizardDraft` as a hand-kept copy of `WizardDraft` ("keep this copy in sync") — duplication flag.
- Desktop-main side referenced by comments: `GamesWriteService`, `GameWizardDraftService.get()` redaction, `DeploymentConfigService.insertGameServerEntry()` (wizard-form.utils.ts:9, :40, :422; use-wizard-draft-autosave.hook.ts:78).
- `../folder-upload/`: FolderSeedSection, useFolderSeed (reset/persistAs/discardPersisted/scan), folder-upload.test-utils makeScan; api folderPick/GetSelection/Rescan/SetSelection/ClearSelection mocked in tests (add-game-wizard.component.tsx:37-38, :134-135; test:41-45).
- UI primitives: `@/components/ui/{button,dialog,form-field,input,label,native-select,textarea}.component`, `@/components/section-card.component`, `@/lib/utils.utils` cn, `../../lib/format.utils.js` formatUsd.
- Callers: `pages/games.page.tsx:8` imports AddGameWizard (resume banner uses initialDraft/hideTrigger/onClose); `components/edit-game-form/edit-game-form.component.tsx:21-26` reuses IdentityStep (nameDisabled), ResourcesStep, NetworkingStep, StorageStep, EnvironmentStep and draftFromGameServer/draftToPayload/validateStep (mode 'edit'); `hooks/use-deployment-settings.hook.ts:7` mentions the flow.
- External libs: react-router-dom, sonner, lucide-react, rxjs, Radix Dialog (via ui wrapper).

### first-run-wizard

- **Consumers of FirstRunWizard:** web/src/app.component.tsx:19,88 renders it in first-run mode while `!wizardCompleted`. web/src/pages/settings.page.tsx:9,252 renders it for Reconfigure. web/src/app.component.test.tsx:14 mocks it.
- **@hyveon/shared:** `WIZARD_STEPS`/`WizardStep` (shared/src/wizardSteps.ts:9-12), `AWS_REGIONS`/`AwsRegionInfo` (guided-iam-step), `HYVEON_DEPLOY_ALL_ACTIONS` (iam-check-panel).
- **@hyveon/desktop-preload types/constants:** `WizardProgress`, `AwsProfileSummary`, `IamCheckResult`, `HyveonStreamHandle`, `StackInitPhase`, `StackInitPhaseEvent`, and `GUIDED_PROFILE_NAME` (desktop-preload/src/hyveon-api.ts:1968). `GUIDED_PROFILE_NAME` is also defined separately, with the same value 'hyveon-guided', in desktop-main/src/services/GuidedIamService.ts:94 (duplicate constant).
- **IPC bridge window.hyveon.wizard.\*:** getState, saveState, getProgress, saveProgress, reset, complete, listAwsProfiles, saveCredentials, bootstrapStateBucket, bootstrapConfigurationBucket, bootstrapDeploymentConfig, bootstrapRunsTable, simulateIamPermissions, guidedIamPrepareTemplate, guidedIamOpenConsole, guidedIamSubmitBootstrapKey, guidedIamRotate, guidedIamRevokeBootstrapKey. Also window.hyveon.iac.stack.initialize() (streaming).
- **desktop-main services named in comments (backends of the IPC above):** WizardController.bootstrapRunsTable, BootstrapService (ensureRunsTable, PAB), GuidedIamService.rotate, AwsProfileService, ElectronStoreService (aws.region), PulumiService.initializeStack, PulumiEngineService (PulumiProvisioningPhase), PulumiWorkspaceService (PULUMI_PROJECT_NAME).
- **web/src shared modules:** @/lib/bridge.utils (`BRIDGE_UNAVAILABLE`), @/lib/utils.utils (`cn`), @/components/inline-alert.component, @/components/ui/{button,badge,input,label,select}.component, ../confirm-dialog.component, ../../hooks/use-copied-reset.hook (also used by web/src/pages/discord/credentials-section.component.tsx), ../../test-utils/stream-handle.test-utils (`toStreamHandleMock`).
- **Docs/specs referenced:** docs/superpowers/plans/bootstrap-7-wizard-ui.md (exists), openspec/changes/add-one-click-aws-bootstrap/specs/guided-iam-provisioning/spec.md, docs/docs/setup.md (HyveonDeployAll), e2e spec guided-iam-wizard.spec.ts (named at guided-iam-step.component.tsx:95).
- **Runtime environment:** web/src/main.tsx `<StrictMode>`, which several guards are written around (use-guided-iam.hook.ts:159-167; stack-init-step.component.tsx:118-122).
