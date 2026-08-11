## 1. RunService: lock-clear confirmation gate

- [x] 1.1 Add `RUN_LOCK_CLEAR_CONFIRMATION_TTL_MS` constant to `RunService.ts` (same value as `PulumiService.LOCK_CLEAR_CONFIRMATION_TTL_MS` today, independently defined).
- [x] 1.2 Add a private `pendingLockClearConfirmation` field (`{ token, runId, expiresAt } | null`) to `RunService`.
- [x] 1.3 Implement `mintLockClearConfirmationToken(): string` — reads `getCurrentLock()`, throws if no lock is held, mints a `randomUUID()` token bound to that lock's `runId`, stores it with an expiry, returns the token. Superseding a previous unconsumed mint (mirrors `PulumiService.mintLockClearConfirmationToken`).
- [x] 1.4 Implement `assertFreshLockClearConfirmation(token: string): string` (returns the bound `runId` on success) — synchronous, throws `RunLockClearNotConfirmedError` (Task 2) when the token is missing/wrong/expired, or when the currently held lock's `runId` no longer matches the token's bound `runId`. Consumes (clears) the pending confirmation on success, mirroring `PulumiService.assertFreshLockClearConfirmation`'s synchronous consume-on-success semantics.
- [x] 1.5 Implement `clearLock(token: string): Promise<void>` — calls `assertFreshLockClearConfirmation(token)` to get the bound `runId`, then calls the existing `releaseRun(runId)`.
- [x] 1.6 Unit tests (`RunService.test.ts` or a new `RunService.clearLock.test.ts`, following `PulumiService.clearStaleLock.test.ts`'s case shape): mint without a held lock throws; mint + immediate clear succeeds; clear with no prior mint throws; clear with expired token throws; clear with wrong token throws; clear after a different run has acquired the lock throws and leaves the new run's lock intact; clear when `runs_table_name` isn't configured (DynamoDB skipped) still clears the in-memory lock.

## 2. Error type

- [x] 2.1 Add `RunLockClearNotConfirmedError` to `RunService.ts` itself (not `@hyveon/shared`), following `PulumiService.ts`'s `LockClearNotConfirmedError`/`DestroyNotConfirmedError` shape and TSDoc conventions — this error is not consumed across packages, so it stays with the service that owns the gate it guards, matching `LockClearNotConfirmedError`'s precedent.
- [x] 2.2 Unit test for the new error class's shape/message (co-located with `RunService.test.ts`).

## 3. IPC controller

- [x] 3.1 Add `IacRunsLockMintAck { token: string }` and `IacRunsLockClearPayload { confirmationToken: string }` / `IacRunsLockClearAck { cleared: boolean; error?: string }` types to `iac-runs.controller.ts` (same names as the preload bridge's mirrored types, task 4.1 — one set across controller, preload, and tests).
- [x] 3.2 Add `@MessagePattern('iac.runs.lock.clear.mintToken')` handler calling `RunService.mintLockClearConfirmationToken()`, returning `{ token }`; surface a clean `BadRequestException`-style error if no lock is currently held.
- [x] 3.3 Add `@MessagePattern('iac.runs.lock.clear')` handler calling `RunService.clearLock(payload.confirmationToken)`, catching `RunLockClearNotConfirmedError` and returning `{ cleared: false, error }` rather than throwing (mirrors `iac.lock.clear`'s ack shape), and logging via `logger.debug`/`logger.warn` per this repo's IPC-handler logging convention.
- [x] 3.4 Controller unit tests (`iac-runs.controller.test.ts`): mint returns a token when a lock is held; mint rejects cleanly when none is held; clear with a valid token resolves `{ cleared: true }` and actually releases the lock; clear with an invalid/stale token resolves `{ cleared: false, error }` without throwing.

## 4. Preload bridge

- [x] 4.1 Add `IacRunsLockMintAck`, `IacRunsLockClearPayload`, `IacRunsLockClearAck` types to `hyveon-api.ts`, mirroring the existing `IacLockClearMintAck`/`IacLockClearPayload`/`IacLockClearAck` naming.
- [x] 4.2 Expose `hyveon.iac.runs.lock.mintToken()` / `hyveon.iac.runs.lock.clear(payload)` in `desktop-preload/src/preload.ts`, invoking the two new IPC channels.
- [x] 4.3 Update preload test doubles / mocks used by web component tests and e2e fixtures to include the new bridge methods (check `test-mocks/` and e2e `fixtures/`/`serverMocks` for where `hyveon.iac.lock.*` is currently stubbed, and add the `runs.lock.*` equivalents alongside).

## 5. Web UI

- [x] 5.1 In `iac.page.tsx`, extend the ack-handling path that currently sets `conflict` (apply/plan/destroy submit handlers) to also track whether the conflict came from a durable `RunLockHeldError` vs. a `PulumiOperationInFlightError` busy refusal (the ack's existing `conflict` value plus an additional flag/field — check whether the controller-side ack already distinguishes these or needs a small ack-shape addition to carry that distinction to the renderer without breaking existing consumers).
- [x] 5.2 Extend `BusyBanner` (or wrap it) to conditionally render a "Clear lock and retry" `Button` + `ConfirmDialog` when the conflict is durable-lock-sourced, following `StaleLockBanner`'s `handleConfirmClear` structure (mint → clear → toast → callback) and cautionary dialog copy adapted for this lock's risk (concurrent applies, not backend corruption specifically).
- [x] 5.3 Wire the new banner variant's `onCleared` callback to return the page to its ready-to-submit state, matching `StaleLockBanner`'s `onCleared` contract.
- [x] 5.4 Component tests (`iac.page.test.tsx`): busy-workspace refusal shows no clear action; durable-lock refusal shows the clear action; confirming and succeeding shows a success toast and returns to ready state; confirming and failing (stale token) shows an inline error and keeps the banner.

## 6. End-to-end coverage

- [x] 6.1 Add a page-object method (e.g. `IacPage.clearRunLockButton()`) alongside the existing `staleLockBanner()` in the e2e page object.
- [x] 6.2 Add an e2e/integration spec exercising: submit while a durable lock is held (via the test IPC mock seam) → clear action appears → confirm → lock cleared → resubmit succeeds.

## 7. Documentation

- [x] 7.1 Update `docs/docs/components/management-app.md` (or wherever the existing Pulumi-lock-clear flow is documented, if it is) to describe the new run-lock recovery action — check first whether the existing clear flow is documented anywhere; if not, note that gap but still document the new one.
- [x] 7.2 Run the `write-docs` skill (or hand-verify) to confirm no other docs page references "the only way to clear a stuck lock is to wait" or similar stale claims.

## 8. Gate

- [x] 8.1 `npm run app:lint` clean.
- [x] 8.2 `npm run app:typecheck` clean.
- [x] 8.3 `npm run app:test` full unit suite green.
- [x] 8.4 `npm run app:test:integration` green (controllers changed).
- [x] 8.5 `npm run app:test:e2e` green (renderer/preload/IPC surface changed).
