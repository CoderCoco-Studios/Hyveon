import { HttpException } from '@nestjs/common';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import { logger } from './logger.js';

/** The `{ evt }` context every self-bridged handler receives so it can reach `evt.sender`. */
export interface SelfBridgedContext {
  evt: IpcMainInvokeEvent;
}

/** A controller method registered directly on `ipcMain.handle` instead of through the generic bridge. */
export type SelfBridgedHandler = (payload: unknown, ctx: SelfBridgedContext) => Promise<unknown>;

// @spec APP-IPC-ERR-004, APP-IPC-ERR-007
/**
 * Extracts the operator-facing message from anything a handler or stream can throw.
 *
 * @remarks
 * An `HttpException` built from an object body (`BadRequestException({ success: false, error })`)
 * carries a class-derived `.message` such as "Bad Request Exception"; its real text lives in
 * `getResponse()`, so that is read first. Everything else yields its `.message`, or `String(err)`
 * for a non-object throw. Never returns the `Error: ` prefix `String(error)` would add.
 *
 * @param err - The value caught from a handler or stream source.
 * @returns A human-readable message.
 */
export function ipcErrorMessage(err: unknown): string {
  if (err instanceof HttpException) {
    const body = err.getResponse();
    if (typeof body === 'string' && body.length > 0) return body;
    if (typeof body === 'object' && body !== null) {
      const { error, message } = body as { error?: unknown; message?: unknown };
      if (typeof message === 'string' && message.length > 0) return message;
      if (typeof error === 'string' && error.length > 0) return error;
    }
    return err.message;
  }
  if (err instanceof Error) return err.message;
  if (typeof err === 'object' && err !== null && 'message' in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err);
}

/**
 * Logs a failed handler and builds the plain `Error` that safely crosses structured clone.
 *
 * @param pattern - The IPC channel whose handler failed.
 * @param err - The value the handler threw or rejected with.
 * @returns A new `Error` carrying only the normalized message.
 */
export function toIpcError(pattern: string, err: unknown): Error {
  const message = ipcErrorMessage(err);
  logger.error(`ipc-main-bridge: handler for "${pattern}" failed: ${message}`, {
    pattern,
    stack: err instanceof Error ? err.stack : undefined,
  });
  return new Error(message);
}

// @spec APP-IPC-CALL-009, APP-IPC-ERR-005
/**
 * Registers each handler on `ipcMain.handle` for the channels in `SELF_BRIDGED_PATTERNS`,
 * normalizing failures the way the generic bridge does.
 *
 * @remarks
 * Each channel is preceded by `removeHandler` so hot-reload re-registration does not throw. A throw
 * before the handler's ack is logged and rethrown as a plain `Error` carrying only the message.
 * Silent no-op while `process.versions.electron` is unset (plain-Node harness, CI).
 *
 * @param handlers - Channel name to the controller method that answers it.
 */
export async function registerSelfBridgedHandlers(handlers: Record<string, SelfBridgedHandler>): Promise<void> {
  if (!process.versions.electron) return;
  const { ipcMain } = (await import('electron')) as unknown as { ipcMain: IpcMain };
  for (const [channel, handler] of Object.entries(handlers)) {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async (evt: IpcMainInvokeEvent, payload: unknown) => {
      try {
        return await handler(payload, { evt });
      } catch (err) {
        throw toIpcError(channel, err);
      }
    });
  }
}
