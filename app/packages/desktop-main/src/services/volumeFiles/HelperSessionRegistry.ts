import { Injectable } from '@nestjs/common';
import { errMessage } from '@hyveon/shared';
import { logger } from '../../logger.js';
import { BROWSE_RUN_ID, FileManagerService, type FileMgrCredentials } from '../FileManagerService.js';
import type { EphemeralCert } from '../folderUpload/ephemeralCert.js';
import { FileBrowserClientFactory } from '../folderUpload/FileBrowserClient.js';
import { abortableSleep } from '../folderUpload/uploadEngine.js';
import { PublicIpService } from '../PublicIpService.js';
import type { HelperVolumeLayout } from './helperVolumeLayout.js';
import { VolumeFileError, type VolumeFileBackend } from './VolumeFileBackend.js';

/** Who is keeping a helper session alive: the file-browser page, or one folder-upload run. */
export type HelperHolder = 'browse' | `upload:${string}`;

/** Lifecycle of one game's helper session as reported to callers. */
export type HelperSessionState = 'not_deployed' | 'stopped' | 'starting' | 'running' | 'stopping' | 'orphaned' | 'failed';

/** What callers may see of a session. Never carries credentials, the certificate, or the helper's address. */
export interface HelperSessionSnapshot {
  game: string;
  state: HelperSessionState;
  startedAt?: number;
  autoStopAt?: number;
  browseHeld: boolean;
  uploadHolders: number;
  error?: string;
  supportsArchive: boolean;
  /** Every declared volume; `mounted` is false for volumes the session's layout could not mount (apply needed). */
  volumes: { name: string; containerPath: string; mounted: boolean }[];
}

/** Outcome of {@link HelperSessionRegistry.acquire}. */
export type AcquireResult = { ok: true } | { ok: false; code: 'orphaned' | 'not_deployed' | 'failed'; message: string };

/** Options for {@link HelperSessionRegistry.acquire}; they apply only when the call actually launches the helper. */
export interface AcquireOptions {
  /** Tags applied to the helper task in addition to the operator IP tag. */
  tags?: readonly { key: string; value: string }[];
  /** Identifies the session; defaults to {@link BROWSE_RUN_ID}. */
  runId?: string;
}

/** Tunables of the registry; mutable so tests can shorten them. */
export interface HelperSessionTimings {
  /** How long a session with no holder but `browse` released outlives the release. */
  browseGraceMs: number;
  pollMs: number;
  helperIpTimeoutMs: number;
  loginTimeoutMs: number;
  /** The port the helper's HTTPS server listens on. */
  helperPort: number;
}

type EntryState = 'starting' | 'running' | 'stopping';

/** The registry's private record of one owned session. */
interface Entry {
  runId: string;
  state: EntryState;
  holders: Set<HelperHolder>;
  /** Settles when the launch and readiness wait finish; shared by every acquire that joins the entry. */
  ready: Promise<AcquireResult>;
  taskArn?: string;
  startedAt?: number;
  autoStopAt?: number;
  backend?: VolumeFileBackend;
  layout?: HelperVolumeLayout;
  credentials?: FileMgrCredentials;
  cert?: EphemeralCert;
  operatorIp?: string;
  graceTimer?: NodeJS.Timeout;
  /** In-flight operator-IP recovery, shared by concurrent operations that all saw `unreachable`. */
  recovery?: Promise<boolean>;
  /** In-flight pin-mismatch failure, so concurrent operations fail the session once. */
  failing?: Promise<AcquireResult>;
  /** Set once teardown begins; concurrent stops and acquires wait on it. */
  teardown?: Promise<{ success: boolean; message: string }>;
}

type SessionVolumes = HelperSessionSnapshot['volumes'];

const STOPPED_BEFORE_READY = 'The file manager session was stopped before it was ready.';

/** No file manager session is running for the requested game. */
export class NoSessionError extends VolumeFileError {
  /** @param game - Game that has no running session. */
  constructor(game: string) {
    super('unreachable', `No file manager session is running for '${game}'.`);
    this.name = 'NoSessionError';
  }
}

/** Whether `err` is a failed certificate pin, which must fail the session closed rather than be retried. */
function isPinMismatch(err: unknown): boolean {
  return err instanceof VolumeFileError && err.code === 'pin-mismatch';
}

/** Projects a layout onto the declared volumes a snapshot reports. */
function volumesOf(layout: HelperVolumeLayout): SessionVolumes {
  return [
    ...layout.mounts.map((m) => ({ name: m.volume, containerPath: m.containerPath, mounted: true })),
    ...layout.unmounted.map((u) => ({ name: u.volume, containerPath: u.containerPath, mounted: false })),
  ];
}

/**
 * Owns the one application-managed file-manager helper session per game, shared by the file browser page and folder
 * uploads.
 *
 * @remarks
 * Holders reference-count a session: the browse page's release starts a grace timer, an upload's release tears the
 * session down immediately once it is the last holder. The helper's credential and certificate live only in this
 * process and never appear on a {@link HelperSessionSnapshot} or in a log line.
 */
@Injectable()
export class HelperSessionRegistry {
  /** Overridable by tests. */
  readonly timings: HelperSessionTimings = {
    browseGraceMs: 5 * 60 * 1000,
    pollMs: 3000,
    helperIpTimeoutMs: 180000,
    loginTimeoutMs: 120000,
    helperPort: 8080,
  };

  private readonly entries = new Map<string, Entry>();
  /** Failure of the last launch or session per game, reported by {@link HelperSessionRegistry.status} until the next acquire. */
  private readonly lastError = new Map<string, string>();
  /** Volumes of the last session per game, so snapshots emitted after the entry is gone still list them. */
  private readonly lastVolumes = new Map<string, SessionVolumes>();
  private readonly stateListeners = new Set<(snapshot: HelperSessionSnapshot) => void>();
  private readonly beforeStopListeners = new Set<(game: string) => Promise<void> | void>();

  constructor(
    private readonly fileManager: FileManagerService,
    private readonly clients: FileBrowserClientFactory,
    private readonly publicIp: PublicIpService,
  ) {}

  /**
   * Adds `holder` to `game`'s session, launching the helper when none is owned, and resolves once it is ready.
   *
   * @remarks
   * Concurrent calls share one launch. A session that is being torn down is waited out first, then launched afresh.
   * An ECS helper this registry does not own yields `orphaned` and nothing is launched.
   *
   * @param game - Game to open the session for.
   * @param holder - Who is keeping the session alive.
   * @param options - Run id and task tags, used only when this call launches.
   * @returns `{ ok: true }` once connected, otherwise why the session could not be opened.
   */
  async acquire(game: string, holder: HelperHolder, options: AcquireOptions = {}): Promise<AcquireResult> {
    logger.debug('HelperSessionRegistry: acquire', { game, holder });
    for (;;) {
      const existing = this.entries.get(game);
      if (!existing) break;
      if (existing.state === 'stopping') {
        await existing.teardown;
        continue;
      }
      existing.holders.add(holder);
      this.cancelGrace(existing);
      return existing.ready;
    }

    this.lastError.delete(game);
    const entry: Entry = { runId: options.runId ?? BROWSE_RUN_ID, state: 'starting', holders: new Set([holder]), ready: Promise.resolve({ ok: true }) };
    this.entries.set(game, entry);
    entry.ready = this.launch(game, entry, options);
    this.emit(game, entry);
    return entry.ready;
  }

  /**
   * Re-holds `browse` on an existing session, cancelling its grace timer.
   *
   * @param game - Game whose session to re-attach to.
   * @returns `true` when a live session exists, `false` when there is nothing to attach to.
   */
  attach(game: string): boolean {
    const entry = this.entries.get(game);
    if (!entry || entry.state === 'stopping') return false;
    entry.holders.add('browse');
    this.cancelGrace(entry);
    return true;
  }

  /**
   * Drops `holder` from `game`'s session. Releasing `browse` always starts the grace timer, even while an upload still
   * holds the session; the last holder leaving stops the session immediately unless a grace timer is pending, in which
   * case the timer decides. An unknown game or holder is ignored.
   *
   * @param game - Game whose session to release.
   * @param holder - The holder to drop.
   */
  release(game: string, holder: HelperHolder): void {
    const entry = this.entries.get(game);
    if (!entry || entry.state === 'stopping' || !entry.holders.delete(holder)) return;
    logger.debug('HelperSessionRegistry: release', { game, holder });
    if (holder === 'browse') this.startGrace(game, entry);
    if (entry.holders.size > 0 || entry.graceTimer) return;
    void this.stopEntry(game, entry);
  }

  /**
   * Stops `game`'s helper: runs the before-stop listeners, closes the backend, and stops the ECS task. With no owned
   * session it stops an orphaned helper instead.
   *
   * @param game - Game whose helper to stop.
   * @returns Whether the helper is stopping, with a message for the operator.
   */
  async stop(game: string): Promise<{ success: boolean; message: string }> {
    logger.debug('HelperSessionRegistry: stop', { game });
    const entry = this.entries.get(game);
    if (entry) return this.stopEntry(game, entry);

    this.lastError.delete(game);
    try {
      if (!(await this.fileManager.listHelperTask(game))) return { success: true, message: `No file manager is running for '${game}'.` };
      return await this.fileManager.stop(game);
    } catch (err) {
      const message = errMessage(err);
      logger.warn('HelperSessionRegistry: could not stop an orphaned helper', { game, error: message });
      return { success: false, message };
    }
  }

  /**
   * Stops `game`'s helper and opens a fresh `browse` session.
   *
   * @param game - Game to restart the session for.
   * @returns The new session's {@link AcquireResult}.
   */
  async restart(game: string): Promise<AcquireResult> {
    logger.debug('HelperSessionRegistry: restart', { game });
    await this.stop(game);
    return this.acquire(game, 'browse');
  }

  /**
   * Reports `game`'s session state.
   *
   * @remarks
   * A `running` session whose ECS task is gone or replaced turns `failed` with ECS's stop reason, and the orphaned
   * security-group rule is revoked. A `failed` state persists until the next {@link HelperSessionRegistry.acquire}.
   *
   * @param game - Game to report on.
   * @returns A snapshot free of credentials and addresses.
   * @throws Error carrying only a message when the ECS lookup fails and no session is owned.
   */
  async status(game: string): Promise<HelperSessionSnapshot> {
    const entry = this.entries.get(game);
    if (!entry) return this.idleSnapshot(game);
    if (entry.state !== 'running') return this.snapshot(game, entry.state, entry);

    let task;
    try {
      task = await this.fileManager.listHelperTask(game);
    } catch (err) {
      logger.warn('HelperSessionRegistry: could not verify the helper task', { game, error: errMessage(err) });
      return this.snapshot(game, entry.state, entry);
    }
    if (this.entries.get(game) !== entry || entry.state !== 'running') return this.status(game);
    if (task && task.taskArn === entry.taskArn) return this.snapshot(game, 'running', entry);
    return this.failVanishedSession(game, entry, task);
  }

  /**
   * Runs `op` against the live backend of `game`'s session.
   *
   * @remarks
   * When `op` fails with `unreachable`, the operator's current public IP is detected; if it changed, the helper's
   * security-group rule is re-authorized for the new IP and `op` is retried exactly once. Concurrent operations that
   * all fail share one re-authorization. A certificate-pin mismatch fails the session closed (the helper is stopped so
   * its rule is revoked) and is rethrown. A recovery that cannot run rethrows the original error.
   *
   * @param game - Game whose session to use.
   * @param op - Receives the backend and the session's volume layout.
   * @returns Whatever `op` returns.
   * @throws {@link NoSessionError} when there is no running session.
   */
  async withBackend<T>(
    game: string,
    op: (backend: VolumeFileBackend, layout: HelperVolumeLayout) => Promise<T>,
  ): Promise<T> {
    const entry = this.entries.get(game);
    if (!entry) throw new NoSessionError(game);
    try {
      return await this.runOp(game, entry, op);
    } catch (err) {
      if (!(err instanceof VolumeFileError) || err.code !== 'unreachable' || !(await this.recoverOperatorIp(game, entry))) throw err;
      return this.runOp(game, entry, op);
    }
  }

  /** Runs `op` on `entry`'s running backend; a pin mismatch fails the session before it is rethrown. */
  private async runOp<T>(
    game: string,
    entry: Entry,
    op: (backend: VolumeFileBackend, layout: HelperVolumeLayout) => Promise<T>,
  ): Promise<T> {
    const { backend, layout } = entry;
    if (this.entries.get(game) !== entry || entry.state !== 'running' || !backend || !layout) throw new NoSessionError(game);
    try {
      return await op(backend, layout);
    } catch (err) {
      if (isPinMismatch(err)) await this.failOnPinMismatch(game, entry, errMessage(err));
      throw err;
    }
  }

  /** Fails `entry`'s session once however many operations hit the mismatch at the same time. */
  private failOnPinMismatch(game: string, entry: Entry, message: string): Promise<AcquireResult> {
    entry.failing ??= this.failSession(game, entry, message);
    return entry.failing;
  }

  /** Shares one {@link HelperSessionRegistry.reauthorizeIfChanged} per entry; resolves whether `op` is worth retrying. */
  private recoverOperatorIp(game: string, entry: Entry): Promise<boolean> {
    entry.recovery ??= this.reauthorizeIfChanged(game, entry).finally(() => {
      entry.recovery = undefined;
    });
    return entry.recovery;
  }

  /**
   * Detects the operator's current IP and, when it differs from the one the helper allows, re-authorizes the new one.
   * Never throws; a failed detection or re-authorization is logged and reported as "nothing recovered".
   */
  private async reauthorizeIfChanged(game: string, entry: Entry): Promise<boolean> {
    if (!entry.taskArn) return false;
    let current: string;
    try {
      current = await this.publicIp.detect();
    } catch (err) {
      logger.warn('HelperSessionRegistry: could not detect the operator IP', { game, error: errMessage(err) });
      return false;
    }
    if (current === entry.operatorIp) return false;
    try {
      await this.fileManager.reauthorizeOperatorIp(game, entry.runId, entry.taskArn, current);
    } catch (err) {
      logger.warn('HelperSessionRegistry: could not re-authorize the operator IP', { game, runId: entry.runId, error: errMessage(err) });
      return false;
    }
    entry.operatorIp = current;
    logger.info('HelperSessionRegistry: operator IP re-authorized', { game, runId: entry.runId, taskArn: entry.taskArn });
    return true;
  }

  /** The games this registry currently owns a session for. */
  ownedGames(): ReadonlySet<string> {
    return new Set(this.entries.keys());
  }

  /**
   * Subscribes to a snapshot on every session state change; a throwing listener is logged and skipped.
   *
   * @param listener - Receives each snapshot.
   * @returns The unsubscribe function.
   */
  onState(listener: (snapshot: HelperSessionSnapshot) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  /**
   * Subscribes to the moment a session is about to be torn down, before its backend closes; a throwing listener is
   * logged and does not stop the teardown.
   *
   * @param listener - Receives the game being stopped.
   * @returns The unsubscribe function.
   */
  onBeforeStop(listener: (game: string) => Promise<void> | void): () => void {
    this.beforeStopListeners.add(listener);
    return () => this.beforeStopListeners.delete(listener);
  }

  /** Stops every owned session; never throws. */
  async stopAll(): Promise<void> {
    await Promise.allSettled([...this.entries.keys()].map((game) => this.stop(game)));
  }

  /** Launch body behind the entry's `ready` promise: orphan check, launch, then readiness. */
  private async launch(game: string, entry: Entry, options: AcquireOptions): Promise<AcquireResult> {
    try {
      if (await this.fileManager.listHelperTask(game)) {
        return this.abandon(game, entry, 'orphaned', `A file manager for '${game}' is already running and is not managed by this app session.`);
      }
      const planned = await this.fileManager.planHelperLayout(game);
      if (!planned) return this.abandon(game, entry, 'not_deployed', 'Infrastructure not deployed. Deploy first.');
      entry.layout = planned;
      if (this.isStopping(entry)) return { ok: false, code: 'failed', message: STOPPED_BEFORE_READY };

      const outcome = await this.fileManager.launchHelper(game, { runId: entry.runId, tls: true, tags: options.tags, layout: planned });
      if (!outcome.ok) {
        if (outcome.code === 'helper-open') return this.abandon(game, entry, 'orphaned', outcome.message);
        return this.failSession(game, entry, outcome.message);
      }
      Object.assign(entry, {
        taskArn: outcome.taskArn,
        credentials: outcome.credentials,
        cert: outcome.cert,
        operatorIp: outcome.operatorIp,
        startedAt: outcome.startedAt,
        autoStopAt: outcome.autoStopAt,
        layout: outcome.layout,
      });
      logger.info('HelperSessionRegistry: helper launched', { game, runId: entry.runId, taskArn: outcome.taskArn });
      if (this.isStopping(entry)) return { ok: false, code: 'failed', message: STOPPED_BEFORE_READY };

      await this.waitUntilReady(game, entry);
      if (this.isSuperseded(game, entry)) return { ok: false, code: 'failed', message: STOPPED_BEFORE_READY };
      entry.state = 'running';
      this.emit(game, entry);
      return { ok: true };
    } catch (err) {
      return this.failSession(game, entry, await this.withStopReason(entry, errMessage(err)));
    }
  }

  /** Whether teardown began; a method so a narrowed `state` is re-read after each await. */
  private isStopping(entry: Entry): boolean {
    return entry.state === 'stopping';
  }

  /** Whether the entry was stopped or replaced; the readiness loops bail out so a stop never waits out their timeouts. */
  private isSuperseded(game: string, entry: Entry): boolean {
    return this.isStopping(entry) || this.entries.get(game) !== entry;
  }

  /**
   * Waits for the helper's public IP, builds the pinned-TLS backend, and retries login until it succeeds. Returns early,
   * unconnected, when the entry is stopped meanwhile; a pin mismatch aborts without retrying.
   */
  private async waitUntilReady(game: string, entry: Entry): Promise<void> {
    const { credentials, cert } = entry;
    if (!credentials || !cert) throw new Error('The file manager helper launched without a credential or certificate.');
    const host = await this.waitForHelperIp(game, entry);
    if (!host) return;
    entry.backend = this.clients.create({
      host,
      port: this.timings.helperPort,
      username: credentials.username,
      password: credentials.password,
      certPem: cert.certPem,
      fingerprint256: cert.fingerprint256,
    });
    await this.waitForLogin(game, entry, entry.backend);
  }

  /** Polls until the task exposes a public IP; `null` when the entry was superseded. A task that stopped first throws. */
  private async waitForHelperIp(game: string, entry: Entry): Promise<string | null> {
    const deadline = Date.now() + this.timings.helperIpTimeoutMs;
    logger.info('HelperSessionRegistry: waiting for the helper public IP', { game, runId: entry.runId, taskArn: entry.taskArn });
    for (;;) {
      if (this.isSuperseded(game, entry)) return null;
      const ip = await this.fileManager.getHelperPublicIp(game, entry.taskArn);
      if (ip) return ip;
      if (Date.now() > deadline) throw new Error('The file manager helper did not get a public IP in time.');
      await abortableSleep(this.timings.pollMs);
    }
  }

  /** Retries login while the container boots until `loginTimeoutMs`; a pin mismatch throws immediately (fail closed). */
  private async waitForLogin(game: string, entry: Entry, backend: VolumeFileBackend): Promise<void> {
    const deadline = Date.now() + this.timings.loginTimeoutMs;
    for (;;) {
      if (this.isSuperseded(game, entry)) return;
      try {
        await backend.connect();
        return;
      } catch (err) {
        if (isPinMismatch(err) || Date.now() > deadline) throw err;
      }
      await abortableSleep(this.timings.pollMs);
    }
  }

  /** Appends the helper container's ECS stop reason to `message` when the task died, so the failure names its cause. */
  private async withStopReason(entry: Entry, message: string): Promise<string> {
    if (!entry.taskArn || message.includes('stopped before it was reachable')) return message;
    try {
      const reason = await this.fileManager.getHelperStopReason(entry.taskArn);
      return reason ? `${message} (helper task stopped: ${reason})` : message;
    } catch (err) {
      logger.warn('HelperSessionRegistry: could not read the helper stop reason', { error: errMessage(err) });
      return message;
    }
  }

  /** Drops an entry that never launched (an orphan or an undeployed stack) and reports why. */
  private abandon(game: string, entry: Entry, code: 'orphaned' | 'not_deployed', message: string): AcquireResult {
    logger.info('HelperSessionRegistry: session not opened', { game, code });
    if (this.entries.get(game) === entry) {
      this.dropEntry(game, entry);
      this.emit(game, entry, code);
    }
    return { ok: false, code, message };
  }

  /**
   * Records a failed launch, readiness wait, or live session: closes the backend, stops a task that did launch so its
   * operator-IP rule is revoked, removes the entry, and keeps the error for {@link HelperSessionRegistry.status}.
   */
  private async failSession(game: string, entry: Entry, message: string): Promise<AcquireResult> {
    logger.warn('HelperSessionRegistry: session failed', { game, runId: entry.runId, taskArn: entry.taskArn, error: message });
    await this.closeBackend(game, entry);
    if (entry.taskArn) await this.stopBestEffort(game);
    if (entry.state !== 'stopping' && this.entries.get(game) === entry) {
      this.dropEntry(game, entry);
      this.lastError.set(game, message);
      this.emit(game, entry, 'failed', message);
    }
    return { ok: false, code: 'failed', message };
  }

  /**
   * Handles a `running` entry whose ECS task is gone or replaced: fails it with ECS's stop reason.
   *
   * @remarks
   * A gone task is stopped best-effort so its operator-IP rule is revoked. A different task is a helper this registry
   * does not own: it is left running and reported `orphaned` by the next status call, never stopped silently.
   */
  private async failVanishedSession(game: string, entry: Entry, current: { taskArn?: string } | null): Promise<HelperSessionSnapshot> {
    let reason: string | null = null;
    try {
      reason = entry.taskArn ? await this.fileManager.getHelperStopReason(entry.taskArn) : null;
    } catch (err) {
      logger.warn('HelperSessionRegistry: could not read the helper stop reason', { game, error: errMessage(err) });
    }
    const error = reason ? `The file manager helper stopped: ${reason}` : 'The file manager helper stopped unexpectedly.';
    logger.warn('HelperSessionRegistry: session task disappeared', { game, taskArn: entry.taskArn, reason });
    await this.closeBackend(game, entry);
    if (this.entries.get(game) === entry) {
      this.dropEntry(game, entry);
      if (!current) this.lastError.set(game, error);
      this.emit(game, entry, 'failed', error);
    }
    if (!current) await this.stopBestEffort(game);
    return this.snapshot(game, 'failed', entry, error);
  }

  /** Begins (or joins) the teardown of `entry`; resolves with the ECS stop result. */
  private stopEntry(game: string, entry: Entry): Promise<{ success: boolean; message: string }> {
    if (entry.teardown) return entry.teardown;
    this.cancelGrace(entry);
    const wasStarting = entry.state === 'starting';
    entry.state = 'stopping';
    this.lastError.delete(game);
    this.emit(game, entry);
    entry.teardown = this.runTeardown(game, entry, wasStarting);
    return entry.teardown;
  }

  private async runTeardown(game: string, entry: Entry, wasStarting: boolean): Promise<{ success: boolean; message: string }> {
    if (wasStarting) await entry.ready;
    for (const listener of [...this.beforeStopListeners]) {
      try {
        await listener(game);
      } catch (err) {
        logger.warn('HelperSessionRegistry: before-stop listener failed', { game, error: errMessage(err) });
      }
    }
    await this.closeBackend(game, entry);
    let result: { success: boolean; message: string };
    try {
      const stopped = await this.fileManager.stop(game);
      result = { success: stopped.success, message: stopped.message };
    } catch (err) {
      const message = errMessage(err);
      logger.warn('HelperSessionRegistry: stopping the helper failed', { game, error: message });
      result = { success: false, message };
    }
    if (this.entries.get(game) === entry) this.dropEntry(game, entry);
    this.emit(game, entry, 'stopped');
    return result;
  }

  /** Stops `game`'s ECS helper, logging rather than throwing; used where the caller is already reporting another failure. */
  private async stopBestEffort(game: string): Promise<void> {
    try {
      await this.fileManager.stop(game);
    } catch (err) {
      logger.warn('HelperSessionRegistry: best-effort helper stop failed', { game, error: errMessage(err) });
    }
  }

  /** Closes and forgets `entry`'s backend; a close error is logged only. */
  private async closeBackend(game: string, entry: Entry): Promise<void> {
    const { backend } = entry;
    entry.backend = undefined;
    if (!backend) return;
    try {
      await backend.close();
    } catch (err) {
      logger.warn('HelperSessionRegistry: closing the backend failed', { game, error: errMessage(err) });
    }
  }

  /** Removes `entry` from the registry, remembering its volumes for later snapshots. */
  private dropEntry(game: string, entry: Entry): void {
    this.cancelGrace(entry);
    if (entry.layout) this.lastVolumes.set(game, volumesOf(entry.layout));
    this.entries.delete(game);
  }

  private startGrace(game: string, entry: Entry): void {
    this.cancelGrace(entry);
    entry.graceTimer = setTimeout(() => {
      entry.graceTimer = undefined;
      if (this.entries.get(game) !== entry || entry.holders.size > 0) return;
      logger.info('HelperSessionRegistry: browse grace period elapsed', { game });
      void this.stopEntry(game, entry);
    }, this.timings.browseGraceMs);
  }

  private cancelGrace(entry: Entry): void {
    if (entry.graceTimer) clearTimeout(entry.graceTimer);
    entry.graceTimer = undefined;
  }

  /** Notifies state listeners; `state` defaults to the entry's own. */
  private emit(game: string, entry: Entry, state: HelperSessionState = entry.state, error?: string): void {
    const snapshot = this.snapshot(game, state, entry, error);
    for (const listener of [...this.stateListeners]) {
      try {
        listener(snapshot);
      } catch (err) {
        logger.warn('HelperSessionRegistry: state listener failed', { game, error: errMessage(err) });
      }
    }
  }

  /** Builds the caller-visible snapshot of `entry`; only the fields a snapshot is allowed to carry are read. */
  private snapshot(game: string, state: HelperSessionState, entry: Entry, error?: string): HelperSessionSnapshot {
    const holders = [...entry.holders];
    return {
      game,
      state,
      ...(entry.startedAt !== undefined && { startedAt: entry.startedAt }),
      ...(entry.autoStopAt !== undefined && { autoStopAt: entry.autoStopAt }),
      browseHeld: holders.includes('browse'),
      uploadHolders: holders.filter((h) => h !== 'browse').length,
      ...(error !== undefined && { error }),
      supportsArchive: typeof entry.backend?.archiveStream === 'function',
      volumes: entry.layout ? volumesOf(entry.layout) : (this.lastVolumes.get(game) ?? []),
    };
  }

  /** Snapshot for a game with no owned session: a kept failure, an undeployed stack, an orphaned helper, or stopped. */
  private async idleSnapshot(game: string): Promise<HelperSessionSnapshot> {
    const base = { game, browseHeld: false, uploadHolders: 0, supportsArchive: false };
    try {
      const layout = await this.fileManager.planHelperLayout(game);
      const volumes = layout ? volumesOf(layout) : [];
      const error = this.lastError.get(game);
      if (error !== undefined) return { ...base, state: 'failed', error, volumes };
      if (!layout) return { ...base, state: 'not_deployed', volumes };
      const task = await this.fileManager.listHelperTask(game);
      return { ...base, state: task ? 'orphaned' : 'stopped', volumes };
    } catch (err) {
      const message = errMessage(err);
      logger.warn('HelperSessionRegistry: could not read the helper state', { game, error: message });
      throw new Error(message);
    }
  }
}
