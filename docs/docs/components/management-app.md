---
title: Management app
sidebar_position: 3
---

# Management app

A TypeScript npm-workspaces monorepo under `app/`. It ships as a packaged
**Electron desktop app** — three packages make up the local control plane: a
Nest.js backend (`desktop-main`), a React dashboard renderer (`web`), and a
pure shared library — plus the four Lambda packages documented
[here](/components/lambdas). There is no HTTP server and no bearer token
anywhere in this app: the renderer talks to the backend exclusively over
Electron IPC, via `window.gsd` (the `desktop-preload` bridge).

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
server **and** all four Lambdas. The canonical location for cross-boundary
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
  `ElectronStoreModule`.
- **`AwsModule`** — provides `ConfigService`, `Ec2Service`, `EcsService`,
  `LogsService`, `CostService`, `FileManagerService`. All exported.
- **`DiscordModule`** — imports `AwsModule`; provides
  `DiscordConfigService` and `DiscordCommandRegistrar`. No discord.js,
  no gateway — the bot is two Lambdas plus Discord's REST API.

### Controllers and IPC channels

Every controller is IPC-only: handlers are bound to a channel name via
`@MessagePattern()`/`@Payload()` — there are no HTTP routes anywhere in this
app. The renderer calls into these via `window.gsd.*` (the preload bridge),
which forwards to `ipcRenderer.invoke(channel, ...)`.

| Controller | Representative channels | Purpose |
|---|---|---|
| `GamesController` | `games.list`, `games.status`, `games.getStatus`, `games.start`, `games.stop`, `games.create`, `games.update`, `games.delete` | List/read status, trigger RunTask/StopTask, manage `game_servers` config entries. Invalidates `ConfigService`'s tfstate cache on list/status reads so fresh applies are picked up without restarting. |
| `ConfigController` | `config.get`, `config.update` | Read/write watchdog knobs in `server_config.json`. Takes effect on next `terraform apply` (the values are baked into Lambda env). |
| `CostsController` | `costs.estimate`, `costs.actual` | Per-game Fargate estimates; Cost Explorer actuals grouped by the `Project` tag. |
| `LogsController` | `logs.get`, `logs.stream` | Snapshot of last N log events; a streaming channel that pushes new events as they arrive (polls `FilterLogEvents` every 2 s under the hood). |
| `FilesController` | `files.list`, `files.start`, `files.stop` | Ad-hoc FileBrowser task against the game's EFS access point. |
| `DiscordController` | `discord.getConfig`, `discord.putConfig`, `discord.listGuilds`, `discord.addGuild`, `discord.removeGuild`, `discord.registerCommands`, `discord.getAdmins`, `discord.putAdmins`, `discord.getPermissions`, `discord.putPermission`, `discord.deletePermission` | Read-redacted config, save credentials, manage guild allowlist + commands, admins, per-game permissions. |
| `EnvController`, `DiagnosticsController`, `DriftController`, `AuditController` | `env.get`; `diagnostics.tail`/`diagnostics.path`; `drift.get`; `audit.list` | Environment info, log-tail diagnostics, config-drift detection, and the audit-log view. |
| `TerraformController`, `TerraformRunsController` | `terraform.init`, `terraform.plan`, `terraform.apply`, `terraform.destroy`, `terraform.output`, `terraform.approve`, `terraform.rollback.*`, `terraform.runs.*` | Drives `terraform` as a child process for the apply pipeline; run history is recorded for the apply-history view. |
| `WizardController` | first-run wizard channels (prerequisites, AWS profile/credentials, bootstrap, IAM check, progress) | Backs the in-app setup wizard — see the [setup guide](/setup). |

### Key services

- **`ConfigService`** — single place that parses `terraform.tfstate` into a
  `TfOutputs` object (cluster ARN, subnets, SGs, EFS access points, game
  names, hosted zone, Discord table + secret ARNs, interactions URL).
  Caches in-memory; `invalidateCache()` is called by the games controller
  on list/status so a new `terraform apply` is picked up without an app
  restart. State resolution order: (1) runtime `terraform/terraform.tfstate`;
  (2) `null` — callers degrade gracefully so the dashboard can render even
  pre-apply.
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
  `FileManagerService`** — thin wrappers over the AWS SDK v3 clients.
  `LogsService.streamLogs(game, signal)` is an `AsyncGenerator` that polls
  `FilterLogEvents` every 2 s; `getRecentLogs` remains the snapshot path.

### Auth

There is no request-level auth to configure — Electron IPC is only reachable
from the app's own renderer process (via the `contextBridge`-exposed
`window.gsd`), not from the network. There is no bearer token, no
`API_TOKEN`, and no equivalent of the old `ApiTokenGuard` anywhere in this
app.

### Logging

Winston in `src/logger.ts`. Dev: colourised timestamps + JSON metadata.
Prod: JSON lines with ISO timestamps. Use `logger.info` / `warn` / `error`
everywhere, not `console.log`.

### Env vars

| Name | Default | Purpose |
|---|---|---|
| `AWS_REGION` / `AWS_DEFAULT_REGION` | — | SDK region. Fallback via `ConfigService`. |

## `@hyveon/web`

`app/packages/web` — React + Vite.

- **Entry**: `src/main.tsx` → `src/App.tsx`, rendered inside an Electron
  `BrowserWindow`.
- **Auth**: none — there's no bearer token, no login prompt, and nothing in
  `localStorage` gating API access. The renderer's `window.gsd` bridge is
  only reachable from the app's own preload-scoped context.

### Dashboard layout

1. **Game cards** — per-game Start/Stop, state badge, IP/hostname. Polls
   game status and cost estimates every 20 s via `hooks/useGameStatus`.
2. **Cost panel** — hourly/daily/4h-per-day estimates + last-7-days actual
   from Cost Explorer (requires the `Project` cost-allocation tag to be
   activated in AWS Billing).
3. **Server Config** — watchdog knobs. Saves go to `server_config.json`;
   take effect on next `terraform apply`.
4. **Discord Bot** — four tabs: Credentials, Guilds, Admins, Per-Game
   Permissions. See the [user guide](/guides/user)
   for the day-to-day workflow.
5. **Live Logs** — fetches a snapshot of the last 50 events on game change,
   then opens a streaming IPC channel (`logs.stream`) that appends new
   lines as they arrive (capped at 1 000 lines in the DOM). Pause/Resume
   toggle buffers incoming lines without scrolling.
6. **File Manager modal** — spawns a FileBrowser Fargate task against the
   game's EFS access point so you can inspect/upload saves without
   starting the game itself.

### API layer

`src/api.service.ts` exports a single `api` object with one method per IPC
channel. Every call is delegated straight to `window.gsd.*` — there are no
`fetch` calls and no bearer-token plumbing anywhere in this module.

### Vite dev config

`vite.config.ts` serves the renderer on `:5173` for HMR purposes only; it is
driven by electron-vite (see `electron.vite.config.ts`), not accessed
directly as a network API. Production builds to `dist/`, packed into the
Electron app's asar archive.

### Running e2e tests

The web package ships a [Playwright](https://playwright.dev/) harness that runs specs against the **production build** (`vite build` + `vite preview`). Every `/api/*` call is stubbed at the network layer — the Nest server never starts.

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
