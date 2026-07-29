## REMOVED Requirements

### Requirement: Fake terraform binary injected via PATH

**Reason**: `PulumiService` drives the Automation API in-process rather than spawning a `terraform` binary resolved off `PATH`, so there is no external binary left for a PATH-based fixture to shim, and no `TerraformNotFoundError`-style resolution step to exercise.

**Migration**: Integration specs substitute a stub at the `PulumiService` DI seam instead of injecting a fake binary via `PATH`. `app/test/fake-terraform.mjs` and its `PATH`/`FAKE_TERRAFORM_SCRIPT` shim wiring are deleted. See the "In-process engine stub injected via DI" requirement below.

### Requirement: Output subcommand integration coverage

**Reason**: Outputs are no longer read via a streamed `output` subcommand; the Automation API exposes them as a direct `stack.outputs()` workspace read with no subprocess or streaming involved.

**Migration**: Replaced by the "Stack outputs integration coverage" requirement below.

## MODIFIED Requirements

### Requirement: Plan integration coverage

The integration suite SHALL verify that `PulumiService`'s preview operation, run through the real DI container, produces a saved update-plan artifact, computes a `planHash` covering that artifact plus the configuration object's version id, and reports the engine's structured change summary — and that a failing preview yields a failed outcome with no `planHash`.

#### Scenario: Successful preview produces artifact and planHash

- **WHEN** a spec drives the preview operation with a stub scripting a successful preview whose plan artifact is written by the stub
- **THEN** the run completes with a success outcome whose plan artifact exists and whose `planHash` covers both that artifact and the configuration object's version id

#### Scenario: Structured change summary matches the scripted response

- **WHEN** a spec drives the preview operation with a stub scripting specific create/update/replace/delete counts in its structured change summary
- **THEN** the returned result's change summary and the persisted run record's change summary both match those exact counts

#### Scenario: Failed preview yields no planHash

- **WHEN** a spec drives the preview operation with a stub scripting a failure
- **THEN** the run completes with a failed outcome and no `planHash` is computed or persisted

### Requirement: Apply rejects stale and unapproved plans

The integration suite SHALL verify `iac.apply`'s pre-spawn gates through the real controller wiring: apply MUST be rejected (with no engine invocation started) when the plan run has no approval, when the approval is older than the 15-minute `APPROVAL_WINDOW_MS`, when the supplied `planHash` does not match the approved record, or when the engine version has changed since the plan was produced — and MUST proceed to invoke the stubbed engine when a fresh, matching approval exists against the current engine version.

#### Scenario: Unapproved plan rejected

- **WHEN** `IacController.apply` is dispatched for a plan run whose persisted record has no `approvedBy`/`approvedAt`
- **THEN** the ack is `{ started: false }` with an error describing the missing approval, and the stubbed engine is never invoked for `apply`

#### Scenario: Expired approval rejected

- **WHEN** `IacController.apply` is dispatched for a plan run whose `approvedAt` is older than the 15-minute approval window
- **THEN** the ack is `{ started: false }` with an approval-expired error, and the stubbed engine is never invoked for `apply`

#### Scenario: Mismatched planHash rejected

- **WHEN** `IacController.apply` is dispatched with a `planHash` that does not match the approved plan record's stored hash
- **THEN** the ack is `{ started: false }` with a stale/mismatched-plan error, and the stubbed engine is never invoked for `apply`

#### Scenario: Engine version mismatch rejected

- **WHEN** `IacController.apply` is dispatched for a plan whose recorded engine version differs from the currently resolved engine version
- **THEN** the ack is `{ started: false }` with an error naming the version change, and the stubbed engine is never invoked for `apply`

#### Scenario: Fresh approved plan applies

- **WHEN** `IacController.apply` is dispatched with the correct `planHash` for a plan record approved within the window, against the same engine version that produced the plan
- **THEN** the ack is `{ started: true }` and the stub's scripted `up` response is executed to completion

#### Scenario: Missing plan record rejected

- **WHEN** `IacController.apply` is dispatched with a `planRunId` that has no persisted plan record
- **THEN** the ack is `{ started: false }` with an error describing the missing plan, and the stubbed engine is never invoked for `apply`

#### Scenario: Stale on-disk artifact rejected

- **WHEN** `IacController.apply` is dispatched with a `planHash` matching the stored record, but the plan artifact on disk has since changed so its re-hashed value no longer matches
- **THEN** the ack is `{ started: false }` with an error describing the mismatch, and the stubbed engine is never invoked for `apply`

#### Scenario: Configuration moved since the plan rejected

- **WHEN** `IacController.apply` is dispatched for a plan whose recorded configuration version no longer matches the configuration object's current version
- **THEN** the ack is `{ started: false }` with an error explaining the plan is stale, and the stubbed engine is never invoked for `apply`

#### Scenario: Competing applies are ordered by the atomic lock

- **WHEN** two `IacController.apply` dispatches for the same approved plan are submitted close enough together that both observe a free workspace before either acquires the durable apply lock
- **THEN** exactly one acquires the lock and proceeds to invoke the stubbed engine, and the other is refused with a conflict

### Requirement: Destroy gated by fresh confirmation token

The integration suite SHALL verify that `PulumiService.destroy` refuses to invoke the engine without a fresh confirmation token minted via `mintDestroyConfirmationToken()` — throwing `DestroyNotConfirmedError` for missing, expired, superseded, or already-consumed tokens — and runs the stub's scripted destroy when a valid token is supplied.

#### Scenario: Destroy without a token rejected

- **WHEN** a spec invokes `destroy()` without minting a confirmation token
- **THEN** `DestroyNotConfirmedError` is thrown and the stubbed engine is never invoked for `destroy`

#### Scenario: Consumed token cannot be reused

- **WHEN** a spec mints a token, completes one `destroy()` run with it, and invokes `destroy()` again with the same token
- **THEN** the second call throws `DestroyNotConfirmedError` and the engine is not invoked a second time

#### Scenario: Fresh token permits destroy

- **WHEN** a spec mints a confirmation token and invokes `destroy()` with it immediately
- **THEN** the stub's scripted destroy response runs to completion and the run's terminal state matches the stub

#### Scenario: Token bound to a different target rejected

- **WHEN** a spec mints a confirmation token for one workspace/stack and invokes `destroy()` against a different stack with that token
- **THEN** `DestroyNotConfirmedError` is thrown and the stubbed engine is never invoked for `destroy`

#### Scenario: Expired or superseded token rejected

- **WHEN** a spec invokes `destroy()` with a token that has expired, or with a token superseded by a later mint for the same target
- **THEN** `DestroyNotConfirmedError` is thrown and the stubbed engine is never invoked for `destroy`

#### Scenario: Concurrent submissions consume one token atomically

- **WHEN** two `destroy()` calls carrying the same confirmation token are invoked concurrently
- **THEN** at most one proceeds to invoke the stubbed engine, and the other is rejected with `DestroyNotConfirmedError` because consumption is atomic

### Requirement: Streamed run chunks preserve ANSI escape sequences

The integration suite SHALL verify that `PulumiService`'s streamed run output and its persisted run log pass the stub's scripted stdout/stderr lines through verbatim — including ANSI colour escape sequences — without stripping or re-encoding, and preserve each line's stream attribution.

#### Scenario: ANSI sequences survive streaming and the run log

- **WHEN** a spec runs an operation whose stub scripts lines containing ANSI escape sequences on both stdout and stderr
- **THEN** every collected chunk's text contains the escape sequences byte-for-byte with correct stdout/stderr attribution, and the run's persisted log contains them unmodified

### Requirement: Run records persisted for every run

The integration suite SHALL verify that each completed preview/apply/destroy run persists a local run record capturing `runId`, `kind`, timestamps, exit outcome, and (for successful previews) `planHash`, that the run is persisted to the `RunRecordStore` via `RunRecordService` with its log embedded inline when under the 350KB limit, and that the run is subsequently retrievable through the runs IPC surface.

#### Scenario: Successful preview writes a run record with planHash

- **WHEN** a spec completes a successful preview run
- **THEN** the local run record exists with `kind: "plan"`, a success outcome, and a `planHash` matching the returned result's hash

#### Scenario: Failed run still persisted

- **WHEN** a spec completes a run whose stub scripts a failure
- **THEN** the run record is still written with the failed outcome and no `planHash`

#### Scenario: Store record embeds inline log

- **WHEN** a spec completes a run whose scripted output is under the 350KB inline limit
- **THEN** the record persisted through the mocked `RunRecordStore` carries the run log inline (no S3 offload key), matching the persisted run log content

#### Scenario: Persisted run is retrievable through the runs listing IPC

- **WHEN** a spec completes a run and then dispatches `iac.runs.list` (or `hyveon.iac.runs.list` from the preload seam) with a page-size limit and, separately, a status filter matching the run's outcome
- **THEN** both the paginated call and the status-filtered call return a page containing the just-persisted run record

## ADDED Requirements

### Requirement: In-process engine stub injected via DI

The integration test harness SHALL cause `PulumiService` to be exercised through a stub substituted at its dependency-injection seam within the real DI container, without spawning any subprocess and without patching `PulumiService` internals. No integration spec SHALL invoke the real Pulumi engine, download the real engine binary, or reach real AWS. The stub MUST be able to script preview, apply, destroy, and stack-output responses, including structured change summaries and failure outcomes, so every gate above it can be exercised deterministically.

#### Scenario: Stub substituted through the DI container

- **WHEN** an integration spec boots the `ipc` harness with a scripted `PulumiService` stub registered in the DI container and triggers any IaC operation
- **THEN** the real controller wiring dispatches to the stub, and the run's output matches the scripted fixture rather than a real engine invocation

#### Scenario: No real engine or AWS reachable from integration specs

- **WHEN** the integration suite is inspected for engine invocations
- **THEN** every spec resolves `PulumiService` to the stub, and none downloads the real engine binary or issues a real AWS call

### Requirement: Stack outputs integration coverage

The integration suite SHALL verify that the stack-outputs IPC channel dispatched through the real controller reads outputs via the stubbed engine's `stack.outputs()` and returns them, degrading to a "not deployed yet" result — rather than throwing — for a stack that has never been deployed.

#### Scenario: Scripted outputs returned

- **WHEN** the stack-outputs channel is dispatched with a stub scripting a populated `stack.outputs()` response
- **THEN** the dispatch resolves with the outputs matching the stub's scripted values

#### Scenario: Never-deployed stack degrades cleanly

- **WHEN** the stack-outputs channel is dispatched with a stub scripting an empty/never-deployed stack
- **THEN** the dispatch resolves a "not deployed yet" result rather than throwing
