/**
 * End-to-end run of {@link FolderUploadService} through a real {@link HelperSessionRegistry} and
 * {@link FileBrowserClientFactory} against an in-process HTTPS fake of the FileBrowser helper. Only the AWS-facing
 * collaborators are stubbed.
 */
import 'reflect-metadata';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GameServer } from '@hyveon/shared';
import type { FolderUploadProgress } from '@hyveon/shared/folderUpload';

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { FolderUploadService } from './FolderUploadService.js';
import { FolderScanService } from './FolderScanService.js';
import { ElectronStoreService } from './ElectronStoreService.js';
import { SafeStorageService } from './SafeStorageService.js';
import type { EcsService } from './EcsService.js';
import type { FileManagerService, HelperLaunchOutcome } from './FileManagerService.js';
import type { PublicIpService } from './PublicIpService.js';
import { HelperSessionRegistry } from './volumeFiles/HelperSessionRegistry.js';
import { FileBrowserClientFactory } from './folderUpload/FileBrowserClient.js';
import { generateEphemeralCert, type EphemeralCert } from './folderUpload/ephemeralCert.js';
import { configServiceStub } from '../testing/config-service.fixture.js';
import { configAndSavesVolumes, deploymentConfigStub, gameServer } from '../testing/deployment-config.fixture.js';
import { stackOutputs } from '../testing/stack-outputs.fixture.js';
import { startFakeFileBrowser, type FakeFileBrowser } from '../testing/fake-filebrowser-server.js';
import { buildHelperVolumeLayout } from './volumeFiles/helperVolumeLayout.js';

let root: string;
let server: FakeFileBrowser | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'fui-'));
  await mkdir(join(root, 'Data', 'worlds'), { recursive: true });
  await writeFile(join(root, 'Data', 'worlds', 'a.db'), Buffer.alloc(200_000, 1));
  await writeFile(join(root, 'Data', 'b.txt'), 'hello');
  await writeFile(join(root, 'a.db'), Buffer.alloc(200_000, 1));
});
afterEach(async () => {
  await server?.close();
  server = undefined;
  await rm(root, { recursive: true, force: true });
});

/** Wires the service to the fake helper, presenting `presentedCert` while the session pins `pinnedCert`. */
async function wire(options: {
  presentedCert?: EphemeralCert;
  seed?: Record<string, number>;
  onUpload?: Parameters<typeof startFakeFileBrowser>[0]['onUpload'];
  /** Answer given to the overwrite warning when one appears; omit to leave the run waiting. */
  answer?: boolean;
  /** The game's declared volumes; defaults to a single `saves` volume at `/data`. */
  volumes?: GameServer['volumes'];
  /** Per-volume access points the stack exports; defaults to one for `saves`. */
  accessPoints?: Record<string, string>;
  include?: string[];
  destination?: string;
  /** Open a browse session before the upload starts. */
  browse?: boolean;
  /** Holds the first helper launch until this settles, so a test can act while the session is still starting. */
  firstLaunchGate?: Promise<void>;
  /** Holds every ECS stop until this settles, so a test can observe a session mid-teardown. */
  stopGate?: Promise<void>;
}) {
  const pinned = await generateEphemeralCert();
  server = await startFakeFileBrowser({ cert: options.presentedCert ?? pinned, onUpload: options.onUpload, seed: options.seed });
  const volumes = options.volumes ?? [{ name: 'saves', container_path: '/data' }];
  const outputs = stackOutputs({
    efsAccessPoints: { minecraft: 'fsap' },
    efsVolumeAccessPoints: { minecraft: options.accessPoints ?? { saves: 'fsap' } },
  });
  const layout = buildHelperVolumeLayout('minecraft', volumes, outputs);
  const launched: HelperLaunchOutcome = {
    ok: true,
    taskArn: 't',
    credentials: { username: 'admin', password: 'secret' },
    cert: pinned,
    operatorIp: '203.0.113.7',
    startedAt: 0,
    autoStopAt: 7_200_000,
    scheduleWarning: '',
    layout,
  };
  /** Whether ECS reports a helper task; true once `launchHelper` runs and false again after `stop`. */
  let helperTask = false;
  let launches = 0;
  const fm = {
    planHelperLayout: vi.fn(async () => layout),
    launchHelper: vi.fn(async () => {
      launches += 1;
      if (launches === 1) await options.firstLaunchGate;
      helperTask = true;
      return launched;
    }),
    listHelperTask: vi.fn(async () => (helperTask ? { taskArn: 't' } : null)),
    stop: vi.fn(async () => {
      await options.stopGate;
      helperTask = false;
      return { success: true, message: '' };
    }),
    getHelperPublicIp: vi.fn().mockResolvedValue('127.0.0.1'),
    getHelperStopReason: vi.fn().mockResolvedValue(null),
    reauthorizeOperatorIp: vi.fn().mockResolvedValue(undefined),
    sweepStrayHelpers: vi.fn(),
  };
  const registry = new HelperSessionRegistry(
    fm as Partial<FileManagerService> as FileManagerService,
    new FileBrowserClientFactory(),
    { detect: vi.fn().mockResolvedValue('203.0.113.7') } as Partial<PublicIpService> as PublicIpService,
  );
  registry.timings.helperPort = server.port;
  registry.timings.pollMs = 1;
  if (options.browse) expect(await registry.acquire('minecraft', 'browse')).toEqual({ ok: true });
  const scans = new FolderScanService();
  const svc = new FolderUploadService(
    configServiceStub({ outputs }),
    deploymentConfigStub({ declared: [gameServer('minecraft', { volumes })] }),
    { findRunningTaskOrThrow: vi.fn().mockResolvedValue(null) } satisfies Partial<EcsService> as EcsService,
    fm as Partial<FileManagerService> as FileManagerService,
    scans,
    new ElectronStoreService(new SafeStorageService()),
    registry,
  );
  svc.engine.sleep = async () => undefined;
  const progress: FolderUploadProgress[] = [];
  svc.onProgress((p) => {
    progress.push(p);
    if (p.phase === 'awaiting-confirmation' && options.answer !== undefined) svc.confirmOverwrite('minecraft', options.answer);
  });
  const scan = await scans.scan(root);
  /** Starts one upload and checks it was accepted. */
  const start = async () => {
    const res = await svc.startUpload({ game: 'minecraft', scanId: scan.scanId, include: options.include ?? ['Data'], destination: options.destination ?? '/data' });
    expect(res.started).toBe(true);
  };
  return { svc, fm, registry, progress, start, server };
}

/** Wires the service and runs one upload to its terminal phase. */
async function run(options: Parameters<typeof wire>[0]) {
  const w = await wire(options);
  await w.start();
  await vi.waitFor(() => expect(['done', 'failed', 'cancelled']).toContain(w.progress.at(-1)?.phase));
  return { ...w, last: w.progress.at(-1)! };
}

describe('folder upload against a fake FileBrowser helper', () => {
  it('should stream every file over pinned TLS, verify the listing, and stop the helper', async () => {
    const r = await run({});
    expect(r.last).toMatchObject({ phase: 'done', filesDone: 2, bytesDone: 200_005, bytesTotal: 200_005 });
    expect(r.server.files.get('/saves/Data/worlds/a.db')).toBe(200_000);
    expect(r.server.files.get('/saves/Data/b.txt')).toBe(5);
    expect(r.fm.stop).toHaveBeenCalledWith('minecraft');
  });

  it('should never publish or persist the helper credential', async () => {
    const r = await run({});
    expect(r.last.phase).toBe('done');

    expect(r.svc.getSelection('minecraft')).not.toBeNull();
    const published = JSON.stringify(r.progress);
    const stored = JSON.stringify(r.svc.getSelection('minecraft'));
    for (const text of [published, stored]) {
      expect(text).not.toContain('secret');
      expect(text).not.toContain('admin');
    }
  });

  it('should leave an existing browse session running after the upload', async () => {
    const r = await run({ browse: true });
    expect(r.last.phase).toBe('done');
    expect(r.fm.launchHelper).toHaveBeenCalledTimes(1);
    expect(r.fm.stop).not.toHaveBeenCalled();
    expect((await r.registry.status('minecraft')).state).toBe('running');
    await r.registry.stop('minecraft');
  });

  it('should not cancel a retry that starts while the cancelled run\'s session is still being torn down', async () => {
    let openGate!: () => void;
    const firstLaunchGate = new Promise<void>((resolve) => { openGate = resolve; });
    const w = await wire({ firstLaunchGate });
    await w.start();
    await vi.waitFor(() => expect(w.fm.launchHelper).toHaveBeenCalledTimes(1));
    w.svc.cancel('minecraft');
    await vi.waitFor(() => expect(w.progress.at(-1)?.phase).toBe('cancelled'));

    await w.start();
    openGate();
    await vi.waitFor(() => expect(['done', 'failed']).toContain(w.progress.at(-1)?.phase), { timeout: 5000 });

    expect(w.progress.at(-1)?.phase).toBe('done');
    expect(w.server.files.get('/saves/Data/b.txt')).toBe(5);
    expect(w.fm.launchHelper).toHaveBeenCalledTimes(2);
    await w.registry.stop('minecraft');
  });

  it('should release a hold acquired after its run was cancelled while waiting out a teardown', async () => {
    let openGate!: () => void;
    const stopGate = new Promise<void>((resolve) => { openGate = resolve; });
    const w = await wire({ browse: true, stopGate });
    const stopping = w.registry.stop('minecraft');
    await w.start();
    await vi.waitFor(() => expect(w.progress.at(-1)?.phase).toBe('starting-helper'));
    w.svc.cancel('minecraft');
    await vi.waitFor(() => expect(w.progress.at(-1)?.phase).toBe('cancelled'));

    openGate();
    await stopping;
    await vi.waitFor(() => expect(w.fm.launchHelper).toHaveBeenCalledTimes(2));

    await vi.waitFor(() => expect(w.registry.ownedGames().size).toBe(0));
    expect(w.fm.stop).toHaveBeenCalledTimes(2);
  });

  it('should write a second-volume upload into that volume and nothing into the first', async () => {
    const r = await run({
      volumes: configAndSavesVolumes(),
      accessPoints: { config: 'fsap-c', saves: 'fsap-s' },
      include: ['a.db'],
      destination: '/data/saves/worlds',
    });
    expect(r.last.phase).toBe('done');
    expect(r.server.files.get('/saves/worlds/a.db')).toBe(200_000);
    expect([...r.server.files.keys()].filter((p) => p.startsWith('/config/'))).toEqual([]);
  });

  it('should resume by skipping files the volume already holds and re-sending partial ones once overwriting is confirmed', async () => {
    const r = await run({ seed: { '/saves/Data/worlds/a.db': 200_000, '/saves/Data/b.txt': 2 }, answer: true });
    expect(r.progress.find((p) => p.phase === 'awaiting-confirmation')?.overwrite).toMatchObject({ conflictCount: 1, identicalCount: 1, newCount: 0 });
    expect(r.last.phase).toBe('done');
    const posts = r.server.requests.filter((q) => q.method === 'POST' && !q.url.endsWith('/') && q.url.startsWith('/api/resources'));
    expect(posts.map((q) => q.url)).toEqual(['/api/resources/saves/Data/b.txt?override=true']);
    expect(r.server.files.get('/saves/Data/b.txt')).toBe(5);
  });

  it('should retry a dropped connection and still finish', async () => {
    const r = await run({ onUpload: (path, attempt) => (path.endsWith('b.txt') && attempt === 1 ? 'drop' : undefined) });
    expect(r.last.phase).toBe('done');
    expect(r.server.files.get('/saves/Data/b.txt')).toBe(5);
  });

  it('should fail the run and stop the helper when uploads keep failing (helper expiry)', async () => {
    const r = await run({ onUpload: () => 'drop' });
    expect(r.last.phase).toBe('failed');
    expect(r.fm.stop).toHaveBeenCalled();
  });

  it('should abort before sending the credential when the endpoint presents a different certificate', async () => {
    const imposter = await generateEphemeralCert();
    const r = await run({ presentedCert: imposter });
    expect(r.last.phase).toBe('failed');
    expect(r.server.requests).toHaveLength(0);
    expect(r.fm.stop).toHaveBeenCalled();
  });

  it('should write nothing and stop the helper when the operator declines to overwrite', async () => {
    const r = await run({ seed: { '/saves/Data/b.txt': 2 }, answer: false });
    expect(r.last.phase).toBe('cancelled');
    expect(r.server.requests.filter((q) => q.method === 'POST' && q.url.startsWith('/api/resources'))).toEqual([]);
    expect(r.server.files.get('/saves/Data/b.txt')).toBe(2);
    await vi.waitFor(() => expect(r.fm.stop).toHaveBeenCalledWith('minecraft'));
  });

  it('should not prompt when the volume has no differing files', async () => {
    const r = await run({ seed: { '/saves/Data/worlds/a.db': 200_000, '/saves/Data/unrelated.txt': 1 } });
    expect(r.last.phase).toBe('done');
    expect(r.progress.some((p) => p.phase === 'awaiting-confirmation')).toBe(false);
  });
});
