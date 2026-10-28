import 'reflect-metadata';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GameServer } from '@hyveon/shared';
import type { FolderUploadProgress, FolderUploadStartResult } from '@hyveon/shared/folderUpload';

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { FolderUploadService } from './FolderUploadService.js';
import { FolderScanService } from './FolderScanService.js';
import { NativeDialogService } from './NativeDialogService.js';
import { ElectronStoreService } from './ElectronStoreService.js';
import { SafeStorageService } from './SafeStorageService.js';
import type { EcsService } from './EcsService.js';
import { UPLOAD_TAGS, type FileManagerService } from './FileManagerService.js';
import type { AcquireResult, HelperSessionRegistry, HelperSessionSnapshot, HelperSessionState } from './volumeFiles/HelperSessionRegistry.js';
import { VolumeFileError, type VolumeFileBackend, type WriteOptions } from './volumeFiles/VolumeFileBackend.js';
import { configServiceStub } from '../testing/config-service.fixture.js';
import { configAndSavesVolumes, deploymentConfigStub, gameServer } from '../testing/deployment-config.fixture.js';
import { stackOutputs } from '../testing/stack-outputs.fixture.js';
import { fakeBackend, type FakeBackend } from '../testing/fake-volume-backend.js';
import { buildHelperVolumeLayout, type HelperVolumeLayout } from './volumeFiles/helperVolumeLayout.js';

let root: string;
let scans: FolderScanService;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'fus-'));
  await mkdir(join(root, 'Config'));
  await mkdir(join(root, 'Data'));
  await mkdir(join(root, 'Logs'));
  await writeFile(join(root, 'Config', 'a.json'), 'aaaa');
  await writeFile(join(root, 'Data', 'b.db'), 'bbbbbbbb');
  await writeFile(join(root, 'Logs', 'c.log'), 'cc');
  scans = new FolderScanService(new NativeDialogService());
});
afterEach(() => rm(root, { recursive: true, force: true }));

interface Harness {
  svc: FolderUploadService;
  client: FakeBackend;
  fm: { planHelperLayout: ReturnType<typeof vi.fn>; sweepStrayHelpers: ReturnType<typeof vi.fn> };
  registry: {
    acquire: ReturnType<typeof vi.fn<HelperSessionRegistry['acquire']>>;
    release: ReturnType<typeof vi.fn<HelperSessionRegistry['release']>>;
    status: ReturnType<typeof vi.fn<HelperSessionRegistry['status']>>;
    ownedGames: ReturnType<typeof vi.fn<HelperSessionRegistry['ownedGames']>>;
    withBackend: ReturnType<typeof vi.fn>;
  };
  /** The listener the service registered with `onBeforeStop`. */
  beforeStop: (game: string) => void;
  ecs: { findRunningTaskOrThrow: ReturnType<typeof vi.fn> };
  store: ElectronStoreService;
  progress: FolderUploadProgress[];
}

/** A registry snapshot in `state`, carrying only what the service reads. */
function snapshot(state: HelperSessionState): HelperSessionSnapshot {
  return { game: 'minecraft', state, browseHeld: false, uploadHolders: 0, supportsArchive: false, volumes: [] };
}

/**
 * Builds the service under test with happy-path collaborators; `acquired` overrides the registry's acquire result,
 * `sessionLayout` the layout the live session reports, and `volumes` the game's declared volumes. The preflight layout
 * is planned from `outputs` by the real planner, as `FileManagerService` does.
 */
function harness(
  options: {
    client?: FakeBackend;
    acquired?: AcquireResult;
    sessionLayout?: (planned: HelperVolumeLayout) => HelperVolumeLayout;
    outputs?: ReturnType<typeof stackOutputs> | null;
    volumes?: GameServer['volumes'];
  } = {},
): Harness {
  const client = options.client ?? fakeBackend();
  const volumes = options.volumes ?? [{ name: 'saves', container_path: '/data' }];
  const outputs =
    options.outputs === undefined
      ? stackOutputs({ efsAccessPoints: { minecraft: 'fsap' }, efsVolumeAccessPoints: { minecraft: { saves: 'fsap' } } })
      : options.outputs;
  const planned = outputs ? buildHelperVolumeLayout('minecraft', volumes, outputs) : null;
  const sessionLayout = planned && options.sessionLayout ? options.sessionLayout(planned) : planned;
  const fm = {
    planHelperLayout: vi.fn(async () => planned),
    sweepStrayHelpers: vi.fn().mockResolvedValue({ stopped: [], skipped: 0, revokedRules: 0, errors: [] }),
  };
  let beforeStop: Harness['beforeStop'] = () => undefined;
  const registry: Harness['registry'] = {
    acquire: vi.fn(async () => options.acquired ?? { ok: true }),
    release: vi.fn(),
    status: vi.fn(async () => snapshot('stopped')),
    ownedGames: vi.fn(() => new Set<string>()),
    withBackend: vi.fn(async (_game: string, op: (b: VolumeFileBackend, l: HelperVolumeLayout | null) => Promise<unknown>) => op(client, sessionLayout)),
  };
  const ecs = { findRunningTaskOrThrow: vi.fn().mockResolvedValue(null) };
  const store = new ElectronStoreService(new SafeStorageService());
  const svc = new FolderUploadService(
    configServiceStub({ outputs }),
    deploymentConfigStub({ declared: [gameServer('minecraft', { volumes })] }),
    ecs as Partial<EcsService> as EcsService,
    fm as Partial<FileManagerService> as FileManagerService,
    scans,
    store,
    {
      ...registry,
      onBeforeStop: (listener: (game: string) => void) => {
        beforeStop = listener;
        return () => undefined;
      },
    } as Partial<HelperSessionRegistry> as HelperSessionRegistry,
  );
  svc.engine.sleep = async () => undefined;
  const progress: FolderUploadProgress[] = [];
  svc.onProgress((p) => progress.push(p));
  return { svc, client, fm, ecs, store, progress, registry, beforeStop: (game) => beforeStop(game) };
}

/** Waits until the terminal progress snapshot for a run has been published. */
async function settled(h: Harness): Promise<FolderUploadProgress> {
  await vi.waitFor(() => {
    const last = h.progress.at(-1);
    expect(last && ['done', 'failed', 'cancelled'].includes(last.phase)).toBe(true);
  });
  return h.progress.at(-1)!;
}

/** The run id of a started upload; fails the test when the start was refused. */
function runIdOf(res: FolderUploadStartResult): string {
  if (!res.started) throw new Error(`expected the upload to start, got: ${res.error}`);
  return res.runId;
}

/** Scans the temp folder and builds a request including the given relPaths. */
async function request(include: string[], destination = '/data') {
  const scan = await scans.scan(root);
  return { game: 'minecraft', scanId: scan.scanId, include, destination };
}

describe('FolderUploadService guards', () => {
  it('should refuse when the game is not deployed and keep the selection', async () => {
    const h = harness({ outputs: null });
    const res = await h.svc.startUpload(await request(['Config']));
    expect(res).toMatchObject({ started: false, error: expect.stringMatching(/not deployed/) });
    expect(h.registry.acquire).not.toHaveBeenCalled();
  });

  it("should target the second volume's mount for a second-volume destination", async () => {
    await writeFile(join(root, 'a.db'), 'x');
    const h = harness({
      volumes: configAndSavesVolumes(),
      outputs: stackOutputs({ efsVolumeAccessPoints: { minecraft: { config: 'fsap-c', saves: 'fsap-s' } } }),
    });
    expect((await h.svc.startUpload(await request(['a.db'], '/data/saves/worlds'))).started).toBe(true);
    await settled(h);
    expect(h.client.uploads).toEqual(['/saves/worlds/a.db']);
  });

  it("should map remote paths through the live session's layout rather than the preflight one", async () => {
    const h = harness({
      sessionLayout: (planned) => ({ ...planned, mounts: planned.mounts.map((m) => ({ ...m, dir: 'moved' })) }),
    });
    expect((await h.svc.startUpload(await request(['Config']))).started).toBe(true);
    await settled(h);
    expect(h.client.uploads).toEqual(['/moved/Config/a.json']);
  });

  it('should fail before writing when the live session does not mount the destination volume', async () => {
    const h = harness({
      volumes: configAndSavesVolumes(),
      outputs: stackOutputs({ efsVolumeAccessPoints: { minecraft: { config: 'fsap-c', saves: 'fsap-s' } } }),
      sessionLayout: (planned) => ({ ...planned, mounts: planned.mounts.filter((m) => m.volume === 'config') }),
    });
    await h.svc.startUpload(await request(['Config'], '/data/saves'));
    const last = await settled(h);
    expect(last).toMatchObject({ phase: 'failed', error: "Stop and start the file manager session to upload into 'saves'." });
    expect(h.client.mkdir).not.toHaveBeenCalled();
    expect(h.client.writeStream).not.toHaveBeenCalled();
    expect(h.registry.release).toHaveBeenCalledTimes(1);
  });

  it('should fail before writing when the live session used the legacy fallback layout', async () => {
    const h = harness({ sessionLayout: (planned) => ({ ...planned, usedFallback: true }) });
    await h.svc.startUpload(await request(['Config']));
    expect(await settled(h)).toMatchObject({ phase: 'failed', error: "Stop and start the file manager session to upload into 'saves'." });
    expect(h.client.writeStream).not.toHaveBeenCalled();
  });

  it('should refuse before launch when the destination volume is not mounted', async () => {
    const h = harness({
      volumes: configAndSavesVolumes(),
      outputs: stackOutputs({ efsAccessPoints: { minecraft: 'fsap' }, efsVolumeAccessPoints: {} }),
    });
    const res = await h.svc.startUpload(await request(['Config'], '/data/saves'));
    expect(res).toMatchObject({ started: false, error: expect.stringContaining("Apply the infrastructure to upload into 'saves'") });
    expect(h.ecs.findRunningTaskOrThrow).not.toHaveBeenCalled();
    expect(h.registry.acquire).not.toHaveBeenCalled();
  });

  it('should refuse an upload into the first volume when the layout is the legacy fallback', async () => {
    const h = harness({
      volumes: configAndSavesVolumes(),
      outputs: stackOutputs({ efsAccessPoints: { minecraft: 'fsap' }, efsVolumeAccessPoints: {} }),
    });
    const res = await h.svc.startUpload(await request(['Config'], '/data/config'));
    expect(res).toMatchObject({ started: false, error: expect.stringContaining("Apply the infrastructure to upload into 'config'") });
    expect(h.ecs.findRunningTaskOrThrow).not.toHaveBeenCalled();
    expect(h.registry.acquire).not.toHaveBeenCalled();
  });

  it('should refuse when the game server task is running', async () => {
    const h = harness();
    h.ecs.findRunningTaskOrThrow.mockResolvedValue({ taskArn: 'x' });
    expect(await h.svc.startUpload(await request(['Config']))).toMatchObject({ started: false, error: expect.stringMatching(/Stop the server/) });
    expect(h.registry.acquire).not.toHaveBeenCalled();
  });

  it("should refuse the upload when the server state can't be confirmed", async () => {
    const h = harness();
    h.ecs.findRunningTaskOrThrow.mockRejectedValue(new Error('ListTasks failed'));
    expect(await h.svc.startUpload(await request(['Config']))).toEqual({
      started: false,
      error: "Couldn't confirm 'minecraft' is stopped. Try again in a moment.",
    });
    expect(h.registry.acquire).not.toHaveBeenCalled();
  });

  it('should refuse with a restart message when an orphaned helper exists', async () => {
    const h = harness();
    h.registry.status.mockResolvedValue(snapshot('orphaned'));
    expect(await h.svc.startUpload(await request(['Config']))).toMatchObject({
      started: false,
      error: expect.stringMatching(/already open.*Restart/),
    });
    expect(h.registry.acquire).not.toHaveBeenCalled();
    expect(h.registry.release).not.toHaveBeenCalled();
  });

  it('should reuse the browse session instead of refusing', async () => {
    const h = harness();
    h.registry.status.mockResolvedValue(snapshot('running'));
    const res = await h.svc.startUpload(await request(['Config']));
    expect(res).toMatchObject({ started: true });
    await settled(h);
    const runId = res.started ? res.runId : '';
    expect(h.registry.acquire).toHaveBeenCalledWith('minecraft', `upload:${runId}`, expect.objectContaining({ runId }));
  });

  it('should refuse a second overlapping start for the same game while the first is still preparing', async () => {
    const h = harness();
    let release!: (task: null) => void;
    h.ecs.findRunningTaskOrThrow.mockReturnValueOnce(new Promise<null>((resolve) => { release = resolve; }));
    const req = await request(['Config']);
    const first = h.svc.startUpload(req);
    const second = await h.svc.startUpload(req);
    expect(second).toEqual({ started: false, error: "An upload is already starting for 'minecraft'." });
    release(null);
    expect(await first).toMatchObject({ started: true });
    await settled(h);
    expect(h.registry.acquire).toHaveBeenCalledTimes(1);
  });

  it('should allow a new start after a refused one released the reservation', async () => {
    const h = harness();
    h.ecs.findRunningTaskOrThrow.mockResolvedValueOnce({ taskArn: 'x' });
    const req = await request(['Config']);
    expect(await h.svc.startUpload(req)).toMatchObject({ started: false, error: expect.stringMatching(/Stop the server/) });
    expect(await h.svc.startUpload(req)).toMatchObject({ started: true });
    await settled(h);
  });

  it('should refuse a destination outside the game volumes', async () => {
    const h = harness();
    expect(await h.svc.startUpload(await request(['Config'], '/etc'))).toMatchObject({ started: false });
  });

  it('should reject a path-traversal entry before any request or launch', async () => {
    const h = harness();
    const req = await request(['Config']);
    const held = scans.get(req.scanId)!;
    held.tree.children![0]!.children![0]!.relPath = '../../etc/passwd';
    const res = await h.svc.startUpload(req);
    expect(res).toMatchObject({ started: false, error: expect.stringMatching(/Invalid relative path/) });
    expect(h.registry.acquire).not.toHaveBeenCalled();
    expect(h.registry.withBackend).not.toHaveBeenCalled();
  });

  it('should refuse an empty selection and an expired scan', async () => {
    const h = harness();
    expect(await h.svc.startUpload(await request([]))).toMatchObject({ started: false, error: expect.stringMatching(/Nothing is selected/) });
    expect(await h.svc.startUpload({ game: 'minecraft', scanId: 'gone', include: ['Config'], destination: '/data' })).toMatchObject({
      started: false,
      error: expect.stringMatching(/expired/),
    });
  });

  it('should refuse a second concurrent run for the same game', async () => {
    const h = harness();
    let ready!: (result: AcquireResult) => void;
    h.registry.acquire.mockReturnValue(new Promise<AcquireResult>((resolve) => { ready = resolve; }));
    expect((await h.svc.startUpload(await request(['Config']))).started).toBe(true);
    expect(await h.svc.startUpload(await request(['Config']))).toMatchObject({ started: false, error: expect.stringMatching(/already running/) });
    h.svc.cancel('minecraft');
    ready({ ok: true });
    await settled(h);
  });
});

describe('FolderUploadService runs', () => {
  it('should upload only the included entries to the stripped remote paths, verify, and stop the helper', async () => {
    const h = harness();
    const res = await h.svc.startUpload(await request(['Config', 'Data']));
    const runId = runIdOf(res);
    const last = await settled(h);
    expect(last).toMatchObject({ phase: 'done', filesDone: 2, filesTotal: 2, bytesDone: 12, bytesTotal: 12 });
    expect(h.client.uploads.sort()).toEqual(['/saves/Config/a.json', '/saves/Data/b.db']);
    expect(h.registry.acquire).toHaveBeenCalledWith('minecraft', `upload:${runId}`, { tags: UPLOAD_TAGS, runId });
    expect(h.registry.release).toHaveBeenCalledWith('minecraft', `upload:${runId}`);
    expect(h.svc.getSelection('minecraft')).toMatchObject({ include: ['Config', 'Data'], destination: '/data', lastRun: { status: 'done', files: 2, bytes: 12 } });
    expect(h.progress.map((p) => p.phase)).toEqual(expect.arrayContaining(['starting-helper', 'uploading', 'verifying', 'done']));
  });

  it('should report 100% only in the done phase, after the session was released', async () => {
    const h = harness();
    const order: string[] = [];
    h.registry.release.mockImplementation(() => {
      order.push('release');
    });
    h.svc.onProgress((p) => p.phase === 'done' && order.push('done'));
    await h.svc.startUpload(await request(['Config']));
    await settled(h);
    expect(order.slice(0, 2)).toEqual(['release', 'done']);
  });

  it('should skip files already on the volume with the right size when resuming', async () => {
    const client = fakeBackend();
    client.sizes.set('/saves/Config/a.json', 4);
    const h = harness({ client });
    await h.svc.startUpload(await request(['Config', 'Data']));
    const last = await settled(h);
    expect(client.uploads).toEqual(['/saves/Data/b.db']);
    expect(last).toMatchObject({ phase: 'done', filesDone: 2, bytesDone: 12 });
  });

  it('should fail with the path when a file keeps failing, persist a failed last run, and still release the session', async () => {
    const client = fakeBackend({
      writeStream: async () => {
        throw new Error('socket hang up');
      },
    });
    const h = harness({ client });
    await h.svc.startUpload(await request(['Config']));
    const last = await settled(h);
    expect(last).toMatchObject({ phase: 'failed', error: expect.stringContaining('Config/a.json') });
    expect(h.registry.release).toHaveBeenCalledTimes(1);
    expect(h.svc.getSelection('minecraft')?.lastRun?.status).toBe('failed');
  });

  it('should fail with a resumable error when the helper expires mid-run (connections refused) and release the session', async () => {
    let calls = 0;
    const client = fakeBackend({
      writeStream: async (remotePath, _source, { onBytes, size }) => {
        calls += 1;
        if (calls > 1) throw new Error('connect ECONNREFUSED 9.9.9.9:8080');
        onBytes?.(size);
        client.sizes.set(remotePath, size);
      },
    });
    const h = harness({ client });
    await h.svc.startUpload(await request(['Config', 'Data']));
    const last = await settled(h);
    expect(last.phase).toBe('failed');
    expect(last.error).toMatch(/ECONNREFUSED/);
    expect(h.registry.release).toHaveBeenCalledTimes(1);
    expect(h.svc.getSelection('minecraft')?.lastRun).toMatchObject({ status: 'failed', files: 1 });
  });

  it('should fail verification listing the missing path', async () => {
    const client = fakeBackend();
    const original = client.writeStream;
    client.writeStream = async (path, source, options) => {
      if (path.endsWith('b.db')) return options.onBytes?.(options.size);
      return original(path, source, options);
    };
    const h = harness({ client });
    await h.svc.startUpload(await request(['Config', 'Data']));
    const last = await settled(h);
    expect(last).toMatchObject({ phase: 'failed', error: expect.stringContaining('Data/b.db (missing)') });
  });

  it('should cancel mid-run, release the session, and record a cancelled last run', async () => {
    const writeStream = vi.fn(
      (_path: string, _source: Readable, { signal }: WriteOptions) =>
        new Promise<void>((_res, rej) => {
          signal?.addEventListener('abort', () => rej(new Error('aborted')));
        }),
    );
    const client = fakeBackend({ writeStream });
    const h = harness({ client });
    await h.svc.startUpload(await request(['Config', 'Data']));
    await vi.waitFor(() => expect(h.progress.some((p) => p.phase === 'uploading')).toBe(true));
    await vi.waitFor(() => expect(writeStream).toHaveBeenCalled());
    expect(h.svc.cancel('minecraft')).toEqual({ cancelled: true });
    const last = await settled(h);
    expect(last.phase).toBe('cancelled');
    expect(h.registry.release).toHaveBeenCalledTimes(1);
    expect(h.svc.getSelection('minecraft')?.lastRun?.status).toBe('cancelled');
  });

  it('should cancel while the helper is still booting, without waiting for acquire, and release its hold', async () => {
    const h = harness();
    h.registry.acquire.mockReturnValue(new Promise<AcquireResult>(() => undefined));
    const runId = runIdOf(await h.svc.startUpload(await request(['Config'])));
    await vi.waitFor(() => expect(h.registry.acquire).toHaveBeenCalled());
    h.svc.cancel('minecraft');
    expect((await settled(h)).phase).toBe('cancelled');
    expect(h.registry.release).toHaveBeenCalledWith('minecraft', `upload:${runId}`);
    expect(h.client.writeStream).not.toHaveBeenCalled();
  });

  it('should append the helper stop reason when a run fails after the helper died', async () => {
    const writeStream = vi.fn().mockRejectedValue(new VolumeFileError('failed', 'ECONNRESET'));
    const h = harness({ client: fakeBackend({ writeStream }) });
    h.registry.status.mockResolvedValue({ ...snapshot('failed'), error: 'The file manager helper stopped: OutOfMemoryError: Container killed' });
    await h.svc.startUpload(await request(['Config']));
    const last = await settled(h);
    expect(last.phase).toBe('failed');
    expect(last.error).toContain('ECONNRESET');
    expect(last.error).toContain('The file manager helper stopped: OutOfMemoryError: Container killed');
    expect(h.registry.release).toHaveBeenCalledTimes(1);
  });

  it('should cancel the run when the session is force-stopped', async () => {
    const writeStream = vi.fn(
      (_path: string, _source: Readable, { signal }: WriteOptions) =>
        new Promise<void>((_res, rej) => {
          signal?.addEventListener('abort', () => rej(new Error('aborted')));
        }),
    );
    const h = harness({ client: fakeBackend({ writeStream }) });
    await h.svc.startUpload(await request(['Config']));
    await vi.waitFor(() => expect(writeStream).toHaveBeenCalled());
    h.beforeStop('minecraft');
    expect((await settled(h)).phase).toBe('cancelled');
  });

  it('should not cancel a run of another game when a different session is force-stopped', async () => {
    const h = harness();
    h.beforeStop('valheim');
    expect(h.svc.cancel('minecraft')).toEqual({ cancelled: false });
  });

  it('should release its hold on success, failure and cancel', async () => {
    const failing = harness({ acquired: { ok: false, code: 'failed', message: 'launch failed' } });
    const failedId = runIdOf(await failing.svc.startUpload(await request(['Config'])));
    expect(await settled(failing)).toMatchObject({ phase: 'failed' });
    expect(failing.registry.release).toHaveBeenCalledWith('minecraft', `upload:${failedId}`);

    const ok = harness();
    const doneId = runIdOf(await ok.svc.startUpload(await request(['Config'])));
    expect((await settled(ok)).phase).toBe('done');
    expect(ok.registry.release).toHaveBeenCalledWith('minecraft', `upload:${doneId}`);

    const cancelled = harness({ client: conflictedClient() });
    const cancelledId = runIdOf(await cancelled.svc.startUpload(await request(['Config'])));
    await reached(cancelled, 'awaiting-confirmation');
    cancelled.svc.cancel('minecraft');
    expect((await settled(cancelled)).phase).toBe('cancelled');
    expect(cancelled.registry.release).toHaveBeenCalledWith('minecraft', `upload:${cancelledId}`);
  });

  it("should fail with the registry's message when the session cannot be opened", async () => {
    const h = harness({ acquired: { ok: false, code: 'failed', message: 'pull failed (helper task stopped: OutOfMemoryError)' } });
    await h.svc.startUpload(await request(['Config']));
    expect(await settled(h)).toMatchObject({ phase: 'failed', error: 'pull failed (helper task stopped: OutOfMemoryError)' });
    expect(h.registry.withBackend).not.toHaveBeenCalled();
  });

  it('should free the game for a new run after a run ends', async () => {
    const h = harness();
    await h.svc.startUpload(await request(['Config']));
    await settled(h);
    h.progress.length = 0;
    expect((await h.svc.startUpload(await request(['Config']))).started).toBe(true);
    await settled(h);
  });
});

/** Waits until a snapshot in the given phase has been published. */
async function reached(h: Harness, phase: FolderUploadProgress['phase']): Promise<FolderUploadProgress> {
  await vi.waitFor(() => expect(h.progress.some((p) => p.phase === phase)).toBe(true));
  return h.progress.find((p) => p.phase === phase)!;
}

/** A volume already holding a different-size `a.json`, an identical `b.db`, and an unrelated file in `Config`. */
function conflictedClient(): FakeBackend {
  const client = fakeBackend();
  client.sizes.set('/saves/Config/a.json', 1);
  client.sizes.set('/saves/Config/old.cfg', 7);
  client.sizes.set('/saves/Data/b.db', 8);
  return client;
}

describe('FolderUploadService overwrite confirmation', () => {
  it('should pause with a summary before writing anything and upload only after the operator confirms', async () => {
    const client = conflictedClient();
    const h = harness({ client });
    await h.svc.startUpload(await request(['Config', 'Data']));

    const waiting = await reached(h, 'awaiting-confirmation');
    expect(waiting.overwrite).toEqual({
      conflictCount: 1,
      identicalCount: 1,
      newCount: 0,
      otherExistingCount: 1,
      samples: [{ relPath: 'Config/a.json', existingSize: 1, newSize: 4 }],
    });
    expect(client.mkdir).not.toHaveBeenCalled();
    expect(client.writeStream).not.toHaveBeenCalled();
    expect(h.registry.release).not.toHaveBeenCalled();
    expect(h.svc.getProgress('minecraft')?.phase).toBe('awaiting-confirmation');

    expect(h.svc.confirmOverwrite('minecraft', true)).toEqual({ resolved: true });
    const last = await settled(h);
    expect(last).toMatchObject({ phase: 'done' });
    expect(client.uploads).toEqual(['/saves/Config/a.json']);
    expect(h.progress.find((p) => p.phase === 'uploading')?.overwrite).toBeUndefined();
  });

  it('should cancel cleanly with nothing written and the helper stopped when the operator declines', async () => {
    const client = conflictedClient();
    const h = harness({ client });
    await h.svc.startUpload(await request(['Config', 'Data']));
    await reached(h, 'awaiting-confirmation');

    expect(h.svc.confirmOverwrite('minecraft', false)).toEqual({ resolved: true });
    const last = await settled(h);
    expect(last.phase).toBe('cancelled');
    expect(last.error).toBeUndefined();
    expect(client.mkdir).not.toHaveBeenCalled();
    expect(client.writeStream).not.toHaveBeenCalled();
    expect(h.registry.release).toHaveBeenCalledTimes(1);
    expect(h.svc.getSelection('minecraft')?.lastRun?.status).toBe('cancelled');
  });

  it('should treat Cancel while waiting as a decline', async () => {
    const h = harness({ client: conflictedClient() });
    await h.svc.startUpload(await request(['Config']));
    await reached(h, 'awaiting-confirmation');
    h.svc.cancel('minecraft');
    expect((await settled(h)).phase).toBe('cancelled');
    expect(h.registry.release).toHaveBeenCalledTimes(1);
    expect(h.svc.confirmOverwrite('minecraft', true)).toEqual({ resolved: false });
  });

  it('should cancel with a reason and stop the helper when nobody answers before the timeout', async () => {
    const client = conflictedClient();
    const h = harness({ client });
    h.svc.timings.confirmationTimeoutMs = 20;
    await h.svc.startUpload(await request(['Config']));
    const last = await settled(h);
    expect(last).toMatchObject({ phase: 'cancelled', error: expect.stringMatching(/Timed out/) });
    expect(client.writeStream).not.toHaveBeenCalled();
    expect(h.registry.release).toHaveBeenCalledTimes(1);
  });

  it('should not prompt when nothing on the volume would be overwritten', async () => {
    const client = fakeBackend();
    client.sizes.set('/saves/Config/a.json', 4);
    client.sizes.set('/saves/Config/other.cfg', 9);
    const h = harness({ client });
    await h.svc.startUpload(await request(['Config']));
    expect((await settled(h)).phase).toBe('done');
    expect(h.progress.some((p) => p.phase === 'awaiting-confirmation')).toBe(false);
  });

  it('should resolve nothing when no run is awaiting an answer', async () => {
    const h = harness();
    expect(h.svc.confirmOverwrite('minecraft', true)).toEqual({ resolved: false });
  });

  describe('resuming this app\'s own cut-short run', () => {
    /** Persists the selection and a failed last run that had copied one file. */
    async function afterFailedRun(h: Harness, include: string[]) {
      h.svc.setSelection(await request(include));
      h.store.setFolderUploadLastRun('minecraft', { status: 'failed', completedAt: '2026-01-01T00:00:00.000Z', files: 1, bytes: 4 });
    }

    it('should not prompt for a few partial files from the previous run of the same selection', async () => {
      const client = conflictedClient();
      const h = harness({ client });
      await afterFailedRun(h, ['Config', 'Data']);
      await h.svc.startUpload(await request(['Config', 'Data']));
      expect((await settled(h)).phase).toBe('done');
      expect(h.progress.some((p) => p.phase === 'awaiting-confirmation')).toBe(false);
    });

    it('should prompt when conflicts exceed the files that could have been mid-flight', async () => {
      const client = conflictedClient();
      client.sizes.set('/saves/Data/b.db', 3);
      const h = harness({ client });
      h.svc.engine.concurrency = 1;
      await afterFailedRun(h, ['Config', 'Data']);
      await h.svc.startUpload(await request(['Config', 'Data']));
      expect((await reached(h, 'awaiting-confirmation')).overwrite?.conflictCount).toBe(2);
      h.svc.cancel('minecraft');
      await settled(h);
    });

    it.each([
      ['a different selection', ['Config'], '/data'],
      ['a different destination', ['Config', 'Data'], '/data/sub'],
    ])('should still prompt for %s', async (_label, include, destination) => {
      const client = fakeBackend();
      client.sizes.set(destination === '/data' ? '/saves/Config/a.json' : '/saves/sub/Config/a.json', 1);
      const h = harness({ client });
      await afterFailedRun(h, ['Config', 'Data']);
      await h.svc.startUpload(await request(include, destination));
      await reached(h, 'awaiting-confirmation');
      h.svc.cancel('minecraft');
      await settled(h);
    });

    it('should prompt after a completed run since the existing files are not partial uploads', async () => {
      const h = harness({ client: conflictedClient() });
      h.svc.setSelection(await request(['Config', 'Data']));
      h.store.setFolderUploadLastRun('minecraft', { status: 'done', completedAt: '2026-01-01T00:00:00.000Z', files: 2, bytes: 12 });
      await h.svc.startUpload(await request(['Config', 'Data']));
      await reached(h, 'awaiting-confirmation');
      h.svc.cancel('minecraft');
      await settled(h);
    });
  });
});

describe('FolderUploadService selection and cleanup', () => {
  it('should persist a selection and rescan its folder for a live scan id', async () => {
    const h = harness();
    h.svc.setSelection(await request(['Data']));
    expect(h.svc.getSelection('minecraft')).toMatchObject({ localPath: root, include: ['Data'] });
    const rescan = await h.svc.rescanSelection('minecraft');
    expect(rescan?.fileCount).toBe(3);
    expect(await h.svc.rescanSelection('other')).toBeNull();
  });

  it('should sweep with age 0 and the currently active games on an explicit cleanup', async () => {
    const h = harness();
    await h.svc.cleanupStrayHelpers();
    expect(h.fm.sweepStrayHelpers).toHaveBeenCalledWith({ activeGames: new Set(), minAgeMs: 0 });
  });

  it('should exclude registry-owned games from the stray sweep', async () => {
    const h = harness();
    h.registry.ownedGames.mockReturnValue(new Set(['mc']));
    await h.svc.cleanupStrayHelpers();
    expect(h.fm.sweepStrayHelpers).toHaveBeenCalledWith({ activeGames: new Set(['mc']), minAgeMs: 0 });
  });

  it('should run the 15-minute startup sweep only inside Electron', async () => {
    const h = harness();
    h.svc.onApplicationBootstrap();
    expect(h.fm.sweepStrayHelpers).not.toHaveBeenCalled();
    vi.stubEnv('x', 'y');
    Object.defineProperty(process.versions, 'electron', { value: '43.0.0', configurable: true });
    try {
      h.svc.onApplicationBootstrap();
    } finally {
      delete (process.versions as Record<string, unknown>)['electron'];
    }
    expect(h.fm.sweepStrayHelpers).toHaveBeenCalledWith({ activeGames: new Set(), minAgeMs: 15 * 60 * 1000 });
    vi.unstubAllEnvs();
  });
});
