# Sweep 2 — `app/packages/web/src/components/` (segment after `components/` starts h–z)

Scope command: `git ls-files app/packages/web/src/components | LC_ALL=C awk -F/ '$6 ~ /^[h-z]/'` → 51 files: 29 top-level `components/*.tsx` files whose names start h–z, plus the 22 files under `components/ui/`. All 51 read in full.

Path prefix below: `app/packages/web/src/components/`. Line numbers refer to the file named in the entry unless another file is given.

## app/packages/web/src/components/ui

All `ui/*` primitives are shadcn-style wrappers. Their styling goes through `cn()` from `@/lib/utils.utils` and Hyveon CSS variables (`--color-*`, `--radius-*`, `--font-mono`) defined in `src/index.css`'s `@theme` block. None of them has side effects.

```yaml
- path: app/packages/web/src/components/ui/alert-dialog.component.tsx
  purpose: Styled wrappers over Radix AlertDialog (overlay, centered content, header/footer, title, description, action, cancel).
  exports: AlertDialog, AlertDialogPortal, AlertDialogOverlay, AlertDialogTrigger, AlertDialogContent, AlertDialogHeader, AlertDialogFooter, AlertDialogTitle, AlertDialogDescription, AlertDialogAction, AlertDialogCancel
  dependencies: "@radix-ui/react-alert-dialog; buttonVariants from ui/button.component; cn"
  data_shapes: Radix props passthrough
  side_effects: none (renders into a portal)
  role: UI primitive
  observations:
    - "AlertDialogContent always renders its own Portal+Overlay (:31-32)."
    - "Action uses default buttonVariants() (:90); Cancel uses variant 'outline' (:101). Destructive styling must come from the caller's className."
    - "Overlay/Content class strings are nearly identical to ui/dialog.component.tsx:18,35 (duplication typical of shadcn copies)."
- path: app/packages/web/src/components/ui/badge.component.tsx
  purpose: CVA-variant status pill.
  exports: Badge, badgeVariants, BadgeProps
  dependencies: class-variance-authority, cn
  data_shapes: "variant: default|secondary|destructive|outline|success|warning|cyan"
  side_effects: none
  role: UI primitive
  observations:
    - "Renders a <div>, not a <span> (:40), so it is block-level markup inside inline contexts (e.g. Badge used inside table cells / chip input)."
    - "Variants success/warning/cyan (:18-23) are Hyveon additions beyond the shadcn defaults."
- path: app/packages/web/src/components/ui/button.component.tsx
  purpose: CVA-variant button with asChild (Radix Slot) support.
  exports: Button, buttonVariants, ButtonProps
  dependencies: "@radix-ui/react-slot, class-variance-authority, cn"
  data_shapes: "variant: default|destructive|outline|secondary|ghost|link|start|stop; size: default|sm|lg|icon"
  side_effects: none
  role: UI primitive
  observations:
    - "Game-control variants 'start' (green) and 'stop' (red) at :23-26; 'stop' and 'destructive' have identical classes (:14 vs :26)."
    - "className is passed into buttonVariants() itself (:54) rather than merged separately — equivalent result via cn/twMerge."
    - "Most widely imported component in the web package (≈50 importers)."
- path: app/packages/web/src/components/ui/card.component.tsx
  purpose: Card container and sub-parts.
  exports: Card, CardHeader, CardFooter, CardTitle, CardDescription, CardContent
  dependencies: cn
  data_shapes: HTML div/h3/p attrs
  side_effects: none
  role: UI primitive
  observations:
    - "CardTitle renders <h3> (:27)."
- path: app/packages/web/src/components/ui/dialog.component.tsx
  purpose: Styled wrappers over Radix Dialog with built-in close (X) button.
  exports: Dialog, DialogPortal, DialogOverlay, DialogClose, DialogTrigger, DialogContent, DialogHeader, DialogFooter, DialogTitle, DialogDescription
  dependencies: "@radix-ui/react-dialog, lucide-react X, cn"
  data_shapes: Radix props
  side_effects: none
  role: UI primitive
  observations:
    - "DialogContent is capped at max-h-[90vh] with overflow-y-auto (:35) and always appends a Close button with sr-only 'Close' (:41-44)."
    - "Only imported by add-game-wizard/add-game-wizard.component.tsx."
    - "DialogOverlay/DialogContent/DialogTitle have no TSDoc while the header/footer do (:50,56); the file is inconsistent about this."
- path: app/packages/web/src/components/ui/dropdown-menu.component.tsx
  purpose: Styled wrappers over Radix DropdownMenu (items, checkbox/radio items, sub-menus, label, separator, shortcut).
  exports: DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuCheckboxItem, DropdownMenuRadioItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuShortcut, DropdownMenuGroup, DropdownMenuPortal, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuRadioGroup
  dependencies: "@radix-ui/react-dropdown-menu, lucide-react Check/ChevronRight/Circle, cn"
  data_shapes: Radix props; `inset?: boolean` on SubTrigger/Item/Label
  side_effects: none
  role: UI primitive
  observations:
    - "No importer anywhere in app/packages/web/src (grep for '/dropdown-menu.component' finds no hits). Appears to be dead code."
- path: app/packages/web/src/components/ui/form-field.component.test.tsx
  purpose: Unit tests for FormField.
  role: test
  observations:
    - "Pins: label + render-prop child render; aria-describedby='<id>-error' and aria-invalid=true when errors are present; neither attribute when errors are absent; an array of errors renders every message; an empty array renders no alert; hint renders."
- path: app/packages/web/src/components/ui/form-field.component.tsx
  purpose: Labeled form-field wrapper that owns error-id/ARIA wiring and renders its control through a render prop.
  exports: FormField, FormFieldProps, FormFieldChildProps
  dependencies: cn
  data_shapes: "{id, label, errors?: string|string[], hint?, className?, children: (FormFieldChildProps)=>ReactNode}; FormFieldChildProps {id, aria-invalid?, aria-describedby?}"
  side_effects: none
  role: UI primitive (form helper)
  observations:
    - "Errors are normalised to an array (:35). Error id is `${id}-error` (:37). The alert <p> contains one <span> per message (:50-54)."
    - "The hint renders after the errors, unwrapped (:56)."
    - "Uses a raw <label>, not ui/label (:41). The class string duplicates labelVariants in ui/label.component.tsx:7 minus the peer-disabled classes."
- path: app/packages/web/src/components/ui/input.component.tsx
  purpose: Styled forwardRef <input>.
  exports: Input, InputProps
  dependencies: cn
  data_shapes: InputHTMLAttributes
  side_effects: none
  role: UI primitive
  observations:
    - "Uses a monospace font by default (font-[var(--font-mono)], :12)."
    - "Its class string is copied nearly verbatim into native-select (:18) and textarea (:11); there is no shared constant."
- path: app/packages/web/src/components/ui/label.component.tsx
  purpose: Radix Label with CVA base classes.
  exports: Label
  dependencies: "@radix-ui/react-label, class-variance-authority, cn"
  data_shapes: Radix Label props
  side_effects: none
  role: UI primitive
  observations:
    - "labelVariants has no variants (:6-8); the cva call only wraps a single class string."
- path: app/packages/web/src/components/ui/native-select.component.test.tsx
  purpose: Unit tests for NativeSelect.
  role: test
  observations:
    - "Pins: renders as a combobox with its options; forwards a ref to HTMLSelectElement; merges a custom className."
- path: app/packages/web/src/components/ui/native-select.component.tsx
  purpose: Thin forwardRef <select> that reuses Input's styling.
  exports: NativeSelect, NativeSelectProps
  dependencies: cn
  data_shapes: SelectHTMLAttributes
  side_effects: none
  role: UI primitive
  observations:
    - "Comment :7-13 says it deliberately avoids the Radix Select so that existing specs using fireEvent.change on a raw <select> keep working."
    - "The class string is copied from input.component.tsx:12 rather than shared (:18), even though the comment says it is 'sharing' Input's class string. Per .claude/rules/duplication.md, a 'mirrors X' comment counts as a bug report."
    - "Used by add-game-wizard networking-step and health-check-fields."
- path: app/packages/web/src/components/ui/select.component.tsx
  purpose: Styled wrappers over Radix Select (trigger, content with scroll buttons, item, label, separator).
  exports: Select, SelectGroup, SelectValue, SelectTrigger, SelectContent, SelectLabel, SelectItem, SelectSeparator, SelectScrollUpButton, SelectScrollDownButton
  dependencies: "@radix-ui/react-select, lucide-react Check/ChevronDown/ChevronUp, cn"
  data_shapes: Radix props; SelectContent position defaults to 'popper' (:61)
  side_effects: none
  role: UI primitive
  observations:
    - "The only real consumer is first-run-wizard/guided-iam-region-screen.component.tsx (native-select references it only in a comment)."
- path: app/packages/web/src/components/ui/sonner.component.tsx
  purpose: Sonner Toaster pre-styled for the dark theme.
  exports: Toaster
  dependencies: sonner
  data_shapes: Sonner ToasterProps
  side_effects: none (mounts the toast container)
  role: UI primitive
  observations:
    - "Hard-codes theme='dark' (:10). Mounted once in app.component.tsx."
- path: app/packages/web/src/components/ui/table.component.tsx
  purpose: Styled table parts.
  exports: Table, TableHeader, TableBody, TableFooter, TableHead, TableRow, TableCell, TableCaption, TableHeadProps, TableCellProps
  dependencies: cn
  data_shapes: HTML table attrs; TableHeadProps.scope, TableCellProps.colSpan/rowSpan
  side_effects: none
  role: UI primitive
  observations:
    - "Table wraps the <table> in a 'relative w-full overflow-auto' div (:17), and the forwarded ref points to the inner <table>."
    - "TableHeadProps/TableCellProps re-declare attributes that HTMLAttributes types for th/td already cover (:5-13)."
- path: app/packages/web/src/components/ui/tabs.component.tsx
  purpose: Styled Radix Tabs.
  exports: Tabs, TabsList, TabsTrigger, TabsContent
  dependencies: "@radix-ui/react-tabs, cn"
  data_shapes: Radix props
  side_effects: none
  role: UI primitive
  observations:
    - "Only consumer: pages/discord/discord.page.tsx."
- path: app/packages/web/src/components/ui/textarea.component.test.tsx
  purpose: Unit tests for Textarea.
  role: test
  observations:
    - "Pins: accepts typed input; forwards a ref to HTMLTextAreaElement; merges a custom className."
- path: app/packages/web/src/components/ui/textarea.component.tsx
  purpose: Styled forwardRef <textarea>.
  exports: Textarea, TextareaProps
  dependencies: cn
  data_shapes: TextareaHTMLAttributes
  side_effects: none
  role: UI primitive
  observations:
    - "Comment :7 says it is 'mirroring ui/input.component.tsx's shape'. The class string at :11 is Input's with min-h-16 in place of h-9 and without the file: classes (duplication)."
    - "Only consumer: add-game-wizard/storage-step.component.tsx."
- path: app/packages/web/src/components/ui/tooltip.component.tsx
  purpose: Styled Radix Tooltip.
  exports: Tooltip, TooltipTrigger, TooltipContent, TooltipProvider
  dependencies: "@radix-ui/react-tooltip, cn"
  data_shapes: Radix props; sideOffset defaults to 4
  side_effects: none
  role: UI primitive
  observations:
    - "TooltipContent is not wrapped in a Portal (:13), unlike Select/DropdownMenu content. Only consumer: polling/polling-indicator.component.tsx."
```

## app/packages/web/src/components (top-level, h–z)

```yaml
- path: app/packages/web/src/components/iac-destroy-section.component.tsx
  purpose: "'Destroy infrastructure' section of the /iac page: warning copy, type-to-confirm dialog, and the run/log/status block, driven by its own useIacRun('destroy')."
  exports: DestroySection({nowMs})
  dependencies: "useIacRun (hooks/use-iac-run.hook); AnsiLogViewer, ConfirmDialog, ErrorBanner, ChangeSummaryStatus, SubmissionBanners, ui/Button; sonner toast; lucide icons"
  data_shapes: "useIacRun result {submit, status, runId, inFlight, staleLock, conflict, runLock, submitError, reset, record.changeSummary, log.chunks, log.error}; ack {started, runId}; mintAck {token}"
  side_effects: "IPC window.hyveon.iac.mintDestroyToken() then window.hyveon.iac.destroy({confirmationToken}) (:43-44); toast on success (:51)"
  role: UI component (page section)
  observations:
    - "DESTROY_CONFIRM_PHRASE = 'destroy infrastructure' (:18). The comment says the backend trusts the minted token (PulumiService.assertFreshDestroyConfirmation), not this phrase."
    - "Mint and destroy run inside one submit() so a failure in either is handled the same way. The dialog closes only when ack.started && ack.runId (:45)."
    - "Non-null assertion window.hyveon! (:43-44) with no BRIDGE_UNAVAILABLE guard, unlike rollback-action/submission-banners. Presumably useIacRun.submit catches the resulting throw."
    - "Shares no state with the plan/apply flow. The comment says the shared Pulumi workspace serializes them (:20-27)."
    - "The submit button and banners are hidden once runId is set (:70). There is no visible path back to 'idle' in this component."
    - "The file is iac-destroy-section but the export is named DestroySection."
- path: app/packages/web/src/components/inline-alert.component.tsx
  purpose: Renders one role=alert error line, or nothing when the message is null/empty.
  exports: InlineAlert, InlineAlertProps
  dependencies: none
  data_shapes: "{message: string|null}"
  side_effects: none
  role: UI component
  observations:
    - "Used only by first-run-wizard screens."
    - "rollback-action.component.tsx:119-123 renders the same role=alert red <p> pattern inline (text-xs instead of text-sm)."
- path: app/packages/web/src/components/jump-to-latest-button.component.test.tsx
  purpose: Tests JumpToLatestButton.
  role: test
  observations:
    - "Pins: hasNewer=false renders nothing; hasNewer=true renders a 'Jump to latest' button; a click calls onClick once."
- path: app/packages/web/src/components/jump-to-latest-button.component.tsx
  purpose: Floating 'Jump to latest' button shown over a log viewer while useLogTail is in historical mode.
  exports: JumpToLatestButton, JumpToLatestButtonProps
  dependencies: ui/Button
  data_shapes: "{hasNewer, onClick}"
  side_effects: none
  role: UI component
  observations:
    - "Extracted from LogsPage/InfrastructureLogsPage (comment :11-16)."
    - "Uses shadow-[var(--shadow-md)] (:26). --shadow-md is not declared in src/index.css; it appears to depend on Tailwind's default theme variable."
- path: app/packages/web/src/components/kpi-strip.component.test.tsx
  purpose: Tests KpiStrip.
  role: test
  observations:
    - "Pins: tile labels 'Current run rate'/'Est. month cap' (and the absence of the old 'Spend today'/'Forecast MTD'); run rate is $0.00 when nothing is running; run rate sums costPerHour of running games; month cap = totalPerHourIfAllOn*24*daysInMonth; null estimates gives $0.00 on both cost tiles."
    - "The month-cap test computes days-in-month from the real clock (:50-52), so it is not time-frozen."
- path: app/packages/web/src/components/kpi-strip.component.tsx
  purpose: Four-tile KPI strip on the Dashboard (Servers running, Current run rate, Est. month cap, Active alerts).
  exports: KpiStrip
  dependencies: "api.service types CostEstimates/GameStatus; lib/format.utils formatUsd; cn; lucide icons"
  data_shapes: "statuses: GameStatus[] {game, state}; estimates: CostEstimates {games[game].costPerHour, totalPerHourIfAllOn} | null"
  side_effects: none (pure derivation)
  role: UI component
  observations:
    - "The comment says the app makes no AWS Cost Explorer calls and cites openspec/changes/remove-cost-explorer-calls (:55-56). That change may since have been archived."
    - "'Active alerts' counts statuses with state==='error' (:62, :99). It is not a separate alert source."
    - "'Servers running' shows '—' when there are zero games (:76)."
    - "currentMonthDays() uses the local clock (:43-46)."
- path: app/packages/web/src/components/live-badge.component.tsx
  purpose: Live/Paused pill for the log tail views.
  exports: LiveBadge, LiveBadgeProps
  dependencies: cn
  data_shapes: "{paused}"
  side_effects: none
  role: UI component
  observations:
    - "The text 'Live'/'Paused' is pinned exactly by the e2e page object e2e/pages/LogsPage.ts (:15-17)."
- path: app/packages/web/src/components/loading-state.component.tsx
  purpose: Centered spinner + label block, plus a bare InlineSpinner.
  exports: LoadingState, LoadingStateProps, InlineSpinner
  dependencies: lucide Loader2, cn
  data_shapes: "{label='Loading…', className}"
  side_effects: none
  role: UI component
  observations:
    - "InlineSpinner (:28-30) has the same shape as inline spinners hand-rolled elsewhere, e.g. rollback-action.component.tsx:116 'size-3.5 animate-spin', which does not use it."
- path: app/packages/web/src/components/log-line-display.component.test.tsx
  purpose: Tests HighlightedLine.
  role: test
  observations:
    - "Pins: plain text passes through; an SGR run gets a color class plus font-bold with no raw ESC bytes; non-SGR CSI (\\x1b[2K) is dropped; search matches render as <mark>; a match inside a colored run keeps the color; a match spanning a dropped CSI between identical-style segments gives one mark; a match spanning two differently styled segments gives two marks."
- path: app/packages/web/src/components/log-line-display.component.tsx
  purpose: ANSI-aware log-line renderer with case-insensitive search highlighting, plus a scrollable list of such lines.
  exports: HighlightedLine({text, query}), LogLineList (forwardRef)
  dependencies: "lib/ansi.utils parseAnsiLine; cn"
  data_shapes: "segments {text, colorClass?, bold?}; MatchRange {start,end}; QueryPart {text, match}; LogLineList props {lines: string[], search, emptyMessage, className?, onScroll?, data-testid?}"
  side_effects: none
  role: UI component
  observations:
    - "Matches are computed against the concatenated plain text of all segments (:63-66), then intersected per segment in sliceSegment (:34-49). This is how a match that spans styled segments gets highlighted."
    - "findMatches is non-overlapping and advances by query length (:24-29)."
    - "LogLineList uses array index keys (:116), so on a prepend (load-older) React re-renders every line."
    - "The comment at :51 says 'Shared by /logs and the Diagnostics panel'. Consumers: log-tail-view and DiagnosticsPanel."
- path: app/packages/web/src/components/log-tail-view.component.tsx
  purpose: Shared page shell for /logs and /logs/infrastructure (header, controls row, optional mobile drawer, error banner, log box, footer counts).
  exports: LogTailView, LogTailViewProps
  dependencies: "UseLogTailResult (hooks/use-log-tail.hook); PageHeader, LiveBadge, LogLineList, JumpToLatestButton, ErrorBanner, ui/Button, ui/Input; PollingIndicator (polling/polling-indicator.component); cn; lucide"
  data_shapes: "tail {lines[{text}], paused, autoscroll, setAutoscroll, search, setSearch, bufferedCount, ageLabel, boxRef, handlePauseToggle, handleScroll, atOldest, loadingOlder, hasNewer, jumpToLatest}"
  side_effects: none directly (the hook owns streaming)
  role: UI component (page shell)
  observations:
    - "With mobileFilters=true, SearchInput/AutoscrollToggle render twice, once desktop-only (hidden md:contents) and once in a mobile drawer (:144-166). That gives two search inputs in the DOM on desktop when the drawer is open; the drawer itself is md:hidden."
    - "The mobile drawer id 'logs-filters' (:159) is presumably the aria-controls target of the caller's toggle button."
    - "test ids: loading-older (:181), at-oldest-marker (:186), logs-viewer (:193)."
    - "Search filters only the visible buffer (placeholder 'Search visible buffer…', :60). Matching lines are highlighted, not filtered out."
    - "Footer shows 'buffered N' only while paused (:212)."
- path: app/packages/web/src/components/page-header.component.tsx
  purpose: Standard page header (optional back link, <h2> title, subtitle, trailing children).
  exports: PageHeader, PageHeaderProps
  dependencies: "react-router-dom Link; lucide ArrowLeft; cn"
  data_shapes: "{title, subtitle?, titleClassName?, backTo?, backLabel?, children?}"
  side_effects: none
  role: UI component
  observations:
    - "The <h2> accessible name is pinned by e2e page objects (:8)."
    - "backLabel is documented as required when backTo is set (:16), but the type does not enforce it."
    - "Used by ~9 pages plus log-tail-view."
- path: app/packages/web/src/components/partial-apply-badge.component.tsx
  purpose: Warning 'partial' badge for apply runs with partialApply:true.
  exports: PartialApplyBadge
  dependencies: ui/Badge
  data_shapes: none
  side_effects: none
  role: UI component
  observations:
    - "Shared by run-history-row and pages/iac-run-detail.page.tsx. The explanation is carried in the title attribute (:12)."
- path: app/packages/web/src/components/pending-changes-banner.component.test.tsx
  purpose: Tests PendingChangesBanner.
  role: test
  observations:
    - "Pins: hidden on an empty report; per-kind counts and total ('4 changes pending', '1 to create', '1 to delete', '2 to update'); dismiss hides it; a changed report on the next 30s poll brings it back; dismissal survives unmount/remount via sessionStorage; an empty report clears the stored dismissal so the same report recurring shows again; hidden when the drift poll rejects."
    - "Mocks ../api.service.js api.drift."
- path: app/packages/web/src/components/pending-changes-banner.component.tsx
  purpose: Dashboard/Games banner that polls the drift report and shows pending create/delete/update counts with links to /iac and /games.
  exports: PendingChangesBanner
  dependencies: "api.service api.drift, types DriftEntry/DriftKind; react-router-dom Link; lucide"
  data_shapes: "DriftEntry {game, kind: pending_create|pending_delete|config_drift, changedFields?}; DriftReport {entries}; signature string 'game:kind:fields|...' sorted"
  side_effects: "IPC via api.drift() (drift.get channel per comment :6), polled every 30s (:7, :126); sessionStorage key 'hyveon.pendingChangesBanner.dismissedSignature' (:14)"
  role: UI component
  observations:
    - "Out-of-order poll responses are discarded by comparing against a monotonic request id (:94-101)."
    - "Errors are swallowed and the banner hides (:108-111), with no logging."
    - "A clean report clears the stored dismissal (:102-107)."
    - "The signature includes changedFields order as given by the backend (:58); only the joined entry strings are sorted, so the same fields in a different order give a new signature."
    - "Two instances (Dashboard and Games) each poll independently; nothing is shared or cached."
    - "The poll keeps running while dismissed."
- path: app/packages/web/src/components/remove-game-button.component.test.tsx
  purpose: Tests RemoveGameButton.
  role: test
  observations:
    - "Pins: confirm stays disabled until the exact game name is typed; Cancel makes no API call; success calls api.deleteGame({name}), navigates to /games, and shows a success toast; an ok:false result shows an error toast and no navigation; the dialog shows the 'deployment-config.json' text and an Infrastructure link to /iac."
    - "Mocks react-router-dom completely (useNavigate and Link only)."
- path: app/packages/web/src/components/remove-game-button.component.tsx
  purpose: Destructive type-to-confirm 'Remove game' that deletes one game entry from DeploymentConfig.
  exports: RemoveGameButton({game})
  dependencies: "api.service api.deleteGame; react-router-dom Link/useNavigate; sonner toast; ui/Button, ui/Input, ui/alert-dialog primitives"
  data_shapes: "deleteGame result: {ok:true, games} | {ok:false, code:'validation', issues[{message}]} | {ok:false, code, message}"
  side_effects: "IPC api.deleteGame({name}) (:56); navigate('/games') on success (:59); toasts"
  role: UI component
  observations:
    - "Doc (:32-36) says the delete only rewrites deployment-config.json; AWS resources stay live until a Pulumi apply, and the dialog states this."
    - "Re-implements type-to-confirm on the AlertDialog primitives instead of reusing ConfirmDialog, because ConfirmDialog's description is plain text (:26-30). The type-to-confirm logic is therefore duplicated."
    - "AlertDialogAction auto-closes the dialog on click before the async delete resolves, so on failure the dialog is already closed and only the toast remains. This is inferred from Radix Action behaviour; :103 does not preventDefault."
    - "The typed value resets when the dialog closes (:49-52)."
- path: app/packages/web/src/components/rollback-action.component.test.tsx
  purpose: Tests RollbackAction.
  role: test
  observations:
    - "Pins: confirm IPC is not called until the dialog is confirmed; a successful confirm closes the dialog and calls onRolledBack({versionId:new head, rolledBackFrom}); a confirm failure shows inline role=alert and onRolledBack is not called; a resolve failure shows inline with no dialog; with no diff in the ack the dialog shows only the target (no diff text)."
    - "Uses vi.stubGlobal('hyveon', …) for window.hyveon.iac.rollback.{resolve,confirm}."
- path: app/packages/web/src/components/rollback-action.component.tsx
  purpose: Two-step resolve-then-confirm rollback of an apply run to the configuration version that was live before it.
  exports: RollbackAction, RollbackResult
  dependencies: "@hyveon/shared errMessage + type DeploymentConfigDiff; ConfirmDialog; ui/Button; @/lib/format.utils formatTimestamp; @/lib/rollback-diff.utils formatDiffSummary; @/lib/bridge.utils BRIDGE_UNAVAILABLE"
  data_shapes: "resolve ack {resolved, versionId?, lastModified?, diff?, error?}; confirm ack {confirmed, versionId?, error?}; RollbackResult {versionId, rolledBackFrom}"
  side_effects: "IPC window.hyveon.iac.rollback.resolve({applyRunId}) (:78), .confirm({applyRunId}) (:98)"
  role: UI component
  observations:
    - "The diff summary is optional and degrades silently. The comment cites the iac-rollback spec: identifying the target is a MUST, the diff is a SHOULD (:44-56)."
    - "The comment says confirm re-resolves on the backend, so a confirm failure writes nothing (:40-42)."
    - "The dialog copy says history is append-only and the current head is not deleted (:132)."
    - "handleConfirm silently returns when there is no bridge (:94); handleClick sets BRIDGE_UNAVAILABLE (:70-72)."
    - "The confirm error renders outside the dialog, in the row's inline alert (:119-123), while the dialog stays open."
- path: app/packages/web/src/components/rolled-back-from-link.component.tsx
  purpose: "'Rollback of apply run X' line linking to /iac/history/:runId."
  exports: RolledBackFromLink({applyRunId})
  dependencies: react-router-dom Link
  data_shapes: "{applyRunId}"
  side_effects: none
  role: UI component
  observations:
    - "Used by iac.page and iac-run-detail.page."
- path: app/packages/web/src/components/run-history-row.component.test.tsx
  purpose: Tests RunHistoryRow.
  role: test
  observations:
    - "Pins: the kind cell links to /iac/history/:runId; a rollback badge appears iff rolledBackFrom is set; a partial badge appears iff partialApply; '—' when approvedBy is missing; Rollback is offered only on apply rows that have configVersionId."
- path: app/packages/web/src/components/run-history-row.component.tsx
  purpose: One row of the /iac/history table.
  exports: RunHistoryRow
  dependencies: "@hyveon/desktop-preload type RunHistoryRecord; ui/Badge, ui/table; RunStatusBadge, PartialApplyBadge, RollbackAction, ChangeSummaryStatus; formatTimestamp"
  data_shapes: "RunHistoryRecord {runId, kind, status, startedAt, completedAt, approvedBy?, rolledBackFrom?, partialApply?, configVersionId?, changeSummary?}"
  side_effects: none directly (RollbackAction issues IPC)
  role: UI component
  observations:
    - "Rollback eligibility rule: kind==='apply' && configVersionId !== undefined (:55)."
    - "The row's rollback badge reuses the 'Rollback of apply run X' wording as its title (:36), duplicating RolledBackFromLink's copy."
- path: app/packages/web/src/components/run-status-badge.component.tsx
  purpose: Maps RunHistoryStatus to a Badge variant and label.
  exports: RunStatusBadge
  dependencies: "@hyveon/desktop-preload type RunHistoryStatus; ui/Badge"
  data_shapes: "status: success|failed|aborted"
  side_effects: none
  role: UI component
  observations:
    - "The Record<RunHistoryStatus,…> lookup (:5-9) makes adding a status a compile error until it is mapped."
- path: app/packages/web/src/components/section-card.component.tsx
  purpose: Card shell with a small-caps title and optional header action.
  exports: SectionCard, SectionCardProps
  dependencies: ui/card, cn
  data_shapes: "{title, action?, children, className?}"
  side_effects: none
  role: UI component
  observations:
    - "Kept separate from AsyncContent on purpose (:17-24)."
- path: app/packages/web/src/components/settings-row.component.tsx
  purpose: Bordered label/description/trailing-action row on the Settings page.
  exports: SettingsRow
  dependencies: none
  data_shapes: "{label: string, description: ReactNode, children?}"
  side_effects: none
  role: UI component
  observations:
    - "Uses the Tailwind theme utility 'text-muted-foreground' (:25) instead of the text-[var(--color-muted-foreground)] form used almost everywhere else. It works because index.css declares that color inside @theme, but the style is inconsistent."
    - "The TSDoc @param entries (:7-9) name destructured props label/description/children, but the function takes a single object parameter."
    - "description renders inside a <p> (:25), so a block-level ReactNode would give invalid nesting."
- path: app/packages/web/src/components/snowflake-chips-input.component.tsx
  purpose: Chip input for Discord snowflake IDs with inline parse errors.
  exports: SnowflakeChipsInput
  dependencies: "lib/snowflake.utils parseSnowflakes; ui/Badge; cn; lucide"
  data_shapes: "{value: string[], onChange, placeholder?, id?, onRemoveChip?, issues?: string[]}; parseSnowflakes → {valid[], invalid[]}"
  side_effects: none
  role: UI component
  observations:
    - "Commits on Enter, comma, blur, or a paste containing whitespace/comma (:89-109). Invalid tokens stay in the draft along with an error message (:45-46)."
    - "Committed values are deduplicated with a Set (:44)."
    - "onMouseDown preventDefault on chip-remove stops a blur-commit of a half-typed draft (:69-72)."
    - "Backspace on an empty draft removes the last chip, or delegates to onRemoveChip so the caller can confirm (:93-99)."
    - "There is no TSDoc on the props parameter and no exported Props interface, unlike sibling components."
    - "Used by the Discord admins/permissions sections and deployment-settings-form."
- path: app/packages/web/src/components/stray-helpers-button.component.test.tsx
  purpose: Tests StrayHelpersButton.
  role: test
  observations:
    - "Pins: lists stopped helpers as 'game (N min old)' plus a skipped/revoked summary; 'No stray helpers found.' when nothing was stopped, with per-item errors listed; an ErrorBanner (role=alert) when the call rejects."
- path: app/packages/web/src/components/stray-helpers-button.component.tsx
  purpose: Diagnostics action that stops file-manager helper tasks no active upload owns, then reports what it did.
  exports: StrayHelpersButton
  dependencies: "api.service api.folderCleanupStrayHelpers; type StrayHelperReport from @hyveon/shared/folderUpload; ErrorBanner; ui/Button"
  data_shapes: "StrayHelperReport {stopped[{game, taskArn, ageMinutes}], skipped, revokedRules, errors: string[]}"
  side_effects: "IPC api.folderCleanupStrayHelpers() (:21), which per the comment stops ECS tasks and revokes access rules (:11-13)"
  role: UI component
  observations:
    - "Runs without a confirmation dialog, even though it stops tasks (:30)."
    - "Uses `err instanceof Error ? err.message : …` (:23) instead of the shared errMessage() used by rollback-action and submission-banners."
    - "Error list items are keyed by message text (:68), so duplicate messages would collide."
    - "Used only in DiagnosticsPanel (out of scope)."
- path: app/packages/web/src/components/submission-banners.component.tsx
  purpose: Stale-lock / workspace-busy / submit-error banner stack under the plan/apply/destroy buttons, including confirmed lock-clear flows.
  exports: SubmissionBanners (internal BusyBanner, StaleLockBanner, useLockClearConfirmation, formatLockAge, CONFLICT_LABELS)
  dependencies: "@hyveon/shared formatRelativeAge, errMessage; @hyveon/desktop-preload types IacStaleLockInfo/RunLock; type Conflict from hooks/use-iac-run.hook; ConfirmDialog, ErrorBanner, ui/Button; sonner; @/lib/bridge.utils BRIDGE_UNAVAILABLE"
  data_shapes: "Conflict: preview|up|destroy|rollback; RunLock {runId, initiator, kind, acquiredAt}; IacStaleLockInfo {stackName, locks[{lockUrl, username, hostname, pid, lockedAt}]}; clear ack {cleared, error?}"
  side_effects: "IPC window.hyveon.iac.runs.lock.mintToken({expectedRunId}) + .runs.lock.clear({confirmationToken}) (:139-141); window.hyveon.iac.lock.mintToken() + .lock.clear(payload) (:249-250); toasts"
  role: UI component
  observations:
    - "useLockClearConfirmation (:49-87) was extracted from two near-identical handlers, per its comment (:26-37)."
    - "Run-lock mint is bound to the displayed runLock.runId to close a TOCTOU gap (RunLockChangedError in RunService.ts) (:131-139)."
    - "Precedence: staleLock is shown alone; otherwise BusyBanner and submitError render together (:338-347)."
    - "The comment says iac.controller never sets both conflict and staleLock (:210-214)."
    - "CONFLICT_LABELS maps Pulumi op names to operator words (preview→plan, up→apply) (:19-24)."
    - "Clearing never resubmits automatically; the operator retries by hand (:110-111, :232-234)."
    - "The StaleLockBanner TSDoc block (:205-238) sits above the StaleLockBannerProps interface, not above the function at :247, so tooling attaches it to the interface."
    - "useLockClearConfirmation's options object is rebuilt on every render with inline lambdas (:137-141, :249-250), so handleConfirmClear's useCallback deps change each render; the memoisation does nothing."
    - "formatLockAge wraps formatRelativeAge; a desktop-main counterpart PulumiLockRecovery.formatLockAge exists (:196-200)."
    - "The BusyBanner dialog says 'durable apply lock' (:173) even when runLock.kind is destroy."
- path: app/packages/web/src/components/watchdog-panel.component.test.tsx
  purpose: Tests WatchdogPanel.
  role: test
  observations:
    - "Pins: shows the 'Watchdog Settings' heading and the pointer to the 'General' section; has no Save button and no textbox/spinbutton."
- path: app/packages/web/src/components/watchdog-panel.component.tsx
  purpose: Static pointer telling operators that watchdog tunables live in DeploymentSettingsForm's 'Watchdog tuning' section.
  exports: WatchdogPanel
  dependencies: none
  data_shapes: none
  side_effects: none
  role: UI component
  observations:
    - "The comment says the watchdog Lambda reads its tunables from DeploymentConfig, not server_config.json (:3-5)."
    - "Looks like a vestigial placeholder from an earlier editable panel; the tests pin that it has no inputs."
- path: app/packages/web/src/components/window-chrome.component.tsx
  purpose: Per-platform title-bar helpers: macOS traffic-light spacer, Windows titleBarOverlay spacer, Linux app-drawn min/max/close buttons.
  exports: TrafficLightSpacer, TitlebarOverlaySpacer, WindowControls
  dependencies: lucide icons; window.hyveon.window bridge (platform, isMaximized, onMaximizedChange, minimize, toggleMaximize, close)
  data_shapes: "platform: 'darwin'|'win32'|'linux'"
  side_effects: "IPC window.hyveon.window.isMaximized() (:74), onMaximizedChange subscription (:79), minimize/toggleMaximize/close (:92,100,112)"
  role: UI component (window chrome)
  observations:
    - "The traffic-light geometry (x 252 = 240px sidebar + 12) is coupled to platformWindowChromeOptions() and to electron-entry.ts's resize listener (:4-17)."
    - "The TitlebarOverlaySpacer width calc(100vw - env(titlebar-area-width, 100vw)) is computed against the viewport on purpose (:23-37, :44)."
    - "A live onMaximizedChange update overrides the initial isMaximized() seed via the receivedLiveUpdate flag (:67-82)."
    - "The IPC subscription is skipped on non-Linux platforms (:62-66)."
    - "Uses 'hover:bg-accent' (:94, :102). index.css defines no --color-accent, so this class appears to be a no-op. It also uses bare 'text-muted-foreground'/'hover:text-foreground' and raw Tailwind red-400/red-500 (:114) instead of the CSS-var tokens used elsewhere."
    - "MEMORY note pr531-linux-native-titlebar-todo: Linux is planned to move to native titleBarOverlay, which would retire WindowControls."
    - "Only consumer: app-topbar.component.tsx."
```

## Observed behaviours

- Destroy requires typing the phrase "destroy infrastructure" in the ConfirmDialog; the backend trusts a minted token instead — iac-destroy-section.component.tsx:18, :102
- Destroy calls `iac.mintDestroyToken()` and then `iac.destroy({confirmationToken})` as one submission; the dialog closes only when `ack.started && ack.runId` — iac-destroy-section.component.tsx:42-47
- A "Destroy complete" toast fires when the destroy run status becomes success — iac-destroy-section.component.tsx:50-52
- The destroy submit button and banners disappear once a runId exists — iac-destroy-section.component.tsx:70, :105
- A failed or aborted destroy shows an ErrorBanner pointing at the log — iac-destroy-section.component.tsx:117-121
- KPI "Current run rate" = sum of costPerHour over games whose status is running — kpi-strip.component.tsx:64-66
- KPI "Est. month cap" = totalPerHourIfAllOn × 24 × calendar days in the current month — kpi-strip.component.tsx:68-69, :43-46
- KPI "Active alerts" = count of game statuses in state `error` — kpi-strip.component.tsx:62, :99
- No AWS Cost Explorer calls; cost figures come only from the per-game Fargate estimates — kpi-strip.component.tsx:54-56
- The pending-changes banner polls `api.drift()` every 30 s and hides on an empty report or a poll error — pending-changes-banner.component.tsx:7, :108-111, :126, :136
- Banner dismissal is keyed to a signature of the report entries and persisted in sessionStorage under `hyveon.pendingChangesBanner.dismissedSignature` — pending-changes-banner.component.tsx:14, :56-61, :168-171
- A clean (empty) drift report clears the stored dismissal — pending-changes-banner.component.tsx:102-107
- Out-of-order drift responses are ignored via a monotonic request id — pending-changes-banner.component.tsx:94-101
- The banner links to `/iac` (plan and apply) and `/games` (view pending) — pending-changes-banner.component.tsx:153, :163
- Remove game requires typing the exact game name before confirm enables — remove-game-button.component.tsx:46, :103
- Remove game only rewrites deployment-config.json (no Pulumi apply), then navigates to `/games` — remove-game-button.component.tsx:32-36, :56-59
- Remove game failures show a toast; a validation result joins the issue messages — remove-game-button.component.tsx:62-64
- Rollback is two-step: `iac.rollback.resolve` (read-only) opens the dialog, then `iac.rollback.confirm` restores the old version as a new head — rollback-action.component.tsx:78, :98
- On a successful rollback confirm, `onRolledBack({versionId, rolledBackFrom: applyRunId})` fires; failures render inline as role=alert — rollback-action.component.tsx:99-104, :119-123
- The rollback diff summary is optional; without a diff the dialog shows only the target version — rollback-action.component.tsx:133
- Rollback is offered only for apply rows that have a configVersionId — run-history-row.component.tsx:55
- A run-history row shows a "rollback" badge when rolledBackFrom is set and a "partial" badge when partialApply===true — run-history-row.component.tsx:35-39, :45
- Run status maps success→green, failed→red, aborted→secondary — run-status-badge.component.tsx:5-9
- The run-history kind cell links to `/iac/history/:runId`; RolledBackFromLink links to the same route — run-history-row.component.tsx:30; rolled-back-from-link.component.tsx:12
- Submission banners show a stale lock alone; otherwise the busy conflict and the submit error render together — submission-banners.component.tsx:338-347
- Clearing a durable run lock mints a token bound to the displayed lock's runId (`iac.runs.lock.mintToken({expectedRunId})`), then calls `iac.runs.lock.clear` — submission-banners.component.tsx:137-141
- Clearing a stale Pulumi backend lock uses `iac.lock.mintToken()` and then `iac.lock.clear` ("pulumi cancel" equivalent) — submission-banners.component.tsx:249-250, :295
- Lock clears never auto-resubmit; success toasts and calls onCleared; failures stay inline with the dialog open — submission-banners.component.tsx:71-77
- The busy banner shows the "Clear lock and retry" action only when a durable runLock is present (apply/destroy; plan never takes the durable lock) — submission-banners.component.tsx:93-102, :155
- Conflict op names are relabelled for operators (preview→plan, up→apply) — submission-banners.component.tsx:19-24
- Lock ages render coarsely through `formatRelativeAge` from the page's 30 s clock (nowMs) — submission-banners.component.tsx:201-203
- Stray-helper cleanup stops orphaned file-manager helper tasks with no confirmation and reports stopped/skipped/revoked rules/errors — stray-helpers-button.component.tsx:15-24, :40-72
- Snowflake chips commit on Enter, comma, blur, or a multi-token paste; invalid tokens stay in the draft with "Not a snowflake: …" — snowflake-chips-input.component.tsx:40-47, :89-109
- Chip values are deduplicated; Backspace on an empty draft removes or offers to remove the last chip — snowflake-chips-input.component.tsx:44, :93-99
- Log lines are rendered ANSI-aware: SGR codes become color/bold classes, non-SGR CSI sequences are dropped (via parseAnsiLine) — log-line-display.component.tsx:53, :81-86; tested in log-line-display.component.test.tsx:11-23
- Log search is case-insensitive, highlights with `<mark>` (including across styled segments), and does not filter lines out — log-line-display.component.tsx:18-49, :73-76
- Log tail view: Pause/Resume toggle; footer shows the line count, oldest age, and "buffered N" while paused — log-tail-view.component.tsx:126-131, :206-213
- Log tail view shows "Loading older logs…" and a "— Beginning of log retention —" marker — log-tail-view.component.tsx:180-189
- "Jump to latest" appears only while the tail is in historical mode (hasNewer) — jump-to-latest-button.component.tsx:21; log-tail-view.component.tsx:202
- The LiveBadge text is exactly "Live"/"Paused" (pinned by e2e) — live-badge.component.tsx:15-17, :35
- WindowControls render only on Linux; macOS gets an 80 px traffic-light spacer and Windows gets a titleBarOverlay spacer — window-chrome.component.tsx:18-21, :38-47, :86
- A live maximize-change event takes priority over the initial isMaximized() seed — window-chrome.component.tsx:72-82
- WatchdogPanel is static: no IPC and no inputs; tunables are edited in DeploymentSettingsForm and take effect on the next apply — watchdog-panel.component.tsx:1-17
- FormField wires `aria-invalid` and `aria-describedby="${id}-error"` only when errors are non-empty — ui/form-field.component.tsx:35-48
- NativeSelect deliberately stays a raw `<select>` so `fireEvent.change` specs keep working — ui/native-select.component.tsx:7-13
- The Toaster is always dark-themed — ui/sonner.component.tsx:10

## Cross-scope references

**Calls out of scope**
- `hooks/use-iac-run.hook` (`useIacRun`, type `Conflict`): iac-destroy-section, submission-banners.
- `hooks/use-log-tail.hook` (`UseLogTailResult`): log-tail-view.
- `polling/polling-indicator.component` (`PollingIndicator`): log-tail-view. In the other direction, `polling/polling-indicator.component` imports ui/tooltip.
- `api.service` (`api.drift`, `api.deleteGame`, `api.folderCleanupStrayHelpers`; types `CostEstimates`, `GameStatus`, `DriftEntry`, `DriftKind`, `DriftReport`): pending-changes-banner, remove-game-button, stray-helpers-button, kpi-strip.
- `window.hyveon` preload bridge (`@hyveon/desktop-preload`):
  - `iac.mintDestroyToken`, `iac.destroy`
  - `iac.rollback.resolve`, `iac.rollback.confirm`
  - `iac.runs.lock.mintToken`, `iac.runs.lock.clear`
  - `iac.lock.mintToken`, `iac.lock.clear`
  - `window.platform`, `window.isMaximized`, `window.onMaximizedChange`, `window.minimize`, `window.toggleMaximize`, `window.close`
  - Types: `RunHistoryRecord`, `RunHistoryStatus`, `IacStaleLockInfo`, `RunLock`.
- Backend behaviours the comments rely on, all in desktop-main:
  - `PulumiService.assertFreshDestroyConfirmation`, `PulumiService.computeRollbackDiff`, `PulumiService.clearStaleLock`
  - `RunService` `RunLockChangedError` / `RunLockHeldError`, `PulumiOperationInFlightError`
  - `iac.controller.ts` error branches
  - `PulumiLockRecovery.formatLockAge`
  - `electron-entry.ts` resize listener and `platformWindowChromeOptions()`
- `@hyveon/shared`: `errMessage`, `formatRelativeAge`, type `DeploymentConfigDiff`; `@hyveon/shared/folderUpload` type `StrayHelperReport`.
- `lib/*`:
  - `utils.utils` (`cn`)
  - `format.utils` (`formatUsd`, `formatTimestamp`)
  - `ansi.utils` (`parseAnsiLine`)
  - `snowflake.utils` (`parseSnowflakes`)
  - `rollback-diff.utils` (`formatDiffSummary`)
  - `bridge.utils` (`BRIDGE_UNAVAILABLE`)
- Sibling components in the other sweep's range (a–g): `AnsiLogViewer`, `ConfirmDialog`, `ErrorBanner`, `ChangeSummaryStatus`. Comments also reference `AsyncContent` and `DeploymentSettingsForm`.
- External libraries: Radix (alert-dialog, dialog, dropdown-menu, label, select, slot, tabs, tooltip), class-variance-authority, sonner, lucide-react, react-router-dom.
- `src/index.css` `@theme` tokens (`--color-*`, `--radius-*`, `--font-mono`, `--font-ui`).
- `e2e/pages/LogsPage.ts` pins the LiveBadge text and PageHeader titles.

**Called by out of scope**
- `pages/iac.page.tsx`: DestroySection, SubmissionBanners, RolledBackFromLink, PageHeader.
- `pages/iac-history.page.tsx`: RunHistoryRow, RollbackAction, LoadingState, SectionCard, PageHeader, table.
- `pages/iac-run-detail.page.tsx`: RunStatusBadge, PartialApplyBadge, RolledBackFromLink, LoadingState, PageHeader.
- `pages/dashboard.page.tsx`: KpiStrip, PendingChangesBanner. `pages/games.page.tsx`: PendingChangesBanner, SectionCard, PageHeader.
- `pages/logs.page.tsx` and `pages/infrastructure-logs.page.tsx`: LogTailView.
- `pages/settings.page.tsx`: SettingsRow, WatchdogPanel, PageHeader. `pages/game-detail.page.tsx`: RemoveGameButton.
- `pages/discord/*`: SnowflakeChipsInput, Tabs, Card, Table, Label, Input, Badge.
- Components in the a–g range:
  - `DiagnosticsPanel` uses StrayHelpersButton and LogLineList.
  - `app-topbar` uses window-chrome.
  - `confirm-dialog` uses alert-dialog and input.
  - `deployment-settings-form` uses SnowflakeChipsInput and FormField.
  - `add-game-wizard/*` uses FormField, NativeSelect, Textarea, Dialog, SectionCard.
  - `first-run-wizard/*` uses InlineAlert and Select.
  - `edit-game-form`, `folder-upload/*`, `audit-entry-row`, `game-card`, `cloud-health-section`, and `change-summary-status` use ui primitives and SectionCard.
- `app.component.tsx` mounts Toaster.
- `ui/dropdown-menu.component.tsx` has no importer anywhere.
