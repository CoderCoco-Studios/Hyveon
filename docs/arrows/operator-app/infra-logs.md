# Arrow: infra-logs

Read a game's or a Lambda's CloudWatch logs inside the app: live tail, pause, page back in history.

## Status

**MAPPED** — mapped 2026-10-30 (git SHA `5c55a380`), not yet audited.
Both log pages (`/logs` for game servers, `/logs/infrastructure` for Lambdas) share one tail hook and one view shell; the backend is one `LogsService` with a game and a Lambda variant of every method, and the Lambda live tail diverges from the game live tail in ways that look like bugs.

## References

### HLD
- `docs/high-level-design.md`
- `docs/intent/operator-app/operator-app-design.md` (sub-HLD)

### LLD
- `docs/intent/operator-app/infra-logs/infra-logs-design.md`

### EARS
- `docs/intent/operator-app/infra-logs/infra-logs-specs.md` (72 specs)

### Tests
- `app/packages/desktop-main/src/controllers/logs.controller.test.ts`
- `app/packages/desktop-main/src/services/LogsService.test.ts`
- `app/packages/web/e2e/specs/infrastructure-logs.spec.ts`
- `app/packages/web/e2e/specs/logs.spec.ts`
- `app/packages/web/src/components/game-combobox.component.test.tsx`
- `app/packages/web/src/components/jump-to-latest-button.component.test.tsx`
- `app/packages/web/src/components/log-line-display.component.test.tsx`
- `app/packages/web/src/hooks/use-log-tail.hook.test.ts`
- `app/packages/web/src/lib/ansi.utils.test.ts`
- `app/packages/web/src/pages/infrastructure-logs.page.test.tsx`
- `app/packages/web/src/pages/logs.page.test.tsx`

### Code

**desktop-main**
- `app/packages/desktop-main/src/services/LogsService.ts`
- `app/packages/desktop-main/src/controllers/logs.controller.ts`

**shared**
- `app/packages/shared/src/lambdaFunctionKey.ts`

**web**
- `app/packages/web/src/pages/logs.page.tsx`
- `app/packages/web/src/pages/infrastructure-logs.page.tsx`
- `app/packages/web/src/hooks/use-log-tail.hook.ts`
- `app/packages/web/src/components/log-tail-view.component.tsx`
- `app/packages/web/src/components/log-line-display.component.tsx`
- `app/packages/web/src/components/live-badge.component.tsx`
- `app/packages/web/src/components/jump-to-latest-button.component.tsx`
- `app/packages/web/src/components/game-combobox.component.tsx`
- `app/packages/web/src/lib/ansi.utils.ts`
- `app/packages/web/e2e/pages/LogsPage.ts` (page object)
- `app/packages/web/e2e/pages/InfrastructureLogsPage.ts` (page object)

### Cited from other leaves
- `app/packages/cloud-aws/src/AwsCloudProvider.ts` (`game-runtime/task-and-dns`): `streamWorkloadLogs` (`:548-589`) is the game live tail that `LogsService.streamLogs` delegates to.
- `app/packages/desktop-main/src/modules/aws.module.ts` (`game-runtime/task-and-dns`): provides `LogsService`.
- `app/packages/desktop-main/src/services/DeploymentConfigService.ts` (`deployment-config`): `getTopLevelSettings().projectName` feeds the Lambda log group name.
- `app/packages/infra/src/logGroups.ts`, `infra/src/lambdas.ts`, `infra/src/ecs.ts` (`iac/program`): declare the `/aws/lambda/{projectName}-{key}` and `/ecs/{game}-server` log groups this leaf reads.
- `app/packages/desktop-main/src/ipc-main-bridge.ts` (`operator-app/ipc-bridge`): `SELF_BRIDGED_PATTERNS` (`:28-29`) excludes `logs.stream` / `logs.lambda.stream` from the generic bridge.
- `app/packages/desktop-preload/src/preload.ts`, `desktop-preload/src/hyveon-api.ts` (`operator-app/ipc-bridge`): `window.hyveon.logs` and `window.hyveon.logs.lambda` stream adapters (`preload.ts:224-254`).
- `app/packages/web/src/components/app-nav.component.tsx` (`operator-app/desktop-shell`): the nested Logs sidebar group (`:48-49`).
- `app/packages/web/src/hooks/use-click-outside.hook.ts` (`operator-app/desktop-shell`): click-away hook consumed by `game-combobox.component.tsx`.
- `app/packages/web/src/app.component.tsx` (`operator-app/desktop-shell`): route `/logs/infrastructure` (`:102`).
- Outbound: `ansi.utils.ts` and `log-line-display.component.tsx` are cited by `iac/run` (`ansi-log-viewer.component.tsx`) and `operator-app/diagnostics` (`DiagnosticsPanel.tsx`).

### OpenSpec sources
- `openspec/specs/infra-log-viewer/spec.md`: synced from archived change `2026-08-14-add-infra-log-viewer`; 5 requirements, 11 scenarios; Purpose still `TBD`.
- `openspec/changes/add-vpc-flow-logs/` (active): not started, 0/22 tasks; proposes new capability `vpc-flow-logs` that extends this leaf's Lambda-log fetch/tail pattern to VPC Flow Logs.

## Architecture

**Purpose:** Let an operator read CloudWatch logs for one game server (`/ecs/{game}-server`) or one of five log-tailable Lambdas (`/aws/lambda/{projectName}-{key}`) without leaving the app, with a 300-line live window, pause buffer, and scroll-driven historical paging.

**Key Components:**
1. `LogsService` (`desktop-main/src/services/LogsService.ts:156`): recent snapshot (`getRecentLogs` `:277`, `getRecentLambdaLogs` `:624`), backward/forward paging across up to 50 streams (`fetchAcrossStreams` `:466`, cap `MAX_STREAMS_SCANNED` `:148`), game live tail delegated to the `CloudProvider` (`streamLogs` `:199`), and its own Lambda live tail (`streamLambdaLogs` `:727`).
2. `withLogGroup` (`LogsService.ts:237`): shared shell for the six get/page methods; `'recent'` folds errors into a synthesized line, `'paging'` rethrows a plain `Error`.
3. `LogsController` (`desktop-main/src/controllers/logs.controller.ts:17`): IPC patterns `logs.get|getOlder|getNewer|stream` and `logs.lambda.get|getOlder|getNewer|stream`; `openStream` (`:144`) mints a uuid `streamId` and pushes `<prefix><id>.chunk|end` over `WebContents.send`, aborting on `.cancel`.
4. `LambdaFunctionKey` / `LAMBDA_FUNCTION_KEYS` (`shared/src/lambdaFunctionKey.ts:8,20`): the five addressable Lambda suffixes; `efs-seeder` excluded as per-game.
5. `useLogTail` (`web/src/hooks/use-log-tail.hook.ts:173`): snapshot-then-stream engine with `WINDOW_SIZE = 300` (`:16`), live/historical mode, pause buffer, `loadOlder` (`:385`), `loadNewer` with a derived forward cursor (`:447-498`), `jumpToLatest` (`:546`), generation counter guarding stale responses (`:256`).
6. `LogTailView` (`web/src/components/log-tail-view.component.tsx`): shared header, controls, log list and footer shell for both pages.
7. `LogsPage` (`web/src/pages/logs.page.tsx:34`): game picker (`GameCombobox`), preselects the game from `GameCard` navigation state (`:41,59-61`).
8. `InfrastructureLogsPage` (`web/src/pages/infrastructure-logs.page.tsx:42`): five-button Lambda picker, adapts `window.hyveon.logs.lambda` to the generic `LogTailApi` (`toLogTailApi` `:19`).
9. `LogLineList` / `HighlightedLine` (`web/src/components/log-line-display.component.tsx`) and `parseAnsiLine` / `stripAnsi` (`web/src/lib/ansi.utils.ts:78,147`): ANSI-coloured rendering with search highlight, reused by two other leaves.
10. `LiveBadge`, `JumpToLatestButton`, `GameCombobox` + `useClickOutside`: small view parts used only by the log pages.

## Spec Coverage

| OpenSpec capability | requirements | scenarios | notes |
|---|---|---|---|
| `infra-log-viewer` | 5 | 11 | Log group resolution, recent fetch, page and nested nav appear implemented (`LogsService.ts:594-604,624-639`; `infrastructure-logs.page.tsx`; `app-nav.component.tsx:48-49`). Live Lambda tail deviates: first poll has no `startTime`, so it is not "newly-arriving" only (finding 1). Abort exits cleanly but only after the pending `setTimeout` (finding 3). The game log tail, scroll-back paging, pause buffer and jump-to-latest have no OpenSpec requirement at all. |

**OpenSpec summary:** One OpenSpec capability (5 requirements, 11 scenarios) covers only the Lambda half of this leaf.

| Category | Spec IDs | Implemented | Deferred | Gaps |
|---|---|---|---|---|
| Log group resolution | `APP-LOGS-GROUP-001` to `APP-LOGS-GROUP-007` | 6 | 0 | 1 |
| Recent snapshot | `APP-LOGS-SNAP-001` to `APP-LOGS-SNAP-006` | 4 | 0 | 2 |
| Historical paging | `APP-LOGS-PAGE-001` to `APP-LOGS-PAGE-008` | 7 | 0 | 1 |
| Live tail | `APP-LOGS-TAIL-001` to `APP-LOGS-TAIL-011` | 7 | 0 | 4 |
| IPC surface | `APP-LOGS-IPC-001` to `APP-LOGS-IPC-008` | 8 | 0 | 0 |
| Renderer tail engine | `APP-LOGS-ENGINE-001` to `APP-LOGS-ENGINE-017` | 15 | 0 | 2 |
| Log pages and view | `APP-LOGS-UI-001` to `APP-LOGS-UI-009` | 7 | 0 | 2 |
| Line rendering | `APP-LOGS-RENDER-001` to `APP-LOGS-RENDER-003` | 2 | 0 | 1 |
| Sidebar navigation | `APP-LOGS-NAV-001` to `APP-LOGS-NAV-003` | 3 | 0 | 0 |

**Summary:** 59 of 72 active specs implemented; 0 deferred; 13 gaps.

## Key Findings

1. **Lambda live tail replays the whole log group on its first poll**: `streamLambdaLogs` starts with `startTime` undefined (`LogsService.ts:735`) and drains every `nextToken` page (`:739-754`), so the first poll returns all retained events, re-yielding the snapshot `useLogTail` already rendered (`use-log-tail.hook.ts:340-344`). The game tail starts at `Date.now()` (`AwsCloudProvider.ts:558`). No test pins the first-poll `startTime` for the Lambda tail (`LogsService.test.ts:797` onward). Behavioural impact is inferred from the code, not observed.
2. **Two live-tail loops that drifted apart**: `streamLambdaLogs` (`LogsService.ts:727-768`) re-implements `AwsCloudProvider.streamWorkloadLogs` (`AwsCloudProvider.ts:548-589`) and differs in start time, `limit: 100`, dedupe-key separator (`:` vs `-`), cursor advance (`max(ts)` vs `ts + 1`), abort-aware SDK call, and error logging. The TSDoc justifies the copy via "design.md D1" (`LogsService.ts:710`).
3. **Lambda tail sleep is not abort-aware and poll errors are not logged**: plain `setTimeout` at `LogsService.ts:766` (the game tail uses `sleepInterruptible`, `AwsCloudProvider.ts:40,584`); the generic catch at `:762-763` yields a `[stream error]` line without any `logger` call, contrary to `.claude/rules/logging.md` rule 2. `AwsCloudProvider.ts:36` says it "mirrors `LogsService`'s `sleepInterruptible` helper", which does not exist in `LogsService`.
4. **"Five vs six Lambdas" wording**: code says 5 log-tailable functions (`lambdaFunctionKey.ts:2`, `LogsService.ts:585`, `logs.controller.ts:220`, `infrastructure-logs.page.tsx:39,58`) and that is correct: six Lambda packages exist (`app/packages/lambda/*`), `efs-seeder` is per-game (`infra/src/lambdas.ts:723`). The stale claims are in docs/CI that say five *packages*: `docs/docs/components/management-app.md:14`, `.github/workflows/lint.yml:51` (inventory cited `:49`). `docs/docs/app/index.md:111` ("5 Lambda functions") is accurate for the log page.
5. **Recent snapshot reads only the single newest stream**: `getRecentFromLogGroup` uses `DescribeLogStreams limit: 1` (`LogsService.ts:304-315`), matching the spec. For `https` games the Caddy sidecar writes to the same `/ecs/{game}-server` group under a `caddy` prefix (`openspec/specs/in-task-tls-termination/spec.md:16`), so the snapshot may show only Caddy lines while the live tail interleaves both `[inferred]`.
6. **`eventId` synthesis differs between snapshot and paging**: `${e.message ?? ''}` at `LogsService.ts:326` vs raw `${e.message}` at `:519`, so a message-less event gets `ts:` in one and `ts:undefined` in the other, breaking `excludeEventIds` matching for that edge case.
7. **Two "no streams" messages, only one recognised**: `getRecentFromLogGroup` throws `No log streams found for {label}.` (`:313`), which `withLogGroup` matches verbatim (`:256`); `fetchAcrossStreams` throws `No log streams found in {logGroup}.` (`:475`), which is not matched (only relevant on the `'paging'` path, where it is rethrown anyway).
8. **Stale and history-narrating comments in `LogsService`**: `:518` cites a nonexistent `fetchRange`; `:41` ("the bug this replaced"), `:218-219,232-233` ("pre-extraction call sites"), `:298-299` ("pre-dedup"), `:478` ("Bug 1") narrate history; the class TSDoc (`:150-154`) and controller TSDoc (`logs.controller.ts:10-14`) still describe only `/ecs/{game}-server`.
9. **Controller duplicates and double-logs paging errors**: four identical try/catch blocks (`logs.controller.ts:88-95,112-119,248-255,272-279`) each log `logger.error` after `LogsService` already logged the same failure at `warn` (`LogsService.ts:260,359,397`); `logs.get` / `logs.lambda.get` have no catch because the service never throws there.
10. **Live-tailed lines carry no timestamp**: `appendLine` stores only `{ text, receivedAt }` (`use-log-tail.hook.ts:259`); the footer's "oldest {age}" (`log-tail-view.component.tsx:209`) is computed from `receivedAt` (`use-log-tail.hook.ts:367`), i.e. time since fetch, not log age `[inferred UX impact]`. The forward cursor falls back to `liveInterruptedAtRef` for exactly this reason (`:458`).
11. **Duplicated relative-time formatter**: `formatAge` (`use-log-tail.hook.ts:137-145`) vs `polling-indicator.component.tsx:96-102` `[unverified rounding difference]`; `use-iac-run.hook.ts` `CHUNK_WINDOW_SIZE` mirrors `WINDOW_SIZE` `[unverified]`.
12. **Index keys on a prepend-heavy list**: `LogLineList` keys rows by array index (`log-line-display.component.tsx:116`) while `loadOlder` prepends (`use-log-tail.hook.ts:412-415`), forcing every row to re-render on backfill.
13. **Undeclared design token**: `shadow-[var(--shadow-md)]` (`jump-to-latest-button.component.tsx:26`); `--shadow-md` is not declared in `web/src/index.css`.
14. **Two search inputs in the DOM on mobile**: with `mobileFilters`, the desktop `SearchInput` stays mounted inside `hidden md:contents` while the drawer mounts a second one (`log-tail-view.component.tsx:150-166`).
15. **Sweep disagreement resolved against the sweep**: the inventory calls the `GameStatusProvider` comment in `infrastructure-logs.page.test.tsx:9-11` wrong; `renderPage` does wrap in `GameStatusProvider` (`web/src/test-utils/render-page.utils.tsx:35`), so the comment is accurate. Also, `LogsPage` uses `window.hyveon.logs` directly (`logs.page.tsx:47`) while loading games through `api.service` (`:54`), one instance of the two-facade split owned by `ipc-bridge`.

## Work Required

Spec IDs cite the open (`[ ]`) gap specs in `docs/intent/operator-app/infra-logs/infra-logs-specs.md`; items with no matching gap spec carry none.

### Must Fix
1. Seed `streamLambdaLogs`'s first `startTime` (e.g. now, or the snapshot's newest timestamp) so the tail does not replay history and duplicate the snapshot, and add a test for it (specs: `APP-LOGS-TAIL-005`).

### Should Fix
2. Collapse the two live-tail loops into one shared implementation, or at least make the Lambda loop abort-aware and log poll errors per the logging rule (specs: `APP-LOGS-TAIL-007`, `APP-LOGS-TAIL-009`).
3. Unify `eventId` synthesis (`LogsService.ts:326` vs `:519`). (specs: `APP-LOGS-SNAP-006`)
4. Extract the four identical controller catch blocks and stop double-logging paging failures. (specs: `APP-LOGS-PAGE-008`)
5. Decide whether the game-log snapshot should read across streams (Caddy sidecar) and record the decision in the spec.
6. Write OpenSpec/EARS coverage for the game log tail, paging, pause and jump-to-latest, which currently have none; fill the `infra-log-viewer` Purpose.
7. Fix stale docs/CI wording: `management-app.md:14`, `lint.yml:51` ("five Lambda packages").

### Nice to Have
8. Remove history-narrating and stale comments in `LogsService.ts` and the controller/class TSDoc.
9. Stable keys in `LogLineList`; declare `--shadow-md` or use an existing token; render one search input on mobile. (specs: `APP-LOGS-RENDER-003`, `APP-LOGS-UI-009`)
10. Share one relative-time formatter with `polling-indicator`; label the footer age honestly or carry timestamps on live lines. (specs: `APP-LOGS-ENGINE-017`, `APP-LOGS-TAIL-011`)
