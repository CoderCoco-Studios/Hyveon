---
title: Management app
sidebar_position: 3
---

# Management app

A TypeScript npm-workspaces monorepo under `app/`, itself one workspace tree
of the repository-root `package.json` workspaces list. It ships as a
packaged **Electron desktop app** — five non-Lambda packages make up the
local control plane: a Nest.js backend (`desktop-main`), a React dashboard
renderer (`web`), a pure shared library (`shared`), an AWS implementation of
the cloud-agnostic contracts (`cloud-aws`), and the Electron preload bridge
(`desktop-preload`) — plus the five Lambda packages documented
[here](/components/lambdas). There is no HTTP server and no bearer token
anywhere in this app: the renderer talks to the backend exclusively over
Electron IPC, via `window.hyveon` (the `desktop-preload` bridge).

Install everything from the root:

```bash
npm install
```

Dev mode (`npm run desktop:dev`) launches the full Electron app with
hot-reload on renderer saves; electron-vite serves the renderer for HMR
purposes only, never as a network API surface. See the [setup guide](/setup)
for the packaged-installer build.

## `@hyveon/shared`

`app/packages/shared` — zero-runtime-dependency TypeScript consumed by the
server **and** the four core Lambdas (interactions, followup, update-dns,
watchdog — `efs-seeder` has no dependency on it). The canonical location for cross-boundary
types and permission logic.

| Module | Purpose |
|---|---|
| `types.ts` | `DiscordAction`, `DiscordConfig`, `RedactedDiscordConfig`, `GameStatus`, `StartResult`, `PendingInteraction`. The API shapes every other package agrees on. |
| `canRun.ts` | The pure permission-check function. Order: **guild allowlist → admin user/role → per-game user/role + action**. Imported verbatim by the Nest server and both Discord Lambdas. |
| `commands.ts` | `COMMAND_DESCRIPTORS` — static JSON for the four slash commands. `actionForCommand(name)` maps to the `start`/`stop`/`status` bucket used by `canRun()`. |
| `sanitize.ts` | `isSafeGameKey()` (blocks `__proto__`, `constructor`, `prototype`), `asString()`, `asStringArray()`, `sanitizeGamePermission()`. Applied on DDB reads where input is operator-provided. |
| `gameServerPorts.ts` | `HTTPS_CONNECT_PORT` / `ConnectPort`, `ingressPorts(game)` (ports that get ingress — excludes a tcp duplicate of `webPort`), and the deprecated `normalizeGameServer` read-time normaliser for legacy https configs (`ports[0]` → `webPort`). `normalizeDeploymentConfigGames` applies it to a whole config. Applied in `DeploymentConfigService` reads, `PulumiService`'s raw preview/apply/rollback-diff reads, `GameWizardDraftService`'s draft backfill and `DriftService`'s comparison. |
| `formatStatus.ts` | `formatGameStatus(status)` — Discord-ready one-liner with emoji and hostname. |
| `ddb/client.ts` | Lazy DynamoDB DocumentClient. Region fallback: `AWS_REGION_` → `AWS_REGION` → `AWS_DEFAULT_REGION` → `us-east-1`. |
| `ddb/configStore.ts` | `getDiscordConfig()` / `putDiscordConfig()` for the `CONFIG#discord` row. |
| `ddb/pendingStore.ts` | `getPending()` / `putPending()` / `deletePending()` for `PENDING#{taskArn}`. `putPending()` sets `expiresAt = now + 15 minutes` so DDB TTL reaps stale rows. |
| `secrets/secretsStore.ts` | Secrets Manager wrapper with a 5-minute in-process cache. Recognises the infra program's `"placeholder"` seed value as "not configured". `invalidateSecretsCache()` is called by the Nest credentials endpoint. Also owns the app-owned health-check credential secret's full write lifecycle — `healthCheckAuthSecretName(gameId)` (deterministic name `hyveon-{gameId}-healthcheck-auth`, one per game), `upsertHealthCheckAuthSecret()` (tries `PutSecretValueCommand` first, falls back to `CreateSecretCommand` only on `ResourceNotFoundException` — no separate existence check; if the same name is still within its recovery window from a prior `deleteHealthCheckAuthSecret()`, both commands instead fail with `InvalidRequestException`, confirmed via `DescribeSecretCommand`'s `DeletedDate`, so this un-schedules the deletion with `RestoreSecretCommand` and retries the put once), and `deleteHealthCheckAuthSecret()` (default recovery window, no-op if already absent). See [Games](/app/games#health-check-optional) for the operator-facing credential-type model this backs. |
| `deploymentConfig.ts` | `DeploymentConfig` — the app's configuration source of truth, persisted verbatim as `deployment-config.json` in the operator's S3 configuration bucket. `gameServers: Record<string, GameServerConfig>` is the single source of truth every per-game resource fans out from. |
| `gameServerConfig.ts` | `GameServerConfig` (aliased `GameServer`) — the canonical per-game container configuration shape embedded in `DeploymentConfig.gameServers`; deliberately reuses `snake_case` field names already load-bearing across the validator, `DeploymentConfigService`'s JSON read/write paths, and the Games UI. |
| `gameServerValidator.ts` | `gameServerSchema` (zod structural schema for one `game_servers` entry) plus `validateGameServer` (cross-entry business rules — port collisions, Fargate CPU/memory pairing, absolute paths, connect-message placeholders, HTTPS port constraints, `webPort` rules) — shared by the desktop-main API and the web client's form validation. |
| `cloud.ts` | The cloud-agnostic contracts (`CloudProvider`, `SecretsStore`, and the other five tokens `CloudProviderModule` binds) — no `@aws-sdk/*` shapes appear here; concrete implementations live in `@hyveon/cloud-aws`. |
| `iamPolicy.ts` | `HYVEON_DEPLOY_ALL_ACTIONS` — the flattened, deduplicated action set mirroring the `HyveonDeployAll` inline IAM policy documented in `docs/docs/setup.md`; drives the first-run wizard's `iam:SimulatePrincipalPolicy` permission check. |
| `stackOutputs.ts` | `StackOutputs` — the typed contract for every value the app reads back off a deployed Pulumi stack (`PulumiService.getStackOutputs()`), including `domainName`, cluster/subnet/security-group IDs, and per-game `appliedGameServers` for drift detection. |
| `pulumiVersion.ts` | `PULUMI_ENGINE_VERSION` — the exact Pulumi engine version the app provisions and runs against, matching the `@pulumi/pulumi` dependency pinned in both `desktop-main` and `infra`. |
| `folderUpload/` | The `@hyveon/shared/folderUpload` subpath export (deliberately outside the barrel): folder-upload types (`FolderScanResult`, `FolderUploadRequest`, `FolderUploadProgress`, `OverwriteSummary`, `StrayHelperReport`, …) and the path helpers `planUpload`, `toRemotePath` and `validateDestination` shared by main and renderer. |
| `volumeFiles/` | The `@hyveon/shared/volumeFiles` subpath export (also outside the barrel): the volume path helpers (`normalizeVolumePath`, `joinVolumePath`, `isValidEntryName`, `VolumePathError`) and the IPC shapes of the embedded file browser in `types.ts` — `VolumeSessionStatus`, `VolumeRef`, `VolumeEntryInfo`, `VolumeListing`, `VolumeTextFile`, `VolumeTransferProgress`, the `VolumeResult<T>` / `VolumeFilesErrorCode` result envelope, `MAX_TEXT_EDIT_BYTES` (1 MiB), and the two push-channel names `VOLUME_FILES_SESSION_CHANNEL` / `VOLUME_FILES_TRANSFER_CHANNEL`. None of these shapes has a field for a credential, address, URL or helper-side path. |

**Invariants**: `canRun()` lives in exactly one place; the four slash
commands are JSON descriptors, not classes; secrets' raw values never
leave this package's own callers.

## `@hyveon/desktop-main`

`app/packages/desktop-main` — a Nest.js app running as an **Electron IPC
microservice** (`NestFactory.createMicroservice`), not an HTTP server. The
boot sequence in `src/main.ts` (invoked from `electron-entry.ts` after
`app.whenReady()`):

1. Guards against running outside an Electron main process — `desktop-main`
   throws immediately if `process.versions.electron` is unset, rather than
   silently doing nothing under plain Node.
2. `NestFactory.createMicroservice(AppModule, { strategy: new BridgedElectronIPCTransport() })`.
3. `app.useGlobalFilters(new RpcErrorMessageFilter())` — must run before
   `app.listen()`, since NestJS reads global filters while wiring up each
   `@MessagePattern` handler during `listen()`.
4. `app.listen()` starts the transport, registering its internal
   `@MessagePattern` dispatch.
5. `registerIpcMainBridges(strategy)` bridges each of those patterns onto a
   real `ipcMain.handle` registration, so `ipcRenderer.invoke` calls from
   the renderer resolve instead of hanging.

A global `RpcErrorMessageFilter` (`src/rpc-error-message.filter.ts`, `@Catch()`
with no arguments) is registered via `app.useGlobalFilters(new
RpcErrorMessageFilter())` between `createMicroservice` and `app.listen()` (step
2 above) — NestJS's `RpcExceptionsHandler` invokes it in place of the default
`BaseRpcExceptionFilter` for every `@MessagePattern` handler. Without it,
anything that isn't itself an `RpcException` is reduced to the generic string
`'Internal server error'` by NestJS's own `handleUnknownError()`, discarding
the handler's real message before it ever reaches `ipc-main-bridge.ts`'s
`firstValueFrom` unwrapping — no amount of unwrapping downstream can recover
text that's already gone. The filter re-emits the exception as a rejected
Observable carrying only its real `.message` (via `@hyveon/shared`'s
`errMessage`), so the operator/renderer see the actual failure instead of a
generic one. `registerIpcMainBridges` is still the structural choke point that
turns that rejection into a plain `Error` object safe for Electron's
structured-clone (a raw SDK/Node error carrying non-plain fields like
`$metadata` otherwise fails the clone, surfacing as `Error: An object could
not be cloned` and leaving the caller's `invoke()` promise unresolved) and
logs the pattern name and original message/stack via the winston `logger`.

There is no listen port, no `NODE_ENV=production` bearer-token check, and no
static-file serving — the renderer is a separate Electron `BrowserWindow`
loading the built Vite bundle (or the Vite dev server in dev mode), and it
never speaks HTTP to this process.

### Module graph

- **`AppModule`** — root. Imports `AwsModule`, `DiscordModule`,
  `DeploymentConfigModule`, `RunRecordModule`, `PulumiEngineModule`,
  `PulumiWorkspaceModule`, `PulumiServiceModule`, `WizardModule`,
  `ElectronStoreModule`, `FolderUploadModule`, `NativeDialogModule`,
  `VolumeFilesModule`, and `VolumeFilesApiModule` (thirteen imports; `ConfigModule` and
  `CloudProviderModule` are **not** direct imports — they arrive
  transitively through `AwsModule`/`DeploymentConfigModule`/`RunRecordModule`, each of
  which imports both). Also directly provides a handful of
  controller-adjacent services that don't warrant their own module
  (`DiagnosticsService`, `DiagnosticsBundleService`, `DriftService`,
  `GamesWriteService`, `AuditService`, `GameWizardDraftService`,
  `WindowService`) plus the `DIAGNOSTICS_LOG_DIR` token.
- **`ConfigModule`** — imports `ElectronStoreModule` and `PulumiServiceModule`
  (so `ConfigService` can inject `PulumiService`); provides just
  `ConfigService`. Extracted on its own so every other feature module can
  depend on it without pulling in `AwsModule`.
- **`CloudProviderModule`** — imports `ConfigModule` and `ElectronStoreModule`. Binds seven
  cloud-agnostic contracts (from `@hyveon/shared/cloud.js`) to concrete
  `@hyveon/cloud-aws` implementations via `useFactory` providers keyed off
  `ConfigService.getActiveCloud()`: `CLOUD_PROVIDER`, `SECRETS_STORE`,
  `REMOTE_FILE_STORE`, `DISCORD_RECEIVER`, `AUDIT_LOG_STORE`,
  `DISCORD_CONFIG_STORE`, and `RUN_RECORD_STORE` (all declared in
  `cloud-provider.tokens.ts`). Consumers
  inject via `@Inject(CLOUD_PROVIDER)` etc. and depend only on the
  `@hyveon/shared` interface — never the concrete AWS class — so swapping the
  active cloud is a one-module change, not a call-site hunt. Today every
  token still resolves to AWS; a future non-AWS provider is added by
  extending the `CLOUD_BINDINGS` registry in `cloud-provider.module.ts`, not
  by touching this module's provider definitions.
- **`AwsModule`** — imports `ConfigModule`, `CloudProviderModule`,
  `ElectronStoreModule`, and `DeploymentConfigModule` (re-exporting the first
  two); provides and exports `Ec2Service`, `EcsService`,
  `LogsService`, `CostService`, `SchedulerService`, `FileManagerService`. The
  `ElectronStoreModule` import lets `Ec2Service`/`EcsService` inject
  `ElectronStoreService` to resolve AWS credentials for their own raw
  `EC2Client`/`ECSClient`; the `DeploymentConfigModule` import lets
  `LogsService` inject `DeploymentConfigService` to resolve the operator's
  configured `projectName` when building a Lambda function's log group name.
  It
  no longer provides
  `ConfigService` directly (that's `ConfigModule`'s job — `AwsModule`
  re-exports it for existing consumers that import `AwsModule` expecting
  `ConfigService` to be available) and no longer wires `AwsCloudProvider`/
  `AwsSecretsStore` itself — `EcsService` injects `CLOUD_PROVIDER` and
  `DiscordConfigService` injects `SECRETS_STORE` and `DISCORD_CONFIG_STORE`,
  all bound by `CloudProviderModule`. `DISCORD_CONFIG_STORE` (bound to
  `AwsDiscordConfigStore`) is what gives `DiscordConfigService`'s DynamoDB
  reads/writes the wizard's resolved AWS credentials — before this token
  existed, the service read/wrote through `@hyveon/shared`'s uncredentialed
  `getDocClient()` singleton, which falls back to the SDK's default provider
  chain and throws a spurious `CredentialsProviderError` ("Your session has
  expired") in the GUI-launched Electron process once any unrelated ambient
  `aws login` session on the host expires.
- **`DiscordModule`** — imports `AwsModule`; provides
  `DiscordConfigService` and `DiscordCommandRegistrar`. No discord.js,
  no gateway — the bot is two Lambdas plus Discord's REST API.
- **`DeploymentConfigModule`** — imports `ConfigModule` and `CloudProviderModule`
  (for the `REMOTE_FILE_STORE` token); provides `DeploymentConfigService`, the
  S3-backed deployment-config JSON reader/parser. There is no local-file
  fallback — see [`DeploymentConfigModule` / `DeploymentConfigService`](#deploymentconfigmodule--deploymentconfigservice)
  below.
- **`RunRecordModule`** — imports `ConfigModule` and `CloudProviderModule`;
  provides `RunService` (the in-memory + DynamoDB apply lock guarding
  plan/apply/destroy submissions) and `RunRecordService` (run-history
  persistence), bound to the narrow `RUN_LOCK_SERVICE`/`RUN_RECORD_PERSISTER`
  DI tokens that `PulumiService` resolves lazily.
- **`PulumiEngineModule`** — imports nothing; provides `PulumiEngineService`,
  which resolves and provisions the pinned Pulumi CLI engine into an
  app-owned directory (never `~/.pulumi`, never `PATH`) without requiring
  the operator to install anything.
- **`PulumiWorkspaceModule`** — imports `PulumiEngineModule` and
  `ElectronStoreModule`; provides `PulumiWorkspaceService`, the Automation
  API `LocalWorkspace`/S3-backend/secrets-passphrase seam behind
  `getOrCreateStack()`.
- **`PulumiServiceModule`** — imports `PulumiWorkspaceModule`,
  `PulumiEngineModule`, and `ElectronStoreModule`; provides `PulumiService`,
  the plan/apply/destroy/rollback + `getStackOutputs()` engine service. It
  deliberately does **not** import
  `RunRecordModule`, `CloudProviderModule`, or `DeploymentConfigModule` — those would
  close a native-ESM module cycle through `ConfigModule` — so `PulumiService`
  resolves `RUN_RECORD_PERSISTER`, `REMOTE_FILE_STORE`, and the `DeploymentConfigService`
  it needs at call time via `ModuleRef.get(token, { strict: false })` instead
  of constructor injection.
- **`WizardModule`** — imports `ElectronStoreModule`, `ConfigModule`, and
  `DeploymentConfigModule`; provides
  `AwsProfileService`, `BootstrapService`, `IamCheckService`,
  `FirstRunWizardService`, `GuidedIamService`, and `CloudHealthService`
  for the first-run setup wizard and the Settings page's Cloud Health
  checklist (`CloudHealthController`). `CloudHealthService` additionally
  injects `ConfigService` (for `getRegion()`, building its `IAMClient`) and
  resolves the operator's configured project name via
  `DeploymentConfigModule` for its `HyveonDeployAll` remediation policy.
  `GuidedIamService` backs the guided-IAM step: renders the
  `iam-bootstrap.yaml` CloudFormation template, hands off to the console,
  intakes the operator-pasted bootstrap key, and performs the mandatory
  mint-then-revoke rotation onto a freshly-minted key pair — plus a
  standalone manual-revoke action for the rotation's failure path.
  `PrerequisiteService` was deleted (`migrate-iac-to-pulumi` change, tasks
  10.1/10.2) along with the wizard's old prerequisites step.
- **`ElectronStoreModule`** — provides `SafeStorageService` (OS-keychain
  encryption) and `ElectronStoreService` (the typed `electron-store`
  consumer built on top of it). See
  [Credential storage at rest](#credential-storage-at-rest) below.
- **`NativeDialogModule`** — no imports; provides and exports `NativeDialogService`, the one wrapper around Electron's open/save dialogs. `AppModule` (for `DiagnosticsController`), `FolderUploadModule` (for `FolderScanService`) and `VolumeFilesApiModule` (for `VolumeFilesService`) import it, so no dialog consumer keeps a private copy of the guarded `electron` dialog import (`DiagnosticsController` still loads `electron` itself, via `createRequire`, for `shell.showItemInFolder`).
- **`VolumeFilesApiModule`** — imports `AwsModule`, `DeploymentConfigModule`, `VolumeFilesModule`, `FolderUploadModule` and `NativeDialogModule`; provides and exports `VolumeFilesService`, the service behind `VolumeFilesController`. It is separate from `VolumeFilesModule` because `FolderUploadModule` already imports `VolumeFilesModule`, and the service needs the folder-upload providers (`FolderScanService`, `FolderUploadService`) for folder uploads — so it lives in its own module rather than in `VolumeFilesModule`.

### Controllers and IPC channels

Every controller is IPC-only: handlers are bound to a channel name via
`@MessagePattern()`/`@Payload()` — there are no HTTP routes anywhere in this
app. The renderer calls into these via `window.hyveon.*` (the preload bridge),
which forwards to `ipcRenderer.invoke(channel, ...)`. The one exception is
`window.maximizedChange`, a one-way main → renderer push (`webContents.send`,
consumed via `ipcRenderer.on`) rather than an `invoke`d request/response —
called out again in the `WindowController` row below.

| Controller | Representative channels | Purpose |
|---|---|---|
| `GamesController` | `games.list`, `games.status`, `games.getStatus`, `games.start`, `games.stop`, `games.create`, `games.update`, `games.delete`, `games.draft.get`, `games.draft.save`, `games.draft.updateStepIndex`, `games.draft.clear` | List/read status, trigger RunTask/StopTask (`games.start` is refused with `{ success: false, message }`, without calling ECS, while `HelperSessionRegistry.hasUploadHolders(game)` reports any `upload:*` holder — a volume-files upload transfer or a folder-upload run (a download transfer holds `download:*`, which does not block a start; a session that is stopping still counts, so a start stays refused until teardown has stopped the helper and dropped the session); the Discord `/server-start` path runs in a Lambda and can't see the desktop registry, so it is not covered), manage `gameServers` entries in the JSON configuration object (`deployment-config.json`) via `DeploymentConfigService`. Invalidates `DeploymentConfigService`'s cache on list/status reads so a config edit made outside the app (e.g. by another operator) is picked up without restarting; `ConfigService`'s cached stack outputs are untouched by this and expire on their own 20s/`invalidateCache()` schedule. The four `games.draft.*` channels save/resume/discard a single in-progress add-game wizard draft via `GameWizardDraftService` — see [Credential storage at rest](#credential-storage-at-rest) for where it's persisted. `games.draft.updateStepIndex` exists so the renderer can persist step-only navigation on a *resumed* draft without re-sending its (secret-redacted) copy through `games.draft.save`, which would otherwise overwrite the real values still on disk. |
| `CostsController` | `costs.estimate` | Per-game Fargate estimates, derived from each game's `{game}-server` task-definition CPU/memory. The app makes no AWS Cost Explorer API calls — see [Costs](/app/costs). |
| `LogsController` | `logs.get`, `logs.getOlder`, `logs.getNewer`, `logs.stream`, `logs.lambda.get`, `logs.lambda.getOlder`, `logs.lambda.getNewer`, `logs.lambda.stream` | Snapshot of last N log events, paged "load older"/"load newer" backfill channels, and a streaming channel that pushes new events as they arrive (polls `FilterLogEvents` every 2 s under the hood) for a game's `/ecs/{game}-server` log group; the `logs.lambda.*` set does the same against `/aws/lambda/{projectName}-{functionKey}` for one of the app's 5 Lambda functions (`LambdaFunctionKey`), resolving `projectName` from `DeploymentConfig` settings and falling back to the `hyveon` default on any read failure. |
| `CloudHealthController` | `cloudHealth.list`, `cloudHealth.fix`, `cloudHealth.downloadPolicy`, `cloudHealth.openPolicyConsole` | Surfaces the account-prerequisite checklist from `CloudHealthService` to the Settings page's Cloud Health section: list check statuses, attempt an automated fix, write a remediation policy JSON to disk, and open an IAM console link for it. |
| `FolderUploadController` | `folderUpload.pickFolder`, `folderUpload.rescanSelection`, `folderUpload.getSelection`, `folderUpload.setSelection`, `folderUpload.clearSelection`, `folderUpload.startUpload`, `folderUpload.cancelUpload`, `folderUpload.confirmOverwrite`, `folderUpload.getProgress`, `folderUpload.cleanupStrayHelpers` (invoke) + `folderUpload.progress` (main → renderer push, not an invoke channel) | Backs [Seeding a volume from a folder](/app/games#seeding-a-volume-from-a-folder). `folderUpload.confirmOverwrite` takes `{ game, proceed }` and answers the overwrite warning of a run in the `awaiting-confirmation` phase (`proceed: false` cancels the run). `folderUpload.clearSelection` takes a game name and forgets its persisted selection; the add-game wizard calls it when a draft is cancelled. Delegates to `FolderScanService` (native folder dialog and local scan) and `FolderUploadService` (the upload run). `folderUpload.progress` is sent to every open window via `webContents.send` from `onModuleInit` (skipped outside Electron, gated on `process.versions.electron`), consumed in the renderer through `window.hyveon.folderUpload.onProgress`. The renderer only ever sees scan metadata, relative include paths and progress snapshots — never the helper's credential. |
| `VolumeFilesController` | Session: `volumeFiles.session.status`, `volumeFiles.session.start`, `volumeFiles.session.attach`, `volumeFiles.session.detach`, `volumeFiles.session.stop`, `volumeFiles.session.restart`. Files: `volumeFiles.list`, `volumeFiles.mkdir`, `volumeFiles.rename`, `volumeFiles.delete`, `volumeFiles.readText`, `volumeFiles.writeText`. Transfers: `volumeFiles.download`, `volumeFiles.uploadFiles`, `volumeFiles.uploadFolder`, `volumeFiles.cancelTransfer` (16 invoke channels) + `volumeFiles.session` and `volumeFiles.transfer` (main → renderer pushes, not invoke channels) | The embedded volume file browser's IPC surface, delegating to `VolumeFilesService`. Results carry only names, sizes, times, state and progress — never helper credentials, address or helper-side paths. It is the only file-browsing surface: the renderer's `/games/:name/files` page calls it through `window.hyveon.volumeFiles` (see [`@hyveon/web`](#hyveonweb)), and no separate legacy channel exists. Payload shapes, result envelope, logging and the security boundary: [`VolumeFilesController` contract](#volumefilescontroller-contract). |
| `DiscordController` | `discord.getConfig`, `discord.putConfig`, `discord.listGuilds`, `discord.addGuild`, `discord.removeGuild`, `discord.registerCommands`, `discord.getAdmins`, `discord.putAdmins`, `discord.getPermissions`, `discord.putPermission`, `discord.deletePermission` | Read-redacted config, save credentials, manage guild allowlist + commands, admins, per-game permissions. |
| `EnvController`, `DiagnosticsController`, `DriftController`, `AuditController` | `env.get`; `diagnostics.tail`/`diagnostics.path`/`diagnostics.reportError`/`diagnostics.reportLog`/`diagnostics.exportBundle`/`diagnostics.showInFolder`; `drift.get`; `audit.list` | Environment info, log-tail diagnostics, config-drift detection, and the audit-log view. Two renderer-forwarding channels land in the same `main-*.log` file but stay distinguishable by line prefix: `diagnostics.reportError` forwards a renderer-side crash (from the top-level `ErrorBoundary` or a `window.onerror`/`unhandledrejection` listener) via `DiagnosticsService.logRendererError`, writing `renderer error (${source}): ${message}`; `diagnostics.reportLog` forwards batched `console.log`/`info`/`warn`/`error` calls (every call, not just crashes — see `installConsoleForwarding()` below) via `DiagnosticsService.logRendererConsoleBatch`, writing one `renderer console (${level}): ${message}` line per entry (level mapped `log`→`debug`, others 1:1) plus a combined `renderer console: ${n} entries dropped (queue capacity exceeded)` warning per flush when the renderer's own queue overflowed. `diagnostics.exportBundle` opens a native save dialog, then (on a chosen path) calls the new `DiagnosticsBundleService` to gather four sections — recent log text (regex-scrubbed), an allowlisted deployment-config summary, app/system metadata, and a best-effort AWS resource snapshot reusing `ConfigService.getStackOutputs()`/`EcsService.getStatus()` — via `Promise.allSettled` and streams them into a single `.zip` (`archiver`) written atomically (temp file + rename) to disk; any section that fails is recorded in the bundle's own `errors.json`, never surfaced as a thrown error. A dialog cancel resolves `{ status: 'cancelled' }` with nothing written. `diagnostics.showInFolder` reveals a written bundle via `shell.showItemInFolder`, backing the Settings page's "Show in folder" action. |
| `IacController` | `iac.stack.initialize`, `iac.plan`, `iac.apply`, `iac.destroy.mintToken`, `iac.destroy`, `iac.output`, `iac.approve`, `iac.rollback.resolve`, `iac.rollback.confirm`, `iac.lock.clear.mintToken`, `iac.lock.clear` | Drives `PulumiService` (Automation API via `LocalWorkspace`, which launches the pinned `@pulumi/pulumi` engine as a child process through `LocalWorkspaceOptions.pulumiCommand` — the app downloads and verifies that engine itself, so no host-installed or PATH-discovered CLI is ever used) for the plan/apply/destroy/rollback pipeline. `iac.destroy.mintToken` issues the type-to-confirm token the UI requires before a `destroy` call is accepted; `iac.lock.clear` recovers a stale Pulumi backend lock, gated the same way behind a `iac.lock.clear.mintToken`-issued type-to-confirm token — clearing a backend lock is not accepted on request alone. |
| `IacRunsController` | `iac.runs.get`, `iac.runs.logs`, `iac.runs.list`, `iac.runs.logUrl`, `iac.runs.lock.clear.mintToken`, `iac.runs.lock.clear` | Run history: fetch a record, stream/fetch its log, list/paginate, resolve an offloaded S3 log link. `iac.runs.lock.clear.mintToken`/`iac.runs.lock.clear` recover a wedged durable run lock (`RunService`'s apply lock, distinct from `IacController`'s `iac.lock.clear` Pulumi-backend-lock recovery) — mint-then-confirm the same as `iac.destroy.mintToken`, backing the `/iac` page's busy-banner "Clear lock and retry" action described in [The workspace-busy banner](/app/iac#the-workspace-busy-banner). |
| `IacSettingsController` | `iac.settings.get`, `iac.settings.update`, `iac.settings.engineVersion`, `iac.settings.autoUpdate.get`, `iac.settings.autoUpdate.update`, `iac.settings.autoUpdate.check`, `iac.settings.autoUpdate.download`, `iac.settings.autoUpdate.install` | Reads/writes every top-level `deployment-config.json` field EXCEPT `gameServers` — backs the Settings page's [General section](/app/settings#general). `update` validates via the shared `validateDeploymentSettingsPatch` (`@hyveon/shared`) before delegating to `DeploymentConfigService.updateTopLevelSettings()`; a stale `expectedVersionId` returns `{ code: 'conflict' }` rather than silently overwriting a concurrent edit. `engineVersion` reads `PulumiEngineService.getResolvedVersion()` (`null` when not yet provisioned) — backs the [Cloud Setup section](/app/settings#cloud-setup)'s Pulumi engine version row. The `autoUpdate.*` pair reads/writes `ElectronStoreService`'s `enableAutoUpdate` flag (a local install-level setting, not a `deployment-config.json` field) — backs the [Updates section](/app/settings#updates)'s toggle. `autoUpdate.get` also returns `appVersion` (the running app's `app.getVersion()` via `readAppVersion()`, `'unknown'` outside Electron) — backs the Updates section's App Version row. `autoUpdate.check` triggers an on-demand `checkForUpdatesNow()` call in `updater.ts`, independent of the `enableAutoUpdate` flag (that flag only gates `initUpdater`'s automatic boot-time check); it never downloads or installs, retries once against the newest published release that carries the platform feed file (`updater-fallback.ts`) if the primary check fails (surfacing the original error if that also fails), and resolves the discriminated `ManualUpdateCheckResult` (`@hyveon/shared`) — `{ ok: true, updateAvailable: true, version }`, `{ ok: true, updateAvailable: false }`, or `{ ok: false, message }`. `autoUpdate.download` and `autoUpdate.install` are the only handlers that ever download or install an update, and only on an explicit operator click: `download` runs `downloadUpdateNow()` and streams progress over the `iac.settings.autoUpdate.download.chunk` / `.end` side channels (self-bridged like `iac.stack.initialize`, since it needs the invoke event's sender; a failure is the end message's `error`); `install` calls `installDownloadedUpdate()`, i.e. `quitAndInstall(false, true)`. Both `engine` and `store` are optional constructor params so direct-construction test call sites keep compiling without stubbing them; a real `AppModule` bootstrap always resolves both. |
| `WizardController` | first-run wizard channels (AWS profile/credentials, bootstrap, IAM check, guided-IAM CloudFormation bootstrap, progress) | Backs the in-app setup wizard — see the [setup guide](/setup). |
| `WindowController` | `window.minimize`, `window.toggleMaximize`, `window.close`, `window.isMaximized` (invoke request/response) + `window.maximizedChange` (main → renderer push, not an invoke channel — see above) | Minimize, maximize, close, and query the maximized state of the main window. `window.maximizedChange` is pushed whenever the main window's maximized state changes, for any reason (the app's own button, OS-level snap/restore, or macOS/Windows native window controls). Backs the app header's merged title bar, rendered with platform-specific window-control buttons: native traffic lights on macOS, native titleBarOverlay on Windows, and app-drawn buttons on Linux. macOS and Windows get double-click-to-maximize on the drag region for free from Electron/Chromium; the app does not add an equivalent handler for Linux's app-drawn header. |

### `VolumeFilesController` contract

- **Requests.** Every file channel takes `{ game, volume, ... }` plus volume-relative path fields that vary by channel: `path` (`list`, `delete`, `readText`, `writeText`, `download`), `parent` + `name` (`mkdir`), `path` + `newName` (`rename`), `dir` (`uploadFiles`, `uploadFolder`). The legacy unnamed volume is the empty string. `cancelTransfer` takes `{ game, transferId }` with no `volume`, and the session channels take a bare game name. Payloads arrive unchecked from the renderer, so each handler validates its own shape and never throws.
- **Results.** File and transfer channels return `VolumeResult<T>` (`{ ok: true, value }` or `{ ok: false, code, message }`). `session.status`/`start`/`attach`/`detach` return a bare `VolumeSessionStatus` and answer a bad `game` with a `failed` status; `session.stop`/`restart` return `VolumeResult<VolumeSessionStatus>` and answer a bad `game` with `{ ok: false, code: 'invalid-path' }`; `cancelTransfer` returns `{ cancelled }`.
- **Session flow.** `session.start` and `session.restart` fire the browse acquire in the background and return the status immediately; readiness arrives on the `volumeFiles.session` push. `session.attach`/`detach` mark the page being entered or left (re-hold or release `browse`, which drives the registry's grace stop).
- **Transfers.** `download` opens the native save dialog; `uploadFiles` opens the file dialog only when `localPaths` is omitted (the preload's `uploadDropped` supplies it); `uploadFolder` opens the folder picker. Each resolves `null` when the operator cancels. Otherwise `download` and `uploadFiles` return a `transferId` and progress arrives on `volumeFiles.transfer`, while `uploadFolder` (`VolumeResult<FolderUploadStartResult | null>`) returns the folder-upload start result and the run reports on `folderUpload.progress`.
- **Pushes.** Both push channels go to every open window through `forwardToWindows` (`ipc-broadcast.ts`; a no-op outside Electron, also used by `FolderUploadController`).
- **Security boundary.** Results and pushes carry only names, sizes, times, session state and progress — never the helper's credential, address, certificate pin or a helper-side (`/srv/...`) path. Backend error messages embed helper mount paths, so file and transfer failures map to fixed operator messages built from the operator's own names, and the original text goes to the winston log. Session channels are the exception: raw text reaches the renderer through the status `error` field (and so the `volumeFiles.session` push). Its sources are `sessionStatus`'s catch (`errMessage(err)`), the registry's `failSession`, `failVanishedSession` and `withStopReason` (launch, readiness and vanished-task reasons, including ECS stop reasons), and `FileManagerService.launchHelper` outcome messages, all copied by `toSessionStatus`. `session.stop`/`restart` return the registry's message, which is raw error text when teardown of an owned session fails (`FileManagerService.stop` returns `String(err)`) as well as when stopping an orphaned helper fails. None of these code paths formats the helper's host, credential or mount path into the text, but AWS error wording can quote the operator's own address (an EC2 `InvalidPermission.Duplicate` message quotes the `/32` rule). So every session error crossing IPC (`toSessionStatus`, `failedSessionStatus`, and the `session.stop`/`restart` failure messages) goes through `scrubAddresses`, which replaces IPv4 literals (with an optional `/NN` or `:port`) and `http(s)://` URLs with `<address>`; the full text goes to the winston log.
- **Logging.** The entry debug line logs only `game`, `volume` and the channel's own volume-relative string fields (`path`, `parent`, `name`, `newName`, `dir`, `transferId`) — never `content` or `localPaths`.
- **Local paths.** The `window.hyveon.volumeFiles` API never lets the renderer supply a local path string: save and open locations come from native dialogs in main, and dropped files are resolved to paths inside the preload (see [`@hyveon/desktop-preload`](#hyveondesktop-preload)).

### Key services

- **`ConfigService`** — no longer parses any state file off disk. Its
  `getStackOutputs()` is a memoised delegate to `PulumiService.getStackOutputs()`,
  which reads the deployed Pulumi stack's outputs (`StackOutputs` from
  `@hyveon/shared` — cluster ARN, subnets, security groups, EFS access
  points, game names, `domainName` (the configured hosted zone's base
  domain), Discord table + secret ARNs, interactions
  URL) via the Automation API against the S3 backend, not a local state
  file. The in-flight promise is cached so concurrent callers
  coalesce; a resolved `null` (infra not yet deployed) expires after 20 s, a
  resolved value is cached until `invalidateCache()` — called by the games
  controller on list/status so a fresh `pulumi up` is picked up without an
  app restart. The old local-file-parsing path was removed as dead code —
  nothing reads a local state file under
  the Pulumi engine. `getConfigurationBucket()` (the configuration S3 bucket
  name) is a different, unrelated resolution path — see
  [`DeploymentConfigModule` / `DeploymentConfigService`](#deploymentconfigmodule--deploymentconfigservice) below.
- **`DiscordConfigService`** — persistence facade over DynamoDB
  (`CONFIG#discord`) + Secrets Manager. Concurrent reads are coalesced via
  an inflight-promise pattern. `getRedacted()` returns
  `botTokenSet` / `publicKeySet` booleans only.
  `getEffectiveToken()` is the single escape hatch — used only by the
  command registrar.
- **`DiscordCommandRegistrar`** — calls
  `PUT https://discord.com/api/v10/applications/{clientId}/guilds/{guildId}/commands`.
  Validates `guildId` as a 17–20-digit Discord snowflake before calling out
  (no path traversal, no SSRF).
- **`EcsService` / `Ec2Service` / `LogsService` / `SchedulerService` /
  `CostService` / `FileManagerService`** — cloud-facing services.
  `EcsService` routes ECS run/stop/status calls through the injected
  `CLOUD_PROVIDER` token (a `CloudProvider` implementation from
  `@hyveon/cloud-aws`) rather than instantiating an `@aws-sdk/client-ecs`
  client directly; `Ec2Service` / `LogsService` / `SchedulerService` still
  call the AWS SDK v3 clients (EC2, CloudWatch Logs, EventBridge Scheduler)
  directly, since those aren't yet behind a cloud-agnostic contract.
  `FileManagerService` composes `EcsService`/`Ec2Service`/`SchedulerService`
  rather than calling any SDK client itself. `CostService` is pure
  arithmetic — no AWS SDK client at all — since the Cost Explorer call
  chain was removed (see `openspec/changes/remove-cost-explorer-calls`).
  New cloud-facing code should prefer adding to (or consuming) the
  `CLOUD_PROVIDER` / `SECRETS_STORE` / `REMOTE_FILE_STORE` /
  `DISCORD_RECEIVER` / `AUDIT_LOG_STORE` / `DISCORD_CONFIG_STORE` /
  `RUN_RECORD_STORE` tokens over
  reaching for a new AWS SDK client directly — see the [maintainer
  guide](/guides/maintainer#when-you-touch-the-nest-server).
  `LogsService.streamLogs(game, signal)` is an `AsyncGenerator` that polls
  `FilterLogEvents` every 2 s; `getRecentLogs` remains the snapshot path.
  `streamLambdaLogs(functionKey, signal)` / `getRecentLambdaLogs(functionKey)`
  are the same two shapes against a resolved Lambda log group
  (`/aws/lambda/{projectName}-{functionKey}`), with `projectName` read from
  `DeploymentConfig` settings and falling back to the `hyveon` default.
- **Folder upload** — `FolderUploadModule` (imports `AwsModule`, `DeploymentConfigModule`, `ElectronStoreModule`, `NativeDialogModule`, `VolumeFilesModule`) provides:
  - `FolderScanService` — the local scan (tree, sizes, skipped symlinks); its folder picker goes through `NativeDialogService` (injected) rather than a private `electron` import, and `pickAndScan` is the only dialog caller left in it.
  - `FolderUploadService` — orchestrates one run per game: plans the helper's volume layout once (`FileManagerService.planHelperLayout`), refuses unless the destination's volume is mounted and the game is confirmed stopped (see the multi-volume layout notes under `FileManagerService` below), opens the helper by acquiring an `upload:<runId>` hold on the helper session registry (see **File-manager helper sessions** below) (tagged `UPLOAD_TAGS`, and reusing a running browse session when one exists), lists the destination folders and, when planned files would overwrite different-size files already on the volume, publishes the `awaiting-confirmation` phase (with an `OverwriteSummary`) and waits for `folderUpload.confirmOverwrite` before writing anything (cancelled after 10 minutes without an answer, or when the run is a resume of its own cut-short run with no more conflicts than the engine's concurrency), uploads, verifies, then persists the outcome. The hold is released in a `finally` on every exit path: the registry stops a helper the run launched and leaves a browse session that predates the run running. Before launching it refuses with `A file manager session is already open for '<game>'. Restart it, then retry.` when the registry reports an `orphaned` helper. Cancel is immediate even while the helper is still booting: the run stops waiting at once and releases the hold as soon as the late acquire resolves. When a run fails after the helper was acquired, the registry's `status` is consulted and a `failed` session's error (ECS's stop reason for a vanished task) is appended to the message. The service registers an `onBeforeStop` listener that cancels the game's run, so an explicit session stop never leaves an upload writing into a dying helper. On application bootstrap (Electron only) it sweeps for stray helpers older than 15 minutes; `folderUpload.cleanupStrayHelpers` runs the same sweep on demand with no age floor, sparing games with an active run or a registry-owned session. `startUpload(request, { persistSelection })` defaults to `true`; with `false` (what `VolumeFilesService.uploadFolder` passes) the run neither replaces the game's saved folder selection, nor records a last-run outcome, nor counts as a resume of that selection's cut-short run.
  - `services/folderUpload/` — `FileBrowserClient` (the HTTPS implementation of the `VolumeFileBackend` interface in `services/volumeFiles/`, built by `FileBrowserClientFactory`, which `VolumeFilesModule` provides; pins the helper's certificate fingerprint), `RegistryUploadBackend` (a `VolumeFileBackend` for one game that routes every call through `registry.withBackend`, so an operator-IP recovery retries that one operation rather than the run; `connect`/`close` are no-ops because the registry owns the connection, and `writeStream` fails with `unreachable` instead of replaying a consumed stream), `uploadEngine` (runs on that interface; four files in flight, up to three attempts per file, resume by remote size, and `classifyUpload` for the pre-upload new/identical/conflict split), `ProgressAggregator` (builds the `FolderUploadProgress` snapshots), `ephemeralCert` (generates the per-launch self-signed certificate and its SHA-256 fingerprint) and `tlsLaunch` (builds the helper container's TLS settings from that certificate).
  - `PublicIpService` (provided in `AwsModule`) — asks `checkip.amazonaws.com` for the operator's public IPv4, with a 5 s timeout.
- **`FileManagerService` (helper launch)** — `launchHelper(game, { runId, tags?, layout? })` is the single launch body, and the helper session registry is its only caller. Every launch serves HTTPS with a per-launch self-signed certificate returned on the outcome for the caller to pin; there is no plain-HTTP launch path and no `tls` option. It authorizes `<operator-ip>/32` on port 8080 of the file-manager security group (via `Ec2Service.authorizeIngress`), registers a throwaway task definition and deregisters it on stop (via `EcsService.registerTaskDefinition` / `deregisterTaskDefinition`), and returns the one-time credential (`HelperCredentials`, in the success outcome) in-process only: it never crosses IPC or reaches a log. If any helper for the game is already running it refuses with `code: 'helper-open'`, because that session's credential is unknown. Each launch seeds a random password, bcrypt-hashes it into the container's `--password` flag, and creates an EventBridge Scheduler one-time schedule that calls `ecs:StopTask` after `FILEBROWSER_AUTO_STOP_MS` (best-effort: a failed schedule does not fail the launch); `stop(game)` (the only other public lifecycle method; the old `start()` and `getStatus()` are gone) deletes that schedule, revokes the rules and deregisters the task definition. Exported constants: `FILEBROWSER_AUTO_STOP_MS` (2 hours), `BROWSE_RUN_ID` (`'browse'`, the default run id) and `UPLOAD_TAGS` (`Purpose=seed-upload` / `Project=hyveon`). `listHelperTask` returns the game's helper task, if any. `reauthorizeOperatorIp(game, runId, taskArn, newIp)` handles an operator whose public IP changed: it authorizes the new `/32`, re-tags the task `OperatorIp=<newIp>` (via the new `EcsService.tagTask`, `TagResource`), then revokes every app rule no running helper needs, always keeping the new CIDR because `DescribeTasks` may not reflect the re-tag yet. `sweepStrayHelpers` stops leftover helpers and revokes the app-added rules. Every helper is tagged `OperatorIp=<ip>` at launch, and both `stop` and the sweep revoke every app-added rule whose CIDR no remaining helper's tag needs (regardless of which game's description it carries; the operator-requested sweep also keeps rules whose description names a game with an active upload run or registry session), keeping all rules if the helper listing fails or a remaining helper has no tag. `Ec2Service` also gained `listIngressRulesByDescriptionPrefix` and `revokeIngressRules`; `EcsService` gained `listTasksByStartedByPrefix`.

  **Multi-volume helper layout.**

  Every launch mounts **every applied volume** of the game, not just the first, once the stack exports `efsVolumeAccessPoints`; on a stack applied before that output existed, the fallback planner mounts only the first volume (see the fallback row below). `FileManagerService` registers one ECS task-definition volume per volume (named `vol-<index>`, the index being the volume's position among all declared volumes) and mounts each at `/srv/<dir>`. FileBrowser keeps `--root /srv`, so its root lists one folder per volume.

  | Piece | Behaviour |
  |-------|-----------|
  | Planner | `buildHelperVolumeLayout` (`services/volumeFiles/helperVolumeLayout.ts`) takes the game's declared volumes (from `DeploymentConfigService`) and the stack outputs. It returns `mounts`, `unmounted` (declared volumes with no access point yet) and `usedFallback`. |
  | Directory name `<dir>` | The volume's name when it matches `[A-Za-z0-9._-]{1,64}`, is not `.`/`..`, is unique among the game's volumes, and does not look like `volume-<n>` (that shape is reserved for the fallback). Otherwise `volume-<index>`. |
  | Access points | `efsVolumeAccessPoints[game][volume]`, a stack output that covers every volume. |
  | Fallback | When `efsVolumeAccessPoints` has no entry for the game (a stack applied by an older build), only the first volume (for a game with no configuration entry, a single unnamed one in `volume-0`) is mounted, via `efsAccessPoints[game]`; the others sit in `unmounted` until the operator runs plan + apply once. The layout has `usedFallback: true`, and folder upload refuses it outright (the legacy access point belongs to whichever volume was first at the last apply, so a later reorder of `volumes` would mislabel the mount). |
  | No mounts | A launch whose layout has no mounts fails with `No EFS access point found for '<game>'.` |

  `launchHelper` mounts a caller-supplied `layout` as-is and plans one itself only when none is passed; the successful outcome carries the `layout` it was launched with, and the registry keeps it on the session.

  **Why one planned layout drives both the mounts and the remote paths.** A path computed relative to a single access point sends bytes meant for a game's second volume into the first (#672), so `FolderUploadService` resolves the destination's owning volume (`validateDestination`), builds each remote path as `toHelperPath(layout, volume, toRemotePath(destination, containerPath, relPath))` — `toRemotePath` (in `@hyveon/shared/folderUpload`) returns a path *inside* the volume, and `toHelperPath` prefixes `/<dir>` — and re-derives the remote paths from the live session's layout (the one `registry.withBackend` hands the operation), so the path and the mount cannot disagree even when a reused browse session predates an infrastructure apply. If that session does not mount the volume, the run fails with `Stop and start the file manager session to upload into '<volume>'.` before writing anything. An upload into a volume that is not mounted, or any upload while the layout is the fallback (`usedFallback`, including into the first volume), is refused before any launch (against a freshly planned layout) with `Apply the infrastructure to upload into '<volume>'. Your selection is kept.`

  **Fail-closed stopped-server check.** `EcsService.findRunningTaskOrThrow(cluster, game)` logs and throws a plain `Error` when ECS can't be queried; `findRunningTask` is unchanged for existing callers — it wraps the throwing variant and returns `null` on failure, so it is only safe where "unknown" may be treated as "none". Folder upload uses the throwing variant: if ECS can't be queried the run is refused with `Couldn't confirm '<game>' is stopped. Try again in a moment.` Writing to EFS while the game server is live can corrupt saves, so an unconfirmed server is never assumed stopped.
- **File-manager helper sessions** — `VolumeFilesModule` (imports `AwsModule`; imported by `AppModule` and `FolderUploadModule`) provides and exports `HelperSessionRegistry` and `FileBrowserClientFactory`. `AwsModule` now exports `PublicIpService` so the registry can detect the operator's IP. The registry (`services/volumeFiles/HelperSessionRegistry.ts`) owns the one app-managed FileBrowser helper per game and is shared by the file browser and folder upload (design D3 in `openspec/changes/embed-file-browser/design.md`; requirements in that change's `game-volume-file-browser` and `game-volume-folder-upload` specs).

  | Concern | Behaviour |
  |---------|-----------|
  | Holders | A session is reference-counted by holders: `browse`, `upload:<runId>` (a folder-upload run or an upload transfer) or `download:<transferId>`. Every holder keeps the session alive and stops it when the last one leaves, but only `upload:` holders refuse a game start and count towards `uploadHolders`. `acquire(game, holder, { tags?, runId? })` adds a holder and launches only when no session is owned; concurrent acquires share the one launch. `tags`/`runId` apply only to the call that launches (`runId` defaults to `BROWSE_RUN_ID`). An acquire that finds a session being torn down waits for it, then launches afresh. |
  | Release and grace | Releasing `browse` starts a grace timer (`timings.browseGraceMs`, default 5 minutes); `attach(game)` re-holds `browse` and cancels it. When the last holder leaves with no grace timer pending the session stops at once (an upload run's release does this); with a timer pending, the timer decides. |
  | Explicit stop | `stop(game)` runs the `onBeforeStop` listeners first (this is how an active upload run is cancelled), then closes the backend and stops the ECS task. A teardown from the last holder leaving or the grace timer notifies no one. `restart(game)` is `stop` then a fresh `browse` acquire. `stopAll()` stops every owned session and never throws. |
  | States | `status(game)` reports `not_deployed`, `stopped`, `starting`, `running`, `stopping`, `orphaned` or `failed`. `orphaned` means an ECS helper for the game exists that this registry did not launch (one from an earlier app session, or any helper started outside this registry): `acquire` returns `code: 'orphaned'` and launches nothing, and only an explicit `stop`/`restart` or the stray-helper sweep removes it. A `running` session whose task is gone becomes `failed` with ECS's stop reason; a failed launch appends `(helper task stopped: <reason>)` to its message. `failed` is remembered until the next `acquire`, `restart` or `stop`. When a session's task is replaced by a different helper the registry does not own, the next `status` reports `orphaned` rather than `failed`. |
  | Readiness | A session is `running` only once the ECS task has a public IP and a FileBrowser login over the pinned TLS certificate has succeeded (polling every 3 s, 180 s for the IP, 120 s for the login). A pin mismatch aborts without retrying and fails the session closed. |
  | `withBackend(game, op)` | Runs `op(backend, layout)` against the live session, or throws `NoSessionError`. When `op` fails with `unreachable`, the registry detects the operator's IP; if it changed it calls `reauthorizeOperatorIp` and retries `op` exactly once (concurrent failures share one re-authorization). A pin mismatch during `op` stops the session so its rule is revoked, and is rethrown. `VolumeFilesService` runs every file operation through this, never holding a backend itself. Uploads run each whole file inside `withBackend`, so an operator-IP change retries that file; a download opens its stream inside `withBackend` but `streamToFile` copies the body after it returns, so the one retry does not cover download bytes. |
  | Snapshots | `HelperSessionSnapshot` carries state, timings, `browseHeld`, `uploadHolders`, `error`, `supportsArchive` and the game's volumes with a `mounted` flag. It never carries the credential, certificate, IP or URL, so it is safe to forward to the renderer. |

  `VolumeFilesService` is the registry's other consumer next to `FolderUploadService`, and uses it as follows: `session.start`/`restart` call `acquire(game, 'browse')` without awaiting readiness; `attach` and `detach` call `attach(game)` and `release(game, 'browse')` (the grace timer decides when the helper stops); `session.stop` and `restart` call `stop(game)`; `status` and `onState` feed `sessionStatus` and the `volumeFiles.session` push; a transfer acquires the holder `upload:xfer-<transferId>` for its duration, so the helper outlives a navigated-away page until the transfer ends; and `onBeforeStop` aborts the game's transfers, the same way it cancels an upload run. The registry's snapshot type reuses `VolumeSessionState` and `VolumeInfo` from `@hyveon/shared/volumeFiles`, so the renderer-visible status and the registry state share one definition.

  `helper-quit-hook.ts` installs a `before-quit` handler from `electron-entry.ts`. With no owned sessions it does nothing, so quitting is never delayed. Otherwise it prevents the first `before-quit`, calls `registry.stopAll()` for at most 5 seconds, then calls `app.quit()` again. A helper that outlives the timeout is left to the next launch's stray-helper sweep (helpers older than 15 minutes).
- **`NativeDialogService`** (`NativeDialogModule`) — `pickDirectory()`, `pickFiles()` (multi-select) and `pickSavePath(defaultName, { title?, filters? })` around Electron's `dialog`, loaded with a lazy `import('electron')`. Outside Electron (unit tests, the plain-Node integration server) each resolves to its cancelled value (`null` / `[]`). Its consumers are `FolderScanService` (`pickDirectory`), `DiagnosticsController` (`diagnostics.exportBundle` calls `pickSavePath` with its title and zip filter) and `VolumeFilesService`.
- **`VolumeFilesService`** (`VolumeFilesApiModule`) — the operator-facing file and session operations behind `VolumeFilesController`; it is the layer that keeps the helper's details out of results. Session channels map the registry's `HelperSessionSnapshot` field by field to `VolumeSessionStatus` (epoch milliseconds become ISO strings; volumes keep only `name`, `containerPath`, `mounted`); a failed status lookup comes back as a `failed` status, not a throw. It registers an `onBeforeStop` listener so stopping a session aborts that game's transfers. Every file operation runs through `FileOps.run` (`volumeFiles/fileOps.ts`):

  | Step | Behaviour |
  |------|-----------|
  | Validate | Paths go through `normalizeVolumePath` (absolute POSIX; no `..`, `.`, empty segments, NUL or backslash) and entry names through `joinVolumePath`; a bad one fails `invalid-path` before any session is touched. Rename and delete refuse the volume root. |
  | Writable check (mutations only) | `assertWritable` reads the stack outputs and calls `EcsService.findRunningTaskOrThrow`: a live server task fails `server-running`; any error (including outputs not available) fails closed as `server-check-failed`. Reads and downloads skip it, so they stay allowed while the game runs. |
  | Session | `registry.withBackend(game, ...)`; no running session fails `no-session`. Inside it, a volume the layout did not mount fails `unknown-volume` (worded differently for a declared-but-unapplied volume), and a mutation under the legacy `usedFallback` layout fails `apply-needed`. The helper path comes from `toHelperPath(layout, volume, path)`. |
  | Timeout | Each attempt gets `AbortSignal.timeout(METADATA_OP_TIMEOUT_MS)` (30 s) for metadata calls; an abort fails `unreachable`. |
  | Failure mapping | `toVolumeResult` builds the message from the operator's own names (`'<path>' no longer exists.`, `'<name>' already exists.`) or a fixed string; the backend's message is only logged (`warn` for refusals, `error` for plain `failed`). A refusal decided by a check rather than thrown (`server-running`, `unknown-volume`, `apply-needed`, `too-large`, `binary`, an mtime or name `conflict`, and the `uploadFiles`/`uploadFolder` pre-checks) logs one `info` line, `VolumeFilesService: file operation refused`, with `game`, `volume`, `path` and `code` only, never content or local paths. `server-check-failed` is skipped there because `assertWritable` already logs its cause. |

  Text editing: `readText` refuses a folder, a file over `MAX_TEXT_EDIT_BYTES` (1 MiB; checked on the stat size and again while reading) with `too-large`, and NUL-containing or non-UTF-8 content with `binary`. `writeText` re-checks the size as UTF-8 bytes, then stats the file and refuses with `conflict` unless its mtime equals `expectedModifiedMs`; an unknown mtime (0) on either side is also a conflict, so a save never overwrites blind. `mkdir`/`rename` return the entry re-read from the volume, with `modifiedMs: 0` when the read-back fails. Because the registry retries an operation once after an operator-IP change, a mutation whose first attempt landed can then report `conflict` or `not-found`.

  Transfers (`volumeFiles/transferOps.ts`, `transfers.ts`): `TransferManager.start` joins an already `running` session (it never launches a helper) by acquiring the holder `<kind>:xfer-<transferId>` (`upload:` for an upload, `download:` for a download), runs the work in the background, throttles `running` progress events to one per 150 ms, and releases the hold in a `finally` before emitting the final `done`, `failed` or `cancelled` event. Execution starts one macrotask after `start` returns, so the invoke reply carrying `transferId` is queued before the first `running` push, and a cancel arriving in that gap ends the transfer as `cancelled` without running it. A throwing listener is caught and logged, so it cannot leak the hold. A spec's optional `onSettled` runs once after the hold is released, on every outcome of a transfer that `start` returned.

  | Operation | Behaviour |
  |-----------|-----------|
  | `download` | Probes the entry first (a file's size; a folder needs `supportsArchive`) so a missing file never costs the operator a dialog, then `pickSavePath` with a default name from `sanitizeLocalFileName` (Windows: forbidden characters, trailing dots/spaces and device names such as `CON` are rewritten; elsewhere only `/` and NUL). A folder downloads as `<name>.zip` with unknown total. Bytes stream to `<target>.<random>.part` (created exclusively) and are renamed over the target only on success; any failure or cancel removes the part file. Dropping the connection mid-body is reported as the file manager being unreachable, local file-system errors as `Couldn't write to that location.` |
  | `uploadFiles` | Refused up front, before any byte moves: invalid destination, an empty dropped path, server running, no running session, a chosen item that is not a regular file (`lstat`; links and folders are refused), the same target name chosen twice, or any target that already exists on the volume (the whole upload fails `conflict`). Written with `overwrite: false`; a retry after an operator-IP change replays the file and rewinds its byte count. FileBrowser writes the body straight to the target, so a cancelled or failed upload would leave a truncated file (and the retry would be refused as `already exists`): the in-flight file is therefore removed best-effort with a metadata-timeout `remove`, skipped when the failure was a `conflict` (the target appeared by itself, or a retried first attempt landed in full). The terminal event then says `The partial file was removed.`, or, when removal failed, `'<name>' was partially uploaded; delete it before retrying.` (also carried as the `error` of a `cancelled` event). Files that finished earlier in a multi-file upload stay. `localPaths` omitted opens the multi-select file dialog; nothing chosen resolves `null`. All targets of a call are reserved in-process (`uploadReservations.ts`, per game and volume) before the existence pre-stat, so an overlapping upload of the same name is refused at once with `conflict` (`'<name>' is already being uploaded.`) and nothing is written; `writeText` reserves its path for its stat and write the same way. The reservation is held until the transfer ends, after any partial-file cleanup, and released on every exit path; the partial-file removal above is safe because it only touches a target this transfer reserved and the pre-stat proved absent. The transfer holds the session before its server check, and re-checks the server before each file: if the server has started (or can't be confirmed stopped) it stops with a `failed` event, `Upload stopped. <reason>`, and leaves the files already written in place. |
  | `uploadFolder` | Checks the server is stopped, finds the volume in `DeploymentConfigService`, builds the destination from the volume's `container_path` and the directory, verifies with `validateDestination` that the destination belongs to that same volume, then `pickDirectory`, `FolderScanService.scan`, and `FolderUploadService.startUpload({ game, scanId, include: [''], destination }, { persistSelection: false })`. A refused start comes back inside the `FolderUploadStartResult` for the page to show. |
  | `cancelTransfer` | Aborts the transfer if it belongs to the named game; the controller answers `{ cancelled: false }` for an unknown id or another game's id. |
- **`DriftService`** — see [Drift detection](#drift-detection) below.
- **`DeploymentConfigService`** — see [`DeploymentConfigModule` / `DeploymentConfigService`](#deploymentconfigmodule--deploymentconfigservice) below.
- **`GamesWriteService`** — backs `GamesController`'s `games.create`/`games.update`/`games.delete`. On a health-check credential change, it validates the operator-submitted plaintext, runs a structural `validateGameServer` pass against a non-mutating preview *before* touching Secrets Manager (so a rejected save — a port collision, a bad cpu/memory pairing, anything unrelated to `auth` — never creates, mutates, or deletes a secret), and only then calls `secretsStore.ts`'s `upsertHealthCheckAuthSecret`/`deleteHealthCheckAuthSecret` for a `basic`/`bearer` credential. Omitting `healthCheck.auth` on an update leaves the existing credential unchanged; submitting `auth: null` clears it (deleting the app-owned secret first, if the prior credential was `basic`/`bearer`); switching a credential away from `basic`/`bearer` deletes the now-orphaned app-owned secret; deleting the game deletes its app-owned secret too. Secret-deletion failures are logged and swallowed (cleanup must not block the write it's tidying up after); secret-creation/update failures are surfaced as a user-facing error.
- **`GameWizardDraftService`** — owns the single in-progress add-game wizard
  draft slot on `ElectronStoreService` (`addGameWizardDraft`, see
  [Credential storage at rest](#credential-storage-at-rest) below). `get()`
  degrades to `null` on any corrupt/unrecognized stored shape rather than
  throwing, mirroring `FirstRunWizardService`'s resume-file behaviour;
  `save()`/`clear()` log and swallow write failures rather than surfacing
  them, since autosave is a best-effort background write, not an
  operator-triggered action that needs its own error path.

### Auth

There is no request-level auth to configure — Electron IPC is only reachable
from the app's own renderer process (via the `contextBridge`-exposed
`window.hyveon`), not from the network. There is no bearer token, no
`API_TOKEN`, and no equivalent of the old `ApiTokenGuard` anywhere in this
app.

### Logging

Winston in `src/logger.ts`. Dev: colourised timestamps + JSON metadata.
Prod: JSON lines with ISO timestamps. Use `logger.info` / `warn` / `error`
everywhere, not `console.log`.

The winston log file is the only durable record of what happened in a given
run — there's no HTTP transport to fall back on for tracing (see
[Auth](#auth) above); the global `RpcErrorMessageFilter` preserves a handler's
real error message, but only the winston log captures it durably. Two
conventions keep it useful,
applied across every controller and every service method in
`desktop-main/src/services/*.ts` that can fail (not just controllers): every
`@MessagePattern` handler logs its pattern name on entry via `logger.debug`
(pattern name only, never payload contents — a payload can carry pasted AWS
credentials); and every service method that calls an AWS SDK operation or
the Pulumi engine likewise logs entry via `logger.debug` (method name only,
never payload contents) and catches the error, logging it via `logger.warn`
(recoverable/expected) or `logger.error` (unexpected) with just
`err instanceof Error ? err.message : String(err)`, and either returns a
modeled result or rethrows a plain `Error` — a raw AWS SDK/Node error object
is never left to escape a service method uncaught, since it can carry
non-plain fields (e.g. `$metadata`) that fail Electron's structured-clone
when marshalled back to the renderer. Pure helpers with no external call and
no possible failure mode (`CostService.ts`'s arithmetic, `sleep.ts`,
`mergeGameLists.ts`) are exempt — there's nothing to log.

### Env vars

| Name | Default | Purpose |
|---|---|---|
| `AWS_DEFAULT_REGION` | — | AWS SDK region hint, read by `ConfigService.readEnvRegion()`. |
| `CONFIG_CACHE_TTL_MS` | `30000` | In-memory cache TTL for `DeploymentConfigService`'s parsed configuration. Falls back to the default when unset, empty, non-numeric, or non-positive. |
| `RUNS_DIR_PATH` | `<userData>/runs` | Directory `PulumiService` writes per-run plan/apply artifacts under. |
| `HYVEON_CONFIG_BUCKET` | — | Dev/CI override for the S3 configuration bucket name `DeploymentConfigService`/`PulumiService` read/write against — wins over the operator-configured value. Not how the packaged app resolves the bucket in normal use; see [`DeploymentConfigModule` / `DeploymentConfigService`](#deploymentconfigmodule--deploymentconfigservice) below for the real resolution order. |
| `NODE_ENV` | — | `'production'` selects Winston's JSON-lines log format over the dev colourised format; read in `logger.ts`. |
| `DIAGNOSTICS_LOG_DIR` | `os.tmpdir()` | Outside Electron only — the directory `DiagnosticsController`'s log-tail reads from. Inside Electron this is always `<userData>/logs` regardless of the env var. |
| `HYVEON_TEST_MODE` | — | `'1'` enables the `window.hyveon.__test` mock-IPC seam in the preload script for Playwright's `electron` e2e project — see [`@hyveon/desktop-preload`](#hyveondesktop-preload) below. Absent (the default) in packaged/production builds. |

### Credential storage at rest

Two services, both provided by `ElectronStoreModule`:

- **`SafeStorageService`** — wraps Electron's `safeStorage` API, which
  encrypts strings using the OS keychain (Keychain on macOS, libsecret on
  Linux, DPAPI on Windows). `isAvailable()` is `true` only inside an
  Electron process with an unlocked keychain; `encrypt()`/`decrypt()`
  degrade to passthrough (with a warning on `encrypt()`) outside Electron —
  unit tests and plain-Node CI never need environment branching of their
  own. The caller must ensure `isAvailable()` returns the same value at
  write time and read time: a ciphertext written while the keychain was
  available cannot be safely round-tripped if it becomes unavailable later
  (locked keychain, or data shared across an Electron and a non-Electron
  context) — `decrypt()` returns the raw base64 blob unchanged in that case.
- **`ElectronStoreService`** — a typed wrapper over `electron-store` (an
  ESM-only package, loaded via dynamic `import()` gated on
  `process.versions.electron` so plain-Node test environments never hit an
  `ERR_REQUIRE_ESM`). Outside Electron it falls back to an in-memory `Map`
  with an identical public API, so reads/writes just don't persist across
  process restarts in tests/CI. Its `AppStoreSchema` holds
  `wizardCompleted`, the selected `activeCloud`/AWS profile/region, the
  bootstrap step's last-submitted resource names (state bucket, configuration
  bucket — so Settings' "Reconfigure" flow can rehydrate a non-default name),
  pasted-credentials profiles keyed by profile name, the single
  in-progress add-game wizard draft (`addGameWizardDraft` — the draft's
  field values, which wizard step the operator was on, and when it was last
  autosaved; see [Draft autosave](/app/games#draft-autosave)), and
  `enableAutoUpdate` (off by default — gates `updater.ts`'s `electron-updater`
  checks; editable via the [Updates section](/app/settings#updates)'s toggle),
  and `folderUpload` (per-game `FolderUploadStoredState`: the saved folder selection and the last run's outcome).
  Every secret field (`aws.accessKeyId`, `aws.secretAccessKey`,
  `creds.aws.<profile>.accessKeyId`/`secretAccessKey`) is encrypted via
  `SafeStorageService` on write and decrypted on the dedicated getter — there
  is no path that reads or writes those fields' raw ciphertext directly.
  Decrypted pasted credentials must only ever be consumed inside main-process
  SDK client factories (e.g. `CloudProviderModule`'s `useFactory` providers)
  — never echoed back over IPC to the renderer. `addGameWizardDraft` is
  deliberately **not** encrypted this way at rest, even though its
  `environment` rows and file-seed rows can hold operator-entered values the
  operator might consider sensitive (e.g. a game server password) — the
  on-disk write matches the plaintext-at-rest posture of the
  `deployment-config.json` write the draft eventually becomes on submit,
  which also isn't field-level encrypted. Those specific fields
  (`environment[].value`, `file_seeds[].content`/`content_base64`, and —
  for a `healthCheck` credential — `secretArn`/`username`/`password`/
  `token`) are, however, never returned to the renderer:
  `GameWizardDraftService.get()` blanks them out before the result crosses
  the IPC boundary, so a draft resumed via the games-page banner comes back
  with row names/paths and the credential's chosen type (`authType`) intact,
  but those value fields empty — the operator re-enters them. `secretSet`,
  populated from the redacted read-side game-server shape rather than the
  draft itself, is the only signal that a credential is already configured.
  Only `save()` (from the main process, in response to the wizard's own
  autosave) ever writes the unredacted values; no read path echoes them
  back.

### AWS credential precedence for Pulumi operations

`PulumiCredentialResolver.ts`'s `resolveCredentialEnvVars()` turns the
wizard-selected credential source (`awsCredentialSource.ts`'s
`resolveAwsCredentialSource()`) into the `envVars` overlay
`PulumiWorkspaceService.getOrCreateStack()` merges into the Pulumi engine's
process environment. Getting this precedence wrong is the classic "why did
my apply just touch the wrong AWS account" footgun, so the rules are:

- **A named `~/.aws` profile wins over ambient pasted-key env vars, and vice
  versa.** Whichever source the wizard's credentials step selected sets its
  own variables (`AWS_PROFILE` for a profile, `AWS_ACCESS_KEY_ID` /
  `AWS_SECRET_ACCESS_KEY` / `AWS_SESSION_TOKEN` for pasted keys) — and
  **explicitly clears the other source's variables to `''`** in the same
  overlay, rather than merely omitting them.
- **Clearing, not omitting, is what makes the precedence hold.** The
  `envVars` overlay becomes an `execa` `env` option with `extendEnv: true`,
  which spreads `process.env` first and the overlay second. Omitting a key
  would leave whatever ambient value `process.env` happened to hold (an
  operator's shell `AWS_PROFILE`, a launcher's stray `AWS_ACCESS_KEY_ID`)
  completely untouched — silently outranking the wizard's selection. Setting
  the key to `''` instead means the overlay always wins for that key,
  because both the AWS SDK for Go (used by the `pulumi` CLI binary and its
  provider plugins) and the AWS SDK for JavaScript treat an empty string the
  same as "not set" for `AWS_PROFILE` / `AWS_ACCESS_KEY_ID` /
  `AWS_SECRET_ACCESS_KEY`.
- **The pasted-keys path also clears `AWS_SESSION_TOKEN`.** The paste flow
  never has a session token of its own to set, but an ambient one (e.g. from
  an `aws sso` / assume-role shell the app was launched from) must still be
  cleared — otherwise the final environment pairs the wizard's long-term
  pasted keys with a temporary session token for a different identity, which
  AWS rejects outright ("security token included in the request is
  invalid").
- **No credential source configured at all is a hard failure, never a
  silent fallback.** If the wizard's credentials step has never selected
  a profile, `resolveCredentialEnvVars()` throws
  `PulumiCredentialsNotConfiguredError` rather than returning an empty
  `envVars` object. An empty overlay would let the Pulumi engine fall
  through to its own default AWS credential chain — exactly the "operator's
  choice gets silently ignored" failure mode this resolver exists to
  prevent.

### `DeploymentConfigModule` / `DeploymentConfigService`

`DeploymentConfigService` is the S3-backed deployment-config JSON reader/parser
backing the Games page's declared-config view, the add/edit/remove game
flows, and drift detection — see `openspec/specs/desktop-only-operator-surface`'s
"No operator-editable configuration files" requirement. There is no
local-file fallback: `ConfigService.getConfigurationBucket()` resolves the
configured S3 bucket (the `HYVEON_CONFIG_BUCKET` env var as a dev/CI
override, otherwise `ElectronStoreService`'s `bootstrap.configurationBucket`
— the value the First-Run Wizard's bootstrap step persisted), and every
read/write goes through the injected `REMOTE_FILE_STORE` token keyed by the
fixed `CONFIGURATION_OBJECT_KEY` constant (`@hyveon/shared`,
`'deployment-config.json'`). When no bucket is configured,
`getGameServers()` resolves to `[]` (never rejects — its `isConfigured()`
method lets a caller distinguish "unconfigured" from "genuinely zero games"),
while the write paths and `getRawConfig()` throw a typed
`ConfigurationNotConfiguredError`. Parsed results are cached in-memory for
`CONFIG_CACHE_TTL_MS` (default 30 s) so repeated reads (e.g. drift checks)
don't re-fetch from S3 on every call; `invalidateCache()` is called after any
write. `ConfigService.getConfigurationBucket()` is the only backend-selection
path in the app: it checks the `HYVEON_CONFIG_BUCKET` env var (a dev/CI
override) before falling back to the wizard-persisted
`bootstrap.configurationBucket`, and returns `null` — never a local-file
path — when neither is set.

`getTopLevelSettings()`/`updateTopLevelSettings()` are the top-level-field
counterpart to `addGameServer()`/`updateGameServer()`/`removeGameServer()` —
same conditional-put/`OptimisticLockError` contract, but merging a patch onto
every field except `gameServers` (which `updateTopLevelSettings()` always
takes from the freshly-read document, never from the caller's patch, even if
a caller's payload contains a `gameServers` key at runtime). Backs the
`IacSettingsController` row above.

### Drift detection

`DriftService` (provided directly by `AppModule`, backing the `drift.get`
IPC channel and the [`/app/dashboard`](/app/dashboard) and
[`/app/games`](/app/games) pages' drift indicators) computes the difference
between the **declared** game-server config (`DeploymentConfigService.getGameServers()`
— what's in the configuration bucket's `deployment-config.json` right now)
and the **applied** config (`ConfigService.getStackOutputs()`'s
`appliedGameServers` field — what the Pulumi stack last actually applied).
Per game, the pure `computeDrift()` function classifies:

- **`pending_create`** — declared but not yet in the deployed set.
- **`pending_delete`** — deployed but no longer declared.
- **`config_drift`** — declared and deployed, but `image`/`cpu`/`memory`/
  `ports`/`volumes` differ from what was last applied, with `changedFields`
  listing exactly which. `ports`/`volumes` comparisons are order-insensitive
  (canonicalized before comparing), since JSON key order isn't guaranteed
  stable and reordering entries in the configuration isn't a real config
  change. A `webPort` change is reported under `ports` (there is no separate
  field), and both sides pass through `normalizeGameServer` before comparing,
  so a snapshot applied in the legacy https shape does not show as drift.
- Games matching on every compared field produce no entry — the report only
  lists what's out of sync.

`getDrift()` invalidates both `ConfigService`'s cached stack outputs and the
`DeploymentConfigService` cache first, so a fresh Pulumi apply or configuration edit is
reflected without an app restart.

## `@hyveon/cloud-aws`

`app/packages/cloud-aws` — the AWS implementation of the seven cloud-agnostic
contracts `@hyveon/shared/cloud.js` declares (`CloudProvider`, `SecretsStore`,
`RemoteFileStore`, `DiscordEventReceiver`, `AuditLogStore`,
`DiscordConfigStore`, `RunRecordStore`).
`CloudProviderModule` (see the module graph above) is the only place that
imports from this package directly — every other consumer in `desktop-main`
depends on the `@hyveon/shared` interface via one of the seven injection
tokens, never on a concrete class from here. Extracted as its own workspace
package (rather than living inside `desktop-main`) so a future non-AWS cloud
provider package can sit alongside it without `desktop-main` depending on
either concrete implementation.

## `@hyveon/desktop-preload`

`app/packages/desktop-preload` — the Electron preload script, run in a
privileged-but-sandboxed context between the main process and the renderer.
`contextBridge.exposeInMainWorld('hyveon', ...)` exposes the typed IPC
surface the renderer calls as `window.hyveon.*`; every method forwards to
`ipcRenderer.invoke(channel, ...args)`.
The `window.hyveon.folderUpload` namespace wraps the `folderUpload.*` channels (including `confirmOverwrite(game, proceed)`) and adds `onProgress`, which subscribes to the `folderUpload.progress` push via `ipcRenderer.on` and returns an unsubscribe function.

The `window.hyveon.volumeFiles` namespace wraps the 16 `volumeFiles.*` invoke channels one-to-one (`sessionStatus`/`Start`/`Attach`/`Detach`/`Stop`/`Restart`, `list`, `mkdir`, `rename`, `remove` → `volumeFiles.delete`, `readText`, `writeText`, `download`, `cancelTransfer`, `uploadFiles`, `uploadFolder`), typed with `@hyveon/shared/volumeFiles` shapes, and adds two more members. `uploadDropped(game, volume, dir, files)` takes the dropped `File` objects and resolves each to a local path with `webUtils.getPathForFile` *inside the preload* (Electron 32 removed `File.path`, and `webUtils` is only reachable here), then sends only the path strings on `volumeFiles.uploadFiles` as `localPaths`; the renderer never handles a local path, and a `File` it constructed itself resolves to `''`, which main rejects with `invalid-path`. `uploadFiles` deliberately omits `localPaths` so main opens its own file dialog. `onSession(cb)` and `onTransfer(cb)` subscribe to the `volumeFiles.session` and `volumeFiles.transfer` pushes via `ipcRenderer.on` and return an unsubscribe function. The two push-channel names are string literals in `preload.ts` rather than imports of the `@hyveon/shared/volumeFiles` constants, because the sandboxed preload cannot load that module at runtime (type imports are erased); a unit test in `preload.test.ts` pins them equal to the constants.

### `HYVEON_TEST_MODE` and the test seam

When `process.env.HYVEON_TEST_MODE === '1'` at preload-script load time, the
bridge gains an additional `window.hyveon.__test` namespace:

```ts
window.hyveon.__test.mock(channel, handler)   // handler: replacement fn or plain value
window.hyveon.__test.clearMocks()             // alias: reset()
```

Once a channel is mocked, every subsequent `invoke(channel, ...)` call
consults an internal `Map<string, fn>` before ever reaching
`ipcRenderer.invoke` — so a Playwright spec can drive the real Electron
shell and real React app while the Nest-side main process is never touched
for that channel. This backs the `electron` Playwright project's specs
(`electron-smoke.spec.ts`, `ipc-mock.spec.ts`, `discord.spec.ts`, and the
documentation screenshot harness — see the
[maintainer guide](/guides/maintainer#refreshing-the-documentation-screenshots)).

**This seam is gated off in production.** When `HYVEON_TEST_MODE` is unset —
the default for packaged/production builds and for `npm run desktop:dev`
without the flag explicitly set — the `if (isTestMode)` branch in the preload script
is never entered, and `window.hyveon.__test` is `undefined`. There is no
runtime toggle, config file, or IPC call that can expose the mock registry
to an end user's build.

## `@hyveon/web`

`app/packages/web` — React + Vite.

- **Entry**: `src/main.tsx` → `src/app.component.tsx`, rendered inside an
  Electron `BrowserWindow`. `main.tsx` calls two forwarding installers from
  `src/lib/report-renderer-error.utils.ts` before rendering:
  `installGlobalErrorReporting()` (wires `window.onerror`/`unhandledrejection`
  to `diagnostics.reportError`) and `installConsoleForwarding()` (wraps
  `console.log`/`info`/`warn`/`error` so every call is both printed to
  devtools as normal and queued for batched delivery to
  `diagnostics.reportLog` — a no-op wherever the bridge doesn't implement
  `diagnostics.reportLog`, which includes the `chromium` Playwright
  project's HTTP-polyfilled `window.hyveon` stub as well as a genuinely
  absent bridge). For the Diagnostics panel UI this backs, see
  [`/app/settings`](/app/settings#diagnostics).
- **Auth**: none — there's no bearer token, no login prompt, and nothing in
  `localStorage` gating API access. The renderer's `window.hyveon` bridge is
  only reachable from the app's own preload-scoped context.

### Routes

The renderer is a multi-route single-page app (`react-router`), not a single
dashboard screen. `app.component.tsx` routes via `HashRouter`, not
`BrowserRouter`: the packaged renderer loads via `win.loadFile()`
(`file:///C:/...` on Windows, drive letter included), and `BrowserRouter`'s
absolute-path route matching breaks against that prefix. `HashRouter` keeps
the route entirely after a `#`, unaffected by the underlying `file://` path —
so every path below is addressed at runtime as `/#<path>` (e.g. `/#/costs`),
not the bare path:

| Path | Page | See |
|---|---|---|
| `/` | Dashboard — game cards, KPI strip, start/stop | [`/app/dashboard`](/app/dashboard) |
| `/games`, `/games/:name` | Games list + game detail | [`/app/games`](/app/games) |
| `/games/:name/files` | In-app game volume file browser (`VolumeFilesPage`); reached from the dashboard's Files action and the game detail page's Files link | [Renderer file browser](#renderer-file-browser) below |
| `/iac`, `/iac/history`, `/iac/history/:runId` | Plan/apply/destroy, run history, run detail | [`/app/iac`](/app/iac) |
| `/discord` | Discord bot credentials, guilds, admins, per-game permissions | [`/app/discord`](/app/discord) |
| `/logs` | Live log viewer for one game server | [`/app/logs`](/app/logs) |
| `/logs/infrastructure` | Live log viewer for one of the app's 5 Lambda functions, reached via the sidebar's **Infra Logs** child link | [`/app/logs`](/app/logs) |
| `/costs` | Per-game Fargate cost estimates, AWS Cost Explorer link-out | [`/app/costs`](/app/costs) |
| `/audit` | Audit log entries | [`/app/audit`](/app/audit) |
| `/settings` | Watchdog summary, cloud health, cloud setup, updates, deployment settings, diagnostics | [`/app/settings`](/app/settings) |
| — | First-run setup wizard, shown in place of the router until `wizardCompleted` | [`/app/first-run-wizard`](/app/first-run-wizard) |

### Renderer file browser

`pages/volume-files.page.tsx` (`VolumeFilesPage`, route `/games/:name/files`) is the only file-browsing UI; it replaced the dashboard's file-manager modal and the `files.*` IPC channels. It reaches main only through `api.service.ts`'s `volume*` methods, which delegate to `window.hyveon.volumeFiles` (the [`VolumeFilesController` contract](#volumefilescontroller-contract)). The dashboard's Files action navigates with router state `{ autoStart: true }`, which makes the page launch the session once when it is `stopped` or `failed`, then clears the state so Back and refresh do not relaunch; any other way of opening the page only shows the session's state.

| Piece (`components/volume-files/`) | Role |
|---|---|
| `use-volume-session.hook.ts` | Attaches to the game's session on mount and detaches on unmount (so the registry's 5-minute browse grace timer, not a closed page, decides when the helper stops). Applies `volumeFiles.session` pushes, polls status every 3 s while `starting` or `stopping`, and exposes `start`/`stop`/`restart` plus the last action error. Needs `<PollingProvider>`. |
| `use-volume-files.hook.ts` | Listing, sort and navigation for one volume (a game or volume change resets the path to the root), plus the mkdir, rename, remove, read and write text, download and upload actions, and the transfers from `use-volume-transfers`. Does nothing until the session is ready. |
| `use-volume-transfers.hook.ts` | Follows the `volumeFiles.transfer` push for the game, upserting rows by `transferId`; refreshes the listing when an upload settles as `done`. |
| `use-server-guard.hook.ts` | Blocks mutations while the game server is `starting`/`running`, or when its state cannot be confirmed (a `server-running` or `server-check-failed` result latches the block until a later status reads `stopped`). Needs `<GameStatusProvider>`. This mirrors the fail-closed stopped-server check main enforces. |
| Components | `SessionBar` (state and start/stop/restart), `VolumePicker`, `VolumeBrowser` (composes the table, breadcrumb, toolbar, dialogs, drop zone and transfer list), plus the server banner, name dialog and text editor dialog. |

The folder-upload card's "stop the open session and retry" action calls `volumeFiles.session.stop` (`api.volumeSessionStop`), the same stop the file browser page uses, since the registry owns every helper.

For what each screen looks like and how to use it, start at
[Using the app](/app) — this page stays at the wiring level (IPC channels,
services, module graph).

### API layer

`src/api.service.ts` exports a single `api` object with one method per IPC
channel. Every call is delegated straight to `window.hyveon.*` — there are no
`fetch` calls and no bearer-token plumbing anywhere in this module.

### Vite dev config

`vite.config.ts` serves the renderer on `:5173` for HMR purposes only; it is
driven by electron-vite (see `electron.vite.config.ts`), not accessed
directly as a network API. Production builds to `dist/`, packed into the
Electron app's asar archive.

### Running e2e tests

The web package ships a [Playwright](https://playwright.dev/) harness with two projects, migrating from the first to the second: `chromium` runs specs against the **production build** (`vite build` + `vite preview`), polyfilling `window.hyveon` with an HTTP bridge so every `/api/*` call can be stubbed via `page.route()`; `electron` launches the packaged Electron app directly via `_electron.launch()` and stubs IPC responses through the `window.hyveon.__test.mock()` test bridge instead. The Nest server never starts in either project.

```bash
# One-off (builds the app, starts vite preview, runs specs, exits)
npm run app:test:e2e

# Keep vite preview running between runs (set PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD if already installed)
cd app/packages/web
npm run build && npm run preview &   # leave running
npx playwright test                   # fast re-run without rebuilding
```

First-time setup — install the Chromium browser binary:

```bash
cd app/packages/web
npx playwright install chromium
```

Specs live under `app/packages/web/e2e/specs/`. Shared stubs and fixtures are in `app/packages/web/e2e/fixtures/`. On CI, Playwright uploads traces and videos as artifacts when a spec fails; see `.github/workflows/e2e.yml`.
