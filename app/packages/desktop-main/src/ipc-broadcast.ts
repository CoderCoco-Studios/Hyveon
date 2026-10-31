import type { BrowserWindow } from 'electron';

// @spec APP-IPC-CALL-012
/**
 * Pushes every event from `subscribe` to all open renderer windows on `channel`.
 *
 * @remarks
 * A push, not a `@MessagePattern`, so it goes straight over `webContents.send`. Gated on
 * `process.versions.electron`: outside Electron (integration server, CI) importing `electron` would throw, so
 * nothing is subscribed.
 *
 * @typeParam T - Event payload type.
 * @param subscribe - Registers a listener with the event source and returns its unsubscribe function.
 * @param channel - IPC channel the renderer listens on.
 * @returns The unsubscribe function, or `null` when not running under Electron.
 */
export async function forwardToWindows<T>(
  subscribe: (listener: (event: T) => void) => () => void,
  channel: string,
): Promise<(() => void) | null> {
  if (!process.versions.electron) return null;
  const { BrowserWindow: Windows } = (await import('electron')) as unknown as {
    BrowserWindow: { getAllWindows(): BrowserWindow[] };
  };
  return subscribe((event) => {
    for (const win of Windows.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(channel, event);
    }
  });
}
