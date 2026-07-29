---
title: Integration tests
sidebar_position: 5
---

# Integration Test Suite (Tier 2)

Playwright-driven tests that dispatch directly into the real `AppModule` Nest.js DI container — built in-process via `NestFactory.createApplicationContext()` — with the AWS SDK mocked. There is no HTTP server, no Vite build/preview, and no `BrowserWindow`: everything runs in a single Node process. The goal is to validate controller-level business logic (permission checks, tfstate parsing, ECS command orchestration, error propagation) against the exact provider wiring the Electron IPC transport uses at runtime, without spinning up real AWS infrastructure.

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
  ├── ipc (IpcHarness) ─────────────────────────── NestFactory.createApplicationContext(AppModule)
  │     ├── dispatch(Controller, 'method', ...) ── invokes the controller instance directly
  │     └── get(Provider) ────────────────────────  resolves a provider (e.g. TerraformService) straight from the container
  ├── serverMocks (ServerMocks) ────────────────── pushes into the shared MockStore singleton
  │     └── aws-sdk-client-mock (ECSClient prototype patched) ── installEcsMock() reads from MockStore
  ├── runRecordMockStore ────────────────────────── stateful pk=RUN / pk=LOCK item store
  │     └── aws-sdk-client-mock (DynamoDBDocumentClient prototype patched) ── installRunRecordDynamoMock()
  └── terraformFixture ──────────────────────────── PATH-shim dir + TF_DIR/RUNS_DIR_PATH/TFVARS_PATH temp dirs
        └── fake-terraform.mjs ──────────────────── resolved as the `terraform` binary via the shim wrapper
```

### Key Files

| File | Purpose |
|------|---------|
| `app/packages/desktop-main/src/test-mocks/mock-store.ts` | In-process `MockStore` singleton with per-command FIFO queues. |
| `app/packages/desktop-main/src/test-mocks/ecs-mock.ts` | Installs `aws-sdk-client-mock` interceptors on `ECSClient`, wired to `MockStore`. |
| `app/packages/desktop-main/src/test-mocks/run-record-mock.ts` | Installs `aws-sdk-client-mock` interceptors on `DynamoDBDocumentClient`, backed by the stateful `runRecordMockStore` singleton (`pk = RUN` run records + the single `pk = LOCK` apply-lock item) — see [DynamoDB Run-Record Mock](#dynamodb-run-record-mock) below. |
| `app/packages/web/e2e/fixtures/ipc-harness.ts` | Builds the in-process IPC test harness (`createIpcHarness()`) via `NestFactory.createApplicationContext(AppModule)`, deep-importing `@hyveon/desktop-main`'s compiled `dist/`, and dispatches directly to controller methods. Also exposes `get(Provider)` to resolve a provider (e.g. `TerraformService`) directly from the container. |
| `app/packages/web/e2e/fixtures/server-mocks.ts` | `ServerMocks` class + extended `test` with `serverMocks` and `ipc` fixtures. |
| `app/packages/web/e2e/fixtures/terraform-shim.ts` | Extended `test` (`terraformFixture` + an `ipc` override that waits on it) that prepends a `terraform` PATH shim and points `TF_DIR`/`RUNS_DIR_PATH`/`TFVARS_PATH`/`FAKE_TERRAFORM_SCRIPT` at fresh per-spec temp dirs before the `ipc` harness is built — see [PATH-Shim Injection](#path-shim-injection) below. |
| `app/packages/web/e2e/fixtures/terraform-fixtures.ts` | Builder functions (`successfulPlanEntry`, `failedPlanEntry`, `successfulApplyEntry`, `successfulDestroyEntry`, `successfulOutputEntry`, `ansiPlanEntry`, `versionEntry`) and `writeFixture()` for scripting `fake-terraform.mjs` responses from orchestrator specs. |
| `app/packages/web/playwright.integration.config.ts` | Playwright config: `testDir: e2e/integration-specs`, `workers: 1`, no `webServer`, no `projects`. |
| `app/packages/web/e2e/fixtures/tfstate.fixture.json` | Synthetic Terraform state (`minecraft` + `valheim`, `us-east-1`, `test.example.com`, including `runs_table_name`), injected via `TF_STATE_PATH` when the `ipc` harness boots. |
| `app/packages/web/e2e/integration-specs/` | All integration specs; import `test`/`expect` from `./index.js` (or, for orchestrator specs, `../fixtures/terraform-shim.js`), not `@playwright/test`. |

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
| `config-service.spec.ts` | `EnvController.getEnv` returns region + domain from the tfstate fixture; `GamesController.listGames`/`listStatus` return the fixture game list. |
| `discord-config.spec.ts` | `DiscordController.getConfig` never echoes the raw bot token or public key — only the redacted `botTokenSet`/`publicKeySet` booleans. |
| `start-stop.spec.ts` | `GamesController.listGames`/`listStatus` report STOPPED games on initial load; a game seeded as RUNNING via mocked ECS responses can be stopped. |
| `status-polling.spec.ts` | Pushing RUNNING mock responses causes the next `GamesController.listStatus` dispatch to reflect the state change (the in-process analogue of the dashboard's poller). |
| `error-propagation.spec.ts` | `AccessDeniedException` from `RunTaskCommand` surfaces as `{ success: false, message: '…' }` from `GamesController.start`. |
| `can-run.spec.ts` | Placeholder — skipped until Discord permission enforcement (`canRun()`) is wired into the `ipc` test harness. |
| `terraform-plan.spec.ts` | `TerraformService.plan()` produces a `.tfplan` artifact + SHA-256 `planHash` on success; a failing plan yields `TerraformPlanError` with no `planHash`; binary/version resolution succeeds through the PATH shim. |
| `terraform-apply.spec.ts` | `TerraformController.apply` rejects an unapproved, expired-approval, or hash-mismatched plan without spawning `terraform` (verified via the fake binary's own end-channel message and `readRunRecord`); a fresh, matching approval applies and streams the scripted `apply` to completion. |
| `terraform-destroy.spec.ts` | `TerraformService.destroy()` throws `DestroyNotConfirmedError` without a token or once a token is reused; a fresh token streams the scripted destroy to completion. |
| `terraform-streaming.spec.ts` | ANSI escape sequences and stdout/stderr attribution survive streaming chunks and the persisted `terraform.log` byte-for-byte. |
| `terraform-run-records.spec.ts` | `run.json` is written for both successful and failed runs (with/without `planHash`); the `RunRecordStore` record embeds the log inline (no S3 offload key) and is retrievable via `TerraformRunsController.get`. |
| `terraform-output.spec.ts` | `TerraformController.output` returns the parsed outputs from a scripted `terraform output -json` response. |

## `fake-terraform.mjs` — Scripted Terraform Stand-In

`app/test/fake-terraform.mjs` is a scripted stand-in for the real `terraform` binary. It lets the integration tier (and any orchestrator unit tests) exercise `TerraformService` against realistic `stdout`/`stderr` output and exit codes without shelling out to real Terraform or touching real AWS. The orchestrator specs (`terraform-*.spec.ts`) wire it in via the PATH shim described below.

### Invocation

```bash
FAKE_TERRAFORM_SCRIPT=/path/to/fixture.json node app/test/fake-terraform.mjs plan -out=tfplan
```

- `FAKE_TERRAFORM_SCRIPT` (required) — absolute path to a JSON fixture file describing the scripted output. If unset, unreadable, or not valid JSON, the script writes a `fake-terraform: …` message to stderr and exits `1`.
- The subcommand (`init`, `plan`, `apply`, `destroy`, or `output` — whatever `TerraformService` would invoke `terraform` with) is read from `process.argv[2]`. Any extra CLI args (`-out=tfplan`, `-auto-approve`, etc.) are accepted but ignored — only the subcommand name is used to look up the scripted response.
- If no subcommand is given, or the fixture has no entry for the given subcommand, the script writes an error to stderr (listing the subcommands that *are* scripted) and exits `1`.

### Fixture Schema

The fixture is a JSON object keyed by subcommand name:

```json
{
  "plan": {
    "exitCode": 0,
    "lines": [
      { "stream": "stdout", "text": "Refreshing state...", "delayMs": 10 },
      { "stream": "stderr", "text": "Warning: deprecated argument", "delayMs": 5 },
      { "stream": "stdout", "text": "Plan: 1 to add, 0 to change, 0 to destroy." }
    ]
  }
}
```

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `<subcommand>.exitCode` | `number` | `0` | Process exit code once every line has been written. |
| `<subcommand>.lines` | `array` | `[]` | Emitted strictly in array order regardless of which stream each line targets, so fixtures can script realistic stdout/stderr interleaving. |
| `lines[].stream` | `"stdout"` \| `"stderr"` | `"stdout"` | Any value other than `"stderr"` is treated as `"stdout"`. |
| `lines[].text` | `string` | — | Written followed by a newline. |
| `lines[].delayMs` | `number` | `0` | Awaited immediately before that line is written, per-line, so fixtures can simulate realistic Terraform timing (e.g. a slow `plan` refresh before later output). |
| `<subcommand>.outFileContent` | `string` | *(unset)* | Opt-in artifact-writing field: when present, its bytes are written verbatim to the path supplied via a `-out=<path>` CLI argument once every scripted line has been emitted — e.g. a `plan` fixture sets this so the caller's SHA-256 `planHash` has a real `.tfplan` artifact on disk to hash. If `outFileContent` is scripted but no `-out=` argument was passed, the process exits `1` with a descriptive stderr message instead of silently dropping the artifact. Absent entirely, existing fixtures are unaffected — no file is written. |

## PATH-Shim Injection

`app/packages/web/e2e/fixtures/terraform-shim.ts` exports an extended `test` (`terraformFixture` fixture, plus an `ipc` override) that orchestrator specs import instead of `./index.js`:

```ts
import { test, expect } from '../fixtures/terraform-shim.js';
import { successfulPlanEntry, versionEntry, writeFixture } from '../fixtures/terraform-fixtures.js';

test('should ...', async ({ ipc, terraformFixture }) => {
  writeFixture(terraformFixture.scriptPath, {
    version: versionEntry(),
    plan: successfulPlanEntry(),
  });
  const terraform = ipc.get(TerraformService);
  // ...drive terraform.plan() directly, or ipc.dispatch(TerraformController, 'plan', ...)
});
```

`terraformFixture` runs *before* `ipc` (the fixture's own `ipc` override depends on it purely for ordering) because `TerraformService` resolves its binary path — and reads the `TF_DIR`/`RUNS_DIR_PATH`/`TFVARS_PATH`/`FAKE_TERRAFORM_SCRIPT` env seams — lazily on first use, but the shim must already be in place by the time anything in the built container could trigger that resolution. Per spec, `terraformFixture`:

1. Creates three temp dirs: a shim dir (holding an executable `terraform` wrapper that `exec`s `node app/test/fake-terraform.mjs "$@"`, plus the JSON fixture file and a placeholder `terraform.tfvars`), a `TF_DIR` composer dir (left empty — the fake binary ignores cwd contents), and a `RUNS_DIR_PATH` run-artifacts dir.
2. Prepends the shim dir to `process.env.PATH` and sets `FAKE_TERRAFORM_SCRIPT`/`TF_DIR`/`RUNS_DIR_PATH`/`TFVARS_PATH`, snapshotting prior values first.
3. On teardown, restores every snapshotted env var (deleting keys that were previously unset) and removes all three temp dirs.

Safe under the tier's `workers: 1`, `fullyParallel: false` config — env mutation windows never overlap between specs.

## DynamoDB Run-Record Mock

`app/packages/desktop-main/src/test-mocks/run-record-mock.ts` installs `aws-sdk-client-mock` interceptors on the `DynamoDBDocumentClient` prototype (`installRunRecordDynamoMock()`, wired into `createIpcHarness()` alongside `installEcsMock()`), backed by the exported `runRecordMockStore` singleton. Unlike `MockStore`'s FIFO queues, this is a genuinely **stateful** table: a plan run persisted via `TerraformService.plan()` (through the real `RunRecordService`) is retrievable by a later `TerraformController.approve`/`apply` call in the same spec, exactly like production.

- **`pk = RUN` items** — `PutCommand`/`QueryCommand` mirror `AwsRunRecordStore`'s `putRecord`/`getRecordByRunId`/`listRuns` request shapes (upsert-by-`sk`, filter by `runId`/`before`/`status`, `Limit`).
- **`pk = LOCK` / `sk = CURRENT` item** — the single apply-lock item `RunService.createRun`/`releaseRun` acquire/release via `acquireRunLock`/`releaseRunLock`. `PutCommand`'s conditional-put semantics (`attribute_not_exists(pk) OR expiresAt < :now`) are reproduced, throwing `ConditionalCheckFailedException` when another unexpired lock is held — the same exception `AwsRunRecordStore.acquireRunLock` catches and converts to `RunLockHeldError`.
- **`runRecordMockStore.patchApprovedAt(runId, isoString)`** — directly overwrites a stored record's `approvedAt`, letting a spec simulate an approval minted outside the 15-minute apply window without fake timers (which never reach the spawned fake-terraform child process).
- **Reset per harness** — `createIpcHarness()` calls `runRecordMockStore.reset()` before installing the mock, so no plan/apply/destroy record or apply lock leaks from one spec's `AppModule` context into the next.

Since the mock patches `DynamoDBDocumentClient`'s prototype globally, it also intercepts `AuditService`'s DynamoDB traffic (harmless — audit items land in the same in-memory item list but are excluded from every `runId`-filtered query).

## Design Constraints

- **`workers: 1`, `fullyParallel: false`** — the `MockStore` is an in-process singleton; concurrent tests would corrupt each other's queues.
- **`serverMocks` resets before and after every test** — the fixture calls `mockStore.reset()` in-process in setup and teardown; there is no HTTP round-trip.
- **No HTTP server, no Vite build/preview, no `BrowserWindow`** — every integration spec dispatches directly to the `AppModule` DI container via the `ipc` fixture (`ipc-harness.ts`) and pushes mock ECS responses straight into the in-process `MockStore` singleton via the `serverMocks` fixture (`server-mocks.ts`), so there is no test-only route surface and nothing for Playwright to boot as a `webServer`.
- **`TF_STATE_PATH`** — `createIpcHarness()` (`ipc-harness.ts`) sets this env var to `e2e/fixtures/tfstate.fixture.json` before building the `AppModule` context, so `ConfigService` reads the fixture instead of requiring a real Terraform state file.

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
  `terraform.init`, `terraform.runs.streamLogs`), back the mock with
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
