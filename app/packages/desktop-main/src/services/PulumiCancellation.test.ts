/**
 * Unit tests for Task 4.7's `runWithEscalatingCancellation` — covering the
 * `pulumi-engine-runtime` delta spec's "Engine process lifecycle"
 * requirement's "Operation is cancelled" and "Unresponsive engine is
 * force-terminated" scenarios, plus the verified pre-aborted-signal gotcha
 * documented in `PulumiCancellation.ts`'s file-level TSDoc.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../logger.js', () => ({ logger: loggerMock }));

import {
  runWithEscalatingCancellation,
  PulumiOperationAbortedError,
  PulumiOperationEscalatedError,
  PULUMI_CANCELLATION_ESCALATION_TIMEOUT_MS,
} from './PulumiCancellation.js';

/** Never-settling promise — models an operation that never responds to its abort signal at all. */
function pendingForever<T>(): Promise<T> {
  return new Promise<T>(() => {
    /* never settles */
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('runWithEscalatingCancellation — no signal supplied', () => {
  it('should run the operation to completion without arming any escalation timer', async () => {
    const operation = vi.fn().mockResolvedValue('done');

    const result = await runWithEscalatingCancellation(operation, undefined);

    expect(result).toBe('done');
    expect(operation).toHaveBeenCalledTimes(1);
  });
});

describe('runWithEscalatingCancellation — already-aborted signal', () => {
  it('should reject with PulumiOperationAbortedError and never invoke the operation', async () => {
    const controller = new AbortController();
    controller.abort();
    const operation = vi.fn().mockResolvedValue('should never happen');

    await expect(runWithEscalatingCancellation(operation, controller.signal)).rejects.toBeInstanceOf(
      PulumiOperationAbortedError,
    );
    expect(operation).not.toHaveBeenCalled();
  });
});

describe('runWithEscalatingCancellation — signal triggers a graceful attempt that settles in time', () => {
  it('should resolve with the operation result and never escalate', async () => {
    const controller = new AbortController();
    const onEscalate = vi.fn();
    let capturedSignal: AbortSignal | undefined;

    const operation = vi.fn().mockImplementation(
      (signal: AbortSignal) =>
        new Promise((resolve) => {
          capturedSignal = signal;
          signal.addEventListener('abort', () => resolve('gracefully finished'));
        }),
    );

    const promise = runWithEscalatingCancellation(operation, controller.signal, { onEscalate });
    controller.abort();
    // The operation resolves synchronously off the same abort event — well
    // within the escalation window, which never gets a chance to fire.
    await vi.advanceTimersByTimeAsync(0);

    await expect(promise).resolves.toBe('gracefully finished');
    expect(onEscalate).not.toHaveBeenCalled();
    expect(capturedSignal).toBe(controller.signal);
  });

  it('should propagate the operation own rejection (e.g. a CLI error after SIGINT) rather than escalating', async () => {
    const controller = new AbortController();
    const onEscalate = vi.fn();
    const operation = vi.fn().mockImplementation(
      (signal: AbortSignal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('interrupted by SIGINT')));
        }),
    );

    const promise = runWithEscalatingCancellation(operation, controller.signal, { onEscalate });
    // Attach the rejection assertion before firing abort — `operation`
    // rejects synchronously off the abort event, so asserting after would
    // let the outer promise settle with no handler attached yet, which
    // Node flags as an (eventually-handled, but noisy) unhandled rejection.
    const assertion = expect(promise).rejects.toThrow('interrupted by SIGINT');
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);

    await assertion;
    expect(onEscalate).not.toHaveBeenCalled();
  });
});

describe('runWithEscalatingCancellation — no response within the escalation timeout', () => {
  it('should invoke onEscalate and reject with PulumiOperationEscalatedError once the timeout elapses', async () => {
    const controller = new AbortController();
    const onEscalate = vi.fn();
    const operation = vi.fn().mockImplementation(() => pendingForever());

    const promise = runWithEscalatingCancellation(operation, controller.signal, {
      escalationTimeoutMs: 5_000,
      onEscalate,
    });
    // Prevent an unhandled-rejection warning from the settlement assertion
    // racing the timer advance below.
    const assertion = expect(promise).rejects.toBeInstanceOf(PulumiOperationEscalatedError);

    controller.abort();
    await vi.advanceTimersByTimeAsync(5_000);

    await assertion;
    expect(onEscalate).toHaveBeenCalledTimes(1);
  });

  it('should not escalate before the timeout has fully elapsed', async () => {
    const controller = new AbortController();
    const onEscalate = vi.fn();
    const operation = vi.fn().mockImplementation(() => pendingForever());

    runWithEscalatingCancellation(operation, controller.signal, { escalationTimeoutMs: 5_000, onEscalate });
    controller.abort();
    await vi.advanceTimersByTimeAsync(4_999);

    expect(onEscalate).not.toHaveBeenCalled();
  });

  it('should default the escalation timeout to PULUMI_CANCELLATION_ESCALATION_TIMEOUT_MS', async () => {
    const controller = new AbortController();
    const onEscalate = vi.fn();
    const operation = vi.fn().mockImplementation(() => pendingForever());

    const promise = runWithEscalatingCancellation(operation, controller.signal, { onEscalate });
    const assertion = expect(promise).rejects.toBeInstanceOf(PulumiOperationEscalatedError);

    controller.abort();
    await vi.advanceTimersByTimeAsync(PULUMI_CANCELLATION_ESCALATION_TIMEOUT_MS);

    await assertion;
    expect(onEscalate).toHaveBeenCalledTimes(1);
  });

  it('should still settle as aborted (escalated) even if the abandoned operation later resolves, without an unhandled rejection', async () => {
    const controller = new AbortController();
    let releaseOperation: (() => void) | undefined;
    const operation = vi.fn().mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          releaseOperation = () => resolve('late success, discarded');
        }),
    );

    const promise = runWithEscalatingCancellation(operation, controller.signal, { escalationTimeoutMs: 1_000 });
    const assertion = expect(promise).rejects.toBeInstanceOf(PulumiOperationEscalatedError);

    controller.abort();
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;

    // The operation's own promise settles well after this function already
    // rejected — this must not throw or produce an unhandled rejection.
    expect(() => releaseOperation?.()).not.toThrow();
    await vi.advanceTimersByTimeAsync(0);
  });
});
