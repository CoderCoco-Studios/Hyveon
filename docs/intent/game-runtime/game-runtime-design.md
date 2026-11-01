---
parent: high-level-design
prefix: RT
---

# High-Level Design: Game Runtime

This is the sub-HLD for the `game-runtime` grouping node: what happens to a game while it is deployed.
It holds the subtree's problem, approach, the task lifecycle that spans its three leaves, the contracts between them, and the decisions whose substance belongs to more than one leaf.
It owns no EARS; requirements live in the child leaves' `*-specs.md` files under the `RT-TASK`, `RT-WATCHDOG` and `RT-HEALTH` prefixes, and `grep RT-` gathers the whole subtree.
Rationale is marked `[stated]` when the cited source gives it and `[inferred]` when it is a reading of the code or docs that no source states.

## Problem

A deployed game is a task definition and a set of Lambdas that cost nothing until a task runs; the moment a task runs, it bills by the hour (`docs/high-level-design.md`, "Problem").
Something therefore has to start a task when a player or the operator asks, stop it when they are done or when nobody is playing, and keep `{game}.{domain}` pointed at an address that changes on every launch, because a Fargate task gets a fresh public IP each time (`docs/intent/game-runtime/task-and-dns/task-and-dns-design.md`, "Context and Design Philosophy").
Without an automatic stop, a server started from Discord or the desktop app runs and bills until someone remembers to stop it (`docs/intent/game-runtime/watchdog/watchdog-design.md`, "Context and Design Philosophy").
Without a game-aware signal, "nobody is playing" can only be guessed from network packets, which cannot tell a server with players from a server receiving background traffic (`docs/intent/game-runtime/health-check/health-check-design.md`, "Context and Design Philosophy").

## Approach

The subtree treats the ECS task itself as the unit of runtime and the ECS task-state change as the one signal everything downstream reacts to.
Actors that change a game's state only ever issue `RunTask` or `StopTask`; every side effect that must follow the task (DNS, the Discord connect reply) hangs off the resulting `RUNNING` or `STOPPED` event rather than off the actor that caused it.

### On-demand tasks, issued from several places

A Start becomes one `RunTask` with `count: 1` against the `{game}-server` task definition and a Stop becomes one `StopTask`; nothing keeps a task alive in between (`task-and-dns-design.md`, "Start, Stop and Status"; `CLAUDE.md`, "No persistent ECS Service").
Two actors start tasks (the desktop app through `AwsCloudProvider`, and the Discord followup Lambda for `/server-start`) and three stop them (the desktop app, the followup Lambda for `/server-stop`, and the watchdog) (`task-and-dns-design.md`, "What it deliberately does not own"; `docs/docs/components/lambdas.md`, "followup").

### DNS that follows task state

The update-dns Lambda, triggered by an EventBridge rule on `ECS Task State Change` for this cluster, UPSERTs `{game}.{domain}` to the task's public IP on `RUNNING` and deletes it on `STOPPED` (`task-and-dns-design.md`, "DNS Lifecycle"; `docs/docs/architecture.md`, "Control loops (DNS + watchdog)").
Because DNS keys off the event, the same path serves every start and stop issuer and every game, HTTPS or not (`openspec/specs/in-task-tls-termination/spec.md:56-58`, cited by `task-and-dns-design.md`).

### Idle shutdown with exactly one verdict source per game

A scheduled watchdog Lambda looks at every RUNNING `{game}-server` task each interval, takes an idle-or-active verdict from exactly one source, keeps a consecutive-idle count in the task's own `idle_checks` tag, and issues `StopTask` once the count reaches the threshold (`watchdog-design.md`, "Run Lifecycle").
The verdict source is the game's inbound traffic from ECS Container Insights (`NetworkRxBytes` per `{game}-server` family) by default, or, for a game that declares `healthCheck`, a synchronous invoke of the shared health-check Lambda, which asks the game over HTTP and returns `{ active, reason, failureDerived }` (`watchdog-design.md`, "Verdict Sources"; `health-check-design.md`, "Declaration and Data Shapes").

### Visibility for the operator

The dashboard polls each game's status (`not_deployed`, `starting`, `running`, `stopped`, `error`) and shows a cost estimate computed from task-definition CPU and memory, never from billed data (`task-and-dns-design.md`, "Status states", "Cost Estimates").

## Target Users

- **The operator**, who starts and stops games from the dashboard, reads status and estimated cost, sets the watchdog tunables in Settings, and declares a game's health check in the add/edit-game wizard (`task-and-dns-design.md`, "Renderer polling and actions"; `watchdog-design.md`, "Configuration Contract"; `health-check-design.md`, "Credential Lifecycle").
- **Players**, who start a game from `/server-start` and receive the connect address when update-dns PATCHes the deferred Discord reply (`docs/docs/components/lambdas.md`, "The `/server-start` critical path, assembled").

Needs and acceptable cost per role beyond these interactions are not stated: *(not yet specified)*.

## Goals

The subtree carries the project's stated aim that servers "only run, and only cost money, while someone is playing" (`README.md`, intro, as cited by `docs/high-level-design.md`, "Problem").
Subtree-specific goals, for example a target idle-to-stop latency or a bound on stops of a server with players, are not stated: *(not yet specified)*.

## Non-Goals

Each of these is stated as a prohibition in a grounding source and binds more than one leaf:

- No persistent ECS Service and no scale-to-zero controller (`CLAUDE.md`, "No persistent ECS Service").
- No infra-program-managed per-game DNS record, and no runtime Lambda other than update-dns writing one; the watchdog never touches Route 53 (`CLAUDE.md`, "DNS records are Lambda-managed"; `docs/docs/architecture.md`, "Control loops (DNS + watchdog)").
- No load balancer, target registration or `elasticloadbalancing` grant in the runtime Lambdas; TLS terminates in-task (`CLAUDE.md`, "TLS terminates in-task via a Caddy sidecar"; `openspec/specs/in-task-tls-termination/spec.md:56`, cited by both `task-and-dns-design.md` and `watchdog-design.md`).
- No DynamoDB or SSM store for watchdog state (`CLAUDE.md`, "Watchdog state lives in ECS task tags").
- No combination of verdict sources for one game (`openspec/specs/game-health-checks/spec.md:17-20`, cited by `watchdog-design.md`).
- No billed-cost data source; Cost Explorer is not called (`openspec/specs/cost-visibility/spec.md:10-42`, cited by `task-and-dns-design.md`).

## Tenets

Hyveon's root tenets (`docs/high-level-design.md`, "Tenets") apply to this subtree unchanged. Within this subtree, "fail active" is also a recorded decision (Key Design Decision 5): both the watchdog and health-check resolve every uncertain verdict toward keeping the task running. Subtree-specific tenets are not yet specified.

## System Design

### Node table

| Node | Purpose | Design doc | Specs | Prefix | Specs count |
|---|---|---|---|---|---|
| `game-runtime/task-and-dns` | Start and stop a game's container on demand, publish its address in DNS, show live status and estimated cost. | [`task-and-dns-design.md`](task-and-dns/task-and-dns-design.md) | [`task-and-dns-specs.md`](task-and-dns/task-and-dns-specs.md) | `RT-TASK` | 72 |
| `game-runtime/watchdog` | Automatically stop a game nobody is playing, keeping its idle counter in an ECS task tag. | [`watchdog-design.md`](watchdog/watchdog-design.md) | [`watchdog-specs.md`](watchdog/watchdog-specs.md) | `RT-WATCHDOG` | 59 |
| `game-runtime/health-check` | Optionally ask a game over HTTP whether it is serving players, so the watchdog judges idleness by the game's own answer. | [`health-check-design.md`](health-check/health-check-design.md) | [`health-check-specs.md`](health-check/health-check-specs.md) | `RT-HEALTH` | 67 |

Spec counts are from the leaves' arrow docs (`docs/arrows/game-runtime/*.md`, "EARS").

### Task lifecycle across the leaves

```mermaid
sequenceDiagram
  autonumber
  participant Actor as Operator app / Discord followup
  participant ECS as ECS task {game}-server
  participant EB as EventBridge
  participant DNS as update-dns (task-and-dns)
  participant WD as watchdog
  participant HC as health-check
  participant R53 as Route 53
  participant DC as Discord deferred reply

  Actor->>ECS: RunTask (count 1, propagateTags TASK_DEFINITION)
  Note over Actor: Discord path also writes PENDING#{taskArn}
  ECS-->>EB: task state change, lastStatus RUNNING
  EB->>DNS: invoke
  DNS->>ECS: DescribeTasks, ENI public IP (up to 5 tries, 3 s apart)
  DNS->>R53: UPSERT {game}.{domain} A, TTL DNS_TTL
  DNS->>DC: PATCH running status, delete PENDING row
  loop every watchdogIntervalMinutes
    WD->>ECS: ListTasks RUNNING, DescribeTasks
    alt game declares healthCheck
      WD->>HC: Invoke RequestResponse {game, taskArn, healthCheck}
      HC->>ECS: DescribeTasks, private IP
      HC-->>WD: {active, reason, failureDerived}
    else no healthCheck
      WD->>WD: Container Insights NetworkRxBytes by family
    end
    WD->>ECS: idle_checks tag read / write
  end
  WD->>ECS: StopTask once idle_checks reaches IDLE_CHECKS
  Note over Actor,ECS: operator or /server-stop may StopTask instead
  ECS-->>EB: task state change, lastStatus STOPPED
  EB->>DNS: invoke
  DNS->>R53: DELETE current A record
```

Sources: `task-and-dns-design.md` ("Start, Stop and Status", "DNS Lifecycle"), `watchdog-design.md` ("Run Lifecycle", "Verdict Sources"), `health-check-design.md` ("Check Execution"), `docs/docs/components/lambdas.md` ("The `/server-start` critical path, assembled").

The desktop status poll is independent of this chain: `running` reflects the ECS task status only and does not wait for the UPSERT, so the dashboard can show a hostname a few seconds before the record exists (`task-and-dns-design.md`, "Status states", `[inferred]` there).

### Contracts between the leaves

| Contract | Producer | Consumer | Shape | Source |
|---|---|---|---|---|
| Game identity | `iac/program` renders `GAME_NAMES`; `@hyveon/shared` `familyToGameMap` | update-dns, watchdog | ECS family `{game}-server` maps to `{game}`; any other family, including the helper task's, is skipped | `task-and-dns-design.md`, "Event handling"; `watchdog-design.md`, "Run Lifecycle" step 3 |
| Task-state signal | ECS via the EventBridge rule `${projectName}-task-state-change` | update-dns | `ECS Task State Change` for this cluster, `lastStatus` `RUNNING` or `STOPPED` | `task-and-dns-design.md`, "Trigger and configuration" |
| DNS on RUNNING | update-dns | players, Discord reply | UPSERT A `{game}.{DOMAIN_NAME}` to the ENI public IP with `DNS_TTL`; no IP after five attempts means no DNS change and an error PATCH | `task-and-dns-design.md`, "Event handling" |
| DNS on STOPPED | update-dns | every stop issuer, including the watchdog | DELETE using the record's current IP and the Lambda's current `DNS_TTL`; no record means no action | `task-and-dns-design.md`, "Event handling"; `watchdog-design.md`, "What it deliberately does not own" |
| Task tags | both `RunTask` paths (`Game`, via `propagateTags: 'TASK_DEFINITION'`); watchdog (`idle_checks`) | Cost allocation (`Game`); watchdog only (`idle_checks`) | `idle_checks` is an integer on the task ARN; missing, non-numeric or unreadable reads as 0, so a new task starts at 0 | `task-and-dns-design.md`, "Resolved" 2; `watchdog-design.md`, "Idle-count state machine" |
| Opt-in map | `iac/program` renders `HEALTH_CHECKS` and `HEALTH_CHECK_FUNCTION_NAME` at apply time | watchdog | JSON map of opted-in games to their full `healthCheck` declaration; empty function name when the function is not provisioned | `watchdog-design.md`, "Configuration Contract"; `health-check-design.md`, "Declaration and Data Shapes" |
| Health verdict | health-check | watchdog | Request `{ game, taskArn, healthCheck }` by `RequestResponse` invoke; response `{ active: boolean, reason: string, failureDerived: boolean }`; idle exactly when `active === false` | `health-check-design.md`, "Declaration and Data Shapes"; `watchdog-design.md`, "Health-check invoke" |
| ENI helpers | task-and-dns (`@hyveon/shared/aws/ecsTask`) | watchdog (`getTaskEniId`), health-check (`getTaskPrivateIp`), provider and update-dns | Structural types and a caller-supplied describe callback; no SDK import | `task-and-dns-design.md`, "What it owns"; `watchdog-design.md`, "Verdict Sources"; `health-check-design.md`, "Check Execution" |
| Discord deferred-reply hand-off | `discord-bot` followup writes `PENDING#{taskArn}` (15-minute TTL) after its `RunTask` | update-dns | On RUNNING, PATCH the interaction with the formatted status and delete the row; on no IP, PATCH an error; on STOPPED the row is not consulted | `docs/intent/discord-bot/discord-bot-design.md`, "DynamoDB rows"; `task-and-dns-design.md`, "Event handling" |

### Configuration reaches the runtime only at apply time

Every runtime Lambda in this subtree gets its configuration from env vars and schedule expressions that `iac/program` renders from `DeploymentConfig`; none reads `deployment-config.json` at runtime (`watchdog-design.md`, "Configuration Contract"; `task-and-dns-design.md`, "Trigger and configuration"; `health-check-design.md`, "Declaration and Data Shapes").
A change to the watchdog tunables, `dnsTtl`, the game list or a health-check declaration therefore takes effect on the next infra apply, which the Settings `WatchdogPanel` tells the operator (`watchdog-design.md`, "Configuration Contract").

## Key Design Decisions

1. **Downstream effects follow the ECS task-state event, never the actor.**
   Cited by `task-and-dns-design.md` (Decisions: "Who owns DNS records", "DNS cleanup ordering"), `watchdog-design.md` (Decisions: "Who deletes DNS on idle stop"), `docs/intent/discord-bot/discord-bot-design.md` ("DNS and the connect follow-up").
   Rationale `[stated]`: records follow ephemeral task IPs "without fighting state" (`update-dns/src/handler.ts:242-246`, cited by `task-and-dns-design.md`), and deleting DNS before `StopTask` would leave a running task with no record if `StopTask` then failed (`watchdog/src/handler.ts:13-17`, cited by `watchdog-design.md`); the connect address arrives by PATCH on RUNNING so the followup Lambda need not wait out a 2-5 minute start (`discord-bot-design.md`, Decisions, `[inferred]` there).
   Alternatives rejected: a Pulumi-managed per-game record `[stated]` (`CLAUDE.md`); each actor deleting DNS before `StopTask` `[stated]`; the desktop app writing DNS on start, which cannot see watchdog stops or Discord starts `[inferred]` (`task-and-dns-design.md`).

2. **Runtime state lives on the task.**
   The idle count is the `idle_checks` tag and cost attribution is the propagated `Game` tag; both disappear with the task (`watchdog-design.md`, "Idle-count state machine"; `task-and-dns-design.md`, "Resolved" 2).
   Rationale `[stated]`: the counter resets for free when a task stops, so no store needs cleaning up (`docs/docs/architecture.md`, "Invariants" 7).
   Alternatives rejected `[stated]`: a DynamoDB or SSM counter (`CLAUDE.md`).
   The one piece of runtime state held off the task is the Discord `PENDING#{taskArn}` row, owned by `discord-bot`, keyed by task ARN and self-expiring after 15 minutes to match the interaction token lifetime (`discord-bot-design.md`, "DynamoDB rows").

3. **The `{game}-server` family name is the cross-Lambda identity contract.**
   update-dns and the watchdog both resolve a task's game by stripping `family:` from its group and looking it up in a map built from `GAME_NAMES`, so helper tasks and foreign families in the same cluster are ignored (`task-and-dns-design.md`, "Event handling"; `watchdog-design.md`, "Run Lifecycle").
   Rationale `[inferred]`: the family naming convention is already the cross-package contract and excludes helper tasks for free (`watchdog-design.md`, Decisions: "Which tasks are eligible").
   Alternatives rejected `[inferred]`: tag-based task selection; treating every task in the cluster as a game.

4. **The watchdog owns routing and the stop decision; the health-check Lambda owns only the verdict.**
   The watchdog picks exactly one verdict source per game from `HEALTH_CHECKS`, keeps the count and issues `StopTask`; the health-check Lambda resolves host and credential, makes the request and returns a verdict (`watchdog-design.md`, "Verdict Sources"; `health-check-design.md`, "It deliberately does not own").
   Rationale `[stated]`: a separate, conditionally provisioned Lambda keeps VPC attachment, game-network egress and secret access out of the function every shutdown depends on (`openspec/changes/add-pluggable-health-checks/design.md:54-73`, cited by both leaves); a single source per game lets an operator read why a server stopped (`openspec/specs/game-health-checks/spec.md:17-20`); routing by an apply-time env map avoids giving the watchdog S3 access and avoids an unconditional network hop (`add-pluggable-health-checks/design.md:83-107`).
   Alternatives rejected `[stated]`: checking inside the watchdog; one Lambda per opted-in game; the watchdog reading `deployment-config.json`; always invoking and letting the function decide; combining packets and health check.
   The watchdog never resolves `auth.secretArn` and holds no `secretsmanager` permission (`watchdog-design.md`, "Health-check invoke").

5. **Fail active: an inconclusive verdict never reads as idle.**
   Every layer that can fail to reach a verdict resolves to "active": the CloudWatch path counts a missing datapoint or query error as active; the health-check engine and handler return `failureDerived: true` verdicts; the watchdog's invoke wrapper does the same for an absent function, a `FunctionError`, a throw or a malformed payload (`watchdog-design.md`, "Verdict Sources"; `health-check-design.md`, "Fail-active Layering").
   Rationale `[stated]`: a wrongly stopped server drops players, which costs more than a server kept running (`health-check/src/engine.ts:144-151`, cited by `health-check-design.md`); a brand-new task that has not yet emitted metrics must not be stopped (`watchdog-design.md`, "CloudWatch heuristic"); fail-active sits at every layer because the most important failure, the function absent or unreachable, is one where no lower layer runs (`add-pluggable-health-checks/design.md:109-116`).
   Alternatives rejected `[stated]`: fail-idle; fail-active in the engine only (`health-check-design.md`, Decisions: "Failure semantics").
   Accepted cost `[stated]`: a persistently broken verdict source keeps a server running indefinitely, made visible by `warn`-level logs at both the health-check and watchdog layers (`add-pluggable-health-checks/design.md:146-150`; `health-check-design.md`, "Fail-active Layering").
   The one route from a misconfigured check to a conclusive idle verdict is the `exists` operator on an unresolved path (`health-check-design.md`, "Check Execution").

6. **Lambda packages deploy independently.**
   The watchdog keeps a local copy of the health-check verdict type rather than importing it, and the ENI helpers in `@hyveon/shared/aws/ecsTask` take structural types and a caller-supplied describe callback (`watchdog-design.md`, Decisions: "Verdict type sharing"; `task-and-dns-design.md`, Decisions: "Public IP lookup").
   Rationale `[stated]`: keeps the two Lambda packages independently deployable (`watchdog/src/handler.ts:67`) and keeps `@hyveon/shared` free of SDK dependencies (`ecsTask.ts:1-16`; `CLAUDE.md`, shared barrel invariant).
   Alternatives rejected: importing from `@hyveon/lambda-health-check` `[stated]`; each caller re-implementing ENI lookup or `shared` importing the EC2 SDK `[stated]`.
   Accepted cost `[stated]`: nothing but a runtime type guard keeps the two verdict shapes in sync (`watchdog-design.md`, "Health-check invoke").

## Cross-subtree Dependencies

| Node | What `game-runtime` depends on it for, or provides to it | Source |
|---|---|---|
| `iac/program` | Provisions every runtime resource: the `{game}-server` task definitions, the update-dns, watchdog and health-check functions, the EventBridge rules and schedule, IAM roles, security groups, and every env var listed in the contracts above. The leaves own handler behaviour only. | `docs/intent/iac/program/program-design.md`, "What it deliberately does not own"; each child's "What it deliberately does not own" |
| `iac/engine` | Stack outputs and region from which the desktop app builds its `CloudProvider`. | `task-and-dns-design.md`, "What it deliberately does not own" |
| `discord-bot` | A second `RunTask`/`StopTask` issuer (the followup Lambda) and the `PENDING#{taskArn}` row update-dns consumes; also the shared `formatStatus` and `patchInteractionOriginal` helpers update-dns calls. Players' idle stops come from the watchdog. | `discord-bot-design.md`, "What it owns" and the DNS and idle-stop bullets |
| `game-server` | The `games.*` IPC channels that call into `EcsService`; the `GameServerHealthCheck` type, validator and write path; the wizard that hosts the health-check fields; the wizard's live cost estimate. `games.start` is refused while a helper upload holds the game. | `docs/intent/game-server/game-server-design.md`, IPC channel table; `health-check-design.md`, "It deliberately does not own" |
| `deployment-config` | Stores the watchdog tunables (`watchdogIntervalMinutes`, `watchdogIdleChecks`, `watchdogMinBytesPerSecond`) and `dnsTtl` that reach the runtime through apply-time env vars. | `docs/intent/deployment-config/deployment-config-design.md`; `watchdog-design.md`, "What it deliberately does not own" |
| `helper-task` | Runs its FileBrowser task in the same cluster under a non-game family, so update-dns and the watchdog skip it; consumes `EcsService` helpers owned by task-and-dns, including the fail-closed `findRunningTaskOrThrow` its file mutations use to refuse writes while the game's task exists. | `docs/intent/helper-task/helper-task-design.md`, "What this leaf deliberately does not own"; `task-and-dns-design.md`, "Event handling" |
| `operator-app/infra-logs` | Consumes `AwsCloudProvider.streamWorkloadLogs` for the game live tail; the Infra Logs page tails the watchdog, health-check and dns-updater functions. | `docs/intent/operator-app/infra-logs/infra-logs-design.md`; `docs/docs/components/lambdas.md`, "The `/server-start` critical path, assembled" |
| `operator-app/desktop-shell` | Binds `CLOUD_PROVIDER`, hosts the Settings page that renders `WatchdogPanel`, and runs the polling registry `GameStatusProvider` registers with. | `docs/arrows/game-runtime/task-and-dns.md` and `watchdog.md`, "Cited from other leaves" |

## Success Metrics

*(not yet specified)*

## Open Questions

1. **Fix sequencing across health-check and watchdog.** Supplying `ECS_CLUSTER` to the health-check function without a network path or a per-invoke time bound would make each check hang to the 30 s function timeout, and two such checks time out the 60 s watchdog run, skipping every later task including CloudWatch-path games (`health-check-design.md`, "Fail-active Layering", `[inferred]` there; `watchdog-design.md`, Deferred 3). Both leaves record the question; which leaf owns the bound, and must `RT-HEALTH-PROV-003`, `RT-HEALTH-PROV-004` and the bound land together?
2. **No game without a health check is auto-stopped today.** The deployed CloudWatch path reads per-ENI `AWS/EC2` metrics that Fargate never publishes (`RT-WATCHDOG-CW-007`, confirmed live 2026-10-31: 368 no-datapoint checks and zero idle verdicts in 7 days), and the health-check path cannot initialise (`RT-HEALTH-PROV-003`, `RT-HEALTH-PROV-004`). The watchdog's replacement source is Container Insights traffic per task family (`RT-WATCHDOG-CW-001`, `RT-WATCHDOG-CW-002`, `RT-WATCHDOG-CW-004`, `IAC-PROGRAM-ECS-001`); until it ships, the subtree's cost goal depends on operators stopping games by hand.
3. **DNS DELETE reliability is load-bearing for every stop issuer.** Decision 1 relies on the STOPPED-path DELETE, but a `dnsTtl` change between UPSERT and DELETE can orphan the record (`RT-TASK-DNS-009`) and a late STOPPED for an old task can delete a newer task's record after a quick restart (`RT-TASK-DNS-010`). Both are task-and-dns gaps; they are listed here because the watchdog and the Discord stop path inherit them.
4. **Cross-process start guard.** `withGameLock` serialises starts only within one desktop process, so a desktop Start and a Discord `/server-start` can both pass the "already running" check (`RT-TASK-LAUNCH-010`; `task-and-dns-design.md`, Deferred 5). Does the subtree need a guard that spans both issuers, and which node would own it?
5. **Ownership of the Discord helpers in `secretsStore.ts`.** `discord-bot-design.md` says `getPublicKey` and its cache (`secretsStore.ts:40-76`) are owned by `game-runtime/health-check`, and `docs/arrows/index.yaml` makes `discord-bot` blocked by `health-check` for that reason; `health-check-design.md` claims only the health-check helpers (`secretsStore.ts:94-194`) and proposes splitting the file. Which reading holds: health-check owns the whole file, or the Discord helpers belong to `discord-bot`?
6. **Within-subtree dependency edges.** The health-check Lambda uses `getTaskPrivateIp`, owned by task-and-dns, but `docs/arrows/index.yaml` does not list `health-check` as blocked by `task-and-dns`. The watchdog's use of `getTaskEniId` ends with the Container Insights traffic measurement (`RT-WATCHDOG-CW-002`). Is the private-IP helper a load-bearing dependency that warrants the edge, or incidental shared code?
7. **Operator docs that disagree with the leaf designs and are not on the leaves' own drift lists.** `docs/docs/components/lambdas.md:232` says a failed watchdog `StopTask` is "logged; next schedule tick retries", whereas `watchdog-design.md` says `StopTask` is unguarded and aborts the rest of the run (`RT-WATCHDOG-STOP-004`); the watchdog IAM row at `lambdas.md:181` omits the `ec2:DescribeNetworkInterfaces` grant that `watchdog-design.md` says `iam.ts` carries. Which leaf tracks these corrections?

## References

### Child design docs and specs

- `docs/intent/game-runtime/task-and-dns/task-and-dns-design.md`, `task-and-dns-specs.md`
- `docs/intent/game-runtime/watchdog/watchdog-design.md`, `watchdog-specs.md`
- `docs/intent/game-runtime/health-check/health-check-design.md`, `health-check-specs.md`

### Arrow tracking

- `docs/arrows/index.yaml` (`game-runtime`, `task-and-dns`, `watchdog`, `health-check` entries)
- `docs/arrows/game-runtime/task-and-dns.md`, `watchdog.md`, `health-check.md`

### Parent and architecture

- `docs/high-level-design.md` (Key Design Decisions 1, 5, 6, 7)
- `docs/docs/architecture.md` ("Control loops (DNS + watchdog)", "The `/server-start` critical path", "Invariants")
- `docs/docs/components/lambdas.md` (update-dns, watchdog, health-check, and the assembled `/server-start` critical path)
- `CLAUDE.md` ("Invariants that hurt to break")

### Legacy requirement and rationale sources

- `openspec/specs/game-health-checks/spec.md`, `openspec/specs/cost-visibility/spec.md`, `openspec/specs/in-task-tls-termination/spec.md`
- `openspec/changes/add-pluggable-health-checks/design.md`, `openspec/changes/add-healthcheck-auth-type/design.md`
