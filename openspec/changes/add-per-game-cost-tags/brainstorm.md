<!--
Raw capture of superpowers:brainstorming output.
-->

# Brainstorm: Per-game AWS cost allocation tags

## Background

User asked whether AWS Cost Explorer breaks costs down by game server, or
whether tags need to be added. Research (this session) established:

- `Project=hyveon` is the only tag today, applied once at the Pulumi
  provider level via `defaultTags` (`app/packages/infra/src/program.ts:174,306,316`)
  — inherited by every Pulumi-managed resource automatically.
- Per-game resources carry a `Name: ${game}-...` tag but no dedicated `Game`
  tag key exists anywhere.
- Dynamically-launched ECS tasks via `RunTaskCommand`
  (`app/packages/cloud-aws/src/AwsCloudProvider.ts:451-459`) get **zero**
  tags at runtime — no `propagateTags` set — so the actual server compute
  cost (bulk of the bill) currently cannot be attributed to a game at all.
- AWS cost allocation tags only apply going forward from activation (not
  retroactive) and only work on tags actually present on the billed
  resource/usage.

## Decision chain

**Q1 (asked in prior turn, before formal brainstorm): tag value scheme —
compound `Hyveon-Palworld` or separate keys?**
→ Separate `Game` key (e.g. `Game=palworld`), paired with existing
`Project=hyveon`. Avoids redundant prefixing, keeps tag values consistent
for grouping.

**Q2: which resources actually need the `Game` tag?**
Read the real resource definitions (`ecs.ts`, `efs.ts`, `dynamodb.ts`,
`securityGroups.ts`, `lambdas.ts`) rather than assume from the file list.
Findings:
- ECS: cluster is shared (`ecs.ts:120`); task definitions and CloudWatch log
  groups are genuinely per-game, one per game in a loop (`ecs.ts:132,221`).
- EFS: the filesystem itself is **one shared filesystem across all games**
  (`efs.ts:103`) — only access points are per-game
  (`efs.ts:140` game volumes, `efs.ts:163` caddy-data certs).
- DynamoDB tables (`dynamodb.ts:145,164`) and security groups
  (`securityGroups.ts:230-323`) are project-wide, not per-game.
- Of the four always-on Lambdas (`lambdas.ts:482-685`), all are project-wide.
  The EFS-seeder Lambda (`lambdas.ts:759,786`) is the one per-game Lambda.

**Q3: does tagging EFS access points actually split EFS cost by game?**
→ No. EFS billing meters at the filesystem resource level (bytes stored on
the filesystem), not per access point or per directory. AWS Cost Explorer /
CUR report the filesystem as the billed resource — access points aren't
separately billed and have no independent usage record to carry a tag into.
Tagging access points would be purely cosmetic; it would not enable a
per-game EFS cost breakdown. Getting real per-game EFS cost would require
separate filesystems per game — a materially bigger change (redundant mount
targets, backup/lifecycle config per filesystem) for a resource that's a
small fraction of the bill next to Fargate compute.

**Q4: given Q3, tag EFS access points anyway (cosmetic) or skip?**
→ **Skip EFS tagging entirely.** Keep the change scoped strictly to
resources where tagging actually changes what Cost Explorer shows, rather
than implying a cost-split capability that doesn't exist.

**Q5: tag key name — `Game` or `GameServer`?**
→ `Game` (shorter, pairs naturally with `Project`).

**Q6: propagate tags to running ECS tasks?**
→ Yes — `RunTaskCommand` needs `propagateTags: 'TASK_DEFINITION'`
(`AwsCloudProvider.ts:451`) so live Fargate tasks (the actual billed compute
cost) inherit `Game` from the task definition. Without this, only the task
*definition* resource (not billed on its own) would carry the tag — the
running task, which is what accrues Fargate compute charges, would not.

## Approaches considered

**A. Tag at both provision-time (Pulumi) and launch-time (RunTask)** —
recommended. Only way to get the running-task compute cost (majority of the
bill) attributed per game.

**B. Pulumi-only tagging, skip `propagateTags`** — rejected. Task
definitions aren't billed; running tasks are. Without propagation the
biggest cost driver stays untagged.

**C. AWS Cost Categories / Billing Groups instead of tags** — rejected.
Heavier feature, overkill for one extra dimension; tags are the established
pattern here (`Project=hyveon` already exists) and are sufficient.

## Validated design (approved by user)

- New tag key: `Game`, value = game id (e.g. `Game=palworld`).
- Tag added to: ECS task definitions (`ecs.ts:221`), CloudWatch log groups
  (`ecs.ts:132`), EFS-seeder Lambda + its log group (`lambdas.ts:759,786`).
- Left untagged for `Game` (shared, `Project` tag suffices): ECS cluster,
  security groups, DynamoDB tables, the four project-wide Lambdas, EFS
  filesystem + access points.
- `RunTaskCommand` in `AwsCloudProvider.ts:451` gets
  `propagateTags: 'TASK_DEFINITION'`.
- Cost allocation tag activation for `Game` is a manual, one-time AWS
  Billing console step — documented, not automated by Pulumi. Not
  retroactive; ~24h to appear in Cost Explorer after activation.
- Docs: `docs/docs/components/infra.md` resource/tag table gets a `Game`
  column, plus a short note on querying a per-game breakdown via
  `aws ce get-cost-and-usage --group-by Type=TAG,Key=Game`.
- Tests: extend `program.test.ts` tag assertions to cover the new `Game`
  tag on the resources listed above.
