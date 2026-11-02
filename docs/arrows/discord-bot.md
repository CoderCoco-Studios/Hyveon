# Arrow: discord-bot

Let players start, stop and check games from Discord slash commands, under the operator's allowlists and per-game permissions, with no bot process running.

## Status

**MAPPED** — mapped 2026-10-30 (git SHA `5c55a380`), not yet audited. Fully serverless path (Function URL → interactions Lambda → followup Lambda → update-dns PATCH) works end to end; the desktop config service has a cache-poisoning bug that can wipe the config row, and there is no OpenSpec capability behind any of it.

## References

### HLD
- `docs/high-level-design.md

### LLD
- `docs/intent/discord-bot/discord-bot-design.md`

### EARS
- `docs/intent/discord-bot/discord-bot-specs.md` (92 specs)

### Documented intent sources
There is no OpenSpec capability for this leaf. Intent is taken from `docs/docs/app/discord.md` (the operator page, including the permission-evaluation order and the Interactions Endpoint URL contract) and the root `CLAUDE.md` invariants: "Discord is fully serverless" (no discord.js, no gateway, per-guild registration only), "`canRun()` lives in `@hyveon/shared`" (one copy), "Secrets never reach the renderer", "Lambda env vars use `AWS_REGION_`", and the `@hyveon/shared` barrel AWS-SDK restriction.

### Tests
- `app/packages/cloud-aws/src/AwsDiscordConfigStore.test.ts`
- `app/packages/cloud-aws/src/AwsDiscordEventReceiver.test.ts`
- `app/packages/cloud-aws/src/AwsSecretsStore.test.ts`
- `app/packages/desktop-main/src/controllers/discord.controller.test.ts`
- `app/packages/desktop-main/src/services/DiscordCommandRegistrar.test.ts`
- `app/packages/desktop-main/src/services/DiscordConfigService.test.ts`
- `app/packages/lambda/followup/src/handler.test.ts`
- `app/packages/lambda/interactions/src/handler.test.ts`
- `app/packages/shared/src/canRun.test.ts`
- `app/packages/shared/src/commands.test.ts`
- `app/packages/shared/src/ddb/configStore.test.ts`
- `app/packages/shared/src/ddb/pendingStore.test.ts`
- `app/packages/shared/src/discord/awsLambdaDiscordReceiver.test.ts`
- `app/packages/shared/src/formatStatus.test.ts`
- `app/packages/shared/src/sanitize.test.ts`
- `app/packages/web/e2e/integration-specs/can-run.spec.ts`
- `app/packages/web/e2e/integration-specs/discord-config.spec.ts`
- `app/packages/web/e2e/specs/discord.spec.ts`
- `app/packages/web/src/pages/discord/discord.page.test.tsx`

### Code

**lambda/interactions**
- `app/packages/lambda/interactions/src/handler.ts`
- `app/packages/lambda/interactions/esbuild.config.mjs`, `package.json`, `tsconfig.json`

**lambda/followup**
- `app/packages/lambda/followup/src/handler.ts`
- `app/packages/lambda/followup/esbuild.config.mjs`, `package.json`, `tsconfig.json`

**shared**
- `app/packages/shared/src/canRun.ts`
- `app/packages/shared/src/commands.ts`
- `app/packages/shared/src/sanitize.ts`
- `app/packages/shared/src/formatStatus.ts`
- `app/packages/shared/src/ddb/client.ts`
- `app/packages/shared/src/ddb/configStore.ts`
- `app/packages/shared/src/ddb/pendingStore.ts`
- `app/packages/shared/src/discord/patchOriginal.ts`
- `app/packages/shared/src/discord/awsLambdaDiscordReceiver.ts`

**cloud-aws**
- `app/packages/cloud-aws/src/AwsDiscordConfigStore.ts`
- `app/packages/cloud-aws/src/AwsSecretsStore.ts`
- `app/packages/cloud-aws/src/AwsDiscordEventReceiver.ts`

**desktop-main**
- `app/packages/desktop-main/src/controllers/discord.controller.ts`
- `app/packages/desktop-main/src/modules/discord.module.ts`
- `app/packages/desktop-main/src/services/DiscordConfigService.ts`
- `app/packages/desktop-main/src/services/DiscordCommandRegistrar.ts`

**web**
- `app/packages/web/src/pages/discord/discord.page.tsx`
- `app/packages/web/src/pages/discord/use-discord-config.hook.ts`
- `app/packages/web/src/pages/discord/credentials-section.component.tsx`
- `app/packages/web/src/pages/discord/guilds-section.component.tsx`
- `app/packages/web/src/pages/discord/guild-row.component.tsx`
- `app/packages/web/src/pages/discord/add-guild-form.component.tsx`
- `app/packages/web/src/pages/discord/admins-section.component.tsx`
- `app/packages/web/src/pages/discord/base-admins-panel.component.tsx`
- `app/packages/web/src/pages/discord/permissions-section.component.tsx`
- `app/packages/web/src/pages/discord/serverless-badge.component.tsx`
- `app/packages/web/src/pages/discord/setup-wizard.component.tsx`
- `app/packages/web/src/pages/discord/snowflake.utils.ts`
- `app/packages/web/src/lib/snowflake.utils.ts`
- `app/packages/web/src/components/snowflake-chips-input.component.tsx`
- `app/packages/web/e2e/pages/DiscordPage.ts`

### Cited from other leaves
- `app/packages/infra/src/lambdas.ts` (`iac/program`): interactions and followup function blocks, Function URL with CORS, `GAME_NAMES`/`GAME_PORTS`/`CONNECT_MESSAGES` env.
- `app/packages/infra/src/discordDomain.ts` (`iac/program`): `discord.{zone}` ACM (us-east-1) + CloudFront + A/AAAA aliases in front of the Function URL.
- `app/packages/infra/src/dynamodb.ts`, `secrets.ts`, `escapes.ts` (`iac/program`): Discord table, placeholder secrets with `ignoreChanges`, `BASE#discord`/`CONFIG#discord` seed rows.
- `app/packages/shared/src/secrets/secretsStore.ts` (`game-runtime/health-check`): `getPublicKey` used by interactions; Discord helpers there are otherwise dead.
- `app/packages/lambda/update-dns/src/handler.ts` (`game-runtime/task-and-dns`): `getPending` → `patchInteractionOriginal` → `deletePending` half of `/server-start`.
- `app/packages/shared/src/cloud.ts` (`game-runtime/task-and-dns`): `SecretsStore`, `DiscordEventReceiver` interfaces.
- `app/packages/shared/src/types.ts` (`game-runtime/task-and-dns`): `GameStatus`/`StartResult` consumed by `formatStatus.ts` and the interactions handler; also `RedactedDiscordConfig`.
- `app/packages/desktop-main/src/modules/cloud-provider.module.ts`, `cloud-provider.tokens.ts`: store/receiver DI bindings.
- `app/packages/desktop-main/src/controllers/validation.ts` (`operator-app/ipc-bridge`): `requireStringArray` etc.
- `app/packages/shared/src/index.ts` (unassigned barrel): carries the "no new AWS SDK imports" constraint.

### OpenSpec sources
- None. No OpenSpec capability covers Discord, and no active change is mapped to this leaf.

## Architecture

**Purpose:** Discord POSTs signed interactions to `https://discord.{zone}/` (CloudFront → Lambda Function URL). The interactions Lambda verifies, authorises with the shared `canRun`, defers, and async-invokes the followup Lambda, which does the ECS work and PATCHes the deferred message. On `/server-start` it also writes a `PENDING#{taskArn}` row so update-dns can PATCH the same message with the connect line once the task is RUNNING. The desktop app only edits configuration (DynamoDB row + Secrets Manager secrets) and registers commands per guild.

**Key Components:**
1. `lambda/interactions/src/handler.ts:268` — Function URL entry: Ed25519 verify (`:279`), PING/PONG, autocomplete filtered by `canRun` (`:152`), allowlist + `canRun` gate (`:189`, `:223`), async `InvokeCommand` with `InvocationType: 'Event'` (`:249`), deferred ack (type 5).
2. `lambda/followup/src/handler.ts:238` — defensive `canRun` re-check (`:220`), `RunTask` against `{game}-server` with `propagateTags` (`:128`), `StopTask` (`:156`), status/list, `putPending` on start (`:192`), final `patchInteractionOriginal` (`:272`).
3. `shared/src/canRun.ts:19` — the single permission evaluator: guild allowlist → admin user → admin role → per-game entry with action → deny.
4. `shared/src/ddb/configStore.ts` — `CONFIG#discord` (operator-edited) and `BASE#discord` (infra-seeded) rows; `getEffectiveDiscordConfig` (`:105`) merges them for both Lambdas.
5. `shared/src/ddb/pendingStore.ts` — `PENDING#{taskArn}` rows with 15-minute `expiresAt` TTL (`:6`, `:17`), matching the interaction-token lifetime.
6. `shared/src/commands.ts` — the four slash-command descriptors (`server-start`, `server-stop`, `server-status`, `server-list`).
7. `shared/src/formatStatus.ts` — `formatGameStatus`/`renderConnectMessage`, shared by followup and update-dns.
8. `desktop-main/src/services/DiscordConfigService.ts` — cached read/write of the `CONFIG#discord` row and both secrets, redacted view (`:257`, `botTokenSet`/`publicKeySet` at `:271-272`).
9. `desktop-main/src/services/DiscordCommandRegistrar.ts:61` — `PUT /applications/{app}/guilds/{guild}/commands` bulk overwrite, per guild only.
10. `desktop-main/src/controllers/discord.controller.ts` — eleven `discord.*` IPC channels (`:34`-`:207`); adds `interactionsEndpointUrl` from stack outputs (`:39`, `:77`).
11. `cloud-aws/src/AwsDiscordConfigStore.ts`, `AwsSecretsStore.ts` — credentialed desktop-side adapters over the shared DynamoDB/Secrets Manager helpers.
12. `web/src/pages/discord/discord.page.tsx` + `use-discord-config.hook.ts` — Credentials / Guilds / Admins / Per-Game Permissions tabs and the Get started checklist.

## Spec Coverage

| OpenSpec capability | requirements | scenarios | notes |
|---|---|---|---|
| (none) | 0 | 0 | No OpenSpec capability; EARS will be authored from code, with `docs/docs/app/discord.md` and CLAUDE.md invariants as the documented intent. |

| Category | Spec IDs | Implemented | Deferred | Gaps |
|---|---|---|---|---|
| Serverless invariants | `DISCORD-SVC-001` to `DISCORD-SVC-005` | 4 | 0 | 1 |
| Ingress and signature verification | `DISCORD-AUTH-001` to `DISCORD-AUTH-008` | 7 | 0 | 1 |
| Command handling (interactions Lambda) | `DISCORD-CMD-001` to `DISCORD-CMD-013` | 12 | 0 | 1 |
| Permission evaluation (canRun) | `DISCORD-PERM-001` to `DISCORD-PERM-005` | 5 | 0 | 0 |
| Followup Lambda | `DISCORD-RUN-001` to `DISCORD-RUN-015` | 11 | 0 | 4 |
| Pending interactions | `DISCORD-PEND-001` to `DISCORD-PEND-004` | 4 | 0 | 0 |
| Message rendering | `DISCORD-MSG-001` to `DISCORD-MSG-006` | 6 | 0 | 0 |
| Configuration model | `DISCORD-CFG-001` to `DISCORD-CFG-006` | 6 | 0 | 0 |
| Desktop configuration service | `DISCORD-DESK-001` to `DISCORD-DESK-009` | 8 | 0 | 1 |
| IPC surface | `DISCORD-IPC-001` to `DISCORD-IPC-006` | 5 | 0 | 1 |
| Command registration | `DISCORD-REG-001` to `DISCORD-REG-005` | 5 | 0 | 0 |
| Discord page | `DISCORD-UI-001` to `DISCORD-UI-010` | 7 | 0 | 3 |

**Summary:** 80 of 92 active specs implemented; 0 deferred; 12 gaps.

## Key Findings

1. **Desktop config cache poisoning can wipe the operator's Discord row** — `DiscordConfigService.load()` catches any read failure, caches `emptyConfig()` and returns it (`DiscordConfigService.ts:129-134`). Every mutator then edits that cached object in place and saves it (e.g. `setAllowedGuilds` `:322-325`, `addAllowedGuild` `:329-334`), so one transient DynamoDB failure followed by any edit overwrites the real `CONFIG#discord` row with an otherwise empty config. Cache is only cleared by `invalidateCache()` (`:415-418`), which also leaves `inflight` untouched.
2. **`patchInteractionOriginal` doc contradicts code** — the TSDoc says it "swallows and logs failures rather than throwing" (`shared/src/discord/patchOriginal.ts:9-11`), but `fetch` is not wrapped (`:23`); a network rejection throws. In update-dns this skips `deletePending` (`update-dns/handler.ts:193-194`), leaving cleanup to the TTL.
3. **Followup can leave a deferred interaction unresolved** — `getEffectiveDiscordConfig` runs before the `try` (`followup/handler.ts:240`) and the final PATCH runs after it (`:272`); a failure in either leaves Discord showing "thinking..." until the token expires.
4. **Followup logs the interaction token** — `console.error('Followup handler failed', { err, event })` (`followup/handler.ts:268`) logs the whole event, which carries `interactionToken` (a 15-minute webhook credential). Conflicts with `.claude/rules/logging.md` rule 3 [inferred: the rule targets desktop-main, but the intent applies].
5. **Raw exception text is sent to Discord users** — `String(err)` is embedded in user-facing replies (`followup/handler.ts:114`, `:146`, `:160`).
6. **Deferred ack waits on the async invoke** — `handleApplicationCommand` awaits `invokeFollowup` before returning type 5 (`interactions/handler.ts:198-206`, `:210-218`, `:227-236`), so Lambda-invoke latency counts against Discord's 3-second budget. No timestamp freshness check on `x-signature-timestamp` either (`:269-280`); only the signature is verified (`:88`). `hex.substr` is deprecated (`:72`).
7. **Two `DiscordEventReceiver` implementations, neither used** — `shared/src/discord/awsLambdaDiscordReceiver.ts:32` (reads `discord_interactions_url`) has no consumer outside its test and the barrel export (`shared/src/index.ts:37`). The bound `AwsDiscordEventReceiver` is constructed with no config callback (`cloud-provider.module.ts:204`), so it would always return `null` (`AwsDiscordEventReceiver.ts:44-45`), and nothing injects `DISCORD_RECEIVER`; the controller reads `outputs.interactionsInvokeUrl` directly instead (`discord.controller.ts:39`, `:77`). `StackOutputs` also carries two identical URL fields (`stackOutputs.ts:147`, `:156`; `infra/src/program.ts:448-451`).
8. **Sweep disagreement: autocomplete does honour the guild allowlist** — sweep-8 says autocomplete "skips allowedGuilds check" (`interactions/handler.ts:152-178`). The code filters through `canRun` (`:171`), whose first step is the allowlist (`canRun.ts:29`). Not a bug; it matches `docs/docs/app/discord.md:336-338`.
9. **Sweep disagreement: `putPermission` actions cast is benign** — sweep-6 flags `actions as DiscordAction[]` (`discord.controller.ts:198`) as unvalidated. The service filters to `start|stop|status` before saving (`DiscordConfigService.ts:386-391`). The cast is cosmetic.
10. **Desktop UI error handling is optimistic** — credentials secrets are cleared without awaiting the save result (`credentials-section.component.tsx:47-52`); the clipboard write is fire-and-forget before "Copied" (`:56-59`); any load error renders "infrastructure not deployed yet" (`discord.page.tsx:39-50`).
11. **Infra-side drift cited from `iac/program`** — interactions gets an unused `HOSTED_ZONE_NAME` (`infra/src/lambdas.ts:463`; the handler never reads it); Function URL CORS allows only POST from `https://discord.com` (`lambdas.ts:478-481`) while CloudFront forwards all methods [unverified: `discordDomain.ts:178` per sweep-8]. `discordDomain.ts` declares an ACM certificate (`:1-30`), contradicting CLAUDE.md's "no ... ACM certificate anywhere" (`CLAUDE.md:90`); the docs page describes it correctly (`docs/docs/app/discord.md:121-130`).
12. **Stale and duplicated pieces** — `DiscordConfigService.ts:8-9` still says "`/api/discord/config`" (no HTTP transport exists); `FollowupPayload` (`interactions/handler.ts:239-247`) and `FollowupEvent` (`followup/handler.ts:40`) are hand-duplicated across the Lambda boundary; Discord helpers `getBotToken`/`putBotToken`/`putPublicKey`/`invalidateSecretsCache` in `shared/src/secrets/secretsStore.ts:63-91` have no Lambda consumer and duplicate cache logic in `AwsSecretsStore.ts` [unverified beyond sweep-7 for `AwsSecretsStore.ts:11-19,97-116`].
13. **`docs/docs/app/discord.md:352-353` overstates recoverability** — the clear-permissions confirm says "recoverable from infrastructure-as-code", but per-game permissions live only in the operator-edited `CONFIG#discord` row; infra seeds only `BASE#discord` (base guilds and admins).
14. **Invariants verified as held** — `canRun` exists once and both Lambdas and desktop import it (`interactions/handler.ts:21`); registration is per guild via the guild-scoped bulk-overwrite endpoint (`DiscordCommandRegistrar.ts:49-52`, `:61`); no discord.js anywhere, PATCH uses global `fetch` (`patchOriginal.ts:23`); renderer receives only the redacted shape (`DiscordConfigService.ts:257-272`). The "four slash commands" header (`DiscordCommandRegistrar.ts:2`) is currently accurate (`commands.ts:31,44,57,70`), though hard-coded.

## Work Required

Spec IDs cite the open (`[ ]`) gap specs in `docs/intent/discord-bot/discord-bot-specs.md`; items with no matching gap spec carry none.

### Must Fix
1. `DiscordConfigService.load()` must not cache an empty config on read failure; mutators must not save over a failed read (finding 1). (specs: `DISCORD-DESK-004`)
2. Wrap the followup's config read and final PATCH so every deferred interaction gets a reply; make `patchInteractionOriginal` actually swallow fetch rejections or fix its doc and callers (findings 2, 3). (specs: `DISCORD-RUN-010`, `DISCORD-RUN-014`)
3. Stop logging the full followup event, which includes the interaction token (finding 4). (specs: `DISCORD-RUN-011`)

### Should Fix
4. Replace `String(err)` in user-facing Discord replies with a generic message plus a server-side log (finding 5). (specs: `DISCORD-RUN-012`)
5. Return the deferred ack without awaiting a slow invoke path, or measure and document the budget; add a timestamp freshness check (finding 6). (specs: `DISCORD-CMD-009`, `DISCORD-AUTH-007`)
6. Delete one of the two `DiscordEventReceiver` implementations and either wire the remaining one (with its config callback) or remove the `DISCORD_RECEIVER` token; collapse the duplicate `interactionsInvokeUrl`/`discordInteractionsUrl` outputs (finding 7). (specs: `DISCORD-SVC-005`)
7. Make the Discord page distinguish "not deployed" from other load errors, and only clear secret inputs after a successful save (finding 10). (specs: `DISCORD-UI-008`, `DISCORD-UI-009`)
8. Fix the CLAUDE.md ACM invariant wording and the "recoverable from IaC" copy (findings 11, 13).
9. Author an OpenSpec capability (or EARS set) for the Discord bot; it is the only user-facing subsystem with none.

### Nice to Have
10. Share one `FollowupPayload` type between the two Lambdas; drop the dead Discord helpers in `secretsStore.ts`; remove the stale `/api/discord/config` header; replace `substr`; drop the unused `HOSTED_ZONE_NAME` env (findings 6, 11, 12).
