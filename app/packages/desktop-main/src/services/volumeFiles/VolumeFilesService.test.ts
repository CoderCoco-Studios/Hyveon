import 'reflect-metadata';
import { mkdir, mkdtemp, readdir, readFile, rm, stat as fsStat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { MAX_TEXT_EDIT_BYTES, type VolumeRef, type VolumeTransferProgress } from '@hyveon/shared/volumeFiles';
import { logger } from '../../logger.js';
import type { ConfigService } from '../ConfigService.js';
import type { DeploymentConfigService } from '../DeploymentConfigService.js';
import type { EcsService } from '../EcsService.js';
import type { FolderScanService } from '../FolderScanService.js';
import type { FolderUploadService } from '../FolderUploadService.js';
import type { NativeDialogService } from '../NativeDialogService.js';
import { deploymentConfigStub, gameServer } from '../../testing/deployment-config.fixture.js';
import { fakeBackend, type FakeBackend } from '../../testing/fake-volume-backend.js';
import { expectNoSecretFields } from '../../testing/no-secret-fields.js';
import { stackOutputs } from '../../testing/stack-outputs.fixture.js';
import { buildHelperVolumeLayout, type HelperVolumeLayout } from './helperVolumeLayout.js';
import { HelperSessionRegistry, NoSessionError, type HelperSessionSnapshot } from './HelperSessionRegistry.js';
import { VolumeFileError, type VolumeStat } from './VolumeFileBackend.js';
import { failedSessionStatus, METADATA_OP_TIMEOUT_MS, VolumeFilesService } from './VolumeFilesService.js';

const SAVES: VolumeRef = { game: 'mc', volume: 'saves' };
const ACCESS_POINTS = { efsAccessPoints: { mc: 'fsap-c' }, efsVolumeAccessPoints: { mc: { config: 'fsap-c', saves: 'fsap-s' } } };
const DECLARED = [
  { name: 'config', container_path: '/data/config' },
  { name: 'saves', container_path: '/data/saves' },
];

const FULL_LAYOUT = buildHelperVolumeLayout('mc', DECLARED, ACCESS_POINTS);
/** Only `config` has an access point, so `saves` is declared but unmounted (apply needed). */
const PARTIAL_LAYOUT = buildHelperVolumeLayout('mc', DECLARED, {
  efsAccessPoints: { mc: 'fsap-c' },
  efsVolumeAccessPoints: { mc: { config: 'fsap-c' } },
});
/** A stack applied by an older build: no per-volume output, so the layout is the read-only fallback. */
const FALLBACK_LAYOUT = buildHelperVolumeLayout('mc', DECLARED, { efsAccessPoints: { mc: 'fsap-c' }, efsVolumeAccessPoints: {} });
/** A deployed-only game with no per-volume output: one unnamed volume at `volume-0`. */
const LEGACY_LAYOUT = buildHelperVolumeLayout('mc', [], { efsAccessPoints: { mc: 'fsap-c' }, efsVolumeAccessPoints: {} });

/** A file stat at the helper path the fake backend would report. */
const stat = (over: Partial<VolumeStat> = {}): VolumeStat => ({
  name: 'level.dat',
  isDir: false,
  size: 4,
  modifiedMs: 1,
  path: '/saves/level.dat',
  ...over,
});

interface Harness {
  service: VolumeFilesService;
  backend: FakeBackend;
  registry: { [K in 'withBackend' | 'status' | 'acquire' | 'attach' | 'release' | 'stop' | 'onBeforeStop' | 'onState']: ReturnType<typeof vi.fn> };
  dialogs: { pickSavePath: ReturnType<typeof vi.fn>; pickFiles: ReturnType<typeof vi.fn>; pickDirectory: ReturnType<typeof vi.fn> };
  scans: { scan: ReturnType<typeof vi.fn> };
  folderUploads: { startUpload: ReturnType<typeof vi.fn> };
  /** The listener the service registered with `onBeforeStop`. */
  beforeStop: (game: string) => void;
  config: { getStackOutputs: ReturnType<typeof vi.fn> };
  ecs: { findRunningTaskOrThrow: ReturnType<typeof vi.fn> };
}

/** Builds the service over a registry stub whose `withBackend` runs the op against `backend` and `layout`. */
function harness(backendOverrides: Parameters<typeof fakeBackend>[0] = {}, layout: HelperVolumeLayout = FULL_LAYOUT): Harness {
  const backend = fakeBackend(backendOverrides);
  const registry = {
    withBackend: vi.fn(async (_game: string, op: (b: FakeBackend, l: HelperVolumeLayout) => Promise<unknown>) => op(backend, layout)),
    status: vi.fn().mockResolvedValue(snapshot()),
    acquire: vi.fn().mockResolvedValue({ ok: true }),
    attach: vi.fn().mockReturnValue(true),
    release: vi.fn(),
    stop: vi.fn().mockResolvedValue({ success: true, message: 'stopped' }),
    onState: vi.fn(() => () => undefined),
    onBeforeStop: vi.fn((listener: (game: string) => void) => {
      beforeStop = listener;
      return () => undefined;
    }),
  };
  let beforeStop: (game: string) => void = () => undefined;
  const dialogs = { pickSavePath: vi.fn(), pickFiles: vi.fn(), pickDirectory: vi.fn() };
  const scans = { scan: vi.fn().mockResolvedValue({ scanId: 'scan-1' }) };
  const folderUploads = { startUpload: vi.fn().mockResolvedValue({ started: true, runId: 'run-1' }) };
  const config = { getStackOutputs: vi.fn().mockResolvedValue(stackOutputs()) };
  const ecs = { findRunningTaskOrThrow: vi.fn().mockResolvedValue(null) };
  const service = new VolumeFilesService(
    registry as Partial<HelperSessionRegistry> as HelperSessionRegistry,
    config as Partial<ConfigService> as ConfigService,
    ecs as Partial<EcsService> as EcsService,
    dialogs as Partial<NativeDialogService> as NativeDialogService,
    scans as Partial<FolderScanService> as FolderScanService,
    folderUploads as Partial<FolderUploadService> as FolderUploadService,
    deploymentConfigStub({ declared: [gameServer('mc', { volumes: DECLARED })] }) as DeploymentConfigService,
  );
  return { service, backend, registry, config, ecs, dialogs, scans, folderUploads, beforeStop: (game) => beforeStop(game) };
}

/** A running-session snapshot with epoch-ms times, as the registry reports it. */
function snapshot(over: Partial<HelperSessionSnapshot> = {}): HelperSessionSnapshot {
  return {
    game: 'mc',
    state: 'running',
    startedAt: Date.UTC(2026, 0, 2, 3, 4, 5),
    autoStopAt: Date.UTC(2026, 0, 2, 5, 4, 5),
    browseHeld: true,
    uploadHolders: 0,
    supportsArchive: true,
    volumes: [{ name: 'saves', containerPath: '/data/saves', mounted: true }],
    ...over,
  };
}

/** Runs each mutation once against `ref` so refusal tests cover all of them. */
function mutations(h: Harness, ref: VolumeRef = SAVES) {
  return {
    mkdir: () => h.service.mkdir(ref, '/', 'new'),
    rename: () => h.service.rename(ref, '/old', 'new'),
    remove: () => h.service.remove(ref, '/old'),
    writeText: () => h.service.writeText(ref, '/a.txt', 'x', 1),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('VolumeFilesService path and volume validation', () => {
  it('should reject a traversal path without contacting the backend', async () => {
    const h = harness();
    const result = await h.service.list(SAVES, '/a/../b');
    expect(result).toMatchObject({ ok: false, code: 'invalid-path' });
    expect(h.registry.withBackend).not.toHaveBeenCalled();
    expect(h.backend.list).not.toHaveBeenCalled();
  });

  it('should reject a traversal path even when no session is running', async () => {
    const h = harness();
    h.registry.withBackend.mockRejectedValue(new NoSessionError('mc'));
    expect(await h.service.list(SAVES, '/a/../b')).toMatchObject({ ok: false, code: 'invalid-path' });
  });

  it('should reject a new folder name containing a slash', async () => {
    const h = harness();
    expect(await h.service.mkdir(SAVES, '/', 'a/b')).toMatchObject({ ok: false, code: 'invalid-path' });
    expect(h.backend.mkdir).not.toHaveBeenCalled();
  });

  it('should reject a volume the session did not mount', async () => {
    const h = harness({}, PARTIAL_LAYOUT);
    const result = await h.service.list(SAVES, '/');
    expect(result).toEqual({ ok: false, code: 'unknown-volume', message: "Apply the infrastructure to browse 'saves'." });
    expect(h.backend.list).not.toHaveBeenCalled();
  });

  it('should name a volume the game never declared as not belonging to the game', async () => {
    const h = harness();
    const result = await h.service.list({ game: 'mc', volume: 'nope' }, '/');
    expect(result).toEqual({ ok: false, code: 'unknown-volume', message: "'nope' is not a volume of 'mc'." });
    expect(h.backend.list).not.toHaveBeenCalled();
  });

  it('should map a volume path to its mount directory', async () => {
    const h = harness({ list: vi.fn().mockResolvedValue([]) });
    await h.service.list(SAVES, '/worlds');
    expect(h.backend.list).toHaveBeenCalledWith('/saves/worlds', expect.any(AbortSignal));
  });

  it('should list the legacy unnamed volume under the fallback layout', async () => {
    const h = harness({ list: vi.fn().mockResolvedValue([]) }, LEGACY_LAYOUT);
    const result = await h.service.list({ game: 'mc', volume: '' }, '/');
    expect(result).toEqual({ ok: true, value: { path: '/', entries: [] } });
    expect(h.backend.list).toHaveBeenCalledWith('/volume-0', expect.any(AbortSignal));
  });

  it('should pass an unknown modification time through as 0', async () => {
    const h = harness({ list: vi.fn().mockResolvedValue([{ name: 'a', isDir: false, size: 3, modifiedMs: 0 }]) });
    const result = await h.service.list(SAVES, '/');
    expect(result).toEqual({ ok: true, value: { path: '/', entries: [{ name: 'a', isDir: false, size: 3, modifiedMs: 0 }] } });
  });

  it('should refuse to delete the volume root', async () => {
    const h = harness();
    expect(await h.service.remove(SAVES, '/')).toMatchObject({ ok: false, code: 'invalid-path' });
    expect(h.backend.remove).not.toHaveBeenCalled();
  });

  it('should refuse to rename the volume root', async () => {
    const h = harness();
    expect(await h.service.rename(SAVES, '/', 'x')).toMatchObject({ ok: false, code: 'invalid-path' });
    expect(h.backend.move).not.toHaveBeenCalled();
  });
});

describe('VolumeFilesService write guards', () => {
  it('should refuse mutations while the server runs and still allow listing', async () => {
    const h = harness({ list: vi.fn().mockResolvedValue([]) });
    h.ecs.findRunningTaskOrThrow.mockResolvedValue({ taskArn: 'arn:t' });
    for (const run of Object.values(mutations(h))) {
      expect(await run()).toEqual({ ok: false, code: 'server-running', message: "'mc' is running. Stop the server to change files." });
    }
    expect((await h.service.list(SAVES, '/')).ok).toBe(true);
    expect(h.ecs.findRunningTaskOrThrow).toHaveBeenCalledWith('game-cluster', 'mc');
  });

  it('should log one info line with the code when a mutation is refused', async () => {
    const h = harness();
    h.ecs.findRunningTaskOrThrow.mockResolvedValue({ taskArn: 'arn:t' });
    vi.mocked(logger.info).mockClear();
    vi.mocked(logger.warn).mockClear();
    await h.service.remove(SAVES, '/old');
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith('VolumeFilesService: file operation refused', {
      game: 'mc',
      volume: 'saves',
      path: '/old',
      code: 'server-running',
    });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('should log a refusal decided inside the session such as an unmounted volume', async () => {
    const h = harness({}, PARTIAL_LAYOUT);
    vi.mocked(logger.info).mockClear();
    await h.service.list(SAVES, '/');
    expect(logger.info).toHaveBeenCalledWith('VolumeFilesService: file operation refused', expect.objectContaining({ code: 'unknown-volume' }));
  });

  it("should refuse mutations when the server state can't be confirmed", async () => {
    const h = harness({ list: vi.fn().mockResolvedValue([]) });
    h.ecs.findRunningTaskOrThrow.mockRejectedValue(new Error('ecs down'));
    for (const run of Object.values(mutations(h))) {
      expect(await run()).toEqual({ ok: false, code: 'server-check-failed', message: "Couldn't confirm the server is stopped." });
    }
    expect((await h.service.list(SAVES, '/')).ok).toBe(true);
  });

  it('should refuse mutations when the stack outputs are missing', async () => {
    const h = harness();
    h.config.getStackOutputs.mockResolvedValue(null);
    expect(await h.service.mkdir(SAVES, '/', 'x')).toMatchObject({ ok: false, code: 'server-check-failed' });
    expect(h.ecs.findRunningTaskOrThrow).not.toHaveBeenCalled();
  });

  it('should refuse every mutation on a fallback layout while still listing', async () => {
    const h = harness({ list: vi.fn().mockResolvedValue([]) }, FALLBACK_LAYOUT);
    const config: VolumeRef = { game: 'mc', volume: 'config' };
    for (const run of Object.values(mutations(h, config))) {
      expect(await run()).toEqual({ ok: false, code: 'apply-needed', message: 'Apply the infrastructure to change files in this volume.' });
    }
    expect((await h.service.list(config, '/')).ok).toBe(true);
    for (const fn of [h.backend.mkdir, h.backend.move, h.backend.remove, h.backend.writeStream]) expect(fn).not.toHaveBeenCalled();
  });

  it('should refuse mutations of the legacy unnamed volume', async () => {
    const h = harness({}, LEGACY_LAYOUT);
    expect(await h.service.mkdir({ game: 'mc', volume: '' }, '/', 'x')).toMatchObject({ ok: false, code: 'apply-needed' });
  });
});

describe('VolumeFilesService mutations', () => {
  it('should map a backend conflict on rename', async () => {
    const h = harness({
      stat: vi.fn().mockResolvedValue(stat({ isDir: true })),
      move: vi.fn().mockRejectedValue(new VolumeFileError('conflict', 'move /saves/old /saves/new failed (409)', 409)),
    });
    expect(await h.service.rename(SAVES, '/old', 'new')).toEqual({ ok: false, code: 'conflict', message: "'new' already exists." });
  });

  it('should rename to a sibling path and return the renamed entry without a helper path', async () => {
    const h = harness({
      stat: vi.fn().mockResolvedValueOnce(stat({ name: 'old', isDir: true })).mockResolvedValueOnce(stat({ name: 'new', isDir: true, size: 0, modifiedMs: 9 })),
      move: vi.fn().mockResolvedValue(undefined),
    });
    const result = await h.service.rename(SAVES, '/worlds/old', 'new');
    expect(h.backend.move).toHaveBeenCalledWith('/saves/worlds/old', '/saves/worlds/new', expect.any(AbortSignal));
    expect(result).toEqual({ ok: true, value: { name: 'new', isDir: true, size: 0, modifiedMs: 9 } });
  });

  it('should report an unknown entry when the stat after a rename fails', async () => {
    const h = harness({
      stat: vi.fn().mockResolvedValueOnce(stat({ isDir: true })).mockRejectedValueOnce(new VolumeFileError('failed', 'x')),
      move: vi.fn().mockResolvedValue(undefined),
    });
    expect(await h.service.rename(SAVES, '/old', 'new')).toEqual({ ok: true, value: { name: 'new', isDir: true, size: 0, modifiedMs: 0 } });
  });

  it('should create a folder and return its entry', async () => {
    const h = harness({ mkdir: vi.fn().mockResolvedValue(undefined), stat: vi.fn().mockResolvedValue(stat({ name: 'new', isDir: true, size: 0, modifiedMs: 7 })) });
    const result = await h.service.mkdir(SAVES, '/worlds', 'new');
    expect(h.backend.mkdir).toHaveBeenCalledWith('/saves/worlds/new', { signal: expect.any(AbortSignal) });
    expect(result).toEqual({ ok: true, value: { name: 'new', isDir: true, size: 0, modifiedMs: 7 } });
  });

  it('should report an unknown entry when the stat after a mkdir fails', async () => {
    const h = harness({ mkdir: vi.fn().mockResolvedValue(undefined), stat: vi.fn().mockRejectedValue(new VolumeFileError('failed', 'x')) });
    expect(await h.service.mkdir(SAVES, '/', 'new')).toEqual({ ok: true, value: { name: 'new', isDir: true, size: 0, modifiedMs: 0 } });
  });

  it('should name the entry in a mkdir conflict', async () => {
    const h = harness({ mkdir: vi.fn().mockRejectedValue(new VolumeFileError('conflict', 'mkdir /saves/new failed (409)', 409)) });
    expect(await h.service.mkdir(SAVES, '/', 'new')).toEqual({ ok: false, code: 'conflict', message: "'new' already exists." });
  });

  it('should delete a path', async () => {
    const h = harness({ remove: vi.fn().mockResolvedValue(undefined) });
    expect(await h.service.remove(SAVES, '/old')).toEqual({ ok: true, value: true });
    expect(h.backend.remove).toHaveBeenCalledWith('/saves/old', expect.any(AbortSignal));
  });
});

describe('VolumeFilesService text files', () => {
  /** Builds a harness whose file stats at `size` and streams `content`, for the text-editor tests. */
  const textBackend = (size: number, content: Buffer | Readable, over: Partial<VolumeStat> = {}) =>
    harness({ stat: vi.fn().mockResolvedValue(stat({ size, ...over })), readStream: vi.fn().mockResolvedValue(content instanceof Readable ? content : Readable.from([content])) });

  it('should read a UTF-8 file and return the volume path, not the helper path', async () => {
    const h = textBackend(5, Buffer.from('héllo'), { modifiedMs: 42 });
    expect(await h.service.readText(SAVES, '/level.dat')).toEqual({ ok: true, value: { path: '/level.dat', content: 'héllo', modifiedMs: 42 } });
  });

  it('should keep a UTF-8 byte order mark so a save writes it back', async () => {
    const h = textBackend(5, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('hi')]));
    expect(await h.service.readText(SAVES, '/level.dat')).toMatchObject({ ok: true, value: { content: '\uFEFFhi' } });
  });

  it('should refuse to open a file over 1 MiB', async () => {
    const over = textBackend(MAX_TEXT_EDIT_BYTES + 1, Buffer.from('x'));
    expect(await over.service.readText(SAVES, '/big.txt')).toMatchObject({ ok: false, code: 'too-large' });
    expect(over.backend.readStream).not.toHaveBeenCalled();
    const exact = textBackend(MAX_TEXT_EDIT_BYTES, Buffer.alloc(MAX_TEXT_EDIT_BYTES, 0x61));
    expect((await exact.service.readText(SAVES, '/big.txt')).ok).toBe(true);
  });

  it('should refuse a file whose stream outgrows the cap after the stat', async () => {
    const stream = Readable.from([Buffer.alloc(MAX_TEXT_EDIT_BYTES, 0x61), Buffer.from('b')]);
    const h = textBackend(10, stream);
    expect(await h.service.readText(SAVES, '/grew.txt')).toMatchObject({ ok: false, code: 'too-large' });
    expect(stream.destroyed).toBe(true);
  });

  it('should refuse to open a non-UTF-8 file', async () => {
    const h = textBackend(2, Buffer.from([0xff, 0xfe]));
    expect(await h.service.readText(SAVES, '/bin')).toMatchObject({ ok: false, code: 'binary' });
  });

  it('should refuse to open a file containing a NUL byte', async () => {
    const h = textBackend(3, Buffer.from([0x61, 0x00, 0x62]));
    expect(await h.service.readText(SAVES, '/bin')).toMatchObject({ ok: false, code: 'binary' });
  });

  it('should refuse to open a folder as text', async () => {
    const h = textBackend(0, Buffer.alloc(0), { isDir: true });
    expect(await h.service.readText(SAVES, '/worlds')).toMatchObject({ ok: false, code: 'invalid-path' });
  });

  it('should refuse a save when the modification time changed', async () => {
    const h = harness({ stat: vi.fn().mockResolvedValue(stat({ modifiedMs: 2 })) });
    const result = await h.service.writeText(SAVES, '/level.dat', 'x', 1);
    expect(result).toEqual({ ok: false, code: 'conflict', message: 'The file changed on the volume since you opened it.' });
    expect(h.backend.writeStream).not.toHaveBeenCalled();
  });

  it('should refuse a save when either modification time is unknown', async () => {
    const unknownActual = harness({ stat: vi.fn().mockResolvedValue(stat({ modifiedMs: 0 })) });
    expect(await unknownActual.service.writeText(SAVES, '/a', 'x', 0)).toMatchObject({ ok: false, code: 'conflict' });
    const unknownExpected = harness({ stat: vi.fn().mockResolvedValue(stat({ modifiedMs: 5 })) });
    expect(await unknownExpected.service.writeText(SAVES, '/a', 'x', 0)).toMatchObject({ ok: false, code: 'conflict' });
    expect(unknownActual.backend.writeStream).not.toHaveBeenCalled();
    expect(unknownExpected.backend.writeStream).not.toHaveBeenCalled();
  });

  it('should refuse to save content over 1 MiB', async () => {
    const h = harness();
    const result = await h.service.writeText(SAVES, '/a', 'x'.repeat(MAX_TEXT_EDIT_BYTES + 1), 1);
    expect(result).toMatchObject({ ok: false, code: 'too-large' });
    expect(h.backend.writeStream).not.toHaveBeenCalled();
  });

  it('should save and return the new modification time', async () => {
    const h = harness({
      stat: vi.fn().mockResolvedValueOnce(stat({ modifiedMs: 1 })).mockResolvedValueOnce(stat({ modifiedMs: 5 })),
      writeStream: vi.fn().mockResolvedValue(undefined),
    });
    const result = await h.service.writeText(SAVES, '/level.dat', 'héllo', 1);
    expect(h.backend.writeStream).toHaveBeenCalledWith('/saves/level.dat', expect.any(Readable), expect.objectContaining({ overwrite: true, size: 6 }));
    expect(result).toEqual({ ok: true, value: { modifiedMs: 5 } });
  });

  it('should build a fresh source stream for each attempt of a save', async () => {
    const sources: Readable[] = [];
    const h = harness({
      stat: vi.fn().mockResolvedValue(stat()),
      writeStream: vi.fn(async (_p: string, source: Readable) => {
        sources.push(source);
      }),
    });
    const attempt = h.registry.withBackend.getMockImplementation()!;
    h.registry.withBackend.mockImplementation(async (game, op) => {
      await attempt(game, op);
      return attempt(game, op);
    });
    await h.service.writeText(SAVES, '/level.dat', 'x', 1);
    expect(sources).toHaveLength(2);
    expect(sources[0]).not.toBe(sources[1]);
  });
});

describe('VolumeFilesService error mapping', () => {
  it('should return no-session when nothing is running', async () => {
    const h = harness();
    h.registry.withBackend.mockRejectedValue(new NoSessionError('mc'));
    expect(await h.service.list(SAVES, '/')).toMatchObject({ ok: false, code: 'no-session' });
  });

  it('should map each modeled backend failure to a fixed operator message', async () => {
    const cases: [VolumeFileError['code'], string, string][] = [
      ['not-found', 'not-found', "'/gone' no longer exists."],
      ['unreachable', 'unreachable', "The file manager isn't reachable. Restart the session."],
      ['auth', 'auth', 'The file manager rejected the session. Restart the session.'],
      ['pin-mismatch', 'pin-mismatch', "The file manager's identity couldn't be verified. Restart the session."],
    ];
    for (const [code, expected, message] of cases) {
      const h = harness({ list: vi.fn().mockRejectedValue(new VolumeFileError(code, 'list /saves/gone failed (500)')) });
      expect(await h.service.list(SAVES, '/gone')).toEqual({ ok: false, code: expected, message });
    }
  });

  it('should never echo a backend message that names a helper path', async () => {
    const h = harness({
      list: vi.fn().mockRejectedValue(new VolumeFileError('conflict', 'list /saves/secret-dir failed (409)')),
      remove: vi.fn().mockRejectedValue(new Error('EACCES: permission denied, open /saves/secret-dir')),
    });
    for (const result of [await h.service.list(SAVES, '/x'), await h.service.remove(SAVES, '/x')]) {
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain('/saves/');
      expect(JSON.stringify(result)).not.toContain('secret-dir');
    }
  });

  it('should map an unexpected error to failed with a fixed message', async () => {
    const h = harness({ list: vi.fn().mockRejectedValue(new TypeError('boom')) });
    expect(await h.service.list(SAVES, '/')).toEqual({ ok: false, code: 'failed', message: 'The file operation failed.' });
  });

  it('should map a metadata operation that times out to unreachable', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(AbortSignal.abort(new DOMException('timed out', 'TimeoutError')));
    const h = harness({
      list: vi.fn(async (_dir: string, signal?: AbortSignal) => {
        signal?.throwIfAborted();
        return [];
      }),
    });
    expect(await h.service.list(SAVES, '/')).toEqual({ ok: false, code: 'unreachable', message: "The file manager didn't respond in time." });
    expect(timeout).toHaveBeenCalledWith(METADATA_OP_TIMEOUT_MS);
  });

  it('should map a timeout the client wrapped as unreachable to the timeout message', async () => {
    const wrapped = new VolumeFileError('unreachable', 'x', undefined, { cause: new DOMException('t', 'TimeoutError') });
    const h = harness({ stat: vi.fn().mockRejectedValue(wrapped) });
    expect(await h.service.readText(SAVES, '/a')).toEqual({ ok: false, code: 'unreachable', message: "The file manager didn't respond in time." });
  });

  it('should start a fresh timeout budget when the registry retries an operation', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const h = harness({ list: vi.fn().mockResolvedValue([]) });
    const attempt = h.registry.withBackend.getMockImplementation()!;
    h.registry.withBackend.mockImplementation(async (game, op) => {
      await attempt(game, op);
      return attempt(game, op);
    });
    await h.service.list(SAVES, '/');
    expect(timeout).toHaveBeenCalledTimes(2);
  });
});

describe('VolumeFilesService sessions', () => {
  it('should map session times to ISO strings and keep only the public fields', async () => {
    const h = harness();
    expect(await h.service.sessionStatus('mc')).toEqual({
      game: 'mc',
      state: 'running',
      startedAt: '2026-01-02T03:04:05.000Z',
      autoStopAt: '2026-01-02T05:04:05.000Z',
      browseHeld: true,
      uploadHolders: 0,
      supportsArchive: true,
      volumes: [{ name: 'saves', containerPath: '/data/saves', mounted: true }],
    });
  });

  it('should omit absent times and carry the session error', async () => {
    const h = harness();
    h.registry.status.mockResolvedValue(snapshot({ state: 'failed', startedAt: undefined, autoStopAt: undefined, error: 'launch failed' }));
    const status = await h.service.sessionStatus('mc');
    expect(status).toMatchObject({ state: 'failed', error: 'launch failed' });
    expect(status).not.toHaveProperty('startedAt');
    expect(status).not.toHaveProperty('autoStopAt');
  });

  it('should report a failed snapshot when the registry cannot read the session', async () => {
    const h = harness();
    h.registry.status.mockRejectedValue(new Error('ecs lookup failed'));
    expect(await h.service.sessionStatus('mc')).toEqual({
      game: 'mc',
      state: 'failed',
      error: 'ecs lookup failed',
      browseHeld: false,
      uploadHolders: 0,
      supportsArchive: false,
      volumes: [],
    });
  });

  it('should scrub addresses from a session error and keep the full text in the log', async () => {
    const h = harness();
    const raw = 'Could not open the file manager port to your IP: rule 1.2.3.4/32 exists, see https://5.6.7.8:8080/x for 9.9.9.9';
    h.registry.status.mockResolvedValue(snapshot({ state: 'failed', error: raw }));
    const status = await h.service.sessionStatus('mc');
    expect(status.error).toBe('Could not open the file manager port to your IP: rule <address> exists, see <address> for <address>');
    expectNoSecretFields(status);
  });

  it('should scrub addresses from pushed session errors and lookup failures', async () => {
    const h = harness();
    let emit: (s: HelperSessionSnapshot) => void = () => undefined;
    h.registry.onState.mockImplementation((listener: (s: HelperSessionSnapshot) => void) => {
      emit = listener;
      return () => undefined;
    });
    const received: unknown[] = [];
    h.service.onSession((status) => received.push(status));
    emit(snapshot({ state: 'failed', error: 'refused by 10.0.0.1/24' }));
    expect(received).toEqual([expect.objectContaining({ error: 'refused by <address>' })]);
    h.registry.status.mockRejectedValue(new Error('lookup at https://10.1.1.1:443 failed'));
    const failed = await h.service.sessionStatus('mc');
    expect(failed.error).toBe('lookup at <address> failed');
    expect(failedSessionStatus('mc', 'bad 1.2.3.4').error).toBe('bad <address>');
  });

  it('should scrub addresses from a failed stop or restart', async () => {
    const h = harness();
    h.registry.stop.mockResolvedValue({ success: false, message: 'could not reach https://1.2.3.4:8080 (1.2.3.4/32)' });
    const stop = await h.service.sessionStop('mc');
    const restart = await h.service.sessionRestart('mc');
    expect(stop).toEqual({ ok: false, code: 'failed', message: 'could not reach <address> (<address>)' });
    expect(restart).toEqual(stop);
    expectNoSecretFields([stop, restart]);
  });

  it('should push registry state changes as the mapped public status', () => {
    const h = harness();
    const unsubscribe = () => undefined;
    let emit: (s: HelperSessionSnapshot) => void = () => undefined;
    h.registry.onState.mockImplementation((listener: (s: HelperSessionSnapshot) => void) => {
      emit = listener;
      return unsubscribe;
    });
    const received: unknown[] = [];
    expect(h.service.onSession((status) => received.push(status))).toBe(unsubscribe);
    emit(snapshot());
    expect(received).toEqual([expect.objectContaining({ game: 'mc', startedAt: '2026-01-02T03:04:05.000Z' })]);
  });

  it('should build a failed status with no volumes', () => {
    expect(failedSessionStatus('mc', 'nope')).toEqual({
      game: 'mc',
      state: 'failed',
      error: 'nope',
      browseHeld: false,
      uploadHolders: 0,
      supportsArchive: false,
      volumes: [],
    });
  });

  it('should start a session without waiting for it to become ready', async () => {
    const h = harness();
    h.registry.acquire.mockReturnValue(new Promise(() => {}));
    h.registry.status.mockResolvedValue(snapshot({ state: 'starting' }));
    expect(await h.service.sessionStart('mc')).toMatchObject({ state: 'starting' });
    expect(h.registry.acquire).toHaveBeenCalledWith('mc', 'browse');
  });

  it('should not surface a failed acquire from sessionStart', async () => {
    const h = harness();
    h.registry.acquire.mockRejectedValue(new Error('launch failed'));
    await expect(h.service.sessionStart('mc')).resolves.toMatchObject({ game: 'mc' });
  });

  it('should re-hold the browse page on attach and release it on detach', async () => {
    const h = harness();
    expect(await h.service.sessionAttach('mc')).toMatchObject({ game: 'mc' });
    expect(h.registry.attach).toHaveBeenCalledWith('mc');
    expect(await h.service.sessionDetach('mc')).toMatchObject({ game: 'mc' });
    expect(h.registry.release).toHaveBeenCalledWith('mc', 'browse');
  });

  it('should stop a session and return its status', async () => {
    const h = harness();
    h.registry.status.mockResolvedValue(snapshot({ state: 'stopped' }));
    expect(await h.service.sessionStop('mc')).toMatchObject({ ok: true, value: { state: 'stopped' } });
  });

  it('should report a failed stop', async () => {
    const h = harness();
    h.registry.stop.mockResolvedValue({ success: false, message: 'could not stop' });
    expect(await h.service.sessionStop('mc')).toEqual({ ok: false, code: 'failed', message: 'could not stop' });
    expect(await h.service.sessionRestart('mc')).toEqual({ ok: false, code: 'failed', message: 'could not stop' });
    expect(h.registry.acquire).not.toHaveBeenCalled();
  });

  it('should restart by stopping, then starting without waiting for readiness', async () => {
    const h = harness();
    h.registry.acquire.mockReturnValue(new Promise(() => {}));
    h.registry.status.mockResolvedValue(snapshot({ state: 'starting' }));
    expect(await h.service.sessionRestart('mc')).toMatchObject({ ok: true, value: { state: 'starting' } });
    expect(h.registry.stop).toHaveBeenCalledWith('mc');
    expect(h.registry.acquire).toHaveBeenCalledWith('mc', 'browse');
  });
});

describe('VolumeFilesService results', () => {
  it('should carry no secret fields in any result', async () => {
    const h = harness({
      list: vi.fn().mockResolvedValue([{ name: 'a', isDir: false, size: 1, modifiedMs: 1 }]),
      stat: vi.fn().mockResolvedValue(stat()),
      mkdir: vi.fn().mockResolvedValue(undefined),
      move: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
      readStream: vi.fn().mockImplementation(async () => Readable.from([Buffer.from('text')])),
      writeStream: vi.fn().mockResolvedValue(undefined),
    });
    const results = [
      await h.service.list(SAVES, '/'),
      await h.service.mkdir(SAVES, '/', 'd'),
      await h.service.rename(SAVES, '/a', 'b'),
      await h.service.remove(SAVES, '/a'),
      await h.service.readText(SAVES, '/a'),
      await h.service.writeText(SAVES, '/a', 'x', 1),
      await h.service.sessionStatus('mc'),
      await h.service.sessionStop('mc'),
    ];
    for (const result of results) expectNoSecretFields(result);
  });
});

let local: string;
beforeEach(async () => {
  local = await mkdtemp(join(tmpdir(), 'vfs-'));
});
afterEach(() => rm(local, { recursive: true, force: true }));

/** Collects transfer events and resolves to the terminal one. */
function watchTransfers(h: Harness) {
  const events: VolumeTransferProgress[] = [];
  h.service.onTransfer((e) => events.push(e));
  const settled = async () => {
    await vi.waitFor(() => expect(['done', 'failed', 'cancelled']).toContain(events.at(-1)?.phase));
    return events.at(-1)!;
  };
  return { events, settled };
}

describe('VolumeFilesService downloads', () => {
  /** Backend overrides for a file of `text` that stats and streams it. */
  const fileBackend = (text = 'hello') => ({
    stat: vi.fn().mockResolvedValue(stat({ name: 'level.dat', size: text.length })),
    readStream: vi.fn().mockImplementation(async () => Readable.from([Buffer.from(text)])),
  });

  it('should not start a download when the save dialog is cancelled', async () => {
    const h = harness(fileBackend());
    h.dialogs.pickSavePath.mockResolvedValue(null);
    expect(await h.service.download(SAVES, '/level.dat', false)).toEqual({ ok: true, value: null });
    expect(h.backend.readStream).not.toHaveBeenCalled();
    expect(h.registry.acquire).not.toHaveBeenCalled();
  });

  it('should emit progress and done with the saved file name', async () => {
    const h = harness(fileBackend('hello'));
    const target = join(local, 'out.dat');
    h.dialogs.pickSavePath.mockResolvedValue(target);
    const { events, settled } = watchTransfers(h);
    const result = await h.service.download(SAVES, '/level.dat', false);
    expect(result).toMatchObject({ ok: true, value: { transferId: expect.any(String) } });
    const end = await settled();
    expect(end).toMatchObject({ game: 'mc', kind: 'download', name: 'level.dat', phase: 'done', bytesDone: 5, bytesTotal: 5, savedAs: 'out.dat' });
    expect(JSON.stringify(events)).not.toContain(local);
    expect(await readFile(target, 'utf8')).toBe('hello');
    expect(h.dialogs.pickSavePath).toHaveBeenCalledWith('level.dat');
    expect(h.backend.readStream).toHaveBeenCalledWith('/saves/level.dat', expect.any(AbortSignal));
  });

  it('should hold the session for the transfer and release it afterwards', async () => {
    const h = harness(fileBackend());
    h.dialogs.pickSavePath.mockResolvedValue(join(local, 'out.dat'));
    const { settled } = watchTransfers(h);
    await h.service.download(SAVES, '/level.dat', false);
    await settled();
    const [, holder] = h.registry.acquire.mock.calls[0] as [string, string];
    expect(holder).toMatch(/^upload:xfer-/);
    expect(h.registry.release).toHaveBeenCalledWith('mc', holder);
  });

  it('should stream a folder as an archive with an unknown total and a .zip default name', async () => {
    const h = harness({
      supportsArchive: true,
      archiveStream: vi.fn().mockImplementation(async () => Readable.from([Buffer.from('PK')])),
    });
    h.dialogs.pickSavePath.mockResolvedValue(join(local, 'worlds.zip'));
    const { events, settled } = watchTransfers(h);
    await h.service.download(SAVES, '/worlds', true);
    expect(await settled()).toMatchObject({ phase: 'done', bytesDone: 2, bytesTotal: null, savedAs: 'worlds.zip' });
    expect(events[0]).toMatchObject({ phase: 'running', bytesTotal: null });
    expect(h.dialogs.pickSavePath).toHaveBeenCalledWith('worlds.zip');
    expect(h.backend.archiveStream).toHaveBeenCalledWith('/saves/worlds', expect.any(AbortSignal));
  });

  it('should refuse a folder download when the backend has no archive support', async () => {
    const h = harness();
    const result = await h.service.download(SAVES, '/worlds', true);
    expect(result).toEqual({ ok: false, code: 'failed', message: 'Folder download is not supported by this backend.' });
    expect(h.dialogs.pickSavePath).not.toHaveBeenCalled();
  });

  it.each([
    ['the volume name', SAVES, 'saves.zip'],
    ['"volume" for the unnamed legacy volume', { game: 'mc', volume: '' }, 'volume.zip'],
  ])('should default the root download name to %s', async (_label, ref, expected) => {
    const h = harness({ supportsArchive: true, archiveStream: vi.fn().mockResolvedValue(Readable.from([])) }, layoutFor(ref));
    h.dialogs.pickSavePath.mockResolvedValue(null);
    await h.service.download(ref, '/', true);
    expect(h.dialogs.pickSavePath).toHaveBeenCalledWith(expected);
  });

  it('should sanitize the default name for the local platform', async () => {
    const h = harness(fileBackend());
    h.dialogs.pickSavePath.mockResolvedValue(null);
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    await h.service.download(SAVES, '/con.txt', false);
    expect(h.dialogs.pickSavePath).toHaveBeenCalledWith('_con.txt');
  });

  it('should still download when the server state cannot be confirmed', async () => {
    const h = harness(fileBackend());
    h.ecs.findRunningTaskOrThrow.mockRejectedValue(new Error('ecs down'));
    h.dialogs.pickSavePath.mockResolvedValue(join(local, 'out.dat'));
    const { settled } = watchTransfers(h);
    expect(await h.service.download(SAVES, '/level.dat', false)).toMatchObject({ ok: true, value: { transferId: expect.any(String) } });
    expect((await settled()).phase).toBe('done');
  });

  it('should return no-session before opening the dialog when no session is running', async () => {
    const h = harness(fileBackend());
    h.registry.withBackend.mockRejectedValue(new NoSessionError('mc'));
    expect(await h.service.download(SAVES, '/level.dat', false)).toMatchObject({ ok: false, code: 'no-session' });
    expect(h.dialogs.pickSavePath).not.toHaveBeenCalled();
  });

  it('should return no-session when the session stops while the dialog is open', async () => {
    const h = harness(fileBackend());
    h.dialogs.pickSavePath.mockImplementation(async () => {
      h.registry.status.mockResolvedValue(snapshot({ state: 'stopped' }));
      return join(local, 'out.dat');
    });
    expect(await h.service.download(SAVES, '/level.dat', false)).toMatchObject({ ok: false, code: 'no-session' });
    expect(h.registry.acquire).not.toHaveBeenCalled();
  });

  it('should report a missing file and a folder asked for as a file before the dialog', async () => {
    const h = harness({ stat: vi.fn().mockRejectedValue(new VolumeFileError('not-found', 'stat /saves/x failed (404)', 404)) });
    expect(await h.service.download(SAVES, '/x', false)).toEqual({ ok: false, code: 'not-found', message: "'/x' no longer exists." });
    const dirs = harness({ stat: vi.fn().mockResolvedValue(stat({ isDir: true })) });
    expect(await dirs.service.download(SAVES, '/d', false)).toMatchObject({ ok: false, code: 'invalid-path' });
    expect(h.dialogs.pickSavePath).not.toHaveBeenCalled();
    expect(dirs.dialogs.pickSavePath).not.toHaveBeenCalled();
  });

  it('should reject a traversal path before any dialog', async () => {
    const h = harness(fileBackend());
    expect(await h.service.download(SAVES, '/a/../b', false)).toMatchObject({ ok: false, code: 'invalid-path' });
    expect(h.dialogs.pickSavePath).not.toHaveBeenCalled();
  });

  it('should cancel a running download and leave no file behind', async () => {
    const stuck = new PassThrough();
    const h = harness({ ...fileBackend(), readStream: vi.fn().mockResolvedValue(stuck) });
    const target = join(local, 'out.dat');
    h.dialogs.pickSavePath.mockResolvedValue(target);
    const { settled } = watchTransfers(h);
    const result = await h.service.download(SAVES, '/level.dat', false);
    if (!result.ok || !result.value) throw new Error('download did not start');
    stuck.write(Buffer.from('he'));
    expect(h.service.cancelTransfer('mc', result.value.transferId)).toEqual({ cancelled: true });
    expect(await settled()).toMatchObject({ phase: 'cancelled' });
    expect(await readdir(local)).toEqual([]);
  });

  it('should cancel running transfers when the game session is stopping', async () => {
    const stuck = new PassThrough();
    const h = harness({ ...fileBackend(), readStream: vi.fn().mockResolvedValue(stuck) });
    h.dialogs.pickSavePath.mockResolvedValue(join(local, 'out.dat'));
    const { settled } = watchTransfers(h);
    await h.service.download(SAVES, '/level.dat', false);
    h.beforeStop('mc');
    expect(await settled()).toMatchObject({ phase: 'cancelled' });
    expect(await readdir(local)).toEqual([]);
  });

  it('should report a connection dropped mid-download as unreachable and leave no part file', async () => {
    const dropped = new Readable({ read() {} });
    const h = harness({ ...fileBackend(), readStream: vi.fn().mockResolvedValue(dropped) });
    h.dialogs.pickSavePath.mockResolvedValue(join(local, 'out.dat'));
    const { settled } = watchTransfers(h);
    await h.service.download(SAVES, '/level.dat', false);
    dropped.push(Buffer.from('he'));
    setTimeout(() => dropped.destroy(Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' })), 20);
    expect(await settled()).toMatchObject({ phase: 'failed', error: "The file manager isn't reachable. Restart the session." });
    expect(await readdir(local)).toEqual([]);
  });

  it('should report a local write failure without naming the local path', async () => {
    const h = harness(fileBackend());
    h.dialogs.pickSavePath.mockResolvedValue(join(local, 'missing-dir', 'out.dat'));
    const { settled } = watchTransfers(h);
    await h.service.download(SAVES, '/level.dat', false);
    const end = await settled();
    expect(end).toMatchObject({ phase: 'failed', error: "Couldn't write to that location." });
    expect(JSON.stringify(end)).not.toContain(local);
  });

  it('should say a transfer is not running for an unknown id', () => {
    const h = harness();
    expect(h.service.cancelTransfer('mc', 'nope')).toEqual({ cancelled: false });
  });
});

/** The unnamed-volume legacy layout for the `''` ref, the full layout otherwise. */
function layoutFor(ref: VolumeRef): HelperVolumeLayout {
  return ref.volume === '' ? LEGACY_LAYOUT : FULL_LAYOUT;
}

describe('VolumeFilesService file uploads', () => {
  /** A `stat` that rejects `not-found`, so every upload target looks free. */
  const missing = () => vi.fn().mockRejectedValue(new VolumeFileError('not-found', 'stat failed (404)', 404));

  /** Writes `text` to a new file called `name` in the temp directory and returns its path. */
  async function localFile(name: string, text: string): Promise<string> {
    const path = join(local, name);
    await writeFile(path, text);
    return path;
  }

  it('should upload dropped files without overwriting and report progress', async () => {
    const h = harness({ stat: missing() });
    const a = await localFile('a.txt', 'aaa');
    const b = await localFile('b.txt', 'bb');
    const { settled } = watchTransfers(h);
    const result = await h.service.uploadFiles(SAVES, '/worlds', [a, b]);
    expect(result).toMatchObject({ ok: true, value: { transferId: expect.any(String) } });
    expect(await settled()).toMatchObject({ kind: 'upload', name: '2 files', phase: 'done', bytesDone: 5, bytesTotal: 5 });
    expect(h.backend.writeStream).toHaveBeenCalledWith('/saves/worlds/a.txt', expect.any(Readable), expect.objectContaining({ size: 3, overwrite: false }));
    expect(h.backend.writeStream).toHaveBeenCalledWith('/saves/worlds/b.txt', expect.any(Readable), expect.objectContaining({ size: 2, overwrite: false }));
    expect(h.dialogs.pickFiles).not.toHaveBeenCalled();
  });

  it('should name a single-file upload after the file and ask the dialog when no paths are given', async () => {
    const h = harness({ stat: missing() });
    h.dialogs.pickFiles.mockResolvedValue([await localFile('a.txt', 'aaa')]);
    const { settled } = watchTransfers(h);
    await h.service.uploadFiles(SAVES, '/', undefined);
    expect(await settled()).toMatchObject({ name: 'a.txt', phase: 'done' });
    expect(h.backend.writeStream).toHaveBeenCalledWith('/saves/a.txt', expect.anything(), expect.anything());
  });

  it('should do nothing when the file dialog is cancelled', async () => {
    const h = harness();
    h.dialogs.pickFiles.mockResolvedValue([]);
    expect(await h.service.uploadFiles(SAVES, '/', undefined)).toEqual({ ok: true, value: null });
    expect(h.registry.acquire).not.toHaveBeenCalled();
  });

  it('should refuse an upload whose name already exists', async () => {
    const h = harness({ stat: vi.fn().mockResolvedValue(stat({ name: 'a.txt', size: 10 })) });
    const a = await localFile('a.txt', 'aaa');
    const result = await h.service.uploadFiles(SAVES, '/', [a]);
    expect(result).toEqual({ ok: false, code: 'conflict', message: "'a.txt' already exists." });
    expect(h.backend.writeStream).not.toHaveBeenCalled();
    expect(h.registry.acquire).not.toHaveBeenCalled();
  });

  it('should log an upload refused because the name exists', async () => {
    const h = harness({ stat: vi.fn().mockResolvedValue(stat({ name: 'a.txt' })) });
    vi.mocked(logger.info).mockClear();
    await h.service.uploadFiles(SAVES, '/worlds', [await localFile('a.txt', 'aaa')]);
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith('VolumeFilesService: file operation refused', { game: 'mc', volume: 'saves', path: '/worlds', code: 'conflict' });
  });

  it('should log a folder upload refused for an unknown volume', async () => {
    const h = harness();
    vi.mocked(logger.info).mockClear();
    await h.service.uploadFolder({ game: 'mc', volume: 'nope' }, '/');
    expect(logger.info).toHaveBeenCalledWith('VolumeFilesService: file operation refused', expect.objectContaining({ code: 'unknown-volume', volume: 'nope' }));
  });

  it('should refuse the whole upload when any one name exists', async () => {
    const h = harness({
      stat: vi.fn().mockImplementation(async (path: string) => {
        if (path.endsWith('/b.txt')) return stat({ name: 'b.txt' });
        throw new VolumeFileError('not-found', 'stat failed (404)', 404);
      }),
    });
    const result = await h.service.uploadFiles(SAVES, '/', [await localFile('a.txt', 'a'), await localFile('b.txt', 'b')]);
    expect(result).toMatchObject({ ok: false, code: 'conflict', message: "'b.txt' already exists." });
    expect(h.backend.writeStream).not.toHaveBeenCalled();
  });

  it('should refuse two files that share a name', async () => {
    const h = harness({ stat: missing() });
    await mkdir(join(local, 'sub'));
    const a = await localFile('a.txt', 'a');
    const b = join(local, 'sub', 'a.txt');
    await writeFile(b, 'b');
    expect(await h.service.uploadFiles(SAVES, '/', [a, b])).toMatchObject({ ok: false, code: 'conflict' });
  });

  it('should reject a dropped path that did not resolve', async () => {
    const h = harness();
    expect(await h.service.uploadFiles(SAVES, '/', [''])).toMatchObject({ ok: false, code: 'invalid-path' });
    expect(h.registry.withBackend).not.toHaveBeenCalled();
    expect(h.dialogs.pickFiles).not.toHaveBeenCalled();
  });

  it('should reject a folder, a missing path and a bad destination', async () => {
    const h = harness({ stat: missing() });
    expect(await h.service.uploadFiles(SAVES, '/', [local])).toMatchObject({ ok: false, code: 'invalid-path', message: expect.stringContaining('isn\'t a file') });
    expect(await h.service.uploadFiles(SAVES, '/', [join(local, 'gone.txt')])).toMatchObject({ ok: false, code: 'invalid-path' });
    expect(await h.service.uploadFiles(SAVES, '/a/../b', [await localFile('a.txt', 'a')])).toMatchObject({ ok: false, code: 'invalid-path' });
    expect(h.backend.writeStream).not.toHaveBeenCalled();
  });

  it('should not leak the local path in a refusal', async () => {
    const h = harness();
    const result = await h.service.uploadFiles(SAVES, '/', [local]);
    expect(JSON.stringify(result)).not.toContain(local);
  });

  it('should refuse before the dialog while the server is running or unconfirmable', async () => {
    const h = harness();
    h.ecs.findRunningTaskOrThrow.mockResolvedValue({ taskArn: 'arn' });
    expect(await h.service.uploadFiles(SAVES, '/', undefined)).toMatchObject({ ok: false, code: 'server-running' });
    h.ecs.findRunningTaskOrThrow.mockRejectedValue(new Error('down'));
    expect(await h.service.uploadFiles(SAVES, '/', undefined)).toMatchObject({ ok: false, code: 'server-check-failed' });
    expect(h.dialogs.pickFiles).not.toHaveBeenCalled();
  });

  it('should return no-session before the dialog when the session is not running', async () => {
    const h = harness();
    h.registry.status.mockResolvedValue(snapshot({ state: 'stopped' }));
    expect(await h.service.uploadFiles(SAVES, '/', undefined)).toMatchObject({ ok: false, code: 'no-session' });
    expect(h.dialogs.pickFiles).not.toHaveBeenCalled();
  });

  it('should refuse uploads into a legacy fallback layout before any bytes move', async () => {
    const h = harness({ stat: missing() }, FALLBACK_LAYOUT);
    const result = await h.service.uploadFiles({ game: 'mc', volume: 'config' }, '/', [await localFile('a.txt', 'a')]);
    expect(result).toMatchObject({ ok: false, code: 'apply-needed' });
    expect(h.backend.writeStream).not.toHaveBeenCalled();
  });

  it('should surface a failure during the transfer as a failed phase with an operator message', async () => {
    const h = harness({
      stat: missing(),
      writeStream: vi.fn().mockRejectedValue(new VolumeFileError('conflict', 'upload /saves/a.txt failed (409)', 409)),
    });
    const { settled } = watchTransfers(h);
    await h.service.uploadFiles(SAVES, '/', [await localFile('a.txt', 'a')]);
    expect(await settled()).toMatchObject({ phase: 'failed', error: "'a.txt' already exists." });
    expect(h.registry.release).toHaveBeenCalledTimes(1);
  });

  it('should open a fresh read stream for each attempt and not double count a replayed file', async () => {
    const sources: Readable[] = [];
    const h = harness({
      stat: missing(),
      writeStream: vi.fn(async (_path: string, source: Readable, options: { onBytes?: (n: number) => void }) => {
        sources.push(source);
        source.destroy();
        options.onBytes?.(3);
      }),
    });
    const attempt = h.registry.withBackend.getMockImplementation()!;
    let calls = 0;
    h.registry.withBackend.mockImplementation(async (game, op) => {
      calls += 1;
      // Only the transfer's write replays; the pre-transfer stat phase is the first call.
      if (calls === 2) await attempt(game, op);
      return attempt(game, op);
    });
    const { settled } = watchTransfers(h);
    await h.service.uploadFiles(SAVES, '/', [await localFile('a.txt', 'aaa')]);
    expect(await settled()).toMatchObject({ phase: 'done', bytesDone: 3 });
    expect(sources).toHaveLength(2);
    expect(sources[0]).not.toBe(sources[1]);
  });

  it('should check the server again before each file and stop the transfer when it has started', async () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    const h = harness({ stat: missing(), remove });
    h.backend.writeStream.mockImplementation(async () => {
      h.ecs.findRunningTaskOrThrow.mockResolvedValue({ taskArn: 'arn' });
    });
    const { settled } = watchTransfers(h);
    await h.service.uploadFiles(SAVES, '/', [await localFile('a.txt', 'a'), await localFile('b.txt', 'b')]);
    const end = await settled();
    expect(end).toMatchObject({ phase: 'failed', error: "Upload stopped. 'mc' is running. Stop the server to change files." });
    expect(h.backend.writeStream).toHaveBeenCalledTimes(1);
    expect(h.backend.writeStream).toHaveBeenCalledWith('/saves/a.txt', expect.anything(), expect.anything());
    expect(remove).not.toHaveBeenCalled();
    expect(h.registry.release).toHaveBeenCalledTimes(1);
  });

  it('should stop the transfer before its first file when the server state can no longer be confirmed', async () => {
    const h = harness({ stat: missing() });
    h.ecs.findRunningTaskOrThrow.mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockRejectedValue(new Error('down'));
    const { settled } = watchTransfers(h);
    await h.service.uploadFiles(SAVES, '/', [await localFile('a.txt', 'a')]);
    expect(await settled()).toMatchObject({ phase: 'failed', error: "Upload stopped. Couldn't confirm the server is stopped." });
    expect(h.backend.writeStream).not.toHaveBeenCalled();
  });

  it('should hold the session before the transfer checks the server for the last time', async () => {
    const h = harness({ stat: missing() });
    const order: string[] = [];
    h.registry.acquire.mockImplementation(async () => {
      order.push('acquire');
      return { ok: true };
    });
    h.ecs.findRunningTaskOrThrow.mockImplementation(async () => {
      order.push('check');
      return null;
    });
    const { settled } = watchTransfers(h);
    await h.service.uploadFiles(SAVES, '/', [await localFile('a.txt', 'a')]);
    await settled();
    expect(order.at(-1)).toBe('check');
    expect(order.indexOf('acquire')).toBeLessThan(order.lastIndexOf('check'));
  });

  describe('target reservations', () => {
    /** A write that never finishes until aborted. */
    const hangingWrite = () =>
      vi.fn((_path: string, _source: Readable, options: { signal?: AbortSignal }) =>
        new Promise<void>((_resolve, reject) => options.signal?.addEventListener('abort', () => reject(new Error('aborted')))),
      );

    it('should refuse an overlapping upload of the same name without writing anything', async () => {
      const h = harness({ stat: missing(), writeStream: hangingWrite(), remove: vi.fn().mockResolvedValue(undefined) });
      const { settled } = watchTransfers(h);
      const first = await h.service.uploadFiles(SAVES, '/', [await localFile('a.txt', 'a')]);
      if (!first.ok || !first.value) throw new Error('upload did not start');
      await vi.waitFor(() => expect(h.backend.writeStream).toHaveBeenCalledTimes(1));

      const second = await h.service.uploadFiles(SAVES, '/', [await localFile('a.txt', 'a'), await localFile('b.txt', 'b')]);

      expect(second).toEqual({ ok: false, code: 'conflict', message: "'a.txt' is already being uploaded." });
      expect(h.backend.writeStream).toHaveBeenCalledTimes(1);
      expect(h.registry.acquire).toHaveBeenCalledTimes(1);
      h.service.cancelTransfer('mc', first.value.transferId);
      await settled();
    });

    it('should reserve the targets of two simultaneous calls atomically', async () => {
      const h = harness({ stat: missing(), writeStream: hangingWrite(), remove: vi.fn().mockResolvedValue(undefined) });
      const a = await localFile('a.txt', 'a');
      const [one, two] = await Promise.all([h.service.uploadFiles(SAVES, '/', [a]), h.service.uploadFiles(SAVES, '/', [a])]);
      expect([one.ok, two.ok].sort()).toEqual([false, true]);
      h.beforeStop('mc');
    });

    it('should let a different directory or name upload meanwhile', async () => {
      const h = harness({ stat: missing(), writeStream: hangingWrite(), remove: vi.fn().mockResolvedValue(undefined) });
      const first = await h.service.uploadFiles(SAVES, '/', [await localFile('a.txt', 'a')]);
      const other = await h.service.uploadFiles(SAVES, '/worlds', [await localFile('a.txt', 'a')]);
      const third = await h.service.uploadFiles(SAVES, '/', [await localFile('b.txt', 'b')]);
      expect([first.ok, other.ok, third.ok]).toEqual([true, true, true]);
      h.beforeStop('mc');
    });

    it('should release the reservation after a successful upload', async () => {
      const h = harness({ stat: missing() });
      const { settled } = watchTransfers(h);
      const a = await localFile('a.txt', 'a');
      await h.service.uploadFiles(SAVES, '/', [a]);
      expect(await settled()).toMatchObject({ phase: 'done' });
      expect(await h.service.uploadFiles(SAVES, '/', [a])).toMatchObject({ ok: true });
    });

    it('should release the reservation after a failed upload', async () => {
      const dropped = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
      const h = harness({ stat: missing(), writeStream: vi.fn().mockRejectedValue(dropped), remove: vi.fn().mockResolvedValue(undefined) });
      const { settled } = watchTransfers(h);
      const a = await localFile('a.txt', 'a');
      await h.service.uploadFiles(SAVES, '/', [a]);
      expect(await settled()).toMatchObject({ phase: 'failed' });
      expect(await h.service.uploadFiles(SAVES, '/', [a])).toMatchObject({ ok: true });
    });

    it('should release the reservation after a cancelled upload, once its partial file is gone', async () => {
      const remove = vi.fn().mockResolvedValue(undefined);
      const h = harness({ stat: missing(), writeStream: hangingWrite(), remove });
      const { settled } = watchTransfers(h);
      const a = await localFile('a.txt', 'a');
      const first = await h.service.uploadFiles(SAVES, '/', [a]);
      if (!first.ok || !first.value) throw new Error('upload did not start');
      await vi.waitFor(() => expect(h.backend.writeStream).toHaveBeenCalled());
      h.service.cancelTransfer('mc', first.value.transferId);
      expect(await settled()).toMatchObject({ phase: 'cancelled' });
      expect(remove).toHaveBeenCalledWith('/saves/a.txt', expect.any(AbortSignal));
      expect(await h.service.uploadFiles(SAVES, '/', [a])).toMatchObject({ ok: true });
    });

    it('should release the reservation after an upload cancelled before its first write', async () => {
      const h = harness({ stat: missing() });
      const { settled } = watchTransfers(h);
      const a = await localFile('a.txt', 'a');
      const first = await h.service.uploadFiles(SAVES, '/', [a]);
      if (!first.ok || !first.value) throw new Error('upload did not start');
      h.service.cancelTransfer('mc', first.value.transferId);
      expect(await settled()).toMatchObject({ phase: 'cancelled' });
      expect(await h.service.uploadFiles(SAVES, '/', [a])).toMatchObject({ ok: true });
    });

    it('should release the reservation when the pre-upload check refuses the upload', async () => {
      const h = harness({ stat: vi.fn().mockResolvedValue(stat({ name: 'a.txt' })) });
      const a = await localFile('a.txt', 'a');
      expect(await h.service.uploadFiles(SAVES, '/', [a])).toMatchObject({ ok: false, code: 'conflict', message: "'a.txt' already exists." });
      h.backend.stat.mockRejectedValue(new VolumeFileError('not-found', 'stat failed (404)', 404));
      expect(await h.service.uploadFiles(SAVES, '/', [a])).toMatchObject({ ok: true });
    });

    it('should release the reservation when the pre-upload check throws', async () => {
      const h = harness({ stat: vi.fn().mockRejectedValue(new VolumeFileError('unreachable', 'down')) });
      const a = await localFile('a.txt', 'a');
      expect(await h.service.uploadFiles(SAVES, '/', [a])).toMatchObject({ ok: false, code: 'unreachable' });
      h.backend.stat.mockRejectedValue(new VolumeFileError('not-found', 'stat failed (404)', 404));
      expect(await h.service.uploadFiles(SAVES, '/', [a])).toMatchObject({ ok: true });
    });

    it('should release the reservation when the transfer cannot start', async () => {
      const h = harness({ stat: missing() });
      h.registry.status.mockResolvedValueOnce(snapshot()).mockResolvedValueOnce(snapshot({ state: 'stopped' }));
      const a = await localFile('a.txt', 'a');
      expect(await h.service.uploadFiles(SAVES, '/', [a])).toMatchObject({ ok: false, code: 'no-session' });
      h.registry.status.mockResolvedValue(snapshot());
      expect(await h.service.uploadFiles(SAVES, '/', [a])).toMatchObject({ ok: true });
    });

    it('should refuse to save a text file that an upload is writing, and the other way round', async () => {
      const h = harness({ stat: missing(), writeStream: hangingWrite(), remove: vi.fn().mockResolvedValue(undefined) });
      const { settled } = watchTransfers(h);
      const first = await h.service.uploadFiles(SAVES, '/', [await localFile('a.txt', 'a')]);
      if (!first.ok || !first.value) throw new Error('upload did not start');
      expect(await h.service.writeText(SAVES, '/a.txt', 'x', 1)).toMatchObject({ ok: false, code: 'conflict' });
      h.service.cancelTransfer('mc', first.value.transferId);
      await settled();

      let finishStat: (info: VolumeStat) => void = () => undefined;
      h.backend.writeStream.mockReset().mockResolvedValue(undefined);
      h.backend.stat.mockClear();
      h.backend.stat.mockImplementationOnce(() => new Promise<VolumeStat>((resolve) => (finishStat = resolve)));
      const saving = h.service.writeText(SAVES, '/b.txt', 'x', 1);
      await vi.waitFor(() => expect(h.backend.stat).toHaveBeenCalledTimes(1));
      expect(await h.service.uploadFiles(SAVES, '/', [await localFile('b.txt', 'b')])).toEqual({
        ok: false,
        code: 'conflict',
        message: "'b.txt' is already being uploaded.",
      });
      finishStat(stat({ name: 'b.txt', modifiedMs: 1 }));
      await saving;
    });

    it('should release the text file after the save finishes or fails', async () => {
      const h = harness({ stat: vi.fn().mockResolvedValue(stat({ name: 'a.txt', modifiedMs: 1 })) });
      expect(await h.service.writeText(SAVES, '/a.txt', 'x', 1)).toMatchObject({ ok: true });
      h.backend.stat.mockResolvedValue(stat({ name: 'a.txt', modifiedMs: 2 }));
      expect(await h.service.writeText(SAVES, '/a.txt', 'x', 1)).toMatchObject({ ok: false, code: 'conflict', message: 'The file changed on the volume since you opened it.' });
      h.backend.stat.mockResolvedValue(stat({ name: 'a.txt', modifiedMs: 1 }));
      expect(await h.service.writeText(SAVES, '/a.txt', 'x', 1)).toMatchObject({ ok: true });
    });
  });

  describe('partial uploads', () => {
    /** A write that never finishes until aborted, so a cancel lands mid-body. */
    const hangingWrite = () =>
      vi.fn((_path: string, _source: Readable, options: { signal?: AbortSignal }) =>
        new Promise<void>((_resolve, reject) => options.signal?.addEventListener('abort', () => reject(new Error('aborted')))),
      );

    it('should remove the partial file when an upload is cancelled', async () => {
      const remove = vi.fn().mockResolvedValue(undefined);
      const h = harness({ stat: missing(), writeStream: hangingWrite(), remove });
      const { settled } = watchTransfers(h);
      const result = await h.service.uploadFiles(SAVES, '/worlds', [await localFile('a.txt', 'a')]);
      if (!result.ok || !result.value) throw new Error('upload did not start');
      await vi.waitFor(() => expect(h.backend.writeStream).toHaveBeenCalled());
      h.service.cancelTransfer('mc', result.value.transferId);
      expect(await settled()).toMatchObject({ phase: 'cancelled' });
      expect(remove).toHaveBeenCalledWith('/saves/worlds/a.txt', expect.any(AbortSignal));
      expect(remove.mock.calls[0]![1].aborted).toBe(false);
    });

    it('should remove the partial file and say so when an upload fails mid-body', async () => {
      const remove = vi.fn().mockResolvedValue(undefined);
      const dropped = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
      const h = harness({ stat: missing(), writeStream: vi.fn().mockRejectedValue(dropped), remove });
      const { settled } = watchTransfers(h);
      await h.service.uploadFiles(SAVES, '/', [await localFile('a.txt', 'a')]);
      const end = await settled();
      expect(remove).toHaveBeenCalledWith('/saves/a.txt', expect.any(AbortSignal));
      expect(end).toMatchObject({ phase: 'failed', error: expect.stringContaining('partial file was removed') });
    });

    it('should tell the operator to delete the file when the partial file cannot be removed', async () => {
      const remove = vi.fn().mockRejectedValue(new VolumeFileError('unreachable', 'remove /saves/a.txt failed', undefined));
      const dropped = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
      const h = harness({ stat: missing(), writeStream: vi.fn().mockRejectedValue(dropped), remove });
      const { settled } = watchTransfers(h);
      await h.service.uploadFiles(SAVES, '/', [await localFile('a.txt', 'a')]);
      const end = await settled();
      expect(end).toMatchObject({ phase: 'failed', error: expect.stringContaining("'a.txt' was partially uploaded; delete it before retrying.") });
      expect(JSON.stringify(end)).not.toContain('/saves');
    });

    it('should report a cancel whose partial file could not be removed', async () => {
      const remove = vi.fn().mockRejectedValue(new VolumeFileError('unreachable', 'remove failed', undefined));
      const h = harness({ stat: missing(), writeStream: hangingWrite(), remove });
      const { settled } = watchTransfers(h);
      const result = await h.service.uploadFiles(SAVES, '/', [await localFile('a.txt', 'a')]);
      if (!result.ok || !result.value) throw new Error('upload did not start');
      await vi.waitFor(() => expect(h.backend.writeStream).toHaveBeenCalled());
      h.service.cancelTransfer('mc', result.value.transferId);
      expect(await settled()).toMatchObject({ phase: 'cancelled', error: "'a.txt' was partially uploaded; delete it before retrying." });
    });

    it('should not remove anything when the target turned out to exist', async () => {
      const remove = vi.fn().mockResolvedValue(undefined);
      const h = harness({
        stat: missing(),
        writeStream: vi.fn().mockRejectedValue(new VolumeFileError('conflict', 'upload failed (409)', 409)),
        remove,
      });
      const { settled } = watchTransfers(h);
      await h.service.uploadFiles(SAVES, '/', [await localFile('a.txt', 'a')]);
      expect(await settled()).toMatchObject({ phase: 'failed', error: "'a.txt' already exists." });
      expect(remove).not.toHaveBeenCalled();
    });

    it('should not claim a partial file when nothing was created', async () => {
      const remove = vi.fn().mockRejectedValue(new VolumeFileError('not-found', 'remove failed (404)', 404));
      const dropped = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
      const h = harness({ stat: missing(), writeStream: vi.fn().mockRejectedValue(dropped), remove });
      const { settled } = watchTransfers(h);
      await h.service.uploadFiles(SAVES, '/', [await localFile('a.txt', 'a')]);
      const end = await settled();
      expect(end.error).not.toContain('partial');
    });
  });

  it('should cancel an upload in flight', async () => {
    const h = harness({
      stat: missing(),
      writeStream: vi.fn((_path: string, _source: Readable, options: { signal?: AbortSignal }) =>
        new Promise<void>((_resolve, reject) => options.signal?.addEventListener('abort', () => reject(new Error('aborted')))),
      ),
    });
    const { settled } = watchTransfers(h);
    const result = await h.service.uploadFiles(SAVES, '/', [await localFile('a.txt', 'a')]);
    if (!result.ok || !result.value) throw new Error('upload did not start');
    h.service.cancelTransfer('mc', result.value.transferId);
    expect(await settled()).toMatchObject({ phase: 'cancelled' });
    expect(await fsStat(join(local, 'a.txt'))).toBeDefined();
  });
});

describe('VolumeFilesService folder uploads', () => {
  it("should start a folder upload into the selected volume's current directory without persisting the selection", async () => {
    const h = harness();
    h.dialogs.pickDirectory.mockResolvedValue('/home/me/world');
    const result = await h.service.uploadFolder({ game: 'mc', volume: 'saves' }, '/worlds');
    expect(result).toEqual({ ok: true, value: { started: true, runId: 'run-1' } });
    expect(h.scans.scan).toHaveBeenCalledWith('/home/me/world');
    expect(h.folderUploads.startUpload).toHaveBeenCalledWith(
      { game: 'mc', scanId: 'scan-1', include: [''], destination: '/data/saves/worlds' },
      { persistSelection: false },
    );
  });

  it('should upload into the volume root', async () => {
    const h = harness();
    h.dialogs.pickDirectory.mockResolvedValue('/p');
    await h.service.uploadFolder({ game: 'mc', volume: 'config' }, '/');
    expect(h.folderUploads.startUpload).toHaveBeenCalledWith(expect.objectContaining({ destination: '/data/config' }), expect.anything());
  });

  it('should do nothing when the folder dialog is cancelled', async () => {
    const h = harness();
    h.dialogs.pickDirectory.mockResolvedValue(null);
    expect(await h.service.uploadFolder(SAVES, '/')).toEqual({ ok: true, value: null });
    expect(h.scans.scan).not.toHaveBeenCalled();
    expect(h.folderUploads.startUpload).not.toHaveBeenCalled();
  });

  it('should return a refused start as a normal result for the page to show', async () => {
    const h = harness();
    h.dialogs.pickDirectory.mockResolvedValue('/p');
    h.folderUploads.startUpload.mockResolvedValue({ started: false, error: 'Nothing is selected to upload.' });
    expect(await h.service.uploadFolder(SAVES, '/')).toEqual({ ok: true, value: { started: false, error: 'Nothing is selected to upload.' } });
  });

  it('should refuse an unknown volume or game before the dialog', async () => {
    const h = harness();
    expect(await h.service.uploadFolder({ game: 'mc', volume: 'nope' }, '/')).toMatchObject({ ok: false, code: 'unknown-volume' });
    expect(await h.service.uploadFolder({ game: 'other', volume: 'saves' }, '/')).toMatchObject({ ok: false, code: 'unknown-volume' });
    expect(h.dialogs.pickDirectory).not.toHaveBeenCalled();
  });

  it('should refuse a destination that a nested volume would own', async () => {
    const h = harness();
    const service = new VolumeFilesService(
      h.registry as Partial<HelperSessionRegistry> as HelperSessionRegistry,
      h.config as Partial<ConfigService> as ConfigService,
      h.ecs as Partial<EcsService> as EcsService,
      h.dialogs as Partial<NativeDialogService> as NativeDialogService,
      h.scans as Partial<FolderScanService> as FolderScanService,
      h.folderUploads as Partial<FolderUploadService> as FolderUploadService,
      deploymentConfigStub({
        declared: [gameServer('mc', { volumes: [{ name: 'data', container_path: '/data' }, { name: 'saves', container_path: '/data/saves' }] })],
      }) as DeploymentConfigService,
    );
    h.dialogs.pickDirectory.mockResolvedValue('/p');
    expect(await service.uploadFolder({ game: 'mc', volume: 'data' }, '/saves')).toMatchObject({ ok: false, code: 'unknown-volume' });
    expect(h.dialogs.pickDirectory).not.toHaveBeenCalled();
    expect(h.folderUploads.startUpload).not.toHaveBeenCalled();
  });

  it('should join a root container path without a double slash', async () => {
    const h = harness();
    const service = new VolumeFilesService(
      h.registry as Partial<HelperSessionRegistry> as HelperSessionRegistry,
      h.config as Partial<ConfigService> as ConfigService,
      h.ecs as Partial<EcsService> as EcsService,
      h.dialogs as Partial<NativeDialogService> as NativeDialogService,
      h.scans as Partial<FolderScanService> as FolderScanService,
      h.folderUploads as Partial<FolderUploadService> as FolderUploadService,
      deploymentConfigStub({ declared: [gameServer('mc', { volumes: [{ name: 'saves', container_path: '/' }] })] }) as DeploymentConfigService,
    );
    h.dialogs.pickDirectory.mockResolvedValue('/p');
    await service.uploadFolder(SAVES, '/x');
    expect(h.folderUploads.startUpload).toHaveBeenCalledWith(expect.objectContaining({ destination: '/x' }), expect.anything());
  });

  it("should upload into the root of a volume mounted at '/'", async () => {
    const h = harness();
    const service = new VolumeFilesService(
      h.registry as Partial<HelperSessionRegistry> as HelperSessionRegistry,
      h.config as Partial<ConfigService> as ConfigService,
      h.ecs as Partial<EcsService> as EcsService,
      h.dialogs as Partial<NativeDialogService> as NativeDialogService,
      h.scans as Partial<FolderScanService> as FolderScanService,
      h.folderUploads as Partial<FolderUploadService> as FolderUploadService,
      deploymentConfigStub({ declared: [gameServer('mc', { volumes: [{ name: 'saves', container_path: '/' }] })] }) as DeploymentConfigService,
    );
    h.dialogs.pickDirectory.mockResolvedValue('/p');
    expect(await service.uploadFolder(SAVES, '/')).toMatchObject({ ok: true });
    expect(h.folderUploads.startUpload).toHaveBeenCalledWith(expect.objectContaining({ destination: '/' }), expect.anything());
  });

  it('should refuse before the dialog while the server is running', async () => {
    const h = harness();
    h.ecs.findRunningTaskOrThrow.mockResolvedValue({ taskArn: 'arn' });
    expect(await h.service.uploadFolder(SAVES, '/')).toMatchObject({ ok: false, code: 'server-running' });
    expect(h.dialogs.pickDirectory).not.toHaveBeenCalled();
  });

  it('should reject a bad directory path before anything else', async () => {
    const h = harness();
    expect(await h.service.uploadFolder(SAVES, '/a/../b')).toMatchObject({ ok: false, code: 'invalid-path' });
    expect(h.dialogs.pickDirectory).not.toHaveBeenCalled();
  });

  it('should report a folder that could not be scanned', async () => {
    const h = harness();
    h.dialogs.pickDirectory.mockResolvedValue('/p');
    h.scans.scan.mockRejectedValue(new Error('Could not scan folder: EACCES /p'));
    const result = await h.service.uploadFolder(SAVES, '/');
    expect(result).toEqual({ ok: false, code: 'failed', message: "Couldn't read that folder." });
  });
});
