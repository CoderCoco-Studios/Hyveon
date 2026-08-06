## 1. Frontend — swap actuals UI for free-data UI (PR: `costexplorer-1-frontend`, base: `main`)

- [x] 1.1 `kpi-strip.component.tsx`: drop the `actualCosts` prop; compute
      "Current run rate" (Σ `costPerHour` over games with
      `state === 'running'`, from the existing `estimates` prop) and "Est.
      month cap" (`totalPerHourIfAllOn × 24 × daysInMonth`, already
      computed today as `budgetText`) as the two cost tiles.
- [x] 1.2 `dashboard.page.tsx`: remove the `api.costsActual()` fetch-on-mount
      effect and the `actualCosts` state; stop passing `actualCosts` into
      `KpiStrip`.
- [x] 1.3 `costs.page.tsx`: remove the total-spend card, delta-vs-prior
      pill, and the stacked daily-by-game bar chart (and their supporting
      helpers — `sumDaily`, `splitDailyByGame`, `DeltaPill`,
      `StackedBarChart`, the `useCostsData` actuals-fetch branch — keep the
      per-game estimates fetch/table). The 7d/30d `RangeSelector` is also
      removed — its only purpose was choosing the Cost Explorer fetch
      window, which no longer exists.
- [x] 1.4 `costs.page.tsx`: add a callout card — "See real billed spend →
      AWS Cost Explorer" — linking to the plain AWS Cost Explorer console
      home URL (no query-string filters).
- [x] 1.5 Update `kpi-strip.component.test.tsx`, `costs.page.test.tsx`,
      `dashboard.page.test.tsx` for the new tiles/UI; delete assertions
      referencing removed elements (stacked chart, delta pill, total-spend
      card).
- [x] 1.6 Run `npm run app:lint`, `npm run app:typecheck`, `npm run
      app:test`, `npm run app:test:e2e` (renderer changed) — all clean,
      including e2e (91 passed, 0 failed). Per this repo's rule that no PR
      may ship with a broken build/CI, the 5 e2e tests that assert the
      removed UI (`costs.spec.ts` x4, `dashboard.spec.ts` x1) are marked
      `test.fixme()` with a comment pointing at PR 3
      (`costexplorer-3-e2e`), which rewrites/removes each one — not left
      failing with a "known/anticipated" note.
- [x] 1.7 Open PR `costexplorer-1-frontend` against `main`.

## 2. Backend — delete the Cost Explorer call chain (PR: `costexplorer-2-backend`, base: PR 1's branch)

- [x] 2.1 `@hyveon/shared/src/cloud.ts`: remove `getActualCosts` from the
      `CloudProvider` interface and the `ActualCosts`/`CostBreakdown` types.
      Update `cloud.test.ts`. (Landed as: only `DateRange` + `getActualCosts`
      removed — `CostBreakdown` stays, it's the unrelated `getCostEstimate()`
      return type; the earlier phrasing above was imprecise.)
- [x] 2.2 `cloud-aws/src/AwsCloudProvider.ts`: delete the `getActualCosts`
      implementation and the `CostExplorerClient`/`GetCostAndUsageCommand`
      import; remove `@aws-sdk/client-cost-explorer` from
      `cloud-aws/package.json`. Update `AwsCloudProvider.test.ts` and
      `index.test.ts`. Also removed the same stray dependency from
      `desktop-main/package.json` (zero direct imports there — found during
      review, not in the original scope).
- [x] 2.3 `desktop-main/src/services/CostService.ts`: delete
      `getActualCosts` (keep `estimateForSpec`). Update `CostService.test.ts`.
      Also removed the now-dead `CLOUD_PROVIDER` constructor injection
      (its only consumer was `getActualCosts`).
- [x] 2.4 `desktop-main/src/controllers/costs.controller.ts`: delete the
      `costs.actual` `@MessagePattern` handler. Update
      `costs.controller.test.ts` and `cloud-provider.module.test.ts`.
- [x] 2.5 `desktop-preload/src/hyveon-api.ts` and `preload.ts`: remove the
      `costs.actual` bridge method.
- [x] 2.6 `web/src/api.service.ts`: remove `costsActual()`. Update
      `api.service.test.ts`.
- [x] 2.6a (Pulled forward from PR 3 — this repo's own `app:typecheck` gate
      reaches `e2e/**` via `tsconfig.typecheck.json`, so PR 2 can't be
      typecheck-clean without these.) Removed dead `ActualCosts`/
      `makeActualCosts`/`costs.actual` references — pure deletions, no new
      test behavior — from `web/e2e/fixtures/game-data.ts`, `index.ts`,
      `hyveon-http-bridge.ts`, `electron-launch.ts`, and
      `web/e2e/screenshots/demo-data.ts` (= old items 3.1 and 3.3b, done
      here instead). `web/e2e/specs/costs.spec.ts` is deliberately NOT
      included — it needs a real rewrite depending on PR 3's Task 18
      page-object locator, not a pure deletion; left as PR 2's one
      documented typecheck exception, fixed by 3.2 below.
- [x] 2.7 Run `npm run app:lint`, `npm run app:typecheck` (clean except the
      documented `costs.spec.ts` exception above), `npm run
      app:test`, `npm run app:test:integration` (controller/IPC surface
      changed) — all clean.
- [x] 2.8 Open PR `costexplorer-2-backend` against `costexplorer-1-frontend`.
      → [#431](https://github.com/CoderCoco/Hyveon/pull/431)

## 3. E2E — update fixtures and specs (PR: `costexplorer-3-e2e`, base: PR 2's branch)

- [x] 3.1 ~~Update `web/e2e/fixtures/electron-launch.ts`, `game-data.ts`,
      `index.ts`, and `web/e2e/screenshots/demo-data.ts`~~ — done early as
      2.6a above (PR 2, not PR 3).
- [x] 3.2 Update `web/e2e/specs/costs.spec.ts` to assert the new Costs page
      (estimates table + CE link-out card, no chart/total-spend card, no
      range selector). Depended on 3.2a (`CostsPage.ts`) below.
- [x] 3.2a Update `web/e2e/pages/CostsPage.ts`: drop range/chart/delta-pill
      locators (`chartTitle()`, `chartSegment()`, `deltaPill()`,
      `totalLabel()`, range-selector locators), add a `costExplorerLink()`
      locator for 3.2's new link-out test. Also fixed the stale
      `chartTitle()`-dependent assertion in
      `web/e2e/screenshots/capture.spec.ts`'s `costs.png` test — a
      regression from PR 1's `costs.page.tsx` change, found during PR 2's
      Task 22 (`docs:screenshots` isn't part of the required
      `app:test:e2e` gate, so it didn't block PR 1/2, but fixed here since
      this task already touches the same page).
- [x] 3.3 Update `web/e2e/specs/discord.spec.ts` — dropped the unused
      `costs.actual` mock from `seedBaseMocks()` (inert cleanup, no
      behavior change — the mock was never invoked).
- [x] 3.3a Update `web/e2e/specs/dashboard.spec.ts` — it asserts the literal
      old `'Spend today'`/`'Forecast MTD'` tile labels; updated to the new
      `'Current run rate'`/`'Est. month cap'` labels.
- [x] 3.3b ~~Update `web/e2e/fixtures/hyveon-http-bridge.ts`~~ — done early
      as 2.6a above (PR 2, not PR 3).
- [x] 3.4 Run `npm run app:test:e2e` — 93/93 passed, first fully-green point
      in the stack (no documented exceptions).
- [x] 3.5 Open PR `costexplorer-3-e2e` against `costexplorer-2-backend`.
      → [#432](https://github.com/CoderCoco/Hyveon/pull/432)

## 4. Docs and IAM cleanup (PR: `costexplorer-4-docs-iam`, base: PR 3's branch)

- [x] 4.1 Rewrite `docs/docs/app/costs.md` to describe estimate-only
      display plus the AWS Cost Explorer link-out; removed references to the
      removed chart/total-spend card and the "Cost Explorer must be
      enabled" caveat section (no longer applicable — the app never calls
      it).
- [x] 4.2 Rewrite `docs/docs/app/dashboard.md`'s KPI tile descriptions
      ("Spend today" / "Forecast MTD" → "Current run rate" / "Est. month
      cap").
- [x] 4.3 Update `docs/docs/components/management-app.md`'s
      `CostsController` row (dropped the `costs.actual` channel and its
      Cost Explorer description).
- [x] 4.4 Remove `"ce:*"` from the `HyveonDeployAll` IAM policy in
      `docs/docs/setup.md`. Also removed it from
      `app/packages/shared/src/iamPolicy.ts` — the machine-readable source
      of truth `setup.md`'s JSON is test-locked against
      (`iamPolicy.test.ts`), found by `docs-accuracy-auditor` and not in
      the original plan scope (which only checked `iam-bootstrap.yaml`).
- [x] 4.5 Ran `docs-accuracy-auditor`, `docs-coverage-auditor`,
      `docs-style-reviewer` over every changed docs page, across two
      re-verification rounds. Found and fixed beyond the original scope:
      `docs/docs/app/index.md`'s stale "Watch the costs" section + nav-map
      row, regenerated `costs.png`/`dashboard.png` (still showed the
      pre-PR1 UI), a stale scenario in this change's own
      `specs/cost-visibility/spec.md` referencing the removed 7d/30d range
      selector, a stale `aws.module.ts` docstring mention of Cost Explorer,
      an inaccurate `FileManagerService` SDK-client claim, a missing
      `SchedulerService` in two `management-app.md` enumerations, and a
      stale/dangling KPI-tile-cadence note in `dashboard.md`'s Polling
      section. Final pass clean.
- [x] 4.6 Open PR `costexplorer-4-docs-iam` against `costexplorer-3-e2e`.
      → [#433](https://github.com/CoderCoco/Hyveon/pull/433)

## 5. Close out

- [ ] 5.1 Once all 4 PRs in the stack are merged to `main`, run
      `/opsx:sync` (or `/opsx:archive` if no further follow-up work is
      expected) so `openspec/specs/` gains the new `cost-visibility`
      capability.
