---
parent: high-level-design
prefix: DISCORD
---

# Discord Bot

## Context and Design Philosophy

The Discord bot lets players start, stop and check game servers from slash commands in the operator's Discord guilds, without the operator opening the desktop app and without any bot process running anywhere. It is the main player-facing entry point to Hyveon's on-demand cost model: a `/server-start` issues one `RunTask` against `{game}-server`, and the rest of the lifecycle (DNS, idle stop) is handled by other leaves.

The design is shaped by one CLAUDE.md invariant above all others: "Discord is fully serverless: no discord.js, no gateway connection, no bot process." Discord delivers every interaction as a signed HTTPS POST to an Interactions Endpoint URL, and Hyveon answers with two Lambdas and a DynamoDB table. Everything else in this leaf follows from that choice: the 3-second reply budget forces a defer-then-PATCH split across two functions, the interaction token's 15-minute lifetime bounds the pending-row TTL, and the absence of a gateway means commands must be pushed to Discord over REST by the operator.

What it owns:

- The interactions Lambda: signature verification, PING, autocomplete, the allowlist and permission gate, and the async hand-off (`app/packages/lambda/interactions/src/handler.ts:301-338`).
- The followup Lambda: the ECS work behind each command and the PATCH of the deferred reply (`app/packages/lambda/followup/src/handler.ts:238-273`).
- The single permission evaluator `canRun()` (`app/packages/shared/src/canRun.ts:19-38`).
- The Discord DynamoDB row shapes and their readers/writers: `CONFIG#discord`, `BASE#discord` (`app/packages/shared/src/ddb/configStore.ts:7-11`) `PENDING#{taskArn}` (`app/packages/shared/src/ddb/pendingStore.ts:8-10`) and the per-game start lease `LAUNCH#{game}` / `LOCK` (`app/packages/shared/src/aws/startLease.ts:56-58`), which this leaf's followup shares with the desktop Start.
- The four slash-command descriptors (`app/packages/shared/src/commands.ts:29-73`) and per-guild registration (`app/packages/desktop-main/src/services/DiscordCommandRegistrar.ts:61-110`).
- Message rendering shared with update-dns (`app/packages/shared/src/formatStatus.ts:16-60`) and the webhook PATCH helper (`app/packages/shared/src/discord/patchOriginal.ts:17-32`).
- The desktop configuration surface: `DiscordConfigService`, `DiscordController`'s eleven `discord.*` IPC channels, and the Discord page in `@hyveon/web`.

What it deliberately does not own:

- **Provisioning.** The two functions, the Function URL and its CORS, the `discord.{zone}` CloudFront distribution and us-east-1 ACM certificate, the Discord table, the two placeholder secrets and the seed rows are all resources in `iac/program` (`app/packages/infra/src/lambdas.ts:415-500`, `discordDomain.ts`, `dynamodb.ts:111-125`, `secrets.ts`, `escapes.ts`).
- **DNS and the connect follow-up.** When the started task reaches RUNNING, `game-runtime/task-and-dns` reads the pending row, PATCHes the same interaction with the address and deletes the row (`app/packages/lambda/update-dns/src/handler.ts:176-198`). This leaf only writes the row.
- **Idle stop.** Tasks started from Discord are stopped by `game-runtime/watchdog`, not by anything here.
- **Which games exist.** Game names, ports and connect-message templates come from `DeploymentConfig.gameServers` (`deployment-config` leaf) and are baked into Lambda env vars at deploy time (`lambdas.ts:433-435`, `:462`).
- **The secrets client.** `getPublicKey` and its 5-minute in-process cache live in `app/packages/shared/src/secrets/secretsStore.ts:40-76`, owned by `game-runtime/health-check`.
- **The IPC transport.** `operator-app/ipc-bridge` owns the preload bridge and `requireStringArray` (`app/packages/desktop-main/src/controllers/validation.ts`).

CLAUDE.md invariants that live here:

- Fully serverless, no discord.js: the PATCH and the registration PUT use global `fetch` (`patchOriginal.ts:23`, `DiscordCommandRegistrar.ts:90`).
- Register commands per guild only: the registrar only calls the guild-scoped bulk-overwrite endpoint (`DiscordCommandRegistrar.ts:88`).
- `canRun()` exists exactly once in `@hyveon/shared`; both Lambdas import it (`interactions/src/handler.ts:20-22`, `followup/src/handler.ts:24-26`) and the file states the rule (`canRun.ts:16-17`).
- Secrets never reach the renderer: the redacted shape carries `botTokenSet`/`publicKeySet` booleans only (`DiscordConfigService.ts:257-273`).
- Lambda env vars use `AWS_REGION_` (`interactions/src/handler.ts:58-60`, `followup/src/handler.ts:53-60`, `lambdas.ts:427`, `:458`).
- `@hyveon/shared`'s barrel stays free of new AWS SDK imports: the Discord DynamoDB helpers use the `@aws-sdk/lib-dynamodb` client the barrel already carries.

## Request Path: Interaction to Reply

Discord POSTs to `https://discord.{zone}/`. CloudFront forwards every method with caching disabled to the Function URL (`app/packages/infra/src/discordDomain.ts:163-182`), which has `authorizationType: 'NONE'` and CORS limited to POST from `https://discord.com` (`lambdas.ts:473-484`). Signature verification in the handler is therefore the only authentication on the path.

### Interactions Lambda

The handler runs these steps in order (`interactions/src/handler.ts:301-338`):

1. Resolved: `DiscordConfigService.load()` no longer backs any write and the page's redacted read rejects instead of degrading (`DISCORD-DESK-004`, `DISCORD-UI-008`).
2. Read the raw body, base64-decoding if needed, and never re-stringify it, because the signature covers the raw bytes (`:135-140`, `:306`).
3. Load the Ed25519 public key from Secrets Manager; a missing or placeholder value returns 401 (`:308-310`, `secretsStore.ts:71-76`). The key is cached per warm container for 5 minutes (`secretsStore.ts:43-54`).
4. Verify `timestamp + rawBody` with `@noble/ed25519`; any parse or verify error is a 401 (`:82-96`, `:312-313`).
5. Validate timestamp freshness on the now-verified timestamp: reject with 401 a timestamp that is not a non-negative integer, or that differs from the Lambda clock by more than 30 seconds in either direction (`:267-288`, `:314`). The window is ±30 seconds around the signed timestamp, so a captured request can remain replayable for up to 60 seconds in the worst case; the check bounds replay but does not prevent it.
6. Resolved: user-facing replies carry a fixed message instead of `String(err)` (`DISCORD-RUN-012`; see the "Raw error text in Discord replies" row).
7. Resolved: the invoke stays awaited but is bounded by the ack deadline with a check-status notice, and the module header says so (`DISCORD-CMD-009`; see the "Followup invoke bound" row).
8. Dispatch autocomplete (type 4) or application command (type 2); anything else gets an ephemeral "Unsupported interaction type." (`:330-337`).

Autocomplete filters the `GAME_NAMES` env list by substring, then by `canRun` for the command's action, caps at 25 and answers in-band (`:157-184`). Because `canRun`'s first step is the guild allowlist, an unlisted guild sees an empty picker. The game list is the deploy-time snapshot, not a live read.

Application commands map the command name to an action (`:138-150`): `server-start` → `start`, `server-stop` → `stop`, `server-status` and `server-list` → `status`. This mapping is duplicated in `actionForCommand` (`commands.ts:10-20`), which the Lambda does not import. The gate is then (`:180-237`):

| Case | Gate before defer | Reply |
|---|---|---|
| Unknown command name | none | ephemeral "Unknown command" (`:186`) |
| Guild not in `allowedGuilds` | explicit allowlist check (`:188-191`) | ephemeral "not enabled in this server" |
| `/server-list`, or `/server-status` with no game | allowlist only | defer, followup `kind: 'list'` (`:197-219`) |
| Game-bearing command with no game | allowlist | ephemeral "Game is required." (`:221`) |
| `canRun` false | full `canRun` (`:223-225`) | ephemeral "You don't have permission…" |
| Otherwise | full `canRun` | defer, followup `kind: action` (`:227-236`) |

The deferred reply is type 5 with the ephemeral flag. Before returning it, the handler awaits `InvokeCommand` with `InvocationType: 'Event'` on `FOLLOWUP_LAMBDA_NAME` (`invokeFollowup`), because Lambda freezes the execution environment once the handler returns and an unawaited invoke may never be sent. The invoke is asynchronous on the AWS side, but its API call still sits inside Discord's 3-second budget, so it is bounded to the smaller of 2 seconds and the time left until 2.8 seconds after handler entry (never below 250 ms), because the secret read, the config read and the invoke are sequential. The ack path therefore makes three AWS calls in order: the signature secret read, the two-row config read (not bounded; two DynamoDB point reads) and the bounded invoke. When the invoke times out or is rejected, `deferToFollowup` logs the normalised error with identifiers only and answers with an ephemeral "Could not confirm that the command was sent. It may already be starting: check `/server-status` before retrying." (type 4) instead of throwing, so the user sees a notice rather than "This interaction failed". The timeout leaves the outcome of the invoke unknown: a late-accepted invoke can still run the command, so a retry may run the followup twice, which is safe because `/server-start` is guarded by the start lease (`startWithLease`) and `/server-stop` is idempotent while list and status only read (`DISCORD-CMD-014`). The function's own timeout is 10 seconds (`lambdas.ts:454`).

### Followup Lambda

The followup event is a hand-written mirror of the interactions payload: `FollowupEvent` (`followup/src/handler.ts:40-48`) duplicates `FollowupPayload` (`interactions/src/handler.ts:246-254`) field for field, with no shared type and no runtime validation of the incoming event.

The handler (`followup/src/handler.ts:238-273`) re-reads the effective config, then inside a `try` re-checks `canRun` for game-bearing kinds (`:219-228`, `:247-263`) on the stated grounds that config "could have changed in the milliseconds since" (`:219`). The work per kind:

| Kind | Work | Source |
|---|---|---|
| `list` | filter `GAME_NAMES` by `canRun(..., 'status')`, then `getStatus` for each in parallel, one line per game | `:164-179` |
| `status` | `ListTasks` (family `{game}-server`, desiredStatus RUNNING) + `DescribeTasks`; if RUNNING, resolve the ENI public IP via EC2 | `:79-116`, `:181-185` |
| `start` | take the start lease (`startWithLease`); refuse with "A start for {game} is already in progress." when another start holds it, or "An upload into {game} is in progress. ..." when a desktop upload does (`DISCORD-RUN-016`), or "{game} is already running." when the strict pre-check finds a task; else `RunTask` FARGATE with public IP, `propagateTags: 'TASK_DEFINITION'` and the lease id as `clientToken`; on a task ARN, write the pending row and append the connect message with `{ip}` blank | `:126-167`, `:209-234` |
| `stop` | find the running task, `StopTask` with reason "Stopped via Discord" | `:150-162`, `:214-217` |

`propagateTags: 'TASK_DEFINITION'` (`:150`) is what carries the task definition's tags onto the task, which the watchdog's `idle_checks` tag and cost allocation rely on [inferred]. The already-running check runs only after the lease is held (`:134-138`), so two concurrent `/server-start` calls, or a `/server-start` racing a desktop Start, cannot both reach `RunTask` (`DISCORD-RUN-002`, `DISCORD-RUN-004`, `RT-TASK-LAUNCH-015`, `RT-TASK-LAUNCH-016`).

A failed ECS call is turned into a fixed reply by `failureReply` ("Could not start {game}. Check server logs." and the stop equivalent); the normalised error (or the `RunTask` failure reason) goes to the log with the game name only, never into the Discord channel, because SDK text can carry ARNs and account details. A failed status lookup likewise logs and yields the `error` state, which `formatGameStatus` renders without the message. Anything else that throws inside the `try` is caught, logged with the whole event (including `interactionToken`) at `:268`, and replaced with "Command failed. Check server logs." (`:269`). Two steps sit outside the `try`: the config read (`:240`) and the final PATCH (`:272`). A failure in either ends the invocation without resolving the deferred message, which then shows "thinking…" until the token expires. Lambda's async-invoke retry would re-run the whole handler, including a possible second `RunTask` [inferred: retry policy is the AWS default; nothing in `lambdas.ts:415-441` overrides it].

The followup does not need Secrets Manager: the webhook PATCH authenticates with the interaction token in the URL (`followup/src/handler.ts:6-9`, `patchOriginal.ts:7-8`, `:22-23`).

### The PATCH helper

`patchInteractionOriginal` PATCHes `/webhooks/{app}/{token}/messages/@original` and logs a non-2xx status with the body (`patchOriginal.ts:17-32`). Its TSDoc says it "swallows and logs failures rather than throwing" (`:9-11`), but the `fetch` call is not wrapped, so a network rejection propagates. In the followup that ends the invocation; in update-dns it skips `deletePending` (`update-dns/src/handler.ts:193-194`), leaving the row to the TTL.

## Configuration Model

### DynamoDB rows

All Discord state lives in one table, `${projectName}-discord`, keyed `pk`/`sk`, with TTL on `expiresAt` (`app/packages/infra/src/dynamodb.ts:111-125`).

| Row | Written by | Contents | Notes |
|---|---|---|---|
| `CONFIG#discord` / `CONFIG` | desktop app (`putDiscordConfig`, `configStore.ts:149-165`); seeded once by infra | `clientId`, `allowedGuilds`, `admins`, `gamePermissions` | infra seed has `ignoreChanges: ['item']` so app edits are never reverted (`app/packages/infra/src/escapes.ts:10-12`, `:93`) |
| `BASE#discord` / `BASE` | infra, recomputed on every deploy from `baseAllowedGuilds`/`baseAdminUserIds`/`baseAdminRoleIds` | `allowedGuilds`, `admins` | "an immutable floor" the app cannot remove (`escapes.ts:13-15`) |
| `PENDING#{taskArn}` / `PENDING` | followup on `/server-start` (`pendingStore.ts:13-30`) | application ID, interaction token, user, guild, game, action, `expiresAt` | 15-minute TTL matching the token lifetime (`pendingStore.ts:5-6`); read and deleted by update-dns |
| `LAUNCH#{game}` / `LOCK` | desktop Start (`AwsCloudProvider.startWorkload`) and the followup `runStart`, both through `startWithLease`, and desktop uploads (`UploadLeaseService`) as holder `upload`, renewed every 30 s (`startLease.ts:78-108`) | `leaseId`, `holder` (`start` or `upload`; absent reads as `start`), `expiresAt` | 120-second TTL (`START_LEASE_TTL_SECONDS`, `startLease.ts:2`); acquired by a conditional put that succeeds only when no row exists or `expiresAt` has passed. Released early, when the pre-check refuses or the launch fails, by writing an already-expired row (`expiresAt: 0`) so no `DeleteItem` permission is needed (`startLease.ts:64-70`); after a successful launch it is left to expire. `leaseId` is the `RunTask` `clientToken` |

Every read is `ConsistentRead: true` and runs through defensive coercion (`parseConfigData`, `parseBaseData`, `configStore.ts:28-67`) that drops non-string entries and unsafe game keys via `isSafeGameKey`/`sanitizeGamePermission` (`app/packages/shared/src/sanitize.ts`), so a hand-edited item cannot crash a Lambda. `getPending` also treats an expired row as absent and best-effort deletes it, because the TTL sweeper can lag by up to 48 hours (`pendingStore.ts:32-61`).

### Effective config

Both Lambdas read `getEffectiveDiscordConfig` (`configStore.ts:105-122`), which fetches both rows in parallel and returns the set-union of base and dynamic `allowedGuilds`, admin user IDs and admin role IDs. `clientId` and `gamePermissions` come from the dynamic row only; the base row cannot grant per-game permissions. Because there is no cache, an edit from the desktop app takes effect on the next interaction (the controller says so at `discord.controller.ts:93`).

### canRun

`canRun(cfg, { guildId, userId, roleIds, game, action })` is pure and evaluates in this order (`canRun.ts:28-37`):

1. Guild not in `allowedGuilds` → deny.
2. User in `admins.userIds` → allow.
3. Any role in `admins.roleIds` → allow.
4. No `gamePermissions[game]` entry, or `action` not in its `actions` → deny.
5. User in the entry's `userIds`, or any role in its `roleIds` → allow.
6. Otherwise deny.

This matches the documented order in `docs/docs/app/discord.md:340-341`. Admins bypass the per-game table entirely, including games with no entry.

### Secrets

Two Secrets Manager secrets hold the bot token and the public key. Infra creates them with a placeholder value and `ignoreChanges: ['secretString']` so the app's writes survive re-applies (`app/packages/infra/src/secrets.ts:15`, `:77-93`). `getPublicKey` maps the placeholder to `null` (`secretsStore.ts:71-76`), which is how an unconfigured endpoint fails closed with 401. The Lambdas only ever read the public key; the bot token is used solely by the desktop registrar.

## Desktop Configuration Surface

### DiscordConfigService

`DiscordConfigService` (`app/packages/desktop-main/src/services/DiscordConfigService.ts`) is the desktop's only path to the Discord row and secrets. It reads through injected `DISCORD_CONFIG_STORE` and `SECRETS_STORE` adapters (`:87-91`), bound to `AwsDiscordConfigStore` and `AwsSecretsStore`, which sign with the operator's wizard-stored credentials rather than the ambient default chain; the constructor comment records that as the fix for a spurious "session expired" bug (`:71-86`).

Reads are cached in memory with in-flight coalescing for both the dynamic row (`load`, `:119-140`) and the base row (`loadBase`, `:149-174`). `invalidateCache()` (`:415-418`) has no production caller, so both caches live for the process lifetime and are refreshed only by the service's own successful `save` (`:184-199`). Edits made from another machine are not seen until restart.

`load()` degrades any failure, including "table not deployed", to a cached `emptyConfig()` (`:129-134`). Every mutator then edits that cached object in place and saves it (`setAllowedGuilds` `:322-326`, `addAllowedGuild` `:329-335`, `setAdmins` `:361-368`, `setGamePermission` `:374-396`, `deleteGamePermission` `:403-412`, and `setCredentials` when a client ID is supplied `:296-301`). One transient read failure followed by any edit therefore overwrites the real `CONFIG#discord` row with an otherwise empty config. This is the leaf's most serious known defect.

Mutator behaviour worth noting:

- `setCredentials` writes `clientId` to DynamoDB first, then the two secrets in parallel; empty strings are treated as "leave unchanged" (`:282-319`). A secret-write failure after a successful `clientId` save leaves a partial update.
- `removeAllowedGuild` refuses a guild that is in the base row, with a message pointing at the Settings page and a re-apply (`:342-354`).
- `setGamePermission` filters `actions` to `start|stop|status` and dedupes all lists (`:383-393`), so the controller's `actions as DiscordAction[]` cast (`discord.controller.ts:198`) is cosmetic.
- `getRedacted` returns booleans for both secrets via `readSecretSafe`, which never throws (`:232-273`).

The file header still describes returning the redacted view "over `/api/discord/config`" (`:8-9`); there is no HTTP transport.

### IPC channels

All handlers are `@MessagePattern` IPC handlers on `DiscordController` (`app/packages/desktop-main/src/controllers/discord.controller.ts`), each logging on entry per `.claude/rules/logging.md`.

| Channel | Payload | Returns | Source |
|---|---|---|---|
| `discord.getConfig` | none | redacted config + `interactionsEndpointUrl` from stack outputs | `:34-40` |
| `discord.putConfig` | `{ botToken?, clientId?, publicKey? }` strings | `{ success, config }` | `:48-79` |
| `discord.listGuilds` | none | `{ guilds, baseGuilds }` | `:86-91` |
| `discord.addGuild` | `{ guildId }` | `{ success, guilds, baseGuilds }` | `:94-105` |
| `discord.removeGuild` | guild ID string | same; 400 for a base guild | `:113-124` |
| `discord.registerCommands` | guild ID string | `RegisterResult` | `:132-138` |
| `discord.getAdmins` | none | `{ userIds, roleIds, baseAdmins }` | `:145-150` |
| `discord.putAdmins` | `{ userIds, roleIds }` | `{ success, admins, baseAdmins }` | `:156-164` |
| `discord.getPermissions` | none | `gamePermissions` map | `:167-171` |
| `discord.putPermission` | `{ game, body: { userIds, roleIds, actions } }` | `{ success, permissions }` | `:183-204` |
| `discord.deletePermission` | game string | `{ success, permissions }` | `:207-219` |

The controller reads `outputs.interactionsInvokeUrl` through one private accessor, `redactedWithEndpoint`, shared by `discord.getConfig` and `discord.putConfig`. `StackOutputs` also carries an identical `discordInteractionsUrl` (`app/packages/shared/src/stackOutputs.ts:147-156`), and two `DiscordEventReceiver` implementations exist that would expose the same URL; neither is consumed (`app/packages/shared/src/discord/awsLambdaDiscordReceiver.ts`, `app/packages/cloud-aws/src/AwsDiscordEventReceiver.ts`, bound without a config callback at `app/packages/desktop-main/src/modules/cloud-provider.module.ts:204`). `putPermission` rejects a game that is not a key of `DeploymentConfig.gameServers`, and `deletePermission` rejects one that is neither declared nor holds an existing permission entry (`requireKnownGame`), both with a bad-request error and before any write. The declared games are read with `getGameServersStrict`, so an unreadable deployment config rejects the call with its message and writes nothing rather than being read as "no games". Prototype-unsafe keys are additionally rejected in the service.

### Command registration

`registerForGuild` validates both the guild ID and the stored `clientId` as 17-20 digit snowflakes before interpolating them into the URL, an SSRF guard (`DiscordCommandRegistrar.ts:16-27`, `:63-79`), then PUTs the full `COMMAND_DESCRIPTORS` array to `/applications/{clientId}/guilds/{guildId}/commands` with `Bot {token}` auth (`:88-97`). Discord replaces the guild's whole command set in one call. Non-2xx responses pass status and body through to the UI; network errors become `Request failed: …` (`:98-109`). Registration is a manual per-guild operator action; removing a guild from the allowlist does not unregister its commands (`discord.controller.ts:111`).

### Discord page

The renderer page (`app/packages/web/src/pages/discord/discord.page.tsx`) has Credentials, Guilds, Admins and Per-Game Permissions tabs, a readiness badge and a Get started card, driven by `use-discord-config.hook.ts`, whose mutations resolve to `undefined` and report through toasts rather than rejecting (`:17`, `:89-93`). `getRedacted` does not degrade: it rejects with `DISCORD_NOT_DEPLOYED_MESSAGE` when the stack has not published the Discord table, or with the real read failure, and caches nothing. The hook records the rejection as `loadError`, and the page, in place of its tabs, shows the "infrastructure not deployed yet" state for the first kind and "Could not load the Discord configuration: {message}" with a Retry button for any other. Because the page renders no editable tab without a successfully read config, an edit can never be drafted from an empty fallback. The Credentials form clears the secret inputs only after `saveCredentials` resolves `true`, and shows "Copied" only after the clipboard write resolves.

## Decisions & Alternatives

| Decision | Chosen | Alternatives Considered | Rationale |
|---|---|---|---|
| Bot runtime | HTTP interactions to a Lambda Function URL, no gateway | discord.js gateway bot in a long-running process (the previous implementation, per `canRun.ts:13-14` and `commands.ts:7-8`) | CLAUDE.md "Discord is fully serverless"; a persistent process breaks the on-demand cost model [inferred for the cost link] |
| Reply within 3 seconds | Defer (type 5) in interactions, async-invoke followup, PATCH `@original` | Do ECS work synchronously in one Lambda | Stated in code: ECS calls do not fit the 3-second budget (`interactions/src/handler.ts:12-15`, `followup/src/handler.ts:230-232`) |
| Connect address on start | Pending row keyed by task ARN, PATCHed by update-dns on RUNNING | Followup polls ECS until RUNNING; second message | Stated in code (`followup/src/handler.ts:11-13`); avoids holding a Lambda for the 2-5 minute start [inferred] |
| Pending-row lifetime | 15-minute DynamoDB TTL plus read-time expiry check | No TTL; explicit cleanup only | Stated in code: token lifetime is 15 minutes and the TTL sweeper can lag 48 hours (`pendingStore.ts:5`, `:32-41`) |
| Permission logic location | One pure `canRun` in `@hyveon/shared`, imported by both Lambdas | Per-consumer copies | CLAUDE.md invariant; `canRun.ts:16-17` |
| Authorisation depth | Check in interactions, re-check in followup | Single check | Stated in code: config may change between the two (`followup/src/handler.ts:219`) |
| Config split | Infra-owned `BASE#discord` floor unioned with app-owned `CONFIG#discord` | One row for both | Stated in infra: base is an immutable floor, app edits must not be reverted (`escapes.ts:10-15`) |
| Config freshness in Lambdas | Consistent read of both rows per interaction, no cache | In-memory cache with TTL | Edits take effect immediately (`discord.controller.ts:93`); cost is two point reads per call [inferred] |
| Command scope | Per-guild bulk overwrite, operator-triggered | Global registration; auto-register on deploy | CLAUDE.md "per guild only"; global commands leak to every guild (`DiscordCommandRegistrar.ts:38-43`) |
| Game list for autocomplete | `GAME_NAMES` env baked at deploy | Read `deployment-config.json` at request time | Autocomplete must answer in-band with no ECS calls (`interactions/src/handler.ts:9-11`); env avoids an S3 read [inferred] |
| Public domain | `discord.{zone}` CloudFront in front of the Function URL | Paste the raw Function URL into Discord | unknown; a stable hostname survives function replacement [inferred] |
| Interaction timestamp freshness | Reject a signature-verified interaction whose `x-signature-timestamp` (Unix seconds) differs from the Lambda clock by more than 30 seconds, in either direction, with 401 | No freshness check; a 5-second window | Discord signs the timestamp together with the body, so a captured request stays valid forever unless the receiver bounds its age; the check runs after signature verification because only a verified timestamp is trustworthy. 5 seconds is too tight for Lambda cold starts and clock skew; the window is symmetric because skew can run either way, which leaves a captured request replayable for up to 60 seconds in the worst case |
| Desktop AWS access | Injected credentialed stores (`AwsDiscordConfigStore`, `AwsSecretsStore`) | Shared `getDocClient()` default chain | Stated in code: the default chain picked up stale ambient sessions (`DiscordConfigService.ts:71-86`) |
| Desktop read failure handling | Mutators and the page's redacted read fail on a failed or unavailable read and cache nothing; only the list-style display reads (`getConfig`, base config) degrade to empty | Degrade everywhere and cache the empty config | An empty fallback shown as real invites an edit that overwrites the stored row; the page now distinguishes not-deployed from other failures, so the degrade is no longer needed to keep it usable before deploy |
| Followup invoke bound | Await the `Invoke`, abort after `min(2 s, 2.8 s - elapsed since handler entry)` (floor 250 ms), answer with an ephemeral check-status notice | A fixed 2-second bound; fire without awaiting; move the config read after the ack | Lambda freezes after the handler returns, so an unawaited invoke can be lost; the secret read, config read and invoke run sequentially, so a fixed 2 seconds after a slow cold config read can exceed Discord's 3-second budget while a deadline-based bound cannot; a timed-out invoke may already have been accepted, so the notice says the command may already be starting rather than asking for a blind retry, and a retry is safe because `/server-start` takes the start lease, `/server-stop` is idempotent and list/status are read-only (`DISCORD-CMD-014`); a lost ack becomes a visible notice instead of "This interaction failed". Trust boundary: the notice carries fixed text only and the bound adds no new input, permission or IAM scope |
| Raw error text in Discord replies | Fixed generic reply per action; normalised error and game name in CloudWatch only | Truncate or sanitise the SDK message | The channel is readable by every guild member and SDK text carries ARNs and account details; the interaction token is never logged |
| Permission target validation | Reject a game absent from `DeploymentConfig.gameServers` before the write; allow deleting an orphaned entry | Validate only the key's safety; reject all unknown deletes | An undeclared key writes an orphan entry no Lambda can use; deleting must stay possible for an entry whose game was removed. Authorisation is unchanged: `canRun` still decides, and this validates the operator's own IPC input, not a Discord-side input |
| Interactions URL accessor | One controller accessor reading `interactionsInvokeUrl`; the duplicate `discordInteractionsUrl` output and the two unused receivers stay until `iac/program` (`IAC-PROGRAM-OUT-003`) and `operator-app/desktop-shell` (`APP-SHELL-BIND-001`) change | Delete the output and receivers here | Both removals contradict specs owned by other segments, so they cross a segment boundary and are recorded as an open question rather than cascaded |
| Registration input safety | Snowflake regex on guild and client IDs before URL interpolation | Encode only | Stated in code: CodeQL SSRF finding (`DiscordCommandRegistrar.ts:16-22`, `:64-67`) |

## Open Questions & Future Decisions

### Resolved

None recorded before this document was written.

### Deferred

1. Should `DiscordConfigService.load()` stop caching `emptyConfig()` on failure, and should mutators refuse to save when the preceding read failed? Today one transient error followed by any edit wipes `CONFIG#discord` (`DiscordConfigService.ts:129-134`, `:322-412`).
2. Should `invalidateCache()` have a caller (page focus, a refresh action, a TTL), given it is never called in production (`DiscordConfigService.ts:415-418`) and the cache never sees another machine's edits? It also leaves `inflight` untouched.
3. Should the followup wrap the final PATCH (`followup/src/handler.ts:300`, still outside the `try`) so every deferred interaction gets a reply? The config read now sits inside the `try` (`:265`). A re-run of the whole handler by Lambda's async-invoke retry can no longer launch a second task: a retry after a successful launch finds the start lease held and replies "A start for {game} is already in progress." (overwriting the success message with that refusal), and the lease id is also the `RunTask` `clientToken` (`startLease.ts:78-108`; `RT-TASK-LAUNCH-015`).
4. Should `patchInteractionOriginal` catch `fetch` rejections as its TSDoc promises (`patchOriginal.ts:9-11`, `:23`), or should the doc and callers (`update-dns/src/handler.ts:193-194`) change?
5. Should the followup stop logging the whole event, which contains the 15-minute `interactionToken` (`followup/src/handler.ts:268`)?
6. Should user-facing replies carry a generic message instead of `String(err)` (`followup/src/handler.ts:114`, `:146`, `:160`)?
7. Is awaiting the async invoke inside the 3-second budget acceptable (`interactions/src/handler.ts:204-243`, `:256-265`), and should the module header's claim at `:13-15` be corrected or the ack decoupled?
8. Resolved: the interactions Lambda rejects `x-signature-timestamp` values more than 30 seconds from its clock, in either direction, after signature verification (`interactions/src/handler.ts:314`; see the "Interaction timestamp freshness" row in the Decisions table). The window is ±30 seconds around the signed timestamp, so a captured request can remain replayable for up to 60 seconds in the worst case.
9. Resolved: concurrent starts are guarded by the DynamoDB start lease and the `RunTask` `clientToken` (`followup/src/handler.ts:134-146`; `RT-TASK-LAUNCH-015`).
10. Which of the two `DiscordEventReceiver` implementations survives, and should the `DISCORD_RECEIVER` binding and the duplicate `discordInteractionsUrl` stack output be removed (`awsLambdaDiscordReceiver.ts:32`, `AwsDiscordEventReceiver.ts:44-45`, `cloud-provider.module.ts:204`, `stackOutputs.ts:147-156`)?
11. Should `FollowupPayload` and `FollowupEvent` become one shared type, and should the Lambda use `actionForCommand` instead of its own `actionFor` (`interactions/src/handler.ts:143-155`, `:246-254`, `followup/src/handler.ts:40-48`, `commands.ts:10-20`)?
12. Resolved: the page distinguishes not-deployed from other failures, offers Retry, and keeps the secret inputs until the save succeeds (`DISCORD-UI-008`, `DISCORD-UI-009`, `DISCORD-UI-010`).
13. Resolved: `putPermission` and `deletePermission` validate `game` against `DeploymentConfig.gameServers` (`DISCORD-IPC-006`).
14. Should `setCredentials` order or roll back its DynamoDB and Secrets Manager writes to avoid partial updates (`DiscordConfigService.ts:296-317`)?
15. The clear-permissions dialog says the change is "recoverable from infrastructure-as-code" (`docs/docs/app/discord.md:352-353`), but per-game permissions live only in the app-owned row. Should the copy change, or should infra seed permissions?
16. CLAUDE.md says there is no ACM certificate anywhere in the stack, but `discordDomain.ts` declares one for CloudFront. Should the invariant be reworded to scope it to game-server TLS?
17. Cited drift from `iac/program`: interactions receives an unused `HOSTED_ZONE_NAME` (`lambdas.ts:463`), and CloudFront allows all methods (`discordDomain.ts:178`) while the Function URL CORS allows only POST (`lambdas.ts:478-482`). Are either intentional?
18. Stale or dead pieces: the `/api/discord/config` header (`DiscordConfigService.ts:8-9`), the Discord bot-token helpers in `secretsStore.ts:78-91` with no Lambda consumer, and the deprecated `hex.substr` (`interactions/src/handler.ts:72`).
19. Removing a guild leaves its registered commands in Discord (`discord.controller.ts:111`). Should removal unregister them, or should the UI warn?
20. Should this leaf's intent be reviewed with the operator? Its requirements derive from code and docs rather than from an operator-reviewed requirement set.

## References

- Arrow doc: `docs/arrows/discord-bot.md`
- EARS specs: `docs/intent/discord-bot/discord-bot-specs.md`
- Operator docs: `docs/docs/app/discord.md`, `docs/docs/components/lambdas.md`, `docs/docs/architecture.md`, `docs/docs/setup.md`
- Invariants: root `CLAUDE.md`, "Invariants that hurt to break"
- Neighbouring leaves: `docs/intent/game-runtime/task-and-dns/task-and-dns-design.md` (update-dns pending PATCH), `docs/intent/game-runtime/watchdog/watchdog-design.md` (idle stop), `docs/intent/game-runtime/health-check/health-check-design.md` (`secretsStore.ts`), `docs/intent/iac/program/program-design.md` (Lambdas, CloudFront, table, secrets, seed rows), `docs/intent/deployment-config/deployment-config-design.md` (`gameServers`, base allowlist fields), `docs/intent/operator-app/ipc-bridge/ipc-bridge-design.md` (IPC transport, validation)
