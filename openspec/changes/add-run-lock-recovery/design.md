## Context

`RunService` (`app/packages/desktop-main/src/services/RunService.ts`) owns the durable apply lock (issue #106): an in-memory `RunLock` field plus a mirrored DynamoDB item, guarding submission-level exclusivity across plan/apply/destroy. It is distinct from `PulumiService.operationInFlight` (an in-process flag guarding the shared local Pulumi Automation API workspace) and from the Pulumi backend lock (Pulumi's own S3-state-backend lock, already recoverable via `PulumiService.clearStaleLock`, `iac.lock.clear.*` IPC, and the `StaleLockBanner` UI).

`RunService`'s lock only self-heals via `DEFAULT_LOCK_TTL_MS` (1 hour, checked by `isRunLockExpired`). An operator who hits `RunLockHeldError` today sees the BUSY banner (`iac.page.tsx`'s `BusyBanner`, driven by `ack.conflict`) with no recourse. This was confirmed live: an apply's `RunLockHeldError` rejection rendered as both the amber BUSY banner and a raw red error box (one rejection, two renderings — not two independently stuck locks), and `operationInFlight` was not also stuck. The fix is scoped entirely to `RunService`.

## Goals / Non-Goals

**Goals:**
- Give operators an in-app way to clear a wedged `RunLock` without waiting out the TTL or touching AWS directly.
- Mirror the existing Pulumi-lock mint/confirm/clear pattern exactly, so the UX and safety model are already familiar and reviewed.
- Fail safe: never release a *different* run's lock than the one the operator was shown.

**Non-Goals:**
- Root-causing why a `RunLock` outlives its holder (likely an abandoned async generator whose `finally` cleanup never runs because nothing drives it to `.return()`/completion). This is a recovery path, not a leak fix.
- A proactive lock-status read channel (e.g., showing a stuck lock on page load before any submission). Discovery stays reactive, matching the existing Pulumi-lock UX.
- Any change to `PulumiOperationInFlightError` handling — that flag means the current process is genuinely busy; there is nothing to clear.

## Decisions

### D1: Reactive discovery only

- **Choice**: The clear action only appears after a plan/apply/destroy submission is rejected with `RunLockHeldError` — no new status-read IPC channel.
- **Rationale**: Matches the existing Pulumi-lock `StaleLockBanner` pattern exactly (also reactive-only), keeping the UX model consistent across both lock types and minimizing new surface area.
- **Alternatives considered**: A proactive `iac.runs.lockStatus` read channel so the busy state is visible on page load. More useful (no need to trigger a doomed submission first) but adds a new channel/behavior not mirrored by precedent; deferred.

### D2: Independent TTL constant

- **Choice**: `RunService` gets its own `RUN_LOCK_CLEAR_CONFIRMATION_TTL_MS`, initially equal to `PulumiService`'s `LOCK_CLEAR_CONFIRMATION_TTL_MS`.
- **Rationale**: The two locks are conceptually distinct (durable submission-level lock vs. Pulumi backend state lock) and only coincidentally share a value today; a shared constant would couple their tuning for no real reason.
- **Alternatives considered**: Importing and reusing `PulumiService`'s constant directly. Slightly less duplication, but couples `RunService`'s confirmation window to a constant owned by a different service for a different lock.

### D3: Token bound to the specific `runId`, not just "the lock"

- **Choice**: `mintLockClearConfirmationToken()` captures the `runId` of the lock current at mint time. `clearLock(token)` validates the token is fresh, unconsumed, and still bound to that *same* `runId` before delegating to the existing `releaseRun(runId)`.
- **Rationale**: Between mint (when the operator sees the stuck lock and opens the confirm dialog) and clear (when they confirm), the original run could finish and a new, legitimate run could acquire the lock. Binding to `runId` means a stale token can never release a *different* run's lock — it simply fails, requiring a fresh mint against whatever is current. Mirrors `PulumiPendingDestroyConfirmation`/`PulumiPendingLockClearConfirmation`'s target-binding design (bound to stateBucket+region+stackName there; bound to `runId` here, the equivalent "what this token authorizes clearing" concept).
- **Alternatives considered**: Binding only to "a lock exists" with no identity check. Simpler, but reintroduces the exact class of bug the Pulumi-lock design already rejected: a delayed confirm could clear a run that has nothing to do with what the operator actually saw and approved.

### D4: No new lock-release logic — gate the existing `releaseRun`

- **Choice**: `clearLock(token)` is purely a confirmation gate; the actual release reuses `RunService.releaseRun(runId)` unchanged (clears in-memory lock, releases the DynamoDB item, degrades gracefully to TTL self-heal on a transient DynamoDB failure — all existing, tested behavior).
- **Rationale**: The release mechanism already exists and is correct; the only missing piece is operator-triggered, confirmed access to it. Reusing it avoids duplicating release semantics.
- **Alternatives considered**: None seriously considered — writing a parallel release path would duplicate `releaseRun`'s DynamoDB-failure handling for no benefit.

### D5: UI surfaces the action only for `RunLockHeldError`-sourced conflicts

- **Choice**: `BusyBanner` gains the "Clear lock and retry" action + `ConfirmDialog` only when the busy ack's `conflict` originated from a `RunLockHeldError`, not from `PulumiOperationInFlightError`.
- **Rationale**: Only the former has anything clearable from this process. Showing a clear action for a busy-workspace refusal (this process's own in-flight operation) would be misleading — there is no lock to clear, the operation is simply running.
- **Alternatives considered**: Showing the action for both and letting `clearLock` itself reject with a clear error for the `operationInFlight` case. Rejected: it invites an operator to attempt a no-op action the UI could simply not offer.

## Risks / Trade-offs

- **[Risk]** Clearing a lock that is, in fact, still backing a genuinely active run in a *different* process (not this one) allows a second, concurrent apply/destroy to start, risking state corruption. → **Mitigation**: identical to the existing Pulumi-lock flow — a `ConfirmDialog` with explicit cautionary copy naming the lock holder/kind/age, requiring the operator to affirmatively confirm they don't recognize it as active. Not eliminated (impossible to know for certain in-app), but consistent with the already-accepted risk posture of the precedent this mirrors.
- **[Trade-off]** Reactive-only discovery (D1) means an operator with a wedged lock and no failed submission yet (e.g., they haven't tried to plan/apply since the crash) won't see any indication anything is wrong until they try. → Accepted: matches existing precedent; a proactive status channel can be added later as a separate, additive change if this proves insufficient in practice.

## Migration Plan

N/A — this change involves no deployment changes (no new AWS resources, no DynamoDB schema change, no Pulumi stack outputs). Purely additive application code: new service methods, new IPC channels, new preload bridge methods, new UI action. No existing IPC channel's request/response shape changes.

## Open Questions

None outstanding — all forks were resolved during brainstorming (see `brainstorm.md`).
