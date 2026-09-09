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

`app/packages/web/e2e/integration-specs/` currently holds:

| Spec | What it tests |
|------|---------------|
| `can-run.spec.ts` | `canRun()` (`@hyveon/shared`) enforces guild allowlisting, admin bypass, and per-game action grants, against config seeded through `DiscordController`'s real IPC channels. |
| `config-service.spec.ts` | `EnvController.getEnv` returns region + domain, and `GamesController.listGames`/`listStatus` return the game list, once `ipc.mocks.pulumi` is scripted with `DEFAULT_STACK_OUTPUTS`. |
| `diagnostics-export.spec.ts` | Sets `HYVEON_CONFIG_BUCKET` itself (see [Configuration-Bucket S3 Mock](#configuration-bucket-s3-mock)) and exercises the diagnostics-export path against the S3-backed configuration store. |
| `discord-config.spec.ts` | `DiscordController.getConfig` never echoes the raw bot token or public key — only the redacted `botTokenSet`/`publicKeySet` booleans. |
| `error-propagation.spec.ts` | `AccessDeniedException` from `RunTaskCommand` surfaces as `{ success: false, message: '…' }` from `GamesController.start`. |
| `guided-iam.spec.ts` | Dispatches the five `wizard.guidedIam.*` channels through the real, DI-resolved `WizardController` → `GuidedIamService`, covering template rendering, console-URL fallback, bootstrap-key intake, the full mint→verify→revoke rotation, and the `delete-failed` manual-revoke retry. |
| `iac-apply-gates.spec.ts` | 9 scenarios covering `PulumiService.apply`'s gate stack (unapproved/expired/mismatched-hash/engine-version-mismatch/fresh-approved/missing-record/stale-artifact/config-moved/competing-applies), scripted via `PulumiServiceStub.scriptApply({ failure: <real gate-error class> })` and asserted against `IacController.apply`'s ack-shaping. |
| `iac-destroy-token.spec.ts` | 6 scenarios covering `IacController.destroy`'s confirmation-token gate (no-token/consumed/fresh/wrong-target/expired-or-superseded/concurrent). |
| `iac-plan.spec.ts` | 3 scenarios: plan artifact/planHash persistence, the structured change summary, and the failed-preview-no-hash path. |
| `iac-run-records.spec.ts` | 4 scenarios exercising `RunRecordService` directly via `ipc.get(RunRecordService)` — planHash-on-success, failed-still-persisted, inline-log, and retrievable-via-runs-list. This is the spec that actually drives the DynamoDB run-record mock (see [DynamoDB Run-Record Mock](#dynamodb-run-record-mock)). |
| `iac-streaming-ansi.spec.ts` | ANSI escape sequences are preserved in both the live stream and a directly-persisted run log. |
| `pulumi-di-seam.spec.ts` | Proves the DI substitution itself: a scripted, non-UUID-shaped `mintDestroyConfirmationToken()` value round-trips through `IacController.mintDestroyToken`, and `ipc.get(PulumiService)` is reference-equal to `ipc.mocks.pulumi`. |
| `stack-outputs.spec.ts` | `IacController.output` (the `iac.output` channel) returns the scripted `PulumiService.getStackOutputs()` value verbatim, and degrades to `null` — not a throw — for a never-deployed stack. |
| `start-stop.spec.ts` | `GamesController.listGames`/`listStatus` report STOPPED games on initial load; a game seeded as RUNNING via mocked ECS responses can be stopped. |
| `status-polling.spec.ts` | Pushing RUNNING mock responses causes the next `GamesController.listStatus` dispatch to reflect the state change (the in-process analogue of the dashboard's poller). |
| `support/iac-ctx.ts` | Not a spec — `makeFakeIacCtx()`, a Playwright-appropriate reimplementation of `iac.controller.test.ts`'s vitest-only `makeCtx()` (plain call-tracking arrays instead of `vi.fn()`, since these specs are typechecked and the vitest test file is not). Shared by the `iac-*` specs above. |

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

**Un-scripted surface.** `initializeStack`/`resolveRollbackTarget`/`computeRollbackDiff`/`confirmRollback`/`clearStaleLock` have no `script*` setter — rollback stayed explicitly out of scope for the Plan/Apply/Destroy/run-record coverage below (per the `orchestrator-integration-coverage` delta spec's own scenario list), so they resolve fixed, harmless placeholder values. Plan/Apply/Destroy gating, ANSI-preservation, and run-record-persistence coverage — once tracked as follow-up under task 7.11 — is now built: see `iac-plan.spec.ts`, `iac-apply-gates.spec.ts`, `iac-destroy-token.spec.ts`, `iac-streaming-ansi.spec.ts`, and `iac-run-records.spec.ts` above. Task 7.11 is closed (`openspec/changes/archive/2026-08-10-migrate-iac-to-pulumi/tasks.md`); those gate errors (`PulumiPlanNotApprovedError`, `RunLockHeldError`, `DestroyNotConfirmedError`, etc.) are scripted straight onto `PulumiServiceStub` via `{ failure: <real gate-error class instance> }` rather than needing dedicated setters, since the gate math itself is already unit-tested in `PulumiService.apply.test.ts`/`.destroy.test.ts` and is not re-derived at this tier.

`createIpcHarness()` builds a fresh `PulumiServiceStub` per harness (per Playwright test) — unlike `mockStore`/`runRecordMockStore`/`remoteFileStoreMockStore`, which are process-wide singletons reset between harnesses because `aws-sdk-client-mock` patches a shared client prototype, a fresh stub instance needs no cross-test reset.

`DEFAULT_STACK_OUTPUTS` (`app/packages/web/e2e/fixtures/stack-outputs.fixture.ts`) is the fixture most specs script — a synthetic, fully-deployed `StackOutputs` value with the same region/domain/game names/table names the deleted legacy stack-outputs fixture used, so every spec that asserted against the old fixture keeps asserting the same values, just read through `PulumiService.getStackOutputs()`'s stubbed return instead of a parsed local state file.

## DynamoDB Run-Record Mock

`app/packages/desktop-main/src/test-mocks/run-record-mock.ts` installs `aws-sdk-client-mock` interceptors on the `DynamoDBDocumentClient` prototype (`installRunRecordDynamoMock()`, wired into `createIpcHarness()` alongside `installEcsMock()`), backed by the exported `runRecordMockStore` singleton. Unlike `MockStore`'s FIFO queues, this is a genuinely **stateful** table: a run persisted through the real `RunRecordService` is retrievable by a later call in the same spec, exactly like production. `iac-run-records.spec.ts` drives this directly — it calls `ipc.get(RunRecordService).persist(...)` and `.getByRunId(...)` against the real, DI-resolved `RunRecordService` (bypassing `PulumiService` entirely, the same pattern `pulumi-di-seam.spec.ts` uses for `PulumiService` itself), so the mock is exercised, not inert.

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
- **Driven by `diagnostics-export.spec.ts`** — that spec sets `process.env['HYVEON_CONFIG_BUCKET']` itself before dispatching (restoring the previous value in its `finally`/teardown), so its calls reach `DeploymentConfigService` → `RemoteFileStore` → this mock for real. Most other specs in the set (e.g. `GamesController.listGames`/`listStatus`, dispatched by `config-service.spec.ts`/`start-stop.spec.ts`) do call into `DeploymentConfigService`, but don't set `HYVEON_CONFIG_BUCKET`, so `DeploymentConfigService.getGameServers()` catches its own `ConfigurationNotConfiguredError` and returns an empty list before ever reaching `RemoteFileStore`/`S3Client.send()` — for those specs this mock is installed and reset but not exercised.

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

## Three Playwright configs

`@hyveon/web` has three separate Playwright configs — each scoped to a different
`testDir` so the three suites never cross-pick-up each other's specs:

| Config | `testDir` | Purpose |
|--------|-----------|---------|
| `playwright.integration.config.ts` | `e2e/integration-specs` | The tier-2 suite documented above. No `webServer`, no `projects` — see [How to Run](#how-to-run). |
| `playwright.config.ts` | `e2e/specs` | The tier-1 suite (`npm run app:test:e2e`). Two projects run side by side: `electron` (`ELECTRON_SPECS`, ~line 50 — `electron-smoke.spec.ts`, `electron-clean-quit.spec.ts`, `electron-ipc-roundtrip.spec.ts`, `ipc-mock.spec.ts`, `streaming-handle-roundtrip.spec.ts`, `dashboard.spec.ts`, `costs.spec.ts`, `logs.spec.ts`, `discord.spec.ts`, `iac.spec.ts`, `guided-iam-wizard.spec.ts`) launches the packaged main bundle via `_electron.launch()`; every other spec runs under `chromium` against the Vite dev/preview server. `npm run app:test:e2e` (root `package.json`) builds `@hyveon/shared`, `@hyveon/cloud-aws`, `@hyveon/infra`, and `@hyveon/desktop-preload` first, then the workspace's own `test:e2e` script additionally runs `desktop:build` (electron-vite) before invoking `playwright test` — so the `electron` project always launches an up-to-date `out/main`/`out/preload`/`out/renderer`. |
| `playwright.screenshots.config.ts` | `e2e/screenshots` | Standalone docs-screenshot harness (`docs:screenshots` in the root `package.json`) — deliberately separate from `playwright.config.ts` so neither suite picks up the other's specs. No `projects`/`webServer`; the one spec (`e2e/screenshots/capture.spec.ts`) manages its own `_electron.launch()` calls, same pattern as the `electron` project above. `workers: 1`/`fullyParallel: false` because output file paths are fixed (`docs/static/img/app/*.png`) and concurrent writers would race. |

## Related: the tier-1 Electron e2e IPC mock seam

The seam below belongs to the **tier-1** Playwright suite (`npm run app:test:e2e`),
not the tier-2 suite documented above. It is described here because it is the
other half of the "how do specs fake the backend" story, and the two are easy to
confuse.

The `electron` Playwright project launches the packaged app via
`_electron.launch()` with `HYVEON_TEST_MODE=1` in the process environment (set in
`app/packages/web/playwright.config.ts`). That env var gates two things:

1. **Main process** (`desktop-main/src/electron-entry.ts`) logs
   `[desktop-main] HYVEON_TEST_MODE active — test seam enabled` at startup, and
   it is a real behaviour switch, not merely informational: `!isTestMode()` gates
   the Pulumi spike (`if (isPulumiSpikeEnabled() && !isTestMode())`, ~line 239) —
   without it, a `HYVEON_PULUMI_SPIKE=1` leaking in from the inherited shell
   environment (which `_electron.launch()` spreads into every launch) would make
   each spec download a 344 MB Pulumi engine and run a real `up`. The e2e config's
   `electronEnv` also strips `HYVEON_PULUMI_SPIKE*` from the inherited environment
   as the other half of that belt. Aside from this gate the window still opens
   normally, so `_electron.launch()` can drive the real UI.
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
`DiscordPage.goto()`'s two-step `window.location.hash` assignment (set to `'/'`
to unmount any previously mounted Discord page, then to `'/discord'` to force a
fresh mount) forcing a `hashchange` — a same-value `location.hash` set fires no
`hashchange`, so `HashRouter` would not re-render on a single assignment — not
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

### Hook specs

- A stateful hook shared by more than one page or component (`src/hooks/*.hook.ts`)
  gets its own co-located `*.hook.test.ts`, testing the hook in isolation via
  `@testing-library/react`'s `renderHook`, rather than being exercised only
  indirectly through each consumer's page/component spec. `useLogTail` (shared by
  `LogsPage` and `InfrastructureLogsPage`) is tested this way at
  `use-log-tail.hook.test.ts`; each page's own `*.test.tsx` then only needs to
  cover how that page wires the hook's result into its markup, not the
  tail/pause/level-filter/autoscroll state machine itself.

### Component specs

- Live **next to the component** (`foo.component.tsx` → `foo.component.test.tsx`),
  not in a separate `__tests__` directory.
- Mock the API client and any module-level singleton with `vi.mock`.
- For a component driven by a streaming channel (`logs.stream`,
  `iac.stack.initialize`, `iac.runs.logs` — bridged over `iac.runs.logs.chunk`/
  `iac.runs.logs.end`), back the mock with
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
`InfrastructureLogsPage`, `SettingsPage`, …) has a co-located `*.test.tsx` that mounts it through
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
(`src/polling/game-status-provider.component.tsx`, in a bare `useEffect`), above
every page mounted this way. That call's rejection is swallowed
(`.catch(() => undefined)`), so leaving `api.costsEstimate` unstubbed does not
hang the test — it silently leaves `estimates` at its initial `null` instead,
which can mask a real assertion failure with a confusing symptom rather than a
useful message, so stub it anyway.

Keep the scope tight: smoke-render each header section, exercise controls not
already covered by a child component's own spec, and verify the polling-indicator
wiring. Anything needing the real DI container belongs in the tier-2 specs above.
