## ADDED Requirements

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

The secrets passphrase MUST be present in the engine environment before the first stack is created and for every operation thereafter. On a self-managed backend the engine has no interactive fallback under the non-interactive mode the automation interface always uses — a missing passphrase is a hard failure at stack creation, not a prompt — and there is no option to run without a secrets provider. The seam MUST therefore generate the passphrase, persist it through the OS-level encrypted store, and supply it on every invocation. Losing it makes the stack unusable, so the seam MUST fail loudly rather than silently generating a second passphrase for a stack that already exists.

#### Scenario: Operations use the self-managed backend

- **WHEN** any infrastructure operation runs
- **THEN** it reads and writes state in the operator's own S3 bucket and no Pulumi Cloud login or access token is required

#### Scenario: Backend is not yet bootstrapped

- **WHEN** an infrastructure operation is attempted before the state bucket exists
- **THEN** the seam surfaces an actionable error directing the operator to the bootstrap step rather than creating the bucket implicitly

#### Scenario: Passphrase is present before stack creation

- **WHEN** the stack is created for the first time
- **THEN** the passphrase is already generated and supplied in the engine environment, so creation does not fail on a missing secrets provider

#### Scenario: Missing passphrase for an existing stack fails loudly

- **WHEN** an operation runs against an existing stack and the stored passphrase cannot be retrieved
- **THEN** the seam reports that the stack's passphrase is unavailable and does not generate a replacement, because a new passphrase cannot decrypt existing state

### Requirement: Wizard-selected credentials reach the engine

The AWS credentials selected in the wizard SHALL be the credentials the engine uses. When the operator selected a named profile, the engine environment MUST carry that profile. When the operator pasted keys through the safeStorage flow, the decrypted values MUST be passed to the engine environment in the main process. The engine MUST NOT be left to resolve credentials through its own default chain, because that silently ignores the operator's choice.

#### Scenario: Named profile is honored

- **WHEN** the operator selected the profile `personal` in the wizard and an infrastructure operation runs
- **THEN** the engine executes against the `personal` profile's credentials, not the ambient default profile

#### Scenario: Pasted keys are honored

- **WHEN** the operator supplied credentials through the paste flow and an infrastructure operation runs
- **THEN** the decrypted key material is supplied to the engine environment from the main process and never crosses the IPC boundary to the renderer

#### Scenario: Credentials are not logged

- **WHEN** an infrastructure operation runs with any credential source
- **THEN** no access key id, secret access key, or session token appears in the streamed output, the persisted run log, or application logs

### Requirement: Stale backend lock recovery

The self-managed backend serializes updates with lock objects it writes into the state bucket, and those locks have no server-side expiry — a run killed by a crash, a force-quit, or a machine losing power leaves a lock that blocks every subsequent operation indefinitely. The app SHALL detect this condition, distinguish it from a legitimately concurrent in-app operation, and offer the operator an explicit, clearly-worded recovery action that clears the stale lock. Clearing MUST be operator-initiated and MUST NOT happen automatically, because a lock held by a genuinely running update is load-bearing.

#### Scenario: Stale lock is surfaced, not swallowed

- **WHEN** an operation fails because the backend reports the stack is locked, and no operation is in flight within this app instance
- **THEN** the failure is presented as a stale-lock condition naming the stack, with an explicit recovery action, rather than as a generic engine error

#### Scenario: Recovery is never automatic

- **WHEN** a stale-lock condition is detected
- **THEN** no lock is cleared until the operator explicitly confirms the recovery action

#### Scenario: In-app concurrency is reported as busy, not stale

- **WHEN** an operation is requested while this app instance already holds the workspace
- **THEN** it is refused as busy through the existing conflict path, and the stale-lock recovery action is not offered

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
