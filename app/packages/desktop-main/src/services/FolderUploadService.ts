import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { errMessage } from '@hyveon/shared';
import {
  planUpload,
  toRemotePath,
  validateDestination,
  type FolderScanResult,
  type FolderUploadPhase,
  type FolderUploadProgress,
  type FolderUploadRequest,
  type FolderUploadStartResult,
  type FolderUploadStoredState,
  type FolderOverwriteDecisionResult,
  type StrayHelperReport,
} from '@hyveon/shared/folderUpload';
import { logger } from '../logger.js';
import { ConfigService } from './ConfigService.js';
import { DeploymentConfigService } from './DeploymentConfigService.js';
import { EcsService } from './EcsService.js';
import { ElectronStoreService } from './ElectronStoreService.js';
import { FileManagerService, UPLOAD_TAGS } from './FileManagerService.js';
import { FolderScanService, type HeldScan } from './FolderScanService.js';
import { isVolumeMounted, toHelperPath } from './volumeFiles/helperVolumeLayout.js';
import { HelperSessionRegistry, type AcquireResult } from './volumeFiles/HelperSessionRegistry.js';
import { ProgressAggregator } from './folderUpload/ProgressAggregator.js';
import { RegistryUploadBackend } from './folderUpload/RegistryUploadBackend.js';
import {
  classifyUpload,
  ConfirmationTimeoutError,
  DEFAULT_ENGINE_OPTIONS,
  ensureDirs,
  listPlannedDirs,
  remoteSizesOf,
  uploadAll,
  UploadCancelledError,
  verifyUpload,
  type UploadEngineOptions,
  type UploadItem,
} from './folderUpload/uploadEngine.js';

/** Helpers older than this with no owning run are stopped by the startup sweep. */
const STARTUP_SWEEP_MIN_AGE_MS = 15 * 60 * 1000;
/** Most paths named in a verification-failure message; the rest are summarized as a count. */
const MAX_PATHS_IN_MESSAGE = 5;

/** Waits of the upload run itself; the helper's own waits live on {@link HelperSessionRegistry.timings}. */
export interface FolderUploadTimings {
  /** Cancel the run when the operator has not answered the overwrite warning after this long. */
  confirmationTimeoutMs: number;
}

/** A run in flight in this process. */
interface ActiveRun {
  runId: string;
  controller: AbortController;
}

/** One file of the plan, addressed by its path inside the destination volume until a session layout maps it. */
interface PlannedFile {
  relPath: string;
  localPath: string;
  /** Path inside the destination volume. */
  volumePath: string;
  size: number;
  mtimeMs: number;
}

/** Everything resolved by the preflight guards that the run needs. */
interface PreparedRun {
  game: string;
  scan: HeldScan;
  request: FolderUploadRequest;
  files: PlannedFile[];
  bytesTotal: number;
  /** Destination volume resolved in preflight; the session's layout must mount it. */
  volume: string;
  /** The previous run for this same selection was cut short, so a few existing files are our own partial uploads. */
  resumesOwnRun: boolean;
  /** Whether this run owns the persisted selection and its last-run status (`false` for runs started from a page). */
  persistSelection: boolean;
}

/** Options for {@link FolderUploadService.startUpload}. */
export interface StartUploadOptions {
  /**
   * Remember this run as the game's folder-upload selection and record its outcome as the selection's last run.
   * Pass `false` for runs the selection card did not start, so they neither replace the card's selection nor change
   * how its next run treats existing files. Defaults to `true`.
   */
  persistSelection?: boolean;
}

// @spec HELPER-UPLOAD-003
/**
 * Orchestrates a folder-to-volume upload: guards, helper lifecycle, the streamed upload with resume, verification, and
 * progress/last-run reporting.
 *
 * @remarks
 * The run holds the game's {@link HelperSessionRegistry} session as an `upload:<runId>` holder and releases it in a
 * `finally` on every exit path; the registry stops a helper the run launched (revoking the operator-IP rule) and leaves
 * a browse session that predates the run running.
 */
@Injectable()
export class FolderUploadService implements OnApplicationBootstrap {
  /** Overridable by tests. */
  readonly timings: FolderUploadTimings = { confirmationTimeoutMs: 10 * 60 * 1000 };

  /** Concurrency/retry tunables; overridable by tests. */
  readonly engine: UploadEngineOptions = { ...DEFAULT_ENGINE_OPTIONS };

  private readonly active = new Map<string, ActiveRun>();
  /** Games whose `startUpload` is between the guard and `active.set`, so an overlapping call cannot pass the guard. */
  private readonly preparing = new Set<string>();
  private readonly confirmations = new Map<string, (proceed: boolean) => void>();
  private readonly latest = new Map<string, FolderUploadProgress>();
  private readonly listeners = new Set<(progress: FolderUploadProgress) => void>();

  // @spec HELPER-SESS-008
  constructor(
    private readonly config: ConfigService,
    private readonly deploymentConfig: DeploymentConfigService,
    private readonly ecs: EcsService,
    private readonly fileManager: FileManagerService,
    private readonly scans: FolderScanService,
    private readonly store: ElectronStoreService,
    private readonly registry: HelperSessionRegistry,
  ) {
    this.registry.onBeforeStop((game) => {
      this.cancel(game);
    });
  }

  // @spec HELPER-STRAY-003
  /** Sweeps stray helpers left by a previous app session; best-effort and Electron-only. */
  onApplicationBootstrap(): void {
    if (!process.versions.electron) return;
    void this.fileManager
      .sweepStrayHelpers({ activeGames: new Set(), minAgeMs: STARTUP_SWEEP_MIN_AGE_MS })
      .catch((err) => logger.warn('FolderUploadService: startup sweep failed', { error: errMessage(err) }));
  }

  /** Subscribes to progress snapshots; returns the unsubscribe function. */
  onProgress(listener: (progress: FolderUploadProgress) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The most recent snapshot for `game`'s run, or `null` when none has run in this process. */
  getProgress(game: string): FolderUploadProgress | null {
    return this.latest.get(game) ?? null;
  }

  /** Persisted selection and last-run status for `game`, or `null`. */
  getSelection(game: string): FolderUploadStoredState | null {
    return this.store.getFolderUploadState(game) ?? null;
  }

  // @spec HELPER-SAFE-003
  /**
   * Persists the selection described by `request` (resolving the local path from the held scan).
   *
   * @throws Error when the scan is no longer held.
   */
  setSelection(request: FolderUploadRequest): void {
    const scan = this.requireScan(request.scanId);
    this.store.setFolderUploadSelection(request.game, {
      localPath: scan.rootPath,
      include: request.include,
      destination: request.destination,
    });
  }

  /** Forgets the persisted selection for `game` (e.g. a discarded wizard draft); a no-op when none is stored. */
  clearSelection(game: string): void {
    this.store.clearFolderUploadState(game);
  }

  // @spec HELPER-SAFE-004
  /** Re-scans the persisted `localPath` for `game` so a restored selection has a live `scanId`; `null` if none stored. */
  async rescanSelection(game: string): Promise<FolderScanResult | null> {
    const state = this.store.getFolderUploadState(game);
    return state ? this.scans.scan(state.localPath) : null;
  }

  // @spec HELPER-PROG-005
  /** Cancels `game`'s run in this process, if any. */
  cancel(game: string): { cancelled: boolean } {
    const run = this.active.get(game);
    run?.controller.abort();
    return { cancelled: !!run };
  }

  // @spec HELPER-OVER-003, HELPER-OVER-004
  /**
   * Answers the overwrite warning for `game`'s run: `proceed` lets the upload continue, otherwise the run is cancelled
   * (helper stopped, IP rule revoked) before any file is written.
   *
   * @returns `{ resolved: false }` when the run is not awaiting confirmation.
   */
  confirmOverwrite(game: string, proceed: boolean): FolderOverwriteDecisionResult {
    const answer = this.confirmations.get(game);
    answer?.(proceed);
    return { resolved: !!answer };
  }

  // @spec HELPER-STRAY-004, HELPER-STRAY-005
  /** Operator-requested cleanup: stops every file-manager helper neither an active run nor the session registry owns. */
  cleanupStrayHelpers(): Promise<StrayHelperReport> {
    return this.fileManager.sweepStrayHelpers({
      activeGames: new Set([...this.active.keys(), ...this.registry.ownedGames()]),
      minAgeMs: 0,
    });
  }

  // @spec HELPER-SELECT-004, HELPER-SELECT-007, HELPER-UPLOAD-002, HELPER-UPLOAD-005, HELPER-UPLOAD-006
  // @spec HELPER-UPLOAD-008, HELPER-UPLOAD-009, HELPER-UPLOAD-011, HELPER-UPLOAD-012, HELPER-UPLOAD-017
  // @spec HELPER-SAFE-006
  /**
   * Validates the request and, if every guard passes, starts the run in the background.
   *
   * @param request - What to upload and where.
   * @param options - Whether the run is remembered as the game's saved selection.
   * @returns `{ started: true, runId }`, or `{ started: false, error }` for a failed guard (not deployed, server
   * running, an unmanaged helper already open, bad destination or path, scan expired).
   */
  async startUpload(request: FolderUploadRequest, options: StartUploadOptions = {}): Promise<FolderUploadStartResult> {
    const { game } = request;
    const persistSelection = options.persistSelection ?? true;
    if (this.preparing.has(game)) {
      return { started: false, error: `An upload is already starting for '${game}'.` };
    }
    // Reserve synchronously: `active.set` only happens after `prepare()`'s awaits.
    this.preparing.add(game);
    let prepared: PreparedRun;
    let runId: string;
    let controller: AbortController;
    try {
      try {
        prepared = await this.prepare(request, persistSelection);
      } catch (err) {
        const error = errMessage(err);
        logger.info('FolderUploadService: upload refused', { game, reason: error });
        return { started: false, error };
      }
      if (persistSelection) this.setSelection(request);

      runId = randomUUID();
      controller = new AbortController();
      // No await between here and the release in `finally`.
      this.active.set(game, { runId, controller });
    } finally {
      this.preparing.delete(game);
    }
    logger.info('FolderUploadService: upload started', { game, runId, files: prepared.files.length, bytes: prepared.bytesTotal });
    void this.execute(prepared, runId, controller.signal);
    return { started: true, runId };
  }

  private requireScan(scanId: string): HeldScan {
    const scan = this.scans.get(scanId);
    if (!scan) throw new Error('The folder scan has expired; pick the folder again.');
    return scan;
  }

  /** Runs every preflight guard and resolves the upload plan. Throws a plain `Error` describing the first failure. */
  private async prepare(request: FolderUploadRequest, persistSelection: boolean): Promise<PreparedRun> {
    const { game } = request;
    if (!game || typeof request.destination !== 'string' || !Array.isArray(request.include)) {
      throw new Error('Invalid upload request.');
    }
    if (this.active.has(game)) throw new Error(`An upload is already running for '${game}'.`);
    const scan = this.requireScan(request.scanId);

    const layout = await this.fileManager.planHelperLayout(game);
    const outputs = await this.config.getStackOutputs();
    if (!layout || !outputs) {
      throw new Error(`'${game}' is not deployed yet. Apply the infrastructure first; your selection is kept.`);
    }

    const gameServers = await this.deploymentConfig.getGameServers();
    const server = gameServers.find((g) => g.name === game);
    if (!server) throw new Error(`Unknown game '${game}'.`);
    const dest = validateDestination(request.destination, server.volumes);
    if (!dest.ok) throw new Error(dest.error);
    if (layout.usedFallback || !isVolumeMounted(layout, dest.volume.name)) {
      throw new Error(`Apply the infrastructure to upload into '${dest.volume.name}'. Your selection is kept.`);
    }

    const plan = planUpload(scan.tree, request.include);
    if (plan.length === 0) throw new Error('Nothing is selected to upload.');
    const files: PlannedFile[] = plan.map((file) => ({
      relPath: file.relPath,
      localPath: join(scan.rootPath, ...file.relPath.split('/')),
      volumePath: toRemotePath(request.destination, dest.volume.container_path, file.relPath),
      size: file.size,
      mtimeMs: scan.mtimes.get(file.relPath) ?? 0,
    }));

    let serverRunning: boolean;
    try {
      serverRunning = (await this.ecs.findRunningTaskOrThrow(outputs.ecsClusterName, game)) !== null;
    } catch {
      // EcsService already logged the cause; a server that can't be confirmed stopped is never assumed stopped.
      throw new Error(`Couldn't confirm '${game}' is stopped. Try again in a moment.`);
    }
    if (serverRunning) throw new Error(`'${game}' is running. Stop the server before uploading.`);
    if ((await this.registry.status(game)).state === 'orphaned') {
      throw new Error(`A file manager session is already open for '${game}'. Restart it, then retry.`);
    }

    return {
      game,
      scan,
      request,
      files,
      bytesTotal: files.reduce((sum, f) => sum + f.size, 0),
      volume: dest.volume.name,
      resumesOwnRun: persistSelection && this.isOwnPartialRun(this.store.getFolderUploadState(game), scan.rootPath, request),
      persistSelection,
    };
  }

  /**
   * True when `previous` is a cut-short run (failed or cancelled after copying something) of the same folder, includes
   * and destination, i.e. a few files on the volume are this app's own partial uploads.
   */
  private isOwnPartialRun(previous: FolderUploadStoredState | undefined, localPath: string, request: FolderUploadRequest): boolean {
    const last = previous?.lastRun;
    if (!previous || !last || last.status === 'done' || last.files === 0) return false;
    const included = new Set(previous.include);
    return (
      previous.localPath === localPath &&
      previous.destination === request.destination &&
      included.size === new Set(request.include).size &&
      request.include.every((p) => included.has(p))
    );
  }

  /** Emits a progress snapshot to listeners and remembers it as `game`'s latest. */
  private publish(progress: FolderUploadProgress): void {
    this.latest.set(progress.game, progress);
    for (const listener of this.listeners) listener(progress);
  }

  // @spec HELPER-UPLOAD-001, HELPER-STRAY-002, HELPER-STRAY-006, HELPER-VERIFY-002, HELPER-VERIFY-003
  // @spec HELPER-RESUME-005
  /**
   * The run body: holds the helper session, uploads, verifies, and always releases the session before reporting the
   * terminal phase.
   *
   * @remarks
   * Remote paths come from the session's own layout, because a reused browse session may predate an infrastructure
   * apply and not mount the destination volume.
   */
  private async execute(prepared: PreparedRun, runId: string, signal: AbortSignal): Promise<void> {
    const { game, files, bytesTotal } = prepared;
    const progress = new ProgressAggregator(game, bytesTotal, files.length, (p) => this.publish(p));
    progress.start();

    const holder = `upload:${runId}` as const;
    let acquired = false;
    let terminal: { phase: FolderUploadPhase; error?: string } = { phase: 'done' };
    try {
      progress.setPhase('starting-helper');
      if (signal.aborted) throw new UploadCancelledError();
      const opened = await this.acquireUnlessCancelled(game, holder, runId, signal);
      if (!opened.ok) throw new Error(opened.message);
      acquired = true;

      const items = await this.resolveItems(prepared);
      const client = new RegistryUploadBackend(this.registry, game);

      const existing = remoteSizesOf(await listPlannedDirs(client, items, signal, this.engine.concurrency));
      await this.confirmOverwrites(items, prepared, runId, existing, progress, signal);

      progress.setPhase('uploading');
      await ensureDirs(client, items, signal);
      await uploadAll(client, items, existing, progress, signal, this.engine);

      progress.setPhase('verifying');
      const verdict = await verifyUpload(client, items, signal);
      if (!verdict.ok) {
        const paths = [...verdict.missing.map((p) => `${p} (missing)`), ...verdict.mismatched.map((p) => `${p} (size mismatch)`)];
        const shown = paths.slice(0, MAX_PATHS_IN_MESSAGE).join(', ');
        const more = paths.length > MAX_PATHS_IN_MESSAGE ? ` and ${paths.length - MAX_PATHS_IN_MESSAGE} more` : '';
        throw new Error(`Verification failed: ${shown}${more}`);
      }
    } catch (err) {
      terminal = err instanceof UploadCancelledError || signal.aborted
        ? { phase: 'cancelled', error: err instanceof ConfirmationTimeoutError ? err.message : undefined }
        : { phase: 'failed', error: acquired ? await this.withSessionFailure(game, errMessage(err)) : errMessage(err) };
      if (terminal.phase === 'failed') logger.warn('FolderUploadService: upload failed', { game, runId, error: terminal.error });
    } finally {
      this.registry.release(game, holder);
      this.finish(prepared, runId, progress, terminal);
    }
  }

  // @spec HELPER-FB-014, HELPER-STRAY-001
  /**
   * Acquires the run's session hold, rejecting with {@link UploadCancelledError} as soon as `signal` aborts.
   *
   * @remarks
   * The registry cannot be aborted, and an acquire that waits out a teardown adds its holder only afterwards. When the
   * run is cancelled first, the hold is released again as soon as that late acquire succeeds, so nothing keeps the
   * session alive for a run that is already over.
   */
  private async acquireUnlessCancelled(game: string, holder: `upload:${string}`, runId: string, signal: AbortSignal): Promise<AcquireResult> {
    const pending = this.registry.acquire(game, holder, { tags: UPLOAD_TAGS, runId });
    try {
      return await this.rejectOnAbort(pending, signal);
    } catch (err) {
      if (signal.aborted) {
        void pending.then(
          (result) => {
            if (result.ok) this.registry.release(game, holder);
          },
          () => undefined,
        );
      }
      throw err;
    }
  }

  /** Settles like `promise` unless `signal` aborts first, in which case it rejects with {@link UploadCancelledError}. */
  private rejectOnAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => reject(new UploadCancelledError());
      signal.addEventListener('abort', onAbort, { once: true });
      promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
    });
  }

  // @spec HELPER-UPLOAD-016
  /**
   * Appends why the session died to `message` when the helper task vanished mid-run.
   *
   * @remarks
   * The registry's status check owns the stop-reason lookup; a vanished session comes back `failed` with ECS's reason.
   */
  private async withSessionFailure(game: string, message: string): Promise<string> {
    const snap = await this.registry.status(game).catch(() => null);
    if (snap?.state !== 'failed' || !snap.error || message.includes(snap.error)) return message;
    return `${message} (${snap.error})`;
  }

  // @spec HELPER-UPLOAD-020
  /**
   * Maps the plan onto the live session's layout.
   *
   * @throws Error naming the volume when the session does not mount it, before anything is written.
   */
  private async resolveItems(prepared: PreparedRun): Promise<UploadItem[]> {
    const { game, volume } = prepared;
    const layout = await this.registry.withBackend(game, async (_backend, sessionLayout) => sessionLayout);
    if (layout.usedFallback || !isVolumeMounted(layout, volume)) {
      throw new Error(`Stop and start the file manager session to upload into '${volume}'.`);
    }
    return prepared.files.map((file) => ({
      relPath: file.relPath,
      localPath: file.localPath,
      remotePath: toHelperPath(layout, volume, file.volumePath),
      size: file.size,
      mtimeMs: file.mtimeMs,
    }));
  }

  // @spec HELPER-OVER-001, HELPER-OVER-002, HELPER-OVER-004, HELPER-OVER-006, HELPER-OVER-007
  /**
   * Preflight: when the plan would overwrite files already on the volume, publishes an `awaiting-confirmation` snapshot
   * and waits for {@link FolderUploadService.confirmOverwrite}. Nothing has been written at this point.
   *
   * @remarks
   * A resume of this app's own cut-short run is not prompted unless conflicts exceed the files that could have been
   * mid-flight when it stopped (the engine's concurrency).
   * @throws UploadCancelledError when the operator declines or the run is cancelled; ConfirmationTimeoutError when
   * no answer arrives within {@link FolderUploadTimings.confirmationTimeoutMs}.
   */
  private async confirmOverwrites(
    items: UploadItem[],
    prepared: PreparedRun,
    runId: string,
    existing: Map<string, number>,
    progress: ProgressAggregator,
    signal: AbortSignal,
  ): Promise<void> {
    const { game } = prepared;
    const summary = classifyUpload(items, existing);
    const ownPartials = prepared.resumesOwnRun && summary.conflictCount <= this.engine.concurrency;
    if (summary.conflictCount === 0 || ownPartials) return;

    logger.info('FolderUploadService: awaiting overwrite confirmation', {
      game,
      runId,
      conflicts: summary.conflictCount,
      identical: summary.identicalCount,
      added: summary.newCount,
    });
    progress.setOverwrite(summary);
    progress.setPhase('awaiting-confirmation');
    const proceed = await this.waitForDecision(game, signal);
    if (!proceed) {
      logger.info('FolderUploadService: overwrite declined', { game, runId });
      throw new UploadCancelledError();
    }
  }

  // @spec HELPER-OVER-005
  /** Resolves with the operator's answer; rejects on cancel (abort) or timeout. Always clears the pending answer. */
  private waitForDecision(game: string, signal: AbortSignal): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        this.confirmations.delete(game);
      };
      const onAbort = () => {
        cleanup();
        reject(new UploadCancelledError());
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new ConfirmationTimeoutError());
      }, this.timings.confirmationTimeoutMs);
      this.confirmations.set(game, (proceed) => {
        cleanup();
        resolve(proceed);
      });
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  /** Records the run's outcome (when it persists its selection), emits the terminal snapshot, and frees the game for a new run. */
  private finish(prepared: PreparedRun, runId: string, progress: ProgressAggregator, terminal: { phase: FolderUploadPhase; error?: string }): void {
    const { game } = prepared;
    const snap = progress.snapshot();
    const status = terminal.phase === 'done' ? 'done' : terminal.phase === 'cancelled' ? 'cancelled' : 'failed';
    if (prepared.persistSelection) {
      this.store.setFolderUploadLastRun(game, {
        status,
        completedAt: new Date().toISOString(),
        files: snap.filesDone,
        bytes: snap.bytesDone,
      });
    }
    progress.setPhase(terminal.phase, terminal.error);
    progress.stop();
    this.active.delete(game);
    logger.info('FolderUploadService: upload finished', { game, runId, phase: terminal.phase });
  }
}
