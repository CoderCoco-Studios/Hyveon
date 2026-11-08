import { randomUUID } from 'node:crypto';
import { Controller, OnModuleInit } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import type { IpcMain, IpcMainInvokeEvent, WebContents } from 'electron';
import type { LambdaFunctionKey } from '@hyveon/shared';
import { LogsService } from '../services/LogsService.js';
import type { RecentLogsPage, OlderLogsPage, NewerLogsPage } from '../services/LogsService.js';
import { logger } from '../logger.js';
import { ipcErrorMessage, registerSelfBridgedHandlers } from '../ipc-handlers.js';
import { errMessage } from '@hyveon/shared';

// @spec APP-LOGS-IPC-001, APP-LOGS-IPC-002
/** IPC-only logs controller. Handles Electron main-process messages via
 * `@MessagePattern`.
 *
 * Tails CloudWatch logs from the `/ecs/{game}-server` log group.
 */
@Controller()
export class LogsController implements OnModuleInit {
  constructor(private readonly logs: LogsService) {}

  // @spec APP-LOGS-IPC-003
  // @spec APP-IPC-CALL-009
  /**
   * Registers an `ipcMain.handle` bridge for `logs.stream` after Nest module
   * init, since `@MessagePattern` alone never calls `ipcMain.handle` and
   * `ipcRenderer.invoke` would otherwise hang. `logs.stream` is excluded from
   * the generic `registerIpcMainBridges` helper (`SELF_BRIDGED_PATTERNS` in
   * `ipc-main-bridge.ts`) because its handler mints a `streamId` and pushes
   * follow-up chunk/end messages over side channels derived from it.
   *
   * Registration goes through `registerSelfBridgedHandlers`, which is a no-op outside Electron.
   */
  async onModuleInit(): Promise<void> {
    await registerSelfBridgedHandlers({
      'logs.stream': (game, ctx) => this.streamLogs(game as string, ctx),
      'logs.lambda.stream': (functionKey, ctx) => this.streamLambdaLogs(functionKey as LambdaFunctionKey, ctx),
    });
  }

  /**
   * Returns the most recent `limit` (default 50) log lines for a game's ECS
   * task. Each line carries its own CloudWatch timestamp so the renderer can
   * seed its first `logs.getOlder` backfill call from the snapshot's real
   * boundary (`lines[0]?.timestamp`) instead of `Date.now()` — the latter
   * can re-fetch (and duplicate) lines already present in this snapshot.
   *
   */
  @MessagePattern('logs.get')
  async getRecentLogs(
    @Payload() payload: { game: string; limit?: number },
  ): Promise<{ game: string } & RecentLogsPage> {
    const { game, limit = 50 } = payload;
    logger.debug('LogsController: logs.get invoked', { game });
    const page = await this.logs.getRecentLogs(game, limit);
    return { game, ...page };
  }

  /**
   * Returns up to `limit` CloudWatch events strictly older than
   * `beforeTimestamp` for a game's ECS task log group — the "load older logs
   * on scroll-up" backfill flow. Delegates to
   * {@link LogsService.getOlderLogs}; a service-thrown error is normalized
   * to a plain `Error` before being allowed to propagate to the IPC caller
   * (there is no modeled failure result for this handler — an unhandled
   * rejection here surfaces to the renderer's `catch` around the `invoke`
   * call).
   *
   */
  @MessagePattern('logs.getOlder')
  async getOlderLogs(
    @Payload() payload: { game: string; beforeTimestamp: number; limit?: number },
  ): Promise<{ game: string } & OlderLogsPage> {
    const { game, beforeTimestamp, limit = 100 } = payload;
    logger.debug('LogsController: logs.getOlder invoked', { game });
    try {
      const page = await this.logs.getOlderLogs(game, beforeTimestamp, limit);
      return { game, ...page };
    } catch (err) {
      const message = errMessage(err);
      logger.error('LogsController: logs.getOlder failed', { game, error: message });
      throw new Error(message);
    }
  }

  /**
   * Returns up to `limit` CloudWatch events strictly newer than
   * `afterTimestamp` for a game's ECS task log group — the paged forward
   * backfill flow that runs when the operator scrolls back down through a
   * historical window. Delegates to {@link LogsService.getNewerLogs}, with
   * the same error-normalization contract as {@link getOlderLogs}.
   *
   */
  @MessagePattern('logs.getNewer')
  async getNewerLogs(
    @Payload() payload: { game: string; afterTimestamp: number; limit?: number; excludeEventIds?: string[] },
  ): Promise<{ game: string } & NewerLogsPage> {
    const { game, afterTimestamp, limit = 100, excludeEventIds = [] } = payload;
    logger.debug('LogsController: logs.getNewer invoked', { game });
    try {
      const page = await this.logs.getNewerLogs(game, afterTimestamp, limit, excludeEventIds);
      return { game, ...page };
    } catch (err) {
      const message = errMessage(err);
      logger.error('LogsController: logs.getNewer failed', { game, error: message });
      throw new Error(message);
    }
  }

  // @spec APP-LOGS-IPC-004, APP-LOGS-IPC-005, APP-LOGS-IPC-006, APP-LOGS-IPC-007, APP-LOGS-IPC-008
  // @spec APP-IPC-STREAM-008, APP-IPC-ERR-006
  /**
   * Opens a live log stream and returns an opaque `streamId` immediately.
   * Chunks are pushed to the renderer via `sender.send` on the
   * `<channelPrefix><streamId>.chunk` channel as they arrive from `source`.
   * The stream terminates with a `<channelPrefix><streamId>.end` message
   * carrying `{ error?: string }`.
   *
   * The renderer cancels the stream by sending
   * `<channelPrefix><streamId>.cancel` via `ipcRenderer.send`.
   *
   * The streaming loop starts only when the renderer sends `<channelPrefix><streamId>.ready`, which the preload does
   * after it has the `streamId` and has attached its chunk and end listeners. Electron delivers the invoke reply
   * and `webContents.send` pushes over separate paths with no ordering guarantee, so the protocol never relies on
   * the reply arriving before a push. A cancel that arrives before `ready` ends the stream without starting the
   * source.
   *
   * The controller creates its own `AbortController` per invocation because
   * `ElectronIPCTransport` passes `{ evt }` as the execution context — there
   * is no `signal` property injected by the transport. `source` receives that
   * signal so the underlying `LogsService` generator can be constructed here,
   * after the `AbortController` exists.
   *
   * @param source - Builds the log generator from this invocation's abort signal.
   * @param channelPrefix - Channel namespace, e.g. `logs.stream.` or `logs.lambda.stream.`.
   * @param ctx - Transport context carrying the originating `IpcMainInvokeEvent`.
   * @param errorLogLabel - Message logged via `logger.error` when `source` throws.
   * @param errorLogFields - Non-secret identifiers merged into that error log line.
   */
  private async openStream(
    source: (signal: AbortSignal) => AsyncGenerator<string>,
    channelPrefix: string,
    ctx: { evt: IpcMainInvokeEvent },
    errorLogLabel: string,
    errorLogFields: Record<string, unknown>,
  ): Promise<{ streamId: string }> {
    const streamId = randomUUID();
    const ac = new AbortController();
    const sender: WebContents = ctx.evt.sender;
    const chunkChannel = `${channelPrefix}${streamId}.chunk`;
    const endChannel = `${channelPrefix}${streamId}.end`;
    const cancelChannel = `${channelPrefix}${streamId}.cancel`;
    const readyChannel = `${channelPrefix}${streamId}.ready`;

    // Lazily import ipcMain so the module stays importable in plain-Node test
    // environments where the Electron runtime is absent.
    const { ipcMain } = await import('electron') as unknown as { ipcMain: IpcMain };

    let started = false;
    const finish = () => {
      ipcMain.removeAllListeners(readyChannel);
      ipcMain.removeAllListeners(cancelChannel);
    };

    // One-shot cancel listener so the renderer can abort the stream; before `ready` it ends the stream unstarted.
    ipcMain.once(cancelChannel, () => {
      ac.abort();
      if (started) return;
      started = true;
      if (!sender.isDestroyed()) sender.send(endChannel, {});
      finish();
    });

    // The preload sends `ready` once its listeners are attached; only then does the source run.
    ipcMain.once(readyChannel, () => {
      if (started) return;
      started = true;
      void this.pump(source, ac, sender, { chunkChannel, endChannel }, finish, errorLogLabel, {
        ...errorLogFields,
        streamId,
      });
    });

    return { streamId };
  }

  /**
   * Drains `source` into chunk pushes on `sender`, then sends the end message (carrying an error message when the
   * source failed other than by abort) and runs `finish` to drop the stream's one-shot listeners.
   *
   * @param source - Builds the log generator from the abort signal.
   * @param ac - The stream's abort controller.
   * @param sender - The renderer that opened the stream.
   * @param channels - The stream's chunk and end channel names.
   * @param finish - Cleanup run once the stream has ended.
   * @param errorLogLabel - Message logged via `logger.error` when `source` throws.
   * @param errorLogFields - Non-secret identifiers merged into that error log line.
   */
  private async pump(
    source: (signal: AbortSignal) => AsyncGenerator<string>,
    ac: AbortController,
    sender: WebContents,
    channels: { chunkChannel: string; endChannel: string },
    finish: () => void,
    errorLogLabel: string,
    errorLogFields: Record<string, unknown>,
  ): Promise<void> {
    try {
      for await (const line of source(ac.signal)) {
        if (sender.isDestroyed()) { ac.abort(); break; }
        sender.send(channels.chunkChannel, line);
      }
      if (!sender.isDestroyed()) sender.send(channels.endChannel, {});
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        if (!sender.isDestroyed()) sender.send(channels.endChannel, {});
      } else {
        const message = ipcErrorMessage(err);
        logger.error(errorLogLabel, { message, ...errorLogFields });
        if (!sender.isDestroyed()) sender.send(channels.endChannel, { error: message });
      }
    } finally {
      finish();
    }
  }

  /**
   * Opens a live log stream for `game`, delegating to {@link LogsService.streamLogs}.
   * See {@link openStream} for the shared channel/cancel/error-normalization contract.
   */
  @MessagePattern('logs.stream')
  async streamLogs(
    @Payload() game: string,
    ctx: { evt: IpcMainInvokeEvent },
  ): Promise<{ streamId: string }> {
    logger.debug('LogsController: logs.stream invoked', { game });
    return this.openStream(
      (signal) => this.logs.streamLogs(game, signal),
      'logs.stream.',
      ctx,
      'Log stream error',
      { game },
    );
  }

  /**
   * Returns the most recent `limit` (default 50) log lines for one of the
   * app's 5 Lambda functions, each carrying its own CloudWatch timestamp —
   * mirrors {@link getRecentLogs} exactly, but delegating to
   * {@link LogsService.getRecentLambdaLogs}.
   *
   */
  @MessagePattern('logs.lambda.get')
  async getRecentLambdaLogs(
    @Payload() payload: { functionKey: LambdaFunctionKey; limit?: number },
  ): Promise<{ functionKey: LambdaFunctionKey } & RecentLogsPage> {
    const { functionKey, limit = 50 } = payload;
    logger.debug('LogsController: logs.lambda.get invoked', { functionKey });
    const page = await this.logs.getRecentLambdaLogs(functionKey, limit);
    return { functionKey, ...page };
  }

  /**
   * Returns up to `limit` CloudWatch events strictly older than
   * `beforeTimestamp` for one of the app's 5 Lambda functions — mirrors
   * {@link getOlderLogs} exactly, but delegating to
   * {@link LogsService.getOlderLambdaLogs}.
   *
   */
  @MessagePattern('logs.lambda.getOlder')
  async getOlderLambdaLogs(
    @Payload() payload: { functionKey: LambdaFunctionKey; beforeTimestamp: number; limit?: number },
  ): Promise<{ functionKey: LambdaFunctionKey } & OlderLogsPage> {
    const { functionKey, beforeTimestamp, limit = 100 } = payload;
    logger.debug('LogsController: logs.lambda.getOlder invoked', { functionKey });
    try {
      const page = await this.logs.getOlderLambdaLogs(functionKey, beforeTimestamp, limit);
      return { functionKey, ...page };
    } catch (err) {
      const message = errMessage(err);
      logger.error('LogsController: logs.lambda.getOlder failed', { functionKey, error: message });
      throw new Error(message);
    }
  }

  /**
   * Returns up to `limit` CloudWatch events strictly newer than
   * `afterTimestamp` for one of the app's 5 Lambda functions — mirrors
   * {@link getNewerLogs} exactly, but delegating to
   * {@link LogsService.getNewerLambdaLogs}.
   *
   */
  @MessagePattern('logs.lambda.getNewer')
  async getNewerLambdaLogs(
    @Payload()
    payload: { functionKey: LambdaFunctionKey; afterTimestamp: number; limit?: number; excludeEventIds?: string[] },
  ): Promise<{ functionKey: LambdaFunctionKey } & NewerLogsPage> {
    const { functionKey, afterTimestamp, limit = 100, excludeEventIds = [] } = payload;
    logger.debug('LogsController: logs.lambda.getNewer invoked', { functionKey });
    try {
      const page = await this.logs.getNewerLambdaLogs(functionKey, afterTimestamp, limit, excludeEventIds);
      return { functionKey, ...page };
    } catch (err) {
      const message = errMessage(err);
      logger.error('LogsController: logs.lambda.getNewer failed', { functionKey, error: message });
      throw new Error(message);
    }
  }

  /**
   * Opens a live log stream for `functionKey`, using a distinct
   * `logs.lambda.stream.<id>.*` channel namespace so it can never collide
   * with `logs.stream.<id>.*`, and delegating to
   * {@link LogsService.streamLambdaLogs}. See {@link openStream} for the
   * shared channel/cancel/error-normalization contract.
   */
  @MessagePattern('logs.lambda.stream')
  async streamLambdaLogs(
    @Payload() functionKey: LambdaFunctionKey,
    ctx: { evt: IpcMainInvokeEvent },
  ): Promise<{ streamId: string }> {
    logger.debug('LogsController: logs.lambda.stream invoked', { functionKey });
    return this.openStream(
      (signal) => this.logs.streamLambdaLogs(functionKey, signal),
      'logs.lambda.stream.',
      ctx,
      'Lambda log stream error',
      { functionKey },
    );
  }
}
