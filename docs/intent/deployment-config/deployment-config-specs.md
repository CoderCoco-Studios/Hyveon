# Deployment Config Specs

EARS requirements for prefix `CONFIG`; design in `docs/intent/deployment-config/deployment-config-design.md`.

## Document model

- [x] **CONFIG-MODEL-001**: The `DeploymentConfig` type in `@hyveon/shared` shall be the single type for `deployment-config.json`, imported directly by both the infra program and `DeploymentConfigService`, so a change to its shape fails type-checking in both until both are updated. (OpenSpec: pulumi-infra-program / Typed game-server configuration model)
- [x] **CONFIG-MODEL-002**: The `DeploymentConfig.gameServers` record, keyed by game name, shall be the only edit required to add or remove a game; the infra program shall derive every per-game resource by iterating that record rather than declaring any game by hand. (OpenSpec: pulumi-infra-program / Typed game-server configuration model)
- [x] **CONFIG-MODEL-003**: The `DeploymentConfig` type shall carry the top-level deployment settings (project name, VPC CIDR, hosted zone, DNS TTL, the three watchdog tunables, the three Discord base allowlists, the Discord application id, and the audit and runs table-name overrides) alongside `gameServers`, so that no deployment setting requires editing a file by hand. The install's AWS region is not a deployment setting: it is the wizard region (`IAC-ENGINE-REGION-001`). (OpenSpec: pulumi-infra-program / Configuration persisted as versioned JSON)
- [x] **CONFIG-MODEL-004**: The `DeploymentConfig` type shall contain no secret field; Discord credentials shall live only in Secrets Manager and never in `deployment-config.json`. (observed)
- [x] **CONFIG-MODEL-005**: The deployment-config document shall be stored under the fixed object key `CONFIGURATION_OBJECT_KEY` (`deployment-config.json`), with no environment override able to change the key. (observed)
- [x] **CONFIG-MODEL-006**: When `withDeploymentConfigDefaults` is given a partial deployment-config document, it shall fill every absent top-level field from `DEPLOYMENT_CONFIG_DEFAULTS` (fresh empty arrays for the three Discord allowlists) and pass `hostedZoneName` and `gameServers` through unchanged. (observed)
- [x] **CONFIG-MODEL-007**: When the deployment-config `runsTableName` is empty, `resolveRunsTableName` shall resolve the runs-table name to `${projectName}-runs`. (observed)
- [x] **CONFIG-MODEL-008**: When `resolvePreApplyRunsTableName` cannot read or parse `deployment-config.json` from the store, it shall return `undefined` rather than throw. (observed)

## Storage transport

- [x] **CONFIG-STORE-001**: `DeploymentConfigService` shall read and write `deployment-config.json` only through the cloud-agnostic `RemoteFileStore` contract, so every write inherits its conditional-write locking and S3 version history. (OpenSpec: pulumi-infra-program / Configuration persisted as versioned JSON)
- [x] **CONFIG-STORE-002**: The desktop app shall depend on no HCL parsing package, and reading or writing `deployment-config.json` shall neither parse nor emit HCL. (OpenSpec: pulumi-infra-program / Configuration persisted as versioned JSON)
- [x] **CONFIG-STORE-003**: When `AwsRemoteFileStore.put` is called with an `ifMatch` etag, it shall send that etag as the S3 `IfMatch` condition, and when called without one it shall send an unconditional `PutObject`. (observed)
- [x] **CONFIG-STORE-004**: If S3 rejects an `AwsRemoteFileStore.put` with HTTP 409 or 412, then the store shall throw `RemoteFileConflictError`. (observed)
- [x] **CONFIG-STORE-005**: If S3 `PutObject` returns no ETag, then `AwsRemoteFileStore.put` shall throw. (observed)
- [x] **CONFIG-STORE-006**: When `AwsRemoteFileStore.get` reads an object that S3 reports as `NoSuchKey` or HTTP 404, it shall return `undefined`. (observed)
- [ ] **CONFIG-STORE-007**: If S3 `GetObject` for `deployment-config.json` returns a response with no body or no ETag, then `AwsRemoteFileStore.get` shall report an error rather than the "not found" result it uses for a missing object. (gap: `app/packages/cloud-aws/src/AwsRemoteFileStore.ts:106`)
- [x] **CONFIG-STORE-008**: When `AwsRemoteFileStore.listVersions` receives a response with `IsTruncated: true`, it shall issue the next request with that response's `NextKeyMarker` and `NextVersionIdMarker` as `KeyMarker` and `VersionIdMarker`, accumulating every page's versions. (OpenSpec: iac-rollback / Complete remote file version listing)
- [x] **CONFIG-STORE-009**: When `AwsRemoteFileStore.listVersions` finishes paging, it shall return only versions whose key exactly matches the requested path, sorted newest `lastModified` first. (OpenSpec: iac-rollback / Complete remote file version listing)
- [x] **CONFIG-STORE-010**: When `AwsRemoteFileStore.listVersions` is called for a key whose versions fit in one response, it shall issue exactly one `ListObjectVersions` request. (OpenSpec: iac-rollback / Complete remote file version listing)
- [x] **CONFIG-STORE-011**: When `AwsRemoteFileStore.getVersion` is asked for a version id that S3 reports as missing, it shall return `undefined` rather than throw. (observed)

## Reads

- [x] **CONFIG-READ-001**: If any `DeploymentConfigService` read or write of `deployment-config.json` runs while no configuration bucket is configured, then it shall throw `ConfigurationNotConfiguredError` before any store call, never falling back to a file on disk. (OpenSpec: pulumi-infra-program / Configuration persisted as versioned JSON)
- [x] **CONFIG-READ-002**: If the configuration bucket is configured but `deployment-config.json` is absent, then `DeploymentConfigService`'s raw read shall throw an error naming the object key and bucket. (observed)
- [x] **CONFIG-READ-003**: If the text of `deployment-config.json` is not valid JSON or does not decode to a plain object, then `DeploymentConfigService` shall reject the parse with an error. (observed)
- [x] **CONFIG-READ-004**: While a `DeploymentConfigService.getGameServers` cache entry is younger than `ConfigService.readEnvConfigCacheTtlMs()` (default 30 s), `getGameServers` shall return the cached game list without reading the store. (observed)
- [x] **CONFIG-READ-005**: If `DeploymentConfigService.getGameServers` fails for any reason (unconfigured bucket, missing object, store error, malformed JSON), then it shall log the failure (`warn` for an unconfigured bucket, `error` otherwise), resolve `[]` instead of rejecting, and cache that `[]` as a failed entry for the TTL. (observed)
- [x] **CONFIG-READ-006**: When `DeploymentConfigService.invalidateCache` is called while a `getGameServers` fetch is in flight, the service shall discard that fetch's result rather than cache it. (observed)
- [x] **CONFIG-READ-007**: When `DeploymentConfigService.getGameServers` flattens `gameServers`, it shall attach each map key as the game's `name` and pass each entry through the `game-server` leaf's `normalizeGameServer` (legacy https entries without `webPort` read in the current shape). (observed)
- [x] **CONFIG-READ-008**: If the parsed deployment-config document has no `gameServers` object, then `DeploymentConfigService.getGameServers` shall log a warning and return `[]`. (observed)
- [x] **CONFIG-READ-009**: `DeploymentConfigService.getRawConfig` shall bypass the game-list cache, reject on any read failure, and return the raw document text with the store etag to use as the caller's `ifMatch`. (observed)
- [x] **CONFIG-READ-010**: `DeploymentConfigService.getTopLevelSettings` shall bypass the game-list cache, reject on any read failure, run the parsed document through `withDeploymentConfigDefaults`, and return every top-level field except `gameServers` with the store etag. (observed)
- [x] **CONFIG-READ-011**: `DeploymentConfigService.isConfigured` shall report whether a configuration bucket is set, so callers can tell "no bucket" apart from "zero games" (both of which yield `[]` from `getGameServers`). (observed)

## Writes

- [x] **CONFIG-WRITE-001**: When the operator adds, edits or removes a game through the app, `DeploymentConfigService` shall write a new version of `deployment-config.json` to the configuration bucket as JSON. (OpenSpec: pulumi-infra-program / Configuration persisted as versioned JSON)
- [x] **CONFIG-WRITE-002**: When a deployment-config document containing every supported field is written by `DeploymentConfigService` and read back, the parsed result shall be deeply equal to what was written, including boolean and numeric fields. (OpenSpec: pulumi-infra-program / Configuration persisted as versioned JSON)
- [x] **CONFIG-WRITE-003**: `DeploymentConfigService` shall serialise every edited deployment-config document as `JSON.stringify(config, null, 2)` followed by a newline. (observed)
- [x] **CONFIG-WRITE-004**: When a game or settings edit to `deployment-config.json` is made with a caller-supplied etag (`expectedVersionId`), `DeploymentConfigService` shall read the current head, apply the edit, and put the result conditionally on that caller's etag. (observed)
- [x] **CONFIG-WRITE-005**: If a conditional put of `deployment-config.json` fails with `RemoteFileConflictError`, then `DeploymentConfigService` shall throw `OptimisticLockError` carrying the expected etag and, when a follow-up read succeeds, the current head etag. (observed)
- [x] **CONFIG-WRITE-006**: When any `DeploymentConfigService` write of `deployment-config.json` (game edit, settings edit, or restore) succeeds, the service shall invalidate the game-list cache. (observed)
- [x] **CONFIG-WRITE-007**: If `addGameServer` is called with a name not matching `GAME_NAME_PATTERN`, then `DeploymentConfigService` shall throw `GameServerEntryError` with reason `invalid-name` before writing. (observed)
- [x] **CONFIG-WRITE-008**: If `addGameServer` is called with a name already present in `gameServers`, then `DeploymentConfigService` shall throw `GameServerEntryError` with reason `duplicate-name` before writing. (observed)
- [x] **CONFIG-WRITE-009**: If `updateGameServer` or `removeGameServer` names a game absent from `gameServers`, then `DeploymentConfigService` shall throw `GameServerEntryError` with reason `not-found` before writing. (observed)
- [x] **CONFIG-WRITE-010**: If a game write finds no `gameServers` map in the stored deployment-config document, then `DeploymentConfigService` shall throw `GameServerEntryError` with reason `structural` before writing. (observed)
- [x] **CONFIG-WRITE-011**: When `updateTopLevelSettings` applies a settings patch, `DeploymentConfigService` shall keep `gameServers` from the current stored document and discard any `gameServers` key present in the patch. (observed)
- [x] **CONFIG-WRITE-012**: If a settings patch or a restored document would change the resolved runs-table name of `deployment-config.json`, then `DeploymentConfigService` shall throw `RunsTableRenameError` naming the contributing fields (`projectName`, `runsTableName`) before writing. (observed)
- [x] **CONFIG-WRITE-013**: `DeploymentConfigModule` shall alias `DeploymentConfigService` to the `DEPLOYMENT_CONFIG_SERVICE` token with `useExisting`, so `PulumiService` resolves the same singleton without a static module import. (observed)

## Rollback restore

- [x] **CONFIG-RESTORE-001**: When rollback calls `DeploymentConfigService.restoreRawConfig` with a historic version's content, the service shall write that content as a new head version of `deployment-config.json` without deleting or rewriting any existing version. (OpenSpec: iac-rollback / Rollback restores the version and queues a tagged plan)
- [x] **CONFIG-RESTORE-002**: When `DeploymentConfigService.restoreRawConfig` writes a historic deployment-config version, the new head's content shall be byte-for-byte identical to the historic content, with no parse-and-re-emit step. (OpenSpec: iac-rollback / Rollback restores the version and queues a tagged plan)
- [x] **CONFIG-RESTORE-003**: When `DeploymentConfigService.restoreRawConfig` runs, it shall apply the runs-table rename guard (CONFIG-WRITE-012) between the current head and the restored document before writing. (observed)
- [ ] **CONFIG-RESTORE-004**: If `deployment-config.json` changes between `restoreRawConfig`'s head read and its put (for example a game edit, which does not take the run lock), then the restore shall fail with `OptimisticLockError` rather than overwrite that change. (gap: `app/packages/desktop-main/src/services/DeploymentConfigService.ts:381-390` writes unconditionally)

## Settings IPC

- [x] **CONFIG-SET-001**: When `iac.settings.get` is invoked, `IacSettingsController` shall log on entry and return `{ ok: true, settings, etag }` from `getTopLevelSettings`. (observed)
- [x] **CONFIG-SET-002**: If an `iac.settings.get` or `iac.settings.update` call hits `ConfigurationNotConfiguredError`, then `IacSettingsController` shall return `code: 'setup_incomplete'` with the error message. (OpenSpec: pulumi-infra-program / Configuration persisted as versioned JSON)
- [ ] **CONFIG-SET-003**: If `iac.settings.get` runs while the configuration bucket is configured but `deployment-config.json` is absent, then `IacSettingsController` shall return a result distinct from the generic `code: 'error'`. (gap: `app/packages/desktop-main/src/controllers/iac-settings.controller.ts:139-140`)
- [x] **CONFIG-SET-004**: When `iac.settings.update` is invoked, `IacSettingsController` shall log on entry, run `validateDeploymentSettingsPatch` on the patch, and return `code: 'validation'` with per-field issues without writing if any issue is found. (observed)
- [x] **CONFIG-SET-005**: When `iac.settings.update` passes validation, `IacSettingsController` shall write the patch with the payload's `expectedVersionId` and return `{ ok: true, settings, etag, versionId }` using a fresh read of the stored settings. (observed)
- [ ] **CONFIG-SET-006**: If the `iac.settings.update` write of `deployment-config.json` succeeds but the follow-up settings read fails, then `IacSettingsController` shall still report success for the write. (gap: `app/packages/desktop-main/src/controllers/iac-settings.controller.ts:167-168`, `:195-196` report `code: 'error'`)
- [x] **CONFIG-SET-007**: If an `iac.settings.update` write throws `RunsTableRenameError`, then `IacSettingsController` shall return `code: 'validation'` with one issue per contributing field. (observed)
- [x] **CONFIG-SET-008**: If an `iac.settings.update` write throws `OptimisticLockError`, then `IacSettingsController` shall return `code: 'conflict'` with the expected and current etags. (observed)
- [ ] **CONFIG-SET-009**: If an `iac.settings.update` write conflicts, or an `iac.settings.get`/`update` call fails unexpectedly, then `IacSettingsController` shall log the outcome with the error's `.message` only, never the raw error object. (gap: `app/packages/desktop-main/src/controllers/iac-settings.controller.ts:139`, `:182-190`, `:195`)
- [x] **CONFIG-SET-010**: If `iac.settings.get` or `iac.settings.update` fails for any other reason, including a malformed payload, then `IacSettingsController` shall return `code: 'error'` with a generic message rather than throw across IPC. (observed)
- [x] **CONFIG-SET-011**: `validateDeploymentSettingsPatch` shall check only fields present in a deployment-settings patch: `hostedZoneName` and `projectName` as non-empty strings; `vpcCidr` as an IPv4 CIDR; `dnsTtl` and the three watchdog tunables as positive integers; and the three Discord base allowlists as arrays of 17-20 digit snowflakes, with per-index issue paths. (observed)
- [ ] **CONFIG-SET-012**: If an `iac.settings.update` patch carries an `awsRegion` field, then `validateDeploymentSettingsPatch` shall report a validation issue on `awsRegion`, so the settings write path never stores an operator-supplied region. (gap: `app/packages/shared/src/deploymentSettingsWrite.ts:56` accepts any non-empty `awsRegion`, and `iac.settings.update` writes it)

## Settings form

- [x] **CONFIG-FORM-001**: When the Settings page loads deployment settings, `useDeploymentSettings` shall call `iac.settings.get` and expose a `loading`, `loaded`, `setup_incomplete` or `error` state. (observed)
- [x] **CONFIG-FORM-002**: While the Settings page holds a deployment-settings draft, `useDeploymentSettings` shall run `validateDeploymentSettingsPatch` live on the draft and disable save while any issue exists or a save is in flight. (observed)
- [ ] **CONFIG-FORM-003**: When the operator saves deployment settings, `useDeploymentSettings` shall send every top-level field except `awsRegion`, and the last-read etag as `expectedVersionId`. (gap: `draftToPatch` sends `awsRegion`, `app/packages/web/src/hooks/use-deployment-settings.hook.ts:155`)
- [x] **CONFIG-FORM-004**: If the Settings page has no etag for the loaded deployment settings, then `useDeploymentSettings` shall refuse to save and ask the operator to reload, rather than send an unconditional write. (observed)
- [x] **CONFIG-FORM-005**: When an `iac.settings.update` save returns `ok`, `useDeploymentSettings` shall adopt the returned etag and settings and show a success toast; on `validation` it shall show the server issues until the next edit; on `conflict` it shall prompt a reload; on `setup_incomplete` or `error` it shall show the message; in every failure case the draft shall be kept. (observed)
- [x] **CONFIG-FORM-006**: `DeploymentSettingsForm` shall edit the three Discord base allowlists with the `discord-bot` leaf's `SnowflakeChipsInput`. (observed)
- [ ] **CONFIG-FORM-007**: `DeploymentSettingsForm` shall show the install's AWS region, the wizard region that `ConfigService.getRegion()` returns, as read-only text with a note that moving to another region means destroying the stack and re-running the first-run wizard, and shall offer no input that edits it. (gap: `app/packages/web/src/components/deployment-settings-form.component.tsx:91-94` renders an editable free-text `AWS region` input bound to `DeploymentConfig.awsRegion`)

## Drift detection

- [x] **CONFIG-DRIFT-001**: When `drift.get` is invoked, `DriftService.getDrift` shall invalidate the deployment-config cache, read the declared games from `getGameServers`, read stack outputs without invalidating their cache, and compute the drift report. (observed)
- [x] **CONFIG-DRIFT-002**: When computing drift, the system shall take the applied map from the `appliedGameServers` stack output and the deployed set from its keys, falling back to the `gameNames` output when `appliedGameServers` is absent. (observed)
- [x] **CONFIG-DRIFT-003**: When a game is declared in `deployment-config.json` but absent from the deployed set, the drift report shall contain a `pending_create` entry for it. (observed)
- [x] **CONFIG-DRIFT-004**: When a game is deployed but not declared in `deployment-config.json`, the drift report shall contain a `pending_delete` entry for it. (observed)
- [x] **CONFIG-DRIFT-005**: When a game is declared, deployed and present in the applied map, and its `image`, `cpu`, `memory`, `ports` (with `webPort` folded in) or `volumes` differ, the drift report shall contain a `config_drift` entry listing the differing fields in that fixed order. (observed)
- [x] **CONFIG-DRIFT-006**: When comparing a declared game against its applied snapshot, the system shall pass both through `normalizeGameServer` and compare `ports` and `volumes` as order-insensitive sets. (observed)
- [ ] **CONFIG-DRIFT-007**: If the declared deployment-config cannot be read while computing drift, then `DriftService.getDrift` shall fail or report the declared state as unknown, rather than report every deployed game as `pending_delete`. (gap: `app/packages/desktop-main/src/services/DriftService.ts:210` uses the never-rejecting `getGameServers`; `:150-154`)
- [ ] **CONFIG-DRIFT-008**: When a declared and deployed game's `environment`, `command`, `https`, `healthCheck` or `pinnedHostname` differs from its applied snapshot, the drift report shall flag it, or the pending-changes banner shall state that drift covers only image, CPU, memory, ports and volumes. (gap: `app/packages/desktop-main/src/services/DriftService.ts:13-20`; `app/packages/shared/src/drift.ts:26`)
- [x] **CONFIG-DRIFT-009**: If `DriftService.getDrift` fails, then it shall log a warning and rethrow a plain `Error` carrying only the message. (observed)

## Pending-changes banner

- [x] **CONFIG-BANNER-001**: While `PendingChangesBanner` is mounted on the dashboard or games page, it shall poll `drift.get` immediately and every 30 seconds. (observed)
- [x] **CONFIG-BANNER-002**: When a `PendingChangesBanner` poll response arrives after a newer poll was issued, the banner shall discard it. (observed)
- [x] **CONFIG-BANNER-003**: If a `PendingChangesBanner` poll fails, then the banner shall hide itself. (observed)
- [x] **CONFIG-BANNER-004**: While the drift report has entries, `PendingChangesBanner` shall show per-kind counts with links to the Infrastructure and Games pages. (observed)
- [x] **CONFIG-BANNER-005**: When the operator dismisses `PendingChangesBanner`, it shall store a signature of the sorted `game:kind:changedFields` tuples in `sessionStorage` and stay hidden until the signature changes, clearing the stored dismissal when a clean report arrives. (observed)

## Rollback diff

- [x] **CONFIG-RBDIFF-001**: When `diffDeploymentConfig` compares two deployment-config documents for the rollback confirmation, it shall return the changed top-level fields and the added, removed and changed `gameServers` keys, comparing arrays and game entries with key-order-insensitive JSON equality. (OpenSpec: iac-rollback / Rollback initiation from history)
- [ ] **CONFIG-RBDIFF-002**: When a top-level field is added to `DeploymentConfig`, `diffDeploymentConfig` shall include it in its comparison without a separate hand-maintained list falling out of date. (gap: `app/packages/shared/src/deploymentConfig.ts:392-407` is not checked for completeness)

## Dropped from OpenSpec

- pulumi-infra-program / Typed game-server configuration model, "replacing the HCL `game_servers` map": migration framing from the Terraform era; the HCL map no longer exists, so only the current-state model requirements are kept (CONFIG-MODEL-001, CONFIG-MODEL-002).
- pulumi-infra-program / Configuration persisted as versioned JSON, "replacing `terraform.tfvars`" and "the unguarded synchronous local write path is deleted, not patched": Terraform-era and removal-history clauses; the current-state outcome is kept as CONFIG-READ-001 and CONFIG-STORE-001.
- pulumi-infra-program / Typed game-server configuration model, scenarios "Adding a game requires only a config entry" and "Removing a game removes its resources" as preview assertions: the preview's resource set is owned by `iac/program`; only the config-side half is kept here (CONFIG-MODEL-002).
