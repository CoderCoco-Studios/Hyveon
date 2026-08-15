## 1. Shared types

- [ ] 1.1 Add a `LambdaFunctionKey` union type (`'watchdog' | 'health-check' |
      'dns-updater' | 'interactions' | 'followup'`) to `@hyveon/shared`, exported for use
      by both `desktop-main` and `web`.

## 2. LogsService

- [ ] 2.1 Add a private log-group resolver in `LogsService` that builds
      `/aws/lambda/${projectName}-${functionKey}`, reading `projectName` from
      `DeploymentConfigService` (default `'hyveon'`).
- [ ] 2.2 Add `getRecentLambdaLogs(functionKey: LambdaFunctionKey, limit = 50):
      Promise<string[]>`, mirroring `getRecentLogs`'s `DescribeLogStreamsCommand` +
      `GetLogEventsCommand` flow and its no-streams-yet / error-message fallback
      behavior.
- [ ] 2.3 Add `streamLambdaLogs(functionKey: LambdaFunctionKey, signal: AbortSignal,
      pollInterval = 2000): AsyncGenerator<string>`, following `streamLogs`'s delegation
      pattern but against the Lambda log group instead of `/ecs/{game}-server` (note:
      this does NOT go through `CloudProvider.streamWorkloadLogs` — poll
      `FilterLogEvents` directly against the resolved log group, matching D1 in
      design.md).
- [ ] 2.4 Unit tests in `LogsService.test.ts` for 2.1-2.3: default/custom `projectName`
      resolution, recent-logs happy path, no-streams-yet fallback, CloudWatch error
      fallback, streaming yields new events without duplicates, streaming exits cleanly
      on abort.

## 3. IPC controller + preload bridge

- [ ] 3.1 Add `@MessagePattern('logs.lambda.get')` to `LogsController`, following
      `getRecentLogs`'s existing handler shape (`{ functionKey, limit? }` →
      `{ functionKey, lines }`), with a `logger.debug` entry line per
      `.claude/rules/logging.md`.
- [ ] 3.2 Add a `logs.lambda.stream` self-bridged handler in `LogsController` (register
      in `onModuleInit`, same as `logs.stream`), using a distinct streamId/channel
      namespace (e.g. `logs.lambda.stream.<id>.chunk` / `.end` / `.cancel`) so it can't
      collide with the existing game-logs stream channels.
- [ ] 3.3 Controller tests in `logs.controller.test.ts` for 3.1-3.2, mirroring the
      existing `logs.get`/`logs.stream` test coverage.
- [ ] 3.4 Expose `logs.lambda.get` / `logs.lambda.stream` on the preload bridge
      (`desktop-preload/src/preload.ts`), following the existing `logs.get`/`logs.stream`
      exposure pattern (including the `__test.mock()` seam per
      `docs/docs/components/integration-tests.md`).

## 4. Sidebar navigation

- [ ] 4.1 In `app-layout.component.tsx`, replace the flat `Logs` `NavItem` with a `Logs`
      group (always-expanded, no collapse state) containing two child links: `Game Logs` →
      `/logs`, `Infra Logs` → `/logs/infrastructure`, nested under `Monitoring`. (Labels
      are `Game Logs`/`Infra Logs`, not the shorter `Games`/`Infrastructure`, to avoid
      colliding with the Configuration section's existing top-level `Games`/`Infrastructure`
      links — ruled during apply, see design.md D3.)
- [ ] 4.2 Preserve existing active-route highlighting semantics for both children
      (matches D3/D4 in design.md — only one child active at a time, based on exact
      path).
- [ ] 4.3 Update/extend the existing sidebar component test(s) for the new nested
      structure and active-state behavior on `/logs` vs `/logs/infrastructure`.

## 5. Extract shared live-tail hook

- [ ] 5.1 Extract a `useLogTail(target: string, api: LogTailApi)` hook out of
      `logs.page.tsx`'s inline buffering/pause/resume/stream/level-filter/autoscroll/
      age-footer logic, into `app/packages/web/src/hooks/use-log-tail.hook.ts`. `target`
      is generic (a game name or a `LambdaFunctionKey`); `api` is a `{ get, stream }` pair
      so callers can wire it to either `window.hyveon.logs` or `window.hyveon.logs.lambda`.
      The hook owns the reset-and-resubscribe effect on `target` change — callers no
      longer need their own "reset state before switching" callback.
- [ ] 5.2 Unit tests for the extracted hook in
      `app/packages/web/src/hooks/use-log-tail.hook.test.ts` (via
      `@testing-library/react`'s `renderHook`, matching this directory's existing
      `use-file-manager.hook.test.ts` pattern): initial fetch seeds `lines` and starts the
      stream; new stream chunks append; pause buffers incoming lines without touching
      `lines`, resume flushes the buffer; a hidden level removes matching lines from
      `visibleLines` without touching `lines`; switching `target` resets `lines`/`paused`/
      `error`/buffer, cancels the previous stream handle, and re-fetches/re-streams the new
      target; a `get` rejection sets `error` and still starts the stream; a thrown stream
      error sets `error`.
- [ ] 5.3 Refactor `logs.page.tsx` to consume `useLogTail(selectedGame, window.hyveon.logs)`
      in place of its inline state/effects — behavior-preserving only. The games list,
      `GameCombobox`, and navigation-state preselection stay in the page (they're
      game-specific, not part of the tail engine); `selectGame` becomes a plain
      `setSelectedGame` call since the hook now owns the reset-on-switch behavior.
- [ ] 5.4 Verify `logs.page.test.tsx` passes unchanged (no test edits) as the regression
      gate for 5.3 — this file's existing assertions must all still hold against the
      refactored page.

## 6. Infrastructure logs page

- [ ] 6.1 Add route `/logs/infrastructure` (router config wherever `/logs` is currently
      registered) rendering a new page component.
- [ ] 6.2 Build the new page: a function picker (5 `LambdaFunctionKey` options) +
      `useLogTail(selectedFunction, window.hyveon.logs.lambda)` (Task 5) for the live-tail
      UI, reusing the same `HighlightedLine`/`LevelFilterMenu`/badge rendering
      `logs.page.tsx` already imports.
- [ ] 6.3 On picker change, cancel the previous function's active stream before starting
      the newly selected one (per the spec's "Operator switches functions" scenario) — a
      direct consequence of `useLogTail`'s target-switch behavior (5.1), not page-specific
      logic.
- [ ] 6.4 Add a page object for the new page per this repo's Playwright conventions
      (`e2e/pages/`), exposing locators the same way `logs.page.tsx`'s existing page
      object does.
- [ ] 6.5 jsdom routed-page spec for the new page, per
      `docs/docs/components/integration-tests.md`'s component/routed-page conventions
      (stub `logs.lambda.get`/`logs.lambda.stream` so the spec doesn't hang).

## 7. E2E coverage

- [ ] 7.1 chromium-project stub spec: nested sidebar renders both `Game Logs` and
      `Infra Logs` links, navigating to `/logs/infrastructure` shows the function
      picker, selecting a function shows stubbed log lines, switching functions
      restarts the stream.
- [ ] 7.2 Stub `logs.lambda.get`/`logs.lambda.stream` in the chromium bridge/fixtures
      alongside the existing `logs.get`/`logs.stream` stubs.

## 8. Docs

- [ ] 8.1 Update `docs/docs/app/logs.md`: remove/correct the "It does not show Lambda
      logs" note; document the new `/logs/infrastructure` page, the function picker, and
      the nested sidebar structure.
- [ ] 8.2 Update `docs/docs/components/management-app.md` (or wherever IPC
      channels/routes are enumerated) to list `logs.lambda.get` / `logs.lambda.stream`
      and the new route, if that page catalogs them.
- [ ] 8.3 Update `docs/docs/components/integration-tests.md` if it names
      `logs.page.tsx`'s buffering/pause/stream logic directly, so it reflects the
      `useLogTail` hook (Task 5) as the actual owner of that behavior.
- [ ] 8.4 Run the `write-docs` skill's evaluator pass (accuracy, coverage, style) over
      the changed docs pages before opening the PR, per CLAUDE.md.

## 9. Pre-PR verification

- [ ] 9.1 `npm run app:lint` clean.
- [ ] 9.2 `npm run app:typecheck` clean.
- [ ] 9.3 `npm run app:test` full unit suite green — including `use-log-tail.hook.test.ts`
      (new) and `logs.page.test.tsx` (unchanged, Task 5's regression gate).
- [ ] 9.4 `npm run app:test:e2e` green (renderer/preload/IPC surface changed).
- [ ] 9.5 `/opsx:sync` to fold `specs/infra-log-viewer/spec.md` into
      `openspec/specs/`, or archive per `.claude/rules` OpenSpec workflow.
