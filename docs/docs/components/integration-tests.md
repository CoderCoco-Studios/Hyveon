---
title: Integration tests
sidebar_position: 5
---

# Integration Test Suite (Tier 2)

Playwright-driven tests that dispatch directly into the real `AppModule` Nest.js DI container — built in-process via `@nestjs/testing`'s `Test.createTestingModule()` — with the AWS SDK mocked and `PulumiService` substituted for an in-memory stub at the DI seam. There is no HTTP server, no Vite build/preview, and no `BrowserWindow`: everything runs in a single Node process. The goal is to validate controller-level business logic (permission checks, stack-output resolution, ECS command orchestration, error propagation) against the exact provider wiring the Electron IPC transport uses at runtime, without spinning up real AWS infrastructure or a real Pulumi engine.

## How to Run

```bash
# Build the server, then run the integration Playwright suite
npm run app:test:integration
```

This command (from the repo root):
1. Builds `@hyveon/desktop-main` via `tsc` (produces `dist/`, which the harness deep-imports).
2. Runs `playwright test --config playwright.integration.config.ts` from `@hyveon/web`.

`playwright.integration.config.ts` has no `webServer` and no `projects` entries — each spec builds its own `ipc` harness (a fresh `AppModule` application context) via the `ipc` fixture, so there's nothing to boot ahead of time.

## Architecture

```text
Playwright test process (single Node process, no HTTP server, no BrowserWindow)
  ├── ipc (IpcHarness) ─────────────────────────── Test.createTestingModule({ imports: [AppModule] }).overrideProvider(PulumiService).useValue(pulumiStub).compile()
  │     ├── dispatch(Controller, 'method', ...) ── invokes the controller instance directly
  │     └── get(Provider) ────────────────────────  resolves a provider (e.g. PulumiService) straight from the container
  ├── ipc.mocks.pulumi (PulumiServiceStub) ──────── the DI-substituted PulumiService — script*() setters control stack outputs, preview/apply/destroy chunks+result
  ├── serverMocks (ServerMocks) ────────────────── pushes into the shared MockStore singleton
  │     └── aws-sdk-client-mock (ECSClient prototype patched) ── installEcsMock() reads from MockStore
  ├── runRecordMockStore ────────────────────────── stateful pk=RUN / pk=LOCK item store
  │     └── aws-sdk-client-mock (DynamoDBDocumentClient prototype patched) ── installRunRecordDynamoMock()
  └── remoteFileStoreMockStore ───────────────────── single versioned configuration-object store
        └── aws-sdk-client-mock (S3Client prototype patched) ── installRemoteFileStoreMock()
```

### Key Files

| File | Purpose |
|------|---------|
| `app/packages/desktop-main/src/test-mocks/mock-store.ts` | In-process `MockStore` singleton with per-command FIFO queues. |
| `app/packages/desktop-main/src/test-mocks/ecs-mock.ts` | Installs `aws-sdk-client-mock` interceptors on `ECSClient`, wired to `MockStore`. |
| `app/packages/desktop-main/src/test-mocks/run-record-mock.ts` | Installs `aws-sdk-client-mock` interceptors on `DynamoDBDocumentClient`, backed by the stateful `runRecordMockStore` singleton (`pk = RUN` run records + the single `pk = LOCK` apply-lock item) — see [DynamoDB Run-Record Mock](#dynamodb-run-record-mock) below. |
| `app/packages/desktop-main/src/test-mocks/remote-file-store-mock.ts` | Installs `aws-sdk-client-mock` interceptors on `S3Client`, backed by the stateful `remoteFileStoreMockStore` singleton (a single versioned configuration object, keyed by `CONFIGURATION_OBJECT_KEY`) — see [Configuration-Bucket S3 Mock](#configuration-bucket-s3-mock) below. |
| `app/packages/desktop-main/src/test-mocks/pulumi-mock.ts` | `PulumiServiceStub` — the class substituted for the real `PulumiService` at the DI seam. Exposes `script*` setters (`scriptStackOutputs`, `scriptPreview`/`scriptApply`/`scriptDestroy`, `scriptOperationInFlight`, `scriptDestroyToken`) plus `reset()` — see [PulumiService DI-Seam Stub](#pulumiservice-di-seam-stub) below. |
| `app/packages/web/e2e/fixtures/ipc-harness.ts` | Builds the in-process IPC test harness (`createIpcHarness()`) via `Test.createTestingModule({ imports: [AppModule] }).overrideProvider(PulumiService).useValue(pulumiStub).compile()`, deep-importing `@hyveon/desktop-main`'s compiled `dist/`, and dispatches directly to controller methods. Also exposes `get(Provider)` to resolve a provider (e.g. `PulumiService`) directly from the container, and `mocks.pulumi` to reach the scriptable stub. |
| `app/packages/web/e2e/fixtures/server-mocks.ts` | `ServerMocks` class + extended `test` with `serverMocks` and `ipc` fixtures. |
| `app/packages/web/e2e/fixtures/stack-outputs.fixture.ts` | Exports `DEFAULT_STACK_OUTPUTS: StackOutputs` — a synthetic, fully-deployed stack-outputs value (`minecraft` + `valheim`, `us-east-1`, `test.example.com`) that specs script onto `ipc.mocks.pulumi` via `scriptStackOutputs()`. Replaces the deleted `tfstate.fixture.json`; re-exported from `integration-specs/index.ts`. |
| `app/packages/web/playwright.integration.config.ts` | Playwright config: `testDir: e2e/integration-specs`, `workers: 1`, no `webServer`, no `projects`. |
| `app/packages/web/e2e/integration-specs/` | All integration specs; import `test`/`expect`/`DEFAULT_STACK_OUTPUTS` from `./index.js`, not `@playwright/test`. |

## How Mock Responses Work

The in-process `MockStore` singleton holds separate FIFO queues for `ListTasks`, `DescribeTasks`, `RunTask`, and `StopTask`. When a queue is empty, the corresponding interceptor returns a safe default:

| Command | Default (empty queue) |
|---------|-----------------------|
| `ListTasksCommand` | `{ taskArns: [] }` → game is stopped |
| `DescribeTasksCommand` | `{ tasks: [] }` |
| `RunTaskCommand` | `{ tasks: [{ taskArn: 'arn:…/test-task-id' }], failures: [] }` |
| `StopTaskCommand` | `{}` |

Push a response before dispatching the controller call that will consume it:

```ts
await serverMocks.pushListTasks({
  type: 'success',
  data: { taskArns: ['arn:aws:ecs:us-east-1:123:task/test-cluster/abc'] },
});
await serverMocks.pushDescribeTasks({
  type: 'success',
  data: { tasks: [{ taskArn: '…', lastStatus: 'RUNNING' }] },
});

const status = await ipc.dispatch(GamesController, 'getStatus', 'minecraft');
```

Push an error to test propagation:

```ts
await serverMocks.pushRunTask({
  type: 'error',
  code: 'AccessDeniedException',
  message: 'User is not authorized to perform ecs:RunTask',
});
```

## Spec Inventory

| Spec | What it tests |
|------|---------------|
| `config-service.spec.ts` | `EnvController.getEnv` returns region + domain, and `GamesController.listGames`/`listStatus` return the game list, once `ipc.mocks.pulumi` is scripted with `DEFAULT_STACK_OUTPUTS`. |
| `discord-config.spec.ts` | `DiscordController.getConfig` never echoes the raw bot token or public key — only the redacted `botTokenSet`/`publicKeySet` booleans. |
| `start-stop.spec.ts` | `GamesController.listGames`/`listStatus` report STOPPED games on initial load; a game seeded as RUNNING via mocked ECS responses can be stopped. |
| `status-polling.spec.ts` | Pushing RUNNING mock responses causes the next `GamesController.listStatus` dispatch to reflect the state change (the in-process analogue of the dashboard's poller). |
| `error-propagation.spec.ts` | `AccessDeniedException` from `RunTaskCommand` surfaces as `{ success: false, message: '…' }` from `GamesController.start`. |
| `can-run.spec.ts` | Placeholder — skipped until Discord permission enforcement (`canRun()`) is wired into the `ipc` test harness. |
| `stack-outputs.spec.ts` | `IacController.output` (the `iac.output` channel) returns the scripted `PulumiService.getStackOutputs()` value verbatim, and degrades to `null` — not a throw — for a never-deployed stack. |
| `pulumi-di-seam.spec.ts` | Proves the DI substitution itself: a scripted, non-UUID-shaped `mintDestroyConfirmationToken()` value round-trips through `IacController.mintDestroyToken`, and `ipc.get(PulumiService)` is reference-equal to `ipc.mocks.pulumi`. |
| `guided-iam.spec.ts` | Dispatches the five `wizard.guidedIam.*` channels through the real, DI-resolved `WizardController` → `GuidedIamService`, covering template rendering, console-URL fallback, bootstrap-key intake, the full mint→verify→revoke rotation, and the `delete-failed` manual-revoke retry. |

## PulumiService DI-Seam Stub

The previous provisioning service (which shelled out to a real CLI binary, faked via a PATH-shimmed stub script) is gone — the `migrate-iac-to-pulumi` change replaced it with `PulumiService`, which drives the `@pulumi/pulumi/automation` API in-process. There is no PATH to shim any more, so the integration tier fakes it the way Nest testing intends: `createIpcHarness()` (`ipc-harness.ts`) builds the container with `Test.createTestingModule({ imports: [AppModule] }).overrideProvider(PulumiService).useValue(pulumiStub)`, substituting a fresh `PulumiServiceStub` (`app/packages/desktop-main/src/test-mocks/pulumi-mock.ts`) for every consumer that injects `PulumiService` — `ConfigService`, `IacController`, `IacRunsController`, `DriftService`, and so on. This is also *why* the harness switched off `NestFactory.createApplicationContext()`: that API has no provider-override hook, and a `TestingModule` already extends `NestApplicationContext` (`.get()`, `.close()`, ...), so no separate "create an application" step is needed once it's compiled.

Reach the stub via `ipc.mocks.pulumi` (aliased as `harness.mocks.pulumi` in the type):

```ts
import { test, expect, DEFAULT_STACK_OUTPUTS } from './index.js';
import { IacController } from '@hyveon/desktop-main/dist/controllers/iac.controller.js';

test('should ...', async ({ ipc }) => {
  ipc.mocks.pulumi.scriptStackOutputs(DEFAULT_STACK_OUTPUTS);
  ipc.mocks.pulumi.scriptApply({ chunks: [{ stream: 'stdout', text: '...' }], result: { /* PulumiUpResult */ } });

  const outputs = await ipc.dispatch(IacController, 'output', {});
});
```

Scripting surface (see the class's own TSDoc for the full contract):

| Setter | Scripts |
|--------|---------|
| `scriptStackOutputs(outputs \| null)` | `getStackOutputs()`'s next resolution — `null` models a never-deployed stack (the default). |
| `scriptOperationInFlight(op \| null)` | `getOperationInFlight()`'s next return value — `null` (default) means the workspace is free. |
| `scriptDestroyToken(token)` | The token `mintDestroyConfirmationToken()` returns next. |
| `scriptPreview(run)` / `scriptApply(run)` / `scriptDestroy(run)` | The `{ chunks?, result? }` or `{ chunks?, failure? }` an operation's async generator plays back — yields `chunks` in order, then either returns `result` or throws `failure`, mirroring how a real `PulumiService` operation settles. Takes effect for every subsequent call until re-scripted (not a one-shot FIFO queue). |
| `reset()` | Restores every scripted response to its never-deployed/workspace-free/empty-run default. |

**Un-scripted surface.** `initializeStack`/`resolveRollbackTarget`/`computeRollbackDiff`/`confirmRollback`/`clearStaleLock`/`computePlanHash`/`readRunRecord`/`hasPlanArtifact`/`streamRunOutput` have no `script*` setter yet — nothing in the current spec set (tasks 11.1/11.2) drives them, so they resolve fixed, harmless placeholder values. Adding `script*` setters for these, to back Plan/Apply/Destroy gating, ANSI-preservation, and run-record-persistence integration coverage, is tracked as follow-up work under task 7.11 in `openspec/changes/migrate-iac-to-pulumi/tasks.md`.

`createIpcHarness()` builds a fresh `PulumiServiceStub` per harness (per Playwright test) — unlike `mockStore`/`runRecordMockStore`/`remoteFileStoreMockStore`, which are process-wide singletons reset between harnesses because `aws-sdk-client-mock` patches a shared client prototype, a fresh stub instance needs no cross-test reset.

`DEFAULT_STACK_OUTPUTS` (`app/packages/web/e2e/fixtures/stack-outputs.fixture.ts`) is the fixture most specs script — a synthetic, fully-deployed `StackOutputs` value with the same region/domain/game names/table names the deleted legacy stack-outputs fixture used, so every spec that asserted against the old fixture keeps asserting the same values, just read through `PulumiService.getStackOutputs()`'s stubbed return instead of a parsed local state file.

## DynamoDB Run-Record Mock

`app/packages/desktop-main/src/test-mocks/run-record-mock.ts` installs `aws-sdk-client-mock` interceptors on the `DynamoDBDocumentClient` prototype (`installRunRecordDynamoMock()`, wired into `createIpcHarness()` alongside `installEcsMock()`), backed by the exported `runRecordMockStore` singleton. Unlike `MockStore`'s FIFO queues, this is a genuinely **stateful** table: a run persisted through the real `RunRecordService` is retrievable by a later call in the same spec, exactly like production. No spec in the current set (tasks 11.1/11.2) drives a real plan/apply run far enough to write one — that requires the real `PulumiService`, which every current harness replaces with the stub above — so this mock is installed and reset but currently inert; it exists for the `IacController.approve` path (which calls `RunRecordService` directly, independent of `PulumiService`) and for the task-7.11 follow-up specs that will drive real persistence.

- **`pk = RUN` items** — `PutCommand`/`QueryCommand` mirror `AwsRunRecordStore`'s `putRecord`/`getRecordByRunId`/`listRuns` request shapes (upsert-by-`sk`, filter by `runId`/`before`/`status`, `Limit`).
- **`pk = LOCK` / `sk = CURRENT` item** — the single apply-lock item `RunService.createRun`/`releaseRun` acquire/release via `acquireRunLock`/`releaseRunLock`. `PutCommand`'s conditional-put semantics (`attribute_not_exists(pk) OR expiresAt < :now`) are reproduced, throwing `ConditionalCheckFailedException` when another unexpired lock is held — the same exception `AwsRunRecordStore.acquireRunLock` catches and converts to `RunLockHeldError`.
- **`runRecordMockStore.patchApprovedAt(runId, isoString)`** — directly overwrites a stored record's `approvedAt`, letting a spec simulate an approval minted outside the 15-minute apply window without fake timers (which don't reach a spawned child process, and `PulumiService`'s Automation API calls do spawn one).
- **Reset per harness** — `createIpcHarness()` calls `runRecordMockStore.reset()` before installing the mock, so no plan/apply/destroy record or apply lock leaks from one spec's `AppModule` context into the next.

Since the mock patches `DynamoDBDocumentClient`'s prototype globally, it also intercepts `AuditService`'s DynamoDB traffic (harmless — audit items land in the same in-memory item list but are excluded from every `runId`-filtered query).

## Configuration-Bucket S3 Mock

`app/packages/desktop-main/src/test-mocks/remote-file-store-mock.ts` installs `aws-sdk-client-mock` interceptors on the `S3Client` prototype (`installRemoteFileStoreMock()`, wired into `createIpcHarness()` alongside `installEcsMock()`/`installRunRecordDynamoMock()`), backed by the exported `remoteFileStoreMockStore` singleton — the configuration-bucket counterpart of the ECS/run-record mocks above. There is no local-file configuration fallback (see the `migrate-iac-to-pulumi` change's Phase 6), so `DeploymentConfigService`'s read/write paths require a genuinely working `RemoteFileStore` to succeed against real AWS.

- **A single versioned object**, keyed by `CONFIGURATION_OBJECT_KEY` (`@hyveon/shared`, `'deployment-config.json'`) — `GetObjectCommand`/`PutObjectCommand`/`ListObjectVersionsCommand` are reproduced against an in-memory, newest-version-first history, mirroring `AwsRemoteFileStore`'s real command usage.
- **Seeded with a placeholder `DeploymentConfig`** on install/reset, so any spec that ends up on this path still gets a valid `get()` without individually stubbing anything.
- **`remoteFileStoreMockStore.seed(config)`** — replaces the object's entire history with a fresh single version containing `config`, for specs (e.g. future `DeploymentConfigService`/rollback specs) that need specific configuration content.
- **Reset per harness** — `createIpcHarness()` calls `remoteFileStoreMockStore.reset()` before installing the mock, so no configuration content or version history leaks from one spec's `AppModule` context into the next.
- **Currently inert for every spec in the set (tasks 11.1/11.2)** — `GamesController.listGames`/`listStatus` (dispatched by `config-service.spec.ts`/`start-stop.spec.ts`) do call into `DeploymentConfigService`, but none of the specs in this set set `HYVEON_CONFIG_BUCKET`, so `DeploymentConfigService.getGameServers()` catches its own `ConfigurationNotConfiguredError` and returns an empty list before ever reaching `RemoteFileStore`/`S3Client.send()`. Installing the mock unconditionally in `createIpcHarness()` is forward-looking — it exists for `DeploymentConfigService`-content/rollback specs that haven't landed yet.

## Guided-IAM STS/IAM Mock

`guided-iam.spec.ts` is a different shape from the other specs in this
inventory: it patches `STSClient`/`IAMClient` with `aws-sdk-client-mock`'s
`mockClient()` **inline, in the spec file itself**, rather than through a
shared singleton under `app/packages/desktop-main/src/test-mocks/` the way
the ECS/DynamoDB/S3 mocks above are wired into `createIpcHarness()`. It's a
fourth AWS-mock family, reset in a spec-local `beforeEach` rather than by the
harness.

It also has to work around `SafeStorageService.isAvailable()` being `false`
in this plain-Node Playwright process (there is no real Electron runtime to
back it, same as a unit test) — without that, `GuidedIamService.rotate()`
throws `SafeStorageUnavailableError` before ever reaching AWS. The spec's
`forceKeychainAvailable()` helper overrides the DI-resolved
`SafeStorageService` singleton's `isAvailable`/`encrypt`/`decrypt` to a
pass-through, mirroring the same "keychain available, but plaintext storage"
state `GuidedIamService.test.ts`'s unit tests target, scoped to the fresh
`AppModule` context `ipc` compiles per test.

## Design Constraints

- **`workers: 1`, `fullyParallel: false`** — the `MockStore` is an in-process singleton; concurrent tests would corrupt each other's queues.
- **`serverMocks` resets before and after every test** — the fixture calls `mockStore.reset()` in-process in setup and teardown; there is no HTTP round-trip.
- **No HTTP server, no Vite build/preview, no `BrowserWindow`** — every integration spec dispatches directly to the `AppModule` DI container via the `ipc` fixture (`ipc-harness.ts`) and pushes mock ECS responses straight into the in-process `MockStore` singleton via the `serverMocks` fixture (`server-mocks.ts`), so there is no test-only route surface and nothing for Playwright to boot as a `webServer`.
- **No real Pulumi engine, ever** — `createIpcHarness()` substitutes `PulumiServiceStub` for `PulumiService` at the DI seam (see [PulumiService DI-Seam Stub](#pulumiservice-di-seam-stub) above), so no integration spec can spawn the Pulumi CLI, download the engine binary, or reach real AWS through it — structurally, not just by convention.

## Related: the tier-1 Electron e2e IPC mock seam

The seam below belongs to the **tier-1** Playwright suite (`npm run app:test:e2e`),
not the tier-2 suite documented above. It is described here because it is the
other half of the "how do specs fake the backend" story, and the two are easy to
confuse.

The `electron` Playwright project launches the packaged app via
`_electron.launch()` with `HYVEON_TEST_MODE=1` in the process environment (set in
`app/packages/web/playwright.config.ts`). That env var gates two things:

1. **Main process** (`desktop-main/src/electron-entry.ts`) logs
   `[desktop-main] HYVEON_TEST_MODE active — test seam enabled` at startup. The
   window still opens normally — the flag is informational, not a behaviour
   switch, so `_electron.launch()` can drive the real UI.
2. **Preload script** (`desktop-preload/src/preload.ts`) checks
   `process.env.HYVEON_TEST_MODE === '1'` before attaching the `__test` namespace
   to the `hyveon` bridge. When the flag is set, the bridge gains:

   ```ts
   window.hyveon.__test.mock(channel, handler)
   ```

   `channel` is an IPC channel string (e.g. `'games.list'`). `handler` is a
   replacement function or a plain value. Thereafter every `invoke(channel, ...args)`
   call in the preload consults a `Map<string, fn>` before forwarding to
   `ipcRenderer.invoke`, so the Electron main process is never reached for mocked
   channels.

### Production-gating guarantee

When `HYVEON_TEST_MODE` is absent (the default for packaged/production builds),
the `if (isTestMode)` branch in the preload is never entered and
`window.hyveon.__test` is `undefined`. The `contextBridge.exposeInMainWorld` call
only ever exposes the production API namespaces. There is no path by which end
users can reach the mock registry.

### Two mock surfaces — choose the right one

| Surface | File | When to use |
|---------|------|-------------|
| `window.hyveon.__test.mock(channel, handler)` | `desktop-preload/src/preload.ts` | Playwright Electron e2e specs (`electron` project) that need to control IPC responses without running the Nest server. Called via `win.evaluate(...)` inside each test body (or a `beforeEach` when all tests in a describe share the same mock). When tests share a single `ElectronApplication`, call `win.evaluate(() => window.hyveon.__test.clearMocks())` (alias: `reset()`) in `afterEach` so stale mock handlers don't bleed into later tests. |
| `register(namespace, mock)` from `@hyveon/desktop-preload/test-mock-registry` | `desktop-preload/src/test-mock-registry.ts` | Vitest unit tests running under jsdom. Build a partial namespace stub with `vi.fn()`, call `register('games', stub)`, then `vi.stubGlobal('hyveon', buildMockHyveon())` so the component under test gets a fully-typed `window.hyveon`. Call `clear()` in `afterEach`. |

The `test-mock-registry` module is **not** imported by the preload script or any
production code; it exists only for jsdom-environment test helpers.

### Alternative pattern: fresh `ElectronApplication` per test

The shared-app + `clearMocks()` pattern above assumes there's a remount lever
— routed-page specs like `discord.spec.ts` get per-test isolation from
`DiscordPage.goto()`'s `pushState`/`popstate` dance forcing a fresh mount, not
from clearing mocks alone. A component that mounts once and never remounts
has no such lever: `guided-iam-wizard.spec.ts` covers the first-run wizard
shell, which mounts once outside the router on app boot, so `clearMocks()`
between tests would leave a prior test's settled state in place with nothing
to re-drive it.

That spec instead launches a brand-new `ElectronApplication` in `beforeEach`
and closes it in `afterEach` (the same per-test-launch pattern `logs.spec.ts`
uses), seeding each fresh app's mocks immediately after `firstWindow()`
resolves and before the renderer's mount effect can fire. Reach for this
pattern for any spec targeting a component that mounts once with no
navigation-driven remount — it's slower than sharing one app, but it's the
only way to guarantee each test starts from a truly fresh mount.

**Known limitation.** A mock handler registered through `contextBridge` cannot be
backed by a real async generator — Electron's structured clone across the bridge
drops the generator protocol. Assertions on streamed chunk content belong in
jsdom/Vitest specs instead.

## Related: unit-tier React component and routed-page specs

Also tier-adjacent rather than tier-2: the conventions for the Vitest specs that
run under jsdom in `@hyveon/web`. They live here so there is one page describing
how each tier fakes its dependencies.

Stack: **Vitest + jsdom + `@testing-library/react` + `@testing-library/user-event`**.
The `@testing-library/jest-dom` matchers (`toBeInTheDocument`, `toHaveTextContent`)
are registered globally by `app/vitest.setup.ts`, which also wires
`afterEach(cleanup)` — that is not automatic here because the suite runs with
`globals: false`, which disables React Testing Library's own cleanup hook.

The node/jsdom split lives in `app/vitest.config.ts` as **two projects**, `node`
and `web` (Vitest 4 removed `environmentMatchGlobs`). Both inherit the root
config via `extends: true` — resolve aliases, the `maxWorkers` cap, `setupFiles`,
mock resets — and differ only in which files they collect and the environment
those files run under: `web` collects `packages/web/**/*.test.{ts,tsx}` under
jsdom, `node` collects everything else under `node`.

### Component specs

- Live **next to the component** (`foo.component.tsx` → `foo.component.test.tsx`),
  not in a separate `__tests__` directory.
- Mock the API client and any module-level singleton with `vi.mock`.
- For a component driven by a streaming channel (`logs.stream`,
  `iac.stack.initialize`, `iac.runs.streamLogs`), back the mock with
  `toStreamHandleMock()` from `src/test-utils/stream-handle.test-utils.ts`. It
  wraps an ordinary async generator body in the `HyveonStreamHandle` shape the
  real preload bridge returns — including the `cancel()` method components call
  on unmount, which a bare `AsyncGenerator` does not have.
- Cover: visible rendering for each `state` branch, every callback prop firing
  with the right argument, internal state transitions (open/close, pause/resume),
  and any non-trivial pure helper.
- Avoid snapshots — they break on every Tailwind tweak — and don't duplicate
  assertions the e2e tier already makes about routing and real streaming.

### Routed-page specs

Each routed page (`DashboardPage`, `CostsPage`, `DiscordPage`, `LogsPage`,
`SettingsPage`, …) has a co-located `*.test.tsx` that mounts it through
`renderPage()` from `app/packages/web/src/test-utils/render-page.utils.tsx`. That
helper wraps children in the production provider stack —
`PollingProvider → GameStatusProvider → MemoryRouter` — so the page is exercised
under the same context it gets at runtime. Pass `initialEntries` when the page
reads `useLocation` (a `{ pathname, state }` entry when it also reads
`location.state`, as the rollback flow does).

Mock `../api.js` with `vi.mock` + `vi.hoisted` so the page runs off canned data,
and **stub every method the provider stack calls, not just the ones the page
calls** — at minimum `api.status` *and* `api.costsEstimate`. `GameStatusProvider`
invokes `api.costsEstimate()` unconditionally on mount
(`src/polling/game-status-provider.component.tsx:72`), above every page mounted
this way, so leaving it unstubbed hangs the test on a promise that never settles
rather than failing with a useful message.

Keep the scope tight: smoke-render each header section, exercise controls not
already covered by a child component's own spec, and verify the polling-indicator
wiring. Anything needing the real DI container belongs in the tier-2 specs above.
