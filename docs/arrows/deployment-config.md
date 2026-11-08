# Arrow: deployment-config

The one stored document that says what should exist (`deployment-config.json`): reading and versioning it, editing its top-level settings, and showing what has changed since the last deploy.

## Status

**MAPPED** — mapped 2026-10-30 (git SHA `5c55a380`), not yet audited.
The S3-only, etag-guarded read/write path is solid and well tested; drift detection is narrower than the config it diffs (the banner says so) and fails, rather than reporting every game pending delete, when the config read fails.

## References

### HLD
- `docs/high-level-design.md

### LLD
- `docs/intent/deployment-config/deployment-config-design.md`

### EARS
- `docs/intent/deployment-config/deployment-config-specs.md` (82 specs)

### Tests
- cloud-aws: `app/packages/cloud-aws/src/AwsRemoteFileStore.test.ts`
- desktop-main: `app/packages/desktop-main/src/controllers/drift.controller.test.ts`, `app/packages/desktop-main/src/controllers/iac-settings.controller.test.ts`, `app/packages/desktop-main/src/services/DeploymentConfigService.test.ts`, `app/packages/desktop-main/src/services/DeploymentConfigService.freshInstall.test.ts`, `app/packages/desktop-main/src/services/DeploymentConfigService.s3.test.ts`, `app/packages/desktop-main/src/services/DeploymentConfigService.write.test.ts`, `app/packages/desktop-main/src/services/DriftService.test.ts`
- shared: `app/packages/shared/src/deploymentConfig.test.ts`, `app/packages/shared/src/deploymentSettingsWrite.test.ts`
- web: `app/packages/web/e2e/specs/pending-changes-banner.spec.ts`, `app/packages/web/src/components/deployment-settings-form.component.test.tsx`, `app/packages/web/src/components/pending-changes-banner.component.test.tsx`
- test doubles (non-test files that exist only for tests): `app/packages/desktop-main/src/test-mocks/remote-file-store-mock.ts`, `app/packages/desktop-main/src/testing/deployment-config.fixture.ts`

### Code
- **cloud-aws**
  - `app/packages/cloud-aws/src/AwsRemoteFileStore.ts`
- **desktop-main**
  - `app/packages/desktop-main/src/controllers/drift.controller.ts`
  - `app/packages/desktop-main/src/controllers/iac-settings.controller.ts`
  - `app/packages/desktop-main/src/modules/deployment-config.module.ts`
  - `app/packages/desktop-main/src/services/DeploymentConfigService.ts`
  - `app/packages/desktop-main/src/services/DriftService.ts`
- **shared**
  - `app/packages/shared/src/deploymentConfig.ts`
  - `app/packages/shared/src/deploymentSettingsWrite.ts`
  - `app/packages/shared/src/drift.ts`
- **web**
  - `app/packages/web/src/components/deployment-settings-form.component.tsx`
  - `app/packages/web/src/components/pending-changes-banner.component.tsx`
  - `app/packages/web/src/hooks/use-deployment-settings.hook.ts`

### Cited from other leaves
- `app/packages/shared/src/cloud.ts` (`game-runtime/task-and-dns`): the cloud-agnostic `RemoteFileStore` interface and `RemoteFileConflictError` this leaf reads and writes through.
- `app/packages/shared/src/errors.ts` (`iac/run`): `OptimisticLockError`, the only conflict shape callers see.
- `app/packages/desktop-main/src/modules/cloud-provider.module.ts` (`operator-app/desktop-shell`): binds `REMOTE_FILE_STORE` to `AwsRemoteFileStore` with `resolveDeploymentConfigFileStoreConfig` (`:73-84`, `:203`); region resolvers (one install region through `getRegion()`, `IAC-ENGINE-REGION-002`).
- `app/packages/desktop-main/src/services/ConfigService.ts` (`iac/engine`): `getConfigurationBucket()`, `getRegion()`, `readEnvConfigCacheTtlMs()`, and `getStackOutputs()` (the `appliedGameServers`/`gameNames` side of drift).
- `app/packages/shared/src/stackOutputs.ts` (`iac/program`): the `appliedGameServers` snapshot drift compares against.
- `app/packages/shared/src/gameServerConfig.ts` (`game-server`): `GameServerConfig` (the `gameServers` value type) and `normalizeGameServer`, the legacy-https read-time normaliser applied in `DeploymentConfigService.flattenGameServers` and `DriftService.changedFields`.
- `app/packages/desktop-main/src/services/GamesWriteService.ts`, `controllers/games.controller.ts` (`game-server`): callers of `addGameServer`/`updateGameServer`/`removeGameServer` and of `computeDriftFromOutputs` (`GamesWriteService.ts:333`, `games.controller.ts:58`).
- `app/packages/desktop-main/src/services/PulumiService.ts` (`iac/engine`, `iac/run`): declares the `DEPLOYMENT_CONFIG_SERVICE` token (`:242`) this leaf's module binds, calls `restoreRawConfig` from rollback and `diffDeploymentConfig` (`:3513`).
- `app/packages/desktop-main/src/services/BootstrapService.ts` (`operator-app/wizard-and-bootstrap`): seeds the initial `deployment-config.json`.
- `app/packages/infra/src/lambdas.ts`, `app/packages/infra/src/escapes.ts` (`iac/program`): bake the `watchdog*` settings and `baseAllowedGuilds`/`baseAdmin*` into the stack at apply time.
- `app/packages/web/src/components/snowflake-chips-input.component.tsx` (`discord-bot`): the base allowlist inputs in the settings form.
- `app/packages/web/src/pages/settings.page.tsx` (`operator-app/desktop-shell`), `pages/dashboard.page.tsx` and `pages/games.page.tsx`: hosts of the settings form and the pending-changes banner.

## Architecture

**Purpose:** Own `deployment-config.json` in the operator's versioned S3 configuration bucket as the single source of truth for what should be deployed, expose it as a cached game list, a raw document, and a top-level settings form, and report how it differs from what the last apply recorded.

**Key Components:**
1. `DeploymentConfig` / `DEPLOYMENT_CONFIG_DEFAULTS` / `withDeploymentConfigDefaults` / `diffDeploymentConfig` (`shared/src/deploymentConfig.ts:35-190`, `:221-245`, `:322`, `:471`): the document type, its object key `CONFIGURATION_OBJECT_KEY`, static defaults, runs-table name resolution (`:259`, `:287`), and the rollback diff.
2. `DeploymentConfigService` (`desktop-main/src/services/DeploymentConfigService.ts:227`): the only reader and writer. `getGameServers` (`:300`) is TTL-cached and never rejects; `getRawConfig` (`:351`) and `getTopLevelSettings` (`:418`) bypass the cache and reject; `addGameServer`/`updateGameServer`/`removeGameServer`/`updateTopLevelSettings` (`:456-561`) share the read-mutate-conditional-put path `writeConfig` (`:590`); `restoreRawConfig` (`:381`) serves rollback.
3. `AwsRemoteFileStore` (`cloud-aws/src/AwsRemoteFileStore.ts:100`, `:121`, `:145`, `:188`): S3 `get` / `getVersion` / `put` with `IfMatch` (412/409 mapped to `RemoteFileConflictError`) / paginated `listVersions`.
4. `DeploymentConfigModule` (`desktop-main/src/modules/deployment-config.module.ts:32-37`): provides the service and aliases it to `DEPLOYMENT_CONFIG_SERVICE` via `useExisting` so `PulumiService` reaches it without a module cycle.
5. `IacSettingsController` (`desktop-main/src/controllers/iac-settings.controller.ts`): `iac.settings.get` (`:128`) and `iac.settings.update` (`:158`) map every failure to a `{ ok: false, code }` result; the same class also carries `iac.settings.engineVersion` (`:210`), hosted on `iac/engine`'s behalf, and five auto-update channels (`:228-320`) that belong to `app-update-and-release` and move to a controller of its own.
6. `validateDeploymentSettingsPatch` (`shared/src/deploymentSettingsWrite.ts:49`): shared PATCH validator run by both the renderer hook and the controller; also defines the IPC result unions (`:171-257`).
7. `useDeploymentSettings` + `DeploymentSettingsForm` (`web/src/hooks/use-deployment-settings.hook.ts:187`, `web/src/components/deployment-settings-form.component.tsx:24`): the Settings-page editor; always sends the last-read etag and refuses to save without one.
8. `DriftService` / `computeDrift` / `computeDriftFromOutputs` (`desktop-main/src/services/DriftService.ts:123`, `:167`, `:206`) behind `drift.get` (`drift.controller.ts:18`): classifies games as `pending_create`, `pending_delete` or `config_drift` against stack outputs; types in `shared/src/drift.ts`.
9. `PendingChangesBanner` (`web/src/components/pending-changes-banner.component.tsx:81`): polls `drift.get` every 30 s on the dashboard and games pages, with a sessionStorage dismissal keyed to the report signature.

## Spec Coverage

| Category | Spec IDs | Implemented | Deferred | Gaps |
|---|---|---|---|---|
| Document model | `CONFIG-MODEL-001` to `CONFIG-MODEL-008` | 8 | 0 | 0 |
| Storage transport | `CONFIG-STORE-001` to `CONFIG-STORE-011` | 11 | 0 | 0 |
| Reads | `CONFIG-READ-001` to `CONFIG-READ-011` | 11 | 0 | 0 |
| Writes | `CONFIG-WRITE-001` to `CONFIG-WRITE-013` | 13 | 0 | 0 |
| Rollback restore | `CONFIG-RESTORE-001` to `CONFIG-RESTORE-004` | 4 | 0 | 0 |
| Settings IPC | `CONFIG-SET-001` to `CONFIG-SET-012` | 12 | 0 | 0 |
| Settings form | `CONFIG-FORM-001` to `CONFIG-FORM-007` | 7 | 0 | 0 |
| Drift detection | `CONFIG-DRIFT-001` to `CONFIG-DRIFT-009` | 9 | 0 | 0 |
| Pending-changes banner | `CONFIG-BANNER-001` to `CONFIG-BANNER-005` | 5 | 0 | 0 |
| Rollback diff | `CONFIG-RBDIFF-001` to `CONFIG-RBDIFF-002` | 2 | 0 | 0 |

**Summary:** 82 of 82 active specs implemented; 0 deferred; 0 gaps.

## Key Findings

1. **S3 is the only source; unconfigured is a typed state, not a failure**: `fetchRawConfig` throws `ConfigurationNotConfiguredError` before any network call when no bucket is set (`DeploymentConfigService.ts:563-574`, `:142`); `iac.settings.get/update` map it to `code: 'setup_incomplete'` (`iac-settings.controller.ts:135-137`, `:191-193`). Matches the `pulumi-infra-program` "No local configuration fallback" scenario.
2. **Two read contracts on one service**: `getGameServers` never rejects and negatively caches `[]` for the TTL on any failure (`DeploymentConfigService.ts:300-338`); `getRawConfig`/`getTopLevelSettings` reject (`:351-353`, `:418-423`). A missing object is a `ConfigurationObjectMissingError`, which `iac.settings.get` reports as `code: 'not_found'`; `AwsRemoteFileStore.get` rejects when S3 omits the body or ETag, so an unreadable object is never reported as "not found".
3. **A transient read failure fails drift**: `DriftService.getDrift` uses the rejecting `getGameServersStrict`, so an unreadable config never reads as "no games declared"; the banner hides on the failed poll.
4. **Drift is narrower than the config**: only `image`, `cpu`, `memory`, `ports` (with `webPort` folded in as a marker) and `volumes` are compared (`DriftService.ts:13-20`; closed set `drift.ts:26`). `environment`, `command`, `https`, `healthCheck` and `pinnedHostname` (`gameServerConfig.ts:245-313`) never produce `config_drift`, and top-level settings (watchdog tunables, base allowlists) are not diffed at all. A declared-and-deployed game missing from the applied map yields no entry (`DriftService.ts:139-142`), which only matters on legacy stacks without `appliedGameServers` (`:169`).
5. **Every drift poll bypasses the config cache**: `getDrift` calls `invalidateCache()` before each read (`DriftService.ts:209`), so the 30 s banner poll (`pending-changes-banner.component.tsx:126-128`) is one S3 GET per tick and also evicts the cache other callers share.
6. **Writes and restore are etag-guarded**: `putRawConfig` passes `ifMatch` and rethrows `RemoteFileConflictError` as `OptimisticLockError` (`DeploymentConfigService.ts:616-639`). `restoreRawConfig` conditions its put on the head etag it reads for the rename guard, so a game edit (which does not take the run lock) landing in between fails with `OptimisticLockError` instead of being overwritten.
7. **`projectName`/`runsTableName` are immutable after bootstrap**: `assertRunsTableNameStable` (`DeploymentConfigService.ts:756-780`) runs on both settings patches (`:731-739`) and restores (`:383-385`); the controller maps `RunsTableRenameError` to per-field `validation` issues (`iac-settings.controller.ts:170-181`).
8. **`gameServers` cannot be changed through settings**: `applyTopLevelSettingsPatch` always takes `gameServers` from the current document and drops any value in the patch with no log line (`DeploymentConfigService.ts:731-739`).
9. **Settings save survives a failed re-read**: if `getTopLevelSettings` throws after `updateTopLevelSettings` resolves, `update` reports success with the settings the write returned.
10. **Two canonical-JSON implementations**: `canonicalStringify` (`DriftService.ts:38-48`) and `canonicalJson` (`deploymentConfig.ts:413-420`) do the same key-sorted serialisation for drift and rollback diff respectively.
11. **Rollback diff field list is completeness-checked**: `DEPLOYMENT_CONFIG_SCALAR_FIELDS` derives from a `Record` keyed by every top-level `DeploymentConfig` field, so a new field is a compile error until listed. `remote-file-store-mock.ts:14-30` is a further full copy, typed `DeploymentConfig`, so it fails to compile rather than drift.
12. **`iac-settings.controller.ts` carries other leaves' channels**: the file is this leaf's, but only 2 of its 8 channels are deployment settings. `engineVersion` (`:210`) stays here, hosted on `iac/engine`'s behalf (`IAC-ENGINE-PIN-005`); `autoUpdate.{get,update,check,download,install}` (`:228-320`) belong to `app-update-and-release` and move to a controller that leaf owns, keeping their channel names (`deployment-config-design.md`, Decisions & Alternatives).
14. **Stale comments and naming**: "Local-vs-S3" (`DeploymentConfigService.ts:223`), "from disk/S3" (`:264`), "persisted to disk/S3 ... retired HCL format" (`:782-785`), "HCL/JSON key order" (`DriftService.ts:34`), `GET /api/drift` (`DriftService.ts:196`, `drift.ts:46`), "issue #94" (`drift.ts:5`), "`game_servers` map key" (`drift.ts:33`), a dangling "empty-string-means-computed-default" module-doc reference (`use-deployment-settings.hook.ts:148-150`; no such section exists). `expectedVersionId` is an etag throughout (`DeploymentConfigService.ts:444-445`), and the IPC mock uses its `versionId` as the etag (`remote-file-store-mock.ts`), unlike real S3.
15. **Sweep corrections**: final-clustering §4 says `diffDeploymentConfig` returns `ChangeSummary`; it returns `DeploymentConfigDiff` defined in `deploymentConfig.ts:364` and `changeSummary.ts` is not a dependency of this leaf. The sweep's "banner signature is sensitive to `changedFields` order" (`pending-changes-banner.component.tsx:58`) does not hold: `changedFields` is always emitted in `COMPARED_FIELDS` order (`DriftService.ts:83-89`) and entries are sorted (`pending-changes-banner.component.tsx:59`). `computeDriftFromOutputs` has no direct test (no reference in `DriftService.test.ts`).

## Work Required

Spec IDs cite the open (`[ ]`) gap specs in `docs/intent/deployment-config/deployment-config-specs.md`; items with no matching gap spec carry none.

### Should Fix
7. Move the five `iac.settings.autoUpdate.*` channels out of `iac-settings.controller.ts` into a controller owned by `app-update-and-release`, keeping the channel names; `iac.settings.get`, `iac.settings.update` and `iac.settings.engineVersion` stay (finding 12). Tracked with the matching item in `docs/arrows/operator-app/app-update-and-release.md`.
8. Add direct tests for `computeDriftFromOutputs` (finding 15).

### Nice to Have
9. Extract one canonical-JSON helper shared by drift and rollback diff (finding 10).
11. Stop invalidating the config cache on every drift poll (finding 5).
13. Clean up the stale comments and the `expectedVersionId` naming (finding 14).
