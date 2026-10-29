import { afterEach, describe, expect, it, vi } from 'vitest';

const windows = vi.hoisted(() => ({ list: [] as Array<{ isDestroyed(): boolean; webContents: { send: ReturnType<typeof vi.fn> } }> }));
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => windows.list } }));

import { forwardToWindows } from './ipc-broadcast.js';

const win = (destroyed: boolean) => ({ isDestroyed: () => destroyed, webContents: { send: vi.fn() } });

/** Runs `fn` with `process.versions.electron` set to `value`. */
async function withElectron<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(process.versions, 'electron');
  Object.defineProperty(process.versions, 'electron', { value, configurable: true });
  try {
    return await fn();
  } finally {
    if (original) Object.defineProperty(process.versions, 'electron', original);
    else delete (process.versions as Record<string, unknown>)['electron'];
  }
}

describe('forwardToWindows', () => {
  afterEach(() => {
    windows.list = [];
  });

  it('should not subscribe outside Electron', async () => {
    const subscribe = vi.fn();
    expect(await withElectron(undefined, () => forwardToWindows(subscribe, 'c'))).toBeNull();
    expect(subscribe).not.toHaveBeenCalled();
  });

  it('should send each event to every live window and skip destroyed ones', async () => {
    const live = win(false);
    const dead = win(true);
    windows.list = [live, dead];
    let emit: (e: { n: number }) => void = () => undefined;
    await withElectron('1.0.0', () => forwardToWindows<{ n: number }>((cb) => ((emit = cb), () => undefined), 'chan'));
    emit({ n: 1 });
    expect(live.webContents.send).toHaveBeenCalledWith('chan', { n: 1 });
    expect(dead.webContents.send).not.toHaveBeenCalled();
  });

  it('should return the source unsubscribe function', async () => {
    const unsubscribe = vi.fn();
    const result = await withElectron('1.0.0', () => forwardToWindows(() => unsubscribe, 'chan'));
    result?.();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
