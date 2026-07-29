# desktop-only-operator-surface

## Purpose

Defines the desktop-only operator surface for Hyveon: `@hyveon/desktop-main` is an Electron IPC microservice with no HTTP transport, the repo carries no legacy container/shell deployment story, `ConfigService` carries no API-token plumbing, operator-facing documentation describes only the Electron desktop workflow, and the test harnesses (unit, tier-2 integration, and both e2e Playwright projects) run without depending on the removed HTTP surface. It also governs the integrity of the surface the operator actually touches: every routed screen is reachable from the sidebar, the chrome renders no dead controls, streaming IPC channels survive the preload context bridge, and navigation carries the operator's context with it.

## Requirements

### Requirement: Desktop-main exposes no HTTP transport

`@hyveon/desktop-main` SHALL expose its API exclusively over the Electron IPC microservice transport. No `*-http.controller.ts` shim controller SHALL exist in `app/packages/desktop-main/src/controllers/`, `AppModule` MUST NOT register any HTTP controller, and the package MUST NOT depend on `@nestjs/platform-express`, `express`, or `@types/express`.

#### Scenario: No HTTP shim controllers remain

- **WHEN** `app/packages/desktop-main/src/controllers/` is listed
- **THEN** no file matching `*-http.controller.ts` or `*-http.controller.test.ts` exists, and `app.module.ts` imports and registers only IPC controllers

#### Scenario: Application boots IPC-only

- **WHEN** the desktop-main process bootstraps via `main.ts`
- **THEN** the Nest application is created with `NestFactory.createMicroservice` using the Electron IPC transport strategy, and no HTTP server listens on any port

#### Scenario: Express dependencies removed

- **WHEN** `app/packages/desktop-main/package.json` is inspected after the shim deletion
- **THEN** `@nestjs/platform-express`, `express`, and `@types/express` are absent from its dependency lists and `npm run app:build` still compiles the workspace

### Requirement: No container or shell deployment artifacts at the repo root

The repository SHALL NOT contain the pre-pivot container/shell deployment story. `Dockerfile`, `docker-compose.yml`, `Makefile`, `setup.sh`, and `setup.ps1` MUST be absent from the repo root, and no CI workflow MUST build or run the Docker image.

#### Scenario: Legacy deployment files deleted

- **WHEN** the repo root is listed
- **THEN** `Dockerfile`, `docker-compose.yml`, `Makefile`, `setup.sh`, and `setup.ps1` do not exist

#### Scenario: CI has no Docker steps

- **WHEN** the workflows in `.github/workflows/` are searched for `docker`, `Dockerfile`, or `setup.sh`
- **THEN** no workflow step references them

### Requirement: ConfigService carries no API-token plumbing

`ConfigService` SHALL NOT resolve, parse, or expose an API token. The `API_TOKEN` environment accessor and the `api_token` field handling in `server_config.json` MUST be removed. `server_config.json` handling SHALL remain solely for the watchdog tunables consumed by `ConfigController` and the Settings page.

#### Scenario: api_token stripped from ConfigService

- **WHEN** `app/packages/desktop-main/src/services/ConfigService.ts` and its tests are searched for `api_token`, `API_TOKEN`, or `apiToken`
- **THEN** no match exists, and no other production module in the workspace references an API token

#### Scenario: Watchdog tunables still persist

- **WHEN** the operator updates watchdog settings through the Settings page
- **THEN** `ConfigService` reads and writes the watchdog tunables in `server_config.json` exactly as before the removal

### Requirement: Documentation describes only the desktop workflow

Operator-facing documentation SHALL describe only the Electron desktop workflow. `CLAUDE.md`, `README.md`, `docs/docs/setup.md`, `docs/docs/architecture.md`, `docs/docs/intro.md`, `docs/docs/components/management-app.md`, and the guides under `docs/docs/guides/` MUST NOT instruct operators to run Docker/`docker compose`, execute `setup.sh`/`setup.ps1`, use the wrapper `Makefile`, or configure an API bearer token, and `docs/docs/architecture.md` MUST present the Electron app driving desktop-main over IPC (not a Nest HTTP API) as the control plane.

#### Scenario: No doc points at removed surface

- **WHEN** the docs listed above are searched for Docker run instructions, `setup.sh`/`setup.ps1` bootstrap steps, wrapper-`Makefile` usage, or `ApiTokenGuard`/bearer-token configuration presented as current behavior
- **THEN** no such instruction remains

#### Scenario: CLAUDE.md reflects current architecture

- **WHEN** `CLAUDE.md` is read after the refresh
- **THEN** it contains no "API authentication" section describing the deleted `ApiTokenGuard`, no `docker compose up` run instructions, and no `./setup.sh` bootstrap step

### Requirement: Test harnesses do not depend on the removed HTTP surface

The test suite SHALL pass without the HTTP shim controllers. The tier-2 integration harness MUST dispatch only to IPC controllers via the DI container, and the five chromium Playwright specs (`audit.spec.ts`, `games.spec.ts`, `pending-changes-banner.spec.ts`, `polling.spec.ts`, `settings.spec.ts`) SHALL remain in the `chromium` project running self-contained against `vite preview` with browser-side `page.route()` stubs and the `hyveon-http-bridge.ts` init-script shim — their migration to the `electron` project stays in Epic F (F.2–F.6) and is NOT part of this change.

#### Scenario: Integration harness targets IPC controllers only

- **WHEN** the specs under `app/packages/web/e2e/integration-specs/` are searched for `HttpController` imports or dispatches
- **THEN** every `ipc.dispatch(...)` targets an IPC controller class (e.g. `GamesController`, `DiscordController`, `EnvController`) and no spec imports a `*-http.controller` module (doc comments excepted)

#### Scenario: Chromium specs pass after shim deletion

- **WHEN** `npm run app:test:e2e` runs the `chromium` project after the HTTP shim controllers are deleted
- **THEN** all five retained chromium specs pass, because their `/api/*` traffic is intercepted in the browser by `page.route()` and never reaches a real server

#### Scenario: Electron and integration tiers pass after shim deletion

- **WHEN** the `electron` e2e project and `npm run app:test:integration` run after the HTTP shim controllers are deleted
- **THEN** all specs pass unchanged

### Requirement: Every routed screen is reachable from the sidebar

The application sidebar SHALL provide a navigation entry for every route the renderer serves as a
top-level screen. No screen may be reachable only by typing a URL.

#### Scenario: Costs is navigable

- **WHEN** the operator opens the app and inspects the sidebar
- **THEN** a Costs entry is present and activating it navigates to `/costs`

#### Scenario: Sidebar covers the route table

- **WHEN** the top-level routes declared in `app/packages/web/src/app.component.tsx` are compared
  with the sidebar entries
- **THEN** every top-level route has a corresponding entry, ignoring detail routes reached from a
  parent screen

### Requirement: The chrome exposes no non-functional controls

The application chrome SHALL NOT render controls that cannot be actioned. Disabled navigation
placeholders for unimplemented screens and search affordances that are not wired to a handler MUST
be removed rather than shown in a dead state.

#### Scenario: Disabled nav placeholders removed

- **WHEN** the sidebar is rendered
- **THEN** no entry is present for a screen that does not exist, and no entry renders as a
  permanently disabled item

#### Scenario: Dead search box removed

- **WHEN** the top bar is rendered
- **THEN** no search input is present unless it accepts focus and performs a search

#### Scenario: Placeholder statistics removed

- **WHEN** a game card is rendered
- **THEN** it displays no statistic whose value is hardcoded and cannot reflect real data

### Requirement: Streamed IPC channels work across the context bridge

Every streaming IPC channel the renderer consumes SHALL deliver its chunks to the renderer through
the preload bridge. The preload MUST NOT return a value across `contextBridge` that cannot survive
the bridge boundary, and MUST NOT require the renderer to pass an object across the bridge whose
prototype methods the bridge drops.

#### Scenario: Streaming call does not fail at the bridge

- **WHEN** the renderer invokes a streaming channel on the exposed bridge in a production build
  with no test mode and no registered mock
- **THEN** the call returns an async-iterable value rather than throwing a serialization error,
  and iterating it yields the chunks the main process emits

#### Scenario: Live log tail renders streamed lines

- **WHEN** the operator selects a game on the logs screen and the main process emits log chunks
- **THEN** the streamed lines appear in the viewer after the initial snapshot, with no stream
  error banner

#### Scenario: Wizard terraform init completes

- **WHEN** the operator reaches the final wizard step and starts `terraform init`
- **THEN** the command actually executes, its output streams into the viewer, and the step can
  reach its success state

#### Scenario: Terraform run output renders live

- **WHEN** a plan, apply, or destroy run is started from the terraform screen
- **THEN** the run's output streams into the log viewer while the run is in progress

#### Scenario: Cancellation stops the stream

- **WHEN** the renderer abandons a stream, by navigating away or by explicitly cancelling
- **THEN** the main process tears the underlying stream down, and no error is raised in the
  renderer

#### Scenario: A test guards the real bridge boundary

- **WHEN** the test suite runs
- **THEN** at least one test drives a streaming channel end to end through the real preload bridge
  with no mock registered, so a regression at the serialization boundary fails the build

### Requirement: Navigating to logs from a game preselects that game

Activating the logs action on a game card SHALL open the logs screen with that game already
selected, without requiring the operator to reselect it.

#### Scenario: Game card logs action preselects

- **WHEN** the operator activates the logs action on the card for a given game
- **THEN** the logs screen opens with that game selected and begins tailing its log stream

#### Scenario: Direct navigation falls back

- **WHEN** the operator opens the logs screen from the sidebar with no game specified
- **THEN** the screen selects the first available game, as before
