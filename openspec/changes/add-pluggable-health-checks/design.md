## Context

See `proposal.md` — Why. The constraints that shape the approach are all existing structure:

- The watchdog (`app/packages/lambda/watchdog/src/handler.ts`) is a single flat handler: list
  RUNNING tasks, map task-def family to game via `FAMILY_TO_GAME`, resolve the ENI, query
  CloudWatch, then maintain the `idle_checks` ECS task tag and call `StopTask`. Its
  fail-active behavior already exists — `getNetworkPackets` returns `MIN_PACKETS + 1` on a
  failed or empty metric query.
- The infra program has one established pattern for conditional resources, the efs-seeder
  (`iam.ts` `gamesWithFileSeeds`, `lambdas.ts` per-game loop, `securityGroups.ts`
  `efsSeederSg`). Its notable discipline: the set of participating games is derived **once**
  into the roles map, and every later loop iterates the roles map rather than re-deriving
  from configuration, so the sets cannot drift.
- Only the efs-seeder Lambdas have a `vpcConfig` today. Any VPC-attached Lambda also needs
  the `ec2:CreateNetworkInterface` / `DescribeNetworkInterfaces` / `DeleteNetworkInterface`
  statement its policy already carries.
- **All game-server tasks share one security group** (`gameServersSg`), whose ingress is a
  merged, de-duplicated list of every game's ports. There are no per-game security groups.
- `gameServerConfig.ts` declares optional fields as plain `?:` with a TSDoc stating the
  behavior when omitted; `gameServerValidator.ts` splits structural validation (zod schema)
  from business rules (`check*` functions returning `GameServerValidationIssue[]` with
  path strings).
- Lambda bundling is an explicit enumeration in `app/package.json`'s `build:lambdas`, not a
  glob, even though the workspace itself globs `app/packages/lambda/*`.

## Goals / Non-Goals

**Goals:**

- A seam for game-aware liveness that the watchdog consults instead of CloudWatch, without
  restructuring the watchdog's loop or its state model.
- One concrete kind (`http`) that is expressive enough for management APIs of the Palworld
  shape, and no more.
- A security posture for the new "component reaches into a game task" direction that is
  driven entirely by declared configuration, with no operator-supplied value able to widen
  it.
- Zero footprint — no resources, no IAM, no cost, no behavior change — for deployments where
  no game opts in.

**Non-Goals:**

- Any game-specific preset, profile, or built-in knowledge of a particular game's API.
- Operator-authored scripts. That is a separate proposed change and the reason `kind` is a
  discriminator from the first version.
- Per-game security groups. See Risks.
- Any change to how watchdog state is stored, to the idle-count thresholds, or to the
  no-persistent-service model.
- Replacing the network-packet heuristic. It remains the default and the only behavior for
  games that do not opt in.

## Decisions

### A separate Lambda rather than checking inside the watchdog

The watchdog is the single component every game's shutdown depends on. Giving it a
`vpcConfig`, egress into the game network, and `secretsmanager:GetSecretValue` for every
opted-in game's credential would widen the blast radius of the one function that must not
misbehave, and would add ENI-attachment cold-start latency to a function on a tight
schedule.

The alternative considered was a Lambda per opted-in game, exactly mirroring efs-seeder.
That buys per-game credential and network isolation but multiplies functions, roles, log
groups, and cold starts for a check that is identical in shape across games. A single shared
health-check function, conditionally provisioned, keeps the efs-seeder pattern's
"exists only if needed" property without its per-game multiplication. Per-game isolation of
credentials is preserved anyway by scoping the policy to the specific secret ARNs; what is
given up is that a compromise of the function itself sees all opted-in games' credentials
rather than one. Accepted: the function executes no operator-supplied code in this change,
which is the property that would make that distinction urgent.

The watchdog invokes it synchronously (`RequestResponse`), which is structurally the same
per-task blocking call the CloudWatch query already is.

### The check engine is a pure function, separated from the handler

`(config, responseStatus, responseBody) → { active, reason }` with no I/O. The entire
decision matrix — six operators, JSONPath hit and miss, non-comparable values, unparseable
bodies — is then table-testable with no AWS mocking, and the handler is left with only the
parts that genuinely need mocking (ECS attachment lookup, secret fetch, the HTTP call). This
mirrors how `canRun()` is kept as a pure, separately-testable unit in `@hyveon/shared`.

### Verdict routing lives in the watchdog, keyed by an env-var map

The watchdog needs to know which games opted in. Rather than reading `DeploymentConfig` at
runtime (it does not today, and giving it S3 access would widen it), the infra program passes
a JSON env var mapping game name to the fact that a check exists — the same technique
`connectMessagesByGame` and `firstPortByGame` already use for other functions. The watchdog's
branch is then a map lookup on the game it has already resolved from the task-def family.

The check configuration itself is passed to the health-check Lambda the same way, so that the
watchdog never handles a secret ARN or a request path.

Alternative considered: have the watchdog always invoke the health-check Lambda and let that
Lambda decide. Rejected — it would provision the function unconditionally, losing the
zero-footprint property, and would put a network hop in front of every idle decision in every
deployment.

### Fail-active is implemented at every layer, not just in the engine

The engine returns fail-active for response-shaped failures. The handler returns fail-active
for transport and credential failures. The watchdog treats a failed *invoke* — throttling, a
function that does not exist, a timeout — as fail-active too. Each layer's failure mode is
handled at that layer rather than relying on the one below it, because the failure that
matters most (the function is absent or unreachable) is precisely the one where no lower
layer runs at all.

### Configuration validation splits along the existing seam

Structure goes in the zod schema (`gameServerHealthCheckSchema`, referenced as
`healthCheck: gameServerHealthCheckSchema.optional()`); cross-field business rules go in a
`checkHealthCheckRules` function gated on presence, alongside `checkHttpsPortRules` and
`checkPortCollisions`. The rule that the declared port must appear in the game's `ports` is
inherently cross-field and belongs in the second group; `path` shape, `timeoutMs` bounds, the
operator enum, and the ARN pattern are structural and belong in the first.

### The destination host is never configurable

The handler resolves the task's private address from the ECS `DescribeTasks` attachment
details, the same source `getEniId` already reads in the watchdog. The configuration supplies
scheme, port, path, method, and headers — never a host. This is what makes the SSRF surface
closed by construction rather than by validation: there is no field to validate, because
there is no field.

## Risks / Trade-offs

**Shared game-server security group means port-level, not game-level, network confinement** →
Egress is granted toward `gameServersSg` on the union of declared health-check ports. A
non-opted-in game listening on a port some opted-in game also uses is reachable. Mitigation:
the request is addressed to a specific task's private address resolved from ECS, so
reachability is not the same as a request being made; the spec states the confinement
accurately rather than overclaiming; and splitting `gameServersSg` into per-game groups is
recorded here as the follow-on that would close it. Not done in this change because it would
touch every ingress rule and task definition, dwarfing the feature.

**A misconfigured check silently keeps a server running forever** → Fail-active is
deliberately the safe direction for players and the unsafe direction for cost. Mitigation:
every failure-derived verdict logs at `warn` with the normalized message, so a persistently
broken check is visible as a repeating fault rather than as silence. This is the accepted
trade: the opposite default can stop a live server with players on it.

**The single-condition `activeWhen` will not fit some game's API** → Accepted deliberately. A
boolean expression tree is the first step toward an interpreter, and the proposed scripting
change is the honest answer to that need. If a game needs AND/OR before then, it keeps the
network heuristic.

**A game's management API may return player names or addresses** → Response bodies are never
logged, only the derived verdict and reason. The `reason` for a condition failure names the
JSONPath and the operator, not the value found.

**Adding a Lambda package is easy to half-finish** → `build:lambdas` in `app/package.json`
enumerates packages explicitly, so a new package that is not added there produces a missing
`handler.cjs` at apply time rather than a build error. The tasks make this an explicit step.

## Migration Plan

No migration. The field is optional and absent from every existing configuration, so an
applied deployment is byte-identical until an operator opts a game in. Rolling back is
removing the field from that game's configuration and re-applying, which returns the game to
the network heuristic and de-provisions the function once no game declares a check.
