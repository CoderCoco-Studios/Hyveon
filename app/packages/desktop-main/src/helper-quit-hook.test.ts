import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { installHelperQuitHook, type QuitApp } from './helper-quit-hook.js';
import { logger } from './logger.js';

type BeforeQuit = Parameters<QuitApp['on']>[1];

/**
 * Installs the hook on a stand-in app and returns the registered `before-quit` handler with the spies it drives.
 */
function setup(owned: string[], stopAll: () => Promise<void>) {
  let handler!: BeforeQuit;
  const app = {
    on: vi.fn((_event: 'before-quit', fn: BeforeQuit) => {
      handler = fn;
    }),
    quit: vi.fn(),
  };
  const stopAllSpy = vi.fn(stopAll);
  installHelperQuitHook(app, { ownedGames: () => new Set(owned), stopAll: stopAllSpy }, 5000);
  const fire = () => {
    const event = { preventDefault: vi.fn() };
    handler(event);
    return event;
  };
  return { app, stopAll: stopAllSpy, fire };
}

describe('installHelperQuitHook', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  // @spec HELPER-QUIT-001
  it('should not delay quit when no helpers are owned', () => {
    const { app, stopAll, fire } = setup([], async () => undefined);
    const event = fire();
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(stopAll).not.toHaveBeenCalled();
    expect(app.quit).not.toHaveBeenCalled();
  });

  // @spec HELPER-QUIT-002, HELPER-FB-018
  it('should stop owned helpers before quitting and let the second before-quit through', async () => {
    const { app, stopAll, fire } = setup(['mc'], async () => undefined);
    const first = fire();
    expect(first.preventDefault).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(app.quit).toHaveBeenCalledTimes(1));
    expect(stopAll).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalled();

    const second = fire();
    expect(second.preventDefault).not.toHaveBeenCalled();
    expect(stopAll).toHaveBeenCalledTimes(1);
  });

  // @spec HELPER-QUIT-002
  it('should quit after the timeout when stopAll never settles', async () => {
    const { app, fire } = setup(['mc'], () => new Promise<void>(() => undefined));
    fire();
    await vi.advanceTimersByTimeAsync(4999);
    expect(app.quit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(app.quit).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalled();
  });

  // @spec HELPER-QUIT-002
  it('should still quit when stopAll rejects', async () => {
    const { app, fire } = setup(['mc'], async () => {
      throw new Error('boom');
    });
    fire();
    await vi.waitFor(() => expect(app.quit).toHaveBeenCalledTimes(1));
  });
});
