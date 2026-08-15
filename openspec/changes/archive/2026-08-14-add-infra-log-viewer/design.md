## Context

The operator app already has one working log-tail flow: `LogsService`
(`app/packages/desktop-main/src/services/LogsService.ts`) fetches recent lines and
streams new ones from CloudWatch Logs for a game's ECS task, at the fixed log-group
convention `/ecs/{game}-server`. This is surfaced on the existing `/logs` page via IPC
channels and a live-tail UI component.

Separately, all 5 Lambda packages (`watchdog`, `health-check`, `dns-updater`,
`interactions`, `followup`) get a CloudWatch log group provisioned in
`app/packages/infra/src/lambdas.ts`, always named
`/aws/lambda/${projectName}-{suffix}` where `projectName` is a `DeploymentConfig` field
(default `'hyveon'`). Today nothing in the app reads from these groups — an operator
must go to the AWS Console. `docs/docs/app/logs.md` already documents this as a known
gap ("It does not show Lambda logs.").

The sidebar (`app/packages/web/src/components/app-layout.component.tsx`) currently
renders two flat `NavItem[]` lists (`Monitoring`, `Configuration`) with no nested/
collapsible-group pattern.

## Goals / Non-Goals

**Goals:**
- Let an operator view recent and live-tailed logs for any of the 5 Lambda functions
  from inside the app, without leaving for the AWS Console.
- Reuse the existing CloudWatch Logs client, polling cadence, and live-tail UI pattern
  already proven by the game-server logs page — no new interaction model.
- Keep the existing `/logs` (game-server) page and URL completely unchanged.

**Non-Goals:**
- No CloudWatch Insights queries or cross-function/cross-log-group search.
- No log retention, export, or download UI.
- No changes to Pulumi-provisioned infrastructure — all 5 log groups already exist.
- No changes to `CloudProvider`'s cloud-agnostic interface — Lambda log-group naming is
  an AWS-specific implementation detail, not a cloud-portable "workload" concept.
- No generic/reusable collapsible sidebar-nav component — only 2 children exist under
  `Logs`, so an always-expanded group is sufficient.

## Decisions

### D1: Extend `LogsService` directly, not `CloudProvider`
- **Choice**: Add `getRecentLambdaLogs(functionKey, limit)` and
  `streamLambdaLogs(functionKey, signal, pollInterval)` to `LogsService`, building the
  log group name inline (`/aws/lambda/${projectName}-${functionKey}`) and reusing the
  service's existing lazily-cached `CloudWatchLogsClient`.
- **Rationale**: `CloudProvider.streamWorkloadLogs` is a cloud-agnostic abstraction over
  a game *workload*. Lambda functions and their AWS-specific log-group naming
  convention aren't a "workload" in that sense, and `LogsService.getRecentLogs` already
  bypasses `CloudProvider` and talks to `CloudWatchLogsClient` directly for the same
  reason. Keeping Lambda log access in `LogsService` (desktop-main only, AWS-specific)
  avoids leaking AWS naming details into the shared cloud-agnostic interface.
- **Alternatives considered**: Adding a `streamLambdaLogs` method to the `CloudProvider`
  interface — rejected because it would force every future `CloudProvider`
  implementation (a hypothetical non-AWS cloud) to model AWS Lambda-specific log-group
  naming, which doesn't generalize.

### D2: Fixed `functionKey` union, not a dynamic Lambda-listing call
- **Choice**: `functionKey: 'watchdog' | 'health-check' | 'dns-updater' | 'interactions'
  | 'followup'`, matching the exact suffixes hardcoded in `app/packages/infra/src/lambdas.ts`.
- **Rationale**: The 5 Lambdas are fixed by the codebase, not dynamically discovered —
  there's no need for a `ListFunctions` call or a data-driven picker. A fixed union keeps
  the IPC contract simple and typo-proof (compile-time checked at both ends).
- **Alternatives considered**: Querying AWS for the Lambda function list at runtime —
  rejected as unnecessary indirection for a fixed, known set of 5 functions; would also
  require an extra IAM permission and error-handling path with no real benefit.

### D3: Nested sidebar group over a new top-level nav item or a tab
- **Choice**: Replace the single `Logs` `NavItem` with an always-expanded `Logs` group
  header plus two child links (`Game Logs` → `/logs`, `Infra Logs` →
  `/logs/infrastructure`), nested under the existing `Monitoring` section. No
  collapse/expand interaction — both children always render.
- **Rationale**: Groups the two log domains under one concept ("Logs") the way an
  operator already thinks about them, without inventing generic collapsible-nav
  infrastructure for a case with only 2 children. Child labels are `Game Logs`/`Infra
  Logs` rather than the shorter `Games`/`Infrastructure` (discovered during Task 4
  implementation, ruled during apply): the Configuration section already has top-level
  `Games` (`/games`) and `Infrastructure` (`/iac`) links, and reusing those exact labels
  as child-link text produces two same-named links in the sidebar — ambiguous for a
  screen reader and for any locator keyed on accessible name (including this change's
  own e2e page objects).
- **Alternatives considered**: A new top-level `/logs/lambdas` sibling page with its own
  flat nav entry — loses the grouping relationship. A `Lambdas` tab inside the existing
  `/logs` page — rejected as it crowds a page that's currently single-purpose per this
  repo's per-page routed-page conventions. A section on the Infrastructure (`/iac`) page
  — rejected because that page is about *provisioning* infra (Pulumi plan/apply), a
  different mental model than *tailing* infra logs.

### D4: Keep `/logs` as the Games page; add `/logs/infrastructure` as a sibling route
- **Choice**: `/logs` continues to mean "game-server logs" (unchanged); the new page is
  `/logs/infrastructure`, not `/logs/games` + a redirect.
- **Rationale**: Avoids breaking the existing bookmarked URL, docs screenshots, and any
  external links pointing at bare `/logs`.
- **Alternatives considered**: Symmetric `/logs/games` + `/logs/infrastructure` — would
  require either a redirect (extra routing complexity) or accepting that plain `/logs`
  404s, both worse than keeping the existing route as-is.

### D5: Live poll tail, matching the existing game-logs cadence
- **Choice**: `/logs/infrastructure` live-tails the selected function's logs using the
  same polling pattern (`FilterLogEvents` every ~2s) as `LogsService.streamLogs`, not a
  one-shot "load recent logs" button.
- **Rationale**: Consistent UX with the existing `/logs` page — an operator switching
  between the two shouldn't learn two different interaction models. Watchdog specifically
  runs on an EventBridge schedule every few minutes, so near-live tailing is genuinely
  useful for confirming a run just happened.
- **Alternatives considered**: On-demand fetch only — simpler (no new streaming IPC
  channel needed) but rejected for UX inconsistency with the sibling Games tab.

### D6: Extract a shared `useLogTail` hook, not a duplicated parallel implementation
- **Choice**: Before building `/logs/infrastructure`, extract the buffering/pause/
  resume/stream/level-filter/autoscroll/age-footer logic currently inline in
  `logs.page.tsx` into a standalone `useLogTail(target, api)` hook
  (`app/packages/web/src/hooks/use-log-tail.hook.ts`). `logs.page.tsx` is refactored to
  consume it (behavior-preserving; its existing test suite must still pass unchanged),
  and the new Infrastructure page is built directly on top of the same hook rather than
  a second, separately-written copy of the same state machine.
- **Rationale**: The spec's "Infrastructure logs page" requirement says the new page
  reuses "the same live-tail UI component used by the existing game-server logs page" —
  a real shared implementation, not two pages that happen to look similar today.
  `logs.page.tsx` turned out to be one monolithic component with no separately-exported
  live-tail piece, so satisfying that requirement means extracting one first. A single
  source of truth for the tail/pause/level-filter state machine means a future fix
  (e.g. a buffering bug, a new level, a de-dup edge case) is made once and both pages
  get it, instead of relying on someone remembering to port the fix to a sibling copy.
  This was raised with the user directly: given the choice between duplicating the
  logic in a parallel hook (the path of least resistance for this change alone) and
  extracting a shared implementation, the user explicitly chose extraction.
- **Alternatives considered**: A parallel `useInfraLogTail` hook duplicating the same
  state machine against `logs.lambda.get`/`logs.lambda.stream` — smaller diff and zero
  risk to the already-working `/logs` page, but rejected: it satisfies the spec's letter
  ("looks the same") while missing its intent ("is the same"), and guarantees the two
  copies drift the first time either page's tail behavior needs to change. Extracting a
  full `<LogTailPanel>` presentational component (not just the state hook) was also
  considered and rejected as larger scope than needed — the two pages' picker UIs
  (searchable `GameCombobox` vs. a fixed 5-button `LambdaFunctionKey` row) are different
  enough that only the state/effects layer, not the JSX, benefits from being shared.
- **Trade-off accepted**: This is a real refactor of already-working, currently
  untouched code, carrying a nonzero chance of a regression in the existing `/logs`
  page. Mitigation: `logs.page.test.tsx` is treated as a fixed regression gate — the
  refactor task (tasks.md 5.3) is not done until that existing suite passes with zero
  test-file edits, so any behavioral drift introduced by the extraction fails CI rather
  than shipping silently.

## Risks / Trade-offs

- [Risk] A Lambda's log group may not exist yet (e.g. `health-check` is conditionally
  provisioned only when at least one game declares a `healthCheck`) → Mitigation:
  `getRecentLambdaLogs`/`streamLambdaLogs` follow the existing `getRecentLogs` pattern of
  catching `ResourceNotFoundException`-style errors and returning a single informational
  message rather than throwing, matching current UX when a log group has no streams yet.
- [Risk] Polling 5 possible functions (even one at a time, per the picker) adds
  CloudWatch API call volume → Mitigation: only the currently-selected function is
  polled (single active stream per page visit), same call volume as the existing
  per-game tail.
- [Trade-off] No dynamic Lambda discovery means a 6th Lambda added in the future needs a
  manual `functionKey` union update in both `LogsService` and the frontend picker →
  accepted, since the last Lambda package added to this repo was also a manual,
  low-frequency addition (5 packages total, added over the project's history), and the
  fixed union's type safety outweighs the marginal maintenance cost.

## Migration Plan

N/A — this change involves no deployment changes. It adds a new IPC surface and UI page;
no data migration, no infra changes, no changes to already-provisioned resources.

## Open Questions

None outstanding — all decisions above were confirmed with the user during
brainstorming (see `brainstorm.md` Q1-Q4).
