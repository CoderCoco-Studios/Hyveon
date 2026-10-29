import 'reflect-metadata';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { MAX_TEXT_EDIT_BYTES, type VolumeRef } from '@hyveon/shared/volumeFiles';
import type { ConfigService } from '../ConfigService.js';
import type { EcsService } from '../EcsService.js';
import { fakeBackend, type FakeBackend } from '../../testing/fake-volume-backend.js';
import { expectNoSecretFields } from '../../testing/no-secret-fields.js';
import { stackOutputs } from '../../testing/stack-outputs.fixture.js';
import { buildHelperVolumeLayout, type HelperVolumeLayout } from './helperVolumeLayout.js';
import { HelperSessionRegistry, NoSessionError, type HelperSessionSnapshot } from './HelperSessionRegistry.js';
import { VolumeFileError, type VolumeStat } from './VolumeFileBackend.js';
import { METADATA_OP_TIMEOUT_MS, VolumeFilesService } from './VolumeFilesService.js';

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
  registry: { [K in 'withBackend' | 'status' | 'acquire' | 'attach' | 'release' | 'stop']: ReturnType<typeof vi.fn> };
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
  };
  const config = { getStackOutputs: vi.fn().mockResolvedValue(stackOutputs()) };
  const ecs = { findRunningTaskOrThrow: vi.fn().mockResolvedValue(null) };
  const service = new VolumeFilesService(registry as Partial<HelperSessionRegistry> as HelperSessionRegistry, config as Partial<ConfigService> as ConfigService, ecs as Partial<EcsService> as EcsService);
  return { service, backend, registry, config, ecs };
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
  const textBackend = (size: number, content: Buffer | Readable, over: Partial<VolumeStat> = {}) =>
    harness({ stat: vi.fn().mockResolvedValue(stat({ size, ...over })), readStream: vi.fn().mockResolvedValue(content instanceof Readable ? content : Readable.from([content])) });

  it('should read a UTF-8 file and return the volume path, not the helper path', async () => {
    const h = textBackend(5, Buffer.from('héllo'), { modifiedMs: 42 });
    expect(await h.service.readText(SAVES, '/level.dat')).toEqual({ ok: true, value: { path: '/level.dat', content: 'héllo', modifiedMs: 42 } });
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
