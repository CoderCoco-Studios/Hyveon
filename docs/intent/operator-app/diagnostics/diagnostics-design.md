---
parent: operator-app
prefix: APP-DIAG
---

# App Diagnostics and Audit Trail

## Context and Design Philosophy

Hyveon's desktop app has no HTTP transport, no exception filter that writes a request log, and no server an operator can SSH into; the winston log file is the only record of what the app did once an operator reports "it hung" (`.claude/rules/logging.md`, "Why").
This leaf exists to make that record trustworthy and portable: one local log file per day that both the Electron main process and the renderer write into, a live view of it in Settings, a one-click support bundle that is safe to hand to someone else, and a cloud-side audit trail of who changed game configuration or ran IaC actions.

The leaf owns four strands that share one purpose (support evidence about app activity):

- **The app log**: the winston singleton and its daily-rotated file (`app/packages/desktop-main/src/logger.ts:61,72`), tail reads and renderer writes (`DiagnosticsService.ts:109,160,173`).
- **Renderer forwarding**: crash reporting, the top-level `ErrorBoundary`, and batched `console.*` forwarding (`app/packages/web/src/lib/report-renderer-error.utils.ts:150,165,190`, `error-boundary.component.tsx:21`).
- **The Settings → Diagnostics surface**: the polled tail panel and the "Export diagnostics bundle" action (`DiagnosticsPanel.tsx:18`, `export-bundle-button.component.tsx:28`, `DiagnosticsBundleService.ts:105`).
- **The audit trail**: `AuditService`, `AwsAuditLogStore`, and the `/audit` page (`AuditService.ts:88,132`, `AwsAuditLogStore.ts:99,136`, `audit.page.tsx:28`).

What it deliberately does not own:

- Bootstrapping: `main.ts:26` calls `createLogger`, `app.module.ts:102-112` provides `DIAGNOSTICS_LOG_DIR`, and `web/src/main.tsx:8-21` installs reporting and mounts the boundary; all belong to `operator-app/desktop-shell`, as does the Settings page that hosts the panel (`settings.page.tsx:379-382`).
- The `window.hyveon.diagnostics.*` / `audit.list` bridge (`desktop-preload/src/preload.ts:583-596`) and the `api.*` facade, owned by `operator-app/ipc-bridge`.
- Log line rendering (`LogLineList`, ANSI SGR parsing), owned by `operator-app/infra-logs`; this leaf consumes it, and the `app-diagnostics-logging` ANSI requirement is implemented there.
- CloudWatch game and Lambda logs (`/logs`), owned by `operator-app/infra-logs`.
- The stray-helper cleanup button rendered inside the panel (`DiagnosticsPanel.tsx:76`), owned by `helper-task`.
- The audit DynamoDB table (`app/packages/infra/src/dynamodb.ts`, `iac/program`) and the callers that record entries (`GamesWriteService.ts:323` in `game-server`; `iac.controller.ts:755,885,1029,1126,1285` in `iac/run`).

CLAUDE.md invariants that live here:

- **Secrets never reach the renderer**, extended to the bundle: the config section is an explicit allowlist and the log section is scrubbed (`diagnosticsBundleAllowlist.ts:85`, `diagnosticsLogScrubber.ts:31`).
- **The desktop app has no HTTP transport**: every surface here is an IPC `@MessagePattern` (`diagnostics.controller.ts:47-129`, `audit.controller.ts:24-28`).
- **Every IPC handler logs on entry; no error escapes uncaught** (`.claude/rules/logging.md`): each diagnostics handler opens with `logger.debug` (`diagnostics.controller.ts:49,57,64,71,84,111`); `AuditService.list` currently breaks rule 2 (see Deferred).

## The App Log

### Logger lifecycle

`logger.ts` exports a live ESM binding `logger` that starts as a console-only instance (`logger.ts:48-54,61`) so modules imported before `main.ts` runs can log immediately.
`createLogger(logDir)` builds a new instance with a Console transport and a `DailyRotateFile` transport, then reassigns the binding so existing importers see the upgraded logger (`logger.ts:72-90`).

| Property | Value | Source |
|---|---|---|
| File name | `main-%DATE%.log`, `datePattern: 'YYYY-MM-DD'` | `logger.ts:80-81` |
| Retention | `maxFiles: '14d'` | `logger.ts:82` |
| Level | `debug` in dev, `info` when `NODE_ENV === 'production'` | `logger.ts:4,74` |
| Dev file format | `HH:mm:ss [level] message`, pretty-printed meta on prefixed, tab-indented continuation lines | `logger.ts:12-18,41` |
| Production file format | `timestamp()` + `json()`, one line per entry | `logger.ts:42` |
| Log directory | `<userData>/logs` in Electron; `DIAGNOSTICS_LOG_DIR` env or `os.tmpdir()` outside Electron | `main.ts:26`, `app.module.ts:105-110` |

The directory is computed in two places that must agree (`main.ts:26` writes, `app.module.ts:109` reads), with no shared helper.

### Tail reads

`DiagnosticsService.readTail(maxLines)` reads at most the last 200 KB (`TAIL_READ_BYTES`, `DiagnosticsService.ts:9`) of today's file, peeking one byte earlier so the first split fragment is always safely droppable (`:117-126`).
Dev-format meta continuation lines (`META_CONTINUATION_PATTERN`, `:48`) are re-merged onto the preceding entry so `maxLines` counts `logger.*` calls, not physical lines (`:59-69,138`), and leading orphaned continuation lines from a mid-block window start are dropped (`:131-137`).
A missing file returns `[]` (first boot); any other read error is logged at `warn` and rethrown as a plain `Error` (`:139-145`).
"Today" is computed in local time (`getTodayLogPath`, `:86-93`), which appears to match winston-daily-rotate-file's default local-time date stamp `[inferred]`.

Because the read is byte-bounded, the requested line count is a ceiling, not a guarantee: the bundle asks for 2,000 lines but may get no more than the panel's 500 on a verbose log, which the code documents (`DiagnosticsBundleService.ts:19-27`).

### Renderer writes into the log

Two IPC channels write renderer-originated lines into the same file:

| Channel | Payload | Written as | Source |
|---|---|---|---|
| `diagnostics.reportError` | `{ message, stack?, source: 'boundary' \| 'window-error' \| 'unhandled-rejection' }` | `logger.error('renderer error (<source>): <message>', { stack })` | `diagnostics.controller.ts:12-16,62-66`, `DiagnosticsService.ts:160-162` |
| `diagnostics.reportLog` | `{ entries: { level, message }[], droppedCount? }` | one line per entry, `renderer console (<level>): <message>`, levels `log→debug`, `info→info`, `warn→warn`, `error→error`; plus one `N entries dropped` warn line | `diagnostics.controller.ts:19-23,69-73`, `DiagnosticsService.ts:173-186` |

The level map is a `null`-prototype object so a hostile `level` such as `__proto__` falls through to the `debug` default (`DiagnosticsService.ts:18-34`).
The main process caps a single batch at 200 entries independently of the renderer and folds any overflow into the dropped count (`:16,174-185`).

## Renderer Error and Console Forwarding

`web/src/main.tsx:8-21` installs global error reporting and console forwarding before render, wraps `<App />` in `ErrorBoundary`, and suppresses React's default `onCaughtError` console echo so a boundary-caught crash is not logged twice.

### Crash paths

- **Window errors and unhandled rejections**: `installGlobalErrorReporting` adds `error` and `unhandledrejection` listeners that call `reportRendererError` (`report-renderer-error.utils.ts:165-174`). It has no install guard and uses `instanceof Error` (`:171-172`), unlike the cross-realm `isErrorLike` used for console formatting (`:4-11`).
- **Render crashes**: `ErrorBoundary.componentDidCatch` combines the error stack and React component stack and reports with source `boundary` (`error-boundary.component.tsx:43-51`); its doc notes this is the only path that sees in-render crashes (`:13-20`). The fallback renders when `this.state.error` is truthy (`:55`) and tells the operator to "Check Settings → Logs" (`:61`), but the Settings section is titled "Diagnostics" (`settings.page.tsx:381`); there is no reset or reload control.
- `reportRendererError` is a no-op without a bridge and swallows its own IPC rejection (`report-renderer-error.utils.ts:150-159`).

### Console forwarding queue

`installConsoleForwarding` wraps `console.log/info/warn/error`, always calling the original first so DevTools output is unchanged, then enqueues `{ level, message }` (`report-renderer-error.utils.ts:190-206`); it is guarded by `consoleForwardingInstalled` and is a no-op without a bridge (`:177,191`).

| Constant | Value | Role | Source |
|---|---|---|---|
| `FLUSH_INTERVAL_MS` | 2,000 | `setInterval(flush)`; the only drain trigger, never cleared | `:14,208` |
| `MAX_BATCH_ENTRIES` | 50 | per-flush send cap; remainder stays queued | `:17,108-109` |
| `MAX_QUEUE_SIZE` | 200 | the only drop point, checked against `queue.length + inFlightCount` | `:20,67-73` |

The in-flight batch is reserved against the queue cap (`inFlightCount`, `:33,113`) so a rejected or synchronously throwing `reportLog` call can always requeue it at the front, preserving oldest-first order (`:82-85,115-136`).
`flushInFlight` blocks a newer flush while an older call is unsettled, for the same ordering reason (`:42,98-100`).
The flush doc says a call that "otherwise never resolves" is requeued (`:94-95`), but nothing times out an unsettled promise, so a hung `reportLog` stops forwarding for the session.
Reserving headroom means newer entries can be dropped before the visible queue reaches 200 while a batch is in flight; that is the intended trade: bounded memory and oldest-first delivery outrank admitting the newest entries (APP-DIAG-CONS-007).

There is no redaction of console arguments; callers own not logging secrets (spec, same requirement).

## Settings → Diagnostics Panel and Bundle Export

### Live tail

`useDiagnosticsTail` fetches `diagnostics.tail` (500 lines, hard-coded at `diagnostics.controller.ts:50`) and `diagnostics.path` together on mount and then every 5 s via its own `setInterval` (`use-diagnostics-tail.hook.ts:4,53-92`), not the app's shared polling registry.
Each response is a cumulative snapshot, not a delta, so pausing keeps polling but stores the latest result in `pendingSnapshotRef`; resume swaps it in one step (`:22-37,58-63,95-104`).
A sequence counter discards out-of-order responses, and a poll failure while paused is not surfaced so a frozen view is not replaced by an error (`:50,57,66-70`).

`DiagnosticsPanel` renders the log path, a search box (substring highlight via `LogLineList`), pause/resume, autoscroll only while not paused, a line count, `ExportBundleButton` and `StrayHelpersButton` (`DiagnosticsPanel.tsx:25-31,51-91`).
When the tail errors, the panel returns only an `ErrorBanner` (`:43-47`), so the export button disappears exactly when the log read is failing.

### Bundle export flow

```
ExportBundleButton ──diagnostics.exportBundle──▶ DiagnosticsController.exportBundle
                                                    │ native save dialog (cancel → {status:'cancelled'})
                                                    ▼
                                       DiagnosticsBundleService.writeBundle(dest)
                         Promise.allSettled ┬─ gatherLogs      → scrubSecrets(readTail(2000))
                                            ├─ gatherConfigSummary → buildDiagnosticsConfigSummary
                                            ├─ gatherMetadata  → app/electron/node/os/autoUpdate
                                            └─ gatherAwsSnapshot → ConfigService + EcsService.getStatus
                                                    │ zip to <dest>.<uuid>.tmp, rename on success
                                                    ▼
                         {status:'written', path} | {status:'error', message}
```

| Step | Behaviour | Source |
|---|---|---|
| Dialog | Default name `hyveon-diagnostics-<ISO with : and . replaced>.zip`, `.zip` filter; cancel returns `{ status: 'cancelled' }`, which the button maps back to idle; the dialog itself is `desktop-shell`'s `NativeDialogService.pickSavePath`, which resolves `null` (cancelled) outside Electron | `diagnostics.controller.ts:82-91`, `NativeDialogService.ts:43-48`, `export-bundle-button.component.tsx:41-47` |
| Section isolation | Four gatherers via `Promise.allSettled`; a rejection becomes `{ section, message }` in `errors.json` with the message passed through `scrubSecrets` | `DiagnosticsBundleService.ts:108-126,139-152` |
| Logs | `logs.txt`: scrubbed join of up to 2,000 tail entries | `:154-157` |
| Config | `config-summary.json`: allowlist of 10 top-level fields plus per-game sizing, counts and booleans (`hasWebPort`, `hasHealthCheck`, `hasPinnedHostname`); excludes `environment`, `file_seeds`, health-check `auth`, Discord IDs | `diagnosticsBundleAllowlist.ts:3-46,55-102` |
| Metadata | `metadata.json`: `readAppVersion()` (`'unknown'` outside Electron), Electron/Node versions, `os.platform()`/`os.release()`, `enableAutoUpdate` | `DiagnosticsBundleService.ts:167-176`, `app-version.ts:12-21` |
| AWS snapshot | `aws-snapshot.json`: four stack-output fields and per-game `GameStatus`; `null`/`[]` before first apply; a per-game failure becomes `{ state: 'error', message }` inside `games`, unscrubbed | `DiagnosticsBundleService.ts:187-209` |
| Write | `archiver` zip at level 9 to a UUID-suffixed temp file, renamed into place; on failure the stream is destroyed, the temp file removed, and a plain `Error` thrown, which the controller maps to `{ status: 'error' }` | `DiagnosticsBundleService.ts:128-136,232-273`, `diagnostics.controller.ts:92-99` |
| Reveal | `diagnostics.showInFolder` calls `shell.showItemInFolder`; failures are logged at `warn` and never rejected | `diagnostics.controller.ts:109-129` |

`errors.json` is always written, so an all-failed export is a valid zip containing only it (`DiagnosticsBundleService.ts:86-90,254`), matching the spec.
The result union lives once in `@hyveon/shared` (`diagnosticsBundle.ts:8-11`); its doc says `DiagnosticsPanel` switches on it, but `ExportBundleButton` does.

### Secret scrubbing

`scrubSecrets` applies two regexes (`diagnosticsLogScrubber.ts:5,15-16,31-38`): AWS access key IDs (`AKIA`/`ASIA` + 16) and a `token`/`key`/`secret`-ish label followed by `:` or `=` and a 16+ character value.
The label pattern requires the separator immediately after the label word, so JSON-quoted keys as produced by the production `json()` format (`"botToken":"..."`) and dev meta (`"apiKey": "..."`) do not match.
The scrubber is explicitly defense-in-depth (`:18-23`; archived design `2026-08-14-add-diagnostics-export/design.md`, Decisions), with "never log secrets" as the primary control.

## Audit Trail

### Data shape and storage

| Field | Type | Notes | Source |
|---|---|---|---|
| `sk` | `<ISO timestamp>#<ULID>` | sort key; ULID disambiguates same-millisecond writes | `shared/src/audit.ts:35,78-80` |
| `timestamp` | ISO string | duplicated from `sk` | `audit.ts:37` |
| `actor` | string | `os.userInfo().username` of the desktop user | `AuditService.ts:104` |
| `action` | `add \| edit \| remove \| plan \| approve \| apply \| destroy \| rollback` | IaC verbs added beside the game CRUD verbs | `audit.ts:18-26` |
| `game` | string | `game_servers` key; `''` for IaC actions | `audit.ts:43`, `iac.controller.ts:757,885` |
| `before` / `after` | `RedactedGameServer \| null` | stored as JSON strings in DynamoDB; `null` for IaC actions | `audit.ts:45-47`, `AwsAuditLogStore.ts:91-110` |
| `versionId` | string, optional | S3 version of `deployment-config.json` | `audit.ts:49` |

`AwsAuditLogStore` writes every entry under the single partition `pk = AUDIT` (`AwsAuditLogStore.ts:13`) and lists with `ScanIndexForward: false`, adding `sk < :before` for pagination; `nextBefore` is the last entry's `sk` only when DynamoDB returns a `LastEvaluatedKey` (`:136-163`).
Table name, region and credentials are resolved per call through an injected `getConfig` so a renamed table or rotated credentials are picked up; a missing table name throws a clear "table not configured" error (`:29-72`).
The store is bound to `AUDIT_LOG_STORE` by `cloud-provider.module.ts:273-276` and implements the cloud-agnostic `AuditLogStore` contract (`shared/src/cloud.ts:211`).

### Write and read paths

- **`record()`** is best-effort by contract: it reads `auditTableName` from stack outputs, logs a warning and returns if absent, and otherwise builds and puts the entry inside a try that logs and swallows failures (`AuditService.ts:78-120`). The stack-outputs read sits outside the try (`:90`), and the catch logs the raw `err` object (`:114-118`).
- **`list()`** clamps `limit` to `1..100` (default 25), returns `{ entries: [] }` when the table is not deployed so the page shows its empty state, and otherwise returns `store.listEntries(...)` with no catch (`AuditService.ts:51-56,132-141`).
- **`audit.list`** is a thin IPC handler that logs entry and defaults `opts` to `{}` (`audit.controller.ts:24-28`).

### `/audit` page

`AuditPage` fetches one page of `PAGE_SIZE` on mount and appends older pages through a "Load more" button driven by `nextBefore`, with a shared unmount guard (`audit.page.tsx:28-80`).
`AsyncContent` shows the error only when the list is empty, and a trailing line shows a "Load more" failure under a non-empty table (`audit.page.tsx:89-115`, `async-content.component.tsx:49`).
`AuditEntryRow` shows timestamp, actor, action, game and version, with an expandable side-by-side `before`/`after` JSON view (`audit-entry-row.component.tsx:31-42`).
The page header carries `<PollingIndicator />`, which reflects the global status poller, although the page itself never polls (`audit.page.tsx:85`).
Documented framing still describes only game mutations: `AuditEntry`'s doc (`audit.ts:29-33`), `AuditController`'s doc (`audit.controller.ts:8-11`), and the subtitle "Who changed which game's configuration" (`audit.page.tsx:84`), while IaC rows render an empty Game cell and a `null`/`null` diff.

The audit trail has no OpenSpec capability; its required behaviour is currently only what the code above does.

## Decisions & Alternatives

| Decision | Chosen | Alternatives Considered | Rationale |
|---|---|---|---|
| Log destination | One local daily-rotated winston file per day, 14-day retention | Remote log shipping; single unrotated file | Local file is the only post-hoc record with no HTTP cycle (`.claude/rules/logging.md`, "Why"); 14-day window `[inferred]` as a bound on disk use. |
| Logger construction | Console-only singleton upgraded in place via a reassigned live ESM binding | Inject a logger via Nest DI | Lets modules imported before `main.ts` log immediately and pick up the file transport without re-importing (`logger.ts:56-60,87`). |
| Console forwarding channel | New sibling `diagnostics.reportLog`, crash channel untouched | Widen `reportError` to a union; per-call synchronous IPC; separate pipeline | Purely additive, existing crash payload and tests unchanged (archived `2026-08-10-add-app-logging-debugging/design.md`, Decision 1). |
| Console batching | 2 s flush, 50 per flush, 200 queue cap with in-flight reservation and requeue | Per-call IPC; drop at the 50 send cap | Hot-loop console output would flood IPC and the log; bounding at 200 delivers bursts in full (same design, Decision 2). |
| Panel data source | Keep a 5 s cumulative-tail poll; pause buffers the latest snapshot | Push/stream model like `/logs`; append successive polls | Reuse `/logs` interaction patterns without its data source; snapshot shape makes appending incorrect (same design, Decision 4; spec "Diagnostics panel pause, search, and autoscroll"). |
| Bundle orchestration | New `DiagnosticsBundleService` calling into existing services | Grow `DiagnosticsService` | Distinct responsibility and test surface (archived `2026-08-14-add-diagnostics-export/design.md`, Decisions). |
| Section isolation | `Promise.allSettled` over four gatherers, failures to `errors.json` | Sequential try/catch chaining | One slow AWS call must not block cheap sections (same design). |
| Zip library | `archiver`, streamed to disk | `adm-zip` | Streams instead of buffering multi-MB logs in memory (same design). |
| Save location | Native save dialog before writing | Silent write to Downloads, then reveal | Operator controls where config/log data lands (same design). |
| Config redaction | Explicit field-by-field allowlist; new fields excluded by default | Generic deep redact-by-key-name | Safe failure direction when a new `DeploymentConfig` field is forgotten (same design, Risks; `diagnosticsBundleAllowlist.ts:70-77`). |
| Log redaction | Regex scrubber as a second layer only | Structured redaction at log time | "Never log secrets" stays primary (same design, Decisions; `diagnosticsLogScrubber.ts:18-23`). |
| Atomic bundle write | Temp file with UUID suffix, rename on success | Write in place | A partial file must never look like a complete bundle; UUID avoids concurrent-export races (`DiagnosticsBundleService.ts:92-95,221-231`). |
| Audit storage layout | Single `pk = AUDIT` partition, `sk = ISO#ULID`, before/after as JSON strings | Per-game partition; native DynamoDB maps | Newest-first query with no sort; JSON strings keep item shape stable across `GameServer` changes (`AwsAuditLogStore.ts:7-12,91-95`). Single-partition scalability is `[inferred]` acceptable at operator scale. |
| Audit write semantics | Best-effort `record()` that never blocks the mutation | Fail the mutation on audit failure; transactional write | An audit failure or undeployed table must not block the `game_servers` write (`AuditService.ts:6-9`). |
| Audit actor identity | `os.userInfo().username` | Cloud identity (STS caller ARN); Discord user | `[inferred]` the desktop app is single-operator and has no app-level user identity. |
| IaC actions in the audit log | Reuse the game-shaped schema with `game: ''` and `null` diffs | A separate IaC run log; a widened entry schema | `[inferred]` cheapest extension; the callers' comments call these "fixed values the `game_servers`-shaped audit schema takes" (`iac.controller.ts:747-754`). |

## Open Questions & Future Decisions

### Resolved

1. ✅ Console forwarding uses a separate `diagnostics.reportLog` channel with client-side batching (archived `2026-08-10-add-app-logging-debugging/design.md`, Decisions 1-2).
2. ✅ The bundle is assembled by a dedicated service with per-section `Promise.allSettled` isolation, `archiver`, a save-dialog-first flow, and an allowlist config summary (archived `2026-08-14-add-diagnostics-export/design.md`, Decisions).
3. ✅ The panel keeps polling rather than streaming, with snapshot-swap pause semantics (archived `2026-08-10-add-app-logging-debugging/design.md`, Decision 4).

### Deferred

1. Should `scrubSecrets` redact JSON-quoted labeled values (`"botToken":"..."`, `"apiKey": "..."`) that the production `json()` and dev meta formats actually emit? Today `LABELED_SECRET_VALUE_PATTERN` needs `[:=]` right after the label (`diagnosticsLogScrubber.ts:15-16`, `logger.ts:14,42`), and tests cover only unquoted shapes (`diagnosticsLogScrubber.test.ts:14-29`).
2. How should the console forwarder recover from a `reportLog` promise that never settles? `flushInFlight` is cleared only on settle (`report-renderer-error.utils.ts:98-100,127-137`), contradicting its own doc (`:94-95`).
3. Should `ExportBundleButton` (and `StrayHelpersButton`) stay rendered when the tail read fails (`DiagnosticsPanel.tsx:43-47,74-76`)? The bundle already tolerates a failed log section (`DiagnosticsBundleService.ts:123`).
4. Should `AuditService.list` catch, normalize and log store failures per `.claude/rules/logging.md` rule 2 (`AuditService.ts:140`), and should `record()` normalize its logged error and move the stack-outputs read inside its try (`AuditService.ts:90,114-118`)? No test covers a `listEntries` rejection (`AuditService.test.ts:143-170`).
5. Should `ErrorBoundary` detect falsy throws (`error-boundary.component.tsx:55`), point to "Settings → Diagnostics" instead of the non-existent "Settings → Logs" (`:61`), and offer a reload action?
6. Should `installGlobalErrorReporting` gain an install guard and use `isErrorLike` like `formatConsoleArgs` (`report-renderer-error.utils.ts:4-11,165-174`)? Should the flush interval ever be cleared (`:208`)?
7. Should the audit trail get its own OpenSpec capability (or its own leaf), given it has no spec and now records IaC actions under a game-only schema and copy (`audit.ts:29-33`, `audit.controller.ts:8-11`, `audit.page.tsx:84`, `iac.controller.ts:755,885,1029`)? If IaC rows stay, how should the page render an empty Game cell and a `null`/`null` diff?
8. Should the `/audit` page drop or rewire `<PollingIndicator />`, which reflects the global status poller on a page that fetches once (`audit.page.tsx:85`, `polling-indicator.component.tsx:18`)?
9. Should per-game `getStatus` failure messages in `aws-snapshot.json` pass through `scrubSecrets` like section errors do (`DiagnosticsBundleService.ts:192-199` vs `:149`)?
10. Should the log directory and `readAppVersion` route through `electronRuntime.ts` (`main.ts:26`, `app.module.ts:109`, `electronRuntime.ts:17`, `app-version.ts:5-6,12-21`) so the write and read paths cannot drift?
11. Should `useDiagnosticsTail` move onto the shared polling registry and stop re-fetching the static log path every 5 s (`use-diagnostics-tail.hook.ts:56,83`)? Should the 500-line panel tail be a shared constant rather than a literal (`diagnostics.controller.ts:50`), and `TAIL_READ_BYTES` be exported instead of duplicated in tests (`DiagnosticsService.test.ts:17-18`)?
12. Stale pointers to refresh: "diagnostics API endpoint" (`DiagnosticsService.ts:72-74`), `openspec/changes/add-diagnostics-export` now archived (`DiagnosticsBundleService.ts:64`), and `diagnosticsBundle.ts:3` naming `DiagnosticsPanel` as the switcher.
13. `AwsAuditLogStore` resolves `getConfig()` twice per operation (`AwsAuditLogStore.ts:65,83`); acceptable, or fold into one resolution?
14. Test hygiene: `logger.test.ts:16,27,99` builds real `DailyRotateFile` transports under `/tmp`; there are no dedicated tests for `export-bundle-button.component.tsx` or `use-diagnostics-tail.hook.ts`; `DiagnosticsPanel.tsx` is the lone PascalCase component filename (sweep disagreement, `final-clustering.md` §6).
15. The `add-pinned-hostname` change added `hasPinnedHostname` to the bundle allowlist (`diagnosticsBundleAllowlist.ts:23,66`) but is shipped, unsynced and unarchived; does `app-diagnostics-logging` need a delta for it when that change is archived?
16. The `embed-file-browser` change's `game-volume-folder-upload` delta asks for stray-helper cleanup "from Diagnostics"; the button already renders here (`DiagnosticsPanel.tsx:76`). Should the diagnostics spec acknowledge that hosting, or does it belong solely to `helper-task`?

## References

- Arrow doc: `docs/arrows/operator-app/diagnostics.md`
- EARS specs: `docs/intent/operator-app/diagnostics/diagnostics-specs.md`
- OpenSpec: `openspec/specs/app-diagnostics-logging/spec.md`; archived design docs `openspec/changes/archive/2026-08-10-add-app-logging-debugging/design.md`, `openspec/changes/archive/2026-08-14-add-diagnostics-export/design.md`, plus `2026-08-10-ansi-log-rendering` and `2026-08-21-remove-log-level-filter`
- Active changes touching this leaf: `openspec/changes/add-pinned-hostname/`, `openspec/changes/embed-file-browser/`
- Rules: `.claude/rules/logging.md`
- Docs pages: `docs/docs/app/settings.md`, `docs/docs/app/audit.md`, `docs/docs/components/management-app.md`
- Neighbouring leaf designs: `docs/intent/operator-app/desktop-shell/desktop-shell-design.md`, `docs/intent/operator-app/ipc-bridge/ipc-bridge-design.md`, `docs/intent/operator-app/infra-logs/infra-logs-design.md`, `docs/intent/helper-task/helper-task-design.md`, `docs/intent/game-server/game-server-design.md`, `docs/intent/iac/run/run-design.md`, `docs/intent/iac/program/program-design.md`
