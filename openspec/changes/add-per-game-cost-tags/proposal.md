## Why

Cost Explorer cannot break spend down by game today because only
`Project=hyveon` is tagged (applied once at the Pulumi provider level).
Per-game AWS resources have no dedicated tag, and dynamically-launched ECS
Fargate tasks — the largest cost driver — get no tags at all at runtime, so
even a tag on the task definition wouldn't reach the billed resource.
`cost-visibility` already links operators out to the AWS Cost Explorer
console for real billed spend; that link is far less useful without a way to
filter by game once there.

## What Changes

**Per-game resource tagging**
- From: Only `Project=hyveon` (provider-level default) is tagged; no
  resource carries a per-game identifier beyond a `Name` string.
- To: A new `Game` tag key (value = game id, e.g. `Game=palworld`) is added
  to the AWS resources whose cost Cost Explorer can actually attribute per
  game: ECS task definitions, their CloudWatch log groups, and the
  per-game EFS-seeder Lambda + its log group.
- Reason: These are the only per-game resources with independently metered
  cost. Resources that are shared across all games (ECS cluster, security
  groups, DynamoDB tables, the four project-wide Lambdas) keep only the
  `Project` tag — adding `Game` there would be misleading, not useful. EFS
  is deliberately excluded: it's one shared filesystem billed at the
  filesystem level, so tagging its per-game access points would not enable
  a per-game cost split (access points aren't separately billed resources).
- Impact: Non-breaking, infra-only. `app/packages/infra` Pulumi resource
  definitions change tags; no `DeploymentConfig` schema change.

**Runtime tag propagation for ECS tasks**
- From: `RunTaskCommand` does not set `propagateTags`, so live Fargate
  tasks (the actual billed compute) carry no tags regardless of what the
  task definition has.
- To: `RunTaskCommand` sets `propagateTags: 'TASK_DEFINITION'` so running
  tasks inherit `Game` from their task definition.
- Reason: Without this, tagging the task definition is cosmetic — the
  resource AWS actually bills for (the running task) stays untagged.
- Impact: Non-breaking. `app/packages/cloud-aws/src/AwsCloudProvider.ts`
  only.

**Cost allocation tag activation and operator documentation**
- From: No documented path for an operator to see a per-game cost
  breakdown.
- To: `docs/docs/components/infra.md` documents the new `Game` tag in its
  resource/tag table, plus a short note that `Game` (and `Project`) must be
  activated as a cost allocation tag in the AWS Billing console (a manual,
  one-time, non-retroactive step, ~24h to appear) before Cost Explorer can
  group by it.
- Reason: This is an AWS account-level setting Pulumi cannot provision; it
  must be documented rather than automated, or operators won't discover it.
- Impact: Docs-only.

## Capabilities

### New Capabilities
(none)

### Modified Capabilities
- `cost-visibility`: adds a requirement that per-game AWS resources with
  independently metered cost carry a `Game` tag, and that dynamically
  launched ECS tasks propagate it, so the existing Cost Explorer console
  link-out can be filtered per game.

## Impact

- `app/packages/infra/src/ecs.ts` — add `Game` tag to task definitions and
  log groups.
- `app/packages/infra/src/lambdas.ts` — add `Game` tag to the EFS-seeder
  Lambda and its log group.
- `app/packages/cloud-aws/src/AwsCloudProvider.ts` — `RunTaskCommand` gets
  `propagateTags: 'TASK_DEFINITION'`.
- `app/packages/infra/src/ecs.test.ts` / `app/packages/infra/src/lambdas.test.ts`
  — extend tag assertions.
- `docs/docs/components/infra.md` — resource/tag table + cost allocation
  tag activation note.
- No `DeploymentConfig`/`GameServerConfig` field changes. No IPC/API
  surface changes. No breaking changes.
