import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { installOperationQuitHook, type OperationQuitApp } from './operation-quit-hook.js';
import { logger } from './logger.js';

type BeforeQuit = Parameters<OperationQuitApp['on']>[1];

/** A promise whose settlement the test controls. */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * Installs the coordinator on a stand-in app and returns the registered `before-quit` handler with the spies it drives.
 */
function setup(opts: { idle?: Promise<void>; busy?: boolean; stoppers?: Array<() => Promise<void>> } = {}) {
  let handler!: BeforeQuit;
  const app = {
    on: vi.fn((_event: 'before-quit', fn: BeforeQuit) => {
      handler = fn;
    }),
    quit: vi.fn(),
    exit: vi.fn(),
  };
  const pulumi = {
    abortInFlightOperations: vi.fn(() => opts.busy ?? true),
    whenIdle: vi.fn(() => opts.idle ?? Promise.resolve()),
  };
  installOperationQuitHook(app, pulumi, opts.stoppers ?? [], { boundMs: 1000, forceExitMs: 500 });
  const fire = () => {
    const event = { preventDefault: vi.fn() };
    handler(event);
    return event;
  };
  return { app, pulumi, fire };
}

describe('installOperationQuitHook', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  // @spec IAC-ENGINE-LIFE-009
  it('should prevent the first quit, abort operations, wait for idle, then quit once', async () => {
    const idle = deferred();
    const { app, pulumi, fire } = setup({ idle: idle.promise });

    const first = fire();

    expect(first.preventDefault).toHaveBeenCalledTimes(1);
    expect(pulumi.abortInFlightOperations).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10);
    expect(app.quit).not.toHaveBeenCalled();

    idle.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(app.quit).toHaveBeenCalledTimes(1);
  });

  // @spec IAC-ENGINE-LIFE-009
  it('should let a second before-quit through without aborting or quitting again', async () => {
    const { app, pulumi, fire } = setup();
    fire();
    await vi.advanceTimersByTimeAsync(0);

    const second = fire();

    expect(second.preventDefault).not.toHaveBeenCalled();
    expect(pulumi.abortInFlightOperations).toHaveBeenCalledTimes(1);
    expect(app.quit).toHaveBeenCalledTimes(1);
  });

  // @spec IAC-ENGINE-LIFE-009
  it('should not let a repeated before-quit while waiting start a second shutdown', async () => {
    const idle = deferred();
    const { app, pulumi, fire } = setup({ idle: idle.promise });
    fire();

    const again = fire();

    expect(again.preventDefault).toHaveBeenCalledTimes(1);
    expect(pulumi.abortInFlightOperations).toHaveBeenCalledTimes(1);
    idle.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(app.quit).toHaveBeenCalledTimes(1);
  });

  // @spec IAC-ENGINE-LIFE-009
  it('should quit after the bound when an operation never goes idle, and force-exit if the process stays alive', async () => {
    const { app, fire } = setup({ idle: new Promise<void>(() => undefined) });
    fire();

    await vi.advanceTimersByTimeAsync(999);
    expect(app.quit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(app.quit).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalled();
    expect(app.exit).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(500);
    expect(app.exit).toHaveBeenCalledWith(0);
  });

  // @spec IAC-ENGINE-LIFE-009
  it('should wait for helper stoppers and operations together, in parallel', async () => {
    const idle = deferred();
    const helpers = deferred();
    const stopHelpers = vi.fn(() => helpers.promise);
    const { app, pulumi, fire } = setup({ idle: idle.promise, stoppers: [stopHelpers] });

    fire();
    expect(stopHelpers).toHaveBeenCalledTimes(1);
    expect(pulumi.abortInFlightOperations).toHaveBeenCalledTimes(1);

    idle.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(app.quit).not.toHaveBeenCalled();

    helpers.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(app.quit).toHaveBeenCalledTimes(1);
  });

  // @spec IAC-ENGINE-LIFE-009
  it('should still quit when a stopper rejects', async () => {
    const { app, fire } = setup({ stoppers: [() => Promise.reject(new Error('helper stop failed'))] });

    fire();
    await vi.advanceTimersByTimeAsync(0);

    expect(app.quit).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalled();
  });
});
