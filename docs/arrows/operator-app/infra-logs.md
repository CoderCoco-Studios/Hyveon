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
- `app/packages/web/src/components/live-badge.component.test.tsx`
- `app/packages/web/src/components/log-line-display.component.test.tsx`
- `app/packages/web/src/components/log-tail-view.component.test.tsx`
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
- `app/packages/web/src/hooks/use-media-query.hook.ts`
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

| Category | Spec IDs | Implemented | Deferred | Gaps |
|---|---|---|---|---|
| Log group resolution | `APP-LOGS-GROUP-001` to `APP-LOGS-GROUP-007` | 7 | 0 | 0 |
| Recent snapshot | `APP-LOGS-SNAP-001` to `APP-LOGS-SNAP-006` | 6 | 0 | 0 |
| Historical paging | `APP-LOGS-PAGE-001` to `APP-LOGS-PAGE-008` | 8 | 0 | 0 |
| Live tail | `APP-LOGS-TAIL-001` to `APP-LOGS-TAIL-012` | 12 | 0 | 0 |
| IPC surface | `APP-LOGS-IPC-001` to `APP-LOGS-IPC-008` | 8 | 0 | 0 |
| Renderer tail engine | `APP-LOGS-ENGINE-001` to `APP-LOGS-ENGINE-019` | 19 | 0 | 0 |
| Log pages and view | `APP-LOGS-UI-001` to `APP-LOGS-UI-009` | 9 | 0 | 0 |
| Line rendering | `APP-LOGS-RENDER-001` to `APP-LOGS-RENDER-003` | 3 | 0 | 0 |
| Sidebar navigation | `APP-LOGS-NAV-001` to `APP-LOGS-NAV-003` | 3 | 0 | 0 |

**Summary:** 75 of 75 active specs implemented; 0 deferred; 0 gaps.

## Key Findings

1. **Two live-tail loops remain separate**: `streamLambdaLogs` and `AwsCloudProvider.streamWorkloadLogs` share the lookback start time, abort-aware SDK call and sleep (`sleepInterruptible` in `@hyveon/shared`), and poll-error logging, but still differ in `limit: 100` and cursor advance (`ts + 1` vs `max(ts)`) and dedupe-key separator (`-` vs `:`), and de-duplication pruning (the Lambda tail prunes ids behind its start time, the game tail does not).
2. **"Five vs six Lambdas" wording**: code says 5 log-tailable functions (`lambdaFunctionKey.ts:2`, `LogsService.ts:585`, `logs.controller.ts:220`, `infrastructure-logs.page.tsx:39,58`) and that is correct: six Lambda packages exist (`app/packages/lambda/*`), `efs-seeder` is per-game (`infra/src/lambdas.ts:723`). The stale claims are in docs/CI that say five *packages*: `docs/docs/components/management-app.md:14`, `.github/workflows/lint.yml:51` (inventory cited `:49`). `docs/docs/app/index.md:111` ("5 Lambda functions") is accurate for the log page.
3. **Recent snapshot reads only the single newest stream**: `getRecentFromLogGroup` uses `DescribeLogStreams limit: 1` (`LogsService.ts:304-315`), matching APP-LOGS-SNAP-001. For `https` games the Caddy sidecar writes to the same `/ecs/{game}-server` group under a `caddy` prefix (IAC-PROGRAM-ECS-007), so the snapshot may show only Caddy lines while the live tail interleaves both `[inferred]`.
4. **Two "no streams" messages, only one recognised**: `getRecentFromLogGroup` throws `No log streams found for {label}.` (`:313`), which `withLogGroup` matches verbatim (`:256`); `fetchAcrossStreams` throws `No log streams found in {logGroup}.` (`:475`), which is not matched (only relevant on the `'paging'` path, where it is rethrown anyway).
5. **Stale and history-narrating comments in `LogsService`**: `:518` cites a nonexistent `fetchRange`; `:41` ("the bug this replaced"), `:218-219,232-233` ("pre-extraction call sites"), `:298-299` ("pre-dedup"), `:478` ("Bug 1") narrate history; the class TSDoc (`:150-154`) and controller TSDoc (`logs.controller.ts:10-14`) still describe only `/ecs/{game}-server`.
6. **Duplicated relative-time formatter**: `formatAge` (`use-log-tail.hook.ts:137-145`) vs `polling-indicator.component.tsx:96-102` `[unverified rounding difference]`; `use-iac-run.hook.ts` `CHUNK_WINDOW_SIZE` mirrors `WINDOW_SIZE` `[unverified]`.
7. **Undeclared design token**: `shadow-[var(--shadow-md)]` (`jump-to-latest-button.component.tsx:26`); `--shadow-md` is not declared in `web/src/index.css`.
8. **Sweep disagreement resolved against the sweep**: the inventory calls the `GameStatusProvider` comment in `infrastructure-logs.page.test.tsx:9-11` wrong; `renderPage` does wrap in `GameStatusProvider` (`web/src/test-utils/render-page.utils.tsx:35`), so the comment is accurate. Also, `LogsPage` uses `window.hyveon.logs` directly (`logs.page.tsx:47`) while loading games through `api.service` (`:54`), one instance of the two-facade split owned by `ipc-bridge`.

## Work Required

Items carry the spec IDs they relate to, where one exists.

### Should Fix
1. Decide whether the game-log snapshot should read across streams (Caddy sidecar) and record the decision in the EARS.
2. Fix stale docs/CI wording: `management-app.md:14`, `lint.yml:51` ("five Lambda packages").

### Nice to Have
3. Remove history-narrating and stale comments in `LogsService.ts` and the controller/class TSDoc.
4. Declare `--shadow-md` or use an existing token.
5. Share one relative-time formatter with `polling-indicator`.
