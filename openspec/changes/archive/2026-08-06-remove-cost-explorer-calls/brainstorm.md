<!--
Raw capture of superpowers:brainstorming output.
-->

## Background

AWS Cost Explorer bills $0.01 per API request. Hyveon calls
`GetCostAndUsage` automatically, without the operator asking for it, in two
places:

- **Dashboard** (`dashboard.page.tsx:29-31`) — fires `costsActual()` once on
  every mount (every navigation to `/`).
- **Costs page** (`costs.page.tsx:148-180`) — fires `costsActual(days*2)` on
  mount *and* on every 7d/30d range toggle.

No background poller hits it (the 20s status poller explicitly skips costs —
comment in `game-status-provider.component.tsx` confirms cost estimates are
fetched once on mount, not on every poll tick). So real operator-visible
billing spikes (117 requests in one day, recurring 11-42/day) trace back to
normal navigation and range-toggling, each one silently billing $0.01 with
no operator awareness it's happening.

User's stated requirement: the app should not cause the user to incur AWS
charges just from using it. Estimates (computed from Fargate task-definition
CPU/memory — free, no AWS billing API involved) are an acceptable substitute
in-app. Real billed numbers should be one click away in the actual AWS Cost
Explorer console, not silently re-fetched by the app.

## Decision chain

**Q1: Should the app ever call Cost Explorer automatically, or only on
explicit user action?**

Options considered:
- Explicit-only (button click triggers one fetch)
- Fully remove, link out only
- Keep automatic but throttle/cache client-side

→ **Decided: Fully remove, link out only.** No live CE calls anywhere,
ever. Zero risk of surprise charges beats convenience of in-app actuals.

**Q2: Dashboard KPI strip has two tiles driven by actual CE data ("Spend
today", "Forecast MTD") — with CE calls removed there's no data source for
them. What should replace them?**

Options considered:
- Swap for live estimate tiles computed from existing free data
- Drop to 2 tiles (Servers running, Active alerts only)
- Single link-out CTA tile

→ **Decided: Swap for live estimate tiles.** "Current run rate" (Σ
`costPerHour` over games currently `state === 'running'`, from the existing
`estimates` prop already passed into `KpiStrip` — no new call) and "Est.
month cap" (existing `totalPerHourIfAllOn × 24 × daysInMonth` math, already
computed as `budgetText` today, just promoted from a delta-line to a
first-class tile value). Both are free and always available — no CE
dependency.

**Q3: Costs page currently has 3 actuals-driven UI pieces: total-spend card
w/ delta-vs-prior pill, and the daily stacked-by-game bar chart. With no CE
calls, what happens to them?**

Options considered:
- Remove all, add a CE link-out card
- Remove UI, no replacement card (link lives elsewhere only)

→ **Decided: Remove all, add CE link-out card.** Drop the total-spend card,
delta pill, and stacked chart entirely — there's no data left to compute
them from. Replace with a callout card: "See real billed spend → AWS Cost
Explorer" linking out. The per-game estimates table (already free — driven
by ECS `getTaskDefinition()`, not CE) stays as the page's main content.

**Q4: How should the AWS Cost Explorer link work?**

Options considered:
- Plain console home link (static URL)
- Deep-link with date-range/filter query params

→ **Decided: Plain console home link.** CE's URL query-param format for
pre-filtering is undocumented and could change silently, breaking the link
with no warning. A static link to the console home is simple and never
breaks; the operator picks their own date range/filters once there.

## Scope discovery (grep across main branch, excluding /dist and other
worktrees)

Confirmed touchpoints, ~24 files:

- **Types/interface**: `@hyveon/shared/src/cloud.ts` (`CloudProvider`
  interface's `getActualCosts`, `ActualCosts`/`CostBreakdown` types) +
  `cloud.test.ts`
- **Provider impl**: `cloud-aws/src/AwsCloudProvider.ts` (uses
  `CostExplorerClient`/`GetCostAndUsageCommand` from
  `@aws-sdk/client-cost-explorer`) + `AwsCloudProvider.test.ts`,
  `index.test.ts`, `cloud-aws/package.json` (drop the SDK dependency)
- **Service**: `desktop-main/src/services/CostService.ts`
  (`getActualCosts` — `estimateForSpec` is pure math and is unaffected) +
  `CostService.test.ts`
- **IPC controller**: `desktop-main/src/controllers/costs.controller.ts`
  (`costs.actual` `@MessagePattern`) + `costs.controller.test.ts`,
  `cloud-provider.module.test.ts`
- **Preload bridge**: `desktop-preload/src/hyveon-api.ts`, `preload.ts`
- **Web API service**: `web/src/api.service.ts` (`costsActual()`) +
  `api.service.test.ts`
- **UI**: `web/src/components/kpi-strip.component.tsx`,
  `web/src/pages/costs.page.tsx`, `costs.page.test.tsx`,
  `web/src/pages/dashboard.page.tsx`, `dashboard.page.test.tsx`
- **E2E**: `web/e2e/fixtures/{electron-launch,game-data,index}.ts`,
  `web/e2e/screenshots/demo-data.ts`, `web/e2e/specs/{costs,discord}.spec.ts`
- **Docs**: `docs/docs/app/costs.md`, `docs/docs/app/dashboard.md`,
  `docs/docs/components/management-app.md`
- **IAM**: `docs/docs/setup.md` — the `HyveonDeployAll` policy grants
  `ce:*`; since nothing will call CE anymore, this should be dropped
  (least privilege). Checked `app/packages/desktop-main/resources/
  cloudformation/iam-bootstrap.yaml` (the guided-IAM wizard's runtime
  policy) — it does not grant any `ce:` actions today, so this cleanup is
  scoped to `setup.md`'s deploy policy only.

## PR-stack breakdown (per `.claude/rules/pr-stacking.md`)

Touching ~24 files across backend/frontend/e2e/docs qualifies as a large
change needing a stack, not one PR:

1. `costexplorer-1-frontend` (base: main) — UI swap (dashboard tiles, costs
   page, kpi-strip). Backend endpoint still exists but gets zero callers —
   typechecks clean on its own.
2. `costexplorer-2-backend` (base: 1) — delete the IPC handler,
   service/provider methods, shared types, preload bridge, SDK dependency.
3. `costexplorer-3-e2e` (base: 2) — update e2e fixtures/specs that mock
   actual-cost data.
4. `costexplorer-4-docs-iam` (base: 3) — rewrite `costs.md`, `dashboard.md`,
   `management-app.md`; strip `ce:*` from `setup.md`.

## Approved design (user sign-off)

User confirmed this design in full ("yes looks good, use /opsx:propose")
before this change was scaffolded.
