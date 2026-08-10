## ADDED Requirements

### Requirement: Operator recovery from a stuck durable run lock

When a plan, apply, or destroy submission is refused with `{ started: false, conflict }` because the durable apply lock (`RunService`'s `RunLock`) is held by another run, the BUSY banner SHALL offer a "Clear lock and retry" action gated behind an explicit confirmation dialog. Confirming SHALL mint a fresh, single-use, run-id-bound confirmation token via `hyveon.iac.runs.lock.mintToken()` and pass it to `hyveon.iac.runs.lock.clear({ confirmationToken })`; a token bound to a `runId` that no longer matches the currently held lock (a different run has since acquired it) MUST be refused rather than releasing that different run's lock. The action MUST NOT be offered when the busy refusal instead came from `PulumiOperationInFlightError` (the current process's own in-flight operation) — there is nothing to clear in that case. Clearing the lock MUST NOT automatically resubmit the original operation; the operator retries manually.

#### Scenario: Operator clears a stuck run lock and retries

- **WHEN** a plan/apply/destroy submission is refused with a durable-lock conflict, and the operator confirms "Clear lock and retry" in the dialog
- **THEN** the page mints a confirmation token, calls the clear IPC channel with it, shows a success toast on `{ cleared: true }`, and returns to the ready-to-submit state so the operator can resubmit manually

#### Scenario: Stale confirmation token is refused safely

- **WHEN** the operator confirms clearing a lock, but by the time the clear call reaches `RunService` a different run has already acquired the lock (the original run finished or expired and a new one started)
- **THEN** the clear call fails, the newly-acquired run's lock is left intact, and the page surfaces the failure inline without clearing the banner

#### Scenario: No clear action for a busy-workspace refusal

- **WHEN** a plan/apply/destroy submission is refused because this process's own operation is currently in flight (`PulumiOperationInFlightError`), not because the durable run lock is held elsewhere
- **THEN** the BUSY banner is shown with no "Clear lock and retry" action
