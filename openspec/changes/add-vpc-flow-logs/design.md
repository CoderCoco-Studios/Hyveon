## Context

See `proposal.md` - Why. Relevant current state:

- `app/packages/infra/src/network.ts`'s `defineNetwork` declares the VPC,
  internet gateway, public subnets, route table — no flow log resource exists
  anywhere in the program.
- `app/packages/desktop-main/src/services/LogsService.ts` already establishes
  the fetch/page/tail contract this feature should reuse: `getRecentLogs`
  (newest-stream snapshot), `getOlderLogs`/`getNewerLogs` (multi-stream
  cursor paging), `streamLogs` (poll-based tail) — each with a Lambda-flavored
  twin (`getRecentLambdaLogs`, etc.) that only differs in how the log group
  name resolves. VPC Flow Logs write to a single CloudWatch Logs log group
  with normal log streams (one per network interface), so the *existing*
  multi-stream paging logic applies unchanged — only log-group resolution and
  event-line parsing (flow log records are pipe-delimited fields, not free
  text) differ from the game/Lambda cases.
- `docs/docs/components/infra.md`'s resource table documents every
  Pulumi-declared resource; this feature adds one row (log group) plus a note
  on the IAM role/policy.
- `DeploymentConfig` (`@hyveon/shared`) is the single source of truth for
  operator-editable settings and already holds top-level, non-per-game
  settings (region, watchdog tunables) alongside `gameServers`.

## Goals / Non-Goals

**Goals:**
- Make network-layer accept/reject visibility available from inside the app,
  scoped to the existing VPC, with no new AWS resource type the operator has
  to reason about beyond "a log group."
- Reuse `LogsService`'s existing fetch/page/tail contract rather than
  inventing a parallel one.
- Default to enabled, but let an operator turn it off before their first
  `apply` if they want to avoid CloudWatch Logs ingestion cost, since Flow
  Logs bill per GB ingested regardless of traffic outcome (accept or reject).

**Non-Goals:**
- No alerting/dashboards/metric filters on flow log content — this ships raw
  record fetch/filter only, matching `LogsService`'s existing read-only scope
  for game/Lambda logs. Alerting can be a later change if operators want it.
- No per-game or per-port flow log scoping — the VPC-level flow log covers all
  traffic through the VPC's ENIs; this is intentional (a rejected packet on a
  port nobody declared is exactly the case operators need to see) rather than
  a limitation to work around.
- Not touching `infra-log-viewer`'s existing Lambda-log requirements or its
  spec — this is additive, a sibling data source in the same UI area.

## Decisions

**D1: VPC-level Flow Log resource, not one per subnet/ENI.**
`aws.ec2.FlowLog` scoped to `vpc.id` (from `defineNetwork`'s returned
`NetworkResources.vpc`) captures every ENI in the VPC, including ECS task
ENIs, in one resource. Alternative considered: per-subnet flow logs — rejected
because it multiplies resource count for no additional coverage (Hyveon's two
public subnets are the VPC's entire subnet set today) and would need updating
if the subnet topology ever changes.

**D2: `trafficType: 'ALL'`, not `'REJECT'`-only.**
Capturing both directions lets an operator confirm "traffic reached the ENI
and was accepted" as a control case, not just see rejects in isolation —
useful for distinguishing "network layer is fine, the game process itself
never responded" from "network layer dropped it," which is exactly the
ambiguity that motivated this proposal (Palworld's direct-connect-works,
browser-connect-fails case could be either). The app's fetch/filter layer
defaults the UI to a `REJECT`-only view (proposal's stated UX) without
requiring a second log group.

**D3: New CloudWatch Logs log group + a dedicated IAM role, not S3 destination.**
CloudWatch Logs matches every other log destination in this program (ECS task
logs, Lambda logs) and lets `LogsService` reuse the same SDK client and paging
primitives already in place. S3 delivery (Flow Logs' other native option)
would need a second, S3-flavored read path in the desktop app for no benefit,
since nothing else here reads flow logs from S3. The IAM role is scoped to
`logs:CreateLogStream`/`PutLogEvents` on exactly the new log group's ARN,
mirroring the least-privilege pattern the existing Lambda execution roles
already use in `iam.ts`.

**D4: Log group naming `/vpc/${projectName}-flow-logs`, distinct namespace
from `/ecs/{game}-server` and `/aws/lambda/{projectName}-{functionKey}`.**
Keeps the three log-group families visually distinguishable in the AWS
console and in `LogsService`'s group-resolution code without a naming
collision risk (no game or Lambda function key could produce this prefix).

**D5: Extend `LogsService` with a third resolution family
(`getRecentFlowLogs`/`getOlderFlowLogs`/`getNewerFlowLogs`/`streamFlowLogs`),
not a new service class.**
The multi-stream paging engine (`fetchAcrossStreams`, `listStreams`,
`MAX_STREAMS_SCANNED`) is entity-agnostic already — it only needs a resolved
log group name — so a fourth thin wrapper (after game/Lambda's two) costs one
new log-group resolver function, not a duplicated paging implementation.
Flow log record parsing (splitting the pipe-delimited field string, and
optionally filtering to `action = REJECT`) happens as a pure transform over
`LogEventLine.message` at the call site (controller/renderer boundary),
keeping `LogsService` itself protocol-agnostic like it is for game/Lambda
text lines today.

**D6: `DeploymentConfig` toggle is a simple boolean
(`vpcFlowLogsEnabled`, default `true`), not a richer config (retention days,
traffic-type selection).**
Matches the proposal's stated scope (on/off for cost control) and the
project's stated principle that a `DeploymentConfig` field should exist
because an operator needs to set it, not because the underlying AWS API
supports more knobs than that. `trafficType: 'ALL'` (D2) and log retention
(CloudWatch Logs default: never-expire, matching every other log group this
program already creates) stay fixed, not operator-configurable, until a real
need for per-operator tuning shows up.

## Risks / Trade-offs

- **Cost surprise** → Mitigation: default-on with an explicit `DeploymentConfig`
  toggle (D6), and `docs/docs/components/infra.md` must state that Flow Logs
  bill per GB ingested by CloudWatch Logs, independent of accept/reject
  outcome, so a high-traffic deployment sees a corresponding line-item.
- **Flow log records lag behind real time** by design (AWS aggregates flow
  log records over a ~1 minute capture window before publishing) → Mitigation:
  state this explicitly in the UI copy next to the flow-log view, the same way
  `streamLogs`'s poll interval is a known latency bound, not a bug to chase.
- **Toggling the flag off after `apply` orphans the existing log group**
  (Flow Log resource is destroyed, log group is not, by AWS default) →
  Mitigation: match existing Pulumi behavior for every other log group in this
  program (none are force-deleted on teardown either) rather than special-case
  this one; call out log-group cleanup as a manual AWS-console step in docs,
  consistent with how the rest of the program already handles log group
  lifecycle.

## Migration Plan

Purely additive — a new resource, a new config field defaulting to enabled,
and a new UI surface. No existing resource, config shape, or API changes.
Rollback is deleting the Flow Log resource, IAM role, and log group via a
Pulumi `destroy`/`apply` of the reverted program; no data migration is
involved since flow log records are ephemeral CloudWatch Logs content, not
state Hyveon persists elsewhere.
