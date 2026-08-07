## Context

AWS Cost Explorer bills $0.01 per `GetCostAndUsage` request. Two React
effects call it without the operator asking:

- `dashboard.page.tsx:29-31` — on every mount of `/`.
- `costs.page.tsx:148-180` — on every mount of `/costs` and every 7d/30d
  range toggle (`useCostsData`'s `useEffect([days])`).

No background/interval poller is involved — the 20s status poller
explicitly skips cost data (`game-status-provider.component.tsx` comment).
The charges are a direct, linear function of navigation frequency, and nine
places in the codebase (types → provider → service → IPC → preload →
web API → 2 UI surfaces → tests) currently participate in producing them.

Two consumers depend on the actuals data today:
- `KpiStrip` — "Spend today" and "Forecast MTD" tiles.
- `CostsPage` — total-spend card, delta-vs-prior pill, stacked daily chart.

Both also already receive **free** data: `CostEstimates` (per-game
`costPerHour`/`costPerDay24h`/`costPerMonth4hpd`, computed from each game's
Fargate task-definition CPU/memory via `CostService.estimateForSpec` — pure
arithmetic, ECS `DescribeTaskDefinition` is not a billed API) and
`GameStatus[]` (current running state per game).

## Goals / Non-Goals

**Goals:**
- Zero AWS Cost Explorer API calls from the app, under any code path,
  automatic or manual.
- Preserve cost visibility in the UI using only free data sources
  (Fargate-spec estimates, current run state).
- Give operators a one-click path to real billed figures in the actual AWS
  Cost Explorer console.
- Reduce the app's IAM footprint to match (drop `ce:*`).

**Non-Goals:**
- Building a manual "fetch actuals on demand" button. Considered and
  rejected during brainstorming (Q1) — the user wants zero exposure, not
  reduced exposure.
- Replacing the removed historical bar chart with any other data source
  (e.g. CloudWatch, a self-maintained running-time ledger). No free
  equivalent exists; out of scope for this change.
- Any infra/Pulumi resource changes — this is app code + one IAM policy
  doc.

## Decisions

### D1: Remove Cost Explorer calls entirely rather than gate/throttle them
- **Choice**: Delete the call chain end-to-end (IPC handler, service
  method, provider method, SDK dependency) instead of caching or rate
  limiting.
- **Rationale**: A cache/throttle still bills at least once per cache
  window with zero operator visibility into when that happens — same
  silent-charge problem, just less frequent. Full removal is the only
  option with zero surprise-billing risk, which is what was asked for.
- **Alternatives considered**: explicit-only fetch (button-triggered, one
  click = one call — rejected, still surprises an operator who doesn't
  read the button's implication); client-side throttle/cache (rejected,
  same reason as above, plus adds cache-invalidation complexity for no
  guarantee).

### D2: Replace, don't remove, the Dashboard KPI cost tiles
- **Choice**: "Current run rate" and "Est. month cap" tiles, both derived
  from data the Dashboard already has in memory (`estimates`, `statuses`)
  with zero new fetches.
- **Rationale**: The KPI strip's value is at-a-glance cost awareness;
  dropping to 2 tiles or a single CTA loses that, and both alternatives
  were explicitly available as options and not chosen. The replacement
  tiles reuse `totalPerHourIfAllOn` (already computed today as
  `budgetText`, previously only shown as a delta line) and a new one-line
  sum over `state === 'running'` games — no new computation surface, no
  new service method.
- **Alternatives considered**: 2-tile strip (rejected — loses cost
  visibility); single link-out CTA tile (rejected — a whole tile spent on
  a link is lower value than two live numbers that cost nothing to show).

### D3: Costs page actuals UI (total-spend card, delta pill, stacked chart) is deleted, not replaced with an approximation
- **Choice**: No client-side approximation (e.g. estimate × elapsed running
  time) stands in for the historical daily/per-game chart. It's removed,
  replaced by a link-out callout card.
- **Rationale**: Any approximation of historical billed spend built from
  estimates would be presented next to a dollar sign, inviting operators to
  trust it as real spend when it isn't (Fargate on-demand pricing ≠ actual
  bill — data transfer, EBS, other line items aren't estimated at all).
  Better to be explicit that real numbers live in the AWS console.
- **Alternatives considered**: none seriously — an approximate historical
  chart was never proposed; it would misrepresent billed cost.

### D4: Link out to the plain AWS Cost Explorer console home, not a deep link
- **Choice**: Static URL to `console.aws.amazon.com`'s Cost Explorer home.
- **Rationale**: AWS's Cost Explorer URL query-param format for
  pre-filtering (date range, service filter) is undocumented and
  unversioned; a deep link could break silently on an AWS console update
  with no signal to us. A static link never breaks.
- **Alternatives considered**: deep-link with date-range/service-filter
  query params (rejected — fragile, undocumented, no test surface since we
  can't assert against AWS's console).

### D5: Drop `ce:*` from the `HyveonDeployAll` IAM policy
- **Choice**: Remove the `ce:*` statement from `docs/docs/setup.md`'s
  policy JSON.
- **Rationale**: Least privilege — once no code path calls any Cost
  Explorer API, granting it is pure unused blast radius.
- **Alternatives considered**: leave it in "in case a future feature needs
  it" — rejected per YAGNI; re-add if/when such a feature is actually
  built. Note: the guided-IAM-wizard runtime policy
  (`iam-bootstrap.yaml`) was checked and already grants no `ce:` actions,
  so this cleanup is scoped to `setup.md`'s deploy policy only.

## Risks / Trade-offs

- [Risk] Operators who relied on the in-app 7-day/30-day spend chart lose
  that view entirely. → Mitigation: the link-out card makes the real,
  authoritative source one click away; the removed view was already a
  "uniform approximation" per-game (documented limitation,
  CoderCoco/Hyveon#61) and account-wide rather than project-scoped, so its
  accuracy was already limited.
- [Trade-off] "Current run rate" / "Est. month cap" are projections, not
  history — an operator can no longer see yesterday's actual spend inside
  the app at all. → Accepted: this is the explicit goal (zero CE calls);
  the AWS console is the correct source for history.
- [Risk] Removing `ce:*` from `setup.md` without also checking for other
  ad hoc CE usage could leave stale permission if something else needs it
  later. → Mitigation: full-repo grep (see `brainstorm.md`) confirms this
  is the only capability that ever called Cost Explorer; no other code
  path is affected.

## Migration Plan

Implemented as a 4-PR stack (`.claude/rules/pr-stacking.md`), each
independently lint/typecheck/test-clean, each based on the previous:

1. **`costexplorer-1-frontend`** (base: `main`) — swap Dashboard KPI tiles,
   remove Costs-page actuals UI + add link-out card, remove
   `dashboard.page.tsx`'s fetch effect. The backend `costs.actual` IPC
   channel still exists at this point but has zero callers — frontend
   typechecks and tests clean on its own without touching the backend.
2. **`costexplorer-2-backend`** (base: 1) — delete
   `CloudProvider.getActualCosts` + types (`@hyveon/shared`),
   `AwsCloudProvider.getActualCosts` + `@aws-sdk/client-cost-explorer` dep
   (`cloud-aws`), `CostService.getActualCosts`, the `costs.actual`
   `@MessagePattern` handler, and the preload bridge method.
3. **`costexplorer-3-e2e`** (base: 2) — update e2e fixtures/specs that
   mock actual-cost data to match the new UI and removed IPC surface.
4. **`costexplorer-4-docs-iam`** (base: 3) — rewrite `costs.md`,
   `dashboard.md`, `management-app.md`; drop `ce:*` from `setup.md`.

No rollback beyond standard PR revert — no data migration, no deployed
infra changes, no persisted state format changes.

## Open Questions

None — all forks were resolved during brainstorming and confirmed with the
user before this change was proposed.
