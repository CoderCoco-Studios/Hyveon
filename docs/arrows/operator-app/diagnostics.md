# Arrow: diagnostics

The app's own winston log, the Settings → Diagnostics live tail and "Export diagnostics bundle" action, forwarding of renderer crashes and `console.*` output into that log, and the `/audit` trail of who changed what.

## Status

**MAPPED** — mapped 2026-10-30 (git SHA `5c55a380`), not yet audited.
All five `app-diagnostics-logging` requirements have working code and tests; the main gap is an audit trail whose EARS are derived from its code alone.

## References

### HLD
- `docs/high-level-design.md`
- `docs/intent/operator-app/operator-app-design.md` (sub-HLD)

### LLD
- `docs/intent/operator-app/diagnostics/diagnostics-design.md`

### EARS
- `docs/intent/operator-app/diagnostics/diagnostics-specs.md` (96 specs)

### Tests
- `app/packages/cloud-aws/src/AwsAuditLogStore.test.ts`
- `app/packages/desktop-main/src/app-version.test.ts`
- `app/packages/desktop-main/src/controllers/audit.controller.test.ts`
- `app/packages/desktop-main/src/controllers/diagnostics.controller.test.ts`
- `app/packages/desktop-main/src/logDir.test.ts`
- `app/packages/desktop-main/src/logger.test.ts`
- `app/packages/desktop-main/src/services/AuditService.test.ts`
- `app/packages/desktop-main/src/services/DiagnosticsBundleService.test.ts`
- `app/packages/desktop-main/src/services/DiagnosticsService.test.ts`
- `app/packages/desktop-main/src/services/diagnosticsBundleAllowlist.test.ts`
- `app/packages/desktop-main/src/services/diagnosticsLogScrubber.test.ts`
- `app/packages/shared/src/audit.test.ts`
- `app/packages/web/e2e/integration-specs/diagnostics-export.spec.ts`
- `app/packages/web/e2e/specs/audit.spec.ts`
- `app/packages/web/src/components/DiagnosticsPanel.test.tsx`
- `app/packages/web/src/components/audit-entry-row.component.test.tsx`
- `app/packages/web/src/components/error-boundary.component.test.tsx`
- `app/packages/web/src/lib/report-renderer-error.utils.test.ts`
- `app/packages/web/src/pages/audit.page.test.tsx`

### Code
- **desktop-main**
  - `app/packages/desktop-main/src/logger.ts`
  - `app/packages/desktop-main/src/logDir.ts`
  - `app/packages/desktop-main/src/app-version.ts`
  - `app/packages/desktop-main/src/controllers/diagnostics.controller.ts`
  - `app/packages/desktop-main/src/controllers/audit.controller.ts`
  - `app/packages/desktop-main/src/services/DiagnosticsService.ts`
  - `app/packages/desktop-main/src/services/DiagnosticsBundleService.ts`
  - `app/packages/desktop-main/src/services/diagnosticsBundleAllowlist.ts`
  - `app/packages/desktop-main/src/services/diagnosticsLogScrubber.ts`
  - `app/packages/desktop-main/src/services/AuditService.ts`
- **shared**
  - `app/packages/shared/src/audit.ts`
  - `app/packages/shared/src/diagnosticsBundle.ts`
- **cloud-aws**
  - `app/packages/cloud-aws/src/AwsAuditLogStore.ts`
- **web**
  - `app/packages/web/src/components/DiagnosticsPanel.tsx`
  - `app/packages/web/src/components/export-bundle-button.component.tsx`
  - `app/packages/web/src/hooks/use-diagnostics-tail.hook.ts`
  - `app/packages/web/src/components/error-boundary.component.tsx`
  - `app/packages/web/src/lib/report-renderer-error.utils.ts`
  - `app/packages/web/src/pages/audit.page.tsx`
  - `app/packages/web/src/components/audit-entry-row.component.tsx`
  - `app/packages/web/e2e/pages/AuditPage.ts` (Playwright page object)

### Cited from other leaves
- `app/packages/desktop-main/src/main.ts:26` and `app/packages/desktop-main/src/app.module.ts:102-112` (`operator-app/desktop-shell`): call `createLogger`, provide `DIAGNOSTICS_LOG_DIR`, register `DiagnosticsController`/`AuditController`.
- `app/packages/desktop-main/src/services/NativeDialogService.ts` (`operator-app/desktop-shell`): `pickSavePath` (`:43-48`) backs the export save dialog; `diagnostics-export.spec.ts` stubs it on the container instance because the in-process harness has no Electron (`diagnostics-export.spec.ts:27-39`).
- `app/packages/web/src/main.tsx:8-21` (`operator-app/desktop-shell`): installs global error reporting and console forwarding, mounts `ErrorBoundary`.
- `app/packages/web/src/pages/settings.page.tsx:379-382` (`operator-app/desktop-shell`): hosts `DiagnosticsPanel` under a "Diagnostics" heading.
- `app/packages/desktop-main/src/modules/cloud-provider.module.ts:273-276` (`operator-app/desktop-shell`): binds `AUDIT_LOG_STORE` to `AwsAuditLogStore`.
- `app/packages/desktop-preload/src/preload.ts:583-596` and `app/packages/web/src/api.service.ts` (`operator-app/ipc-bridge`): the `window.hyveon.diagnostics.*` / `audit.list` bridge and `api.*` facade.
- `app/packages/web/src/components/log-line-display.component.tsx`, `app/packages/web/src/lib/ansi.utils.ts` (`operator-app/infra-logs`): `LogLineList` and ANSI rendering used by `DiagnosticsPanel`.
- `app/packages/web/src/components/stray-helpers-button.component.tsx` (`helper-task`): rendered inside `DiagnosticsPanel.tsx:76`.
- `app/packages/desktop-main/src/services/GamesWriteService.ts:323` (`game-server`) and `app/packages/desktop-main/src/controllers/iac.controller.ts:755,885,1029,1126,1285` (`iac/run`): the only `AuditService.record` callers.
- `app/packages/infra/src/dynamodb.ts` (`iac/program`): the audit table.
- `app/packages/shared/src/cloud.ts:211` (`game-runtime/task-and-dns`): the `AuditLogStore` contract.
- `app/packages/shared/src/types.ts:95-98` (`game-runtime/task-and-dns`): `RendererConsoleLevel` / `RendererLogEntry`.
- `app/packages/desktop-main/src/controllers/iac-settings.controller.ts:235` (`app-update-and-release`): also calls `readAppVersion`.

## Architecture

**Purpose:** Give the operator (and anyone they send a support bundle to) a local, secret-free record of what the app did: the main-process winston log, renderer errors and console output folded into it, a live tail in Settings, a one-click zip export, and a DynamoDB-backed audit trail of game and IaC mutations.

**Key Components:**
1. `logger.ts:61,72`: module-level winston singleton, upgraded by `createLogger(logDir)` to add a `DailyRotateFile` transport writing `main-%DATE%.log` (14-day retention); dev uses `devPrintf`, production uses JSON.
2. `DiagnosticsService` (`DiagnosticsService.ts:109,160,173`): byte-bounded tail read (200 KB) with pretty-printed meta continuation lines re-merged; writes renderer errors and console batches into the log.
3. `DiagnosticsController` (`diagnostics.controller.ts:47-129`): IPC channels `diagnostics.tail` / `path` / `reportError` / `reportLog` / `exportBundle` / `showInFolder`; opens the bundle save dialog through `NativeDialogService.pickSavePath` with the title, default name and `.zip` filter it supplies (`diagnostics.controller.ts:85-88`).
4. `DiagnosticsBundleService.writeBundle` (`DiagnosticsBundleService.ts:105`): gathers logs, config summary, metadata and AWS snapshot via `Promise.allSettled`, writes `logs.txt`, `config-summary.json`, `metadata.json`, `aws-snapshot.json`, `errors.json` to a temp file and renames into place.
5. `buildDiagnosticsConfigSummary` (`diagnosticsBundleAllowlist.ts:85`) and `scrubSecrets` (`diagnosticsLogScrubber.ts:31`): the allowlist and regex scrubber that keep secrets out of the bundle.
6. `report-renderer-error.utils.ts:150,165,190`: `reportRendererError`, `installGlobalErrorReporting`, `installConsoleForwarding` (2 s flush, 50 per flush, 200-entry queue).
7. `ErrorBoundary` (`error-boundary.component.tsx:21`): top-level render-crash fallback that forwards via `reportRendererError(..., 'boundary')`.
8. `DiagnosticsPanel` + `useDiagnosticsTail` (`DiagnosticsPanel.tsx:18`, `use-diagnostics-tail.hook.ts:39`): 5 s polled tail with pause (snapshot-swap on resume), search highlight, autoscroll; hosts `ExportBundleButton` (`export-bundle-button.component.tsx:28`).
9. `AuditService` (`AuditService.ts:88,132`): best-effort `record()` (actor = OS username) and paged `list()` (limit clamped to 1..100), both skipped when `auditTableName` is absent from stack outputs.
10. `AwsAuditLogStore` (`AwsAuditLogStore.ts:99,136`): single `pk = AUDIT` partition, `sk = <ISO>#<ULID>` (`audit.ts:78`), newest-first query with `sk < :before` cursor.
11. `AuditPage` + `AuditEntryRow` (`audit.page.tsx:28`, `audit-entry-row.component.tsx:42`): `/audit` table with "Load more" pagination and expandable before/after JSON.

## Spec Coverage

| Category | Spec IDs | Implemented | Deferred | Gaps |
|---|---|---|---|---|
| App Log File | `APP-DIAG-LOG-001` to `APP-DIAG-LOG-008` | 8 | 0 | 0 |
| Log Tail Reads | `APP-DIAG-TAIL-001` to `APP-DIAG-TAIL-006` | 6 | 0 | 0 |
| Renderer Error Reporting | `APP-DIAG-RERR-001` to `APP-DIAG-RERR-009` | 9 | 0 | 0 |
| Renderer Console Forwarding | `APP-DIAG-CONS-001` to `APP-DIAG-CONS-015` | 15 | 0 | 0 |
| Service-Layer Logging | `APP-DIAG-SVC-001` to `APP-DIAG-SVC-005` | 3 | 0 | 2 |
| Diagnostics Panel | `APP-DIAG-PANEL-001` to `APP-DIAG-PANEL-010` | 9 | 0 | 1 |
| ANSI Log Line Rendering | owned by `infra-logs` (`APP-LOGS-RENDER-001`, `-002`) | — | — | — |
| Diagnostics Bundle Export | `APP-DIAG-BNDL-001` to `APP-DIAG-BNDL-018` | 17 | 0 | 1 |
| Log Secret Scrubbing | `APP-DIAG-SCRUB-001` to `APP-DIAG-SCRUB-004` | 4 | 0 | 0 |
| Audit Trail Recording | `APP-DIAG-AUDIT-001` to `APP-DIAG-AUDIT-008` | 7 | 0 | 1 |
| Audit Trail Reading | `APP-DIAG-AUDR-001` to `APP-DIAG-AUDR-004` | 3 | 0 | 1 |
| Audit Page | `APP-DIAG-AUDUI-001` to `APP-DIAG-AUDUI-008` | 7 | 0 | 1 |

**Summary:** 94 of 95 active specs implemented; 0 deferred; 1 gap.

## Key Findings

1. **Log scrubber covers JSON-quoted keys**: `LABELED_SECRET_VALUE_PATTERN` (`diagnosticsLogScrubber.ts:19-20`) accepts a closing quote (plain or backslash-escaped) between the label and the `:`/`=` and an opening quote before the value, so the production `winston.format.json()` shape (`"botToken":"…"`, `logger.ts:37,42`) and the dev `devPrintf` meta shape (`"apiKey": "…"`, `logger.ts:14`) are redacted. Short or unlabeled secrets are still not caught (scrubber is defense-in-depth by its own doc).
2. **Console forwarder recovers from a hung call**: `flush()` treats a `reportLog` call that has not settled within `FLUSH_TIMEOUT_MS` as failed, requeues the batch and clears `flushInFlight`; a late settle is ignored (`report-renderer-error.utils.ts`).
3. **Effective queue cap is below 200 while a batch is in flight**: `enqueue` drops when `queue.length + inFlightCount >= 200` (`report-renderer-error.utils.ts:68`), so up to 50 entries of headroom are reserved for requeue. This is the intended contract (APP-DIAG-CONS-007).
4. **Global error reporting is idempotent and cross-realm safe**: `installGlobalErrorReporting` is guarded by `globalErrorReportingInstalled` and reads a rejection reason with `isErrorLike`. The flush `setInterval` is never cleared, by design for a session-long forwarder.
5. **ErrorBoundary fallback tracks a `hasError` flag and points to Settings → Diagnostics**: a descendant that throws `0`/`''`/`null` still gets the fallback (`error-boundary.component.tsx`); the fallback offers no reset or reload action.
6. **Panel error state hides the export button**: when `diagnostics.tail` fails, `DiagnosticsPanel` returns only an `ErrorBanner` (`DiagnosticsPanel.tsx:43-47`), so `ExportBundleButton` and `StrayHelpersButton` (`:74-76`) disappear exactly when an operator most needs a bundle. The bundle itself treats a log failure as one recoverable section (`DiagnosticsBundleService.ts:123`).
7. **`AuditService.list` lets store rejections escape raw**: `return this.store.listEntries(...)` (`AuditService.ts:140`) has no catch, against `.claude/rules/logging.md` rule 2; no test covers a `listEntries` rejection (`AuditService.test.ts:143-170` only mocks resolutions). The page catches it generically (`audit.page.tsx:52-54`).
8. **`AuditService.record` logs a raw error object and is not fully "never throws"**: the catch logs `{ err }` unnormalized (`AuditService.ts:114-118`); the `getStackOutputs()` read (`:90`) sits outside the try, so a rejection there would propagate, although `ConfigService.getStackOutputs` only rejects defensively (`ConfigService.ts:152-166`) `[inferred: unlikely in practice]`.
9. **Audit trail outgrew its "game_servers" framing**: IaC entries are recorded with `game: ''`, `before/after: null` (`iac.controller.ts:755,885,1029`), yet `AuditEntry`'s doc (`audit.ts:29-33`), `AuditController`'s doc (`audit.controller.ts:8-11`), and the page subtitle "Who changed which game's configuration" (`audit.page.tsx:84`) still describe only game mutations; IaC rows render an empty Game cell and a null/null diff.
10. **Audit page shows a polling indicator for a page that never polls**: `<PollingIndicator />` defaults to the global `status` poller (`audit.page.tsx:85`, `polling-indicator.component.tsx:18`) while the page fetches once on mount (`audit.page.tsx:43-61`). The inventory's "error rendered twice" (`audit.page.tsx:89-115`) is refuted: `AsyncContent` shows the error only when the list is empty (`async-content.component.tsx:49`), and the trailing line covers the non-empty "Load more" failure.
11. **Log directory derived once**: `resolveLogDir` (`logDir.ts`) feeds both `createLogger` in `main.ts` and the `DIAGNOSTICS_LOG_DIR` provider in `app.module.ts`. `readAppVersion` (`app-version.ts:12-21`) still re-implements the lazy-require pattern of `electronRuntime.ts`, and its doc says it "mirrors `CloudHealthService.readIsPackaged`" (`:5-6`), which now delegates to `electronRuntime.ts` (`CloudHealthService.ts:12`).
12. **Stale doc pointers**: `DiagnosticsService`'s class doc says "diagnostics API endpoint" (`DiagnosticsService.ts:72-74`; there is no HTTP transport); `DiagnosticsBundleService`'s class doc names a change directory that no longer exists (`DiagnosticsBundleService.ts:64`); `diagnosticsBundle.ts:3` says `DiagnosticsPanel` switches on the result, but `ExportBundleButton` does (`export-bundle-button.component.tsx:41-47`).
13. **Per-game ECS failures are folded into the snapshot, not `errors.json`**: `gatherAwsSnapshot` models a failed `getStatus` as `{ state: 'error', message }` in `games` (`DiagnosticsBundleService.ts:192-199`); only a whole-section failure reaches `errors.json`. Arguably within the spec ("MAY be incomplete"), but the per-game message is not passed through `scrubSecrets` the way section errors are (`:149`).
14. **Polling and constants live outside shared seams**: `useDiagnosticsTail` runs its own `setInterval` (`use-diagnostics-tail.hook.ts:83`) instead of the polling registry, and re-fetches the log path every 5 s (`:56`); the 500-line tail is hard-coded in the controller (`diagnostics.controller.ts:50`); `DiagnosticsService.test.ts:17-18` duplicates `TAIL_READ_BYTES`; `AwsAuditLogStore` resolves `getConfig()` twice per operation (`AwsAuditLogStore.ts:65,83`).
15. **Test hygiene**: `logger.test.ts:16,27,99` builds real `DailyRotateFile` transports under `/tmp`; there is no dedicated test file for `export-bundle-button.component.tsx` or `use-diagnostics-tail.hook.ts` (covered indirectly via `DiagnosticsPanel.test.tsx`); `DiagnosticsPanel.tsx` is the lone PascalCase component filename (§6).

## Work Required

Spec IDs cite the open (`[ ]`) gap specs in `docs/intent/operator-app/diagnostics/diagnostics-specs.md`; items with no matching gap spec carry none.

### Must Fix
1. Make the console forwarder recover from a never-settling `reportLog` call (timeout or settle guard) so forwarding cannot stop for the session (finding 2). (specs: `APP-DIAG-CONS-012`)

### Should Fix
2. Keep `ExportBundleButton` reachable when the tail fails (finding 6). (specs: `APP-DIAG-PANEL-010`)
3. Catch, normalize and log `AuditService.list` store failures; normalize the error in `record()` and move the stack-outputs read inside the try (findings 7, 8). (specs: `APP-DIAG-AUDR-004`, `APP-DIAG-SVC-003`, `APP-DIAG-AUDIT-004`)
4. Fix `ErrorBoundary`'s falsy-throw check, correct the "Settings → Logs" copy, and consider a reload action (finding 5). (specs: `APP-DIAG-RERR-006`, `APP-DIAG-RERR-007`)
5. Add an install guard and `isErrorLike` to `installGlobalErrorReporting` (finding 4). (specs: `APP-DIAG-RERR-008`, `APP-DIAG-RERR-009`)
6. Decide whether audit gets its own leaf, and update audit docs and page copy for IaC actions (finding 9). (specs: `APP-DIAG-AUDUI-008`)

### Nice to Have
7. Drop or rewire the `/audit` polling indicator (finding 10).
8. Route log-dir and app-version lookups through `electronRuntime.ts` (finding 11). (specs: `APP-DIAG-LOG-008`)
9. Refresh stale doc pointers (finding 12); scrub per-game snapshot messages (finding 13). (specs: `APP-DIAG-BNDL-013`)
10. Move the diagnostics tail onto the polling registry, export shared constants, and tidy tests (findings 14, 15).
