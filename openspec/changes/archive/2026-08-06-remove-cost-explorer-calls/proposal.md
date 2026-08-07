## Why

AWS Cost Explorer bills $0.01 per `GetCostAndUsage` API request. Hyveon
currently calls it automatically and invisibly — once on every Dashboard
mount, and again on every Costs-page mount or 7d/30d range toggle — so
normal navigation silently charges the operator's AWS bill (confirmed
against real account charges: 117 requests in a single day, 11-42/day
recurring). The app should never cause AWS spend on its own; cost estimates
computed from Fargate task-definition specs are free and already exist in
the app, and real billed numbers belong in the AWS Cost Explorer console
itself, not behind a repeated paid call the operator doesn't know is firing.

## What Changes

**Cost Explorer API calls**
- From: `costsActual()` fires automatically on Dashboard mount and on
  Costs-page mount/range-change, each firing a billed
  `GetCostAndUsage` request.
- To: The app makes zero Cost Explorer API calls, ever. No automatic fetch,
  no manual "fetch actuals" button — the capability is removed end-to-end
  (IPC channel, service method, provider method, SDK dependency).
- Reason: Eliminate all AWS spend the app causes without the operator
  explicitly incurring it elsewhere (i.e. not via this app).
- Impact: Breaking for any operator relying on in-app actual-spend figures;
  they now use the AWS Cost Explorer console directly, reached via an
  in-app link.

**Dashboard KPI strip**
- From: "Spend today" and "Forecast MTD" tiles, both driven by
  `costsActual()`.
- To: "Current run rate" (Σ `costPerHour` across currently-running games)
  and "Est. month cap" (`totalPerHourIfAllOn × 24 × daysInMonth`) — both
  computed from the existing free per-game Fargate estimate, already
  fetched via ECS `getTaskDefinition()`.
- Reason: Replace actuals-only tiles with equivalent-value tiles that need
  no CE call.
- Impact: Non-breaking visually (still 4 tiles, same position); the
  numbers now represent an estimate/cap rather than billed history.

**Costs page**
- From: Total-spend card with delta-vs-prior-period pill, and a daily
  stacked-by-game bar chart, both sourced from `costsActual()`.
- To: Those three elements are removed (no data source remains). A callout
  card links out to the AWS Cost Explorer console home for real billed
  figures. The per-game estimates table (ECS-spec-derived, already free)
  remains the page's main content.
- Reason: No free substitute exists for historical billed-spend charting;
  point operators to the authoritative source instead of approximating.
- Impact: Breaking — the page loses its historical spend visualization.

## Capabilities

### New Capabilities
- `cost-visibility`: What the app shows operators about game-server cost —
  free Fargate-spec-derived estimates in-app, plus a link out to the AWS
  Cost Explorer console for real billed figures. Explicitly governs that
  the app makes no AWS Cost Explorer API calls.

### Modified Capabilities
(none — no existing spec capability governs cost display today)

## Impact

- **Removed**: `CloudProvider.getActualCosts` + its `DateRange` param type
  (`@hyveon/shared` — `CostBreakdown` stays, it's still `getCostEstimate()`'s
  unrelated return type), `AwsCloudProvider.getActualCosts` +
  `@aws-sdk/client-cost-explorer` dependency (`cloud-aws`),
  `CostService.getActualCosts` and its now-unused `CLOUD_PROVIDER`
  constructor injection (`desktop-main`), `costs.actual` IPC
  `@MessagePattern` (`costs.controller.ts`), the `costs.actual` preload
  bridge method, `api.service.ts`'s `costsActual()`, and the
  desktop-main/preload/web `ActualCosts` type (unrelated to shared's
  `CostBreakdown`).
- **Changed**: `kpi-strip.component.tsx` (new tile logic, drops
  `actualCosts` prop), `dashboard.page.tsx` (drops the fetch effect),
  `costs.page.tsx` (drops actuals UI, adds CE link-out card).
- **Docs**: `docs/docs/app/costs.md`, `docs/docs/app/dashboard.md`,
  `docs/docs/components/management-app.md` need rewriting to describe
  estimate-only + link-out behavior. `docs/docs/setup.md`'s
  `HyveonDeployAll` IAM policy drops `ce:*` (least privilege — nothing
  calls CE anymore).
- **Tests**: unit tests for every removed method/component prop, plus e2e
  fixtures/specs currently mocking actual-cost data (~24 files total,
  enumerated in `brainstorm.md`).
- **No infra/Pulumi changes** — this is app-code and IAM-policy-doc only.
