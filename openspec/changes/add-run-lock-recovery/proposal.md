## Why

An infra apply got stuck live with "Run lock already held by chris" and no way to clear it short of manually deleting a DynamoDB item via the AWS CLI and restarting the desktop app. `RunService`'s durable apply lock (issue #106) only self-heals via a 1-hour TTL and has no operator override anywhere — no service method, IPC channel, preload exposure, or UI action — unlike the separate Pulumi backend lock, which already has a full mint/confirm/clear flow. A crashed or abandoned run (most likely an async generator whose cleanup never ran) wedges the workspace for up to an hour with no recourse.

## What Changes

**RunLock recovery**
- From: a stuck `RunLock` can only be cleared by waiting out its TTL or manually deleting the DynamoDB item outside the app.
- To: the BUSY banner shown for a `RunLockHeldError` rejection gains a "Clear lock and retry" action, gated behind a confirmation dialog and a single-use, run-id-bound confirmation token — mirroring the existing Pulumi-backend-lock clear flow exactly.
- Reason: operators need an in-app recovery path for the lock they actually hit; today's only lock-clear flow covers a different lock (the Pulumi backend lock) that wasn't the one stuck.
- Impact: non-breaking addition. New `RunService` methods, new IPC channels, new preload surface, new UI action. No existing behavior changes for the busy-workspace (`PulumiOperationInFlightError`) case, which still shows the BUSY banner with no clear action (there's nothing to clear — that flag means *this* process is genuinely busy right now).

## Capabilities

### New Capabilities

(none — this extends an existing capability's requirements rather than introducing a new one)

### Modified Capabilities

- `iac-plan-apply-page`: the "Apply refused while the lock is held" scenario gains an operator recovery action when the refusal is a durable `RunLockHeldError` (not a `PulumiOperationInFlightError` busy refusal).

## Impact

- `app/packages/desktop-main/src/services/RunService.ts` — new `mintLockClearConfirmationToken()` / `clearLock(token)` methods.
- `app/packages/desktop-main/src/controllers/iac-runs.controller.ts` — new `iac.runs.lock.clear.mintToken` / `iac.runs.lock.clear` `@MessagePattern`s.
- `app/packages/desktop-preload/` — new `hyveon.iac.runs.lock.mintToken()` / `.clear({ confirmationToken })` bridge methods and types.
- `app/packages/web/src/pages/iac.page.tsx` — `BusyBanner` gains a conditional "Clear lock and retry" action + `ConfirmDialog` for the `RunLockHeldError` case.
- Tests: `RunService`, `IacRunsController`, and `iac.page.tsx` component tests, plus e2e page-object coverage for the new banner action.
