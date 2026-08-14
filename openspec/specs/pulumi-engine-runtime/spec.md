# pulumi-engine-runtime

## Purpose

Defines how the desktop main process resolves, downloads, version-pins, and caches the Pulumi engine without requiring the operator to install anything, and the Automation API seam every infrastructure operation goes through — workspace and stack construction, the self-managed S3 state backend, the secrets provider, AWS credential wiring, stale-lock recovery, and engine process lifecycle.

## Requirements

### Requirement: App-managed engine provisioning

The desktop main process SHALL provide a `PulumiEngineService` that resolves a usable Pulumi engine without requiring the operator to install anything. The service MUST NOT probe `PATH` for a `pulumi` binary as its primary resolution strategy; it SHALL resolve the engine from an app-owned cache directory under Electron `userData`, and when the cache is empty or holds a version other than the pinned one, it SHALL download and install the pinned engine into that cache before the first infrastructure operation. Engine resolution MUST be memoized so concurrent callers share a single provisioning attempt, and the service constructor MUST NOT throw on a machine with no engine present, so the Nest DI container still builds.

#### Scenario: First run on a machine with no engine

- **WHEN** an infrastructure operation is requested and the engine cache under `userData` is empty
- **THEN** the service downloads the pinned engine version into the cache, reports provisioning progress to the caller, and completes the operation without the operator having installed anything

#### Scenario: Subsequent runs reuse the cache

- **WHEN** an infrastructure operation is requested and the pinned engine version is already present in the cache
- **THEN** no download is performed and the cached engine is used

#### Scenario: Concurrent callers share one provisioning attempt

- **WHEN** two infrastructure operations are requested before engine provisioning has completed
- **THEN** exactly one download is performed and both callers resolve against the same engine

#### Scenario: Provider plugins are reported as their own phase

- **WHEN** the first infrastructure operation runs on a machine whose plugin cache is empty, so the engine downloads the cloud provider plugin
- **THEN** the plugin download is reported to the caller as a distinct phase from engine provisioning and from the operation itself, so a multi-minute first run is not presented as a hang

#### Scenario: Engine and plugin caches live under app-owned directories

- **WHEN** the engine and its plugins are provisioned
- **THEN** both land under app-owned directories derived from Electron `userData`, so the app does not write into or depend on a shared user-level tool directory

#### Scenario: Container builds without an engine

- **WHEN** the Nest application context is constructed on a machine with no engine installed and no network access
- **THEN** `PulumiEngineService` instantiates successfully and the failure surfaces only when an operation is actually attempted

### Requirement: Pinned engine version

The engine version SHALL be pinned to a single constant exported from `@hyveon/shared`, and the service MUST provision exactly that version rather than "latest". The resolved version SHALL be readable through a service accessor so the Settings page can display it. When the cache holds a different version than the pin, the pinned version MUST be provisioned and used.

#### Scenario: Cache holds a stale version

- **WHEN** the engine cache contains a version other than the pinned constant
- **THEN** the pinned version is provisioned and used, and the stale version is not used for the operation

#### Scenario: Resolved version is observable

- **WHEN** the renderer requests the engine status after provisioning
- **THEN** it receives the resolved engine version matching the pinned constant

### Requirement: Engine provisioning failure is actionable

When engine provisioning fails — no network, a download or integrity-verification failure, or an unwritable cache directory — the service SHALL surface a distinct, typed error naming the cause, and MUST NOT leave a partially written engine in the cache that a later run would treat as valid. The failure MUST be reportable to the wizard and to the Plan/Apply page rather than crashing the main process.

#### Scenario: Provisioning fails with no network

- **WHEN** engine provisioning is attempted on a machine with no network connectivity
- **THEN** a typed provisioning error naming the cause is surfaced to the renderer, the cache is left with no partially written engine, and a retry is offered

#### Scenario: Interrupted download leaves no usable partial

- **WHEN** a download is interrupted partway through
- **THEN** the next provisioning attempt does not treat the partial content as an installed engine and re-downloads it

### Requirement: Automation API workspace seam

All infrastructure operations SHALL go through a single main-process seam that constructs the Pulumi workspace and stack, rather than each caller building its own. The seam MUST configure the self-managed state backend, the secrets provider, and the AWS credentials for every operation, and MUST NOT require a Pulumi Cloud account or access token. The state backend SHALL be the operator's own S3 bucket, provisioned by the existing bootstrap flow.

The workspace directory SHALL be a single stable location per stack under `userData`, reused across operations rather than created per operation. Creating one per operation would reproduce, in a new location, the unbounded temporary-directory growth that motivated setting an explicit path in the first place.

The secrets passphrase MUST be present in the engine environment before the first stack is created and for every operation thereafter. On a self-managed backend the engine has no interactive fallback under the non-interactive mode the automation interface always uses — a missing passphrase is a hard failure at stack creation, not a prompt — and there is no option to run without a secrets provider. The seam MUST derive the passphrase deterministically from the AWS account ID (via STS `GetCallerIdentity`) and the stack name, using a fixed app-level derivation constant, rather than generating and persisting a random per-machine value. The derived passphrase MUST NOT be stored; it SHALL be recomputed on every invocation. This makes the passphrase reproducible on any machine holding valid credentials for the same AWS account, so a second or replacement machine can operate against an existing stack without any locally-stored passphrase record. The passphrase MUST NOT be treated as a confidentiality boundary — the infrastructure program does not mark any Pulumi stack config or output as secret, so the passphrase gates access to non-sensitive state only, not encryption of real secrets.

For an install that still holds a legacy random passphrase in its OS-level encrypted store from before this behavior existed, the seam MUST perform a one-time, automatic migration the next time the workspace is constructed: read the legacy passphrase, re-encrypt the stack's secrets provider to the newly-derived passphrase, and remove the legacy passphrase from the encrypted store only after the re-encryption succeeds. This migration MUST require no user action and MUST be safely retryable — if re-encryption fails, the legacy passphrase MUST remain in place so the next launch retries with the same still-valid value.

Because the passphrase is no longer stored, the seam MUST record a separate, non-secret local marker — set after a stack has been successfully created or selected at least once on this install — for any caller that needs to distinguish "this install has never interacted with a stack" from "this install has, but is not currently holding a decrypted passphrase in memory." This marker MUST NOT be used as, or treated as equivalent to, a passphrase or any other secret value.

#### Scenario: Operations use the self-managed backend

- **WHEN** any infrastructure operation runs
- **THEN** it reads and writes state in the operator's own S3 bucket and no Pulumi Cloud login or access token is required

#### Scenario: Backend is not yet bootstrapped

- **WHEN** an infrastructure operation is attempted before the state bucket exists
- **THEN** the seam surfaces an actionable error directing the operator to the bootstrap step rather than creating the bucket implicitly

#### Scenario: Workspace is reused, not accumulated

- **WHEN** many operations run against the same stack over the app's lifetime
- **THEN** they share one stable workspace directory under `userData` rather than creating a new one per operation, and the number of workspace directories does not grow with the number of operations

#### Scenario: Passphrase is present before stack creation

- **WHEN** the stack is created for the first time
- **THEN** the passphrase is derived from the AWS account ID and stack name and supplied in the engine environment, so creation does not fail on a missing secrets provider, and no passphrase is written to local storage

#### Scenario: A second machine operates on an existing stack

- **WHEN** an infrastructure operation runs on a machine with valid credentials for the same AWS account as an existing stack, and that machine has no locally stored passphrase for the stack
- **THEN** the seam derives the same passphrase the stack was created with and completes the operation, without generating a new passphrase and without failing due to a missing local record

#### Scenario: A legacy per-machine passphrase is migrated automatically

- **WHEN** the workspace is constructed on an install whose encrypted store still holds a legacy randomly-generated passphrase for the stack
- **THEN** the seam re-encrypts the stack's secrets provider to the newly-derived passphrase, removes the legacy passphrase from the encrypted store, and completes the operation, with no user-facing action required

#### Scenario: Local initialization marker is set after a successful stack operation

- **WHEN** the seam successfully creates or selects the stack
- **THEN** it records a non-secret local marker that this install has interacted with a stack at least once, without writing the passphrase itself anywhere

#### Scenario: Local initialization marker is not set on failure

- **WHEN** stack creation or selection fails
- **THEN** the local initialization marker is not set (or, if already set from a prior success, is left unchanged)

#### Scenario: Legacy migration is retried after a failed re-encryption

- **WHEN** the one-time migration's re-encryption step fails partway (e.g. a network interruption)
- **THEN** the legacy passphrase is left in place in the encrypted store, and the next workspace construction attempts the migration again using that same legacy passphrase

### Requirement: Wizard-selected credentials reach the engine

The AWS credentials selected in the wizard SHALL be the credentials the engine uses. When the operator selected a named profile, the engine environment MUST carry that profile. When the operator pasted keys through the safeStorage flow, the decrypted values MUST be passed to the engine environment in the main process. The engine MUST NOT be left to resolve credentials through its own default chain, because that silently ignores the operator's choice.

The selected source MUST be **exclusive**. Every operation SHALL start from a sanitized environment in which the credential variables belonging to the *other* source are cleared, not merely left unset: a profile run MUST clear any inherited `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and `AWS_SESSION_TOKEN`, and a paste-flow run MUST clear any inherited `AWS_PROFILE` and `AWS_DEFAULT_PROFILE`. The engine inherits the Electron process environment by default, so without this an ambient variable — set by the operator's shell, a launcher, or another tool — silently outranks the wizard's selection and deploys under an identity the operator never chose.

#### Scenario: Named profile is honored

- **WHEN** the operator selected the profile `personal` in the wizard and an infrastructure operation runs
- **THEN** the engine executes against the `personal` profile's credentials, not the ambient default profile

#### Scenario: Pasted keys are honored

- **WHEN** the operator supplied credentials through the paste flow and an infrastructure operation runs
- **THEN** the decrypted key material is supplied to the engine environment from the main process and never crosses the IPC boundary to the renderer

#### Scenario: Ambient keys cannot override a selected profile

- **WHEN** `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` are present in the Electron process environment and the operator has selected a named profile
- **THEN** those variables are cleared from the engine environment and the operation runs under the selected profile

#### Scenario: Ambient profile cannot override pasted keys

- **WHEN** `AWS_PROFILE` is present in the Electron process environment and the operator supplied credentials through the paste flow
- **THEN** `AWS_PROFILE` and `AWS_DEFAULT_PROFILE` are cleared from the engine environment and the operation runs under the pasted keys

#### Scenario: Credentials are not logged

- **WHEN** an infrastructure operation runs with any credential source
- **THEN** no access key id, secret access key, or session token appears in the streamed output, the persisted run log, or application logs

### Requirement: Stale backend lock recovery

The self-managed backend serializes updates with lock objects it writes into the state bucket, and those locks have no server-side expiry — a run killed by a crash, a force-quit, or a machine losing power leaves a lock that blocks every subsequent operation indefinitely.

Recovery SHALL be governed by **provable ownership**, not by the absence of local activity. The app MUST record the identity of every lock it causes to be taken, so it can later distinguish two cases:

- **A lock the app can prove it owns** — recorded against a run of this installation that has since terminated. The app MAY reclaim it without prompting, because it is cleaning up after itself rather than overriding another party. This is what makes the forceful-termination path in "Engine process lifecycle" safe: a force-killed engine can orphan its lock, and that orphan MUST be reclaimable.
- **A lock the app cannot prove it owns** — written by another installation, another machine, or an unrecognised run. Clearing it requires explicit operator confirmation, and the prompt MUST show the lock's recorded holder and age so the operator is not confirming blind.

The absence of an in-flight operation within this app instance MUST NOT be treated as evidence that a lock is stale. Another machine may be mid-update against the same stack, and clearing its lock would permit concurrent updates and risk corrupting state.

#### Scenario: Force-terminated run reclaims its own lock

- **WHEN** an engine invocation is forcefully terminated and leaves its backend lock behind, and the next operation encounters that lock
- **THEN** the app recognises the lock as its own from the recorded identity and reclaims it without prompting, so a force-kill does not wedge the stack

#### Scenario: Unrecognised lock requires confirmation with evidence

- **WHEN** an operation fails because the stack is locked and the app cannot prove it owns the lock
- **THEN** the failure is presented as a possible stale-lock condition naming the stack, the recorded holder, and the lock's age, and nothing is cleared until the operator explicitly confirms

#### Scenario: Another machine's active lock is not presented as stale

- **WHEN** a lock is held by a different installation whose update is still running
- **THEN** the app does not clear it, and does not describe it as stale merely because no operation is in flight locally

#### Scenario: In-app concurrency is reported as busy, not stale

- **WHEN** an operation is requested while this app instance already holds the workspace
- **THEN** it is refused as busy through the existing conflict path, and no lock recovery action is offered

### Requirement: Engine process lifecycle

Engine invocations SHALL be terminated deterministically. Every operation MUST be cancellable, and cancellation MUST release the workspace and any durable lock the operation holds. Because a graceful interrupt is not guaranteed to stop a wedged engine process, cancellation MUST escalate to a forceful termination after a bounded timeout rather than waiting indefinitely. When the Electron app quits, no engine process or listener may remain that prevents the process from exiting.

#### Scenario: Operation is cancelled

- **WHEN** the operator cancels an in-flight operation
- **THEN** the engine invocation is terminated, the run is recorded as aborted, and the workspace and apply lock are released

#### Scenario: Unresponsive engine is force-terminated

- **WHEN** a cancelled engine invocation does not exit within the bounded escalation timeout
- **THEN** it is forcefully terminated so the app does not wait on it indefinitely, and the run still settles as aborted

#### Scenario: App quits cleanly during idle

- **WHEN** the app is quit after at least one infrastructure operation has completed
- **THEN** the Electron process exits without hanging and no orphaned engine process remains

#### Scenario: App quits with an operation in flight

- **WHEN** the app is quit while an infrastructure operation is running
- **THEN** the engine invocation is terminated during shutdown and the process exits rather than hanging
