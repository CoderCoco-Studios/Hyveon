import 'reflect-metadata';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FolderUploadProgress } from '@hyveon/shared/folderUpload';

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { FolderUploadService } from './FolderUploadService.js';
import { FolderScanService } from './FolderScanService.js';
import { ElectronStoreService } from './ElectronStoreService.js';
import { SafeStorageService } from './SafeStorageService.js';
import type { EcsService } from './EcsService.js';
import type { FileManagerService, UploadHelperLaunch } from './FileManagerService.js';
import type { FileBrowserApi, FileBrowserClientFactory } from './folderUpload/FileBrowserClient.js';
import { PinMismatchError } from './folderUpload/FileBrowserClient.js';
import { generateEphemeralCert } from './folderUpload/ephemeralCert.js';
import { configServiceStub } from '../testing/config-service.fixture.js';
import { deploymentConfigStub, gameServer } from '../testing/deployment-config.fixture.js';
import { stackOutputs } from '../testing/stack-outputs.fixture.js';
import { fakeClient, type FakeClient } from '../testing/fake-filebrowser-client.js';

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
  scans = new FolderScanService();
});
afterEach(() => rm(root, { recursive: true, force: true }));

interface Harness {
  svc: FolderUploadService;
  client: FakeClient;
  fm: { startForUpload: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; getStatus: ReturnType<typeof vi.fn>; getHelperPublicIp: ReturnType<typeof vi.fn>; sweepStrayHelpers: ReturnType<typeof vi.fn> };
  ecs: { findRunningTask: ReturnType<typeof vi.fn> };
  store: ElectronStoreService;
  progress: FolderUploadProgress[];
  create: ReturnType<typeof vi.fn>;
}

/** Builds the service under test with happy-path collaborators; `launch` overrides the helper launch result. */
async function harness(options: { client?: FakeClient; launch?: UploadHelperLaunch; outputs?: ReturnType<typeof stackOutputs> | null } = {}): Promise<Harness> {
  const cert = await generateEphemeralCert();
  const client = options.client ?? fakeClient();
  const fm = {
    startForUpload: vi.fn().mockResolvedValue(
      options.launch ?? { ok: true, session: { taskArn: 't', runId: 'r', credentials: { username: 'admin', password: 'pw-secret' }, cert } },
    ),
    stop: vi.fn().mockResolvedValue({ success: true, message: 'ok' }),
    getStatus: vi.fn().mockResolvedValue({ game: 'minecraft', state: 'stopped' }),
    getHelperPublicIp: vi.fn().mockResolvedValue('9.9.9.9'),
    sweepStrayHelpers: vi.fn().mockResolvedValue({ stopped: [], skipped: 0, revokedRules: 0, errors: [] }),
  };
  const ecs = { findRunningTask: vi.fn().mockResolvedValue(null) };
  const create = vi.fn().mockReturnValue(client as FileBrowserApi);
  const store = new ElectronStoreService(new SafeStorageService());
  const outputs = options.outputs === undefined ? stackOutputs({ efsAccessPoints: { minecraft: 'fsap' } }) : options.outputs;
  const svc = new FolderUploadService(
    configServiceStub({ outputs }),
    deploymentConfigStub({ declared: [gameServer('minecraft')] }),
    ecs as unknown as EcsService,
    fm as unknown as FileManagerService,
    scans,
    store,
    { create } as unknown as FileBrowserClientFactory,
  );
  svc.timings.pollMs = 1;
  svc.engine.sleep = async () => undefined;
  const progress: FolderUploadProgress[] = [];
  svc.onProgress((p) => progress.push(p));
  return { svc, client, fm, ecs, store, progress, create };
}

/** Waits until the terminal progress snapshot for a run has been published. */
async function settled(h: Harness): Promise<FolderUploadProgress> {
  await vi.waitFor(() => {
    const last = h.progress.at(-1);
    expect(last && ['done', 'failed', 'cancelled'].includes(last.phase)).toBe(true);
  });
  return h.progress.at(-1)!;
}

/** Scans the temp folder and builds a request including the given relPaths. */
async function request(include: string[], destination = '/data') {
  const scan = await scans.scan(root);
  return { game: 'minecraft', scanId: scan.scanId, include, destination };
}

describe('FolderUploadService guards', () => {
  it('should refuse when the game is not deployed and keep the selection', async () => {
    const h = await harness({ outputs: null });
    const res = await h.svc.startUpload(await request(['Config']));
    expect(res).toMatchObject({ started: false, error: expect.stringMatching(/not deployed/) });
    expect(h.fm.startForUpload).not.toHaveBeenCalled();
  });

  it('should refuse when the game server task is running', async () => {
    const h = await harness();
    h.ecs.findRunningTask.mockResolvedValue({ taskArn: 'x' });
    expect(await h.svc.startUpload(await request(['Config']))).toMatchObject({ started: false, error: expect.stringMatching(/Stop the server/) });
    expect(h.fm.startForUpload).not.toHaveBeenCalled();
  });

  it('should refuse when a helper is already open and never stop it', async () => {
    const h = await harness();
    h.fm.getStatus.mockResolvedValue({ game: 'minecraft', state: 'running' });
    expect(await h.svc.startUpload(await request(['Config']))).toMatchObject({ started: false, error: expect.stringMatching(/already open/) });
    expect(h.fm.stop).not.toHaveBeenCalled();
  });

  it('should refuse a destination outside the game volumes', async () => {
    const h = await harness();
    expect(await h.svc.startUpload(await request(['Config'], '/etc'))).toMatchObject({ started: false });
  });

  it('should reject a path-traversal entry before any request or launch', async () => {
    const h = await harness();
    const req = await request(['Config']);
    const held = scans.get(req.scanId)!;
    held.tree.children![0]!.children![0]!.relPath = '../../etc/passwd';
    const res = await h.svc.startUpload(req);
    expect(res).toMatchObject({ started: false, error: expect.stringMatching(/Invalid relative path/) });
    expect(h.fm.startForUpload).not.toHaveBeenCalled();
    expect(h.create).not.toHaveBeenCalled();
  });

  it('should refuse an empty selection and an expired scan', async () => {
    const h = await harness();
    expect(await h.svc.startUpload(await request([]))).toMatchObject({ started: false, error: expect.stringMatching(/Nothing is selected/) });
    expect(await h.svc.startUpload({ game: 'minecraft', scanId: 'gone', include: ['Config'], destination: '/data' })).toMatchObject({
      started: false,
      error: expect.stringMatching(/expired/),
    });
  });

  it('should refuse a second concurrent run for the same game', async () => {
    const login = (signal?: AbortSignal) => new Promise<void>((_res, rej) => signal?.addEventListener('abort', () => rej(new Error('aborted'))));
    const h = await harness({ client: fakeClient({ login }) });
    expect((await h.svc.startUpload(await request(['Config']))).started).toBe(true);
    expect(await h.svc.startUpload(await request(['Config']))).toMatchObject({ started: false, error: expect.stringMatching(/already running/) });
    h.svc.cancel('minecraft');
    await settled(h);
  });
});

describe('FolderUploadService runs', () => {
  it('should upload only the included entries to the stripped remote paths, verify, and stop the helper', async () => {
    const h = await harness();
    const res = await h.svc.startUpload(await request(['Config', 'Data']));
    expect(res.started).toBe(true);
    const last = await settled(h);
    expect(last).toMatchObject({ phase: 'done', filesDone: 2, filesTotal: 2, bytesDone: 12, bytesTotal: 12 });
    expect(h.client.uploads.sort()).toEqual(['/Config/a.json', '/Data/b.db']);
    expect(h.fm.stop).toHaveBeenCalledWith('minecraft');
    expect(h.svc.getSelection('minecraft')).toMatchObject({ include: ['Config', 'Data'], destination: '/data', lastRun: { status: 'done', files: 2, bytes: 12 } });
    expect(h.progress.map((p) => p.phase)).toEqual(expect.arrayContaining(['starting-helper', 'uploading', 'verifying', 'done']));
  });

  it('should report 100% only in the done phase, after the helper was stopped', async () => {
    const h = await harness();
    const order: string[] = [];
    h.fm.stop.mockImplementation(async () => {
      order.push('stop');
      return { success: true, message: '' };
    });
    h.svc.onProgress((p) => p.phase === 'done' && order.push('done'));
    await h.svc.startUpload(await request(['Config']));
    await settled(h);
    expect(order.slice(0, 2)).toEqual(['stop', 'done']);
  });

  it('should skip files already on the volume with the right size when resuming', async () => {
    const client = fakeClient();
    client.sizes.set('/Config/a.json', 4);
    const h = await harness({ client });
    await h.svc.startUpload(await request(['Config', 'Data']));
    const last = await settled(h);
    expect(client.uploads).toEqual(['/Data/b.db']);
    expect(last).toMatchObject({ phase: 'done', filesDone: 2, bytesDone: 12 });
  });

  it('should fail with the path when a file keeps failing, persist a failed last run, and still stop the helper', async () => {
    const client = fakeClient({
      uploadFile: async () => {
        throw new Error('socket hang up');
      },
    });
    const h = await harness({ client });
    await h.svc.startUpload(await request(['Config']));
    const last = await settled(h);
    expect(last).toMatchObject({ phase: 'failed', error: expect.stringContaining('Config/a.json') });
    expect(h.fm.stop).toHaveBeenCalledTimes(1);
    expect(h.svc.getSelection('minecraft')?.lastRun?.status).toBe('failed');
  });

  it('should fail with a resumable error when the helper expires mid-run (connections refused) and stop it', async () => {
    let calls = 0;
    const client = fakeClient({
      uploadFile: async ({ onBytes, size, remotePath }) => {
        calls += 1;
        if (calls > 1) throw new Error('connect ECONNREFUSED 9.9.9.9:8080');
        onBytes(size);
        client.sizes.set(remotePath, size);
      },
    });
    const h = await harness({ client });
    await h.svc.startUpload(await request(['Config', 'Data']));
    const last = await settled(h);
    expect(last.phase).toBe('failed');
    expect(last.error).toMatch(/ECONNREFUSED/);
    expect(h.fm.stop).toHaveBeenCalled();
    expect(h.svc.getSelection('minecraft')?.lastRun).toMatchObject({ status: 'failed', files: 1 });
  });

  it('should fail verification listing the missing path', async () => {
    const client = fakeClient();
    const original = client.uploadFile;
    client.uploadFile = async (args) => {
      if (args.remotePath.endsWith('b.db')) return args.onBytes(args.size);
      return original(args);
    };
    const h = await harness({ client });
    await h.svc.startUpload(await request(['Config', 'Data']));
    const last = await settled(h);
    expect(last).toMatchObject({ phase: 'failed', error: expect.stringContaining('Data/b.db (missing)') });
  });

  it('should cancel mid-run, stop the helper, and record a cancelled last run', async () => {
    const uploadFile = vi.fn(
      ({ signal }: { signal?: AbortSignal }) =>
        new Promise<void>((_res, rej) => {
          signal?.addEventListener('abort', () => rej(new Error('aborted')));
        }),
    );
    const client = fakeClient({ uploadFile });
    const h = await harness({ client });
    await h.svc.startUpload(await request(['Config', 'Data']));
    await vi.waitFor(() => expect(h.progress.some((p) => p.phase === 'uploading')).toBe(true));
    await vi.waitFor(() => expect(uploadFile).toHaveBeenCalled());
    expect(h.svc.cancel('minecraft')).toEqual({ cancelled: true });
    const last = await settled(h);
    expect(last.phase).toBe('cancelled');
    expect(h.fm.stop).toHaveBeenCalledTimes(1);
    expect(h.svc.getSelection('minecraft')?.lastRun?.status).toBe('cancelled');
  });

  it('should cancel while waiting for the helper to boot', async () => {
    const h = await harness();
    h.fm.getHelperPublicIp.mockResolvedValue(null);
    await h.svc.startUpload(await request(['Config']));
    await vi.waitFor(() => expect(h.fm.getHelperPublicIp).toHaveBeenCalled());
    h.svc.cancel('minecraft');
    expect((await settled(h)).phase).toBe('cancelled');
    expect(h.fm.stop).toHaveBeenCalled();
  });

  it('should abort on a certificate pin mismatch without retrying or sending any file, and stop the helper', async () => {
    const login = vi.fn().mockRejectedValue(new PinMismatchError());
    const client = fakeClient({ login });
    const h = await harness({ client });
    await h.svc.startUpload(await request(['Config']));
    const last = await settled(h);
    expect(last.phase).toBe('failed');
    expect(login).toHaveBeenCalledTimes(1);
    expect(client.uploadFile).not.toHaveBeenCalled();
    expect(h.fm.stop).toHaveBeenCalled();
  });

  it('should keep retrying login while the container boots', async () => {
    const login = vi.fn().mockRejectedValueOnce(new Error('ECONNREFUSED')).mockResolvedValue(undefined);
    const h = await harness({ client: fakeClient({ login }) });
    await h.svc.startUpload(await request(['Config']));
    expect((await settled(h)).phase).toBe('done');
    expect(login).toHaveBeenCalledTimes(2);
  });

  it('should fail with the launch message and not stop a helper it did not start', async () => {
    const h = await harness({ launch: { ok: false, code: 'helper-open', message: 'already open' } });
    await h.svc.startUpload(await request(['Config']));
    const last = await settled(h);
    expect(last).toMatchObject({ phase: 'failed', error: 'already open' });
    expect(h.fm.stop).not.toHaveBeenCalled();
  });

  it('should never publish or persist the helper credential', async () => {
    const h = await harness();
    await h.svc.startUpload(await request(['Config']));
    await settled(h);
    expect(JSON.stringify(h.progress)).not.toContain('pw-secret');
    expect(JSON.stringify(h.svc.getSelection('minecraft'))).not.toContain('pw-secret');
  });

  it('should free the game for a new run after a run ends', async () => {
    const h = await harness();
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

describe('FolderUploadService overwrite confirmation', () => {
  /** A volume already holding a different-size `a.json`, an identical `b.db`, and an unrelated file in `Config`. */
  function conflictedClient(): FakeClient {
    const client = fakeClient();
    client.sizes.set('/Config/a.json', 1);
    client.sizes.set('/Config/old.cfg', 7);
    client.sizes.set('/Data/b.db', 8);
    return client;
  }

  it('should pause with a summary before writing anything and upload only after the operator confirms', async () => {
    const client = conflictedClient();
    const h = await harness({ client });
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
    expect(client.uploadFile).not.toHaveBeenCalled();
    expect(h.fm.stop).not.toHaveBeenCalled();
    expect(h.svc.getProgress('minecraft')?.phase).toBe('awaiting-confirmation');

    expect(h.svc.confirmOverwrite('minecraft', true)).toEqual({ resolved: true });
    const last = await settled(h);
    expect(last).toMatchObject({ phase: 'done' });
    expect(client.uploads).toEqual(['/Config/a.json']);
    expect(h.progress.find((p) => p.phase === 'uploading')?.overwrite).toBeUndefined();
  });

  it('should cancel cleanly with nothing written and the helper stopped when the operator declines', async () => {
    const client = conflictedClient();
    const h = await harness({ client });
    await h.svc.startUpload(await request(['Config', 'Data']));
    await reached(h, 'awaiting-confirmation');

    expect(h.svc.confirmOverwrite('minecraft', false)).toEqual({ resolved: true });
    const last = await settled(h);
    expect(last.phase).toBe('cancelled');
    expect(last.error).toBeUndefined();
    expect(client.mkdir).not.toHaveBeenCalled();
    expect(client.uploadFile).not.toHaveBeenCalled();
    expect(h.fm.stop).toHaveBeenCalledTimes(1);
    expect(h.svc.getSelection('minecraft')?.lastRun?.status).toBe('cancelled');
  });

  it('should treat Cancel while waiting as a decline', async () => {
    const h = await harness({ client: conflictedClient() });
    await h.svc.startUpload(await request(['Config']));
    await reached(h, 'awaiting-confirmation');
    h.svc.cancel('minecraft');
    expect((await settled(h)).phase).toBe('cancelled');
    expect(h.fm.stop).toHaveBeenCalledTimes(1);
    expect(h.svc.confirmOverwrite('minecraft', true)).toEqual({ resolved: false });
  });

  it('should cancel with a reason and stop the helper when nobody answers before the timeout', async () => {
    const client = conflictedClient();
    const h = await harness({ client });
    h.svc.timings.confirmationTimeoutMs = 20;
    await h.svc.startUpload(await request(['Config']));
    const last = await settled(h);
    expect(last).toMatchObject({ phase: 'cancelled', error: expect.stringMatching(/Timed out/) });
    expect(client.uploadFile).not.toHaveBeenCalled();
    expect(h.fm.stop).toHaveBeenCalledTimes(1);
  });

  it('should not prompt when nothing on the volume would be overwritten', async () => {
    const client = fakeClient();
    client.sizes.set('/Config/a.json', 4);
    client.sizes.set('/Config/other.cfg', 9);
    const h = await harness({ client });
    await h.svc.startUpload(await request(['Config']));
    expect((await settled(h)).phase).toBe('done');
    expect(h.progress.some((p) => p.phase === 'awaiting-confirmation')).toBe(false);
  });

  it('should resolve nothing when no run is awaiting an answer', async () => {
    const h = await harness();
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
      const h = await harness({ client });
      await afterFailedRun(h, ['Config', 'Data']);
      await h.svc.startUpload(await request(['Config', 'Data']));
      expect((await settled(h)).phase).toBe('done');
      expect(h.progress.some((p) => p.phase === 'awaiting-confirmation')).toBe(false);
    });

    it('should prompt when conflicts exceed the files that could have been mid-flight', async () => {
      const client = conflictedClient();
      client.sizes.set('/Data/b.db', 3);
      const h = await harness({ client });
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
      const client = fakeClient();
      client.sizes.set(destination === '/data' ? '/Config/a.json' : '/sub/Config/a.json', 1);
      const h = await harness({ client });
      await afterFailedRun(h, ['Config', 'Data']);
      await h.svc.startUpload(await request(include, destination));
      await reached(h, 'awaiting-confirmation');
      h.svc.cancel('minecraft');
      await settled(h);
    });

    it('should prompt after a completed run since the existing files are not partial uploads', async () => {
      const h = await harness({ client: conflictedClient() });
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
    const h = await harness();
    h.svc.setSelection(await request(['Data']));
    expect(h.svc.getSelection('minecraft')).toMatchObject({ localPath: root, include: ['Data'] });
    const rescan = await h.svc.rescanSelection('minecraft');
    expect(rescan?.fileCount).toBe(3);
    expect(await h.svc.rescanSelection('other')).toBeNull();
  });

  it('should sweep with age 0 and the currently active games on an explicit cleanup', async () => {
    const h = await harness();
    await h.svc.cleanupStrayHelpers();
    expect(h.fm.sweepStrayHelpers).toHaveBeenCalledWith({ activeGames: new Set(), minAgeMs: 0 });
  });

  it('should run the 15-minute startup sweep only inside Electron', async () => {
    const h = await harness();
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
