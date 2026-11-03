---
parent: high-level-design
prefix: CONFIG
---

# Deployment Config

## Context and Design Philosophy

Hyveon has exactly one stored description of what should be deployed: the JSON object `deployment-config.json` in the operator's versioned S3 configuration bucket (`shared/src/deploymentConfig.ts:35`).
Every per-game resource the infra program declares fans out from its `gameServers` map, and its top-level fields carry the project name, VPC CIDR, hosted zone, DNS TTL, watchdog tunables, Discord base allowlists, the Discord application id and the two DynamoDB table-name overrides (`shared/src/deploymentConfig.ts:44-190`). Its `awsRegion` field is not one of them and is ignored: an install has one region, chosen in the first-run wizard (`docs/high-level-design.md`, decision 10).
This leaf owns that document end to end inside the desktop app: its type and static defaults, the one service that reads and writes it, the S3 adapter it travels through, the Settings-page editor for its top-level fields, and the drift report that compares it against what the last apply recorded.

The design rests on four ideas that the code states directly.

1. **One source, no fallback.** S3 is the only configuration source; with no bucket configured every read or write reports "setup incomplete" before any network call, never a path on disk (`desktop-main/src/services/DeploymentConfigService.ts:5-14`, `:563-567`). This is the no-local-fallback rule: when no bucket is configured a read reports that setup is incomplete rather than falling back to a file on disk.
2. **Plain JSON data, no secrets.** The model must stay JSON-serialisable because it is persisted verbatim and read directly by the Pulumi program, and secrets are excluded permanently: Discord credentials live in Secrets Manager only (`shared/src/deploymentConfig.ts:13-21`).
3. **Every editing write is a conditional put.** Game edits and settings edits read the current head, mutate it, and put it back guarded by the etag the caller last saw; a store-level conflict surfaces as one cloud-agnostic `OptimisticLockError` (`DeploymentConfigService.ts:37-43`, `:590-639`).
4. **Pollers degrade, editors fail loudly.** The cached game list never rejects so dashboards keep rendering; the raw and settings reads bypass the cache and reject so an editor never shows stale or empty fields (`DeploymentConfigService.ts:32-35`, `:340-353`, `:404-417`).

CLAUDE.md invariants that live here:

- **`DeploymentConfig.gameServers` is the single source of truth**, persisted as `deployment-config.json` in the configuration bucket via `DeploymentConfigService`. Adding a game means adding one map entry (`shared/src/deploymentConfig.ts:176-190`).
- **Secrets never reach the renderer.** This leaf upholds it by construction: no secret field exists on `DeploymentConfig` (`shared/src/deploymentConfig.ts:18-21`), so the settings channels have nothing to redact.

What this leaf deliberately does not own:

- **The shape and validation of one game entry** (`GameServerConfig`, `normalizeGameServer`, the add/edit-game wizard and `GamesWriteService`) belongs to `game-server`. This leaf only stores the map and applies the read-time legacy-https normaliser (`DeploymentConfigService.ts:821-836`).
- **Consuming the document at apply time** (task definitions, watchdog Lambda env, allowlist escapes, `appliedGameServers` stack output) belongs to `iac/program`; selecting and gating the rollback version, and the run lock, belong to `iac/run` and `iac/engine` (`PulumiService.ts` calls `restoreRawConfig` and `diffDeploymentConfig`).
- **Seeding the first document** belongs to `operator-app/wizard-and-bootstrap` (`BootstrapService`).
- **Binding the `RemoteFileStore` to a bucket, region and credentials** belongs to `operator-app/desktop-shell` (`desktop-main/src/modules/cloud-provider.module.ts:73-84`).
- **Watchdog behaviour** belongs to `game-runtime/watchdog`; this leaf only stores its three tunables and renders them in the settings form.

## Document Model

`DeploymentConfig` (`shared/src/deploymentConfig.ts:44-190`) is a flat object of fourteen top-level settings plus the `gameServers` record. `TopLevelDeploymentSettings` is the same type without `gameServers` (`:206`), and is what the Settings page reads and writes.

| Field | Static default (`:221-245`) | Notes |
|---|---|---|
| `projectName` | `hyveon` | Feeds the runs-table name; immutable after bootstrap (see Write Paths). |
| `awsRegion` | `us-east-1` | Not an operator setting: an install has one region, the wizard's, and the infra program takes its `awsRegion` input from `ConfigService.getRegion()`, ignoring this field (`IAC-ENGINE-REGION-001`). Settings shows the wizard region read-only (Settings Editor, below). |
| `vpcCidr` | `10.0.0.0/16` | Validated as an IPv4 CIDR on write (`shared/src/deploymentSettingsWrite.ts:61-67`, `:97-98`). |
| `hostedZoneName` | none (required) | `withDeploymentConfigDefaults` requires it explicitly (`deploymentConfig.ts:322-345`). |
| `dnsTtl` | `30` | Positive integer. |
| `watchdogIntervalMinutes`, `watchdogIdleChecks`, `watchdogMinBytesPerSecond` | `15`, `4`, `1000` | Positive integers; baked into the stack at apply time by `iac/program`. |
| `baseAllowedGuilds`, `baseAdminUserIds`, `baseAdminRoleIds` | fresh `[]` per call | Arrays of 17-20 digit Discord snowflakes (`deploymentSettingsWrite.ts:82-87`, `:147-163`). |
| `discordApplicationId` | `''` | |
| `auditTableName` | `''` | Empty means "computed by the infra program" (`deploymentConfig.ts:142-152`). |
| `runsTableName` | `''` | Empty resolves to `${projectName}-runs` via `resolveRunsTableName` (`:259-261`); the table is created by the SDK at bootstrap, not by Pulumi (`:154-174`). |
| `gameServers` | none (required; `{}` is valid) | `Record<string, GameServerConfig>` keyed by game name (`:176-190`). |

Field names are camelCase except inside `gameServers`, whose entries keep `GameServerConfig`'s snake_case fields because that shape was already embedded across the validator, the service and the Games UI (`deploymentConfig.ts:6-12`).

Two helpers resolve the runs-table name so no caller forks the ternary: `resolveRunsTableName` (`:259`) for callers holding a parsed document, and `resolvePreApplyRunsTableName` (`:287-297`), which reads the object straight from the store and returns `undefined` on any failure so run gates work before the first apply has produced stack outputs (`:263-285`).

Reads are not schema-validated. `parseConfigContents` checks only that the text parses and decodes to a plain object, then casts (`DeploymentConfigService.ts:798-812`). `getTopLevelSettings` papers over missing fields from older documents by running `withDeploymentConfigDefaults` before stripping `gameServers` (`:404-423`); `getGameServers` does not default top-level fields because it only returns the map (`:821-836`). This is narrower than the intent that a configuration containing every supported field round-trips losslessly, deeply equal including boolean and numeric fields: the service's own writes round-trip because `serializeConfig` is `JSON.stringify(config, null, 2) + '\n'` (`DeploymentConfigService.ts:787-789`), but a malformed or lossy document is never rejected on read.

## Storage and Read Paths

### Transport

`DeploymentConfigService` depends only on the cloud-agnostic `RemoteFileStore` interface, resolved through the `REMOTE_FILE_STORE` token (`DeploymentConfigService.ts:241-251`). In production that is `AwsRemoteFileStore` (`cloud-aws/src/AwsRemoteFileStore.ts`), bound by `CloudProviderModule` to the configuration bucket, `ConfigService.getRegion()`, and the stored AWS credentials (`cloud-provider.module.ts:73-84`).

| Store method | Behaviour |
|---|---|
| `get(path)` (`AwsRemoteFileStore.ts:100-113`) | `GetObject`; returns `{ body, etag }` with the etag unquoted. Returns `undefined` on `NoSuchKey`, on HTTP 404, and also when S3 returns no body or no ETag (`:106`). |
| `getVersion(path, versionId)` (`:121-134`) | `GetObject` with `VersionId`; used by rollback to fetch a historic body. |
| `put(path, body, { ifMatch })` (`:145-173`) | `PutObject` with `IfMatch` only when an etag is supplied. HTTP 409 or 412 becomes `RemoteFileConflictError` (`:21`, `:164-170`); a response with no ETag throws. |
| `listVersions(path)` (`:188-217`) | Paginates `ListObjectVersions` on `IsTruncated` with both continuation markers, keeps exact-key matches only, sorts newest first. Satisfies the complete-version-listing requirement that rollback depends on: while a response reports `IsTruncated`, the next request passes `NextKeyMarker` / `NextVersionIdMarker` as `KeyMarker` / `VersionIdMarker`, accumulating every page before the key-match filter and newest-first sort; a single-page listing issues exactly one request. |

The object key is the fixed constant `CONFIGURATION_OBJECT_KEY`, so no environment override can redirect which S3 key a deployment uses (`deploymentConfig.ts:27-35`).

### Two read contracts

`fetchRawConfig` (`DeploymentConfigService.ts:563-574`) is the single raw read: it throws `ConfigurationNotConfiguredError` when no bucket is set (`:142-150`), a plain `Error` when the object is absent (`:570-572`), and otherwise returns the decoded text with its etag. Three public reads sit on top of it with deliberately different failure behaviour.

| Method | Cache | On failure |
|---|---|---|
| `getGameServers()` (`:300-338`) | In-memory, TTL `ConfigService.readEnvConfigCacheTtlMs()` (default 30 s, `ConfigService.ts:13`, `:194-200`) | Never rejects. Logs (`warn` for unconfigured, `error` otherwise) and resolves `[]`, which is negatively cached for the TTL. |
| `getRawConfig()` (`:351-353`) | Bypassed | Rejects. Returns `{ config, etag }`. |
| `getTopLevelSettings()` (`:418-423`) | Bypassed | Rejects. Returns defaulted settings plus etag. |

`isConfigured()` (`:286-288`) exists because `getGameServers` returns `[]` both for "no bucket" and "zero games", and wizard routing needs to tell them apart (`:276-285`).

The cache is a tri-state: `null` means never loaded, and a set entry carries `failed` to distinguish a real parse from a negatively cached failure (`DeploymentConfigService.ts:72-80`, `:22-31`). `invalidateCache()` clears it and bumps `cacheGeneration`, and a fetch only commits its result if the generation is unchanged when it resolves, so a slow in-flight read cannot resurrect pre-invalidation data with a fresh timestamp (`:230-239`, `:266-269`, `:308-334`). Every write path invalidates after its put (`:590-599`, `:381-390`).

`flattenGameServers` turns the map into `GameServer[]` with the key attached as `name`, passing each entry through `normalizeGameServer` so a legacy https entry without `webPort` reads in the current shape (`:821-836`). A document without a `gameServers` object yields `[]` with a `warn` (`:822-826`).

## Write Paths

All editing writes share `writeConfig` (`DeploymentConfigService.ts:590-599`): fetch the current raw head, apply a pure string-to-string mutation, `putRawConfig` with the caller's `expectedVersionId` as `ifMatch`, then invalidate the cache. `putRawConfig` (`:616-639`) re-checks the bucket, and on `RemoteFileConflictError` re-reads the head (swallowing a failure there) and throws `OptimisticLockError(expected, current?.etag)`, so callers see one conflict type regardless of provider.

The etag the caller holds is what makes this safe, not the internal re-read: `writeConfig` reads the head and writes it back with the *caller's* etag, so an edit made after the caller's read but before this put fails with a conflict. The parameter is named `expectedVersionId` throughout but always carries an etag, which is distinct from an S3 `versionId` (`:340-347`, `:444-445`).

| Write | Mutation | Guarded | Errors |
|---|---|---|---|
| `addGameServer(name, config, etag?)` (`:486-491`) | `insertGameServerEntry` (`:664-678`) | `ifMatch` when supplied | `GameServerEntryError` reason `invalid-name` (`GAME_NAME_PATTERN`, `:207-215`), `duplicate-name`, or `structural` (`:648-655`) |
| `updateGameServer(name, config, etag?)` (`:516-521`) | `replaceGameServerEntry` (`:683-692`) | `ifMatch` when supplied | `not-found`, `structural` |
| `removeGameServer(name, etag?)` (`:545-549`) | `removeGameServerEntry` (`:697-707`) | `ifMatch` when supplied | `not-found`, `structural` |
| `updateTopLevelSettings(patch, etag?)` (`:456-461`) | `applyTopLevelSettingsPatch` (`:731-739`) | `ifMatch` when supplied | `RunsTableRenameError` |
| `restoreRawConfig(raw)` (`:381-390`) | none; writes the given bytes verbatim | never | `RunsTableRenameError` |

Three rules are enforced inside the mutations rather than by callers.

- **`gameServers` is untouchable from settings.** `applyTopLevelSettingsPatch` always takes `gameServers` from the freshly parsed document and discards any `gameServers` key in the patch, because the patch arrives over IPC as plain JSON where `Omit` gives no runtime protection (`:434-441`, `:714-739`). The discard is silent: no log line records it.
- **The runs-table name cannot change after bootstrap.** `assertRunsTableNameStable` (`:756-780`) resolves the effective table name before and after, and throws `RunsTableRenameError` naming the contributing fields if it would move. It runs on every settings patch and on every restore (`:383-385`). The reason is written in code: `BootstrapService.ensureRunsTable` creates that DynamoDB table once at wizard time, so a later rename would point every resolver at a table that does not exist (`:153-179`).
- **Unknown top-level keys pass through.** `validateDeploymentSettingsPatch` only checks the fourteen known fields (`deploymentSettingsWrite.ts:49-79`), and `applyTopLevelSettingsPatch` spreads the whole remaining patch onto the document (`DeploymentConfigService.ts:735-738`), so an unrecognised key sent over IPC would be persisted.

`restoreRawConfig` reads the head only to run the rename guard against the restored document, then writes unconditionally. The code comment gives the rationale: rollback restores known historic content and appends a new S3 version rather than editing against an expected prior state (`:356-365`). What it does not cover is a game edit landing between that read and the put; game writes do not take the run lock, so such an edit would be overwritten without a conflict. The lock and orphaned-restore handling around restore live in `PulumiService` (`iac/run`).

`DeploymentConfigModule` provides the service and aliases it to the `DEPLOYMENT_CONFIG_SERVICE` token with `useExisting`, so `PulumiService` resolves the same singleton through `ModuleRef` without a static import that would close a module cycle (`desktop-main/src/modules/deployment-config.module.ts:17-37`).

## Settings Editor

The Settings page edits top-level settings through two IPC channels on `IacSettingsController` (`desktop-main/src/controllers/iac-settings.controller.ts`). Both log on entry and map every outcome to a discriminated result defined in `shared/src/deploymentSettingsWrite.ts:171-257`, so the renderer never sees a thrown error from this path.

| Channel | Payload | Result codes |
|---|---|---|
| `iac.settings.get` (`:128-142`) | none | `ok` with `settings` and `etag`; `setup_incomplete` for `ConfigurationNotConfiguredError`; `error` for anything else, including a missing object. |
| `iac.settings.update` (`:158-198`) | `{ patch, expectedVersionId? }` (`deploymentSettingsWrite.ts:257-260`) | `validation` with per-field `issues` (validator, or `RunsTableRenameError` mapped onto `projectName`/`runsTableName`, `:171-181`); `conflict` with expected and current etags (`:182-190`); `setup_incomplete`; `error`; or `ok` with re-read `settings`, new `etag` and `versionId`. |

On success `update` does a second read through `getTopLevelSettings` to return the stored settings (`:167-169`). If that read fails after the write succeeded, the catch reports `code: 'error'` although S3 already holds the new version. The `conflict` branch returns without a log line, and the generic branches log the raw error object (`:139`, `:195`), both against `.claude/rules/logging.md`.

`iac-settings.controller.ts` is this leaf's file, and the same controller class carries two further groups that are not part of this leaf's settings contract. `iac.settings.engineVersion` (`:210`) stays in this controller and is hosted on `iac/engine`'s behalf, which specifies its behaviour (`IAC-ENGINE-PIN-005`). The five `iac.settings.autoUpdate.*` channels (`:228-320`) belong to `operator-app/app-update-and-release` and move to a controller that leaf owns, keeping their channel names; until that move they are hosted here.

`validateDeploymentSettingsPatch` is the one validator, run both live in the renderer and again in the controller (`deploymentSettingsWrite.ts:49-79`). It checks only fields present in the patch: required non-empty strings (`hostedZoneName`, `projectName`), optional strings, IPv4 CIDR, positive integers for `dnsTtl` and the watchdog tunables, and snowflake arrays with per-index issue paths (`:110-163`). A patch that carries `awsRegion` is a validation issue, because the region is not a deployment setting (`CONFIG-SET-012`); today the validator still accepts any non-empty `awsRegion` (`deploymentSettingsWrite.ts:56`).

`useDeploymentSettings` (`web/src/hooks/use-deployment-settings.hook.ts:187-357`) holds a string-typed draft, the last-read etag, and the load state (`loading`, `loaded`, `setup_incomplete`, `error`). It sends every operator-editable top-level field, not a minimal diff, and never `awsRegion` (`CONFIG-FORM-003`; today `draftToPatch` still sends it, `:152-169`), and it refuses to save without an etag rather than fall back to an unconditional write (`:309-316`). Server `validation` issues replace live ones until the next edit; `conflict` shows a reload prompt; `setup_incomplete` and `error` show the message (`:327-347`). `DeploymentSettingsForm` (`web/src/components/deployment-settings-form.component.tsx`) renders the fields in four groups, uses the `discord-bot` leaf's `SnowflakeChipsInput` for the allowlists (`:195-230`), and shows `projectName` and `runsTableName` as ordinary editable inputs even though any change that moves the resolved runs-table name is rejected server-side (`:86`, `:252`). It shows the install's AWS region, the wizard region, as read-only text with a note that moving to another region means destroying the stack, deleting the bootstrap resources and resetting the app (`CONFIG-FORM-007`); today it renders an editable free-text input bound to `DeploymentConfig.awsRegion` (`:91-94`), and a save from it changes where the next apply provisions, replacing the whole stack, EFS world saves included.

## Drift Detection

Drift answers "what would the next apply change" at a per-game granularity, for the pending-changes banner on the dashboard and games pages and for the drift chips owned by `game-server`.

`DriftService.getDrift()` (`desktop-main/src/services/DriftService.ts:206-218`), behind `drift.get` (`desktop-main/src/controllers/drift.controller.ts:18-22`), invalidates the config cache, reads `getGameServers()`, reads `ConfigService.getStackOutputs()`, and delegates to the pure `computeDriftFromOutputs` (`:167-171`). It deliberately does not invalidate the stack-outputs cache, because that read resolves the Pulumi engine and the S3 backend and is expensive to repeat on every poll (`:190-205`). A failure is logged at `warn` and rethrown as a plain `Error` (`:213-217`).

`computeDriftFromOutputs` takes the applied map from `outputs.appliedGameServers` and the deployed set from its keys, falling back to the older `gameNames` output when the applied map is absent (`:168-169`). `computeDrift` (`:123-157`) then classifies, with entry types in `shared/src/drift.ts:17-54`:

| Kind | Condition |
|---|---|
| `pending_create` | Declared, not in the deployed set (`:134-137`). |
| `config_drift` | Declared, deployed, present in the applied map, and at least one compared field differs; `changedFields` lists them in `COMPARED_FIELDS` order (`:139-147`, `:83-89`). |
| `pending_delete` | Deployed, not declared (`:150-154`). |
| no entry | In sync, or declared and deployed but missing from the applied map (`:139-142`), which only happens on legacy stacks without `appliedGameServers`. |

Only `image`, `cpu`, `memory`, `ports` and `volumes` are compared (`DriftService.ts:13-20`; closed type at `shared/src/drift.ts:26`). `webPort` is appended to the `ports` value as a marker entry rather than having its own field (`:17-18`). Both sides pass through `normalizeGameServer` so a snapshot applied before `webPort` existed compares in the current shape (`:80-82`). `ports` and `volumes` compare as order-insensitive sets of key-sorted entries (`:49-67`); other fields compare by `JSON.stringify` (`:27-29`). Fields such as `environment`, `command`, `https`, `healthCheck` and `pinnedHostname` never produce drift, and top-level settings are not diffed at all.

Because `getGameServers` resolves `[]` on any read failure, a transient S3 or parse error makes `computeDrift` report every deployed game as `pending_delete`, and the banner shows it as pending work. `games.controller.ts:58` and `GamesWriteService.ts:333` reach `computeDriftFromOutputs` with the same declared list and inherit the same behaviour.

`PendingChangesBanner` (`web/src/components/pending-changes-banner.component.tsx:81-180`) polls `drift.get` immediately and every 30 s (`:7`, `:114-134`), discards out-of-order responses with a request counter (`:94-100`), hides itself on a failed poll (`:108-111`), and shows counts per kind with links to the Infrastructure and Games pages (`:144-178`). Dismissal stores a signature of the sorted `game:kind:changedFields` tuples in `sessionStorage` (`:14`, `:56-61`, `:166-171`); the banner reappears when the signature changes and the stored dismissal is cleared when a clean report arrives (`:102-107`). Each poll is one S3 GET because `getDrift` invalidates the cache first, which also evicts the cache other callers share.

### Rollback diff

`diffDeploymentConfig(previous, current)` (`shared/src/deploymentConfig.ts:471-487`) is a separate, coarser comparison for the `iac-rollback` confirmation dialog: which top-level fields changed and which game keys were added, removed or changed, without before/after values or per-field detail inside a game (`:356-363`, `:434-470`). It walks the hand-maintained `DEPLOYMENT_CONFIG_SCALAR_FIELDS` list (`:383-407`) and compares non-scalars with key-order-insensitive `canonicalJson` (`:413-433`). It returns `DeploymentConfigDiff` (`:364-381`). `canonicalJson` and drift's `canonicalStringify` (`DriftService.ts:38-48`) are two implementations of the same key-sorted serialisation.

## Decisions & Alternatives

| Decision | Chosen | Alternatives Considered | Rationale |
|---|---|---|---|
| Configuration source | Versioned S3 object only; unconfigured is a typed error | Local file fallback (the previous local-file mode) | Every write goes through the `RemoteFileStore` contract and so inherits conditional locking and version history; the unguarded synchronous local write path was deleted, not patched (`DeploymentConfigService.ts:5-14`). With no bucket configured, reads report setup incomplete. |
| Document format | Plain JSON, `JSON.stringify` with 2-space indent | HCL `terraform.tfvars` (retired) | Writing configuration must not require parsing or emitting HCL, and the app depends on no HCL parser; the Pulumi program reads the JSON directly (`deploymentConfig.ts:13-17`). |
| Drift field set | Closed: `image`, `cpu`, `memory`, `ports`, `volumes` | Diff every `GameServerConfig` field and the top-level settings | The set is deliberately closed; `environment`, `command`, `https`, `healthCheck` and `pinnedHostname` are outside it. Whether `pinnedHostname` should be added, or the banner should state the narrowed scope, is Deferred question 5 (`CONFIG-DRIFT-008`). |
| Concurrency control for edits | Read-mutate-put with caller-supplied etag as `IfMatch`, mapped to `OptimisticLockError` | Locking via the run lock; last-write-wins | Written in `DeploymentConfigService.ts:37-43`: callers handle one conflict type regardless of cloud provider. Not taking the run lock is `[inferred]` to keep game edits available during a run. |
| Rollback restore | Unconditional verbatim put of historic bytes | Conditional put against the etag read for the rename guard | Written in `DeploymentConfigService.ts:360-365`: rollback restores known historic content, not an edit against an expected state. The race with concurrent game edits is not addressed (see Deferred). |
| Read failure behaviour | `getGameServers` never rejects and negatively caches `[]`; editor reads reject | One rejecting read for all callers | Written in `DeploymentConfigService.ts:32-35`, `:340-350`, `:404-417`: pollers degrade gracefully, editors must know the source is unreadable. |
| Game list cache | In-process TTL cache (default 30 s) with a generation counter | No cache; event-driven invalidation only | Written in `DeploymentConfigService.ts:21-31`, `:230-239`: frequent callers should not re-fetch every call, and a late fetch must not resurrect stale data. |
| Runs-table name after bootstrap | Reject any change to the resolved name with `RunsTableRenameError` | Allow and migrate; allow and recreate | Written in `DeploymentConfigService.ts:153-179`: the table is created once by the SDK at bootstrap, and a rename would surface as a raw `ResourceNotFoundException`. |
| `gameServers` vs settings | Settings patch can never touch `gameServers`, enforced at runtime | Type-only `Omit` protection | Written in `DeploymentConfigService.ts:434-441`: the patch crosses IPC as plain JSON where `Omit` offers no protection. |
| Settings validation location | One shared validator run in renderer and controller | Separate client and server rules | `[inferred]` from both call sites (`use-deployment-settings.hook.ts:287`, `iac-settings.controller.ts:162`): one rule set cannot drift between layers. |
| Settings IPC error shape | Discriminated `{ ok: false, code }` results, never a thrown error | Throwing and relying on the IPC bridge's normaliser | `[inferred]` from `deploymentSettingsWrite.ts:171-257`: the form needs per-field issues and a distinct conflict state. |
| Read-time schema handling | Cast after a plain-object check; default top-level fields on the settings read | Full schema validation on read | Partly written (`DeploymentConfigService.ts:407-417`: defaulting stops older documents crashing the form). Not validating further is `[inferred]`. |
| Drift input for "applied" | `appliedGameServers` stack output, falling back to `gameNames` | Live ECS task-definition inspection; Pulumi preview | `[inferred]` from `DriftService.ts:91-122`: a pure, cheap comparison that a 30 s poll can afford, unlike a preview. |
| Drift field scope | Five fields: image, cpu, memory, ports (with webPort), volumes | Whole-entry comparison | `[inferred]`; no rationale is written for omitting the other `GameServerConfig` fields. |
| Banner dismissal | Session-scoped signature of the pending set | A plain "hidden" flag; persisted dismissal | Written in `docs/docs/app/dashboard.md:211-219`: the banner returns as soon as the pending set changes. |
| Service wiring for `PulumiService` | `DEPLOYMENT_CONFIG_SERVICE` token aliased with `useExisting` | Static module import | Written in `deployment-config.module.ts:17-31`: a static edge would close a real module cycle. |
| Region in Settings | Read-only display of the wizard region with the destroy-and-re-run note; a patch carrying `awsRegion` is rejected | Editable free-text field written to `deployment-config.json`; an editable dropdown over `AWS_REGIONS` | An install has one region, chosen in the first-run wizard; editing it replaces the whole stack, EFS world saves included, so moving regions is a deliberate destroy-and-rebuild, never a settings edit (`docs/high-level-design.md`, decision 10). |
| Ownership of `iac-settings.controller.ts` | This leaf owns the file with `iac.settings.get`, `iac.settings.update` and `iac.settings.engineVersion`; the five `iac.settings.autoUpdate.*` channels move to a controller owned by `operator-app/app-update-and-release`, channel names unchanged | Whole file owned by this leaf, hosting the auto-update channels on `app-update-and-release`'s behalf; whole file owned by `app-update-and-release` | Every controller belongs to the leaf whose behaviour it serves (`ipc-bridge-design.md`, "What it deliberately does not own"). `enableAutoUpdate` is a local electron-store flag, not a `DeploymentConfig` field (`autoUpdateSetting.ts:1-9`), so the auto-update channels are not this leaf's; the settings channels read and write `deployment-config.json`, so they are not `app-update-and-release`'s. |

## Open Questions & Future Decisions

### Resolved

1. ✅ Version listing must paginate so rollback can find the correct prior version, implemented at `AwsRemoteFileStore.ts:188-217`.
2. ✅ No local fallback: the S3 configuration bucket is the only configuration source, implemented at `DeploymentConfigService.ts:563-567`.
3. ✅ `iac.settings.get`, `iac.settings.update` and `iac.settings.engineVersion` stay in `iac-settings.controller.ts`, owned by this leaf; the five `iac.settings.autoUpdate.*` channels move to a controller owned by `operator-app/app-update-and-release`, keeping their names (Decisions & Alternatives, "Ownership of `iac-settings.controller.ts`"; `docs/arrows/deployment-config.md`, Should Fix).
4. ✅ The configuration `RemoteFileStore` reads `deployment-config.json` from the wizard region through `ConfigService.getRegion()`, like every other desktop store; `awsRegion` in the document is not a region anything reads from, and Settings cannot edit it (`IAC-ENGINE-REGION-002`, `CONFIG-FORM-007`, `CONFIG-SET-012`; `docs/high-level-design.md`, decision 10).

### Deferred

1. Should drift use a rejecting read, or return an explicit "declared state unknown" result, so a transient config read failure stops reporting every deployed game as `pending_delete`? (`DriftService.ts:210`, `:150-154`; `DeploymentConfigService.ts:318-337`)
2. Should `restoreRawConfig` be conditional on the etag it already reads for the rename guard, so a game edit between that read and the put fails instead of being overwritten? (`DeploymentConfigService.ts:381-390`)
3. Should `iac.settings.get` distinguish "bucket configured, object missing" from a generic error, and should an ETag-less or body-less S3 response be an error rather than "not found"? (`DeploymentConfigService.ts:570-572`; `iac-settings.controller.ts:139-140`; `AwsRemoteFileStore.ts:106`)
4. Should `iac.settings.update` return success when the write succeeded but the follow-up read failed, for example by returning the patched document it just wrote? (`iac-settings.controller.ts:167-169`, `:195-196`)
5. Should drift cover the remaining `GameServerConfig` fields and the top-level settings, or should the banner copy state its narrower scope? (`DriftService.ts:13-20`; `shared/src/drift.ts:26`)
6. Who adds direct tests for `computeDriftFromOutputs`, including the `gameNames` fallback? (`DriftService.ts:167-171`; no reference in `DriftService.test.ts`)
7. Should drift and the rollback diff share one canonical-JSON helper? (`DriftService.ts:38-48`; `deploymentConfig.ts:413-420`)
8. Should `DEPLOYMENT_CONFIG_SCALAR_FIELDS` be type-checked for completeness (for example `satisfies` against a `Record` of every key) so a new top-level field cannot silently drop out of the rollback diff? (`deploymentConfig.ts:392-407`) A proposed top-level VPC flow-logs toggle would be exactly such a new field.
9. Should drift stop invalidating the shared config cache on every 30 s poll? (`DriftService.ts:209`; `pending-changes-banner.component.tsx:126-128`)
10. Should the `conflict` branch log, and should the generic branches log `.message` rather than the raw error object, per `.claude/rules/logging.md`? (`iac-settings.controller.ts:139`, `:182-190`, `:195`)
11. Should `applyTopLevelSettingsPatch` drop and log unknown keys instead of persisting them, and log when it discards a `gameServers` key? (`DeploymentConfigService.ts:731-739`; `deploymentSettingsWrite.ts:49-79`)
12. Should the settings form render `projectName` and `runsTableName` read-only after bootstrap, given the server always rejects a change that moves the resolved runs-table name? (`deployment-settings-form.component.tsx:86`, `:252`; `DeploymentConfigService.ts:756-780`)
13. Should reads validate against the `DeploymentConfig` shape so a lossy document is rejected, closing the gap with the lossless round-trip intent? (`DeploymentConfigService.ts:798-812`)
14. Should `expectedVersionId` be renamed to reflect that it carries an etag, and should the IPC test double stop using its `versionId` as the etag? (`DeploymentConfigService.ts:444-445`; `desktop-main/src/test-mocks/remote-file-store-mock.ts`)
15. Stale comments to clean: "Local-vs-S3" (`DeploymentConfigService.ts:223`), "from disk/S3" (`:264`), "retired HCL format" (`:782-785`), "HCL/JSON key order" (`DriftService.ts:34`), `GET /api/drift` (`DriftService.ts:196`; `drift.ts:46`), an issue number (`drift.ts:5`), "`game_servers` map key" (`drift.ts:33`), and a dangling module-doc reference in `use-deployment-settings.hook.ts:148-150`.
16. The mapping sweep said `diffDeploymentConfig` returns `ChangeSummary`; the code returns `DeploymentConfigDiff` (`deploymentConfig.ts:364`, `:471`). The sweep also said the banner signature depends on `changedFields` order; it does not, because `changedFields` follows `COMPARED_FIELDS` order and signatures are sorted (`DriftService.ts:83-89`; `pending-changes-banner.component.tsx:59`). Both are recorded here so the boundary rulings can be corrected.
17. Should `DeploymentConfig.awsRegion` be removed and the install region passed to the infra program as a program option (as `lambdaBundlesDir` is), rather than kept in the stored document and overwritten from `ConfigService.getRegion()` (`IAC-ENGINE-REGION-001`)? Either satisfies the specs; removal also stops `APP-DIAG-BNDL-008` reporting a stored value the program ignores.

## References

- Arrow doc: `docs/arrows/deployment-config.md`
- EARS specs: `docs/intent/deployment-config/deployment-config-specs.md` (prefix `CONFIG`)
- HLD: `docs/high-level-design.md`
- Docs pages: `docs/docs/architecture.md`, `docs/docs/components/management-app.md`, `docs/docs/components/infra.md`, `docs/docs/app/settings.md`, `docs/docs/app/dashboard.md` (pending-changes banner), `docs/docs/app/iac.md` (rollback), `docs/docs/setup.md`
- Neighbouring leaf designs: `docs/intent/game-server/game-server-design.md`, `docs/intent/iac/program/program-design.md`, `docs/intent/iac/run/run-design.md`, `docs/intent/iac/engine/engine-design.md`, `docs/intent/operator-app/wizard-and-bootstrap/wizard-and-bootstrap-design.md`, `docs/intent/operator-app/desktop-shell/desktop-shell-design.md`, `docs/intent/game-runtime/watchdog/watchdog-design.md`, `docs/intent/discord-bot/discord-bot-design.md`
