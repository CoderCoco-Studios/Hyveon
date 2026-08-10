# Run Lock Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an operator clear a wedged `RunService` durable apply lock from the UI, mirroring the existing Pulumi-backend-lock clear flow.

**Architecture:** `RunService` gains a mint/confirm/clear gate (`mintLockClearConfirmationToken()` / `clearLock(token)`) that wraps its existing `releaseRun()`, bound to the specific `runId` current at mint time. New IPC channels on `IacRunsController` expose it; `IacController`'s existing `RunLockHeldError` catch branches (in `apply`/`destroy` — `plan`/`preview` never acquires the durable `RunLock`, so it can never throw `RunLockHeldError` and has no such branch) additionally attach the held lock to the ack so the renderer can offer a "Clear lock and retry" action on `BusyBanner`, distinct from the no-action case where the busy refusal was `PulumiOperationInFlightError` instead.

**Tech Stack:** NestJS (`@MessagePattern`), Electron IPC (`ipcMain`/`ipcRenderer` via preload), React (`iac.page.tsx`), Vitest, Playwright.

## Global Constraints

- Every `@MessagePattern` handler logs `logger.debug('<Controller>: <pattern> invoked')` as its first statement (`.claude/rules/logging.md`).
- No raw SDK/Node error escapes a service method uncaught — catch, log, return a modeled result (`.claude/rules/logging.md`).
- TSDoc only, no ad hoc JSDoc; `@param name - description` hyphen form (`.claude/rules/tsdoc-tags.md`).
- Test names read as `it('should ...')` sentences (`CLAUDE.md`).
- No `as unknown as T` in tests; `vi.mocked(fn)` / `Partial<T> + as T` (`CLAUDE.md`).
- Run `npm run app:lint && npm run app:typecheck` after each task, not just at the end.

---

## Task 1: `RunLockClearNotConfirmedError` in `RunService.ts`

**Files:**
- Modify: `app/packages/desktop-main/src/services/RunService.ts`
- Test: `app/packages/desktop-main/src/services/RunService.test.ts`

**Interfaces:**
- Produces: `export class RunLockClearNotConfirmedError extends Error` (no constructor args — mirrors `LockClearNotConfirmedError`'s zero-arg shape in `PulumiService.ts:5828`).

Placed in `RunService.ts` itself, not `@hyveon/shared`, matching `LockClearNotConfirmedError`'s precedent (it lives in `PulumiService.ts`, the service that owns the gate it guards, not in shared — only errors consumed *across* packages, like `RunLockHeldError`, live in `@hyveon/shared`).

- [ ] **Step 1: Write the failing test**

Add to `RunService.test.ts`:

```typescript
import { RunLockClearNotConfirmedError } from './RunService.js';

describe('RunLockClearNotConfirmedError', () => {
  it('should carry a descriptive message naming the required mint/clear sequence', () => {
    const err = new RunLockClearNotConfirmedError();
    expect(err.name).toBe('RunLockClearNotConfirmedError');
    expect(err.message).toMatch(/mintLockClearConfirmationToken/);
    expect(err.message).toMatch(/clearLock/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run app:test -- RunService.test.ts -t "RunLockClearNotConfirmedError"`
Expected: FAIL — `RunLockClearNotConfirmedError` is not exported from `./RunService.js`.

- [ ] **Step 3: Write minimal implementation**

Add to `RunService.ts`, above the `RunService` class:

```typescript
/**
 * Thrown by `RunService.clearLock` when it's called without a fresh, valid
 * confirmation token — mirrors `PulumiService`'s `LockClearNotConfirmedError`
 * exactly, for this lock's own clear-confirmation gate.
 */
export class RunLockClearNotConfirmedError extends Error {
  constructor() {
    super(
      'run lock clear refused: no fresh confirmation token was supplied, it has expired, or it no longer ' +
        'matches the currently held lock. Call RunService.mintLockClearConfirmationToken() and pass the ' +
        'returned token to clearLock() before it expires.',
    );
    this.name = 'RunLockClearNotConfirmedError';
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run app:test -- RunService.test.ts -t "RunLockClearNotConfirmedError"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add app/packages/desktop-main/src/services/RunService.ts app/packages/desktop-main/src/services/RunService.test.ts
git commit -m "feat(desktop-main): add RunLockClearNotConfirmedError"
```

---

## Task 2: `RunService.mintLockClearConfirmationToken()`

**Files:**
- Modify: `app/packages/desktop-main/src/services/RunService.ts`
- Test: `app/packages/desktop-main/src/services/RunService.test.ts`

**Interfaces:**
- Consumes: `RunService.getCurrentLock(): RunLock | undefined` (existing, `RunService.ts:145`, in-memory only) and `RunRecordStore.getRunLock(): Promise<RunLock | undefined>` (existing, `@hyveon/shared`, durable DynamoDB read) as a fallback.
- Produces: `RunService.mintLockClearConfirmationToken(): Promise<string>`.

`getCurrentLock()` only reflects *this process's* in-memory field. When `createRun()` loses the DynamoDB race to another process, it rolls its own provisional in-memory lock back to `null` — so after that rejection, this process's `getCurrentLock()` returns `undefined` even though a lock genuinely is still held (durably, by the winner). The same gap applies across an app restart. Since the operator's "Clear lock and retry" click happens as a separate IPC round-trip well after the original `RunLockHeldError` was thrown (not by re-invoking `createRun()`), minting must be able to discover that durable lock itself — it cannot rely on this process's in-memory field alone. `mintLockClearConfirmationToken()` is therefore `async`: fall back to `this.store.getRunLock()` (skipped, like `createRun()`, when `runs_table_name` isn't configured) whenever `getCurrentLock()` returns `undefined`.

The test cases below reference `getRunLockMock`, the mock for `RunRecordStore.getRunLock()` — add it to `RunService.test.ts`'s existing store-mock harness alongside `releaseRunLockMock`/`acquireRunLockMock`, defaulted to `mockResolvedValue(undefined)`.

- [ ] **Step 1: Write the failing test**

```typescript
describe('RunService.mintLockClearConfirmationToken', () => {
  it('should throw when no lock is currently held, in-memory or durable', async () => {
    const service = makeService();
    getRunLockMock.mockResolvedValue(undefined);
    await expect(service.mintLockClearConfirmationToken()).rejects.toThrow(
      /no run lock is currently held/i,
    );
  });

  it('should mint a token when a lock is held in-memory', async () => {
    const service = makeService();
    await service.createRun('apply', 'chris');
    const token = await service.mintLockClearConfirmationToken();
    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThan(0);
  });

  it('should mint a token bound to the durable lock when this process has no in-memory lock (cross-process/restart recovery)', async () => {
    const service = makeService(); // fresh instance: currentLock is null
    const durableLock: RunLock = {
      runId: 'other-process-run-id',
      kind: 'apply',
      initiator: 'someone-else',
      acquiredAt: '2026-08-10T03:52:26.761Z',
      expiresAt: '2026-08-10T04:52:26.761Z',
    };
    getRunLockMock.mockResolvedValue(durableLock);
    const token = await service.mintLockClearConfirmationToken();
    expect(typeof token).toBe('string');
    // bound to the durable lock's runId, not this process's (empty) in-memory state
    await expect(service.clearLock(token)).resolves.toBeUndefined();
    expect(releaseRunLockMock).toHaveBeenCalledWith(durableLock.runId);
  });

  it('should supersede a previously minted, unconsumed token', async () => {
    const service = makeService();
    await service.createRun('apply', 'chris');
    const first = await service.mintLockClearConfirmationToken();
    const second = await service.mintLockClearConfirmationToken();
    expect(first).not.toBe(second);
    await expect(service.clearLock(first)).rejects.toThrow(RunLockClearNotConfirmedError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run app:test -- RunService.test.ts -t "mintLockClearConfirmationToken"`
Expected: FAIL — `mintLockClearConfirmationToken is not a function`.

- [ ] **Step 3: Write minimal implementation**

Add a private field and constant near `DEFAULT_LOCK_TTL_MS`:

```typescript
/**
 * How long a minted lock-clear confirmation token remains valid, in
 * milliseconds, before {@link RunService.assertFreshLockClearConfirmation}
 * treats it as expired — mirrors `PulumiService.LOCK_CLEAR_CONFIRMATION_TTL_MS`'s
 * value, defined independently since the two guard conceptually distinct
 * locks that only coincidentally share a window today.
 */
export const RUN_LOCK_CLEAR_CONFIRMATION_TTL_MS = 5 * 60 * 1000;
```

Inside the `RunService` class, alongside `currentLock`:

```typescript
  /**
   * The most recently minted, not-yet-consumed lock-clear confirmation
   * token, or `null`. Bound to the `runId` that was current at mint time —
   * see {@link mintLockClearConfirmationToken}.
   */
  private pendingLockClearConfirmation: { token: string; runId: string; expiresAt: number } | null = null;
```

And the method itself, after `releaseRun`:

```typescript
  /**
   * Mints a fresh, single-use confirmation token for a subsequent
   * {@link clearLock} call, bound to the `runId` of the lock currently held
   * — mirrors `PulumiService.mintLockClearConfirmationToken`'s mint/confirm
   * pattern, extended with a durable fallback this lock's cross-process
   * nature requires. Minting a new token immediately supersedes any
   * previously minted, unconsumed one.
   *
   * Prefers {@link getCurrentLock} (in-memory, no I/O). Falls back to
   * `RunRecordStore.getRunLock()` (the durable DynamoDB read, skipped when
   * `runs_table_name` isn't configured) when the in-memory field is empty —
   * covering the case where this process lost the lock race to another
   * process (its own provisional in-memory lock was already rolled back by
   * {@link createRun}) or was restarted since the lock was acquired
   * elsewhere. Either way the operator is reacting to a `RunLockHeldError`
   * ack that already told them a lock is held; minting must be able to
   * confirm and bind to it.
   *
   * @returns The minted token.
   * @throws A plain `Error` if no run lock is currently held — in-memory or
   *   durable — nothing to mint a clear-confirmation for.
   */
  async mintLockClearConfirmationToken(): Promise<string> {
    let lock = this.getCurrentLock();
    if (!lock) {
      const tableName = (await this.config.getStackOutputs())?.runsTableName;
      if (tableName) {
        lock = await this.store.getRunLock();
      }
    }
    if (!lock) {
      throw new Error('Cannot mint a lock-clear confirmation token: no run lock is currently held.');
    }
    const token = randomUUID();
    this.pendingLockClearConfirmation = {
      token,
      runId: lock.runId,
      expiresAt: Date.now() + RUN_LOCK_CLEAR_CONFIRMATION_TTL_MS,
    };
    return token;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run app:test -- RunService.test.ts -t "mintLockClearConfirmationToken"`
Expected: The first two cases PASS. The third ("supersede") FAILS — `clearLock` doesn't exist yet; that's expected, it's covered by Task 3. Confirm the first two pass in isolation:

Run: `npm run app:test -- RunService.test.ts -t "should throw when no lock is currently held|should mint a token when a lock is held"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add app/packages/desktop-main/src/services/RunService.ts app/packages/desktop-main/src/services/RunService.test.ts
git commit -m "feat(desktop-main): add RunService.mintLockClearConfirmationToken"
```

---

## Task 3: `RunService.clearLock(token)`

**Files:**
- Modify: `app/packages/desktop-main/src/services/RunService.ts`
- Test: `app/packages/desktop-main/src/services/RunService.test.ts`

**Interfaces:**
- Consumes: `RunLockClearNotConfirmedError` (Task 1), `pendingLockClearConfirmation` field + `mintLockClearConfirmationToken()` (Task 2), existing `releaseRun(runId): Promise<void>`.
- Produces: `RunService.clearLock(token: string): Promise<void>`.

- [ ] **Step 1: Write the failing test**

Complete the test file's coverage for this method (the "supersede" case from Task 2 now becomes assertable too):

```typescript
describe('RunService.clearLock', () => {
  it('should throw RunLockClearNotConfirmedError when no token has ever been minted', async () => {
    const service = makeService();
    await service.createRun('apply', 'chris');
    await expect(service.clearLock('bogus-token')).rejects.toThrow(RunLockClearNotConfirmedError);
  });

  it('should throw RunLockClearNotConfirmedError when the supplied token does not match the most recently minted one', async () => {
    const service = makeService();
    await service.createRun('apply', 'chris');
    await service.mintLockClearConfirmationToken();
    await expect(service.clearLock('wrong-token')).rejects.toThrow(RunLockClearNotConfirmedError);
  });

  it('should throw RunLockClearNotConfirmedError when the minted token has expired', async () => {
    vi.useFakeTimers();
    const service = makeService();
    await service.createRun('apply', 'chris');
    const token = await service.mintLockClearConfirmationToken();
    vi.advanceTimersByTime(RUN_LOCK_CLEAR_CONFIRMATION_TTL_MS + 1);
    await expect(service.clearLock(token)).rejects.toThrow(RunLockClearNotConfirmedError);
    vi.useRealTimers();
  });

  it('should clear the lock and allow a subsequent createRun on a valid, fresh token', async () => {
    const service = makeService();
    const lock = await service.createRun('apply', 'chris');
    const token = await service.mintLockClearConfirmationToken();
    await service.clearLock(token);
    expect(service.getCurrentLock()).toBeUndefined();
    expect(releaseRunLockMock).toHaveBeenCalledWith(lock.runId);
    await expect(service.createRun('apply', 'someone-else')).resolves.toMatchObject({ initiator: 'someone-else' });
  });

  it('should refuse to clear (token no longer bound to the current lock) when a different run has since acquired the lock', async () => {
    const service = makeService();
    await service.createRun('apply', 'chris');
    const token = await service.mintLockClearConfirmationToken();
    await service.releaseRun((service.getCurrentLock()!).runId); // original run finishes on its own
    const newLock = await service.createRun('apply', 'someone-else'); // a new, legitimate run starts
    await expect(service.clearLock(token)).rejects.toThrow(RunLockClearNotConfirmedError);
    expect(service.getCurrentLock()).toMatchObject({ runId: newLock.runId }); // untouched
  });

  it('should consume the token: a second clearLock() call reusing an already-consumed token is rejected', async () => {
    const service = makeService();
    await service.createRun('apply', 'chris');
    const token = await service.mintLockClearConfirmationToken();
    await service.clearLock(token);
    await service.createRun('apply', 'someone-else');
    await expect(service.clearLock(token)).rejects.toThrow(RunLockClearNotConfirmedError);
  });

  it('should clear a durable-only lock (no in-memory lock in this process) on a valid, fresh token', async () => {
    const service = makeService(); // fresh instance: currentLock is null
    const durableLock: RunLock = {
      runId: 'other-process-run-id',
      kind: 'apply',
      initiator: 'someone-else',
      acquiredAt: '2026-08-10T03:52:26.761Z',
      expiresAt: '2026-08-10T04:52:26.761Z',
    };
    getRunLockMock.mockResolvedValue(durableLock);
    const token = await service.mintLockClearConfirmationToken();
    getRunLockMock.mockResolvedValue(durableLock); // still held at confirm time
    await service.clearLock(token);
    expect(releaseRunLockMock).toHaveBeenCalledWith(durableLock.runId);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run app:test -- RunService.test.ts -t "RunService.clearLock"`
Expected: FAIL — `clearLock is not a function`.

- [ ] **Step 3: Write minimal implementation**

Add after `mintLockClearConfirmationToken()`:

```typescript
  /**
   * Throws {@link RunLockClearNotConfirmedError} unless `token` matches the
   * most recently minted, not-yet-expired, not-yet-consumed confirmation
   * token AND the lock it was bound to (by `runId`) is still the one
   * currently held — i.e. no different run has acquired the lock since the
   * token was minted. On success, consumes the token (clears
   * {@link pendingLockClearConfirmation}) and returns the bound `runId`.
   *
   * Unlike `PulumiService.assertFreshLockClearConfirmation` this is `async`:
   * the "still current" check must consult the same durable fallback
   * {@link mintLockClearConfirmationToken} used to bind the token in the
   * first place (see Task 2), or a token minted from a durable-only lock
   * (this process has no matching in-memory field) would always fail here.
   * The two awaits this adds (`getStackOutputs()`, `store.getRunLock()`) are
   * both read-only and idempotent, so no double-release risk is introduced.
   *
   * @param token - The token to validate, as returned by
   *   {@link mintLockClearConfirmationToken}.
   * @returns The `runId` the (now-consumed) token was bound to.
   * @throws {@link RunLockClearNotConfirmedError} if `token` is missing,
   *   wrong, expired, or bound to a `runId` the currently held lock (checked
   *   in-memory, then durably) no longer matches.
   */
  private async assertFreshLockClearConfirmation(token: string): Promise<string> {
    const pending = this.pendingLockClearConfirmation;
    let current = this.getCurrentLock();
    if (!current) {
      const tableName = (await this.config.getStackOutputs())?.runsTableName;
      if (tableName) {
        current = await this.store.getRunLock();
      }
    }
    if (
      !pending ||
      pending.token !== token ||
      Date.now() > pending.expiresAt ||
      !current ||
      current.runId !== pending.runId
    ) {
      throw new RunLockClearNotConfirmedError();
    }
    this.pendingLockClearConfirmation = null;
    return pending.runId;
  }

  /**
   * Clears the run lock currently held, gated behind a fresh confirmation
   * token minted via {@link mintLockClearConfirmationToken} — an operator
   * recovery path for a lock a crashed/abandoned run left standing past what
   * its holder intended, without waiting for {@link DEFAULT_LOCK_TTL_MS} to
   * elapse. Delegates to the existing {@link releaseRun} once the token is
   * validated; introduces no new release semantics.
   *
   * @param token - The confirmation token to validate.
   * @throws {@link RunLockClearNotConfirmedError} if `token` is missing,
   *   wrong, expired, or no longer bound to the currently held lock (a
   *   different run has since acquired it).
   */
  async clearLock(token: string): Promise<void> {
    logger.debug('RunService.clearLock: clearing confirmed-stale run lock');
    const runId = await this.assertFreshLockClearConfirmation(token);
    await this.releaseRun(runId);
    logger.warn('run lock cleared by explicit operator confirmation (unrecognized-lock recovery)', { runId });
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run app:test -- RunService.test.ts`
Expected: PASS (all `RunService` tests, including Task 2's "supersede" case)

- [ ] **Step 5: Commit**

```bash
git add app/packages/desktop-main/src/services/RunService.ts app/packages/desktop-main/src/services/RunService.test.ts
git commit -m "feat(desktop-main): add RunService.clearLock confirmation-gated release"
```

---

## Task 4: `IacRunsController` mint/clear IPC channels

**Files:**
- Modify: `app/packages/desktop-main/src/controllers/iac-runs.controller.ts`
- Test: `app/packages/desktop-main/src/controllers/iac-runs.controller.test.ts`

**Interfaces:**
- Consumes: `RunService.mintLockClearConfirmationToken()`, `RunService.clearLock(token)`, `RunLockClearNotConfirmedError` (Tasks 1-3).
- Produces: `@MessagePattern('iac.runs.lock.clear.mintToken')`, `@MessagePattern('iac.runs.lock.clear')`; exported types `IacRunsLockMintAck { token: string }`, `IacRunsLockClearPayload { confirmationToken: string }`, `IacRunsLockClearAck { cleared: boolean; error?: string }`.

- [ ] **Step 1: Write the failing test**

Add to `iac-runs.controller.test.ts` (check the existing file's setup for how `RunService`/`PulumiService`/`RunRecordService` stubs are constructed and reuse that helper rather than duplicating it):

```typescript
describe('IacRunsController.mintLockClearToken', () => {
  it('should return a token when a run lock is currently held', async () => {
    vi.mocked(runService.getCurrentLock).mockReturnValue(SOME_LOCK);
    vi.mocked(runService.mintLockClearConfirmationToken).mockResolvedValue('tok-123');
    const result = await controller.mintLockClearToken();
    expect(result).toEqual({ token: 'tok-123' });
  });

  it('should throw a clean BadRequestException, not the raw service error, when no lock is held', async () => {
    vi.mocked(runService.mintLockClearConfirmationToken).mockRejectedValue(
      new Error('Cannot mint a lock-clear confirmation token: no run lock is currently held.'),
    );
    await expect(controller.mintLockClearToken()).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('IacRunsController.clearLock', () => {
  it('should resolve { cleared: true } on a valid token', async () => {
    vi.mocked(runService.clearLock).mockResolvedValue(undefined);
    const result = await controller.clearLock({ confirmationToken: 'tok-123' });
    expect(result).toEqual({ cleared: true });
    expect(runService.clearLock).toHaveBeenCalledWith('tok-123');
  });

  it('should resolve { cleared: false, error } (not throw) on RunLockClearNotConfirmedError', async () => {
    vi.mocked(runService.clearLock).mockRejectedValue(new RunLockClearNotConfirmedError());
    const result = await controller.clearLock({ confirmationToken: 'stale' });
    expect(result.cleared).toBe(false);
    expect(result.error).toMatch(/mintLockClearConfirmationToken/);
  });

  it('should throw BadRequestException when confirmationToken is missing or empty', async () => {
    await expect(controller.clearLock({ confirmationToken: '' } as never)).rejects.toBeInstanceOf(BadRequestException);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run app:test -- iac-runs.controller.test.ts -t "mintLockClearToken|clearLock"`
Expected: FAIL — `controller.mintLockClearToken is not a function`.

- [ ] **Step 3: Write minimal implementation**

Add imports at the top of `iac-runs.controller.ts`:

```typescript
import { RunLockClearNotConfirmedError } from '../services/RunService.js';
```

Add types near the other payload/ack interfaces:

```typescript
/** Result {@link IacRunsController.mintLockClearToken} resolves with. */
export interface IacRunsLockMintAck {
  token: string;
}

/** Payload accepted by {@link IacRunsController.clearLock}. */
export interface IacRunsLockClearPayload {
  confirmationToken: string;
}

/**
 * Result {@link IacRunsController.clearLock} resolves with. `cleared: false`
 * means nothing was cleared (the token was missing/wrong/expired, or no
 * longer bound to the currently held lock) — `error` describes why. Never
 * throws for an unconfirmed clear; only a malformed payload throws
 * (`BadRequestException`).
 */
export interface IacRunsLockClearAck {
  cleared: boolean;
  error?: string;
}
```

Add methods to the `IacRunsController` class, after `logUrl`:

```typescript
  /**
   * Mints a fresh, single-use confirmation token the renderer must supply
   * back on {@link clearLock}'s payload before it expires — the RunLock
   * analogue of `IacController.mintLockClearToken`, for the durable apply
   * lock (`RunService`) rather than the Pulumi backend lock.
   *
   * `RunService.mintLockClearConfirmationToken()` throws a plain `Error`
   * when no lock is currently held (in-memory or durable) — an expected
   * race (the lock self-healed or was cleared between the busy ack and this
   * call), not a server fault. Caught here and reported as a clean
   * `BadRequestException` so the renderer never sees an unmodeled IPC
   * rejection for it.
   *
   * @throws `BadRequestException` when no run lock is currently held.
   *
   * Reachable via the Electron IPC transport (`iac.runs.lock.clear.mintToken`).
   */
  @MessagePattern('iac.runs.lock.clear.mintToken')
  async mintLockClearToken(): Promise<IacRunsLockMintAck> {
    logger.debug('IacRunsController: iac.runs.lock.clear.mintToken invoked');
    try {
      const token = await this.runService.mintLockClearConfirmationToken();
      return { token };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn('iac.runs.lock.clear.mintToken rejected: no run lock currently held', { error: message });
      throw new BadRequestException({ success: false, error: message });
    }
  }

  /**
   * Clears the current run lock by invoking `RunService.clearLock()`,
   * gated behind `payload.confirmationToken` (minted via
   * {@link mintLockClearToken}) — mirrors `IacController.clearStaleLock`'s
   * ack shape: a rejected/unconfirmed clear resolves `{ cleared: false,
   * error }` rather than throwing, so the renderer never sees an unhandled
   * IPC rejection for the expected "token stale" case.
   *
   * @throws `BadRequestException` when `payload.confirmationToken` isn't a
   *   non-empty string.
   *
   * Reachable via the Electron IPC transport (`iac.runs.lock.clear`).
   */
  @MessagePattern('iac.runs.lock.clear')
  async clearLock(@Payload() payload: IacRunsLockClearPayload): Promise<IacRunsLockClearAck> {
    logger.debug('IacRunsController: iac.runs.lock.clear invoked');
    const token = payload?.confirmationToken;
    if (typeof token !== 'string' || token.length === 0) {
      throw new BadRequestException({
        success: false,
        error: 'iac.runs.lock.clear requires a non-empty confirmationToken string',
      });
    }
    try {
      await this.runService.clearLock(token);
      return { cleared: true };
    } catch (err) {
      if (err instanceof RunLockClearNotConfirmedError) {
        logger.warn('iac.runs.lock.clear rejected: confirmation not fresh', { error: err.message });
        return { cleared: false, error: err.message };
      }
      logger.error('iac.runs.lock.clear error', { err });
      const error = err instanceof Error ? err.message : String(err);
      return { cleared: false, error };
    }
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run app:test -- iac-runs.controller.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add app/packages/desktop-main/src/controllers/iac-runs.controller.ts app/packages/desktop-main/src/controllers/iac-runs.controller.test.ts
git commit -m "feat(desktop-main): add iac.runs.lock.clear IPC channels"
```

---

## Task 5: attach the held lock to `RunLockHeldError` acks in `IacController`

**Files:**
- Modify: `app/packages/desktop-main/src/controllers/iac.controller.ts`
- Test: `app/packages/desktop-main/src/controllers/iac.controller.test.ts` (or the specific `.plan.test.ts`/`.apply.test.ts`/`.destroy.test.ts` split file this repo uses — check which file currently covers the `RunLockHeldError` catch branches at lines ~993 and ~1190 and add cases there)

**Interfaces:**
- Consumes: `RunLockHeldError.lock: RunLock` (existing, `@hyveon/shared`).
- Produces: `IacPlanAck.runLock?: RunLock` (new field, populated on both call sites that already catch `RunLockHeldError`: `apply`, `destroy`. `plan`/`preview` never acquires the durable `RunLock` — see `PulumiService.preview`'s own TSDoc, which states its busy-workspace refusal uses a generic `Error`, not `RunLockHeldError` — so it has no such branch and is untouched by this task).

This is the piece that lets the renderer distinguish "conflict came from the durable RunLock" (clearable) from "conflict came from the in-process workspace busy flag" (not clearable) — today `conflict` alone can't tell the two apart (both populate the same field with an operation-name string).

- [ ] **Step 1: Write the failing test**

Add (adapting to whichever existing test file covers `apply`'s `RunLockHeldError` branch — follow its existing mock-setup style for `RunService.createRun` rejecting):

```typescript
it('should attach the held lock as runLock on the ack when apply is refused with RunLockHeldError', async () => {
  const heldLock: RunLock = {
    runId: 'other-run-id',
    kind: 'apply',
    initiator: 'someone-else',
    acquiredAt: '2026-08-10T03:52:26.761Z',
    expiresAt: '2026-08-10T04:52:26.761Z',
  };
  // stub whatever this file's existing harness uses to make PulumiService.apply's
  // generator reject its first `.next()` with a RunLockHeldError — mirror the
  // existing "should set conflict: 'up' on RunLockHeldError" test's setup exactly,
  // just add the assertion below.
  const ack = await controller.apply({ planRunId: 'x', planHash: 'y' }, ctx);
  expect(ack.runLock).toEqual(heldLock);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run app:test -- iac.controller -t "runLock"`
Expected: FAIL — `ack.runLock` is `undefined`.

- [ ] **Step 3: Write minimal implementation**

Add the type import at the top of `iac.controller.ts`:

```typescript
import type { DeploymentConfigDiff, RunLock, StackOutputs } from '@hyveon/shared';
```

Add the field to `IacPlanAck` (the shared ack type `plan`/`apply`/`destroy` all return):

```typescript
interface IacPlanAck {
  started: boolean;
  runId?: string;
  error?: string;
  conflict?: 'preview' | 'up' | 'destroy' | 'rollback';
  staleLock?: StaleLockInfo;
  /**
   * The durable apply lock currently held by another run, present only when
   * the rejection was `RunLockHeldError` (as opposed to a
   * `PulumiOperationInFlightError` busy refusal, which populates `conflict`
   * identically but has no lock to attach — that flag means *this* process
   * is busy right now). Lets the renderer offer a "Clear lock and retry"
   * action only for the genuinely clearable case.
   */
  runLock?: RunLock;
}
```

Update each of the two `if (err instanceof RunLockHeldError)` branches (in `apply`, `destroy`) to attach it — e.g. `apply`'s (line ~993):

```typescript
      if (err instanceof RunLockHeldError) {
        logger.error('apply rejected: apply lock already held', { planRunId: payload.planRunId, lock: err.lock });
        return { started: false, error: err.message, conflict: 'up', runLock: err.lock };
      }
```

Repeat identically for `destroy`'s branch (`conflict: 'destroy'`). `plan` has no equivalent branch — it never acquires the durable `RunLock`, so its only busy refusal (`conflict: 'preview'`) comes from `PulumiOperationInFlightError`, which never carries a `RunLock` to attach; leave `plan`'s catch block untouched.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run app:test -- iac.controller`
Expected: PASS (full file — confirms no regression in the untouched `PulumiUnrecognizedLockError`/`PulumiOperationInFlightError` branches)

- [ ] **Step 5: Commit**

```bash
git add app/packages/desktop-main/src/controllers/iac.controller.ts app/packages/desktop-main/src/controllers/iac.controller.test.ts
git commit -m "feat(desktop-main): attach held RunLock to plan/apply/destroy acks"
```

---

## Task 6: preload bridge

**Files:**
- Modify: `app/packages/desktop-preload/src/hyveon-api.ts`
- Modify: `app/packages/desktop-preload/src/preload.ts`
- Test: whichever preload test file covers `iac.lock.*` today (search `preload.test.ts` for `'iac.lock.clear.mintToken'` to find it) — add the mirrored cases for `iac.runs.lock.*`

**Interfaces:**
- Consumes: `IacRunsLockMintAck`, `IacRunsLockClearPayload`, `IacRunsLockClearAck` (Task 4) — re-declared here per this codebase's "mirror, don't import across the preload/main boundary" convention (see the existing `IacLockClearAck` etc.).
- Produces: `window.hyveon.iac.runs.lock.mintToken()`, `window.hyveon.iac.runs.lock.clear(payload)`.

- [ ] **Step 1: Write the failing test**

Add to the preload test file, mirroring its existing `iac.lock.clear.mintToken`/`iac.lock.clear` cases:

```typescript
it('should invoke iac.runs.lock.clear.mintToken with no payload', async () => {
  await hyveon.iac.runs.lock.mintToken();
  expect(invokeMock).toHaveBeenCalledWith('iac.runs.lock.clear.mintToken');
});

it('should invoke iac.runs.lock.clear with the confirmation token payload', async () => {
  await hyveon.iac.runs.lock.clear({ confirmationToken: 'tok' });
  expect(invokeMock).toHaveBeenCalledWith('iac.runs.lock.clear', { confirmationToken: 'tok' });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run app:test -- preload -t "iac.runs.lock"`
Expected: FAIL — `hyveon.iac.runs.lock` is `undefined`.

- [ ] **Step 3: Write minimal implementation**

In `hyveon-api.ts`, add types near `IacLockClearAck`/`IacLockClearMintAck`/`IacLockClearPayload`:

```typescript
/** Mirrors `IacRunsLockMintAck` in `@hyveon/desktop-main/src/controllers/iac-runs.controller.ts` — that file is the source of truth. */
export interface IacRunsLockMintAck {
  token: string;
}

/** Mirrors `IacRunsLockClearPayload` in `@hyveon/desktop-main/src/controllers/iac-runs.controller.ts`. */
export interface IacRunsLockClearPayload {
  confirmationToken: string;
}

/** Mirrors `IacRunsLockClearAck` in `@hyveon/desktop-main/src/controllers/iac-runs.controller.ts`. */
export interface IacRunsLockClearAck {
  cleared: boolean;
  error?: string;
}
```

Extend `HyveonIacRunsApi` (after its existing `logUrl`-equivalent members):

```typescript
  /** Durable apply-lock recovery: mint/clear a confirmation token to release a stuck RunLock. Mirrors `HyveonIacLockApi`. */
  lock: {
    mintToken: () => Promise<IacRunsLockMintAck>;
    clear: (payload: IacRunsLockClearPayload) => Promise<IacRunsLockClearAck>;
  };
```

In `preload.ts`, extend the `iac.runs` object (next to `logUrl`):

```typescript
      lock: {
        mintToken: () => invoke<IacRunsLockMintAck>('iac.runs.lock.clear.mintToken'),
        clear: (payload: IacRunsLockClearPayload) => invoke<IacRunsLockClearAck>('iac.runs.lock.clear', payload),
      },
```

Add the two new types to `preload.ts`'s existing import from `./hyveon-api.js`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run app:test -- preload`
Expected: PASS

- [ ] **Step 5: Update the IPC mock seam**

Search `app/packages/web` and `app/packages/desktop-main` test-mock/fixture directories for every place `window.hyveon.iac.lock` (the Pulumi-lock bridge) is currently stubbed for tests — likely `app/packages/web/src/test-utils/` (component tests) and `app/packages/web/e2e/fixtures/` (e2e `window.hyveon.__test.mock()` surface, per `docs/docs/components/integration-tests.md`). Add `iac.runs.lock.mintToken`/`iac.runs.lock.clear` stubs alongside each `iac.lock.mintToken`/`iac.lock.clear` stub found, returning sensible defaults (`{ token: 'test-token' }` / `{ cleared: true }`) so existing tests that don't care about this feature don't start failing on an undefined bridge method.

Run: `npm run app:test` (full unit suite) to confirm nothing broke from the mock-seam change.
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add app/packages/desktop-preload/src/hyveon-api.ts app/packages/desktop-preload/src/preload.ts
git commit -m "feat(desktop-preload): expose iac.runs.lock mint/clear bridge"
```

---

## Task 7: `BusyBanner` clear action in `iac.page.tsx`

**Files:**
- Modify: `app/packages/web/src/pages/iac.page.tsx`
- Test: `app/packages/web/src/pages/iac.page.test.tsx`

**Interfaces:**
- Consumes: `window.hyveon.iac.runs.lock.mintToken()` / `.clear(payload)` (Task 6), the ack's new `runLock?: RunLock` field (Task 5) — the submit-handler code path that currently reads `ack.conflict`/`ack.staleLock` needs to also read `ack.runLock` and store it in whatever local state currently holds `conflict`/`staleLock` (check the existing `useState` shape near where `BusyBanner`/`StaleLockBanner` are rendered).
- Produces: a new prop on `BusyBanner` (e.g. `runLock?: RunLock`) and an inline confirm-clear affordance when it's set.

- [ ] **Step 1: Write the failing test**

Add to `iac.page.test.tsx`, following whichever existing test exercises `StaleLockBanner`'s clear flow (`hyveon.iac.lock.mintToken`/`.clear` mocked, confirm dialog opened, success toast asserted) as the template:

```typescript
it('should show no clear action on BusyBanner when the busy ack has no runLock (workspace busy, not a durable lock)', async () => {
  // plan/preview never acquires the durable RunLock, so its only busy refusal is
  // PulumiOperationInFlightError — always conflict: 'preview', never a runLock.
  mockPlan.mockResolvedValue({ started: false, conflict: 'preview', error: 'preview is already in flight' });
  render(<IacPage />);
  await userEvent.click(screen.getByRole('button', { name: /plan/i }));
  expect(await screen.findByRole('alert')).toHaveTextContent(/workspace busy/i);
  expect(screen.queryByRole('button', { name: /clear lock and retry/i })).not.toBeInTheDocument();
});

it('should show a clear action on BusyBanner when the busy ack carries runLock, clear it on confirm, and return to ready state for manual resubmission', async () => {
  // Only apply/destroy can be refused with a durable RunLockHeldError (and thus
  // carry runLock) — plan/preview structurally cannot, see the test above.
  const heldLock = { runId: 'r1', kind: 'apply', initiator: 'chris', acquiredAt: '...', expiresAt: '...' };
  mockApply.mockResolvedValueOnce({ started: false, conflict: 'up', error: 'Run lock already held by "chris"', runLock: heldLock });
  mockApply.mockResolvedValueOnce({ started: true, runId: 'new-run-id' });
  window.hyveon!.iac.runs.lock.mintToken = vi.fn().mockResolvedValue({ token: 'tok' });
  window.hyveon!.iac.runs.lock.clear = vi.fn().mockResolvedValue({ cleared: true });

  render(<IacPage />);
  await userEvent.click(screen.getByRole('button', { name: /apply/i }));
  expect(await screen.findByRole('alert')).toHaveTextContent(/run lock already held/i); // original ErrorBanner
  await userEvent.click(await screen.findByRole('button', { name: /clear lock and retry/i }));
  await userEvent.click(screen.getByRole('button', { name: /^clear lock$/i })); // confirm dialog

  expect(window.hyveon!.iac.runs.lock.clear).toHaveBeenCalledWith({ confirmationToken: 'tok' });
  expect(await screen.findByText(/run lock cleared/i)).toBeInTheDocument(); // toast
  // returns to ready state: both the BUSY banner and the original ErrorBanner are gone
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /clear lock and retry/i })).not.toBeInTheDocument();

  // clearing does not auto-resubmit; the operator retries manually
  expect(mockApply).toHaveBeenCalledTimes(1);
  await userEvent.click(screen.getByRole('button', { name: /apply/i }));
  expect(mockApply).toHaveBeenCalledTimes(2);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run app:test -- iac.page.test.tsx -t "clear action"`
Expected: FAIL — no "Clear lock and retry" button rendered.

- [ ] **Step 3: Write minimal implementation**

Extend `BusyBanner`'s props and body in `iac.page.tsx`:

```typescript
function BusyBanner({ conflict, runLock, onCleared }: { conflict: Conflict; runLock?: RunLock; onCleared: () => void }) {
  const label = CONFLICT_LABELS[conflict];
  const article = /^[aeiou]/i.test(label) ? 'an' : 'a';
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [clearError, setClearError] = useState<string | null>(null);

  function handleConfirmClear() {
    if (!window.hyveon) {
      setClearError('IPC bridge (window.hyveon) is not available in this context.');
      return;
    }
    setClearing(true);
    setClearError(null);
    void (async () => {
      try {
        const { token } = await window.hyveon!.iac.runs.lock.mintToken();
        const ack = await window.hyveon!.iac.runs.lock.clear({ confirmationToken: token });
        if (ack.cleared) {
          setConfirmOpen(false);
          toast.success('Run lock cleared — resubmit to retry.');
          onCleared();
        } else {
          setClearError(ack.error ?? 'Could not clear the run lock.');
        }
      } catch (err) {
        setClearError(err instanceof Error ? err.message : String(err));
      } finally {
        setClearing(false);
      }
    })();
  }

  return (
    <div role="alert" className="flex flex-col gap-2 rounded-[var(--radius-sm)] border border-[var(--color-amber)]/40 bg-[var(--color-amber)]/10 px-3 py-2 text-sm text-[var(--color-amber)]">
      <p>
        Workspace busy — {article} <code className="font-[var(--font-mono)]">{label}</code> run
        is already in progress. Try again once it finishes.
      </p>
      {runLock && (
        <>
          <Button onClick={() => setConfirmOpen(true)} variant="secondary" size="sm" className="self-start" disabled={clearing}>
            {clearing ? <Loader2 className="animate-spin" /> : null}
            Clear lock and retry
          </Button>
          {clearError && <ErrorBanner message={clearError} />}
          <ConfirmDialog
            open={confirmOpen}
            onOpenChange={setConfirmOpen}
            title="Clear this run lock?"
            description={
              `This releases the durable apply lock held by "${runLock.initiator}" (${runLock.kind}, ` +
              `started ${formatLockAge(runLock.acquiredAt, Date.now())}). Only confirm if you are CONFIDENT ` +
              "this is not a real, currently-running plan/apply/destroy elsewhere — clearing a genuinely " +
              "active run's lock lets two Pulumi updates run concurrently, which can corrupt the deployed " +
              'infrastructure state. This does not retry your operation for you; resubmit it manually once ' +
              'the lock is cleared.'
            }
            onConfirm={handleConfirmClear}
            confirmLabel={clearing ? 'Clearing…' : 'Clear lock'}
          />
        </>
      )}
    </div>
  );
}
```

Update every call site that renders `<BusyBanner conflict={...} />` to also pass `runLock={ack.runLock}` and `onCleared={() => /* clear conflict, runLock, AND the original ack's error/ErrorBanner state, matching StaleLockBanner's onCleared usage — returning the page fully to its ready-to-submit state, not just dismissing BusyBanner */}`, and update the local state that currently stores `conflict`/`staleLock` from a rejected ack to also store `runLock`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run app:test -- iac.page.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add app/packages/web/src/pages/iac.page.tsx app/packages/web/src/pages/iac.page.test.tsx
git commit -m "feat(web): add Clear lock and retry action to BusyBanner"
```

---

## Task 8: e2e page object + spec

**Files:**
- Modify: e2e page object for the IaC page (find via `grep -rn "staleLockBanner" app/packages/web/e2e/pages/`)
- Create/modify: an e2e or integration spec exercising the new flow (co-locate near the existing stale-lock e2e coverage — `grep -rn "staleLockBanner" app/packages/web/e2e/`)

**Interfaces:**
- Consumes: the `window.hyveon.__test.mock()` seam (see `docs/docs/components/integration-tests.md`) to make an apply/destroy submission return a `RunLockHeldError`-shaped ack with `runLock` set — `plan`/`preview` never acquires the durable `RunLock` and so can never produce this ack shape (see Task 5/7); this spec must exercise `apply` or `destroy`, not `plan`.

- [ ] **Step 1: Add the page-object method**

In the IaC page object file, alongside `staleLockBanner()`:

```typescript
clearRunLockButton() {
  return this.page.getByRole('button', { name: /clear lock and retry/i });
}
```

- [ ] **Step 2: Write the spec**

Following the existing stale-lock e2e spec's structure (mock the apply IPC call to reject with the durable-lock ack shape, submit, assert the button appears, click through the confirm dialog, assert success, that the original error banner and BUSY banner are both gone, and that a manual resubmit is now allowed):

```typescript
test('should clear a stuck run lock and allow manual resubmission', async ({ page, ipc, iacPage }) => {
  await ipc.mockOnce('iac.apply', { started: false, conflict: 'up', error: 'Run lock already held by "chris"', runLock: { runId: 'r1', kind: 'apply', initiator: 'chris', acquiredAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString() } });
  await ipc.mockOnce('iac.runs.lock.clear.mintToken', { token: 'tok' });
  await ipc.mockOnce('iac.runs.lock.clear', { cleared: true });
  await ipc.mockOnce('iac.apply', { started: true, runId: 'new-run-id' }); // the operator's manual resubmit

  await iacPage.goto();
  await iacPage.applyButton().click();
  await expect(page.getByText(/run lock already held/i)).toBeVisible(); // original ErrorBanner
  await expect(iacPage.clearRunLockButton()).toBeVisible();
  await iacPage.clearRunLockButton().click();
  await iacPage.confirmDialogConfirmButton().click(); // reuse whatever locator the stale-lock spec already uses for this
  await expect(page.getByText(/run lock cleared/i)).toBeVisible();

  // returns to ready state: original ErrorBanner and BUSY banner both cleared, no auto-resubmit
  await expect(page.getByText(/run lock already held/i)).not.toBeVisible();
  await expect(iacPage.clearRunLockButton()).not.toBeVisible();

  // operator resubmits manually
  await iacPage.applyButton().click();
  await expect(page.getByText(/new-run-id/i)).toBeVisible();
});
```

- [ ] **Step 3: Run the e2e suite**

Run: `npm run app:test:e2e`
Expected: PASS (new spec passes; no regression in the existing stale-lock spec)

- [ ] **Step 4: Commit**

```bash
git add app/packages/web/e2e/
git commit -m "test(e2e): cover run-lock clear-and-retry flow"
```

---

## Task 9: docs + full gate

**Files:**
- Check: `docs/docs/components/management-app.md`, `docs/docs/app/*.md` for the IaC page — search for any mention of "workspace busy" or the Pulumi-lock clear flow to update alongside it.

- [ ] **Step 1: Run the write-docs skill** (or hand-update) to document the new run-lock recovery action on whichever docs page describes the `/iac` page's busy/error states.

- [ ] **Step 2: Full gate**

```bash
npm run app:lint
npm run app:typecheck
npm run app:test
npm run app:test:integration
npm run app:test:e2e
```

Expected: all five exit 0.

- [ ] **Step 3: Commit**

```bash
git add docs/
git commit -m "docs: document run-lock clear-and-retry recovery"
```

---

## Execution Handoff

Two execution options:

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent per task above, review between tasks, fast iteration.
2. **Inline Execution** — execute tasks in this session using `executing-plans`, batch execution with checkpoints.
