---
parent: operator-app
prefix: APP-LOGS
---

# CloudWatch Log Viewer

## Context and Design Philosophy

Hyveon writes every game server's output to `/ecs/{game}-server` and every fixed Lambda's output to `/aws/lambda/{projectName}-{functionKey}`, both with a seven-day retention declared by the infra program (`app/packages/infra/src/logGroups.ts:4,38`).
Without this leaf, an operator reading those logs would have to leave the app for the AWS Console; the archived design names that gap as the reason the Lambda half exists (`openspec/changes/archive/2026-08-14-add-infra-log-viewer/design.md`, Context).
This leaf lets the operator read either kind of log group inside the app: a recent snapshot, a 2-second live tail, a pause buffer, and scroll-driven paging back through retention and forward again.

The leaf owns:

- **The backend reader**: `LogsService` (`app/packages/desktop-main/src/services/LogsService.ts:156`), which talks to CloudWatch Logs directly for snapshots, paging and the Lambda tail, and delegates only the game tail to the `CloudProvider` (`LogsService.ts:199-208`).
- **The IPC surface**: `LogsController` with eight `@MessagePattern` handlers and the per-stream side-channel pump (`app/packages/desktop-main/src/controllers/logs.controller.ts:61,82,106,144,203,225,242,265,289`).
- **The addressable Lambda set**: `LambdaFunctionKey` / `LAMBDA_FUNCTION_KEYS` (`app/packages/shared/src/lambdaFunctionKey.ts:8,20`).
- **The renderer tail engine and its two pages**: `useLogTail` (`app/packages/web/src/hooks/use-log-tail.hook.ts:173`), the `LogTailView` shell (`web/src/components/log-tail-view.component.tsx:97`), `LogsPage` at `/logs` (`web/src/pages/logs.page.tsx:34`) and `InfrastructureLogsPage` at `/logs/infrastructure` (`web/src/pages/infrastructure-logs.page.tsx:42`).
- **Line rendering**: `LogLineList` / `HighlightedLine` (`web/src/components/log-line-display.component.tsx:52,99`) and the ANSI SGR parser (`web/src/lib/ansi.utils.ts:78,147`), which `iac/run` and `operator-app/diagnostics` also consume.

What it deliberately does not own:

- The game live-tail poll loop itself: `AwsCloudProvider.streamWorkloadLogs` (`app/packages/cloud-aws/src/AwsCloudProvider.ts:548-589`) belongs to `game-runtime/task-and-dns`.
- The log groups: declared by `iac/program` (`infra/src/logGroups.ts`, `infra/src/lambdas.ts`, `infra/src/ecs.ts`). This leaf only reads them and never creates, deletes or changes retention.
- `projectName`: read from `DeploymentConfigService.getTopLevelSettings()` (`LogsService.ts:597`), owned by `deployment-config`.
- The `window.hyveon.logs` bridge, `createBufferedStream`, and `SELF_BRIDGED_PATTERNS` (`app/packages/desktop-preload/src/preload.ts:229-260,451-469`; `desktop-main/src/ipc-main-bridge.ts:28-29`), owned by `operator-app/ipc-bridge`.
- The sidebar `Logs` group and the `/logs/infrastructure` route (`web/src/components/app-nav.component.tsx:48-49`, `web/src/app.component.tsx:102`), owned by `operator-app/desktop-shell`.
- The app's own winston log and the Settings diagnostics tail, owned by `operator-app/diagnostics`.

CLAUDE.md invariants that live here:

- **The desktop app has no HTTP transport.** Streams are pushed over `WebContents.send` side channels, not a socket or SSE endpoint (`logs.controller.ts:167-174`).
- **Secrets never reach the renderer.** Handlers log only `game` / `functionKey` identifiers on entry (`logs.controller.ts:66,87,111,208,230,247,271,294`), per `.claude/rules/logging.md` rule 1.
- **`@hyveon/shared`'s barrel stays free of new AWS SDK imports.** `lambdaFunctionKey.ts` is a pure type and array; all CloudWatch SDK use stays in `desktop-main` and `cloud-aws`.

## Log Sources and Group Resolution

| Source | Log group | Resolver | Group missing (`ResourceNotFoundException`) |
|---|---|---|---|
| Game server | `/ecs/{game}-server` | inline string (`LogsService.ts:279,354,392`; `AwsCloudProvider.ts:557`) | No `notFound` hook: snapshot folds it into `Error fetching logs for {game}: …`; paging rethrows (`LogsService.ts:259-262`) |
| Lambda | `/aws/lambda/{projectName}-{functionKey}` | `resolveLambdaLogGroup` (`LogsService.ts:594-604`) | Snapshot returns one `No log group for {key} yet …` line (`:633-636`); paging throws the same text (`:661-664,697-700`); tail yields it once and ends (`:757-760`) |

`resolveLambdaLogGroup` falls back to `DEPLOYMENT_CONFIG_DEFAULTS.projectName` both when the setting is unset and when the read itself fails, logging a `warn` in the second case (`LogsService.ts:595-602`).
This satisfies the `infra-log-viewer` "Lambda log group resolution" requirement, but a failed config read silently points the viewer at the `hyveon-*` groups of what may be a differently named deployment.

`LambdaFunctionKey` covers five of the six Lambda packages; `efs-seeder` is excluded because it is per-game, not a single addressable function (`lambdaFunctionKey.ts:1-7`).
The union and `LAMBDA_FUNCTION_KEYS` are written out separately (`lambdaFunctionKey.ts:8-13,20-26`); the comment claims they "can never drift", but nothing derives one from the other, so adding a key to the union without the array would compile `[inferred]`.

The `add-vpc-flow-logs` change (active, not started) plans a third family on the same service: a flow-log resolver mirroring `resolveLambdaLogGroup` plus `getRecent/Older/Newer/streamFlowLogs` (`openspec/changes/add-vpc-flow-logs/tasks.md:15-16`).
That would turn today's game/Lambda method pairs into triplets.

## IPC Contract and Stream Lifecycle

| Channel | Payload | Returns | Error behaviour |
|---|---|---|---|
| `logs.get` | `{ game, limit = 50 }` | `{ game } & RecentLogsPage` (`logs.controller.ts:61-69`) | Never throws; failures arrive as a synthetic line |
| `logs.getOlder` | `{ game, beforeTimestamp, limit }` | `OlderLogsPage` `{ lines, atOldest }` | Service rethrows; controller logs `error` and rethrows (`:88-95`) |
| `logs.getNewer` | `{ game, afterTimestamp, limit, excludeEventIds }` | `NewerLogsPage` `{ lines, hasMore }` | Same as above (`:112-119`) |
| `logs.stream` | `game` | `{ streamId }`, then `logs.stream.<id>.chunk` / `.end` | Generator throw logged and sent as `.end { error }` (`:179-188`) |
| `logs.lambda.get` | `{ functionKey, limit = 50 }` | `RecentLogsPage` | Never throws |
| `logs.lambda.getOlder` / `getNewer` | as the game variants, keyed by `functionKey` | `OlderLogsPage` / `NewerLogsPage` | `:248-255,272-279` |
| `logs.lambda.stream` | `functionKey` | `{ streamId }`, then `logs.lambda.stream.<id>.*` | Same as `logs.stream` |

Every line from a snapshot or paging call is a `LogEventLine` `{ message, timestamp, eventId }` (`LogsService.ts:34-56`).
`GetLogEvents` returns no `eventId`, so one is synthesized as `${timestamp}:${message}` (`LogsService.ts:515-519`).
The snapshot path writes `${e.message ?? ''}` (`:326`) while the paging path writes raw `${e.message}` (`:519`), so a message-less event gets two different ids depending on which call delivered it.

The two streaming channels bypass the generic bridge because the handler must mint an id and push follow-up messages (`logs.controller.ts:20-27`).
`onModuleInit` registers both with `ipcMain.handle` only when `process.versions.electron` is set (`:35-51`).
`openStream` (`:144-197`) mints a `randomUUID` stream id, registers a one-shot `.cancel` listener that aborts its own `AbortController`, then fire-and-forgets a loop that forwards each yielded string as a `.chunk`, sends `.end {}` on normal completion or `AbortError`, sends `.end { error }` otherwise, and removes the cancel listener in `finally`.
It aborts and stops forwarding if the `WebContents` is destroyed mid-stream (`:173`).

Live chunks are bare strings.
The preload declares `LogChunk = string` (`desktop-preload/src/hyveon-api.ts:157`) while `@hyveon/shared` declares a different `LogChunk { message, timestamp }` (`shared/src/cloud.ts:26`); `LogsService.streamLogs` drops the timestamp when it unwraps the provider's chunks (`LogsService.ts:205-206`).
So live-tailed lines reach the renderer with no CloudWatch timestamp or event id, which shapes several renderer behaviours below.

## Backend Fetch Model

### Snapshot

`getRecentFromLogGroup` reads only the single most recently written stream (`DescribeLogStreams` ordered by `LastEventTime`, `limit: 1`) and returns its last `limit` events oldest-first (`LogsService.ts:303-328`).
That matches the spec's "most recently written CloudWatch log stream" wording for Lambdas (`openspec/specs/infra-log-viewer/spec.md`, "Recent Lambda logs fetch").
For a game with an `https` Caddy sidecar, the sidecar logs into the same `/ecs/{game}-server` group under its own prefix (`openspec/specs/in-task-tls-termination/spec.md:16`), so the snapshot may show only one container's lines while the live tail, which filters the whole group, interleaves both `[inferred]`.

### Failure contracts via `withLogGroup`

All six get/page methods run through `withLogGroup` (`LogsService.ts:237-264`), which takes a `kind`:

- `'recent'`: the exact `No log streams found for {label}.` error is returned verbatim as a synthetic line (`:256-257`); any other failure is logged by the per-method hook (`logger.error`, `:284,631`) and folded into `Error fetching logs for {label}: {String(err)}` (`:262`). This is the spec's "return a single message … rather than propagating a raw SDK error" contract.
- `'paging'`: any failure is normalized with `errMessage`, logged at `warn` (`:359,397,660,696`), and rethrown as a plain `Error` (`:261`).
- `notFound`, passed only by the three Lambda methods, intercepts `ResourceNotFoundException` ahead of both branches.

Synthetic lines carry `Date.now()` as their timestamp (`LogsService.ts:133-136`), so the renderer will later use a fabricated time as a paging boundary if the snapshot was a synthetic message.

### Paging across streams

`fetchAcrossStreams` (`LogsService.ts:466-546`) lists up to `MAX_STREAMS_SCANNED = 50` streams newest-first (`:148,558-582`), then calls `GetLogEvents` stream by stream until `limit` events are accumulated, sorts by timestamp, and trims to the `limit` closest to the boundary.
The TSDoc gives the reasoning (`:407-441`): `'older'` walks newest-to-oldest; `'newer'` walks oldest-to-newest because the events just after a forward boundary often sit in an older, rotated stream.
`excludeEventIds` is consumed as an occurrence-counted multiset so two genuinely distinct cross-stream events sharing one synthesized id are not both dropped (`:430-440,479-482,520-526`), and the per-stream `limit` over-fetches by the excluded count (`:504-507`).
`atOldest` is true only when the trimmed page is empty and stream listing was exhausted below the cap (`:539`), so a group with more than 50 streams never reports the beginning of retention.
`hasMore` is simply "the page filled `limit`" (`:532,544`).

### Two live tails

| Aspect | Game (`AwsCloudProvider.streamWorkloadLogs`) | Lambda (`LogsService.streamLambdaLogs`) |
|---|---|---|
| First `startTime` | `Date.now()` (`AwsCloudProvider.ts:558`) | `undefined`, i.e. whole retained group (`LogsService.ts:735`) |
| Page size / paging | `limit: 100`, one call per poll (`:564`) | no limit, drains every `nextToken` (`:739-754`) |
| Cursor advance | `ts + 1` (`:573-575`) | `max(ts)` (`:747-749`) |
| Dedupe key fallback | `` `${ts}-${msg}` `` (`:568`) | `` `${ts}:${msg}` `` (`:744`) |
| Abort | SDK `abortSignal` and `sleepInterruptible` (`:565,583-588`) | checked between events and polls; plain `setTimeout` sleep (`:750,765-766`) |
| Poll error | `logger.error` then `[stream error] …` line (`:579-580`) | `[stream error] …` line, no log call (`:762-763`) |
| Infra not deployed | throws `WorkloadGuardError` before polling (`:554`) | n/a |

The Lambda tail's TSDoc says it copies the game loop's shape and cites "design.md D1" for not sharing it (`LogsService.ts:705-713`); D1 in the archived design argues only that Lambda naming should not enter the cloud-agnostic `CloudProvider` interface, not that the loops must differ.
Because the first Lambda poll has no `startTime`, it yields every retained event, re-delivering the snapshot the renderer already rendered (`use-log-tail.hook.ts:340-344`); that departs from the spec's "stream newly-arriving log lines" wording.
Both `seen` sets grow without bound for the life of a stream (`LogsService.ts:734`; `AwsCloudProvider.ts:559`) `[inferred]`.
`AwsCloudProvider.ts:36` says its `sleepInterruptible` mirrors one in `LogsService`, which has none.

## Renderer Tail Engine

`useLogTail(target, api)` is a page-agnostic state machine over the `LogTailApi` shape `{ get, stream, getOlder, getNewer }` (`use-log-tail.hook.ts:49-62`).
`LogsPage` passes `window.hyveon.logs` directly (`logs.page.tsx:47`); `InfrastructureLogsPage` adapts `window.hyveon.logs.lambda` with `toLogTailApi` (`infrastructure-logs.page.tsx:19-32,45-48`).
Both fall back to `NO_HYVEON_LOG_TAIL_API` when the bridge is absent (`use-log-tail.hook.ts:77-82`).

### Modes and window

| State | Entered by | Live chunks go to | Leaves by |
|---|---|---|---|
| live | target change, `jumpToLatest` | `lines`, trimmed to the newest 300 (`:269-272`) | pause, or scroll near the top |
| paused (live) | Pause button (`:578-581`) | `bufferRef`, capped at 300, oldest dropped (`:261-266`) | Resume flushes the buffer into `lines` (`:586-594`) |
| historical | first `loadOlder` (`:391-402`) | `bufferRef`, same cap | only `jumpToLatest`, which discards the buffer and re-fetches the snapshot (`:547-576`) |

`WINDOW_SIZE = 300` bounds the loaded window in both directions (`:7-16`): live appends evict from the top, `loadOlder` prepends and evicts from the bottom (`:413-416`), `loadNewer` appends and evicts from the top (`:485-488`).
Scroll handling pins autoscroll within 24 px of the bottom, triggers `loadOlder` within 50 px of the top, and triggers `loadNewer` near the bottom while historical (`:19-21,514-534`).

On target change the hook clears all state, bumps `windowGenerationRef`, fetches the snapshot, then opens the stream; a snapshot failure shows `Could not load initial logs; trying live stream.` and opens the stream anyway (`:322-358`).
`windowGenerationRef` lets late `loadOlder` / `loadNewer` / `jumpToLatest` responses be dropped after a target switch or jump (`:249-257,406,482,565`).
The stream loop itself is not generation-checked: a stream ended with an error surfaces `Stream ended with error: …` only if it is still the current handle (`:290-300`), and nothing reopens an ended stream.

### Paging cursors

Backward paging uses the oldest loaded line's `timestamp`, else `oldestTimestampRef`, else `Date.now()` (`:403`).
Forward paging uses `deriveForwardCursor` (`:448-460`): the newest loaded line's timestamp plus the event ids of every loaded line sharing it, or, when the newest line is a timestamp-less live line, the moment historical mode was entered (`liveInterruptedAtRef`, `:248,401,459`).
Live lines carry only `receivedAt` (`:259-260`), which is why that fallback exists, and why the footer's `oldest {age}` (`:367-368`, `log-tail-view.component.tsx:209`) measures time since the line was received, not log age.
`NewerLogsPage.hasMore` is not read by the hook: `hasNewer` is `mode === 'historical'` (`use-log-tail.hook.ts:612`), so `Jump to latest` stays visible even after forward paging has caught up.
`jumpingToLatest` is returned (`:614`) but no view consumes it.

### View shell and rendering

`LogTailView` renders the header with `PollingIndicator` and `LiveBadge`, the page's picker slot, search, autoscroll toggle, pause button, error banner, `Loading older logs…` and `— Beginning of log retention —` markers, the list, `JumpToLatestButton`, and a footer with line count and pause-buffer count (`log-tail-view.component.tsx:133-216`).
`LiveBadge` reflects only `paused` (`live-badge.component.tsx:19-36`), so historical mode still shows "Live"; the footer's `buffered N` shows only when paused (`log-tail-view.component.tsx:212`), although historical mode buffers too.
With `mobileFilters` (game page only), a second search input and autoscroll toggle mount in a drawer while the desktop pair stays mounted under `hidden md:contents` (`:144-166`).
Search highlights matches with `<mark>` across ANSI segment boundaries and never filters lines (`log-line-display.component.tsx:18-31,52-90`); the placeholder says "Search visible buffer…" (`log-tail-view.component.tsx:60`).
ANSI parsing is per line, so colour state does not carry from one line to the next (`ansi.utils.ts:78`).
Rows are keyed by index (`log-line-display.component.tsx:116`) on a list that `loadOlder` prepends to.

The game page loads game names via `api.games()` (`logs.page.tsx:54`) and preselects a game passed in router state from a game card, falling back to the first game (`:41,59-61`).
The Lambda page defaults to `watchdog` and renders `LAMBDA_FUNCTION_KEYS` as `aria-pressed` buttons (`infrastructure-logs.page.tsx:43,60-70`).

## Decisions & Alternatives

| Decision | Chosen | Alternatives Considered | Rationale |
|---|---|---|---|
| Where Lambda log access lives | Methods on `LogsService`, building the group name inline | A `streamLambdaLogs` on the `CloudProvider` interface | Lambda log naming is AWS-specific and should not leak into the cloud-agnostic interface (archived `add-infra-log-viewer` design.md D1) |
| How Lambdas are addressed | Fixed `LambdaFunctionKey` union of five suffixes | Runtime `ListFunctions` discovery | Set is fixed by the codebase; a union is compile-time checked and needs no extra IAM permission (design.md D2) |
| Sidebar placement | Always-expanded `Logs` group with `Game Logs` / `Infra Logs` children | Top-level `/logs/lambdas` item; a tab inside `/logs`; a section on `/iac` | Groups both log domains without generic collapsible-nav code; labels avoid colliding with `Games` / `Infrastructure` links (design.md D3) |
| Routes | Keep `/logs` for games, add sibling `/logs/infrastructure` | `/logs/games` plus a redirect | Avoids breaking existing links and docs (design.md D4) |
| Lambda live view | 2 s `FilterLogEvents` poll tail | On-demand fetch only | Same interaction model as the game page; watchdog runs often enough that near-live tail is useful (design.md D5) |
| Sharing the tail state machine | One `useLogTail` hook consumed by both pages | Parallel `useInfraLogTail` copy; a full shared presentational panel | User chose extraction to keep one source of truth (design.md D6). The presentational panel D6 rejected now exists as `LogTailView`; why it was later added is not recorded |
| Game live tail | Delegate to `CloudProvider.streamWorkloadLogs`; snapshot and paging call CloudWatch directly | All game reads through `CloudProvider` | Depending on the interface keeps the service swappable (`LogsService.ts:164-169`); why snapshot/paging bypass it is stated only for Lambdas (D1), for games it is `[inferred]` historical |
| Lambda live tail | Separate loop in `LogsService` | Share the provider's loop | TSDoc cites D1 (`LogsService.ts:710`), but D1 justifies the interface boundary, not a second loop; divergence appears unintended `[inferred]` |
| Event identity for paging | Synthesized `${timestamp}:${message}` id, multiset exclusion | `Set` exclusion; per-stream ids | `GetLogEvents` has no `eventId`; a `Set` would drop distinct same-content events across rotated streams (`LogsService.ts:430-440,515-519`) |
| Paging scan bound | Cap of 50 streams per call; `atOldest` only when the scan is exhaustive | Unbounded stream listing | Prevents one page call becoming unbounded CloudWatch requests on groups with years of task restarts (`LogsService.ts:138-147`) |
| Snapshot vs paging failure contract | Snapshot never throws (synthetic line); paging throws a plain `Error` | One contract for both | Snapshot contract is required by `infra-log-viewer` "Recent Lambda logs fetch"; paging throws so the hook can show `Could not load older logs: …` (`use-log-tail.hook.ts:417-420`) `[inferred]` |
| Missing Lambda log group in the tail | Yield one informational line and end the stream | Repeat `[stream error]` every poll | A missing group will not appear while the operator watches; repeating would flood the window (`LogsService.ts:715-721`) |
| Stream transport | uuid-scoped `WebContents.send` side channels with a renderer `.cancel` | Single `invoke` reply | `invoke` returns one value only (`logs.controller.ts:167-169`) |
| Viewport bound | 300-line window, 300-line buffer dropping oldest | Unbounded list; virtualized list | Bound keeps rendering cheap and eviction directional per mode (`use-log-tail.hook.ts:7-15`); the specific number is `[inferred]` |
| Search | Highlight-only over the loaded window | Filter lines; server-side `filterPattern` | `[inferred]`: keeps context around matches; server-side search was a non-goal (design.md Non-Goals) |

## Open Questions & Future Decisions

### Resolved

1. ✅ Lambda logs go through `LogsService`, not `CloudProvider` (design.md D1).
2. ✅ Lambdas are a fixed five-key union, `efs-seeder` excluded (design.md D2, `lambdaFunctionKey.ts:1-7`).
3. ✅ Both pages share one tail hook (design.md D6).
4. ✅ The log-level filter is gone; archived change `2026-08-21-remove-log-level-filter` removed it after D6 listed it as part of the shared state machine.

### Deferred

1. Should `streamLambdaLogs` seed its first `startTime` (now, or the snapshot's newest timestamp) so it stops replaying the whole group and duplicating the snapshot (`LogsService.ts:735`; `use-log-tail.hook.ts:340-344`)? No test pins the first-poll `startTime` (`LogsService.test.ts:797` onward).
2. Should the two live-tail loops collapse into one implementation (`LogsService.ts:727-768` vs `AwsCloudProvider.ts:548-589`), and if not, should the Lambda loop at least use an abort-aware sleep and SDK call (`:766`) and log poll errors per `.claude/rules/logging.md` rule 2 (`:762-763`)?
3. Should `eventId` synthesis be one helper so the snapshot (`:326`) and paging (`:519`) agree for message-less events?
4. Should the four identical controller catch blocks be extracted, and should the controller stop re-logging at `error` what the service already logged at `warn` (`logs.controller.ts:88-95,112-119,248-255,272-279`; `LogsService.ts:359,397,660,696`)?
5. Should the game snapshot read across streams (or across containers) so `https` games with a Caddy sidecar show both containers (`LogsService.ts:304-315`)? Record the decision in a spec either way.
6. Should the game log group get a `notFound` hook like the Lambda family, instead of surfacing a raw `ResourceNotFoundException` string (`LogsService.ts:277-288`)?
7. `fetchAcrossStreams` throws `No log streams found in {logGroup}.` (`:475`), a different text from the one `withLogGroup` recognizes (`:256,313`). Harmless today on the paging path; should both use one message?
8. Should live chunks carry the CloudWatch timestamp and event id end to end (`LogsService.ts:205-206`, `hyveon-api.ts:157`), which would remove the `liveInterruptedAtRef` fallback (`use-log-tail.hook.ts:458`) and make the footer age real log age? Two unrelated types both named `LogChunk` (`shared/src/cloud.ts:26`, `hyveon-api.ts:157`) complicate this.
9. Should `hasNewer` honour `NewerLogsPage.hasMore` (`use-log-tail.hook.ts:612`), and should historical mode auto-return to live once forward paging catches up? Today only `jumpToLatest` leaves it.
10. Should `LiveBadge` and the footer buffer count reflect historical mode (`live-badge.component.tsx:19`, `log-tail-view.component.tsx:212`)?
11. Is `jumpingToLatest` meant to drive a loading state in the view (`use-log-tail.hook.ts:613`)? It has no consumer.
12. Should an ended or errored stream be reopened automatically (`use-log-tail.hook.ts:289-299`)?
13. Should the `seen` dedupe sets in both tails be bounded (`LogsService.ts:734`, `AwsCloudProvider.ts:559`)?
14. When the project-name read fails, should the Lambda viewer show an error instead of silently reading `hyveon-*` groups (`LogsService.ts:599-602`)?
15. Should `LAMBDA_FUNCTION_KEYS` derive the union (or vice versa) so the "can never drift" comment is enforced (`lambdaFunctionKey.ts:15-26`)?
16. Before `add-vpc-flow-logs` adds a third resolution family, should the game/Lambda method pairs collapse into one resolver-parameterized set (`LogsService.ts:277,352,385,624,653,684`; `openspec/changes/add-vpc-flow-logs/tasks.md:15-16`)?
17. Stale and history-narrating comments: `fetchRange` (`LogsService.ts:518`), "Bug 1" (`:478`), "pre-extraction call sites" (`:218-219,232-233`), the class TSDoc and controller TSDoc that describe only `/ecs/{game}-server` (`:150-154`; `logs.controller.ts:11-15`), and `AwsCloudProvider.ts:36`.
18. Rendering debt: index keys on a prepend-heavy list (`log-line-display.component.tsx:116`); undeclared `--shadow-md` (`jump-to-latest-button.component.tsx:26`); duplicate mounted search inputs on mobile (`log-tail-view.component.tsx:150-166`); `formatAge` duplicated by `formatAgo` in `polling-indicator.component.tsx:96-102`, which rounds where `formatAge` floors (`use-log-tail.hook.ts:137-145`).
19. Docs and CI say five Lambda *packages* where six exist (`docs/docs/components/management-app.md:14`, `.github/workflows/lint.yml:51`); the five-function wording in code and `docs/docs/app/index.md:111` is correct.
20. The game log tail, scroll-back paging, pause buffer and jump-to-latest have no OpenSpec requirement, and `infra-log-viewer`'s Purpose is still `TBD`. EARS coverage under `APP-LOGS` should close that gap.
21. Sweep disagreement, resolved against the inventory: the `GameStatusProvider` comment in `infrastructure-logs.page.test.tsx:9-11` is accurate because `renderPage` wraps in it (`web/src/test-utils/render-page.utils.tsx:35`). No action unless the test helper changes.

## References

- Arrow doc: `docs/arrows/operator-app/infra-logs.md`
- EARS specs (not yet written): `docs/intent/operator-app/infra-logs/infra-logs-specs.md`
- OpenSpec: `openspec/specs/infra-log-viewer/spec.md`; archived design `openspec/changes/archive/2026-08-14-add-infra-log-viewer/design.md`; archived `2026-08-21-remove-log-level-filter`; active `openspec/changes/add-vpc-flow-logs/`; related `openspec/specs/in-task-tls-termination/spec.md`
- Docs pages: `docs/docs/app/logs.md`, `docs/docs/components/management-app.md` (LogsController row), `docs/docs/app/index.md`
- Neighbouring leaf docs: `docs/intent/operator-app/diagnostics/diagnostics-design.md` (consumes `LogLineList` and ANSI parsing); `docs/arrows/operator-app/ipc-bridge.md`, `docs/arrows/operator-app/desktop-shell.md`, and the `game-runtime/task-and-dns`, `iac/program`, `deployment-config` arrow docs (design docs not yet written)
