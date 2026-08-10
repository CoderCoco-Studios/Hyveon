## Context

AWS Cost Explorer cannot currently break Hyveon spend down by game. The
Pulumi infra program applies exactly one tag today — `Project=hyveon` — set
once via `defaultTags` on the two `aws.Provider` instances
(`app/packages/infra/src/program.ts:174,306,316`) and inherited by every
Pulumi-managed resource. Per-game resources are distinguishable only by a
`Name` string (e.g. `${game}-server`), which is not a cost-allocation
mechanism.

The bigger gap is at runtime: game servers run as on-demand ECS Fargate
tasks started via `RunTaskCommand`
(`app/packages/cloud-aws/src/AwsCloudProvider.ts:451-459`), per this
project's no-persistent-Service invariant. `RunTaskCommand` does not set
`propagateTags`, so the actual billed resource (the running task) carries no
tags at all today — even if the task *definition* were tagged, that tag
would not reach the resource AWS meters compute cost against.

`cost-visibility` (existing capability, `openspec/specs/cost-visibility/spec.md`)
already establishes that the app must never call the Cost Explorer API
itself and instead links operators to the AWS Cost Explorer console for real
billed spend. This change makes that link-out actually useful per game by
giving Cost Explorer a `Game` dimension to group and filter by.

## Goals / Non-Goals

**Goals:**
- Let an operator filter/group AWS Cost Explorer by game for every resource
  whose cost is independently metered per game.
- Make the running ECS Fargate task — the dominant cost driver — carry the
  `Game` tag, not just the task definition.
- Document the manual AWS-account-level activation step Pulumi cannot
  provision.

**Non-Goals:**
- Splitting EFS storage cost by game. EFS bills at the filesystem resource
  level; access points (the only per-game EFS construct) are not
  independently billed or metered, so no tag on them changes what Cost
  Explorer can show. Achieving a real per-game EFS split would require
  separate filesystems per game — a materially larger change, not
  justified for a cost component that's small next to Fargate compute.
- Building any in-app cost breakdown UI. `cost-visibility` already forbids
  the app from calling the Cost Explorer API; this change only makes the
  existing console link-out more useful, it doesn't add an in-app view.
- Retroactive tagging of historical cost data. AWS cost allocation tags
  only apply to usage going forward from activation.
- Tagging resources that are shared across all games (ECS cluster, security
  groups, DynamoDB tables, the four project-wide Lambdas). A `Game` tag on
  a shared resource would misattribute shared cost to one game.

## Decisions

### D1: New tag key `Game`, not a compound value on `Project`
- **Choice**: Add a separate `Game` tag key (e.g. `Game=palworld`),
  distinct from and paired with the existing `Project=hyveon` tag.
- **Rationale**: `Project` already scopes "this is a Hyveon resource";
  encoding that again into a compound value like `Hyveon-Palworld` is
  redundant and produces awkward tag values to group by. Two independent
  keys let Cost Explorer group by `Project` alone (whole-app total), by
  `Game` alone (cross-project if ever relevant), or by both.
- **Alternatives considered**: Compound value on `Project`
  (`Project=Hyveon-Palworld`) — rejected, breaks the existing `Project=hyveon`
  grouping used by CLAUDE.md's documented cost-allocation-tag setup.
  `GameServer` as the key name — rejected, `Game` is shorter and
  unambiguous in this codebase (`gameServers`, `GameServerConfig` already
  establish "game" as the term of art).

### D2: Tag only resources with independently metered per-game cost
- **Choice**: Add `Game` to ECS task definitions and their CloudWatch log
  groups (`ecs.ts`), and to the EFS-seeder Lambda + its log group
  (`lambdas.ts`). Leave the ECS cluster, security groups, DynamoDB tables,
  the four project-wide Lambdas, and EFS (filesystem + access points)
  untagged for `Game`.
- **Rationale**: Verified against the actual resource definitions, not
  assumed from file names — `ecs.ts` and `lambdas.ts` do have per-game
  loops (`for (const game of Object.keys(gameServers))`), but
  `dynamodb.ts` and `securityGroups.ts` declare project-wide resources only,
  and EFS provisions one shared filesystem with per-game access points that
  aren't separately billed. Tagging a shared resource with a single game's
  id would misattribute that resource's cost to one game.
- **Alternatives considered**: Tag every per-game-loop-touched resource
  including EFS access points anyway, for consistency — rejected by user
  (see brainstorm.md Q4): it implies a cost-split capability that doesn't
  exist and adds tag-maintenance surface with zero Cost Explorer benefit.

### D3: Propagate tags to running ECS tasks via `propagateTags`
- **Choice**: Set `propagateTags: 'TASK_DEFINITION'` on the
  `RunTaskCommand` call in `AwsCloudProvider.ts:451`.
- **Rationale**: This is the decision that makes the whole change
  effective. AWS bills Fargate compute against the running task, not the
  task definition. Without propagation, `Game` would exist only on a
  resource (`aws.ecs.TaskDefinition`) that itself accrues no cost, and Cost
  Explorer would show nothing tagged for the actual server runtime.
- **Alternatives considered**: Tag the task definition only, relying on
  operators mentally mapping task-def name to game — rejected, defeats the
  purpose of adding the tag at all.

## Risks / Trade-offs

- [Risk] Cost allocation tags are not retroactive — activating `Game` today
  produces no historical breakdown for past spend. → Mitigation: document
  this explicitly so operators don't expect backfilled data.
- [Risk] Tag activation is a manual AWS Billing console step outside
  Pulumi's control; if skipped, the tag exists on resources but never
  appears as a Cost Explorer grouping dimension. → Mitigation: document the
  activation step in `docs/docs/components/infra.md` next to the existing
  `Project` activation note, and mention it can take ~24h to appear.
- [Trade-off] EFS cost stays unattributed per game. → Accepted: EFS is a
  minor cost component relative to Fargate compute for this workload, and a
  real fix (per-game filesystems) is a larger change not currently
  justified.
- [Trade-off] `propagateTags: 'TASK_DEFINITION'` also propagates any other
  task-definition-level tags (currently just `Name` and `Project`, both
  harmless) onto the running task — this is intentional and matches how
  AWS expects cost-allocation tags to reach billed resources.

## Migration Plan

No data migration. Deployment sequence:
1. Ship the Pulumi tag changes (`ecs.ts`, `lambdas.ts`) and the
   `propagateTags` change (`AwsCloudProvider.ts`) in one PR — these are
   small, same-concern, non-breaking changes to existing resource
   definitions, not a fresh capability requiring a stack.
2. Next Pulumi apply/update updates existing task definitions and Lambda
   functions in place with the new `Game` tag (Pulumi tags are mutable
   in-place properties, no resource replacement).
3. Next `RunTask` call after the `cloud-aws` change ships launches tasks
   with propagated tags — no operator action needed.
4. Operator (documented step, not automated): activate `Game` as a cost
   allocation tag in AWS Billing → Cost allocation tags. Allow up to 24h for
   Cost Explorer to reflect it.

Rollback: revert the tag/`propagateTags` changes; no state to unwind since
tags are non-structural resource properties.

## Open Questions

None outstanding — scope, tag scheme, and included/excluded resources were
resolved during brainstorming (see `brainstorm.md`).
