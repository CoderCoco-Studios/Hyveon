/**
 * Unit tests for the leaked-promise-handling primitives: a successful
 * Pulumi operation must not be reported as a failure merely because the
 * inline program left a dangling promise.
 *
 * Constructs the exact message shape `debuggable.leakedPromises()`
 * (`node_modules/@pulumi/pulumi/runtime/debuggable.js`) produces, rather
 * than a hand-waved approximation.
 */
import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';

const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../logger.js', () => ({ logger: loggerMock }));

import { isLeakedPromiseError, runTreatingLeakedPromiseAsSuccess } from './PulumiLeakedPromise.js';

// `debuggable.leakedPromises()`/its backing `state.getStore()` are exported at
// runtime from `@pulumi/pulumi/runtime/*.js` but marked `@internal` in the
// SDK's own source — there is no public, stable alternative signal to key off
// instead of this message text (verified during PR review). Loading these two
// untyped internals lets the compatibility test below call the real SDK
// function rather than only asserting against a hand-built string.
const debuggableInternals = createRequire(import.meta.url)('@pulumi/pulumi/runtime/debuggable.js') as {
  leakedPromises: () => [Set<unknown>, string];
};
const stateInternals = createRequire(import.meta.url)('@pulumi/pulumi/runtime/state.js') as {
  getStore: () => { leakCandidates: Set<unknown> };
};

/** The exact message shape `debuggable.leakedPromises()` builds for a single leaked promise. */
const SINGLE_LEAK_MESSAGE =
  'The Pulumi runtime detected that 1 promise was still active\n' +
  'at the time that the process exited. There are a few ways that this can occur:\n' +
  '  * Not using `await` or `.then` on a Promise returned from a Pulumi API';

/** The exact message shape for more than one leaked promise (plural wording). */
const MULTI_LEAK_MESSAGE = 'The Pulumi runtime detected that 3 promises were still active\nat the time that the process exited.';

describe('isLeakedPromiseError', () => {
  it('should return true for the single-leak message shape', () => {
    expect(isLeakedPromiseError(new Error(SINGLE_LEAK_MESSAGE))).toBe(true);
  });

  it('should return true for the multi-leak (plural) message shape', () => {
    expect(isLeakedPromiseError(new Error(MULTI_LEAK_MESSAGE))).toBe(true);
  });

  it('should return false for a genuine CLI failure', () => {
    expect(isLeakedPromiseError(new Error('error: update failed: some resource error'))).toBe(false);
  });

  it('should return false for a stack-lock conflict error', () => {
    expect(isLeakedPromiseError(new Error('the stack is currently locked by 1 lock(s)'))).toBe(false);
  });

  it('should return false for a non-Error thrown value', () => {
    expect(isLeakedPromiseError('just a string')).toBe(false);
  });
});

describe('isLeakedPromiseError — compatibility with the installed @pulumi/pulumi SDK', () => {
  it('should classify the message the real, installed debuggable.leakedPromises() produces (regression for a future SDK upgrade silently changing the wording)', () => {
    const store = stateInternals.getStore();
    const originalCandidates = store.leakCandidates;
    store.leakCandidates = new Set([Promise.resolve()]);

    try {
      const [, message] = debuggableInternals.leakedPromises();
      expect(isLeakedPromiseError(new Error(message))).toBe(true);
    } finally {
      store.leakCandidates = originalCandidates;
    }
  });
});

describe('runTreatingLeakedPromiseAsSuccess — genuine success (no leak)', () => {
  it('should return the operation result unchanged and never call recoverResult', async () => {
    const operation = vi.fn().mockResolvedValue('the real result');
    const recoverResult = vi.fn();

    const result = await runTreatingLeakedPromiseAsSuccess(operation, recoverResult);

    expect(result).toBe('the real result');
    expect(recoverResult).not.toHaveBeenCalled();
  });
});

describe('runTreatingLeakedPromiseAsSuccess — succeeded then threw (leaked promise)', () => {
  it('should recover via recoverResult instead of propagating the leak error', async () => {
    const operation = vi.fn().mockRejectedValue(new Error(SINGLE_LEAK_MESSAGE));
    const recoverResult = vi.fn().mockResolvedValue('recovered result');

    const result = await runTreatingLeakedPromiseAsSuccess(operation, recoverResult);

    expect(result).toBe('recovered result');
    expect(recoverResult).toHaveBeenCalledTimes(1);
    expect(recoverResult.mock.calls[0][0]).toBeInstanceOf(Error);
    expect((recoverResult.mock.calls[0][0] as Error).message).toContain('The Pulumi runtime detected that');
  });

  it('should log a warning noting the recovery', async () => {
    const operation = vi.fn().mockRejectedValue(new Error(SINGLE_LEAK_MESSAGE));
    const recoverResult = vi.fn().mockResolvedValue('recovered result');

    await runTreatingLeakedPromiseAsSuccess(operation, recoverResult);

    expect(loggerMock.warn).toHaveBeenCalledTimes(1);
  });
});

describe('runTreatingLeakedPromiseAsSuccess — genuine failure', () => {
  it('should propagate a real operation failure unchanged and never call recoverResult', async () => {
    const realFailure = new Error('error: update failed: some resource error');
    const operation = vi.fn().mockRejectedValue(realFailure);
    const recoverResult = vi.fn();

    await expect(runTreatingLeakedPromiseAsSuccess(operation, recoverResult)).rejects.toBe(realFailure);
    expect(recoverResult).not.toHaveBeenCalled();
  });
});

describe('runTreatingLeakedPromiseAsSuccess — recoverResult itself fails', () => {
  it('should propagate the recovery failure rather than the original leak error', async () => {
    const operation = vi.fn().mockRejectedValue(new Error(SINGLE_LEAK_MESSAGE));
    const recoveryFailure = new Error('stack.outputs() failed too');
    const recoverResult = vi.fn().mockRejectedValue(recoveryFailure);

    await expect(runTreatingLeakedPromiseAsSuccess(operation, recoverResult)).rejects.toBe(recoveryFailure);
  });
});
