import { randomUUID } from 'node:crypto';
import { BadRequestException, Controller, OnModuleInit } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import type { IpcMain, IpcMainInvokeEvent, WebContents } from 'electron';
import { computeRunDetailStatus, type RunDetailStatus, type RunPageResult, type RunStatus } from '@hyveon/shared';
import {
  PulumiService,
  type PulumiRunChunk,
  type PulumiRunRecord,
} from '../services/PulumiService.js';
import { RunLockChangedError, RunLockClearNotConfirmedError, RunService } from '../services/RunService.js';
import { RunRecordService, type ListRunsOpts } from '../services/RunRecordService.js';
import { logger } from '../logger.js';

/** Every {@link RunStatus} value — used to validate {@link IacRunsController.list}'s `status` filter. */
const RUN_STATUSES: readonly RunStatus[] = ['success', 'failed', 'aborted'];

/** Result of {@link IacRunsController.logUrl}: a presigned/temporary URL the renderer can fetch the offloaded log from directly. */
export interface IacRunsLogUrlResult {
  url: string;
}

/** Payload accepted by {@link IacRunsController.logUrl}. */
export interface IacRunsLogUrlPayload {
  logKey: string;
  expiresInSeconds?: number;
}

/** Result {@link IacRunsController.mintLockClearToken} resolves with. */
export interface IacRunsLockMintAck {
  token: string;
}

/**
 * Payload accepted by {@link IacRunsController.mintLockClearToken}.
 * `expectedRunId` must be the `runId` of the {@link RunLock} the renderer
 * displayed to the operator (`ack.runLock.runId` on the plan/apply/destroy
 * ack that reported the busy conflict) — binds the minted token to that
 * SPECIFIC lock instance rather than "whatever lock happens to be held"
 * (see `RunLockChangedError`'s doc comment in `RunService.ts` for the
 * TOCTOU this closes).
 */
export interface IacRunsLockMintPayload {
  expectedRunId: string;
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

/** Payload accepted by {@link IacRunsController.get}. */
export interface IacRunsGetPayload {
  runId: string;
}

/**
 * Result of {@link IacRunsController.get}: `found: false` when `runId`
 * is neither the currently held apply lock nor a persisted
 * `PulumiRunRecord` on disk. `found: true` always carries the derived
 * {@link RunDetailStatus}; `record` is present only once the run has produced
 * a persisted `PulumiRunRecord` (i.e. every status except `running`, since a
 * run in flight hasn't closed its process yet — see `PulumiRunRecord`'s doc
 * comment), read from the local `run.json` via `PulumiService.readRunRecord`.
 */
export type IacRunsGetResult =
  | { found: false }
  | { found: true; status: RunDetailStatus; record?: PulumiRunRecord };

/** Payload accepted by {@link IacRunsController.logs}. */
export interface IacRunsLogsPayload {
  runId: string;
}

/** Fixed side-channel {@link IacRunsController.logs} pushes streamed output on. */
const LOGS_CHUNK_CHANNEL = 'iac.runs.logs.chunk';

/** Fixed side-channel {@link IacRunsController.logs} sends its terminal message on. */
const LOGS_END_CHANNEL = 'iac.runs.logs.end';

/**
 * Message payload sent, in order, on {@link LOGS_CHUNK_CHANNEL} for every
 * chunk `PulumiService.streamRunOutput` yields. `streamId` ties the chunk
 * back to the `logs()` call that produced it (see
 * {@link IacRunsLogsAck.streamId}) so the renderer can never mix up
 * output from two overlapping subscriptions.
 */
interface IacRunsLogsChunkMessage {
  streamId: string;
  chunk: PulumiRunChunk;
}

/**
 * Message payload sent exactly once on {@link LOGS_END_CHANNEL} once the run
 * identified by `logs()`'s `runId` reaches a terminal status — either
 * `PulumiService.streamRunOutput`'s generator ends cleanly (the run
 * settled, or a finished run's persisted log finished replaying) or it threw
 * (`error` carries the stringified failure). `streamId` identifies which
 * `logs()` call this terminates.
 */
interface IacRunsLogsEndMessage {
  streamId: string;
  error?: string;
}

/**
 * Immediate acknowledgement `logs()` resolves with — `streamId` tags every
 * subsequent chunk/end message pushed for this subscription on
 * {@link LOGS_CHUNK_CHANNEL} / {@link LOGS_END_CHANNEL}.
 */
interface IacRunsLogsAck {
  streamId: string;
}

/**
 * IPC-only controller for reading the status/detail of a single Pulumi
 * preview/apply/destroy run (issue #108) — no HTTP routes are registered
 * here. Backed by `PulumiService`.
 *
 * `get()` combines two data sources to derive the run's
 * {@link RunDetailStatus} via the shared, pure `computeRunDetailStatus`
 * helper: `RunService.getCurrentLock()` (the in-flight apply lock, #106) for
 * a still-running run, and `PulumiService.readRunRecord()` /
 * `PulumiService.hasPlanArtifact()` (the local `<runsDir>/<runId>/run.json`
 * + saved plan artifact) for a finished one.
 *
 * `logs()` bridges `PulumiService.streamRunOutput`'s async-generator output
 * onto the fixed `iac.runs.logs.chunk` / `iac.runs.logs.end` side channels,
 * mirroring `IacController.plan`'s streaming shape, so the renderer can
 * watch (or re-attach to) a run's live or persisted output.
 */
@Controller()
export class IacRunsController implements OnModuleInit {
  constructor(
    private readonly pulumi: PulumiService,
    private readonly runService: RunService,
    private readonly runRecordService: RunRecordService,
  ) {}

  /**
   * Registers an `ipcMain.handle` bridge for the `iac.runs.logs`
   * channel after the Nest module initialises, so that
   * `ipcRenderer.invoke('iac.runs.logs', { runId })` in the preload
   * actually resolves.
   *
   * `@MessagePattern('iac.runs.logs')` only wires the transport's
   * internal dispatcher — it does **not** call `ipcMain.handle`, so
   * `ipcRenderer.invoke` would otherwise hang. This hook bridges the gap,
   * mirroring `IacController.onModuleInit`'s handling of
   * `iac.plan`/`iac.apply`/`iac.destroy` — see `SELF_BRIDGED_PATTERNS` in
   * `../ipc-main-bridge.ts`, which excludes `iac.runs.logs` from the
   * generic bridge for the same reason: the handler pushes follow-up
   * chunk/end messages over side channels for the duration of a run's output
   * rather than resolving a single value.
   *
   * Only runs inside a real Electron main process. In plain-Node runtimes
   * (integration test server, Docker, CI) `process.versions.electron` is
   * undefined and importing `electron` would throw, so the bridge is skipped
   * entirely rather than guessing which error means "no Electron" from the
   * message.
   */
  async onModuleInit(): Promise<void> {
    if (!process.versions.electron) {
      // Not running inside the Electron main process — ipcMain bridge skipped.
      return;
    }
    const { ipcMain } = (await import('electron')) as unknown as { ipcMain: IpcMain };
    // Remove any existing handler first so hot-reload re-registration does
    // not throw "IPC channel already registered".
    ipcMain.removeHandler('iac.runs.logs');
    ipcMain.handle('iac.runs.logs', (evt, payload: IacRunsLogsPayload) =>
      this.logs(payload, { evt: evt as IpcMainInvokeEvent }),
    );
  }

  /**
   * Looks up a single run by `runId` and returns its current
   * {@link RunDetailStatus}:
   *
   * - `{ found: true, status: 'running' }` when `runId` matches the run
   *   currently holding the apply lock (`RunService.getCurrentLock()`) — no
   *   `record` is attached, since a {@link PulumiRunRecord} is only ever
   *   persisted once the run has settled.
   * - `{ found: true, status, record }` when a persisted
   *   {@link PulumiRunRecord} exists for `runId` — `status` is derived via
   *   `computeRunDetailStatus`, checking `PulumiService.hasPlanArtifact()`
   *   for `plan` records to distinguish `awaiting_approval` from a terminal
   *   `success`/`failed`/`aborted`.
   * - `{ found: false }` when `runId` is neither in flight nor has a
   *   persisted record.
   *
   * @throws `BadRequestException` when `payload.runId` isn't a non-empty
   *   string.
   *
   * Reachable via the Electron IPC transport (`iac.runs.get`).
   */
  @MessagePattern('iac.runs.get')
  async get(@Payload() payload: IacRunsGetPayload): Promise<IacRunsGetResult> {
    logger.debug('IacRunsController: iac.runs.get invoked');
    const runId = payload?.runId;
    if (typeof runId !== 'string' || runId.length === 0) {
      throw new BadRequestException({
        success: false,
        error: 'iac.runs.get requires a non-empty runId string',
      });
    }

    const currentLock = this.runService.getCurrentLock();
    if (currentLock?.runId === runId) {
      return { found: true, status: 'running' };
    }

    const record = this.pulumi.readRunRecord(runId);
    if (!record) {
      return { found: false };
    }

    const planArtifactExists = record.kind === 'plan' ? this.pulumi.hasPlanArtifact(runId) : false;
    const status = computeRunDetailStatus({
      isInFlight: false,
      kind: record.kind,
      exitCode: record.exitCode,
      planArtifactExists,
    });

    return { found: true, status, record };
  }

  /**
   * Opens a live/replayed log stream for the run identified by `payload.runId`
   * and returns an opaque `streamId` immediately. Chunks are pushed to the
   * renderer via `sender.send` on {@link LOGS_CHUNK_CHANNEL}, forwarded in
   * order from `PulumiService.streamRunOutput`, terminating with exactly one
   * message on {@link LOGS_END_CHANNEL}.
   *
   * Mints its own `AbortController` per invocation rather than accepting a
   * caller-supplied one: `ElectronIPCTransport` passes `{ evt }` as the
   * execution context, with no `signal` to propagate from the IPC caller. A
   * `'destroyed'` listener on the `WebContents` aborts it — and stops further
   * `sender.send` calls — the instant the window/webview goes away.
   *
   * @throws `BadRequestException` when `payload.runId` isn't a non-empty
   *   string.
   *
   * Reachable via the Electron IPC transport (`iac.runs.logs`).
   */
  @MessagePattern('iac.runs.logs')
  async logs(
    @Payload() payload: IacRunsLogsPayload,
    ctx: { evt: IpcMainInvokeEvent },
  ): Promise<IacRunsLogsAck> {
    logger.debug('IacRunsController: iac.runs.logs invoked');
    const runId = payload?.runId;
    if (typeof runId !== 'string' || runId.length === 0) {
      throw new BadRequestException({
        success: false,
        error: 'iac.runs.logs requires a non-empty runId string',
      });
    }

    const sender: WebContents = ctx.evt.sender;
    const streamId = randomUUID();
    const ac = new AbortController();

    const onDestroyed = () => ac.abort();
    sender.once('destroyed', onDestroyed);

    // Fire-and-forget the streaming loop. Chunks are pushed back to the
    // renderer directly via WebContents.send rather than through the normal
    // invoke reply mechanism, which only supports a single return value.
    void (async () => {
      try {
        for await (const chunk of this.pulumi.streamRunOutput(runId, ac.signal)) {
          if (sender.isDestroyed()) { ac.abort(); return; }
          const chunkMessage: IacRunsLogsChunkMessage = { streamId, chunk };
          sender.send(LOGS_CHUNK_CHANNEL, chunkMessage);
        }
        if (!sender.isDestroyed()) {
          const message: IacRunsLogsEndMessage = { streamId };
          sender.send(LOGS_END_CHANNEL, message);
        }
      } catch (err) {
        logger.error('iac.runs.logs error', { err, runId, streamId });
        if (!sender.isDestroyed()) {
          const message: IacRunsLogsEndMessage = { streamId, error: String(err) };
          sender.send(LOGS_END_CHANNEL, message);
        }
      } finally {
        sender.removeListener('destroyed', onDestroyed);
      }
    })();

    return { streamId };
  }

  /**
   * Returns a page of persisted run records, newest-first — see
   * `RunRecordService.listRuns()`. `opts` mirrors {@link ListRunsOpts}
   * (`limit`/`before`/`status`) and defaults to `{}` when the renderer
   * invokes `iac.runs.list` with no arguments.
   *
   * @throws `BadRequestException` when `opts.status` is present but not one
   *   of {@link RUN_STATUSES}.
   *
   * Reachable via the Electron IPC transport (`iac.runs.list`).
   */
  @MessagePattern('iac.runs.list')
  async list(@Payload() opts: ListRunsOpts = {}): Promise<RunPageResult> {
    logger.debug('IacRunsController: iac.runs.list invoked');
    if (opts?.status !== undefined && !RUN_STATUSES.includes(opts.status)) {
      throw new BadRequestException({
        success: false,
        error: `iac.runs.list status must be one of ${RUN_STATUSES.join(', ')}`,
      });
    }
    return this.runRecordService.listRuns(opts ?? {});
  }

  /**
   * Resolves a temporary, fetchable URL for a run's log once it has been
   * offloaded to the store's remote file backend (i.e. the run's
   * `RunRecord.logS3Key` is set) — see `RunRecordService.getLogUrl()`.
   *
   * @throws `BadRequestException` when `payload.logKey` isn't a non-empty
   *   string.
   *
   * Reachable via the Electron IPC transport (`iac.runs.logUrl`).
   */
  @MessagePattern('iac.runs.logUrl')
  async logUrl(@Payload() payload: IacRunsLogUrlPayload): Promise<IacRunsLogUrlResult> {
    logger.debug('IacRunsController: iac.runs.logUrl invoked');
    const logKey = payload?.logKey;
    if (typeof logKey !== 'string' || logKey.length === 0) {
      throw new BadRequestException({
        success: false,
        error: 'iac.runs.logUrl requires a non-empty logKey string',
      });
    }

    const url = await this.runRecordService.getLogUrl(logKey, payload.expiresInSeconds);
    return { url };
  }

  /**
   * Mints a fresh, single-use confirmation token the renderer must supply
   * back on {@link clearLock}'s payload before it expires — the RunLock
   * analogue of `IacController.mintLockClearToken`, for the durable apply
   * lock (`RunService`) rather than the Pulumi backend lock.
   *
   * `payload.expectedRunId` must be the `runId` of the lock the renderer
   * displayed to the operator — `RunService.mintLockClearConfirmationToken()`
   * refuses to mint (throwing {@link RunLockChangedError}) when a DIFFERENT
   * lock is now held, closing the TOCTOU gap where the displayed lock was
   * released and replaced by a new, legitimate one before the operator
   * confirmed. It also throws a plain `Error` when no lock is currently held
   * at all (in-memory or durable). Both are expected races, not server
   * faults — caught here and reported as a clean `BadRequestException` so
   * the renderer never sees an unmodeled IPC rejection for either.
   *
   * @throws `BadRequestException` when `payload.expectedRunId` isn't a
   *   non-empty string, when no run lock is currently held, or when the
   *   currently held lock's `runId` doesn't match `payload.expectedRunId`.
   *
   * Reachable via the Electron IPC transport (`iac.runs.lock.clear.mintToken`).
   */
  @MessagePattern('iac.runs.lock.clear.mintToken')
  async mintLockClearToken(@Payload() payload: IacRunsLockMintPayload): Promise<IacRunsLockMintAck> {
    logger.debug('IacRunsController: iac.runs.lock.clear.mintToken invoked');
    const expectedRunId = payload?.expectedRunId;
    if (typeof expectedRunId !== 'string' || expectedRunId.length === 0) {
      throw new BadRequestException({
        success: false,
        error: 'iac.runs.lock.clear.mintToken requires a non-empty expectedRunId string',
      });
    }
    try {
      const token = await this.runService.mintLockClearConfirmationToken(expectedRunId);
      return { token };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const reason = err instanceof RunLockChangedError ? 'the held lock has changed' : 'no run lock currently held';
      logger.warn(`iac.runs.lock.clear.mintToken rejected: ${reason}`, { error: message });
      throw new BadRequestException({ success: false, error: message });
    }
  }

  /**
   * Clears the current run lock by invoking `RunService.clearLock()`,
   * gated behind `payload.confirmationToken` (minted via
   * {@link mintLockClearToken}) — mirrors `IacController.clearStaleLock`'s
   * ack shape: a rejected/unconfirmed clear resolves `{ cleared: false, error }`
   * rather than throwing, so the renderer never sees an unhandled IPC
   * rejection for the expected "token stale" case.
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
      const error = err instanceof Error ? err.message : String(err);
      logger.error('iac.runs.lock.clear error', { error });
      return { cleared: false, error };
    }
  }
}
