---
title: Architecture
sidebar_position: 2
---

# Architecture

Three loosely-coupled pieces, all sharing types and helpers through a single
workspace package, `@hyveon/shared`:

1. **`app/packages/infra`** provisions every AWS resource — a Pulumi
   Automation API program (TypeScript), not a CLI-driven `.tf` tree. There
   is no `.tf` file anywhere in this repository.
2. The **management app** is a packaged Electron desktop app and the local
   control plane. Its React/Vite renderer talks to the Nest.js backend
   (`desktop-main`) over Electron IPC — not HTTP. The backend reads the
   deployed Pulumi stack's outputs (via `PulumiService.getStackOutputs()`,
   against the S3 state backend — no local state file) to discover what the
   infra looks like, and drives AWS via the cloud-provider abstraction (SDK
   v3 under the hood).
3. Five **Lambda packages** run the control flow: two for Discord, one for
   DNS, one for the idle watchdog — all four always deployed — and one
   conditional per-game `efs-seeder` Lambda, deployed once per game that
   declares `file_seeds` (zero, one, or many instances, never a fixed fifth
   function).

### Why Pulumi, not Terraform

The project started on Terraform and migrated to Pulumi mid-way through
(`migrate-iac-to-pulumi`). Three reasons drove it: **multi-cloud
optionality** — Pulumi's provider model makes a future non-AWS cloud a new
package alongside `app/packages/infra`, using the same `CloudProvider`
abstraction the desktop app already has, rather than a second HCL module
tree; **no separate HCL round-trip** — the program is TypeScript end to end,
so there's no state-diffing or code-generation step between the app's own
types (`DeploymentConfig`, `GameServerConfig`) and the infrastructure that
consumes them; and **no operator-installed CLI binary** — the Automation API
lets the app drive Pulumi as a library, with `PulumiEngineService`
provisioning the pinned engine itself, instead of requiring a `terraform`
binary on the operator's machine.

There is **no persistent ECS service**. Game servers only exist while a
RunTask is in flight — Start triggers `ecs.runTask`, Stop triggers
`ecs.stopTask`, and the Watchdog Lambda stops tasks that look idle.

## Component diagrams

The system splits cleanly into three slices. Each is shown on its own
rather than jammed into one overview — the cross-cluster arrows that
arise when you draw all three together (Discord Lambdas talking to ECS,
EventBridge talking to update-dns, the dashboard talking to everything)
route through neighbouring subgraphs and produce unreadable overlap.

### Game plane and operator control

The Electron app's Nest.js backend is the local control plane, driven by
its React/Vite renderer over Electron IPC (`window.hyveon`) rather than HTTP.
It reads the deployed Pulumi stack's outputs to discover infrastructure IDs,
then drives ECS / DynamoDB / Secrets Manager / CloudWatch via the
cloud-provider abstraction (SDK v3 under the hood). Players reach the game directly at the
task's public IP either way — UDP/TCP games connect straight to the game
port, and HTTPS games terminate TLS in-task via a Caddy sidecar that shares
the same public IP. There is no load balancer anywhere in the path.

![Game plane and operator](/diagrams/game-plane.svg)

### Serverless Discord bot

Two Lambdas and a single DynamoDB table handle every slash command.
`interactions` is the synchronous entry point behind a Function URL —
it verifies the Ed25519 signature, replies with a deferred ack within
Discord's 3-second budget, then fires the async `followup` Lambda for
anything that touches ECS.

![Serverless Discord bot](/diagrams/discord-bot.svg)

### Control loops (DNS + watchdog)

EventBridge drives the two "always on" Lambdas that keep DNS and idle
shutdown in sync with actual task state. `update-dns` fires on every
ECS task state change, UPSERTing the Route 53 A record on `RUNNING` and
deleting it on `STOPPED`. It reconciles the pending-interaction row in
DynamoDB on the `RUNNING` path only, where it patches the deferred Discord
reply with the resolved address. `watchdog` fires on a schedule and
stops tasks whose `NetworkPacketsIn` has stayed below the threshold for
`IDLE_CHECKS` consecutive intervals — it issues `StopTask` only; it never
touches Route 53 itself, `update-dns` reacts to the resulting `STOPPED`
event.

![Control loops](/diagrams/control-loops.svg)

## The `/server-start` critical path

When a user types `/server-start palworld` in Discord, five AWS services and
three Lambdas cooperate to return a usable `palworld.yourdomain.com` without
ever letting the interaction time out.

![/server-start sequence](/diagrams/server-start.svg)

After the session: either the user types `/server-stop palworld` (same flow
but `stopTask` + `DELETE` A record), or the Watchdog Lambda notices
`NetworkPacketsIn < min_packets` for four consecutive 15-minute windows and
stops the task itself.

## Invariants

These are easy to break by accident. They are spelled out in `CLAUDE.md`, the
maintainer guide, and inline in a few `app/packages/infra` source files. If
you change one, write the PR description as if you're explaining the new
design.

1. **`DeploymentConfig.gameServers` is the single source of truth.**
   It's persisted as the JSON object `deployment-config.json` in the
   operator's S3 configuration bucket. Task definitions, EFS access points,
   log groups, security-group rules, and the `GAME_NAMES` env var on four
   Lambdas (interactions, followup, update-dns, watchdog) are all produced
   by resource-defining functions in `app/packages/infra` that each loop
   over this map internally. Adding or removing a game means editing
   exactly one entry.

2. **DNS is Lambda-managed, not infra-program-managed.** `route53.ts`
   declares zero resources — only a hosted-zone data-source lookup;
   individual A records are created and deleted by the update-dns Lambda in
   response to ECS task state changes. Adding a per-game
   `aws.route53.Record` resource would fight the Lambda.

3. **Lambdas use `AWS_REGION_` (trailing underscore).** The standard
   `AWS_REGION` name is reserved by the Lambda runtime and cannot be
   overridden. The infra program sets `AWS_REGION_` on all five Lambda
   functions; the four core Lambdas read `process.env.AWS_REGION_` (the
   fifth, `efs-seeder`, makes no AWS SDK calls and never reads it).

4. **Secrets never leave AWS.** The bot token and the Discord public key
   live in Secrets Manager. The management app can write them and
   `getEffectiveToken()` once (to register guild commands), but they are
   never sent to the browser — the API only returns `botTokenSet` /
   `publicKeySet` booleans.

5. **Per-guild command registration only.** `DiscordCommandRegistrar.registerForGuild`
   PUTs to `applications/{client_id}/guilds/{guild_id}/commands`. Do not
   register global commands — they would leak to every guild the bot is
   invited to.

6. **Permission resolution lives in `canRun()` in `@hyveon/shared`.** The server
   and both Discord Lambdas import the same function. Do not duplicate the
   logic; do not reorder the checks (guild allowlist → admin → per-game).

7. **Watchdog state lives in ECS task tags.** There is no DynamoDB/SSM for
   the idle counter — it is an `idle_checks` tag on each running task.
   Counter resets when a task stops, which is free.

See the [maintainer guide](/guides/maintainer) for
what tends to break these and what the failure modes look like.
