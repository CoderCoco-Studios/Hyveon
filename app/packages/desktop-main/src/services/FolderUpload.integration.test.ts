/**
 * End-to-end run of {@link FolderUploadService} through the real {@link FileBrowserClientFactory} against an in-process
 * HTTPS fake of the FileBrowser helper. Only the AWS-facing collaborators are stubbed.
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
import type { FileManagerService } from './FileManagerService.js';
import { FileBrowserClientFactory } from './folderUpload/FileBrowserClient.js';
import { generateEphemeralCert, type EphemeralCert } from './folderUpload/ephemeralCert.js';
import { configServiceStub } from '../testing/config-service.fixture.js';
import { deploymentConfigStub, gameServer } from '../testing/deployment-config.fixture.js';
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
async function run(options: {
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
}) {
  const pinned = await generateEphemeralCert();
  server = await startFakeFileBrowser({ cert: options.presentedCert ?? pinned, onUpload: options.onUpload, seed: options.seed });
  const volumes = options.volumes ?? [{ name: 'saves', container_path: '/data' }];
  const outputs = stackOutputs({
    efsAccessPoints: { minecraft: 'fsap' },
    efsVolumeAccessPoints: { minecraft: options.accessPoints ?? { saves: 'fsap' } },
  });
  const fm = {
    planHelperLayout: vi.fn(async () => buildHelperVolumeLayout('minecraft', volumes, outputs)),
    startForUpload: vi.fn().mockResolvedValue({
      ok: true,
      session: { taskArn: 't', runId: 'r', credentials: { username: 'admin', password: 'secret' }, cert: pinned },
    }),
    stop: vi.fn().mockResolvedValue({ success: true, message: '' }),
    getStatus: vi.fn().mockResolvedValue({ game: 'minecraft', state: 'stopped' }),
    getHelperPublicIp: vi.fn().mockResolvedValue('127.0.0.1'),
  };
  const scans = new FolderScanService();
  const svc = new FolderUploadService(
    configServiceStub({ outputs }),
    deploymentConfigStub({ declared: [gameServer('minecraft', { volumes })] }),
    { findRunningTaskOrThrow: vi.fn().mockResolvedValue(null) } as unknown as EcsService,
    fm as unknown as FileManagerService,
    scans,
    new ElectronStoreService(new SafeStorageService()),
    new FileBrowserClientFactory(),
  );
  svc.timings.helperPort = server.port;
  svc.timings.pollMs = 1;
  svc.engine.sleep = async () => undefined;
  const progress: FolderUploadProgress[] = [];
  svc.onProgress((p) => {
    progress.push(p);
    if (p.phase === 'awaiting-confirmation' && options.answer !== undefined) svc.confirmOverwrite('minecraft', options.answer);
  });
  const scan = await scans.scan(root);
  const res = await svc.startUpload({ game: 'minecraft', scanId: scan.scanId, include: options.include ?? ['Data'], destination: options.destination ?? '/data' });
  expect(res.started).toBe(true);
  await vi.waitFor(() => expect(['done', 'failed', 'cancelled']).toContain(progress.at(-1)?.phase));
  return { svc, fm, progress, last: progress.at(-1)!, server };
}

describe('folder upload against a fake FileBrowser helper', () => {
  it('should stream every file over pinned TLS, verify the listing, and stop the helper', async () => {
    const r = await run({});
    expect(r.last).toMatchObject({ phase: 'done', filesDone: 2, bytesDone: 200_005, bytesTotal: 200_005 });
    expect(r.server.files.get('/saves/Data/worlds/a.db')).toBe(200_000);
    expect(r.server.files.get('/saves/Data/b.txt')).toBe(5);
    expect(r.fm.stop).toHaveBeenCalledWith('minecraft');
  });

  it('should write a second-volume upload into that volume and nothing into the first', async () => {
    const r = await run({
      volumes: [
        { name: 'config', container_path: '/data/config' },
        { name: 'saves', container_path: '/data/saves' },
      ],
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
    expect(r.fm.stop).toHaveBeenCalledWith('minecraft');
  });

  it('should not prompt when the volume has no differing files', async () => {
    const r = await run({ seed: { '/saves/Data/worlds/a.db': 200_000, '/saves/Data/unrelated.txt': 1 } });
    expect(r.last.phase).toBe('done');
    expect(r.progress.some((p) => p.phase === 'awaiting-confirmation')).toBe(false);
  });
});
