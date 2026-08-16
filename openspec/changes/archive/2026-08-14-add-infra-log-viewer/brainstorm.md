<!--
Raw capture of superpowers:brainstorming output.
-->

# Brainstorm: Infrastructure Lambda log viewer

## Background

The user asked where watchdog Lambda logs are visible in the app. Investigation
(via `graphify` + reading `LogsService.ts` and `docs/docs/app/logs.md`) found:

- The app's `/logs` page only tails ECS game-server CloudWatch logs
  (`/ecs/{game}-server`) via `LogsService.streamLogs`/`getRecentLogs`.
- `docs/docs/app/logs.md` explicitly states: "It does not show Lambda logs.
  Those are in CloudWatch under the Lambdas' own log groups."
- All 5 Lambda packages (`watchdog`, `health-check`, `dns-updater`,
  `interactions`, `followup`) get a deterministically-named CloudWatch log
  group provisioned in `app/packages/infra/src/lambdas.ts`:
  `/aws/lambda/${projectName}-{watchdog|health-check|dns-updater|interactions|followup}`.
- `projectName` is a `DeploymentConfig` field, defaulting to `'hyveon'`.

Classified as **bounded**: `LogsService` already has a working tail/fetch flow
for one log-group family (ECS); this extends it to a second family (Lambda)
by reusing the same CloudWatch Logs client and UI patterns. No new
subsystem, no new external integration.

## Decision chain

**Q1 — Scope: which Lambdas get in-app log viewing?**
Options: watchdog only / all 5 Lambdas / watchdog + health-check.
→ **Decided: all 5 Lambdas** (`watchdog`, `health-check`, `dns-updater`,
`interactions`, `followup`). One generic viewer with a function picker,
rather than a one-off for watchdog that would need rework later.

**Q2 — UI placement**
Options offered: new sibling page `/logs/lambdas`; a tab inside the existing
`/logs` page; a section on the Infrastructure page.
→ User proposed a fourth option instead: a **nested sidebar group** —

```
Logs
----Games
----Infrastructure
```

Checked `app/packages/web/src/components/app-layout.component.tsx`: the
sidebar currently renders a flat `NavItem[]` list under two section headings
(`Monitoring`, `Configuration`) — there's no existing nested/collapsible nav
pattern. Decided this doesn't need generic collapsible-nav infrastructure
since there are only 2 children: replace the single `Logs` `NavItem` with an
always-expanded `Logs` group header + two child links, nested under
Monitoring.

**Q3 — Route structure**
Options: keep `/logs` as the Games page + add `/logs/infrastructure`
(no redirect, no broken links); or symmetric `/logs/games` +
`/logs/infrastructure` (requires a redirect from bare `/logs` or accepts a
break).
→ **Decided: `/logs` (Games, unchanged) + `/logs/infrastructure` (new)**.
Preserves existing URL/docs/screenshots.

**Q4 — Tail behavior**
Options: live poll (same pattern as game logs, `FilterLogEvents` every
~2s via a function-key dropdown); or on-demand fetch only (a "Load recent
logs" button, no polling, since Lambdas here are low-frequency/scheduled).
→ **Decided: live poll, same as game logs.** Watchdog runs every few
minutes; near-live tailing is useful to confirm a run just happened, and it
keeps UX consistent with the existing `/logs` page rather than introducing a
second interaction model.

## Design (approved)

**Sidebar nav** (`app/packages/web/src/components/app-layout.component.tsx`):
replace the flat `Logs` entry with a `Logs` group under Monitoring,
always-expanded, two children:
- `Games` → `/logs` (existing page, unchanged)
- `Infrastructure` → `/logs/infrastructure` (new)

**Backend** — extend `LogsService`
(`app/packages/desktop-main/src/services/LogsService.ts`), not
`CloudProvider`, since Lambda log groups are an AWS-specific naming detail,
not a cloud-agnostic "workload" concept:
- `getRecentLambdaLogs(functionKey, limit)` and
  `streamLambdaLogs(functionKey, signal, pollInterval)`, mirroring the
  existing `getRecentLogs`/`streamLogs` but building the log group as
  `/aws/lambda/${projectName}-${functionKey}` (reads `projectName` from
  `DeploymentConfigService`/`DeploymentConfig`, defaults `'hyveon'`) instead
  of `/ecs/{game}-server`.
- `functionKey` is a fixed union matching the exact suffixes used in
  `app/packages/infra/src/lambdas.ts`:
  `'watchdog' | 'health-check' | 'dns-updater' | 'interactions' | 'followup'`.
- Reuses the same lazily-cached `CloudWatchLogsClient` already in
  `LogsService`.

**Controller/IPC**: new `@MessagePattern`s on the logs controller, same
shape/naming convention as the existing game-log channels (e.g.
`iac.logs.lambda.getRecent`, `iac.logs.lambda.stream`), logged on entry per
the repo's IPC logging rule (`.claude/rules/logging.md`).

**Preload bridge**: expose the new channels the same way the existing
game-log channels are exposed.

**Frontend**: new `/logs/infrastructure` routed page — a function-picker
dropdown (5 options: watchdog, health-check, dns-updater, interactions,
followup) + the same live-tail UI component the existing `/logs` game page
already uses, pointed at the new IPC channels.

**Testing**: unit tests for the two new `LogsService` methods (mirroring
`LogsService.test.ts`), controller tests, a jsdom routed-page spec for the
new page (per this repo's jsdom component/routed-page conventions), e2e
stub coverage for the nested nav + new route.

**Explicitly out of scope**: no CloudWatch Insights queries, no
cross-function search, no log retention/export UI, no changes to Pulumi
infra provisioning (all 5 Lambda log groups already exist and are
deterministically named — this is a pure read/display feature). No changes
to `CloudProvider`'s cloud-agnostic interface.

## Workflow routing decision

Per `.claude/rules/spec-driven-development.md`'s "New feature / new
capability" → opsx rule, and confirmed with the user: this goes through
OpenSpec (`/opsx:propose`) rather than a direct PR, since it spans
IPC/service/UI. Scaffolded in a fresh worktree/branch
(`worktree-add-infra-log-viewer`) off `main`, per `.claude/rules/worktree.md`.
