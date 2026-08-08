## Context

Hyveon's only durable record of what happened in a running app is the
winston log file written by `app/packages/desktop-main/src/logger.ts`
(`DailyRotateFile`, `main-%DATE%.log`, 14-day retention). There is no HTTP
transport (`CLAUDE.md`'s desktop-only-operator-surface invariant) and no
NestJS exception filter, so this file plus whatever the operator can
copy-paste from DevTools is the entire diagnostic surface.

Existing pieces this design builds on, confirmed against current source:

- `app/packages/web/src/lib/report-renderer-error.utils.ts` —
  `installGlobalErrorReporting()` already wires `window.onerror` and
  `unhandledrejection` to `reportRendererError()`, which best-effort-calls
  `window.hyveon.diagnostics.reportError(...)`. `error-boundary.component.tsx`
  calls the same function from `componentDidCatch`. All three funnel into
  `DiagnosticsController.reportError` (`diagnostics.controller.ts:40-44`) →
  `DiagnosticsService.logRendererError()` → `logger.error('renderer error
  (${source}): ${message}', { stack })`.
- `app/packages/desktop-main/src/logger.ts` — plain module-level singleton
  (`export let logger`), not a NestJS-injected `LoggerService`; every
  controller/service imports it directly (`import { logger } from
  '../logger.js'`). Standard winston npm levels only:
  `error, warn, info, http, verbose, debug, silly`. `level: isDev ? 'debug'
  : 'info'`. `verbose`/`silly` are configured but unused anywhere in the
  codebase today (0 hits for both).
- `app/packages/desktop-main/src/ipc-main-bridge.ts` — `registerIpcMainBridges()`
  generically wires every `@MessagePattern` handler to `ipcMain.handle`,
  except patterns in `SELF_BRIDGED_PATTERNS` (streaming channels like
  `logs.stream`) which self-bridge via their own `OnModuleInit`. A one-shot
  "report this batch of console lines" channel gets the generic bridge
  automatically — no self-bridging needed.
- `.claude/rules/logging.md` — the existing rule already states the
  destination pattern (catch, `err instanceof Error ? err.message :
  String(err)`, log via `logger.warn`/`logger.error`, return a modeled
  result or a plain `Error`) via `GuidedIamService`/`AwsProfileService`/
  `IamCheckService`. This change extends that same pattern into services
  that currently have zero `logger.debug` coverage; it does not invent a
  new pattern.
- `app/packages/web/src/components/ansi-log-viewer.component.tsx` and
  `app/packages/web/src/pages/logs.page.tsx` — the `/logs` page already
  implements level-filter badges (`INFO/WARN/ERROR/DEBUG` via regex),
  search-highlight, autoscroll toggle, and pause/resume with buffering
  against a *different* data source (CloudWatch game-server logs via
  `logs.get`/`logs.stream`). `DiagnosticsPanel.tsx` reads a different
  source (the app's own log via `diagnostics.tail`, polled every 5s) and
  has none of these controls. This change ports the same interaction
  patterns onto `DiagnosticsPanel.tsx`, not the underlying data source.

## Goals / Non-Goals

**Goals:**

- An operator's own `console.*` narration during a bug survives into
  `main-*.log`, not just uncaught crashes.
- The service layer's AWS SDK/Pulumi call sites are debuggable from the log
  file alone, matching the coverage controllers already have.
- The Diagnostics panel is as usable as `/logs` for reading the app's own
  log: pause, filter by level, search.

**Non-Goals:**

- A custom winston `trace` level. Decided with the user: reuse `debug`
  (normal detail) and `silly` (very verbose/hot-path detail, already
  configured, currently unused).
- Touching IPC controller entry-logging — already 100% compliant.
- A structured/queryable log store, external aggregation, or log shipping.
- Forwarding console output from the Playwright `chromium` E2E project
  (runs outside Electron, no `window.hyveon` bridge) — the existing
  no-op-when-no-bridge guard already handles this and needs no new code.

## Decisions

### Decision 1: Extend the existing `diagnostics.reportError` channel's payload shape rather than adding a fully separate pipeline

**Chosen:** widen `ReportRendererErrorInput` (`diagnostics.controller.ts`)
into a shape that also carries ordinary console entries — e.g. add a
`level: 'log' | 'info' | 'warn' | 'error' | 'crash'` discriminant, keep
`message`/`stack` (`stack` now optional/absent for non-Error console
calls), and keep `source` for the crash sub-cases
(`'boundary' | 'window-error' | 'unhandled-rejection'`) plus a new
`'console'` source for forwarded console calls. Rename the channel's
public IPC method surface only if needed for clarity; the underlying
`diagnostics.reportError` `@MessagePattern` name can stay if the payload
discriminant makes the two cases unambiguous, or split into
`diagnostics.reportError` (unchanged, crash-only) and a new
`diagnostics.reportLog` (console calls) — implementation decides based on
how invasive the discriminated-union refactor turns out to be against
existing callers and tests.

Alternatives considered:

| Option | Why not |
|---|---|
| Replace `console.*` globally with a function that both logs to DevTools and calls IPC synchronously per call | No batching — every `console.log` becomes an IPC round-trip, and a hot loop logging in a render path would flood both the IPC channel and the log file. |
| A wholly separate main-to-renderer logging pipeline (new controller, new service, new preload namespace) | Duplicates `DiagnosticsService`'s file-path/log-write logic for no benefit — the destination file and the write mechanics are identical to what `logRendererError` already does. |

### Decision 2: Batch and throttle console forwarding client-side, before it reaches IPC

Renderer code overrides `console.log`/`info`/`warn`/`error` to (a) still
call the original console method so DevTools behavior is unchanged, and
(b) push an entry onto an in-memory queue that flushes to
`diagnostics.reportError`/`reportLog` on a short interval (e.g. every
1–2 seconds) or when the queue reaches a size cap, whichever comes first —
mirroring the buffering pattern `/logs`'s pause/resume already uses
(`ansi-log-viewer.component.tsx`), but for a write path instead of a
read path. A hard per-flush entry cap with a "N entries dropped" marker
line prevents a runaway loop from producing unbounded memory growth or an
unbounded IPC payload.

Rationale: console statements are frequently emitted in tight loops or
render cycles; forwarding every single call as its own IPC round-trip
would itself become a performance and log-volume problem, defeating the
purpose of adding visibility.

### Decision 3: Service-layer sweep scope — SDK/engine call sites only, not every file

Confirmed by grepping `app/packages/desktop-main/src/services/*.ts` for
`logger.debug`: 8 of 34 files have any coverage today
(`BootstrapService`, `DeploymentConfigService`, `Ec2Service`,
`ElectronStoreService`, `FileManagerService`, `FirstRunWizardService`,
`PulumiWorkspaceService`, `SchedulerService`). The remaining 26 split into
two groups:

- **In scope**: files whose methods call an AWS SDK client, invoke the
  Pulumi engine, or otherwise reach an external system that can fail —
  `AuditService`, `AwsProfileService`, `ConfigService`, `CostService`,
  `DiagnosticsService` (the extension itself), `DiscordCommandRegistrar`,
  `DiscordConfigService`, `DriftService`, `EcsService`, `GamesWriteService`,
  `GuidedIamService`, `IamCheckService`, `LogsService`,
  `PulumiCancellation`, `PulumiCredentialResolver`, `PulumiEngineService`,
  `PulumiLeakedPromise`, `PulumiLockRecovery`, `PulumiService`,
  `RunRecordService`, `RunService`, `SafeStorageService`,
  `awsCredentialSource`, `verifyAccessKeyWithRetry`.
- **Out of scope**: pure-function helpers with no external call and no
  failure mode worth a log line — `mergeGameLists.ts`, `sleep.ts`. Adding
  `logger.debug` to these would be noise with no diagnostic value, contrary
  to `CLAUDE.md`'s "don't add... for scenarios that can't happen."

Each in-scope file gets: a `logger.debug` on entry to methods that make an
external call (mirroring the controller-entry convention, method name only
— never payload contents), and a `logger.warn`/`logger.error` on any
failure path that currently lets a raw SDK/Node error propagate uncaught,
per `.claude/rules/logging.md`'s existing requirement. Methods that already
throw a plain `Error` with a clear `.message` and no raw SDK object
escaping get a debug entry line only, not a rewritten error path.

### Decision 4: Diagnostics panel gets the `/logs` page's controls, not its data source

`ansi-log-viewer.component.tsx`'s pause/resume-with-buffering, level-filter
badges, and search-highlight are UI patterns independent of where the data
comes from (CloudWatch stream vs. polled tail). `DiagnosticsPanel.tsx`
keeps its own 5-second poll against `diagnostics.tail` — no change to
becoming a push/stream model — but gains:

- **Pause**: freeze the displayed line set while polling continues in the
  background (matching `/logs`'s buffer-while-paused, flush-on-resume
  behavior), so an operator can stop mid-scroll to read without new lines
  yanking the viewport.
- **Level filter**: reuse the same `INFO/WARN/ERROR/DEBUG` regex
  classification `/logs` already uses on each line, exposed as filter
  toggles.
- **Search**: substring match with highlight, no regex support (matching
  `/logs`'s existing scope).

Alternatives considered:

| Option | Why not |
|---|---|
| Switch `DiagnosticsPanel` to a push/stream model like `logs.stream` | The app's own log is local-file-based, not CloudWatch-based; there's no existing main-process file-watch-and-stream mechanism for it, and building one is materially more work than porting UI controls onto the existing 5s-poll model for a marginal latency improvement on a panel used for post-hoc debugging, not live monitoring. |
| Extract a shared `LogViewer` component used by both pages | Tempting, but the two components differ in data-fetch model (stream vs. poll) enough that a shared abstraction would need a fetch-strategy prop layer; left as a possible follow-up, not required to deliver parity of *behavior*. |

## Risks / Trade-offs

- **Console forwarding becomes log-volume noise** → per-flush entry cap
  with an explicit "N entries dropped" marker line (Decision 2); operators
  can already ignore `debug`-level lines in the panel's new level filter.
- **A secret gets logged via `console.log(someObjectThatIncludesASecret)`
  in existing app code** → out of this change's control (it can't
  redact arbitrary object contents), but the override truncates/stringifies
  non-primitive console arguments the same conservative way regardless,
  and existing app code is expected to already follow
  `.claude/rules/logging.md`'s no-secrets rule for anything it logs.
  Explicitly not a new attack surface: today those same `console.log`
  calls already exist and simply aren't captured; this change captures
  them into a local file the operator already controls, not a new
  external destination.
- **IPC channel volume from console forwarding competes with real IPC
  traffic** → batching interval and entry cap (Decision 2) keep the worst
  case bounded; the flush is a single small message, not per-call.
- **Service-layer sweep touching 23 files risks review fatigue in one PR**
  → split across the PR stack per `tasks.md`; each service file's debug
  lines are small, independent, mechanical diffs reviewable individually
  or in small batches.

## Migration Plan

No data migration. This is additive logging/UI work with no schema or
persisted-state changes.

1. **Group 1 — console forwarding**: `diagnostics.controller.ts` payload
   extension, `DiagnosticsService` write-path extension, preload/bridge
   plumbing, the renderer-side override + batching in
   `report-renderer-error.utils.ts`, wired in `main.tsx`. Independently
   shippable and testable.
2. **Group 2 — service-layer sweep**: the 23 in-scope service files from
   Decision 3, landed as one PR (mechanical, low review risk per file) or
   split further if review load warrants it once underway. No dependency
   on Group 1.
3. **Group 3 — Diagnostics panel UX**: pause/filter/search on
   `DiagnosticsPanel.tsx`. Benefits from Group 1 being live (more to see
   in the panel) but has no hard code dependency on it — can land in
   either order.
4. **Docs**: `docs/docs/components/management-app.md` and
   `docs/docs/app/settings.md` updated once the flow is verifiable
   end-to-end — per `.claude/rules/pr-stacking.md`'s sanctioned exception,
   this can land as a dedicated final PR in the stack rather than
   duplicated across Groups 1–3, since the three groups are independently
   small enough that splitting docs per-group would fragment a single
   coherent "here's how logging/diagnostics work now" narrative.

**Rollback:** every group is additive. Reverting Group 1 leaves crash-only
reporting exactly as it is today; reverting Group 2 leaves whichever
services were already covered; reverting Group 3 leaves the panel as a
plain scrolling view.

## Open Questions

None outstanding — scope, trace-level approach, panel UX inclusion, and
delivery process (OpenSpec + PR stack) were all confirmed with the user
before this design was written.
