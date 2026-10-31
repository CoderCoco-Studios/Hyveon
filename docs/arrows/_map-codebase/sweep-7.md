# Sweep 7 — `@hyveon/shared`, `@hyveon/desktop-preload`, `@hyveon/cloud-aws`

Scope: every tracked file from `git ls-files app/packages/shared app/packages/desktop-preload app/packages/cloud-aws` (97 files). Source files were read in full. For test files I read the headers and every `describe`/`it` title, and the bodies where they mattered (e.g. `iamPolicy.test.ts`, `cloud.test.ts`, `index.test.ts`, the `preload.test.ts` header). Each test entry summarises the behaviours it pins down.

## app/packages/shared

```yaml
- path: app/packages/shared/package.json
  purpose: Workspace manifest for @hyveon/shared (ESM, tsc build).
  exports: "subpath exports '.', './gameServerValidator', './envTokens', './folderUpload', './secrets/secretsStore'"
  dependencies: "@aws-sdk/client-dynamodb, @aws-sdk/client-secrets-manager, @aws-sdk/lib-dynamodb, ulid, zod"
  data_shapes: n/a
  side_effects: none
  role: config
  observations: "'./secrets/secretsStore' is offered as a subpath (package.json:22-25), but the barrel also re-exports it (src/index.ts:35), so every barrel consumer still pulls in the Secrets Manager SDK. './gameServerValidator' and './envTokens' are likewise also in the barrel (index.ts:12). Only './folderUpload' is subpath-only."

- path: app/packages/shared/tsconfig.json
  purpose: tsc config; extends ../../tsconfig.base.json, src -> dist, excludes *.test.ts.
  exports: n/a
  dependencies: tsconfig.base.json
  data_shapes: n/a
  side_effects: none
  role: config
  observations: none
```

## app/packages/shared/src

```yaml
- path: app/packages/shared/src/index.ts
  purpose: Package barrel; re-exports 34 modules.
  exports: "everything from types, errors, pulumiVersion, iamPolicy, wizardSteps, addGameWizardSteps, gameServerConfig, deploymentConfig, awsRegions, stackOutputs, gameServerPorts, gameServerValidator, gamesWrite, deploymentSettingsWrite, autoUpdateSetting, diagnosticsBundle, drift, audit, runs, changeSummary, cloud, lambdaFunctionKey, envJson, env, aws/ecsTask, fileManagerLogGroup, relativeTime, sanitize, canRun, formatStatus, commands, ddb/client, ddb/configStore, ddb/pendingStore, secrets/secretsStore, discord/awsLambdaDiscordReceiver, discord/patchOriginal"
  dependencies: all sibling modules
  data_shapes: n/a
  side_effects: "none directly; transitively imports @aws-sdk/client-dynamodb, lib-dynamodb and client-secrets-manager via ddb/* and secrets/*"
  role: barrel
  observations: "Line 36 `export type { DiscordEventReceiver } from './cloud.js'` duplicates what line 21 `export * from './cloud.js'` already exports. The barrel pulls in AWS SDK code (lines 32-35), as CLAUDE.md acknowledges. `aws/ecsTask.js` is in the barrel (line 25) even though CLAUDE.md says AWS-touching helpers under shared/src/aws/* are 'deep-imported'; it is SDK-free, though."

- path: app/packages/shared/src/addGameWizardSteps.ts
  purpose: Ordered add-game wizard step list (single source of truth).
  exports: "ADD_GAME_WIZARD_STEPS ['identity','resources','networking','storage','environment','review'], type AddGameWizardStep"
  dependencies: none
  data_shapes: readonly string tuple
  side_effects: none
  role: constant
  observations: "Consumers named in its doc: web wizard-form.utils.ts and desktop-main GameWizardDraftService (addGameWizardSteps.ts:3-7)."

- path: app/packages/shared/src/audit.ts
  purpose: Audit-log entry types and sort-key builder.
  exports: "type AuditAction (add|edit|remove|plan|approve|apply|destroy|rollback), interface AuditEntry, interface AuditPageResult, buildAuditSk(now?)"
  dependencies: "ulid; type RedactedGameServer"
  data_shapes: "AuditEntry {sk, timestamp, actor, action, game, before|null, after|null, versionId?}; sk = `<ISO>#<ULID>`"
  side_effects: none (reads the clock only when `now` is defaulted)
  role: shared types + pure helper
  observations: "The doc references IacController.approve/apply/destroy/confirmRollback (audit.ts:9-16) and describes the table as `${project_name}-audit`, pk=AUDIT."

- path: app/packages/shared/src/audit.test.ts
  purpose: Tests buildAuditSk.
  role: test
  observations: "Pins: shape `<ISO>#<26-char Crockford ULID>`; ISO prefix taken from the given Date; defaults to now; lexicographic order is chronological."

- path: app/packages/shared/src/autoUpdateSetting.ts
  purpose: IPC payload/result types for the iac.settings.autoUpdate.* channels.
  exports: "AutoUpdateSettingGet{Success,Failure,Result}, AutoUpdateSettingUpdatePayload, AutoUpdateSettingWrite{Success,Failure,Result}, ManualUpdateCheckResult, UpdateDownloadProgress, UpdateDownloadResult, UpdateInstallResult"
  dependencies: none
  data_shapes: "ok/code discriminated unions; UpdateDownloadProgress {percent, transferred, total, bytesPerSecond}"
  side_effects: none
  role: shared types
  observations: "The doc ties the flag to desktop-main/src/updater.ts electron-updater (autoUpdateSetting.ts:4). Channels named: get/update/check/download/install."

- path: app/packages/shared/src/awsRegions.ts
  purpose: Generated list of commercial-partition AWS regions with labels.
  exports: "interface AwsRegionInfo {code,name,continent}, AWS_REGIONS (36 entries)"
  dependencies: none
  data_shapes: array of region info
  side_effects: none
  role: generated constant
  observations: "Header says regenerate via `npm run aws-regions:generate`, do not hand-edit (awsRegions.ts:3-5). Includes 'eusc-de-east-1' (sovereign cloud, line 36) and 'us-east-2-mci-1' (line 51), even though the doc says only commercial-partition regions are listed and GovCloud/China are excluded."

- path: app/packages/shared/src/canRun.ts
  purpose: The single Discord permission evaluator (CLAUDE.md invariant).
  exports: "canRun(cfg: DiscordConfig, {guildId,userId,roleIds,game,action}): boolean"
  dependencies: "types DiscordAction, DiscordConfig"
  data_shapes: DiscordConfig
  side_effects: none
  role: pure business rule
  observations: "Order: guild allowlist deny -> admin userIds/roleIds allow -> per-game entry with action included and user/role match -> deny (canRun.ts:29-37). The doc says 'imported verbatim by desktop-main and every Lambda' (line 16)."

- path: app/packages/shared/src/canRun.test.ts
  purpose: Tests canRun.
  role: test
  observations: "Pins: unknown guild denies even an admin (short-circuit); admin user/role allow any game/action; missing game entry denies; a listed user without the action denies; user or role match plus action allows."

- path: app/packages/shared/src/changeSummary.ts
  purpose: Pulumi resource-change summary types, duplicated from @pulumi/pulumi/automation.
  exports: "type OpType (15 members), type ChangeSummary = {[OpType]?: number}"
  dependencies: none
  data_shapes: count map keyed by OpType
  side_effects: none
  role: shared types
  observations: "Deliberately duplicates Pulumi's OpType/OpMap byte-for-byte (changeSummary.ts:9-15), because Lambdas and the renderer must not depend on @pulumi/pulumi. Sharp edge: `{}` means 'summary event never observed', not 'no changes' (lines 46-54)."

- path: app/packages/shared/src/cloud.ts
  purpose: Cloud-agnostic provider and store interfaces, plus the conflict error.
  exports: "StartOpts, WorkloadHandle, WorkloadStatus, LogChunk, CostBreakdown, interface CloudProvider, SecretsStore, RemoteFileStore, class RemoteFileConflictError, DiscordEventReceiver, AuditLogStore, DiscordConfigStore, RunRecordStore"
  dependencies: "types from audit, runs, types"
  data_shapes: "WorkloadStatus.state running|starting|stopped|not_deployed|error; RemoteFileStore get/getVersion/put(ifMatch)/listVersions; RunRecordStore putRecord/getRecordByRunId/listRuns/putLog/getLogUrl/acquireRunLock/getRunLock/releaseRunLock"
  side_effects: none
  role: interface contracts
  observations: "RemoteFileConflictError sets its prototype explicitly (cloud.ts:183). The CostBreakdown doc says the app makes no Cost Explorer calls (lines 32-36). The RunRecordStore doc says the apply lock is store-owned so it survives restarts (lines 259-263). The LogChunk name collides with desktop-preload's `type LogChunk = string` (hyveon-api.ts:149), which is a different shape."

- path: app/packages/shared/src/cloud.test.ts
  purpose: Contract tests for cloud.ts.
  role: test
  observations: "Pins: cloud.ts source contains no `from '@aws-sdk/` import (a file-read assertion, cloud.test.ts:23-26); each interface is implementable by a plain object; RemoteFileConflictError is an Error with name, path, custom message and ifMatch."

- path: app/packages/shared/src/commands.ts
  purpose: Discord slash-command descriptors and the command-to-permission mapping.
  exports: "type AppCommandName ('server-start'|'server-stop'|'server-status'|'server-list'), actionForCommand(name), COMMAND_DESCRIPTORS (const JSON)"
  dependencies: type DiscordAction
  data_shapes: "Discord application-command JSON (option type 3 = STRING, autocomplete)"
  side_effects: none
  role: constant + pure mapping
  observations: "server-status and server-list both map to 'status' (commands.ts:16-18). server-list has no options (line 69-72)."

- path: app/packages/shared/src/commands.test.ts
  purpose: Tests actionForCommand and COMMAND_DESCRIPTORS.
  role: test
  observations: "Pins: exactly four commands; `game` required+autocomplete on start/stop, optional on status; server-list has no options."

- path: app/packages/shared/src/deploymentConfig.ts
  purpose: The canonical DeploymentConfig model, its defaults, the runs-table name resolution, and the rollback diff.
  exports: "CONFIGURATION_OBJECT_KEY='deployment-config.json', interface DeploymentConfig, type TopLevelDeploymentSettings, DEPLOYMENT_CONFIG_DEFAULTS, resolveRunsTableName, resolvePreApplyRunsTableName, withDeploymentConfigDefaults, interface DeploymentConfigDiff, diffDeploymentConfig"
  dependencies: "types GameServerConfig, RemoteFileStore"
  data_shapes: "DeploymentConfig {projectName, awsRegion, vpcCidr, hostedZoneName, dnsTtl, watchdogIntervalMinutes, watchdogIdleChecks, watchdogMinPackets, baseAllowedGuilds[], baseAdminUserIds[], baseAdminRoleIds[], discordApplicationId, auditTableName, runsTableName, gameServers: Record<string,GameServerConfig>}"
  side_effects: "resolvePreApplyRunsTableName reads the config object from RemoteFileStore (deploymentConfig.ts:287-296); everything else is pure"
  role: domain model + pure helpers
  observations: "gameServers deliberately keeps snake_case fields (lines 6-12). Secrets must never be added (lines 18-21). Defaults: hyveon/us-east-1/10.0.0.0/16/30/15/4/100 (lines 235-246). resolvePreApplyRunsTableName swallows every error and returns undefined (lines 293-295). diffDeploymentConfig compares key-order-insensitively via canonicalJson (lines 413-434) and walks a hand-maintained DEPLOYMENT_CONFIG_SCALAR_FIELDS list (lines 392-407) that must track the interface. auditTableName '' is resolved downstream, not here (lines 143-152). The doc references `#112` (line 30)."

- path: app/packages/shared/src/deploymentConfig.test.ts
  purpose: Tests DeploymentConfig serialisation, defaults and diff.
  role: test
  observations: "Pins: lossless JSON round-trip; an absent `https` stays absent (not null/false); defaults match their documented values; withDeploymentConfigDefaults allocates fresh base arrays per call and leaves auditTableName/runsTableName as ''; diff ignores key order, reports every scalar field, and classifies games as added/removed/changed."

- path: app/packages/shared/src/deploymentSettingsWrite.ts
  purpose: Shared client+server validator and IPC result types for iac.settings.get/update.
  exports: "DeploymentSettingsValidationIssue, validateDeploymentSettingsPatch, SNOWFLAKE_PATTERN, isSnowflake, DeploymentSettings{GetSuccess,SetupIncomplete,Failure,GetResult,WriteSuccess,Conflict,ValidationFailure,WriteResult}, UpdateDeploymentSettingsPayload"
  dependencies: type TopLevelDeploymentSettings
  data_shapes: "issues {path,message}; result unions with codes setup_incomplete|error|conflict|validation"
  side_effects: none
  role: shared validator + types
  observations: "Validates a PATCH: only fields that are present are checked, with a type check first (deploymentSettingsWrite.ts:39-45). The CIDR regex accepts leading zeros (lines 94-98). checkStringField's doc cites a '\"Type safety\" doc' section that doesn't exist under that heading in validateDeploymentSettingsPatch (lines 107-108). SNOWFLAKE_PATTERN is also documented as used by web isSnowflake (line 81)."

- path: app/packages/shared/src/deploymentSettingsWrite.test.ts
  purpose: Tests validateDeploymentSettingsPatch.
  role: test
  observations: "Pins: an empty patch is valid; required non-empty strings; CIDR edge cases; positive integers for the watchdog/dnsTtl fields; snowflake arrays with index-pathed issues; computed-default fields may be ''; wrong-typed values are rejected (never skipped); multiple issues are aggregated."

- path: app/packages/shared/src/diagnosticsBundle.ts
  purpose: Result type for the diagnostics.exportBundle IPC channel.
  exports: "type ExportDiagnosticsBundleResult (written{path}|cancelled|error{message})"
  dependencies: none
  data_shapes: status union
  side_effects: none
  role: shared type
  observations: none

- path: app/packages/shared/src/drift.ts
  purpose: Drift-detection types.
  exports: "DriftKind (pending_create|pending_delete|config_drift), DriftChangedField (ports|image|cpu|memory|volumes), DriftEntry, DriftReport"
  dependencies: none
  data_shapes: "DriftReport {entries: DriftEntry[]}"
  side_effects: none
  role: shared types
  observations: "The DriftReport doc says 'Aggregate drift report returned by `GET /api/drift`' (drift.ts:46). That is a stale HTTP reference (the desktop app has no HTTP transport). The doc references issue #94 (line 5). DriftChangedField omits newer fields such as https, webPort, healthCheck, environment and pinnedHostname (line 26)."

- path: app/packages/shared/src/env.ts
  purpose: Lambda environment-variable helpers.
  exports: "requireEnv(name), gameNamesFromEnv(), parseGameMapEnv<T>(name), familyToGameMap(names)"
  dependencies: envJson.parseJsonEnv
  data_shapes: "GAME_NAMES csv; `{game}-server` -> game map with a null prototype"
  side_effects: reads process.env
  role: Lambda helper
  observations: "requireEnv is meant for module scope so failures surface at INIT_FAILURE (env.ts:7-10). familyToGameMap uses a null prototype to defeat a `constructor`/`toString` lookup (lines 57-59, 65). The raw process.env reads are acceptable here because these are the env wrappers."

- path: app/packages/shared/src/env.test.ts
  purpose: Tests env helpers.
  role: test
  observations: "Pins: requireEnv throws on unset or empty; GAME_NAMES is split/trimmed/filtered; parseGameMapEnv falls back to {}; familyToGameMap returns undefined for inherited keys. Mutates process.env (implied by the tests)."

- path: app/packages/shared/src/envJson.ts
  purpose: Tolerant JSON env parsing with shape checks.
  exports: "parseJsonEnv<T>(envName, raw, fallback)"
  dependencies: none
  data_shapes: generic
  side_effects: "console.warn on malformed input"
  role: Lambda helper
  observations: "Two `@remarks` blocks in one TSDoc comment (envJson.ts:5 and :13). An array fallback requires an array; an object fallback rejects arrays (lines 26-30)."

- path: app/packages/shared/src/envJson.test.ts
  purpose: Tests parseJsonEnv.
  role: test
  observations: "Pins: falls back on undefined, '' and malformed input (with a warning); a valid but non-object value falls back for an object fallback; arrays and objects are distinguished in both directions."

- path: app/packages/shared/src/envTokens.ts
  purpose: The `${hyveon.*}` env-value interpolation token catalogue and helpers.
  exports: "HYVEON_ENV_TOKENS {publicAddress:'${hyveon.network.public-address}', publicIpv4:'${hyveon.network.public-ipv4}'}, type HyveonEnvToken, ALLOWED_HYVEON_ENV_TOKENS, HYVEON_TOKEN_CANDIDATE_PATTERN, findHyveonTokenCandidates, valueUsesToken, substituteHyveonToken"
  dependencies: none
  data_shapes: strings
  side_effects: none
  role: pure helper
  observations: "The candidate regex also matches an unclosed `${hyveon.` up to the end of the string (envTokens.ts:24). Substitution is split/join (line 38)."

- path: app/packages/shared/src/envTokens.test.ts
  purpose: Tests envTokens.
  role: test
  observations: "Pins: embedded, repeated and unknown candidates are found; `${OTHER}` is ignored; substitution leaves other text byte-identical; exactly two tokens are allowed."

- path: app/packages/shared/src/errors.ts
  purpose: Cross-package error classes and message normaliser.
  exports: "class OptimisticLockError(expectedEtag, currentEtag?, message?), class RunLockHeldError(lock, message?), errMessage(err)"
  dependencies: type RunLock
  data_shapes: n/a
  side_effects: none
  role: shared errors
  observations: "The RunLockHeldError doc says 'so the HTTP layer can respond 409 Conflict' (errors.ts:53-55). That is stale; there is no HTTP layer. Both classes call setPrototypeOf. errMessage is the shared copy of the `err instanceof Error ? err.message : String(err)` idiom required by .claude/rules/logging.md."

- path: app/packages/shared/src/errors.test.ts
  purpose: Tests the error classes.
  role: test
  observations: "Pins: instanceof Error; names; etag/lock fields round-trip; default messages ('unknown' when currentEtag is missing; initiator/kind/runId); custom messages."

- path: app/packages/shared/src/fileManagerLogGroup.ts
  purpose: The FileBrowser helper's log-group name.
  exports: "fileManagerLogGroupName(game) => `/ecs/filebrowser-${game}`"
  dependencies: none
  data_shapes: string
  side_effects: none
  role: pure helper
  observations: "Shared by the infra program (which pre-creates the group) and FileManagerService (fileManagerLogGroup.ts:2-4)."

- path: app/packages/shared/src/fileManagerLogGroup.test.ts
  purpose: Tests fileManagerLogGroupName.
  role: test
  observations: "Pins the `/ecs/filebrowser-{game}` format."

- path: app/packages/shared/src/formatStatus.ts
  purpose: Renders Discord status messages and connect-message templates.
  exports: "renderConnectMessage(template, {host?, ip?, port?, game}), formatGameStatus(status, connectMessage?, port?)"
  dependencies: "HTTPS_CONNECT_PORT, ConnectPort, type GameStatus"
  data_shapes: strings
  side_effects: none
  role: pure presentation helper (used by Lambdas)
  observations: "For an https marker port, `{host}:{port}` becomes `https://{host}`, keeping an existing scheme (formatStatus.ts:21-24), and a bare `{port}` becomes 443 (line 25). Emoji mapping: running/starting/stopped, with ⚠️ for anything else (lines 44-48). The connect message is shown only when the state is running (line 52)."

- path: app/packages/shared/src/formatStatus.test.ts
  purpose: Tests formatGameStatus and renderConnectMessage.
  role: test
  observations: "Pins: https URL rendering, no doubled scheme, an http scheme is kept, the host:443 fallback when there is no host, a numeric 443 on a non-https game stays untouched; emoji per state; hostname preferred over IP; placeholder substitution; an empty connect message counts as absent; it is ignored when not running."

- path: app/packages/shared/src/gameServerConfig.ts
  purpose: The canonical per-game config shape, redaction, and the games-list entry type.
  exports: "GameServerPort, isIcmpProtocol, GameServerEnvironmentVariable, GameServerVolume, GameServerFileSeed, GameServerHealthCheckAuth, GameServerHealthCheckCondition, GameServerHealthCheck, GameServer, type GameServerConfig = Omit<GameServer,'name'>, RedactedGameServerHealthCheck, RedactedGameServer, redactGameServer, GameListEntry"
  dependencies: "types DriftKind, DriftChangedField"
  data_shapes: "GameServer {name,image,cpu,memory,ports[{container,protocol,visibility?}],webPort?,environment?,command?,volumes[],https?,connect_message?,file_seeds?,healthCheck?,pinnedHostname?}"
  side_effects: none
  role: domain model + pure redaction
  observations: "redactGameServer replaces auth with secretSet/authType (gameServerConfig.ts:373-383). The GameListEntry doc still says '`/api/games` HTTP route' and 'deployed view (tfstate)' (lines 386-390, 395, 401), both stale since the move to Pulumi/IPC. Legacy https ports[0]-as-upstream reading is documented as deprecated (lines 231-234, 279-281). The doc references issue #92 (line 390). The app-owned secret name `hyveon-{gameId}-healthcheck-auth` is documented here (line 135)."

- path: app/packages/shared/src/gameServerPorts.ts
  purpose: HTTPS-port helpers, legacy https normalisation, ingress selection and webPort collision checks.
  exports: "HTTPS_RESERVED_PORTS [80,443], isReservedHttpsPort, HTTPS_CONNECT_PORT='https', type ConnectPort, normalizeGameServer (deprecated), normalizeDeploymentConfigGames (deprecated), ingressPorts, findWebPortCollisions"
  dependencies: "types DeploymentConfig, GameServerConfig, GameServerPort"
  data_shapes: game configs
  side_effects: none
  role: pure domain helpers
  observations: "normalizeGameServer checks `first.protocol !== 'tcp'` case-sensitively (gameServerPorts.ts:62), while ingressPorts/findWebPortCollisions lowercase the protocol (lines 106, 130). An `https` game with ports[0] 'TCP' is therefore not normalised. normalizeDeploymentConfigGames builds a null-prototype map to keep a `__proto__` key (lines 83-84). The removal plan is stated as 'first minor after the one shipping webPort, plus one release of overlap' (lines 39-41). findWebPortCollisions duplicates the write-path check in gameServerValidator.checkWebPortCollisionsAcrossDeployment (validator:838-869), with differing message text."

- path: app/packages/shared/src/gameServerPorts.test.ts
  purpose: Tests the port helpers.
  role: test
  observations: "Pins: normalisation is idempotent, non-mutating and returns the same reference when nothing changes; a null webPort draft is left alone; non-tcp, empty or no ports are untouched; a reserved 443 is promoted; ingressPorts excludes webPort; a `__proto__` key survives; collisions with udp/self are ignored."

- path: app/packages/shared/src/gameServerValidator.ts
  purpose: Zod structural schema plus cross-entry business-rule validation for game_servers entries, and Fargate pricing/sizing helpers.
  exports: "GAME_NAME_PATTERN, GAME_NAME_PATTERN_DESCRIPTION, PINNED_HOSTNAME_PATTERN(+_DESCRIPTION), HOSTNAME_SHIM_MOUNT_PATH='/hyveon/hostname-shim', HOSTNAME_SHIM_RESERVED_NAME='hostname-shim', gameServerPortSchema, gameServerEnvironmentVariableSchema, gameServerVolumeSchema, gameServerFileSeedSchema, gameServerHealthCheckAuthSchema, gameServerHealthCheckAuthInputSchema, GameServerHealthCheckAuthWriteInput, validateHealthCheckAuthInput, gameServerHealthCheckConditionSchema, gameServerHealthCheckSchema, gameServerSchema, GameServerEntryInput, GameServerValidationIssue, GameServerValidationResult, getFargateCpuOptions, getFargateMemoryOptions, FARGATE_VCPU_PER_HOUR=0.04048, FARGATE_GB_PER_HOUR=0.004445, estimateFargateHourlyCost, checkEnvironmentValueTokens, ALLOWED_CONNECT_MESSAGE_PLACEHOLDERS, PLACEHOLDER_TOKEN_PATTERN, checkConnectMessagePlaceholders, isValidIcmpType, validateGameServer"
  dependencies: "zod; gameServerConfig (isIcmpProtocol); gameServerPorts (isReservedHttpsPort); envTokens"
  data_shapes: "issues {path,message}; result {success,data}|{success:false,issues}"
  side_effects: none
  role: shared validator (renderer + desktop-main)
  observations: "The game name is capped at 32 characters for the Lambda/IAM 64-char budget, and is enforced only at creation, never on read/update (gameServerValidator.ts:37-49, 51). Fargate CPU->memory table (lines 358-368). The header-credential heuristic regex rejects any value of 20+ [a-z0-9._-] characters (line 111), which may false-positive on long non-secret values. checkHttpsPortRules compares protocol case-sensitively, so 'TCP' is rejected (line 753) while every other check lowercases. checkHealthCheckRules requires `protocol === 'tcp'` case-sensitively (line 1001). Port-collision/https/webPort checks run even when the schema fails, so drafts still get feedback (lines 1078-1098). The cross-deployment 443/80 reservation is security-load-bearing in both directions (lines 871-936). Pricing lives here and is re-exported by cloud-aws (lines 402-411). estimateFargateHourlyCost's formula is duplicated by AwsCloudProvider.estimateHourlyCost (cloud-aws AwsCloudProvider.ts:312-317)."

- path: app/packages/shared/src/gameServerValidator.test.ts
  purpose: Tests validateGameServer and the helpers (1321 lines).
  role: test
  observations: "Pins: every Fargate tier boundary and step violation; absolute paths; empty/duplicate env names; placeholder allowlist; within-game and cross-game port collisions (protocol-aware); icmp cross-game exemption with a visibility-match requirement and a remediation message; webPort required/forbidden/range/reserved; https extra-port rules, including that uppercase 'TCP' is rejected; icmp type 0-255 including uppercase 'ICMP'; the 443/80 tcp reservation in both directions with no self-flag; webPort collisions across games; health-check port/operator/value/timeout/path/secretArn/header-credential rules; auth input per type; command non-empty; ipv4 token requires a command and shell-identifier names; pinnedHostname pattern and reserved names/paths; redactGameServer keeps pinnedHostname."

- path: app/packages/shared/src/gamesWrite.ts
  purpose: IPC payload/result types for games.create/update/delete.
  exports: "GameServerHealthCheckWriteInput, GameServerWriteConfig, GameWriteSuccess, GameWriteConflict, GameWriteValidationFailure, GameWriteNotFound, GameWriteSetupIncomplete, GameWriteFailure, GameWriteResult, CreateGamePayload, UpdateGamePayload, DeleteGamePayload"
  dependencies: "types from gameServerConfig, gameServerValidator"
  data_shapes: "ok/code unions (conflict|validation|not_found|setup_incomplete|error); auth null=clear, undefined=unchanged"
  side_effects: none
  role: shared types
  observations: "The header says '(and their HTTP equivalents)' (gamesWrite.ts:4), which is stale. CreateGamePayload and UpdateGamePayload are structurally identical (lines 117-131)."

- path: app/packages/shared/src/iamPolicy.ts
  purpose: The HyveonDeployAll IAM policy as structured statements plus a flattened action set; policy-document generators.
  exports: "HYVEON_DEPLOY_ALL_ACTIONS, HYVEON_DEPLOY_ALL_STATEMENTS, generateHyveonDeployAllPolicy(projectName='hyveon'), generateHyveonSelfRotatePolicy()"
  dependencies: none
  data_shapes: "IAM policy JSON; Fn::Sub object for the self-rotate Resource"
  side_effects: none
  role: constant + generator
  observations: "HYVEON_DEPLOY_ALL_ACTIONS is a hand-flattened duplicate of the statements (iamPolicy.ts:9-39 vs 79-172), kept in sync only by test. The state-bucket statement is scoped to `${projectName}-tfstate` (lines 147-150), a legacy name carried over from the pre-Pulumi era. IAM resources are scoped to role/hyveon-* and policy/hyveon-* (line 105). HyveonIAMSimulate uses `${aws:username}` (line 112). SLR GetRole is split out because GetRole lacks the iam:AWSServiceName context key (lines 162-166). The doc cites issue #208 (line 6)."

- path: app/packages/shared/src/iamPolicy.test.ts
  purpose: Asserts iamPolicy stays in sync with the docs.
  role: test
  observations: "Reads docs/docs/setup.md at runtime and regex-extracts the FIRST ```json block (iamPolicy.test.ts:18, 33-35). That is fragile if another json block is placed before the policy. Pins: Sid-for-Sid and statement-for-statement equality, including Effect/Resource; the flattened set equals the deduplicated statement actions; the self-rotate policy has three actions with Fn::Sub serialised as a nested object."

- path: app/packages/shared/src/lambdaFunctionKey.ts
  purpose: Keys for the five log-tailable Lambda functions.
  exports: "type LambdaFunctionKey (watchdog|health-check|dns-updater|interactions|followup), LAMBDA_FUNCTION_KEYS"
  dependencies: none
  data_shapes: string union + array
  side_effects: none
  role: constant
  observations: "efs-seeder is excluded as per-game (lambdaFunctionKey.ts:5-6). The log group is `/aws/lambda/${projectName}-${functionKey}`. The union and the array are both hand-written (lines 8-26), so they can drift despite the 'can never drift' doc (line 18)."

- path: app/packages/shared/src/pulumiVersion.ts
  purpose: Pinned Pulumi engine version.
  exports: "PULUMI_ENGINE_VERSION='3.255.0', interface PulumiEngineVersionResult {resolvedVersion: string|null}"
  dependencies: none
  data_shapes: string
  side_effects: none
  role: constant
  observations: "An exact pin, asserted against the root manifest by app/test/packaging-manifest-pins.test.ts (pulumiVersion.ts:4-5, 16-19). Used by PulumiEngineService's PulumiCommand.install."

- path: app/packages/shared/src/relativeTime.ts
  purpose: Coarse 'N units ago' formatter.
  exports: "formatRelativeAge(ms)"
  dependencies: none
  data_shapes: string
  side_effects: none
  role: pure helper
  observations: "Shared by PulumiLockRecovery.formatLockAge and web submission-banners formatLockAge (relativeTime.ts:9-11)."

- path: app/packages/shared/src/relativeTime.test.ts
  purpose: Tests formatRelativeAge.
  role: test
  observations: "Pins: <1 min; singular/plural minutes, hours and days; negative values are clamped."

- path: app/packages/shared/src/runs.ts
  purpose: Run-history record and lock types, plus pure status/lock/approval helpers.
  exports: "RunKind (plan|apply|destroy), RunStatus (success|failed|aborted), RunRecord, RunPageResult, buildRunSk, deriveRunStatus, RunLock, isRunLockExpired, APPROVAL_WINDOW_MS (15 min), isApprovalExpired, RunDetailStatus, computeRunDetailStatus"
  dependencies: type ChangeSummary
  data_shapes: "RunRecord {sk,runId,kind,status,startedAt,completedAt,exitCode,configVersionId?,planHash?,approvedBy?,approvedAt?,logInline?,logS3Key?,rolledBackFrom?,changeSummary?,engineVersion?,partialApply?}; RunLock {runId,kind,initiator,acquiredAt,expiresAt}"
  side_effects: none
  role: shared types + pure helpers
  observations: "The plan/apply vocabulary is kept from the pre-Pulumi tool (runs.ts:4-13). partialApply is additive rather than a new RunStatus because status is the GSI hash key (lines 135-139). The pre-flight marker relies on partialApply:true persisting (lines 150-160), but cloud-aws AwsRunRecordStore never writes or reads partialApply (see that entry). The computeRunDetailStatus doc admits nothing deletes the `.tfplan` artifact and that the 'awaiting_approval' escape relies on rule ordering (lines 309-321). The RunLock doc mentions 'mirroring CodeBuild's concurrent_build_limit = 1' (line 218), a legacy reference."

- path: app/packages/shared/src/runs.test.ts
  purpose: Tests the runs helpers.
  role: test
  observations: "Pins: sk format and ordering; exit code -> status (null=aborted); lock and approval expiry are inclusive at the boundary; computeRunDetailStatus precedence (inFlight > awaiting_approval only when the artifact exists > deriveRunStatus)."

- path: app/packages/shared/src/sanitize.ts
  purpose: Defensive coercion for DynamoDB-stored Discord config and prototype-pollution guards.
  exports: "UNSAFE_GAME_KEYS, isSafeGameKey, asString, asStringArray, sanitizeGamePermission"
  dependencies: "types DiscordAction, DiscordGamePermission"
  data_shapes: DiscordGamePermission
  side_effects: none
  role: pure helper
  observations: "Unknown actions are dropped (sanitize.ts:31-33)."

- path: app/packages/shared/src/sanitize.test.ts
  purpose: Tests sanitize.
  role: test
  observations: "Pins: type filtering; `__proto__`/`constructor`/`prototype` and '' are rejected; unknown actions and non-string ids are dropped."

- path: app/packages/shared/src/stackOutputs.ts
  purpose: Typed contract for the Pulumi stack outputs the app reads.
  exports: "interface StackOutputs"
  dependencies: type GameServerConfig
  data_shapes: "{awsRegion, ecsClusterName, ecsClusterArn, subnetIds: string[], securityGroupId, fileManagerSecurityGroupId, efsFileSystemId, efsAccessPoints, domainName, gameNames, discordTableName, auditTableName, runsTableName, discordBotTokenSecretArn, discordPublicKeySecretArn, fileBrowserCredentialSecretArn, fileBrowserSchedulerRoleArn, interactionsInvokeUrl|null, discordInteractionsUrl|null, appliedGameServers|null}"
  side_effects: none
  role: shared type
  observations: "subnetIds is an array (stackOutputs.ts:57-61), but cloud-aws AwsCloudProviderConfig.subnetIds is a comma-joined string (AwsCloudProvider.ts:131), so callers must join it. The file doc lists six original outputs that were intentionally dropped (lines 17-23). runsTableName is a config echo, not resource-derived (lines 92-99). efsAccessPoints holds only each game's first volume access point (lines 73-76)."

- path: app/packages/shared/src/types.ts
  purpose: Discord and status core types.
  exports: "DiscordAction, DiscordGamePermission, DiscordAdmins, DiscordConfig, BaseDiscordConfig, RedactedDiscordConfig, GameStatus, StartResult, PendingInteraction, RendererConsoleLevel, RendererLogEntry"
  dependencies: none
  data_shapes: "DiscordConfig {clientId, allowedGuilds, admins, gamePermissions}; PendingInteraction {taskArn, applicationId, interactionToken, userId, guildId, game, action, expiresAt}"
  side_effects: none
  role: shared types
  observations: "GameStatus.state duplicates the WorkloadStatus.state union in cloud.ts:17 (types.ts:63). Shared RedactedDiscordConfig lacks `interactionsEndpointUrl`, which preload's copy has (hyveon-api.ts:256). RendererLogEntry/RendererConsoleLevel live here, not in a diagnostics module (lines 94-101)."

- path: app/packages/shared/src/wizardSteps.ts
  purpose: First-run wizard step order.
  exports: "WIZARD_STEPS ['pick-cloud','guided-iam','credentials','bootstrap','stack-init'], type WizardStep"
  dependencies: none
  data_shapes: tuple
  side_effects: none
  role: constant
  observations: "Hand-duplicated as `WizardStepName` in desktop-preload hyveon-api.ts:1705."
```

## app/packages/shared/src/aws

```yaml
- path: app/packages/shared/src/aws/ecsTask.ts
  purpose: SDK-free helpers for reading ECS task ENI details and resolving an ENI's public IP.
  exports: "EcsTaskLike, getTaskAttachmentDetail, getTaskEniId, getTaskPrivateIp, DescribeNetworkInterfacesResultLike, resolveEniPublicIp(describeFn, eniId)"
  dependencies: none (structural types only)
  data_shapes: "task.attachments[].details[] name/value"
  side_effects: "none itself; resolveEniPublicIp invokes a caller-supplied describe callback"
  role: pure helper
  observations: "Deliberately has no @aws-sdk/client-ecs/ec2 dependency and cites a no-restricted-imports ESLint rule (ecsTask.ts:5-9, 73-76). Error handling is left to callers: Lambdas throw, AwsCloudProvider/Ec2Service log and return null (lines 88-92)."

- path: app/packages/shared/src/aws/ecsTask.test.ts
  purpose: Tests ecsTask helpers.
  role: test
  observations: "Pins: only ElasticNetworkInterface attachments count; null when the attachment or detail is missing; describe errors propagate."
```

## app/packages/shared/src/ddb

```yaml
- path: app/packages/shared/src/ddb/client.ts
  purpose: Lazy singleton DynamoDB DocumentClient for Lambdas.
  exports: "getDocClient(), __resetDocClient()"
  dependencies: "@aws-sdk/client-dynamodb, @aws-sdk/lib-dynamodb"
  data_shapes: n/a
  side_effects: "reads process.env AWS_REGION_ -> AWS_REGION -> AWS_DEFAULT_REGION -> us-east-1; caches a module-level client"
  role: AWS client factory
  observations: "A third copy of the region fallback chain. The others are secrets/secretsStore.ts:26-27 and cloud-aws awsRegionEnv.ts:15-22, plus inline copies in AwsSecretsStore.ts:72-77 and AwsRemoteFileStore.ts:86-91. This copy doesn't trim; the cloud-aws one does. The cached client never rebuilds when the region changes."

- path: app/packages/shared/src/ddb/configStore.ts
  purpose: Read/write the Discord CONFIG#discord and BASE#discord DynamoDB rows, with sanitisation and base+dynamic merge.
  exports: "getBaseDiscordConfig(table, client?), getEffectiveDiscordConfig(table, client?), getDiscordConfig(table, client?), putDiscordConfig(table, cfg, client?)"
  dependencies: "@aws-sdk/lib-dynamodb Get/PutCommand; sanitize; ddb/client"
  data_shapes: "items {pk:'CONFIG#discord', sk:'CONFIG', data, updatedAt} / {pk:'BASE#discord', sk:'BASE', data}"
  side_effects: "DynamoDB GetItem (ConsistentRead) and PutItem"
  role: data-access helper (Lambdas + desktop via cloud-aws)
  observations: "The effective config is the union of base and dynamic guild/admin lists, while gamePermissions come from the dynamic row only (configStore.ts:113-121). Unsafe game keys are dropped on read (line 34). putDiscordConfig writes cfg verbatim without sanitising (lines 154-164). An injectable client was added for the Electron credential problem (lines 75-81)."

- path: app/packages/shared/src/ddb/configStore.test.ts
  purpose: Tests configStore.
  role: test
  observations: "Pins: an empty config/base when a row is missing; sanitisation instead of throwing; prototype-pollution keys are dropped; ConsistentRead; merge dedup; dynamic clientId/gamePermissions are kept; the fixed pk on write."

- path: app/packages/shared/src/ddb/pendingStore.ts
  purpose: Pending Discord interaction rows keyed by ECS task ARN, with a 15-min TTL.
  exports: "putPending(table, item), getPending(table, taskArn), deletePending(table, taskArn)"
  dependencies: "@aws-sdk/lib-dynamodb; ddb/client.getDocClient"
  data_shapes: "{pk:'PENDING#<taskArn>', sk:'PENDING', data:{...item, expiresAt}, expiresAt (epoch s), updatedAt}"
  side_effects: "DynamoDB Put/Get(ConsistentRead)/Delete; fire-and-forget delete of expired rows"
  role: data-access helper (Lambdas)
  observations: "Unlike configStore, there is no injectable client parameter; it always uses getDocClient() (pendingStore.ts:18, 43, 65). An expired row is treated as absent and deleted best-effort, because DynamoDB TTL can lag up to 48h (lines 35-41, 54-58). expiresAt is stored both inside data and at the top level."

- path: app/packages/shared/src/ddb/pendingStore.test.ts
  purpose: Tests pendingStore.
  role: test
  observations: "Pins: 15-min TTL key layout; null when missing; an expired row returns null and triggers a delete; a failing delete doesn't reject; ConsistentRead; delete by ARN."
```

## app/packages/shared/src/discord

```yaml
- path: app/packages/shared/src/discord/awsLambdaDiscordReceiver.ts
  purpose: DiscordEventReceiver backed by a pre-resolved `discord_interactions_url`.
  exports: "interface DiscordReceiverConfig {discord_interactions_url}, class AwsLambdaDiscordReceiver"
  dependencies: type DiscordEventReceiver
  data_shapes: snake_case config key
  side_effects: none
  role: provider implementation (in shared)
  observations: "No non-test consumer anywhere in app/ (git grep). It appears to be dead code, superseded by cloud-aws AwsDiscordEventReceiver, which reads `interactionsInvokeUrl` instead. It uses the custom-domain URL; the other receiver uses the invoke URL. An AWS-named class lives in the cloud-agnostic package."

- path: app/packages/shared/src/discord/awsLambdaDiscordReceiver.test.ts
  purpose: Tests AwsLambdaDiscordReceiver.
  role: test
  observations: "Pins: returns the url, or null when it is null or absent."

- path: app/packages/shared/src/discord/patchOriginal.ts
  purpose: PATCH a deferred Discord interaction's @original message.
  exports: "patchInteractionOriginal(applicationId, interactionToken, content)"
  dependencies: global fetch
  data_shapes: "{content}"
  side_effects: "HTTPS PATCH to discord.com/api/v10/webhooks/{app}/{token}/messages/@original; console.error on non-OK"
  role: network helper (Lambdas)
  observations: "Swallows a non-OK response but does NOT catch a fetch rejection (network error), so it can still throw despite the doc saying 'Swallows and logs failures rather than throwing' (patchOriginal.ts:9-11, 23-31). No tests in scope."
```

## app/packages/shared/src/folderUpload

```yaml
- path: app/packages/shared/src/folderUpload/index.ts
  purpose: Subpath barrel for folder-upload types and helpers.
  exports: "re-exports types.js and paths.js"
  dependencies: siblings
  data_shapes: n/a
  side_effects: none
  role: barrel (deep-import only, not in the main barrel)
  observations: none

- path: app/packages/shared/src/folderUpload/paths.ts
  purpose: Pure path planning and validation for folder-to-volume uploads.
  exports: "VolumeLike, DestinationValidation, planUpload(tree, include), toRemotePath(destination, containerPath, relPath), validateDestination(destination, volumes)"
  dependencies: "types FolderScanNode, PlannedFile"
  data_shapes: POSIX paths
  side_effects: none
  role: pure helper (path-traversal guard)
  observations: "Rejects NUL, backslash, `.` and `..` segments, and absolute or empty relPaths (paths.ts:16-17, 62-68). Whole-segment prefix matching prevents sibling-prefix escapes (line 20-21). validateDestination picks the deepest matching volume (lines 92-98). toRemotePath strips container_path because the helper's root is the access point (lines 54-55)."

- path: app/packages/shared/src/folderUpload/paths.test.ts
  purpose: Tests the path helpers.
  role: test
  observations: "Pins: directory inheritance; no directories emitted; prefix stripping; trailing slashes; root container path; traversal/absolute/doubled/backslash/NUL rejection; sibling-prefix rejection; deepest-volume selection; no volumes -> error."

- path: app/packages/shared/src/folderUpload/types.ts
  purpose: Folder-upload IPC and state types.
  exports: "FolderUploadPhase, MAX_OVERWRITE_SAMPLES=20, OverwriteConflict, OverwriteSummary, FolderUploadProgress, FolderScanNode, FolderScanResult, FolderUploadSelection, FolderUploadLastRun, PlannedFile, FolderUploadRequest, FolderUploadStoredState, FolderUploadStartResult, StrayHelperStopped, StrayHelperReport, FolderOverwriteDecision, FolderOverwriteDecisionResult"
  dependencies: none
  data_shapes: "progress snapshot roughly every 500 ms; the scan is addressed by scanId so file contents never reach the renderer"
  side_effects: none
  role: shared types
  observations: "FolderUploadSelection (types.ts:77-84) and FolderUploadRequest (lines 101-108) differ only in localPath vs scanId."
```

## app/packages/shared/src/secrets

```yaml
- path: app/packages/shared/src/secrets/secretsStore.ts
  purpose: Module-level Secrets Manager helpers for Discord secrets and app-owned health-check credentials.
  exports: "SECRET_PLACEHOLDER='placeholder', __resetSecretsClient, getBotToken, getPublicKey, putBotToken, putPublicKey, invalidateSecretsCache, healthCheckAuthSecretName(gameId) => `hyveon-${gameId}-healthcheck-auth`, upsertHealthCheckAuthSecret, deleteHealthCheckAuthSecret"
  dependencies: "@aws-sdk/client-secrets-manager (Get/Put/Create/Delete/Restore/DescribeSecret, ResourceNotFoundException, InvalidRequestException)"
  data_shapes: secret strings; basic creds are JSON {username,password}
  side_effects: "Secrets Manager calls; module-level client and 5-min in-process cache; reads process.env region chain"
  role: AWS data-access helper (Lambdas + desktop-main GamesWriteService)
  observations: "getBotToken and getPublicKey have identical bodies (secretsStore.ts:63-76). getBotToken, putBotToken, putPublicKey and invalidateSecretsCache have no consumer outside shared (git grep); desktop-main uses cloud-aws AwsSecretsStore instead, which duplicates this cache logic. upsertHealthCheckAuthSecret: Put first, Restore+retry on pending deletion (detected via DescribeSecret DeletedDate), Create on not-found (lines 144-172). Delete uses the default recovery window, with no force (lines 184-194). The upsert doesn't populate the read cache. getSecret doesn't catch ResourceNotFoundException, so getPublicKey can throw for a missing secret (lines 46-54)."

- path: app/packages/shared/src/secrets/secretsStore.test.ts
  purpose: Tests secretsStore.
  role: test
  observations: "Pins: placeholder/empty -> null; per-ARN 5-min cache; invalidation after put and invalidateSecretsCache; deterministic name; upsert Put->Create fallback; Restore-then-retry on pending deletion; non-pending InvalidRequest is rethrown; delete without ForceDeleteWithoutRecovery; missing secret is a no-op on delete; other errors are rethrown."
```

## app/packages/cloud-aws

```yaml
- path: app/packages/cloud-aws/package.json
  purpose: Manifest for @hyveon/cloud-aws.
  exports: "'.' only"
  dependencies: "@aws-sdk/client-cloudwatch-logs, client-dynamodb, client-ec2, client-ecs, client-s3, client-secrets-manager, lib-dynamodb, s3-request-presigner, @hyveon/shared"
  data_shapes: n/a
  side_effects: none
  role: config
  observations: none

- path: app/packages/cloud-aws/tsconfig.json
  purpose: tsc config with a project reference to ../shared.
  exports: n/a
  dependencies: tsconfig.base.json, shared
  data_shapes: n/a
  side_effects: none
  role: config
  observations: "Excludes *.test.ts."
```

## app/packages/cloud-aws/src

```yaml
- path: app/packages/cloud-aws/src/index.ts
  purpose: Barrel.
  exports: "AwsAuditLogStore, AwsCloudProvider (+WorkloadGuardError, WorkloadLaunchError, AwsCloudProviderConfig, AwsCloudProviderLogger, FARGATE_* re-exports), AwsDiscordConfigStore, AwsDiscordEventReceiver, AwsRemoteFileStore, AwsRunRecordStore, AwsSecretsStore"
  dependencies: siblings
  data_shapes: n/a
  side_effects: none
  role: barrel
  observations: "awsRegionEnv and cachedClient are not exported (internal)."

- path: app/packages/cloud-aws/src/index.test.ts
  purpose: Barrel smoke test.
  role: test
  observations: "Pins: AwsCloudProvider, AwsDiscordEventReceiver, AwsRemoteFileStore and AwsSecretsStore are constructible; the no-config paths reject/resolve. The header doc talks about 'stub methods ... throw synchronously' (index.test.ts:15-18), stale wording since every class is now a real implementation. It doesn't cover AwsAuditLogStore, AwsRunRecordStore or AwsDiscordConfigStore."

- path: app/packages/cloud-aws/src/awsRegionEnv.ts
  purpose: Env accessor for the default AWS region chain.
  exports: "resolveDefaultAwsRegion()"
  dependencies: none
  data_shapes: string
  side_effects: reads process.env
  role: env wrapper
  observations: "Trims each value, and uses || so an empty/whitespace value falls through (awsRegionEnv.ts:16-21). AwsSecretsStore and AwsRemoteFileStore do NOT use it; they reimplement the chain inline with ?? and no trim (AwsSecretsStore.ts:72-77, AwsRemoteFileStore.ts:86-91). That inconsistency is what the 'no raw process.env in business logic' rule targets."

- path: app/packages/cloud-aws/src/cachedClient.ts
  purpose: A memoised AWS client keyed by region + credentialsSignature.
  exports: "CachedAwsClientConfig, createCachedAwsClient(factory)"
  dependencies: none
  data_shapes: "cache key `${region}::${credentialsSignature ?? ''}`"
  side_effects: none (in-closure cache)
  role: utility
  observations: "Says it preserves the semantics 'documented on AwsAuditLogStore.getClient', while AwsAuditLogStore.getClient says it 'mirrors AwsSecretsStore.getClient' and AwsSecretsStore.getClient says it 'mirrors AwsCloudProvider.getEcsClient'. The cross-references are circular (cachedClient.ts:16-18; AwsAuditLogStore.ts:77; AwsSecretsStore.ts:68)."

- path: app/packages/cloud-aws/src/AwsAuditLogStore.ts
  purpose: DynamoDB-backed AuditLogStore.
  exports: "class AwsAuditLogStore"
  dependencies: "@aws-sdk/client-dynamodb, lib-dynamodb Put/QueryCommand; awsRegionEnv; cachedClient"
  data_shapes: "item {pk:'AUDIT', sk, timestamp, actor, action, game, before/after as JSON strings or null, versionId?}"
  side_effects: DynamoDB PutItem and Query
  role: provider implementation
  observations: "Calls getConfig() twice per operation, once in getClient and once in getTableName (AwsAuditLogStore.ts:65, 83, 100-102). The constructor doc claims to be 'the canonical statement' of the resolve-per-call pattern (lines 30-32). before/after are serialised to JSON strings (lines 110-111). nextBefore is the last entry's sk when LastEvaluatedKey is set (line 160). The getConfig type literal is written out twice (lines 44-55)."

- path: app/packages/cloud-aws/src/AwsAuditLogStore.test.ts
  purpose: Tests AwsAuditLogStore.
  role: test
  observations: "Pins: pk AUDIT; JSON-string before/after; null stays null (not the string 'null'); versionId when present; newest-first Query with Limit; `sk < :before` cursor; nextBefore; credentials are passed to the client."

- path: app/packages/cloud-aws/src/AwsCloudProvider.ts
  purpose: AWS CloudProvider covering ECS start/stop/status, a CloudWatch log poll stream, and a Fargate cost estimate.
  exports: "re-export FARGATE_VCPU_PER_HOUR/FARGATE_GB_PER_HOUR, class WorkloadGuardError, class WorkloadLaunchError, interface AwsCloudProviderConfig, interface AwsCloudProviderLogger, class AwsCloudProvider"
  dependencies: "@aws-sdk/client-ecs (List/DescribeTasks, DescribeTaskDefinition, RunTask, StopTask), client-ec2 DescribeNetworkInterfaces, client-cloudwatch-logs FilterLogEvents; shared getTaskEniId, resolveEniPublicIp, pricing; cachedClient"
  data_shapes: "config {region, credentials?, credentialsSignature?, ecsClusterName, subnetIds (csv string), securityGroupId, domainName?, gameNames?}; WorkloadStatus; LogChunk; CostBreakdown"
  side_effects: "ECS RunTask (FARGATE, assignPublicIp ENABLED, propagateTags TASK_DEFINITION) and StopTask; ECS/EC2/CloudWatch reads; timers"
  role: provider implementation (backs EcsService/CostService)
  observations: "There is a per-game in-process promise-chain lock (withGameLock, AwsCloudProvider.ts:328-336). That lock, not ListTasks (which is eventually consistent), is what prevents duplicate starts (lines 344-347); it doesn't protect across processes. estimateHourlyCost (lines 312-317) duplicates shared estimateFargateHourlyCost (gameServerValidator.ts:426-431) instead of calling it. sleepInterruptible duplicates LogsService's helper (lines 35-57). The DescribeTaskDefinition fallback is 2048/8192 (lines 297-302). getCostEstimate awaits each game sequentially (lines 611-619). The log poll doc mentions an 'SSE client's expected cadence' (line 536), which is stale. The log group is `/ecs/{game}-server` (line 557). The `seen` dedupe Set grows without bound for the lifetime of the stream (line 559). Message strings are a UI contract (lines 404-405). getWorkloadStatus wraps getConfig inside its try so one game's failure returns 'error' (lines 494-500, 525-527). Operator messages reference 'Run Apply on the IaC page first' (lines 414, 506)."

- path: app/packages/cloud-aws/src/AwsCloudProvider.test.ts
  purpose: Tests AwsCloudProvider.
  role: test
  observations: "Pins: guard errors for no config / already running / not running; RunTask parameters (trimmed subnets, SG); a failures reason or 'unknown'; original Error and non-Error throws are rethrown unchanged; status transitions not_deployed/running(+IP,hostname)/starting/stopped/error, including when getConfig throws or rejects; log stream abort, dedupe by eventId, `/ecs/{game}-server`, an error sentinel that continues, a 2000ms default; cost zeroing, fallbacks, logger use and rounding; no getActualCosts method; credentials and signature-driven client rebuild; the pricing re-export equals shared."

- path: app/packages/cloud-aws/src/AwsDiscordConfigStore.ts
  purpose: DiscordConfigStore wrapping the shared ddb/configStore functions with a credentialed client.
  exports: "interface AwsDiscordConfigStoreConfig, class AwsDiscordConfigStore"
  dependencies: "@aws-sdk/client-dynamodb, lib-dynamodb; shared getDiscordConfig/getBaseDiscordConfig/putDiscordConfig; awsRegionEnv; cachedClient"
  data_shapes: DiscordConfig, BaseDiscordConfig
  side_effects: DynamoDB via shared helpers
  role: provider implementation
  observations: "The doc records a real bug fix: the default credential chain in GUI Electron threw a spurious CredentialsProviderError (AwsDiscordConfigStore.ts:72-80). resolveConfig is called twice per operation (lines 59, 82). It does not expose getEffectiveDiscordConfig."

- path: app/packages/cloud-aws/src/AwsDiscordConfigStore.test.ts
  purpose: Tests AwsDiscordConfigStore.
  role: test
  observations: "Pins: CONFIG#discord/BASE#discord read with empty defaults; put writes CONFIG#discord; a clear 'table not configured' error; region and credentials are passed through."

- path: app/packages/cloud-aws/src/AwsDiscordEventReceiver.ts
  purpose: DiscordEventReceiver reading interactionsInvokeUrl from a per-call config callback.
  exports: "interface AwsDiscordEventReceiverConfig, class AwsDiscordEventReceiver"
  dependencies: type DiscordEventReceiver
  data_shapes: "{interactionsInvokeUrl}"
  side_effects: none
  role: provider implementation
  observations: "getConfig is synchronous-only, unlike the other stores, which accept a Promise (AwsDiscordEventReceiver.ts:33). It overlaps with shared's AwsLambdaDiscordReceiver, which uses a different URL field."

- path: app/packages/cloud-aws/src/AwsDiscordEventReceiver.test.ts
  purpose: Tests AwsDiscordEventReceiver.
  role: test
  observations: "Pins: returns the url; null for no callback, a null config, or an undefined url; re-reads the config on every call."

- path: app/packages/cloud-aws/src/AwsRemoteFileStore.ts
  purpose: Versioned-S3 RemoteFileStore with If-Match optimistic concurrency.
  exports: "class AwsRemoteFileStore"
  dependencies: "@aws-sdk/client-s3 Get/PutObject, ListObjectVersions, NoSuchKey, S3ServiceException; shared RemoteFileConflictError; cachedClient"
  data_shapes: "{body: Uint8Array, etag (unquoted)}; versions [{versionId, lastModified}] newest-first"
  side_effects: S3 Get/Put/ListObjectVersions
  role: provider implementation (config bucket)
  observations: "HTTP 409 and 412 both map to RemoteFileConflictError (AwsRemoteFileStore.ts:21, 164-169). ETags are unquoted (lines 29-31). listVersions paginates on IsTruncated, and Prefix=path means sibling keys sharing the prefix are fetched and then filtered out (lines 178-216; issue #260 cited). getConfig is synchronous-only (line 55) while the Dynamo stores accept a Promise. The inline region chain doesn't use resolveDefaultAwsRegion (lines 86-91). get() returns undefined when the response has no ETag (line 106)."

- path: app/packages/cloud-aws/src/AwsRemoteFileStore.test.ts
  purpose: Tests AwsRemoteFileStore.
  role: test
  observations: "Pins: unquoted etag; NoSuchKey or 404 -> undefined, other errors rethrown; no Body or no ETag -> undefined; IfMatch is passed through; versionId; a missing ETag on put throws; 412/409 -> RemoteFileConflictError; listVersions filter/sort/pagination across pages; bucket-not-configured errors; region fallback chain AWS_REGION_ -> AWS_REGION -> AWS_DEFAULT_REGION -> us-east-1; region-change rebuild; credentials."

- path: app/packages/cloud-aws/src/AwsRunRecordStore.ts
  purpose: DynamoDB run history plus S3 log offload, presigned URLs, and the durable apply lock item.
  exports: "class AwsRunRecordStore"
  dependencies: "@aws-sdk/client-dynamodb (ConditionalCheckFailedException), lib-dynamodb Put/Get/Query/Delete, client-s3, s3-request-presigner getSignedUrl; shared RunLockHeldError; awsRegionEnv; cachedClient"
  data_shapes: "RUN items {pk:'RUN', sk:`<startedAt>#<runId>`, ...}; LOCK item {pk:'LOCK', sk:'CURRENT', runId, kind, initiator, acquiredAt, expiresAt}; S3 key runs/<runId>.log; GSI 'status-index' (status, startedAt)"
  side_effects: "DynamoDB Put/Get/Query/conditional Put and Delete; S3 PutObject; presign GetObject (default 3600s)"
  role: provider implementation
  observations: "putRecord does NOT write `partialApply` and toRunRecord does NOT read it back (AwsRunRecordStore.ts:189-207, 336-374). shared RunRecord.partialApply (runs.ts:161) and RunRecordService.writePreflightMarker both rely on partialApply:true persisting, and PulumiService.ts:2037 checks `record.partialApply === true`. The value appears to be silently dropped on the DynamoDB round-trip; no test covers it. listRuns uses `KeyConditionExpression: 'status = :status'` without ExpressionAttributeNames (line 302). STATUS appears to be a DynamoDB reserved word, which would make the real request fail validation; tests only assert the expression string against a mocked client (AwsRunRecordStore.test.ts:544-552). getRecordByRunId uses a FilterExpression over the whole RUN partition with no Limit, paging until it finds a match (lines 232-252). The acquire condition is `attribute_not_exists(pk) OR expiresAt < :now`, an ISO string comparison (line 436). Release is conditional on runId, and ConditionalCheckFailed is swallowed (lines 485-501). The DynamoDB client factory's credentials type is borrowed from S3ClientConfig (line 87). getConfig is called up to 2-3 times per operation."

- path: app/packages/cloud-aws/src/AwsRunRecordStore.test.ts
  purpose: Tests AwsRunRecordStore.
  role: test
  observations: "Pins: pk RUN with optional fields included/omitted (configVersionId, logInline/logS3Key, planHash, approvedBy/At, rolledBackFrom, changeSummary). No case covers engineVersion or partialApply on write. Also pins: getRecordByRunId newest-first, paging, exhaustion, and optional-field restore; putLog key runs/<id>.log; presigned URL with custom expiry; lock acquire when absent/expired, held -> RunLockHeldError with the current holder, other errors rethrown; getRunLock parse; listRuns pk/cursor/nextBefore, plus status-index with ExclusiveStartKey rebuilt from the sk cursor; release scoped by runId with a no-op on mismatch; credentials for both clients."

- path: app/packages/cloud-aws/src/AwsSecretsStore.ts
  purpose: Secrets Manager SecretsStore with a 5-min cache and placeholder handling.
  exports: "class AwsSecretsStore"
  dependencies: "@aws-sdk/client-secrets-manager Get/PutSecretValue, ResourceNotFoundException; shared SECRET_PLACEHOLDER; cachedClient"
  data_shapes: string values
  side_effects: "Secrets Manager Get/Put; in-instance cache; reads process.env"
  role: provider implementation
  observations: "Duplicates shared secretsStore's cache/TTL/placeholder logic (AwsSecretsStore.ts:11-19, 97-116 vs shared secretsStore.ts:38-54). Its constructor takes three separate callbacks (getRegion, getCredentials, getCredentialsSignature) instead of one getConfig like its siblings (lines 59-63). Raw process.env region chain (lines 72-77). get() treats ResourceNotFound, empty and placeholder as undefined (lines 106-112). put trims the value (line 129)."

- path: app/packages/cloud-aws/src/AwsSecretsStore.test.ts
  purpose: Tests AwsSecretsStore.
  role: test
  observations: "Pins: trimmed value; not-found/empty/undefined/placeholder -> undefined; other errors rethrown; 5-min cache and TTL expiry; per-name isolation; put trims and invalidates; exists is defined via get; region callback re-read per call; credentials."
```

## app/packages/desktop-preload

```yaml
- path: app/packages/desktop-preload/package.json
  purpose: Manifest for @hyveon/desktop-preload.
  exports: "'.', './preload', './test-mock-registry'"
  dependencies: "@hyveon/shared; dev electron ^43.2.0"
  data_shapes: n/a
  side_effects: none
  role: config
  observations: "There is no './hyveon-api' export, yet hyveon-api.ts's own usage example imports '@hyveon/desktop-preload/hyveon-api' (hyveon-api.ts:2506)."

- path: app/packages/desktop-preload/tsconfig.json
  purpose: tsc -b config (Node16 module resolution) referencing shared.
  exports: n/a
  dependencies: tsconfig.base.json, shared
  data_shapes: n/a
  side_effects: none
  role: config
  observations: "Does NOT exclude *.test.ts (tsconfig.json:10), unlike shared and cloud-aws, so preload.test.ts and test-mock-registry.test.ts compile into dist."
```

## app/packages/desktop-preload/src

```yaml
- path: app/packages/desktop-preload/src/index.ts
  purpose: Package entry; re-exports a subset of hyveon-api types and augments Window.
  exports: "types HyveonApi, HyveonTestApi, HyveonMockNamespaces, HyveonStreamHandle, LogChunk, HyveonLambdaLogsApi, LambdaLogs, LogEventLine, Older/NewerLogsPage, IacRun*, StackInit*, RunDetailStatus, IacRunsGetResult, IacRunsListOpts, RunHistory*, Iac*Ack/Payload types, RunLock, ChangeSummary, OpType, AwsProfileSummary, IamCheckResult, IamCheckOrigin, WizardState, SaveWizardStateInput, WizardStepName, GuidedIamSubState, WizardProgress, SaveWizardProgressInput, Renderer*, CloudHealth*, OpenConsoleResult; value GUIDED_PROFILE_NAME"
  dependencies: hyveon-api.ts
  data_shapes: n/a
  side_effects: "global `Window.hyveon?: HyveonApi` augmentation"
  role: barrel / type entry
  observations: "Many hyveon-api types are not re-exported (GameStatus, GameListEntry, GameServer, Discord*, Audit*, Drift*, FileMgr*), so consumers presumably deep-import or redeclare them."

- path: app/packages/desktop-preload/src/hyveon-api.ts
  purpose: The full typed contract of `window.hyveon`, covering every namespace and its IPC payload/result shapes.
  exports: "re-exported shared types (AutoUpdate*, ChangeSummary, DeploymentConfigDiff, DeploymentSettings*, ExportDiagnosticsBundleResult, GameServerHealthCheckAuth, LambdaFunctionKey, ManualUpdateCheckResult, UpdateDownload*, UpdateInstallResult, OpType, PulumiEngineVersionResult, Renderer*, RunLock, TopLevelDeploymentSettings, UpdateDeploymentSettingsPayload); locally declared mirrors: GameStatus, StartResult, GameEstimate, CostEstimates, LogEventLine, GameLogs, LogChunk=string, HyveonStreamHandle, FileMgr*, Discord*, EnvInfo, GameServerPort/EnvironmentVariable/Volume/FileSeed/HealthCheck*/GameServer/RedactedGameServer/GameServerWriteConfig/GameListEntry/GameServerValidationIssue, GameWrite*, Create/Update/DeleteGamePayload, GameWizardDraft, StoredGameWizardDraft, Drift*, AuditAction/Entry/PageResult, IacRunChunk, StackInitPhase*, IacRunKind, IacRunRecord, RunDetailStatus, IacRunsGetResult, RunHistoryStatus/Record/PageResult, IacRunsListOpts, IacPlanPayload, IacStaleLock*, IacPlanAck, IacRollback*Ack, IacLockClear*, IacApplyPayload, IacDestroy*, IacRunsLock*, IacApproveAck, CloudHealth*, wizard input/result types, GUIDED_PROFILE_NAME='hyveon-guided', WizardAwsChoice, WizardBootstrapNames, WizardState, SaveWizardStateInput; namespace interfaces Hyveon{CloudHealth,Games,Costs,Logs,LambdaLogs,Files,FolderUpload,Discord,Env,Wizard,Drift,Diagnostics,Audit,IacRuns,IacStack,Iac,IacLock,IacRollback,IacSettings,Window}Api, HyveonMockNamespaces, HyveonTestApi, HyveonApi"
  dependencies: "types from @hyveon/shared and @hyveon/shared/folderUpload"
  data_shapes: "the whole IPC surface (channels listed under preload.ts)"
  side_effects: none (types + one constant)
  role: IPC contract types
  observations: "There are about 40 hand-mirrored types with 'Mirrors X — keep this copy in sync' comments (e.g. hyveon-api.ts:299-302, 430-432). .claude/rules/duplication.md calls that wording the bug report. Several have already drifted from @hyveon/shared: GameServerPort lacks `visibility` (304-307 vs shared gameServerConfig.ts:50); GameServer lacks `webPort` and `command` (433-447 vs shared 243, 254); GameWizardDraft has no webPort/command fields (665-694); DiscordGamePermission.actions is string[] rather than DiscordAction[] (238); RedactedDiscordConfig adds interactionsEndpointUrl, which shared lacks (256). LogChunk here is `string` while shared's LogChunk is {message,timestamp} (149). The HyveonIacRunsApi.streamLogs doc references `HyveonIacApi.init`, which no longer exists (2074). The HyveonApi.costs doc mentions 'historical CE data' (2515) and contradicts the no-Cost-Explorer docs (1428). IacPlanAck's doc mentions `RunService`/`RunLockService` (1101), and RunLockService may not exist. Lingering 'tfstate' wording (479, 493, 712, 2004, 2529). The IacPlanAck/plan doc states that nothing listens on iac.plan.chunk/end, iac.apply.end or iac.destroy.end (1091-1094, 2195-2200). The iac.output doc says it has no web call site (2250-2253). The rollback-confirm doc notes that rollback-action.component.tsx doesn't read versionId on failure, as an open TODO (1159-1160). WizardStepName duplicates shared WIZARD_STEPS (1705). The usage example imports a nonexistent subpath (2506)."

- path: app/packages/desktop-preload/src/preload.ts
  purpose: Electron preload that builds the window.hyveon bridge via contextBridge, a mock-aware invoke, and five buffered streams.
  exports: "isTestModeEnabled(); side effect contextBridge.exposeInMainWorld('hyveon', bridge)"
  dependencies: "electron contextBridge/ipcRenderer; stream-bridge.createBufferedStream; hyveon-api types; shared StackOutputs; shared/folderUpload types"
  data_shapes: "IPC channels: games.{list,status,getStatus,start,stop,create,update,delete,draft.get,draft.save,draft.updateStepIndex,draft.clear}; costs.estimate; cloudHealth.{list,fix,downloadPolicy,openPolicyConsole}; logs.{get,stream(+.<id>.chunk/.end/.cancel),getOlder,getNewer}; logs.lambda.{get,stream(+.<id>.*),getOlder,getNewer}; files.{list,start,stop}; folderUpload.{pickFolder,rescanSelection,getSelection,setSelection,clearSelection,startUpload,cancelUpload,confirmOverwrite,getProgress,cleanupStrayHelpers} + push 'folderUpload.progress'; discord.{getConfig,putConfig,listGuilds,addGuild,removeGuild,registerCommands,getAdmins,putAdmins,getPermissions,putPermission,deletePermission}; env.get; wizard.{aws.listProfiles,aws.saveCredentials,state.get,state.save,bootstrap.stateBucket,bootstrap.configurationBucket,bootstrap.deploymentConfig,bootstrap.runsTable,iam.simulate,progress.get,progress.save,complete,reset,guidedIam.prepareTemplate,guidedIam.openConsole,guidedIam.submitBootstrapKey,guidedIam.rotate,guidedIam.revokeBootstrapKey}; drift.get; diagnostics.{tail,path,reportError,reportLog,exportBundle,showInFolder}; audit.list; iac.{stack.initialize(+.chunk/.end),plan,approve,apply,destroy.mintToken,destroy,output,runs.get,runs.logs(+.chunk/.end),runs.list,runs.logUrl,runs.lock.clear.mintToken,runs.lock.clear,rollback.resolve,rollback.confirm,lock.clear.mintToken,lock.clear,settings.get,settings.update,settings.engineVersion,settings.autoUpdate.{get,update,check,download(+.chunk/.end),install}}; window.{minimize,toggleMaximize,close,isMaximized} + push 'window.maximizedChange'"
  side_effects: "IPC invoke/send/on; contextBridge exposure; reads process.env HYVEON_TEST_MODE once at load; reads process.platform"
  role: Electron preload / IPC bridge
  observations: "__test (mock/clearMocks/reset) is exposed only when HYVEON_TEST_MODE=1 (preload.ts:604-629), but the mockRegistry is consulted by every invoke regardless of mode; it is just unreachable without __test (lines 181-191). The module doc says createBufferedStream is 'called five times' (line 45) while stream-bridge.ts says 'four times' (stream-bridge.ts:7-10). bridgeStream's doc says 'none of the three generators' (line 334) and openBufferedStream's doc lists four sources (line 354); there are five. Payload shape is inconsistent across the discord namespace: addGuild sends {guildId} but removeGuild/registerCommands/deletePermission send bare strings (lines 474-485). The transport limitation is that only the first argument reaches @Payload (lines 397-399). iac.runs.logUrl unwraps {url} (line 554). streamUpdateDownload's ack check doesn't validate `started`, unlike stack init (lines 290 vs 256-259)."

- path: app/packages/desktop-preload/src/preload.test.ts
  purpose: Unit tests for the preload dispatcher (2718 lines).
  role: test
  observations: "Mocks electron and re-imports the module per HYVEON_TEST_MODE value; the header says it does this by setting the env (preload.test.ts:15-18), though isTestModeEnabled exists for spying. Pins: real-IPC fallthrough for games/env/drift/audit/draft and single-object payloads; folderUpload channel mapping and progress subscribe/unsubscribe; window namespace; mock-override semantics (args, plain values, rejection propagation, latest mock wins); __test gating; clearMocks/reset; per-call streams (logs, lambda logs): mocked delegation with an internal AbortSignal, chunk yield, end error throws, cancel->ack; shared-channel streams (stack init, run logs): listeners attached before invoke, foreign streamId ignored, `started:false` throws after cleanup, cancel before or during the stream; iac.plan/approve/apply/rollback/settings/destroy/output/runs.*/runs.lock.*; diagnostics.*. Not covered in titles: autoUpdate download stream, discord, wizard, cloudHealth, files, costs, logs.get/getOlder/getNewer, iac.lock.*."

- path: app/packages/desktop-preload/src/stream-bridge.ts
  purpose: Generic buffered IPC-to-AsyncGenerator machinery with per-call and shared-side-channel styles.
  exports: "BufferedStreamConfig<TArg,TWire,TOut>, BufferedStreamDeps, createBufferedStream(config, deps)"
  dependencies: electron ipcRenderer
  data_shapes: "end payload {streamId?, error?}"
  side_effects: "ipcRenderer.on/once/removeListener/send"
  role: IPC streaming utility
  observations: "Shared style: listeners attach BEFORE invoke, and pre-ack events are buffered raw and replayed with a streamId filter (stream-bridge.ts:165-186). Abort only stops the local drain and sends no cancel to main (lines 24-26, 160-163). Per-call style: listeners attach after the ack, so a chunk emitted between the main process's ack and listener attachment could appear to be lost (lines 212-230). An `!ended` finally sends cancel (line 255). An end error rethrows as `new Error(endError)` (lines 195, 242). Throws at factory time if a shared style is missing getStreamId (lines 98-100). The 'four times' count is stale (line 7-10)."

- path: app/packages/desktop-preload/src/test-mock-registry.ts
  purpose: Test-only namespace-level mock registry for window.hyveon (jsdom).
  exports: "HyveonNamespace, HyveonNamespaceMap, HyveonPartialNamespaceMap, register, lookup, clear, buildMockHyveon"
  dependencies: type HyveonApi
  data_shapes: partial namespace map
  side_effects: module-level mutable registry
  role: test utility
  observations: "The doc says it is consumed by the @hyveon/web test suite (test-mock-registry.ts:9-11), but git grep finds no import of 'test-mock-registry' anywhere outside this package, so it appears unused. buildMockHyveon's doc says it is 'not exported from the package root — import it directly from the test-mock-registry export path' (lines 95-96), which is consistent with package.json. It is a separate mechanism from preload's per-channel mockRegistry."

- path: app/packages/desktop-preload/src/test-mock-registry.test.ts
  purpose: Tests test-mock-registry.
  role: test
  observations: "Pins: register/lookup/overwrite/multiple namespaces; clear empties the registry and is idempotent; buildMockHyveon returns only registered namespaces and is empty after clear."
```

## Observed behaviours

- `canRun` evaluates in a fixed order: guild allowlist deny, then admin user/role allow-all, then the per-game entry (the action must be listed and the user or a role must match), otherwise deny. — app/packages/shared/src/canRun.ts:29-37
- The effective Discord config is the union of the BASE#discord and CONFIG#discord guild/admin lists. gamePermissions and clientId come only from the dynamic row. — app/packages/shared/src/ddb/configStore.ts:105-122
- Discord config reads use `ConsistentRead: true` and sanitise malformed items instead of throwing; prototype-pollution game keys are dropped. — app/packages/shared/src/ddb/configStore.ts:28-45, 86-95, 133-142
- A missing CONFIG/BASE row yields an empty config, so a fresh deploy still boots. — app/packages/shared/src/ddb/configStore.ts:93, 140
- Pending interactions live at `PENDING#<taskArn>` with a 15-minute TTL (epoch seconds). An expired row is treated as absent and deleted fire-and-forget. — app/packages/shared/src/ddb/pendingStore.ts:6, 13-30, 53-58
- `patchInteractionOriginal` PATCHes `discord.com/api/v10/webhooks/{app}/{token}/messages/@original` using only the interaction token, with no bot token. Non-OK responses are only logged. — app/packages/shared/src/discord/patchOriginal.ts:17-31
- Slash commands server-status and server-list both consume the `status` permission bucket. — app/packages/shared/src/commands.ts:10-20
- Secrets equal to the literal `placeholder` (as seeded by infra) are treated as unset by both secret readers. — app/packages/shared/src/secrets/secretsStore.ts:21, 66; app/packages/cloud-aws/src/AwsSecretsStore.ts:112
- Secret reads are cached in-process for 5 minutes and invalidated on write. — app/packages/shared/src/secrets/secretsStore.ts:43-60; app/packages/cloud-aws/src/AwsSecretsStore.ts:13, 97-132
- The app-owned health-check secret is named `hyveon-{gameId}-healthcheck-auth`. Upsert tries Put, then Restore+retry when the secret is pending deletion, then Create when not found. Delete keeps the default recovery window. — app/packages/shared/src/secrets/secretsStore.ts:94-96, 144-194
- Every Lambda-side DynamoDB/Secrets client resolves its region as `AWS_REGION_`, then `AWS_REGION`, then `AWS_DEFAULT_REGION`, then us-east-1. — app/packages/shared/src/ddb/client.ts:15-16; app/packages/shared/src/secrets/secretsStore.ts:26-27
- A malformed JSON env var falls back to its default (with a warning) instead of failing Lambda init; the parser enforces array-vs-object shape. — app/packages/shared/src/envJson.ts:22-38
- The task family to game lookup is built as `{game}-server` with a null prototype. — app/packages/shared/src/env.ts:64-66
- Game names must match `^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$`, enforced only when a name is created. — app/packages/shared/src/gameServerValidator.ts:37-51
- Fargate cpu/memory pairs are validated against a hard-coded tier table. — app/packages/shared/src/gameServerValidator.ts:358-368, 446-472
- Across the whole deployment, once any game is https, 443/tcp and 80/tcp are reserved for every game, checked in both edit orders. — app/packages/shared/src/gameServerValidator.ts:894-936
- A tcp extra port equal to another game's webPort is rejected (in both directions) because the shared security group would expose that game's Caddy upstream. — app/packages/shared/src/gameServerValidator.ts:838-869; re-checked on raw reads by app/packages/shared/src/gameServerPorts.ts:118-136
- The same icmp entry may appear on several games only if its effective visibility matches; an omitted visibility counts as public. — app/packages/shared/src/gameServerValidator.ts:621-623, 671-681
- An https game must declare webPort (1-65535, not 80/443); a non-https game must not declare one. — app/packages/shared/src/gameServerValidator.ts:704-734
- Using `${hyveon.network.public-ipv4}` in env requires a non-empty `command` and shell-identifier env names. Unknown `${hyveon.*}` tokens are rejected. — app/packages/shared/src/gameServerValidator.ts:548-583
- Health-check headers named Authorization, or with credential-looking values, are rejected. Credentials must go through `auth.secretArn`. — app/packages/shared/src/gameServerValidator.ts:111, 253-269
- Port and https rules run even when the structural schema fails, so wizard drafts get feedback. — app/packages/shared/src/gameServerValidator.ts:1078-1098
- Legacy https games (no webPort) have ports[0] (tcp) promoted to webPort at read time; the function is idempotent and returns the same reference when nothing changes. — app/packages/shared/src/gameServerPorts.ts:54-66, 77-91
- The webPort tcp duplicate is excluded from security-group ingress. — app/packages/shared/src/gameServerPorts.ts:101-107
- `redactGameServer` replaces `healthCheck.auth` with `secretSet` and `authType` before the game crosses IPC. — app/packages/shared/src/gameServerConfig.ts:373-383
- Connect messages for https games render `{host}:{port}` as `https://{host}` and a bare `{port}` as 443. The connect message is shown only while the game is running. — app/packages/shared/src/formatStatus.ts:16-31, 52-55
- Deployment settings validate as a PATCH: only present fields are checked, and type is checked before value. — app/packages/shared/src/deploymentSettingsWrite.ts:49-79
- The deployment config is stored under the fixed S3 key `deployment-config.json`. — app/packages/shared/src/deploymentConfig.ts:35
- The runs-table name is the override if non-empty, otherwise `${projectName}-runs`. The pre-apply fallback reads the config object directly and never throws. — app/packages/shared/src/deploymentConfig.ts:259-296
- The rollback diff compares game entries key-order-insensitively, so read-time normalisation isn't reported as a change. — app/packages/shared/src/deploymentConfig.ts:413-434
- Run status is derived from the exit code: 0 is success, null is aborted, anything else is failed. — app/packages/shared/src/runs.ts:205-210
- Lock expiry and approval expiry (15-minute window) are inclusive at the boundary instant. — app/packages/shared/src/runs.ts:250-278
- The run detail reports `awaiting_approval` only for a successful plan whose artifact still exists; an in-flight run always reports `running`. — app/packages/shared/src/runs.ts:332-346
- Audit sort key is `<ISO>#<ULID>`; run sort key is `<startedAt>#<runId>`. — app/packages/shared/src/audit.ts:78-80; app/packages/shared/src/runs.ts:190-192
- `AwsCloudProvider` serialises start/stop per game with an in-process promise chain. The ListTasks guard alone is eventually consistent. — app/packages/cloud-aws/src/AwsCloudProvider.ts:215, 328-336, 344-347
- RunTask always uses FARGATE, `assignPublicIp: ENABLED`, `propagateTags: TASK_DEFINITION` and the `{game}-server` family. A response with zero tasks becomes a WorkloadLaunchError carrying the failure reason. — app/packages/cloud-aws/src/AwsCloudProvider.ts:432-449
- StopTask is sent with reason 'Stopped via management app'. DNS cleanup is left to the update-dns Lambda. — app/packages/cloud-aws/src/AwsCloudProvider.ts:456-483
- Workload status is `running` (with public IP and `{game}.{domain}`) only when lastStatus is RUNNING. Any other non-stopped task reports `starting`. Every error, including a getConfig failure, reports `error` rather than rejecting. — app/packages/cloud-aws/src/AwsCloudProvider.ts:503-528
- Game log streaming polls FilterLogEvents on `/ecs/{game}-server` every 2s, dedupes by eventId, and yields a `[stream error]` sentinel on failure instead of terminating. — app/packages/cloud-aws/src/AwsCloudProvider.ts:548-589
- The cost estimate uses each game's task-definition cpu/memory (falling back to 2048/8192) and makes no Cost Explorer calls. — app/packages/cloud-aws/src/AwsCloudProvider.ts:285-304, 603-623
- AWS clients are rebuilt only when region or credentialsSignature changes. — app/packages/cloud-aws/src/cachedClient.ts:35-49
- S3 412/409 responses on a conditional put become `RemoteFileConflictError`. ETags are returned unquoted. — app/packages/cloud-aws/src/AwsRemoteFileStore.ts:21-31, 159-171
- listVersions paginates through every ListObjectVersions page, filters to the exact key, and sorts newest-first. — app/packages/cloud-aws/src/AwsRemoteFileStore.ts:188-217
- The durable apply lock is the single item `pk=LOCK, sk=CURRENT`. Acquire is a conditional put (absent or expired); a lost race re-reads and throws RunLockHeldError. Release is conditional on runId and no-ops on mismatch. — app/packages/cloud-aws/src/AwsRunRecordStore.ts:40-41, 422-501
- Run logs offload to S3 at `runs/<runId>.log`, with presigned GET URLs valid for 3600s by default. — app/packages/cloud-aws/src/AwsRunRecordStore.ts:47, 57-59, 384-407
- Status-filtered run listings use the `status-index` GSI and resume via an ExclusiveStartKey rebuilt from the sk cursor. — app/packages/cloud-aws/src/AwsRunRecordStore.ts:295-326
- `partialApply` is not persisted or restored by AwsRunRecordStore, even though shared and desktop-main treat it as durable. — app/packages/cloud-aws/src/AwsRunRecordStore.ts:185-210, 336-374 vs app/packages/shared/src/runs.ts:150-161
- Audit before/after snapshots are stored as JSON strings. — app/packages/cloud-aws/src/AwsAuditLogStore.ts:99-116
- The preload exposes exactly one `window.hyveon` object via contextBridge. `__test` is attached only when `HYVEON_TEST_MODE=1`. — app/packages/desktop-preload/src/preload.ts:604-631
- Every bridged call is checked against the per-channel mock registry first, then falls through to `ipcRenderer.invoke`. — app/packages/desktop-preload/src/preload.ts:159-191
- Streams cross the bridge as plain `{next, cancel, [Symbol.asyncIterator]}` handles. The AbortController is minted inside preload, because generators and AbortSignals don't survive the structured clone. — app/packages/desktop-preload/src/preload.ts:17-43, 340-363
- Per-call streams (logs, lambda logs) use `<channel>.<streamId>.{chunk,end,cancel}`, and cancel is sent if the consumer leaves early. Shared streams (stack init, run logs, update download) use fixed channels filtered by streamId, and their cancel only stops local consumption. — app/packages/desktop-preload/src/stream-bridge.ts:13-27, 126-256
- Write ops pass a single payload object because nestjs-electron-ipc-transport only delivers the first argument. — app/packages/desktop-preload/src/preload.ts:397-402; app/packages/desktop-preload/src/hyveon-api.ts:1617-1623
- The `cloud.ts` contract file is test-guarded against importing `@aws-sdk/*`. — app/packages/shared/src/cloud.test.ts:22-27
- The HyveonDeployAll policy constant is test-guarded against the first ```json block in docs/docs/setup.md. — app/packages/shared/src/iamPolicy.test.ts:18-35

## Cross-scope references

- **Lambdas → shared**: `lambda/followup` uses putPending, getEffectiveDiscordConfig, canRun, patchInteractionOriginal, renderConnectMessage, formatGameStatus, parseGameMapEnv and resolveEniPublicIp. `lambda/update-dns` uses getPending/deletePending, patchInteractionOriginal, formatGameStatus, familyToGameMap, parseGameMapEnv and resolveEniPublicIp. `lambda/interactions` uses getEffectiveDiscordConfig, canRun and getPublicKey. `lambda/watchdog` uses familyToGameMap and parseGameMapEnv. The other env helpers (requireEnv, gameNamesFromEnv) are documented as Lambda-scope (env.ts:7-10).
- **desktop-main → cloud-aws**: `modules/cloud-provider.module.ts` binds AwsAuditLogStore, AwsRunRecordStore, AwsDiscordConfigStore, AwsDiscordEventReceiver, AwsRemoteFileStore, AwsSecretsStore and AwsCloudProvider to DI tokens (RUN_RECORD_STORE, REMOTE_FILE_STORE, ...). `EcsService.ts` uses AwsCloudProvider and WorkloadGuardError. `CostService.ts` uses the FARGATE_* re-exports. `DiscordConfigService.ts` uses AwsDiscordConfigStore. `RunRecordService.ts` references AwsRunRecordStore.
- **desktop-main → shared**: RunService/RunRecordService use RunLockHeldError, isRunLockExpired, buildRunSk, deriveRunStatus, resolvePreApplyRunsTableName and errMessage. PulumiService uses normalizeDeploymentConfigGames, findWebPortCollisions, diffDeploymentConfig and the partialApply gate (PulumiService.ts:2037). `iac-runs.controller.ts` uses computeRunDetailStatus. `discord.controller.ts` uses canRun and COMMAND_DESCRIPTORS (also DiscordCommandRegistrar). GamesWriteService uses upsertHealthCheckAuthSecret, deleteHealthCheckAuthSecret and validateHealthCheckAuthInput. GuidedIamService uses generateHyveonSelfRotatePolicy. IamCheckService uses HYVEON_DEPLOY_ALL_ACTIONS. Ec2Service uses resolveEniPublicIp. PulumiEngineService uses PULUMI_ENGINE_VERSION. FileManagerService uses fileManagerLogGroupName. The folderUpload services and controller use `@hyveon/shared/folderUpload`. Named-only references in docs: BootstrapService.ensureRunsTable, DeploymentConfigService, GameWizardDraftService, FirstRunWizardService, ElectronStoreService.
- **infra → shared**: `infra/src/ecs.ts` and `securityGroups.ts` use ingressPorts. `infra/src/envTokenWrapper.ts` uses `@hyveon/shared/envTokens`. infra is documented as consuming DeploymentConfig, resolveRunsTableName, StackOutputs (`program.ts` buildStackOutputs), fileManagerLogGroupName, and SECRET_PLACEHOLDER (`secrets.ts`).
- **web → shared/preload**: 36 files import `@hyveon/desktop-preload` (root entry only). The web add-game wizard and `api.service.ts` deep-import `@hyveon/shared/gameServerValidator`, envTokens or folderUpload. Documented web consumers include wizard-form.utils.ts (GAME_NAME_PATTERN, checkConnectMessagePlaceholders, isValidIcmpType, ADD_GAME_WIZARD_STEPS), wizard.utils.ts (WIZARD_STEPS), submission-banners (formatRelativeAge), iam-check-panel (HYVEON_DEPLOY_ALL_ACTIONS), and `e2e/integration-specs/can-run.spec.ts` (canRun, getEffectiveDiscordConfig).
- **desktop-main IPC controllers ↔ preload**: every channel name in preload.ts must match a `@MessagePattern` in `desktop-main/src/controllers/*.ts`, including the side channels iac.stack.initialize.{chunk,end}, iac.runs.logs.{chunk,end}, iac.settings.autoUpdate.download.{chunk,end}, logs[.lambda].stream.<id>.{chunk,end,cancel}, and the push events folderUpload.progress and window.maximizedChange. hyveon-api.ts mirrors types owned by desktop-main: LogsService (LogEventLine, Older/NewerLogsPage), PulumiService (PulumiRunRecord, PulumiRunChunk), PulumiEngineService (phases), iac.controller.ts / iac-runs.controller.ts (acks and payloads), ElectronStoreService (GameWizardDraft), GuidedIamService/IamCheckService/FirstRunWizardService/wizard.controller.ts (wizard types, GUIDED_PROFILE_NAME).
- **docs → shared tests**: `iamPolicy.test.ts` reads `docs/docs/setup.md`. `pulumiVersion.ts` is asserted by `app/test/packaging-manifest-pins.test.ts`. `HYVEON_DEPLOY_ALL_ACTIONS` is also referenced from `desktop-main/resources/cloudformation/iam-bootstrap.yaml`.
- **No external consumer found (possibly dead)**: shared `AwsLambdaDiscordReceiver`; shared `getBotToken`/`putBotToken`/`putPublicKey`/`invalidateSecretsCache`; preload `test-mock-registry` (claimed web consumer, but no import found).
