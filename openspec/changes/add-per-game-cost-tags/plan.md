# Per-Game Cost Allocation Tags Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `Game` AWS tag to every per-game resource with independently metered cost, and propagate it to running ECS Fargate tasks, so AWS Cost Explorer can be grouped/filtered by game.

**Architecture:** Pure additive changes to existing Pulumi resource declarations (`tags:` blocks in `ecs.ts`/`lambdas.ts`) and one new field (`propagateTags`) on the `RunTaskCommand` input in `AwsCloudProvider.ts`. No new files, no schema changes, no IPC surface changes.

**Tech Stack:** Pulumi (`@pulumi/aws`), AWS SDK v3 `@aws-sdk/client-ecs`, Vitest, `aws-sdk-client-mock`.

## Global Constraints

- Tag key is exactly `Game` (capital G), value is the game's config key (e.g. `palworld`) — matches `openspec/changes/add-per-game-cost-tags/specs/cost-visibility/spec.md`.
- Only tag resources with independently metered per-game cost: ECS task definitions, per-game CloudWatch log groups, the per-game EFS-seeder Lambda + its log group. Do NOT tag the ECS cluster, security groups, DynamoDB tables, the four project-wide Lambdas, or EFS (filesystem/access points).
- TSDoc on any new/modified exported function per CLAUDE.md — not needed here since no exported signatures change, only literal `tags:`/`propagateTags:` object contents.
- Every IPC handler / service failure logging rule (`.claude/rules/logging.md`) does not apply — no controller or service method changes here, only Pulumi resource literals and one SDK command input.
- Run `npm run app:lint`, `npm run app:typecheck`, `npm run app:test` before considering the change complete (CLAUDE.md "Before opening a PR").

---

## Task 1: Tag per-game ECS task definitions and log groups

**Files:**
- Modify: `app/packages/infra/src/ecs.ts:127-136` (log group), `app/packages/infra/src/ecs.ts:210-224` (task definition)
- Test: `app/packages/infra/src/ecs.test.ts`

**Interfaces:**
- Consumes: nothing new — `game` is already the loop variable in both `for` loops in `defineEcs`.
- Produces: nothing new — `tags` is a literal object on existing `aws.cloudwatch.LogGroup`/`aws.ecs.TaskDefinition` resources.

- [ ] **Step 1: Write the failing test for the log group's `Game` tag**

In `app/packages/infra/src/ecs.test.ts`, extend the existing test at line 96-99 (`'should declare exactly one log group per game...'`):

```typescript
    const alphaLog = findByName(mocks.resources, 'alpha-server-logs');
    expect(alphaLog.inputs.name).toBe('/ecs/alpha-server');
    expect(alphaLog.inputs.retentionInDays).toBe(7);
    expect(alphaLog.inputs.tags).toEqual({ Name: 'alpha-logs', Game: 'alpha' });
```

(Only the last `toEqual` line changes — from `{ Name: 'alpha-logs' }` to `{ Name: 'alpha-logs', Game: 'alpha' }`.)

- [ ] **Step 2: Write the failing test for the task definition's `Game` tag**

In the same file, extend the test at line 133-141 (`'should set family/networkMode/...'`):

```typescript
    const alphaTd = findByName(mocks.resources, 'alpha-server');
    expect(alphaTd.type).toBe('aws:ecs/taskDefinition:TaskDefinition');
    expect(alphaTd.inputs.family).toBe('alpha-server');
    expect(alphaTd.inputs.networkMode).toBe('awsvpc');
    expect(alphaTd.inputs.requiresCompatibilities).toEqual(['FARGATE']);
    expect(alphaTd.inputs.cpu).toBe('1024');
    expect(alphaTd.inputs.memory).toBe('2048');
    expect(alphaTd.inputs.executionRoleArn).toBe('arn:aws:iam::123456789012:role/hyveon-task-execution');
    expect(alphaTd.inputs.tags).toEqual({ Name: 'alpha-server', Game: 'alpha' });
```

(Only the last line changes.)

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm run app:test -- ecs.test.ts`
Expected: FAIL — both `toEqual` assertions above fail because `tags` currently equals `{ Name: '...' }` without `Game`.

- [ ] **Step 4: Add the `Game` tag to the log group**

In `app/packages/infra/src/ecs.ts`, change the log group declaration (around line 127-135):

```typescript
  const logGroups: Record<string, aws.cloudwatch.LogGroup> = {};
  for (const game of Object.keys(gameServers)) {
    logGroups[game] = new aws.cloudwatch.LogGroup(
      `${game}-server-logs`,
      {
        name: `/ecs/${game}-server`,
        retentionInDays: 7,
        tags: { Name: `${game}-logs`, Game: game },
      },
      opts,
    );
  }
```

- [ ] **Step 5: Add the `Game` tag to the task definition**

In the same file, change the task definition declaration (around line 210-224):

```typescript
    taskDefinitions[game] = new aws.ecs.TaskDefinition(
      `${game}-server`,
      {
        family: `${game}-server`,
        networkMode: 'awsvpc',
        requiresCompatibilities: ['FARGATE'],
        cpu: String(config.cpu),
        memory: String(config.memory),
        executionRoleArn,
        volumes,
        containerDefinitions: pulumi.jsonStringify(containerDefs),
        tags: { Name: `${game}-server`, Game: game },
      },
      opts,
    );
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm run app:test -- ecs.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add app/packages/infra/src/ecs.ts app/packages/infra/src/ecs.test.ts
git commit -m "feat(infra): tag per-game ECS task definitions and log groups with Game"
```

---

## Task 2: Tag the per-game EFS-seeder Lambda and its log group

**Files:**
- Modify: `app/packages/infra/src/lambdas.ts:754-762` (log group), `:765-787` (function)
- Test: `app/packages/infra/src/lambdas.test.ts`

**Interfaces:**
- Consumes: nothing new — `game` is already the loop variable from `for (const [game, role] of seederGames)`.
- Produces: nothing new — `tags` is a literal object on existing resources.

- [ ] **Step 1: Write the failing test for the efs-seeder log group's `Game` tag**

In `app/packages/infra/src/lambdas.test.ts`, in the `'should declare one log group/function per game with file_seeds...'` test (starting at line 510), add after the existing log group assertions (after line 530, `expect(logGroup.inputs.retentionInDays).toBe(7);`):

```typescript
      const logGroup = findByName(mocks.resources, 'hyveon-efs-seeder-echo-logs');
      expect(logGroup.inputs.name).toBe('/aws/lambda/hyveon-efs-seeder-echo');
      expect(logGroup.inputs.retentionInDays).toBe(7);
      expect(logGroup.inputs.tags).toEqual({ Name: 'hyveon-efs-seeder-echo-logs', Game: 'echo' });
```

- [ ] **Step 2: Write the failing test for the efs-seeder function's `Game` tag**

In the same test, after the `fn` assertions block (after the existing `expect(fn.inputs.vpcConfig).toEqual({...})` block), add:

```typescript
      expect(fn.inputs.tags).toEqual({ Name: 'hyveon-efs-seeder-echo', Game: 'echo' });
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm run app:test -- lambdas.test.ts`
Expected: FAIL — both new `toEqual` assertions fail; `tags` currently lacks `Game`.

- [ ] **Step 4: Add the `Game` tag to the efs-seeder log group**

In `app/packages/infra/src/lambdas.ts`, change the log group declaration (around line 754-762):

```typescript
      const logGroup = new aws.cloudwatch.LogGroup(
        `${projectName}-efs-seeder-${game}-logs`,
        {
          name: `/aws/lambda/${projectName}-efs-seeder-${game}`,
          retentionInDays: 7,
          tags: { Name: `${projectName}-efs-seeder-${game}-logs`, Game: game },
        },
        opts,
      );
```

- [ ] **Step 5: Add the `Game` tag to the efs-seeder function**

In the same file, change the function declaration's `tags` field (around line 786):

```typescript
          environment: { variables: { AWS_REGION_: awsRegion } },
          tags: { Name: `${projectName}-efs-seeder-${game}`, Game: game },
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm run app:test -- lambdas.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add app/packages/infra/src/lambdas.ts app/packages/infra/src/lambdas.test.ts
git commit -m "feat(infra): tag per-game EFS-seeder Lambda and log group with Game"
```

---

## Task 3: Confirm shared resources stay untagged for Game (regression check, no code change)

**Files:**
- Test: `app/packages/infra/src/ecs.test.ts`, `app/packages/infra/src/securityGroups.test.ts`, `app/packages/infra/src/dynamodb.test.ts`, `app/packages/infra/src/lambdas.test.ts` (existing files — verify only, no new file)

**Interfaces:**
- Consumes: nothing.
- Produces: nothing — this task is a verification pass, not new production code.

- [ ] **Step 1: Confirm the ECS cluster assertion still expects `Name` only**

Re-read `app/packages/infra/src/ecs.test.ts:73-78` (`'should declare the ECS cluster...'`). It already asserts `expect(cluster.inputs.tags).toEqual({ Name: 'hyveon-cluster' });`. Since Task 1 does not touch the cluster's `tags:` block (`ecs.ts:120`, untouched), this assertion already covers "the cluster does not get a `Game` tag" — no edit needed. Confirm by running:

Run: `npm run app:test -- ecs.test.ts`
Expected: PASS (no changes made in this task)

- [ ] **Step 2: Confirm security group and DynamoDB tag assertions are unaffected**

Run: `npm run app:test -- securityGroups.test.ts dynamodb.test.ts`
Expected: PASS — these files are untouched by this change; their existing `tags` assertions (`{ Name: ... }` only, no `Game`) continue to hold since `securityGroups.ts` and `dynamodb.ts` are not modified by Tasks 1-2.

- [ ] **Step 3: Confirm the four project-wide Lambda tag assertions are unaffected**

Run: `npm run app:test -- lambdas.test.ts`
Expected: PASS — the followup/interactions/watchdog/dns-updater Lambda tag assertions (e.g. `lambdas.test.ts:217`, `expect(fn.inputs.tags).toEqual({ Name: 'hyveon-followup' });`) are untouched by Task 2, which only edits the efs-seeder block.

No commit — this task makes no code changes; it documents that the existing test suite already provides negative-case coverage for D2 in `design.md` (shared resources stay `Game`-untagged) because those tests assert an exact `tags` object that does not include `Game`, and neither `securityGroups.ts`, `dynamodb.ts`, nor the four project-wide Lambda blocks in `lambdas.ts` are touched by Tasks 1-2.

---

## Task 4: Propagate the `Game` tag to running ECS tasks via `RunTask`

**Files:**
- Modify: `app/packages/cloud-aws/src/AwsCloudProvider.ts:451-459`
- Test: `app/packages/cloud-aws/src/AwsCloudProvider.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: nothing new — `propagateTags` is a literal field on the existing `RunTaskCommand` input.

- [ ] **Step 1: Write the failing test**

In `app/packages/cloud-aws/src/AwsCloudProvider.test.ts`, extend the existing test at line 79-98 (`'should launch a task with the correct cluster, family, trimmed subnets, and SG'`) by adding one more assertion at the end:

```typescript
    it('should launch a task with the correct cluster, family, trimmed subnets, and SG', async () => {
      ecsMock.on(ListTasksCommand).resolves({ taskArns: [] });
      ecsMock.on(RunTaskCommand).resolves({ tasks: [{ taskArn: 'arn-new' }] });

      const provider = makeProvider();
      const handle = await provider.startWorkload('minecraft', {});

      expect(handle).toEqual({ workloadId: 'arn-new' });
      const input = ecsMock.commandCalls(RunTaskCommand)[0]!.args[0].input;
      expect(input.cluster).toBe('game-cluster');
      expect(input.taskDefinition).toBe('minecraft-server');
      expect(input.count).toBe(1);
      expect(input.launchType).toBe('FARGATE');
      expect(input.networkConfiguration?.awsvpcConfiguration?.subnets).toEqual([
        'subnet-a',
        'subnet-b',
      ]);
      expect(input.networkConfiguration?.awsvpcConfiguration?.securityGroups).toEqual(['sg-game']);
      expect(input.networkConfiguration?.awsvpcConfiguration?.assignPublicIp).toBe('ENABLED');
      expect(input.propagateTags).toBe('TASK_DEFINITION');
    });
```

(Only the final `expect(input.propagateTags)...` line is new.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run app:test -- AwsCloudProvider.test.ts`
Expected: FAIL — `input.propagateTags` is `undefined`, not `'TASK_DEFINITION'`.

- [ ] **Step 3: Add `propagateTags` to the `RunTaskCommand` input**

In `app/packages/cloud-aws/src/AwsCloudProvider.ts`, change the `RunTaskCommand` construction (around line 451-459):

```typescript
      const resp = await this.getEcsClient(region, credentials, credentialsSignature).send(
        new RunTaskCommand({
          cluster,
          taskDefinition: `${game}-server`,
          count: 1,
          launchType: 'FARGATE',
          networkConfiguration: {
            awsvpcConfiguration: { subnets, securityGroups: [sg], assignPublicIp: 'ENABLED' },
          },
          propagateTags: 'TASK_DEFINITION',
        }),
      );
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run app:test -- AwsCloudProvider.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add app/packages/cloud-aws/src/AwsCloudProvider.ts app/packages/cloud-aws/src/AwsCloudProvider.test.ts
git commit -m "feat(cloud-aws): propagate task-definition tags to running ECS tasks"
```

---

## Task 5: Document the `Game` tag and cost allocation tag activation

**Files:**
- Modify: `docs/docs/components/infra.md`

**Interfaces:**
- Consumes: nothing (docs-only).
- Produces: nothing (docs-only).

- [ ] **Step 1: Add a `Game` note to the `ecs.ts` and `lambdas.ts` rows of the Files table**

In `docs/docs/components/infra.md`, in the `## Files` table (around line 106-121), edit the `ecs.ts` row (line 111) to append a note about the `Game` tag:

```markdown
| `ecs.ts` | The ECS cluster and per-game task definitions. | `aws.ecs.Cluster` (1), `aws.cloudwatch.LogGroup` (one per game, `/ecs/{game}-server`), `aws.ecs.TaskDefinition` (one per game, family `{game}-server`). **No `aws.ecs.Service` is ever declared** — upholding the no-persistent-Service invariant. The per-game log group and task definition both carry a `Game=<game>` tag (see "Cost allocation tags" below); the cluster does not. |
```

And edit the `lambdas.ts` row (line 113):

```markdown
| `lambdas.ts` | The five Lambda functions, their log groups, the interactions Function URL, and the two EventBridge rule/target pairs. | `aws.lambda.Function` — 4 fixed + 1 per seeder game (`{projectName}-efs-seeder-{game}`). `aws.cloudwatch.LogGroup` — 4 fixed + 1 per seeder game. `aws.lambda.FunctionUrl` (1). `aws.lambda.Permission` (4). `aws.cloudwatch.EventRule` (2: watchdog schedule, ECS task-state-change). `EventTarget` (2). The per-seeder-game function and log group carry a `Game=<game>` tag; the 4 fixed Lambdas do not. |
```

- [ ] **Step 2: Add a new "Cost allocation tags" section**

In the same file, insert a new section immediately after the `## Files` table (before `## The DNS invariant, precisely`, currently at line 123):

```markdown
## Cost allocation tags

Every Pulumi-managed resource carries `Project=hyveon` (applied once via
`defaultTags` on both `aws.Provider`s in `program.ts`). In addition, the
resources whose cost AWS meters independently per game — per-game ECS task
definitions and their CloudWatch log groups (`ecs.ts`), and the per-game
EFS-seeder Lambda and its log group (`lambdas.ts`) — carry a `Game=<game>`
tag, where `<game>` is the game's key in `DeploymentConfig.gameServers`.

Resources shared across every game (the ECS cluster, security groups,
DynamoDB tables, the four project-wide Lambdas, and the EFS filesystem and
its access points) intentionally do **not** carry a `Game` tag — EFS in
particular bills at the filesystem level, so tagging its per-game access
points would not let Cost Explorer split EFS cost by game (access points
aren't separately billed resources).

Dynamically-launched ECS Fargate tasks (via `RunTask`, never a persistent
`aws.ecs.Service` — see the no-persistent-Service invariant above) inherit
`Game` from their task definition via `propagateTags: 'TASK_DEFINITION'`
(`AwsCloudProvider.startWorkload`) — this is what makes the tag reach the
resource AWS actually bills Fargate compute against.

**One-time manual step required — Pulumi cannot do this:** to see costs
broken down by `Game` in AWS Cost Explorer, activate `Game` (and `Project`,
if not already active) as a cost allocation tag: AWS Billing console →
Cost allocation tags → select the tag → Activate. This is not retroactive
(only usage after activation is tagged in cost data) and can take up to 24
hours to appear in Cost Explorer.

Once activated, pull a per-game breakdown with:

\`\`\`bash
aws ce get-cost-and-usage \\
  --time-period Start=2026-08-01,End=2026-09-01 \\
  --granularity MONTHLY \\
  --metrics UnblendedCost \\
  --group-by Type=TAG,Key=Game
\`\`\`
```

- [ ] **Step 3: Verify the docs build**

Run: `npm run app:lint`
Expected: PASS (markdown/docs linting, if configured, or no output if `docs/` isn't linted by this script — in that case, visually re-read the added section for a stray unescaped backtick or broken table row before committing.)

- [ ] **Step 4: Commit**

```bash
git add docs/docs/components/infra.md
git commit -m "docs(infra): document per-game Game cost allocation tag and activation step"
```

---

## Task 6: Full verification gate

**Files:** none (verification only)

- [ ] **Step 1: Lint**

Run: `npm run app:lint`
Expected: exit 0, no errors.

- [ ] **Step 2: Typecheck**

Run: `npm run app:typecheck`
Expected: exit 0, no errors.

- [ ] **Step 3: Full unit test suite**

Run: `npm run app:test`
Expected: exit 0, all suites green (includes the updated `ecs.test.ts`, `lambdas.test.ts`, `AwsCloudProvider.test.ts` from Tasks 1, 2, 4, plus every untouched suite from Task 3's regression check).

- [ ] **Step 4: Commit if any lint --fix changes were applied**

```bash
git add -A
git commit -m "chore: apply lint fixes"
```

(Only if Step 1 or a `--fix` run produced changes; skip if the working tree is already clean.)
