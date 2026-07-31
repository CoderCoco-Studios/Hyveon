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

Dev mode (`npm run app:dev`) launches the full Electron app with hot-reload
on renderer saves; electron-vite serves the renderer for HMR purposes only —
it is not a network API surface. See the [setup guide](/setup) for the
packaged-installer build.

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
| `formatStatus.ts` | `formatGameStatus(status)` — Discord-ready one-liner with emoji and hostname. |
| `ddb/client.ts` | Lazy DynamoDB DocumentClient. Region fallback: `AWS_REGION_` → `AWS_REGION` → `AWS_DEFAULT_REGION` → `us-east-1`. |
| `ddb/configStore.ts` | `getDiscordConfig()` / `putDiscordConfig()` for the `CONFIG#discord` row. |
| `ddb/pendingStore.ts` | `getPending()` / `putPending()` / `deletePending()` for `PENDING#{taskArn}`. `putPending()` sets `expiresAt = now + 15 minutes` so DDB TTL reaps stale rows. |
| `secrets/secretsStore.ts` | Secrets Manager wrapper with a 5-minute in-process cache. Recognises Terraform's `"placeholder"` seed as "not configured". `invalidateSecretsCache()` is called by the Nest credentials endpoint. |

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
3. `app.listen()` starts the transport, registering its internal
   `@MessagePattern` dispatch.
4. `registerIpcMainBridges(strategy)` bridges each of those patterns onto a
   real `ipcMain.handle` registration, so `ipcRenderer.invoke` calls from
   the renderer resolve instead of hanging.

There is no listen port, no `NODE_ENV=production` bearer-token check, and no
static-file serving — the renderer is a separate Electron `BrowserWindow`
loading the built Vite bundle (or the Vite dev server in dev mode), and it
never speaks HTTP to this process.

### Module graph

- **`AppModule`** — root. Imports `AwsModule`, `DiscordModule`,
  `TfvarsModule`, `TerraformModule`, `WizardModule`, and
  `ElectronStoreModule`. Also directly provides a handful of
  controller-adjacent services that don't warrant their own module
  (`DiagnosticsService`, `DriftService`, `GamesWriteService`,
  `AuditService`) plus the `DIAGNOSTICS_LOG_DIR` token.
- **`ConfigModule`** — standalone module providing just `ConfigService`, the
  `terraform.tfstate`-backed configuration reader. Extracted on its own so
  every other feature module can depend on it without pulling in `AwsModule`.
- **`CloudProviderModule`** — imports `ConfigModule`. Binds six
  cloud-agnostic contracts (from `@hyveon/shared/cloud.js`) to concrete
  `@hyveon/cloud-aws` implementations via `useFactory` providers keyed off
  `ConfigService.getActiveCloud()`: `CLOUD_PROVIDER`, `SECRETS_STORE`,
  `REMOTE_FILE_STORE`, `DISCORD_RECEIVER`, `AUDIT_LOG_STORE`, and
  `RUN_RECORD_STORE` (all declared in `cloud-provider.tokens.ts`). Consumers
  inject via `@Inject(CLOUD_PROVIDER)` etc. and depend only on the
  `@hyveon/shared` interface — never the concrete AWS class — so swapping the
  active cloud is a one-module change, not a call-site hunt. Today every
  token still resolves to AWS; a future non-AWS provider is added by
  extending the `CLOUD_BINDINGS` registry in `cloud-provider.module.ts`, not
  by touching this module's provider definitions.
- **`AwsModule`** — imports `ConfigModule` and `CloudProviderModule`
  (re-exporting both); provides and exports `Ec2Service`, `EcsService`,
  `LogsService`, `CostService`, `FileManagerService`. It no longer provides
  `ConfigService` directly (that's `ConfigModule`'s job — `AwsModule`
  re-exports it for existing consumers that import `AwsModule` expecting
  `ConfigService` to be available) and no longer wires `AwsCloudProvider`/
  `AwsSecretsStore` itself — `EcsService` injects `CLOUD_PROVIDER` and
  `DiscordConfigService` injects `SECRETS_STORE`, both bound by
  `CloudProviderModule`.
- **`DiscordModule`** — imports `AwsModule`; provides
  `DiscordConfigService` and `DiscordCommandRegistrar`. No discord.js,
  no gateway — the bot is two Lambdas plus Discord's REST API.
- **`TfvarsModule`** — imports `ConfigModule` and `CloudProviderModule`
  (for the `REMOTE_FILE_STORE` token); provides `TfvarsService`, the
  S3-backed deployment-config JSON reader/parser. There is no local-file
  fallback — see [`TfvarsModule` / `TfvarsService`](#tfvarsmodule--tfvarsservice)
  below.
- **`TerraformModule`** — imports `ConfigModule`, `CloudProviderModule`
  (for `REMOTE_FILE_STORE` and `RUN_RECORD_STORE`), and `TfvarsModule`
  (for the rollback flow); provides `TerraformService`, `RunService`
  (the apply-lock guard), and `RunRecordService` (run-history persistence).
- **`WizardModule`** — imports `ElectronStoreModule`; provides
  `PrerequisiteService`, `AwsProfileService`, `BootstrapService`,
  `IamCheckService`, `FirstRunWizardService` for the first-run setup wizard.
- **`ElectronStoreModule`** — provides `SafeStorageService` (OS-keychain
  encryption) and `ElectronStoreService` (the typed `electron-store`
  consumer built on top of it). See
  [Credential storage at rest](#credential-storage-at-rest) below.

### Controllers and IPC channels

Every controller is IPC-only: handlers are bound to a channel name via
`@MessagePattern()`/`@Payload()` — there are no HTTP routes anywhere in this
app. The renderer calls into these via `window.hyveon.*` (the preload bridge),
which forwards to `ipcRenderer.invoke(channel, ...)`.

| Controller | Representative channels | Purpose |
|---|---|---|
| `GamesController` | `games.list`, `games.status`, `games.getStatus`, `games.start`, `games.stop`, `games.create`, `games.update`, `games.delete` | List/read status, trigger RunTask/StopTask, manage `game_servers` config entries. Invalidates `ConfigService`'s tfstate cache on list/status reads so fresh applies are picked up without restarting. |
| `ConfigController` | `config.get`, `config.update` | Read/write watchdog knobs in `server_config.json`. Takes effect on next `terraform apply` (the values are baked into Lambda env). |
| `CostsController` | `costs.estimate`, `costs.actual` | Per-game Fargate estimates; Cost Explorer actuals filtered on the `SERVICE` dimension (ECS + Fargate) — account-wide, **not** scoped by the `Project` tag. See [Costs](/app/costs#activate-the-project-cost-allocation-tag). |
| `LogsController` | `logs.get`, `logs.stream` | Snapshot of last N log events; a streaming channel that pushes new events as they arrive (polls `FilterLogEvents` every 2 s under the hood). |
| `FilesController` | `files.list`, `files.start`, `files.stop` | Ad-hoc FileBrowser task against the game's EFS access point. |
| `DiscordController` | `discord.getConfig`, `discord.putConfig`, `discord.listGuilds`, `discord.addGuild`, `discord.removeGuild`, `discord.registerCommands`, `discord.getAdmins`, `discord.putAdmins`, `discord.getPermissions`, `discord.putPermission`, `discord.deletePermission` | Read-redacted config, save credentials, manage guild allowlist + commands, admins, per-game permissions. |
| `EnvController`, `DiagnosticsController`, `DriftController`, `AuditController` | `env.get`; `diagnostics.tail`/`diagnostics.path`; `drift.get`; `audit.list` | Environment info, log-tail diagnostics, config-drift detection, and the audit-log view. |
| `TerraformController`, `TerraformRunsController` | `terraform.init`, `terraform.plan`, `terraform.apply`, `terraform.destroy.mintToken`, `terraform.destroy`, `terraform.output`, `terraform.approve`, `terraform.rollback.resolve`, `terraform.rollback.confirm`, `terraform.runs.*` | Drives `terraform` as a child process for the apply pipeline; `terraform.destroy.mintToken` issues the type-to-confirm token the UI requires before a `destroy` call is accepted; run history is recorded for the apply-history view. |
| `IacSettingsController` | `iac.settings.get`, `iac.settings.update` | Reads/writes every top-level `deployment-config.json` field EXCEPT `gameServers` — backs the Settings page's [General section](/app/settings#general). `update` validates via the shared `validateDeploymentSettingsPatch` (`@hyveon/shared`) before delegating to `TfvarsService.updateTopLevelSettings()`; a stale `expectedVersionId` returns `{ code: 'conflict' }` rather than silently overwriting a concurrent edit. |
| `WizardController` | first-run wizard channels (prerequisites, AWS profile/credentials, bootstrap, IAM check, progress) | Backs the in-app setup wizard — see the [setup guide](/setup). |

### Key services

- **`ConfigService`** — single place that parses `terraform.tfstate` into a
  `TfOutputs` object (cluster ARN, subnets, SGs, EFS access points, game
  names, hosted zone, Discord table + secret ARNs, interactions URL).
  Caches in-memory; `invalidateCache()` is called by the games controller
  on list/status so a new `terraform apply` is picked up without an app
  restart. `getTfStatePath()` resolution order: (1) `TF_STATE_PATH` env var,
  if set; (2) when running as a packaged Electron app
  (`app.isPackaged`), `<resourcesPath>/terraform/aws/terraform.tfstate`;
  (3) dev/test fallback — the repo-root `terraform/terraform.tfstate`. A
  missing or unparsable state file degrades to `null` rather than throwing,
  so the dashboard can still render pre-apply. Other paths
  (`getServerConfigPath()`, the Terraform composer root) follow the same
  env-var → packaged-resourcesPath → dev-fallback shape — see the
  [environment variables](#env-vars) table below for each one's specific env
  var name. `getConfigurationBucket()` (the configuration S3 bucket name) is
  a different shape entirely — see
  [`TfvarsModule` / `TfvarsService`](#tfvarsmodule--tfvarsservice) below.
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
- **`EcsService` / `Ec2Service` / `LogsService` / `CostService` /
  `FileManagerService`** — cloud-facing services. `EcsService` routes
  ECS run/stop/status calls through the injected `CLOUD_PROVIDER` token
  (a `CloudProvider` implementation from `@hyveon/cloud-aws`) rather than
  instantiating an `@aws-sdk/client-ecs` client directly; `Ec2Service` /
  `LogsService` / `CostService` / `FileManagerService` still call the AWS
  SDK v3 clients (CloudWatch Logs, Cost Explorer, EC2) directly, since
  those aren't yet behind a cloud-agnostic contract. New cloud-facing code
  should prefer adding to (or consuming) the `CLOUD_PROVIDER` /
  `SECRETS_STORE` / `REMOTE_FILE_STORE` / `DISCORD_RECEIVER` /
  `AUDIT_LOG_STORE` / `RUN_RECORD_STORE` tokens over reaching for a new AWS
  SDK client directly — see the [maintainer guide](/guides/maintainer#when-you-touch-the-nest-server).
  `LogsService.streamLogs(game, signal)` is an `AsyncGenerator` that polls
  `FilterLogEvents` every 2 s; `getRecentLogs` remains the snapshot path.
- **`DriftService`** — see [Drift detection](#drift-detection) below.
- **`TfvarsService`** — see [`TfvarsModule` / `TfvarsService`](#tfvarsmodule--tfvarsservice) below.

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

### Env vars

| Name | Default | Purpose |
|---|---|---|
| `AWS_DEFAULT_REGION` | — | AWS SDK region hint, read by `ConfigService.readEnvRegion()`. |
| `TF_STATE_PATH` | — | Overrides the resolved path to `terraform.tfstate` (see `ConfigService.getTfStatePath()` resolution order above). |
| `TF_DIR` | — | Overrides the Terraform composer root (`terraform/`, not `terraform/aws/`) that `TerraformService` spawns the `terraform` binary in. |
| `SERVER_CONFIG_PATH` | — | Overrides the resolved path to `server_config.json` (the watchdog-knob store). Same env → packaged → dev-fallback resolution shape as `TF_STATE_PATH`. |
| `TFVARS_CACHE_TTL_MS` | `30000` | In-memory cache TTL for `TfvarsService`'s parsed configuration. Falls back to the default when unset, empty, non-numeric, or non-positive. |
| `RUNS_DIR_PATH` | `<tmpdir>/hyveon-runs` | Directory `TerraformService` writes per-run plan/apply artifacts under. |
| `HYVEON_TFVARS_BUCKET` | — | Dev/CI override for the S3 configuration bucket name `TfvarsService`/`TerraformService` read/write against — wins over the operator-configured value. Not how the packaged app resolves the bucket in normal use; see [`TfvarsModule` / `TfvarsService`](#tfvarsmodule--tfvarsservice) below for the real resolution order. |
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
  bootstrap step's last-submitted resource names (state bucket, tfvars
  bucket — so Settings' "Reconfigure" flow can rehydrate a non-default name),
  and pasted-credentials profiles keyed by profile name. Every secret
  field (`aws.accessKeyId`, `aws.secretAccessKey`,
  `creds.aws.<profile>.accessKeyId`/`secretAccessKey`) is encrypted via
  `SafeStorageService` on write and decrypted on the dedicated getter — there
  is no path that reads or writes those fields' raw ciphertext directly.
  Decrypted pasted credentials must only ever be consumed inside main-process
  SDK client factories (e.g. `CloudProviderModule`'s `useFactory` providers)
  — never echoed back over IPC to the renderer.

### `TfvarsModule` / `TfvarsService`

`TfvarsService` is the S3-backed deployment-config JSON reader/parser
backing the Games page's declared-config view, the add/edit/remove game
flows, and drift detection — see `openspec/specs/desktop-only-operator-surface`'s
"No operator-editable configuration files" requirement. There is no
local-file fallback: `ConfigService.getConfigurationBucket()` resolves the
configured S3 bucket (the `HYVEON_TFVARS_BUCKET` env var as a dev/CI
override, otherwise `ElectronStoreService`'s `bootstrap.configurationBucket`
— the value the First-Run Wizard's bootstrap step persisted), and every
read/write goes through the injected `REMOTE_FILE_STORE` token keyed by the
fixed `CONFIGURATION_OBJECT_KEY` constant (`@hyveon/shared`,
`'deployment-config.json'`). When no bucket is configured,
`getGameServers()` resolves to `[]` (never rejects — its `isConfigured()`
method lets a caller distinguish "unconfigured" from "genuinely zero games"),
while the write paths and `getRawConfig()` throw a typed
`ConfigurationNotConfiguredError`. Parsed results are cached in-memory for
`TFVARS_CACHE_TTL_MS` (default 30 s) so repeated reads (e.g. drift checks)
don't re-fetch from S3 on every call; `invalidateCache()` is called after any
write. `scripts/tfvars-sync.ts`'s own local-vs-S3 backend choice (see the
[S3 tfvars storage guide](/guides/s3-tfvars)) is a separate, maintainer-facing
CLI concern — it does not share this resolution mechanism.

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
between the **declared** game-server config (`TfvarsService.getGameServers()`
— what's in the configuration bucket's `deployment-config.json` right now)
and the **applied** config (`ConfigService.getTfOutputs()?.applied_game_servers`
— what Terraform last actually applied). Per game, the pure `computeDrift()`
function classifies:

- **`pending_create`** — declared but not yet in the deployed set.
- **`pending_delete`** — deployed but no longer declared.
- **`config_drift`** — declared and deployed, but `image`/`cpu`/`memory`/
  `ports`/`volumes` differ from what was last applied, with `changedFields`
  listing exactly which. `ports`/`volumes` comparisons are order-insensitive
  (canonicalized before comparing), since JSON key order isn't guaranteed
  stable and reordering entries in the configuration isn't a real config
  change.
- Games matching on every compared field produce no entry — the report only
  lists what's out of sync.

`getDrift()` invalidates both the tfstate cache and the `TfvarsService`
cache first, so a fresh `terraform apply` or tfvars edit is reflected
without an app restart.

## `@hyveon/cloud-aws`

`app/packages/cloud-aws` — the AWS implementation of the six cloud-agnostic
contracts `@hyveon/shared/cloud.js` declares (`CloudProvider`, `SecretsStore`,
`RemoteFileStore`, `DiscordEventReceiver`, `AuditLogStore`, `RunRecordStore`).
`CloudProviderModule` (see the module graph above) is the only place that
imports from this package directly — every other consumer in `desktop-main`
depends on the `@hyveon/shared` interface via one of the six injection
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
the default for packaged/production builds and for `npm run app:dev` without
the flag explicitly set — the `if (isTestMode)` branch in the preload script
is never entered, and `window.hyveon.__test` is `undefined`. There is no
runtime toggle, config file, or IPC call that can expose the mock registry
to an end user's build.

## `@hyveon/web`

`app/packages/web` — React + Vite.

- **Entry**: `src/main.tsx` → `src/App.tsx`, rendered inside an Electron
  `BrowserWindow`.
- **Auth**: none — there's no bearer token, no login prompt, and nothing in
  `localStorage` gating API access. The renderer's `window.hyveon` bridge is
  only reachable from the app's own preload-scoped context.

### Routes

The renderer is a multi-route single-page app (`react-router`), not a single
dashboard screen. `app.component.tsx` declares:

| Path | Page | See |
|---|---|---|
| `/` | Dashboard — game cards, KPI strip, start/stop | [`/app/dashboard`](/app/dashboard) |
| `/games`, `/games/:name` | Games list + game detail | [`/app/games`](/app/games) |
| `/terraform`, `/terraform/history`, `/terraform/history/:runId` | Plan/apply/destroy, run history, run detail | [`/app/terraform`](/app/terraform) |
| `/discord` | Discord bot credentials, guilds, admins, per-game permissions | [`/app/discord`](/app/discord) |
| `/logs` | Live log viewer | [`/app/logs`](/app/logs) |
| `/costs` | Cost estimates and actuals | [`/app/costs`](/app/costs) |
| `/audit` | Audit log entries | [`/app/audit`](/app/audit) |
| `/settings` | Watchdog knobs, cloud setup, diagnostics | [`/app/settings`](/app/settings) |
| — | First-run setup wizard, shown in place of the router until `wizardCompleted` | [`/app/first-run-wizard`](/app/first-run-wizard) |

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
