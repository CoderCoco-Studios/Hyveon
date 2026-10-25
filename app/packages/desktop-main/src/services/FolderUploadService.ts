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
import { FileManagerService, type UploadHelperSession } from './FileManagerService.js';
import { FolderScanService, type HeldScan } from './FolderScanService.js';
import { FileBrowserClientFactory, PinMismatchError, type FileBrowserApi } from './folderUpload/FileBrowserClient.js';
import { ProgressAggregator } from './folderUpload/ProgressAggregator.js';
import {
  abortableSleep,
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

/** Waits and polling cadence; production values by default, shortened by tests. */
export interface FolderUploadTimings {
  /** Port FileBrowser listens on inside the helper. */
  helperPort: number;
  /** Poll interval while waiting for the helper's public IP and for HTTPS to answer. */
  pollMs: number;
  /** Give up waiting for the helper's task to expose a public IP after this long. */
  helperIpTimeoutMs: number;
  /** Give up waiting for FileBrowser to accept a login after this long. */
  loginTimeoutMs: number;
  /** Cancel the run when the operator has not answered the overwrite warning after this long. */
  confirmationTimeoutMs: number;
}

/** A run in flight in this process. */
interface ActiveRun {
  runId: string;
  controller: AbortController;
}

/** Everything resolved by the preflight guards that the run needs. */
interface PreparedRun {
  game: string;
  scan: HeldScan;
  request: FolderUploadRequest;
  items: UploadItem[];
  bytesTotal: number;
  /** The previous run for this same selection was cut short, so a few existing files are our own partial uploads. */
  resumesOwnRun: boolean;
}

/**
 * Orchestrates a folder-to-volume upload: guards, helper lifecycle, the streamed upload with resume, verification, and
 * progress/last-run reporting.
 *
 * @remarks
 * The helper's credential lives only in this process: it is handed to the {@link FileBrowserApi} client and never
 * returned over IPC or logged. The helper is stopped in a `finally` on every exit path, which also revokes the
 * operator-IP rule.
 */
@Injectable()
export class FolderUploadService implements OnApplicationBootstrap {
  /** Overridable by tests. */
  readonly timings: FolderUploadTimings = { helperPort: 8080, pollMs: 3000, helperIpTimeoutMs: 3 * 60 * 1000, loginTimeoutMs: 2 * 60 * 1000, confirmationTimeoutMs: 10 * 60 * 1000 };

  /** Concurrency/retry tunables; overridable by tests. */
  readonly engine: UploadEngineOptions = { ...DEFAULT_ENGINE_OPTIONS };

  private readonly active = new Map<string, ActiveRun>();
  private readonly confirmations = new Map<string, (proceed: boolean) => void>();
  private readonly latest = new Map<string, FolderUploadProgress>();
  private readonly listeners = new Set<(progress: FolderUploadProgress) => void>();

  constructor(
    private readonly config: ConfigService,
    private readonly deploymentConfig: DeploymentConfigService,
    private readonly ecs: EcsService,
    private readonly fileManager: FileManagerService,
    private readonly scans: FolderScanService,
    private readonly store: ElectronStoreService,
    private readonly clients: FileBrowserClientFactory,
  ) {}

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

  /** Re-scans the persisted `localPath` for `game` so a restored selection has a live `scanId`; `null` if none stored. */
  async rescanSelection(game: string): Promise<FolderScanResult | null> {
    const state = this.store.getFolderUploadState(game);
    return state ? this.scans.scan(state.localPath) : null;
  }

  /** Cancels `game`'s run in this process, if any. */
  cancel(game: string): { cancelled: boolean } {
    const run = this.active.get(game);
    run?.controller.abort();
    return { cancelled: !!run };
  }

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

  /** Operator-requested cleanup: stops every file-manager helper no active run here owns, regardless of age. */
  cleanupStrayHelpers(): Promise<StrayHelperReport> {
    return this.fileManager.sweepStrayHelpers({ activeGames: new Set(this.active.keys()), minAgeMs: 0 });
  }

  /**
   * Validates the request and, if every guard passes, starts the run in the background.
   *
   * @returns `{ started: true, runId }`, or `{ started: false, error }` for a failed guard (not deployed, server
   * running, helper already open, bad destination or path, scan expired).
   */
  async startUpload(request: FolderUploadRequest): Promise<FolderUploadStartResult> {
    let prepared: PreparedRun;
    try {
      prepared = await this.prepare(request);
    } catch (err) {
      const error = errMessage(err);
      logger.info('FolderUploadService: upload refused', { game: request.game, reason: error });
      return { started: false, error };
    }
    this.setSelection(request);

    const runId = randomUUID();
    const controller = new AbortController();
    this.active.set(request.game, { runId, controller });
    logger.info('FolderUploadService: upload started', { game: request.game, runId, files: prepared.items.length, bytes: prepared.bytesTotal });
    void this.execute(prepared, runId, controller.signal);
    return { started: true, runId };
  }

  private requireScan(scanId: string): HeldScan {
    const scan = this.scans.get(scanId);
    if (!scan) throw new Error('The folder scan has expired; pick the folder again.');
    return scan;
  }

  /** Runs every preflight guard and resolves the upload plan. Throws a plain `Error` describing the first failure. */
  private async prepare(request: FolderUploadRequest): Promise<PreparedRun> {
    const { game } = request;
    if (!game || typeof request.destination !== 'string' || !Array.isArray(request.include)) {
      throw new Error('Invalid upload request.');
    }
    if (this.active.has(game)) throw new Error(`An upload is already running for '${game}'.`);
    const scan = this.requireScan(request.scanId);

    const outputs = await this.config.getStackOutputs();
    if (!outputs || !outputs.efsAccessPoints[game]) {
      throw new Error(`'${game}' is not deployed yet. Apply the infrastructure first; your selection is kept.`);
    }

    const gameServers = await this.deploymentConfig.getGameServers();
    const server = gameServers.find((g) => g.name === game);
    if (!server) throw new Error(`Unknown game '${game}'.`);
    const dest = validateDestination(request.destination, server.volumes);
    if (!dest.ok) throw new Error(dest.error);

    const plan = planUpload(scan.tree, request.include);
    if (plan.length === 0) throw new Error('Nothing is selected to upload.');
    const items: UploadItem[] = plan.map((file) => ({
      relPath: file.relPath,
      localPath: join(scan.rootPath, ...file.relPath.split('/')),
      remotePath: toRemotePath(request.destination, dest.volume.container_path, file.relPath),
      size: file.size,
      mtimeMs: scan.mtimes.get(file.relPath) ?? 0,
    }));

    if (await this.ecs.findRunningTask(outputs.ecsClusterName, game)) {
      throw new Error(`'${game}' is running. Stop the server before uploading.`);
    }
    const helper = await this.fileManager.getStatus(game);
    if (helper.state === 'running' || helper.state === 'starting') {
      throw new Error(`A file manager session is already open for '${game}'. Stop it first, then retry.`);
    }

    return {
      game,
      scan,
      request,
      items,
      bytesTotal: items.reduce((sum, i) => sum + i.size, 0),
      resumesOwnRun: this.isOwnPartialRun(this.store.getFolderUploadState(game), scan.rootPath, request),
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

  /** The run body: launch, upload, verify, and always stop the helper before reporting the terminal phase. */
  private async execute(prepared: PreparedRun, runId: string, signal: AbortSignal): Promise<void> {
    const { game, items, bytesTotal } = prepared;
    const progress = new ProgressAggregator(game, bytesTotal, items.length, (p) => this.publish(p));
    progress.start();

    let session: UploadHelperSession | undefined;
    let client: FileBrowserApi | undefined;
    let terminal: { phase: FolderUploadPhase; error?: string } = { phase: 'done' };
    try {
      progress.setPhase('starting-helper');
      const launch = await this.fileManager.startForUpload(game, runId);
      if (!launch.ok) throw new Error(launch.message);
      session = launch.session;

      const host = await this.waitForHelperIp(game, signal);
      client = this.clients.create({
        host,
        port: this.timings.helperPort,
        username: session.credentials.username,
        password: session.credentials.password,
        certPem: session.cert.certPem,
        fingerprint256: session.cert.fingerprint256,
      });
      await this.waitForLogin(client, signal);

      const existing = remoteSizesOf(await listPlannedDirs(client, items, signal, this.engine.concurrency));
      await this.confirmOverwrites(prepared, runId, existing, progress, signal);

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
        : { phase: 'failed', error: errMessage(err) };
      if (terminal.phase === 'failed') logger.warn('FolderUploadService: upload failed', { game, runId, error: terminal.error });
    } finally {
      await this.releaseHelper(game, runId, client, session !== undefined);
      this.finish(game, runId, progress, terminal);
    }
  }

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
    prepared: PreparedRun,
    runId: string,
    existing: Map<string, number>,
    progress: ProgressAggregator,
    signal: AbortSignal,
  ): Promise<void> {
    const { game } = prepared;
    const summary = classifyUpload(prepared.items, existing);
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

  /** Records the run's outcome, emits the terminal snapshot, and frees the game for a new run. */
  private finish(game: string, runId: string, progress: ProgressAggregator, terminal: { phase: FolderUploadPhase; error?: string }): void {
    const snap = progress.snapshot();
    const status = terminal.phase === 'done' ? 'done' : terminal.phase === 'cancelled' ? 'cancelled' : 'failed';
    this.store.setFolderUploadLastRun(game, {
      status,
      completedAt: new Date().toISOString(),
      files: snap.filesDone,
      bytes: snap.bytesDone,
    });
    progress.setPhase(terminal.phase, terminal.error);
    progress.stop();
    this.active.delete(game);
    logger.info('FolderUploadService: upload finished', { game, runId, phase: terminal.phase });
  }

  /** Closes the client and stops the helper (revoking its IP rule). Only stops a helper this run launched. */
  private async releaseHelper(game: string, runId: string, client: FileBrowserApi | undefined, launched: boolean): Promise<void> {
    try {
      await client?.close();
    } catch (err) {
      logger.warn('FolderUploadService: client close failed', { game, runId, error: errMessage(err) });
    }
    if (!launched) return;
    try {
      const result = await this.fileManager.stop(game);
      if (!result.success) logger.warn('FolderUploadService: helper stop reported failure', { game, runId, message: result.message });
    } catch (err) {
      logger.error('FolderUploadService: helper stop threw', { game, runId, error: errMessage(err) });
    }
  }

  /** Polls until the helper task exposes a public IP. */
  private async waitForHelperIp(game: string, signal: AbortSignal): Promise<string> {
    const deadline = Date.now() + this.timings.helperIpTimeoutMs;
    for (;;) {
      if (signal.aborted) throw new UploadCancelledError();
      const ip = await this.fileManager.getHelperPublicIp(game);
      if (ip) return ip;
      if (Date.now() > deadline) throw new Error('The file manager helper did not get a public IP in time.');
      await abortableSleep(this.timings.pollMs, signal);
    }
  }

  /** Retries login while the container boots; a certificate-pin failure aborts immediately (fail closed). */
  private async waitForLogin(client: FileBrowserApi, signal: AbortSignal): Promise<void> {
    const deadline = Date.now() + this.timings.loginTimeoutMs;
    for (;;) {
      if (signal.aborted) throw new UploadCancelledError();
      try {
        await client.login(signal);
        return;
      } catch (err) {
        if (err instanceof PinMismatchError || Date.now() > deadline) throw err;
        await abortableSleep(this.timings.pollMs, signal);
      }
    }
  }
}
