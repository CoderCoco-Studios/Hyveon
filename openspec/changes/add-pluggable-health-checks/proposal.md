## Why

The watchdog decides whether to stop a running game server using one heuristic applied
identically to every game: CloudWatch `AWS/EC2 NetworkPacketsIn` on the task's elastic
network interface. Packet counts are a proxy for "someone is connected", not an answer,
and the watchdog has no way to ask the game itself. Games increasingly expose an
authoritative answer over an HTTP management API — Palworld's REST API is the concrete
trigger, having replaced the RCON interface that would otherwise have been the obvious
integration point — but the system has no seam through which any game-aware check can be
plugged in.

## What Changes

- Introduce an optional per-game `healthCheck` field on `GameServer`. A game that declares
  one is judged active or idle by that check; a game that omits it keeps today's
  network-packet heuristic unchanged. The check **replaces** the heuristic rather than
  being combined with it, so exactly one verdict source applies to any given game.
- Add one supported check kind, `http`: a declarative description of a request (scheme,
  port, path, method, headers, optional Secrets Manager-backed auth, timeout) and a single
  response condition (`jsonPath`, comparison operator, value) that determines whether the
  server counts as active. No operator-authored code executes anywhere in this change; a
  follow-up change will propose sandboxed operator scripting as a second kind.
- Add a new Lambda that performs these checks. It is provisioned only when at least one
  game declares a `healthCheck`, mirroring the existing efs-seeder pattern where per-game
  functions exist only for games that declare `file_seeds`. It is the first Lambda in the
  system that makes network calls *to* a game task rather than to AWS APIs, so it is
  VPC-attached with egress restricted to the ports opted-in games declare, toward the
  game-server tasks only, and its Secrets Manager access is scoped to exactly the secrets
  those games reference.
- Preserve the watchdog's existing structure. It continues to own the idle loop — list
  running tasks, obtain a verdict, maintain the consecutive-idle counter in the ECS task
  tag, stop the task — and gains no VPC attachment and no credentials. Only the source of
  the verdict changes.
- Establish fail-active as the universal failure semantic: a check that times out, is
  refused, returns a non-2xx status, returns unparseable JSON, resolves no value at its
  JSONPath, or whose Lambda cannot be invoked at all reports the server as **active**.
  This matches the watchdog's existing behavior when a CloudWatch metric query fails.
- Validate `healthCheck` configuration at save time in the operator app, so a
  misconfiguration surfaces in the wizard rather than in a Lambda log at 3am.

## Capabilities

### New Capabilities

- `game-health-checks`: How the system determines whether a running game server is active
  or idle — the per-game check configuration, the declarative HTTP check kind and its
  evaluation rules, the fail-active failure semantics, the security boundary around
  reaching into a game task, and the operator-facing validation and observability of that
  decision.

### Modified Capabilities

- `lambda-runtime-currency`: The requirement enumerates the deployed Lambda functions as
  a closed set of five. A sixth, conditionally provisioned function joins that set and is
  subject to the same supported-runtime and bundle-target rules, so the enumeration and
  its scenario must account for a function that may or may not exist in a given
  deployment.

## Impact

- **`@hyveon/shared`** — `GameServer` gains the optional `healthCheck` field; the zod
  schema in the game-server validator gains its validation rules, including the
  cross-field rule that the declared port must appear in the game's `ports` list.
- **New Lambda package** under `app/packages/lambda/` — the check engine (a pure function
  of configuration and HTTP response) and its handler.
- **`app/packages/lambda/watchdog`** — routing between the CloudWatch heuristic and the
  new Lambda, and threading the returned reason into its existing per-task log line.
- **`app/packages/infra`** — conditional provisioning of the function, its role, its
  security group and the paired egress/ingress rules against each opted-in game's task
  security group, its VPC configuration, and the watchdog's permission to invoke it.
- **`@hyveon/web`** — the add/edit-game wizard surfaces the health-check configuration,
  exposing a `secretSet` boolean rather than any secret value.
- **Documentation** — `docs/docs/components/lambdas.md`,
  `docs/docs/components/infra.md`, and the wizard page under `docs/docs/app/`.
- **No change** to watchdog state storage (ECS task tags), to the no-persistent-service
  model, or to any existing game's behavior: a deployment where no game declares a
  `healthCheck` provisions nothing new and behaves exactly as it does today.
