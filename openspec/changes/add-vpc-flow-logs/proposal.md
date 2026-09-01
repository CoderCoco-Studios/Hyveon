## Why

Hyveon has no network-layer observability today — only per-game and per-Lambda
CloudWatch application logs exist (`infra-log-viewer`). When a game server is
reachable on one path but not another (e.g. a Palworld server accepting direct
UDP connections but never appearing/connecting through the in-game server
browser, which depends on the task successfully reaching Palworld's backend
outbound), there is no way to tell, from inside the app, whether traffic is
being dropped at the security-group/VPC layer versus failing somewhere in the
game process itself. The only current workaround is enabling VPC Flow Logs by
hand in the AWS console, which is undiscoverable, not reproducible across
environments, and leaves no record in the app.

## What Changes

- Add a Pulumi-managed VPC Flow Log resource for the Hyveon VPC, publishing to
  a dedicated CloudWatch Logs log group (tagged `Project=hyveon`, following the
  existing per-resource tagging convention).
- Capture `REJECT`-and-`ACCEPT` traffic (all traffic) by default so both
  "blocked inbound" and "blocked outbound" cases are diagnosable from the same
  log group, with the standard VPC Flow Logs v5+ field set.
- Add an IAM role/policy permitting the VPC Flow Logs service to publish to
  the new log group, scoped to that single log group ARN.
- Extend the app's log-viewing surface (the pattern established by
  `infra-log-viewer`'s Lambda log fetch/tail) so operators can fetch recent
  flow log records and filter to `REJECT` action from the Infrastructure page,
  without leaving the app or touching the AWS console.
- Add a `deployment-config`-level toggle (default **on**, since Flow Logs bill
  by ingested volume) so operators can disable flow log collection entirely if
  they want to avoid the CloudWatch Logs ingestion cost.

## Capabilities

### New Capabilities

- `vpc-flow-logs`: Pulumi-managed VPC Flow Log publishing to a dedicated
  CloudWatch Logs group, its supporting IAM role, the deployment-config
  enable/disable toggle, and an app-side fetch/filter surface for viewing
  recent flow log records (mirroring the fetch/tail contract
  `infra-log-viewer` already establishes for Lambda logs).

### Modified Capabilities

(none — `infra-log-viewer` is not modified; its existing Lambda-log
requirements are unchanged. The new flow-log viewing behavior is specified
under the new `vpc-flow-logs` capability so its requirements and the resource
it depends on stay in one place.)

## Impact

- **`app/packages/infra`**: new flow-log Pulumi resource(s) (likely a new
  `flowLogs.ts`), a new IAM role/policy, a new CloudWatch Logs log group,
  wired into the VPC definition. Adds a new stack output (the flow-log log
  group name) for the desktop app to read.
- **`@hyveon/shared`**: extend `DeploymentConfig` with the flow-log
  enable/disable toggle.
- **`app/packages/desktop-main`**: extend the existing log-fetching service
  (or add a sibling to it) with a flow-log-group fetch/tail method; a new or
  extended IPC controller endpoint.
- **`@hyveon/web`**: extend the Infrastructure/Logs page to surface flow log
  records, with a `REJECT`-only filter.
- **Cost**: CloudWatch Logs ingestion/storage charges scale with VPC traffic
  volume — must be called out in `docs/docs/components/infra.md` and the
  toggle's UI copy.
- **Docs**: `docs/docs/components/infra.md` (new resource in the file/resource
  table), relevant `docs/docs/app/*` page for the Infrastructure/Logs UI
  surface, `docs/docs/app/games.md` or a troubleshooting guide referencing
  this as the diagnostic path for "server reachable one way, not another"
  reports.
