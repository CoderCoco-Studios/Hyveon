## MODIFIED Requirements

### Requirement: Destroy IPC channel

`TerraformController` SHALL expose a `terraform.destroy` IPC channel following the shipped `terraform.apply` streaming pattern: a self-bridged handler (registered via `onModuleInit` inside a real Electron main process, excluded from the generic bridge via `SELF_BRIDGED_PATTERNS` in `ipc-main-bridge.ts`) that resolves an immediate `{ started, runId?, error?, conflict? }` ack, streams every destroy output chunk on a chunk side channel tagged with the run's id, sends exactly one terminal end message, and refuses submission with a `conflict` ack when the shared workspace is busy. The handler MUST acquire the durable apply lock (`RunService.createRun`) before invoking the engine and release it on every exit path, record an audit entry for accepted submissions, and persist a run record so destroy runs appear in run history. Because the engine is invoked in-process through the automation seam rather than as a directly spawned command, the handler MUST also release the lock when the engine invocation is cancelled or the app shuts down mid-run.

#### Scenario: Destroy streams output and completes

- **WHEN** a valid destroy submission is accepted and the destroy runs to completion
- **THEN** the renderer receives ordered chunk messages tagged with the run id followed by a single end message reporting success, and a `kind: 'destroy'` run record is persisted and visible in run history

#### Scenario: Destroy refused while the workspace is busy

- **WHEN** `terraform.destroy` is invoked while another operation is in flight
- **THEN** the ack resolves `{ started: false, conflict }` naming the in-flight operation, no engine invocation is started, and no audit entry or run record is written

#### Scenario: Lock is released when a destroy is cancelled

- **WHEN** an accepted destroy run is cancelled before it reaches a terminal state
- **THEN** the durable apply lock is released, the run record settles as aborted, and a subsequent operation is not refused as busy

### Requirement: Fresh confirmation token gate

Every destroy attempt SHALL be gated on a fresh, server-minted, single-use, expiring confirmation token: the renderer requests a token via a plain-invoke IPC channel backed by a token-minting service method, and `terraform.destroy` passes the supplied token to the destroy service method, which refuses (per `DestroyNotConfirmedError`) when the token is absent, unknown, expired, or already consumed. The engine's automation interface is inherently non-interactive and offers no operator confirmation prompt of its own, so this gate is the only thing standing between an accidental invocation and the destruction of all managed infrastructure — it MUST NOT be bypassable by any code path, and tokens MUST NOT be reusable across attempts.

#### Scenario: Destroy without a fresh token is refused

- **WHEN** `terraform.destroy` is invoked with a missing, expired, or previously consumed confirmation token
- **THEN** the submission is refused with the `DestroyNotConfirmedError`-derived error, and no engine destroy is invoked

#### Scenario: Each attempt needs its own token

- **WHEN** a destroy run completes (or fails) and the operator initiates another destroy
- **THEN** a new token must be minted and confirmed — the prior token is rejected

#### Scenario: No unguarded destroy path exists

- **WHEN** the codebase is inspected for invocations of the engine's destroy operation
- **THEN** every call site is reached only through the token-gated service method
