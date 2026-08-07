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

- [ ] 2.1 `@hyveon/shared/src/cloud.ts`: remove `getActualCosts` from the
      `CloudProvider` interface and the `ActualCosts`/`CostBreakdown` types.
      Update `cloud.test.ts`.
- [ ] 2.2 `cloud-aws/src/AwsCloudProvider.ts`: delete the `getActualCosts`
      implementation and the `CostExplorerClient`/`GetCostAndUsageCommand`
      import; remove `@aws-sdk/client-cost-explorer` from
      `cloud-aws/package.json`. Update `AwsCloudProvider.test.ts` and
      `index.test.ts`.
- [ ] 2.3 `desktop-main/src/services/CostService.ts`: delete
      `getActualCosts` (keep `estimateForSpec`). Update `CostService.test.ts`.
- [ ] 2.4 `desktop-main/src/controllers/costs.controller.ts`: delete the
      `costs.actual` `@MessagePattern` handler. Update
      `costs.controller.test.ts` and `cloud-provider.module.test.ts`.
- [ ] 2.5 `desktop-preload/src/hyveon-api.ts` and `preload.ts`: remove the
      `costs.actual` bridge method.
- [ ] 2.6 `web/src/api.service.ts`: remove `costsActual()`. Update
      `api.service.test.ts`.
- [ ] 2.7 Run `npm run app:lint`, `npm run app:typecheck`, `npm run
      app:test`, `npm run app:test:integration` (controller/IPC surface
      changed) — all clean.
- [ ] 2.8 Open PR `costexplorer-2-backend` against `costexplorer-1-frontend`.

## 3. E2E — update fixtures and specs (PR: `costexplorer-3-e2e`, base: PR 2's branch)

- [ ] 3.1 Update `web/e2e/fixtures/electron-launch.ts`,
      `web/e2e/fixtures/game-data.ts`, `web/e2e/fixtures/index.ts`, and
      `web/e2e/screenshots/demo-data.ts` to drop actual-cost mock data and
      any `costs.actual` IPC stubbing.
- [ ] 3.2 Update `web/e2e/specs/costs.spec.ts` to assert the new Costs page
      (estimates table + CE link-out card, no chart/total-spend card, no
      range selector).
- [ ] 3.3 Update `web/e2e/specs/discord.spec.ts` if it depends on
      dashboard/costs mock data affected by the removal.
- [ ] 3.3a Update `web/e2e/specs/dashboard.spec.ts` — it asserts the literal
      old `'Spend today'`/`'Forecast MTD'` tile labels; update to the new
      `'Current run rate'`/`'Est. month cap'` labels.
- [ ] 3.3b Update `web/e2e/fixtures/hyveon-http-bridge.ts` — it hardcodes a
      `costs.actual` → `/api/costs/actual` HTTP mapping for the chromium
      e2e tier; remove it alongside the IPC channel removal.
- [ ] 3.4 Run `npm run app:test:e2e` — all clean.
- [ ] 3.5 Open PR `costexplorer-3-e2e` against `costexplorer-2-backend`.

## 4. Docs and IAM cleanup (PR: `costexplorer-4-docs-iam`, base: PR 3's branch)

- [ ] 4.1 Rewrite `docs/docs/app/costs.md` to describe estimate-only
      display plus the AWS Cost Explorer link-out; remove references to the
      removed chart/total-spend card and the "Cost Explorer must be
      enabled" caveat section (no longer applicable — the app never calls
      it).
- [ ] 4.2 Rewrite `docs/docs/app/dashboard.md`'s KPI tile descriptions
      ("Spend today" / "Forecast MTD" → "Current run rate" / "Est. month
      cap").
- [ ] 4.3 Update `docs/docs/components/management-app.md`'s
      `CostsController` row (drop the `costs.actual` channel and its Cost
      Explorer description).
- [ ] 4.4 Remove `"ce:*"` from the `HyveonDeployAll` IAM policy in
      `docs/docs/setup.md`.
- [ ] 4.5 Run the `write-docs` skill's evaluator agents (accuracy,
      coverage, style) over the changed docs pages.
- [ ] 4.6 Open PR `costexplorer-4-docs-iam` against `costexplorer-3-e2e`.

## 5. Close out

- [ ] 5.1 Once all 4 PRs in the stack are merged to `main`, run
      `/opsx:sync` (or `/opsx:archive` if no further follow-up work is
      expected) so `openspec/specs/` gains the new `cost-visibility`
      capability.
