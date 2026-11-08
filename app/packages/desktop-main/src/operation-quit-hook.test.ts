import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { installOperationQuitHook } from './operation-quit-hook.js';

/** Installs the hook on a stand-in app and returns the registered handler with its spies. */
function setup(busy: boolean) {
  let handler!: () => void;
  const app = {
    on: vi.fn((_event: 'before-quit', fn: () => void) => {
      handler = fn;
    }),
    exit: vi.fn(),
  };
  const abortInFlightOperations = vi.fn(() => busy);
  installOperationQuitHook(app, { abortInFlightOperations }, 1000);
  return { app, abortInFlightOperations, fire: () => handler() };
}

describe('installOperationQuitHook', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  // @spec IAC-ENGINE-LIFE-009
  it('should abort a running operation on before-quit and force-exit if the process is still alive afterwards', () => {
    const { app, abortInFlightOperations, fire } = setup(true);

    fire();
    expect(abortInFlightOperations).toHaveBeenCalledTimes(1);
    expect(app.exit).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1000);
    expect(app.exit).toHaveBeenCalledWith(0);
  });

  // @spec IAC-ENGINE-LIFE-009
  it('should arm no force-exit timer when nothing was running', () => {
    const { app, fire } = setup(false);

    fire();
    vi.advanceTimersByTime(60_000);

    expect(app.exit).not.toHaveBeenCalled();
  });
});
