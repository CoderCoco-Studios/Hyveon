# CloudWatch Log Viewer Specs

EARS requirements for prefix `APP-LOGS`; design in `docs/intent/operator-app/infra-logs/infra-logs-design.md`.

## Log group resolution

- [x] **APP-LOGS-GROUP-001**: The log viewer shall read a game server's logs from the CloudWatch log group `/ecs/{game}-server` for the game snapshot, game paging, and game live tail. (observed)
- [x] **APP-LOGS-GROUP-002**: The log viewer shall resolve a Lambda function's CloudWatch log group as `/aws/lambda/{projectName}-{functionKey}`, where `projectName` comes from the active `deployment-config.json` top-level settings. (OpenSpec: infra-log-viewer / Lambda log group resolution)
- [x] **APP-LOGS-GROUP-003**: When `projectName` is unset in `deployment-config.json`, the Lambda log group resolver shall use the default project name `hyveon`, so `functionKey: 'watchdog'` resolves to `/aws/lambda/hyveon-watchdog`. (OpenSpec: infra-log-viewer / Lambda log group resolution)
- [x] **APP-LOGS-GROUP-004**: When `projectName` is set (for example `acme`), the Lambda log group resolver shall use it, so `functionKey: 'health-check'` resolves to `/aws/lambda/acme-health-check`. (OpenSpec: infra-log-viewer / Lambda log group resolution)
- [x] **APP-LOGS-GROUP-005**: The addressable Lambda set for the log viewer shall be exactly the five `LambdaFunctionKey` values `watchdog`, `health-check`, `dns-updater`, `interactions`, `followup`, excluding the per-game `efs-seeder` Lambda. (OpenSpec: infra-log-viewer / Lambda log group resolution)
- [x] **APP-LOGS-GROUP-006**: If reading `deployment-config.json` fails while resolving a Lambda log group, then the resolver shall log a `warn` with the `functionKey` and fall back to the default project name. (observed)
- [ ] **APP-LOGS-GROUP-007**: The `LambdaFunctionKey` union and the `LAMBDA_FUNCTION_KEYS` picker array shall be derived from one declaration so a key cannot be added to one without the other. (observed; gap: `shared/src/lambdaFunctionKey.ts:8-13,20-26` declares both by hand)

## Recent snapshot

- [x] **APP-LOGS-SNAP-001**: When the caller requests recent logs for a game or a Lambda `functionKey` with a `limit` (default 50), the log viewer shall return up to `limit` events from the most recently written stream in that log group, ordered oldest-first, each carrying its CloudWatch `timestamp` and an `eventId`. (OpenSpec: infra-log-viewer / Recent Lambda logs fetch)
- [x] **APP-LOGS-SNAP-002**: If the log group for a recent-logs request (game or Lambda) has no log streams, then the log viewer shall return a single informational `No log streams found for {label}.` line instead of throwing or returning an empty array. (OpenSpec: infra-log-viewer / Recent Lambda logs fetch)
- [x] **APP-LOGS-SNAP-003**: If the log group for a Lambda recent-logs request does not exist (`ResourceNotFoundException`), then the log viewer shall return a single informational `No log group for {functionKey} yet …` line, logged at `warn` rather than `error`. (OpenSpec: infra-log-viewer / Recent Lambda logs fetch)
- [x] **APP-LOGS-SNAP-004**: If a CloudWatch call fails during a game or Lambda recent-logs request, then the log viewer shall return a single `Error fetching logs for {label}: …` line instead of propagating the SDK error, and shall log the failure via `logger.error` with the game or `functionKey` and log group as identifiers. (OpenSpec: infra-log-viewer / Recent Lambda logs fetch)
- [ ] **APP-LOGS-SNAP-005**: If the log group for a game recent-logs request does not exist, then the log viewer shall return the same kind of informational "no log group yet" line it returns for Lambdas, rather than a raw `ResourceNotFoundException` string. (observed; gap: `LogsService.ts:277-288` passes no `notFound` hook for games)
- [ ] **APP-LOGS-SNAP-006**: The log viewer shall synthesize a game or Lambda event's `eventId` the same way on the snapshot path and the paging path, including for events with no message. (observed; gap: `LogsService.ts:326` uses `${e.message ?? ''}` while `:519` uses raw `${e.message}`)

## Historical paging

- [x] **APP-LOGS-PAGE-001**: When the caller requests older logs for a game or Lambda before a `beforeTimestamp`, the log viewer shall return up to `limit` events strictly older than that timestamp, gathered across up to 50 of the group's streams walked newest-first, sorted oldest-first and trimmed to the `limit` closest to the boundary. (observed)
- [x] **APP-LOGS-PAGE-002**: When the caller requests newer logs for a game or Lambda after an `afterTimestamp`, the log viewer shall return up to `limit` events at or after that timestamp, gathered across up to 50 streams walked oldest-first, sorted oldest-first and trimmed to the `limit` closest to the boundary. (observed)
- [x] **APP-LOGS-PAGE-003**: When a newer-logs request carries `excludeEventIds`, the log viewer shall drop each listed id at most as many times as it appears in the list (multiset exclusion), so distinct same-content events from different streams are not all dropped. (observed)
- [x] **APP-LOGS-PAGE-004**: The older-logs page for a game or Lambda shall report `atOldest: true` only when it is empty and the stream listing ended naturally below the 50-stream scan cap. (observed)
- [x] **APP-LOGS-PAGE-005**: The newer-logs page for a game or Lambda shall report `hasMore: true` exactly when the accumulated events filled `limit`. (observed)
- [x] **APP-LOGS-PAGE-006**: If an older-logs or newer-logs request for a game or Lambda fails, then the log viewer shall log the failure at `warn` and throw a plain `Error` carrying only the normalized message. (observed)
- [x] **APP-LOGS-PAGE-007**: If the log group for a Lambda older-logs or newer-logs request does not exist, then the log viewer shall throw an `Error` with the `No log group for {functionKey} yet …` text. (observed)
- [ ] **APP-LOGS-PAGE-008**: If an older-logs or newer-logs IPC handler rethrows a paging failure, then it shall not re-log at `error` a failure `LogsService` already logged at `warn`, and the four game/Lambda paging handlers shall share one catch implementation. (observed; gap: `logs.controller.ts:88-95,112-119,248-255,272-279`)

## Live tail

- [x] **APP-LOGS-TAIL-001**: When a consumer starts a game live tail, the log viewer shall poll `FilterLogEvents` on `/ecs/{game}-server` every poll interval (default 2000 ms), starting from the moment the tail opened, and yield each new event's message once. (observed)
- [x] **APP-LOGS-TAIL-002**: If infrastructure is not deployed when a game live tail starts, then the game tail shall fail with a `WorkloadGuardError` before polling. (observed)
- [x] **APP-LOGS-TAIL-003**: When a consumer starts a Lambda live tail for a `functionKey`, the log viewer shall poll `FilterLogEvents` on that function's log group every poll interval (default 2000 ms), draining every `nextToken` page per poll. (OpenSpec: infra-log-viewer / Live Lambda log tail)
- [x] **APP-LOGS-TAIL-004**: While a game or Lambda live tail is active, the tail shall not yield any CloudWatch event it has already yielded on that stream. (OpenSpec: infra-log-viewer / Live Lambda log tail)
- [ ] **APP-LOGS-TAIL-005**: When a Lambda live tail starts, the tail shall yield only events written after it started (newly-arriving lines), not the group's retained history already shown by the snapshot. (OpenSpec: infra-log-viewer / Live Lambda log tail; gap: `LogsService.ts:735` starts with `startTime` undefined, so the first poll replays the whole group; observed live 2026-10-31: opening the watchdog tail replayed about 50,000 retained lines from roughly 10,000 runs in a few minutes with no timestamps, which reads as the Lambda running several times a second)
- [x] **APP-LOGS-TAIL-006**: When the caller's `AbortSignal` is aborted during a game or Lambda live tail, the tail shall end without an unhandled rejection and issue no further polls. (OpenSpec: infra-log-viewer / Live Lambda log tail)
- [ ] **APP-LOGS-TAIL-007**: When the caller's `AbortSignal` is aborted during a Lambda live tail, the tail shall cancel its in-flight `FilterLogEvents` call and its inter-poll sleep immediately, as the game tail does. (observed; gap: `LogsService.ts:739-741` passes no `abortSignal`, `:766` uses a plain `setTimeout`)
- [x] **APP-LOGS-TAIL-008**: If a poll fails during a game or Lambda live tail, then the tail shall yield one `[stream error] …` line and keep polling. (observed)
- [ ] **APP-LOGS-TAIL-009**: If a poll fails during a Lambda live tail, then the tail shall log the normalized error with the `functionKey` and log group, per the logging rule. (observed; gap: `LogsService.ts:762-763` yields the line without any `logger` call)
- [x] **APP-LOGS-TAIL-010**: If the log group for a Lambda live tail does not exist, then the tail shall yield one `No log group for {functionKey} yet …` line and end, rather than repeating an error every poll. (observed)
- [ ] **APP-LOGS-TAIL-011**: The live tail shall deliver each line's CloudWatch timestamp to the renderer, for both game and Lambda tails. (observed; gap: `LogsService.ts:205-206` drops the provider chunk's timestamp; preload `LogChunk = string`, `hyveon-api.ts:157`)

## IPC surface

- [x] **APP-LOGS-IPC-001**: The log viewer's IPC surface shall expose `logs.get`, `logs.getOlder`, `logs.getNewer`, `logs.stream` keyed by game, and `logs.lambda.get`, `logs.lambda.getOlder`, `logs.lambda.getNewer`, `logs.lambda.stream` keyed by `functionKey`. (observed)
- [x] **APP-LOGS-IPC-002**: When any of the eight log IPC handlers is invoked, it shall first log at `debug` the pattern name with only the game or `functionKey` identifier. (observed)
- [x] **APP-LOGS-IPC-003**: Where the app runs inside Electron, the log viewer shall register `logs.stream` and `logs.lambda.stream` directly with `ipcMain.handle`, outside the generic IPC bridge. (observed)
- [x] **APP-LOGS-IPC-004**: When `logs.stream` or `logs.lambda.stream` is invoked, the handler shall return a fresh uuid `streamId` and push each yielded line on `<prefix><streamId>.chunk` via `WebContents.send`, where `<prefix>` is `logs.stream.` or `logs.lambda.stream.`. (observed)
- [x] **APP-LOGS-IPC-005**: When the renderer sends `<prefix><streamId>.cancel` for an open log stream, the handler shall abort that stream's generator. (observed)
- [x] **APP-LOGS-IPC-006**: When a log stream's generator completes or ends with an `AbortError`, the handler shall send `<prefix><streamId>.end` with an empty payload; if it throws any other error, then the handler shall log it at `error` and send `.end` with `{ error }`. (observed)
- [x] **APP-LOGS-IPC-007**: If the originating `WebContents` is destroyed while a log stream is open, then the handler shall abort the stream and stop sending. (observed)
- [x] **APP-LOGS-IPC-008**: When a log stream ends for any reason, the handler shall remove its `.cancel` listener. (observed)

## Renderer tail engine

- [x] **APP-LOGS-ENGINE-001**: When the selected target (game or `functionKey`) changes, the log tail engine shall clear lines, pause buffer, pause state, error and paging state, fetch the target's recent snapshot, then open its live stream. (OpenSpec: infra-log-viewer / Infrastructure logs page)
- [x] **APP-LOGS-ENGINE-002**: When the selected target changes, the log tail engine shall cancel the previous target's live stream. (OpenSpec: infra-log-viewer / Infrastructure logs page)
- [x] **APP-LOGS-ENGINE-003**: If the snapshot fetch fails on target change, then the log tail engine shall show `Could not load initial logs; trying live stream.` and still open the live stream. (observed)
- [x] **APP-LOGS-ENGINE-004**: While in live mode and not paused, the log tail engine shall append live lines and keep only the newest 300 lines loaded. (observed)
- [x] **APP-LOGS-ENGINE-005**: While paused or in historical mode, the log tail engine shall route live lines into a pause buffer capped at 300 entries that drops its oldest entries. (observed)
- [x] **APP-LOGS-ENGINE-006**: When the operator resumes from pause while in live mode, the log tail engine shall flush the pause buffer into the loaded lines, trimmed to the newest 300. (observed)
- [x] **APP-LOGS-ENGINE-007**: When the operator resumes from pause while in historical mode, the log tail engine shall keep the buffered live lines out of the historical window. (observed)
- [x] **APP-LOGS-ENGINE-008**: When the operator scrolls within 50 px of the top of the log list, the log tail engine shall request one older page of up to 300 lines before the oldest loaded line's timestamp, enter historical mode on the first such request, prepend the page, and evict from the bottom to stay at 300 lines. (observed)
- [x] **APP-LOGS-ENGINE-009**: When an older-page request returns `atOldest` or no lines, the log tail engine shall stop further backward requests until the target changes or the operator jumps to latest. (observed)
- [x] **APP-LOGS-ENGINE-010**: When the operator scrolls within 24 px of the bottom while in historical mode, the log tail engine shall request one newer page of up to 300 lines after the newest loaded line's timestamp, excluding the `eventId`s of loaded lines at that timestamp, append it, and evict from the top. (observed)
- [x] **APP-LOGS-ENGINE-011**: If the newest loaded line has no timestamp (a live-tailed line) when a newer page is requested, then the log tail engine shall use the moment historical mode was entered as the forward boundary. (observed)
- [x] **APP-LOGS-ENGINE-012**: If an older, newer, or latest-snapshot request fails, then the log tail engine shall show `Could not load older logs: …`, `Could not load newer logs: …`, or `Could not load latest logs: …` respectively. (observed)
- [x] **APP-LOGS-ENGINE-013**: When the operator jumps to latest, the log tail engine shall discard the pause buffer and loaded lines, re-fetch the recent snapshot, return to live mode, and re-enable autoscroll. (observed)
- [x] **APP-LOGS-ENGINE-014**: If an older, newer, or latest-snapshot response resolves after a target switch or a later jump to latest, then the log tail engine shall discard that response. (observed)
- [x] **APP-LOGS-ENGINE-015**: When the operator scrolls away from the bottom of the log list, the log tail engine shall turn autoscroll off, and turn it back on when they scroll back within 24 px of the bottom. (observed)
- [ ] **APP-LOGS-ENGINE-016**: When a newer-page request returns `hasMore: false` in historical mode, the log tail engine shall report that no newer history remains. (observed; gap: `use-log-tail.hook.ts:612` sets `hasNewer` from mode alone and ignores `NewerLogsPage.hasMore`)
- [ ] **APP-LOGS-ENGINE-017**: The log tail footer's `oldest {age}` shall measure the age of the oldest loaded log event, not the time since it was received. (observed; gap: `use-log-tail.hook.ts:258-259,366-367` uses `receivedAt`)

## Log pages and view

- [x] **APP-LOGS-UI-001**: The app shall provide a routed page at `/logs` that live-tails the selected game server's logs, loading game names from the games list and selecting the game passed in router navigation state when it exists, else the first game. (observed)
- [x] **APP-LOGS-UI-002**: The app shall provide a routed page at `/logs/infrastructure` that lets the operator pick one of the five `LambdaFunctionKey` values from `aria-pressed` buttons, defaulting to `watchdog`, and view its recent and live-tailed logs. (OpenSpec: infra-log-viewer / Infrastructure logs page)
- [x] **APP-LOGS-UI-003**: The `/logs` and `/logs/infrastructure` pages shall both use the same log tail engine (`useLogTail`) and view shell (`LogTailView`). (OpenSpec: infra-log-viewer / Infrastructure logs page)
- [x] **APP-LOGS-UI-004**: If the games list fails to load on `/logs`, then the page shall show `Could not load games.` (observed)
- [x] **APP-LOGS-UI-005**: The log view shell shall show a `Live` / `Paused` badge, a search input, an autoscroll toggle, a pause/resume button, an error banner, a `Loading older logs…` marker while an older page is loading, a `Beginning of log retention` marker at the oldest point, and a footer with the loaded line count. (observed)
- [x] **APP-LOGS-UI-006**: While in historical mode, the log view shell shall show a `Jump to latest` button, and hide it in live mode. (observed)
- [x] **APP-LOGS-UI-007**: While paused with buffered lines, the log view footer shall show `buffered {N}`. (observed)
- [ ] **APP-LOGS-UI-008**: While in historical mode, the log view shell shall indicate that the view is not live, in both the badge and the buffered-line count. (observed; gap: `live-badge.component.tsx:19-36` reflects only `paused`; `log-tail-view.component.tsx:212` shows `buffered` only when paused)
- [ ] **APP-LOGS-UI-009**: Where the `/logs` page uses its mobile filter drawer, the log view shell shall mount exactly one search input and one autoscroll toggle at a time. (observed; gap: `log-tail-view.component.tsx:150-166` keeps the desktop pair mounted under `hidden md:contents`)

## Line rendering

- [x] **APP-LOGS-RENDER-001**: When the search input is non-empty, the shared log line list (used by `/logs`, `/logs/infrastructure` and the Settings → Diagnostics panel) shall highlight every case-insensitive match in each loaded line with `<mark>`, including matches spanning ANSI-styled segments while keeping their colour, without hiding non-matching lines. (observed; OpenSpec: app-diagnostics-logging / ANSI escape sequence rendering for log lines)
- [x] **APP-LOGS-RENDER-002**: The shared log line list shall render the 16 standard ANSI SGR foreground colours, bold and normal intensity, and reset per line, ignore unrecognized SGR codes, strip every well-formed non-SGR escape sequence (cursor movement, clear-line, OSC) from the displayed text, and leave a malformed or truncated escape in place as plain text without erroring. (observed; OpenSpec: app-diagnostics-logging / ANSI escape sequence rendering for log lines)
- [ ] **APP-LOGS-RENDER-003**: The log line list shall key rows by a stable per-line identity, so prepending older lines does not re-render every row. (observed; gap: `log-line-display.component.tsx:116` keys by array index)

## Sidebar navigation

- [x] **APP-LOGS-NAV-001**: The sidebar shall present `Logs` under the `Monitoring` section as a group with two always-visible child links, `Game Logs` to `/logs` and `Infra Logs` to `/logs/infrastructure`, with no expand/collapse interaction. (OpenSpec: infra-log-viewer / Nested Logs sidebar navigation)
- [x] **APP-LOGS-NAV-002**: The `Logs` group's child link labels shall not share an accessible name with any other sidebar link, such as the Configuration section's `Games` and `Infrastructure`. (OpenSpec: infra-log-viewer / Nested Logs sidebar navigation)
- [x] **APP-LOGS-NAV-003**: While the operator is on `/logs/infrastructure`, the sidebar shall mark `Infra Logs` as active and shall not mark `Game Logs` as active. (OpenSpec: infra-log-viewer / Nested Logs sidebar navigation)

## Dropped from OpenSpec

None. Every `infra-log-viewer` requirement still describes current behaviour; the "5 Lambda functions" wording matches the five `LambdaFunctionKey` values.
