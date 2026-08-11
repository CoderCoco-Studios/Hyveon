# iac-destroy-flow

## Purpose

Defines the operator-facing destroy flow: a self-bridged IPC channel that streams destroy output under the same durable apply lock as plan/apply, a fresh server-minted single-use confirmation token gate that prevents accidental destroys, a preload bridge exposing the destroy surface, and a type-to-confirm UI on the `/iac` page.

## Requirements

### Requirement: Destroy IPC channel

`IacController` SHALL expose an `iac.destroy` IPC channel following the shipped `iac.apply` streaming pattern: a self-bridged handler (registered via `onModuleInit` inside a real Electron main process, excluded from the generic bridge via `SELF_BRIDGED_PATTERNS` in `ipc-main-bridge.ts`) that resolves an immediate `{ started, runId?, error?, conflict? }` ack, streams every destroy output chunk on a chunk side channel tagged with the run's id, sends exactly one terminal end message, and refuses submission with a `conflict` ack when the shared workspace is busy. The handler MUST acquire the durable apply lock (`RunService.createRun`) before invoking the engine and release it on every exit path, record an audit entry for accepted submissions, and persist a run record so destroy runs appear in run history. Because the engine is invoked in-process through the automation seam rather than as a directly spawned command, the handler MUST also release the lock when the engine invocation is cancelled or the app shuts down mid-run.

#### Scenario: Destroy streams output and completes

- **WHEN** a valid destroy submission is accepted and the destroy runs to completion
- **THEN** the renderer receives ordered chunk messages tagged with the run id followed by a single end message reporting success, and a `kind: 'destroy'` run record is persisted and visible in run history

#### Scenario: Destroy refused while the workspace is busy

- **WHEN** `iac.destroy` is invoked while another operation is in flight
- **THEN** the ack resolves `{ started: false, conflict }` naming the in-flight operation, no engine invocation is started, and no audit entry or run record is written

#### Scenario: Lock is released when a destroy is cancelled

- **WHEN** an accepted destroy run is cancelled before it reaches a terminal state
- **THEN** the durable apply lock is released, the run record settles as aborted, and a subsequent operation is not refused as busy

#### Scenario: Lock is released when the app shuts down mid-run

- **WHEN** the app shuts down while a destroy run is in flight, before it reaches a terminal state
- **THEN** the durable apply lock is released as part of shutdown, and a subsequent app launch does not report the workspace as permanently busy

### Requirement: Fresh confirmation token gate

Every destroy attempt SHALL be gated on a fresh, server-minted, single-use, expiring confirmation token: the renderer requests a token via a plain-invoke IPC channel backed by a token-minting service method, and `iac.destroy` passes the supplied token to the destroy service method, which refuses (per `DestroyNotConfirmedError`) when the token is absent, unknown, expired, or already consumed. The engine's automation interface is inherently non-interactive and offers no operator confirmation prompt of its own, so this gate is the only thing standing between an accidental invocation and the destruction of all managed infrastructure — it MUST NOT be bypassable by any code path, and tokens MUST NOT be reusable across attempts.

The token SHALL be **bound to the destroy target**, not merely to the act of minting. A minted token records the workspace and stack it was issued for, and the destroy service MUST reject a token whose recorded target does not match the stack about to be destroyed. Consumption MUST be atomic — the token is marked spent before the engine is invoked, so two concurrent submissions cannot both pass on one token. Without binding, a token proves only that *some* token was issued, not that the operator confirmed destruction of *this* stack, which is precisely the assurance a destroy gate exists to provide.

#### Scenario: Token bound to a different stack is rejected

- **WHEN** a destroy is submitted with a valid, unexpired token that was minted for a different workspace or stack
- **THEN** the submission is refused and no engine destroy is invoked

#### Scenario: Concurrent submissions cannot share one token

- **WHEN** two destroy submissions carrying the same token arrive concurrently
- **THEN** at most one proceeds, because consumption is atomic and completes before the engine is invoked

#### Scenario: Destroy without a fresh token is refused

- **WHEN** `iac.destroy` is invoked with a missing, expired, or previously consumed confirmation token
- **THEN** the submission is refused with the `DestroyNotConfirmedError`-derived error, and no engine destroy is invoked

#### Scenario: Each attempt needs its own token

- **WHEN** a destroy run completes (or fails) and the operator initiates another destroy
- **THEN** a new token must be minted and confirmed — the prior token is rejected

#### Scenario: No unguarded destroy path exists

- **WHEN** the codebase is inspected for invocations of the engine's destroy operation
- **THEN** every call site is reached only through the token-gated service method

### Requirement: Preload destroy bridge

The preload SHALL expose the destroy surface on the `hyveon.iac` namespace — a token-minting call (`mintDestroyToken`) plus a `destroy` call following the existing streaming bridge shape (side-channel chunk/end events surfaced to the renderer, honoring the test-mode mock registry) — with typed mirrors in `hyveon-api.ts` kept in sync with the controller payload shapes.

#### Scenario: Renderer consumes destroy output through the bridge

- **WHEN** the renderer initiates a destroy through `hyveon.iac` with a freshly minted token
- **THEN** it receives the run's chunks in order and a terminal completion/error through the preload bridge without touching `ipcRenderer` directly

### Requirement: Type-to-confirm destroy UI

The `/iac` page SHALL offer a destroy entry point that opens an explicit type-to-confirm dialog: the operator MUST type a fixed confirmation phrase before the app mints a token and submits the destroy, the dialog MUST spell out that all managed infrastructure will be destroyed, and the run's output MUST stream live in the same ANSI log viewer used for plan/apply. A BUSY conflict MUST be surfaced the same way as plan/apply conflicts.

#### Scenario: Confirmation phrase gates submission

- **WHEN** the destroy dialog is open and the typed text does not match the required phrase
- **THEN** the destructive confirm button remains disabled and no token is minted

#### Scenario: Confirmed destroy streams live

- **WHEN** the operator types the exact phrase and confirms
- **THEN** a token is minted, the destroy is submitted, and its output streams live with a terminal success or failure state shown when it ends
