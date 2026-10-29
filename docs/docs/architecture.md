---
title: Architecture
sidebar_position: 2
---

# Architecture

Three loosely-coupled pieces, all sharing types and helpers through a single
workspace package, `@hyveon/shared`:

1. **`app/packages/infra`** provisions the Pulumi-managed application stack —
   a Pulumi Automation API program (TypeScript), not a CLI-driven, file-based
   config tree. It is not the *only* way AWS resources reach this account: a
   one-time IAM bootstrap CloudFormation template and a handful of
   `BootstrapService` AWS-SDK calls exist outside it — see
   [Infra program](/components/infra) for the exact boundary.
2. The **management app** is a packaged Electron desktop app and the local
   control plane. Its React/Vite renderer talks to the Nest.js backend
   (`desktop-main`) over Electron IPC — not HTTP. The backend reads the
   deployed Pulumi stack's outputs (via `PulumiService.getStackOutputs()`,
   against the S3 state backend — no local state file) to discover what the
   infra looks like, and drives AWS via the cloud-provider abstraction (SDK
   v3 under the hood).
3. Six **Lambda packages** run the control flow: two for Discord, one for
   DNS, one for the idle watchdog — all four always deployed — plus two
   conditional Lambdas: a shared `health-check` function, provisioned once
   when at least one game declares a `healthCheck`, and a per-game
   `efs-seeder` Lambda, deployed once per game that declares `file_seeds`
   (zero, one, or many instances, never a fixed count).

## Why Pulumi

The project originally provisioned infrastructure with a CLI-driven,
HCL-based tool and migrated to Pulumi mid-way through
(`migrate-iac-to-pulumi`). Three reasons drove it: **multi-cloud
optionality** — Pulumi's provider model makes a future non-AWS cloud a new
package alongside `app/packages/infra`, using the same `CloudProvider`
abstraction the desktop app already has, rather than a second HCL module
tree; **no separate HCL round-trip** — the program is TypeScript end to end,
so there's no state-diffing or code-generation step between the app's own
types (`DeploymentConfig`, `GameServerConfig`) and the infrastructure that
consumes them; and **no operator-installed CLI binary** — the Automation API
lets the app drive Pulumi as a library, with `PulumiEngineService`
provisioning the pinned engine itself, instead of requiring a separate CLI
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
then drives AWS through a mix of abstraction and direct SDK v3 calls: ECS
start/stop/status/logs/cost go through the `CloudProvider` abstraction
(`@hyveon/cloud-aws` underneath), secrets go through a separate `SecretsStore`
abstraction, and DynamoDB reads/writes go straight through the AWS SDK v3
client with no abstraction layer. Players reach the game directly at the
task's public IP either way — UDP/TCP games connect straight to the game
port, and HTTPS games terminate TLS in-task via a Caddy sidecar that shares
the same public IP and proxies to the game's explicit `webPort`, which is never
exposed directly. There is no load balancer anywhere in the path.

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
reply with the resolved address. `watchdog` fires on a schedule and stops a task once it's looked idle for
`IDLE_CHECKS` consecutive intervals — it issues `StopTask` only; it never
touches Route 53 itself, `update-dns` reacts to the resulting `STOPPED`
event. How "idle" is decided is per-game: a game with no declared
`healthCheck` falls back to the `NetworkPacketsIn`-below-threshold check;
a game that declares one delegates the verdict to the health-check Lambda
instead, invoked over the network via the IAM identity-policy grant described
in [Infra program](/components/infra#health-check-network-confinement-is-port-level-not-game-level).

![Control loops](/diagrams/control-loops.svg)

## The `/server-start` critical path

When a user types `/server-start palworld` in Discord, five AWS services and
three Lambdas cooperate to return a usable `palworld.yourdomain.com` without
ever letting the interaction time out.

![/server-start sequence](/diagrams/server-start.svg)

After the session: either the user types `/server-stop palworld` (same flow
but `stopTask` + `DELETE` A record), or the Watchdog Lambda decides the task
has been idle for four consecutive 15-minute windows and stops it itself —
`NetworkPacketsIn < min_packets` for a game with no declared `healthCheck`,
or a negative verdict from the health-check Lambda for a game that declares
one.

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
   overridden. The infra program sets `AWS_REGION_` on every provisioned
   Lambda function. The four always-deployed packages and the conditional
   `health-check` package read `process.env.AWS_REGION_` when provisioned
   (`efs-seeder` makes no AWS SDK calls and never reads it).

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

8. **The file-manager security group has no default ingress.**
   `securityGroups.ts` declares it with an empty `ingress` array.
   When the desktop app launches a FileBrowser helper it detects the operator's current public IP and authorizes only `<ip>/32` on port 8080, and tags the task `OperatorIp`.
   If the operator's IP changes mid-session the app authorizes the new `/32` and re-tags the task.
   Revoking is reference-counted by that tag: a rule is removed only when no remaining helper needs its CIDR, because two helpers on the same IP share one rule.

9. **One app-owned helper session per game, and its secrets never leave the main process.** `HelperSessionRegistry` (in `desktop-main`) owns at most one FileBrowser helper per game, shared by file browsing and folder upload.
   - **Encrypted and pinned.** Every helper the registry launches is served over HTTPS with a per-launch self-signed certificate. The app pins that certificate's SHA-256 fingerprint rather than trusting a CA, and a pin mismatch fails the session closed (the helper is stopped and its rule revoked).
   - **Ready means reachable.** A session is ready only once the task is `RUNNING`, has a public IP, and a login over the pinned connection has succeeded.
   - **Nothing sensitive crosses IPC.** The one-time credential, the helper's address, and the certificate stay in the main process; the session snapshot the registry produces carries none of them (only the game, state, who holds the session, start and auto-stop times, any error, whether folder archives are supported, and the volumes).
   - **Holders, not timers, decide lifetime.** A session ends on an explicit stop, when its last holder (the browse page or an upload run) releases it — after a 5-minute grace once the browse page has left, otherwise immediately; an upload that finishes while that grace is still pending leaves the helper running until the grace ends — or when the app quits (a bounded `before-quit` hook stops owned helpers, then quits regardless). The 2-hour EventBridge Scheduler auto-stop is the backstop.
   - **Orphans are reported, not adopted.** A helper running with no matching app session (its credential is unknown) is reported as `orphaned`; the registry never adopts it or stops it silently, so an orphan can only be replaced by a restart (stop, then a fresh session). The startup sweep in item 10 is separate: it stops unowned `filemgr-*` helpers older than 15 minutes.

   There is no plain-HTTP path and no second way to launch a helper: `FileManagerService.launchHelper` is called only by the registry, and the former `files.list|start|stop` IPC channels and the dashboard file-manager modal are gone. The renderer's in-app file browser (`/games/:name/files`) goes through the registry via the `volumeFiles.*` channels, and the folder-upload card reaches it through `FolderUploadService` via the `folder*` channels (its only `volumeFiles.*` call is stopping a leftover session). The renderer never receives the helper's credential, address, URL or token; it receives session state, volume names and container paths, file metadata (names, sizes, times), file content it asks to view or edit, transfer progress, and error messages with the helper address scrubbed.

10. **Stray helpers are swept, by age.** At startup the app stops every running `filemgr-*` helper that is at least 15 minutes old, whatever its `Purpose` tag, and revokes the security-group rules no remaining helper needs. The operator-requested cleanup does the same with no age floor, but skips games with an active upload run or a registry-owned session so a live session is never swept out from under its holder. (At startup nothing is owned yet, so there is nothing to skip.) Whatever outlives a bounded quit is left to the next launch's sweep.

See the [maintainer guide](/guides/maintainer) for
what tends to break these and what the failure modes look like.
