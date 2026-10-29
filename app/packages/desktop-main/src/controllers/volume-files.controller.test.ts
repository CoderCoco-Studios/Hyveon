import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
const forward = vi.hoisted(() => vi.fn());
vi.mock('../ipc-broadcast.js', () => ({ forwardToWindows: forward }));

import { VOLUME_FILES_SESSION_CHANNEL, VOLUME_FILES_TRANSFER_CHANNEL, type VolumeSessionStatus } from '@hyveon/shared/volumeFiles';
import { logger } from '../logger.js';
import type { VolumeFilesService } from '../services/volumeFiles/VolumeFilesService.js';
import { expectChannels } from '../testing/message-pattern.test-utils.js';
import { expectNoSecretFields } from '../testing/no-secret-fields.js';
import { VolumeFilesController } from './volume-files.controller.js';

const STATUS: VolumeSessionStatus = { game: 'mc', state: 'running', browseHeld: true, uploadHolders: 0, supportsArchive: true, volumes: [] };
const INVALID = { ok: false, code: 'invalid-path', message: 'Invalid request.' };
const INVALID_STATUS = {
  game: 'mc',
  state: 'failed',
  error: 'Invalid request.',
  browseHeld: false,
  uploadHolders: 0,
  supportsArchive: false,
  volumes: [],
};

/** A service stub whose every channel method resolves to a recognisable value. */
function make() {
  const service = {
    sessionStatus: vi.fn().mockResolvedValue(STATUS),
    sessionStart: vi.fn().mockResolvedValue(STATUS),
    sessionAttach: vi.fn().mockResolvedValue(STATUS),
    sessionDetach: vi.fn().mockResolvedValue(STATUS),
    sessionStop: vi.fn().mockResolvedValue({ ok: true, value: STATUS }),
    sessionRestart: vi.fn().mockResolvedValue({ ok: true, value: STATUS }),
    list: vi.fn().mockResolvedValue({ ok: true, value: { path: '/', entries: [] } }),
    mkdir: vi.fn().mockResolvedValue({ ok: true, value: { name: 'n', isDir: true, size: 0, modifiedMs: 1 } }),
    rename: vi.fn().mockResolvedValue({ ok: true, value: { name: 'n', isDir: false, size: 0, modifiedMs: 1 } }),
    remove: vi.fn().mockResolvedValue({ ok: true, value: true }),
    readText: vi.fn().mockResolvedValue({ ok: true, value: { path: '/a', content: 'x', modifiedMs: 1 } }),
    writeText: vi.fn().mockResolvedValue({ ok: true, value: { modifiedMs: 2 } }),
    download: vi.fn().mockResolvedValue({ ok: true, value: { transferId: 't' } }),
    cancelTransfer: vi.fn().mockReturnValue({ cancelled: true }),
    uploadFiles: vi.fn().mockResolvedValue({ ok: true, value: { transferId: 't' } }),
    uploadFolder: vi.fn().mockResolvedValue({ ok: true, value: null }),
    onSession: vi.fn(),
    onTransfer: vi.fn(),
  };
  return { service, controller: new VolumeFilesController(service as Partial<VolumeFilesService> as VolumeFilesService) };
}

beforeEach(() => {
  vi.mocked(logger.debug).mockClear();
  forward.mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe('VolumeFilesController', () => {
  it('should register every volumeFiles channel', () => {
    expectChannels(VolumeFilesController.prototype, [
      ['sessionStatus', 'volumeFiles.session.status'],
      ['sessionStart', 'volumeFiles.session.start'],
      ['sessionAttach', 'volumeFiles.session.attach'],
      ['sessionDetach', 'volumeFiles.session.detach'],
      ['sessionStop', 'volumeFiles.session.stop'],
      ['sessionRestart', 'volumeFiles.session.restart'],
      ['list', 'volumeFiles.list'],
      ['mkdir', 'volumeFiles.mkdir'],
      ['rename', 'volumeFiles.rename'],
      ['remove', 'volumeFiles.delete'],
      ['readText', 'volumeFiles.readText'],
      ['writeText', 'volumeFiles.writeText'],
      ['download', 'volumeFiles.download'],
      ['cancelTransfer', 'volumeFiles.cancelTransfer'],
      ['uploadFiles', 'volumeFiles.uploadFiles'],
      ['uploadFolder', 'volumeFiles.uploadFolder'],
    ] as const);
  });

  describe('delegation', () => {
    it.each([
      ['sessionStatus', 'sessionStatus'],
      ['sessionStart', 'sessionStart'],
      ['sessionAttach', 'sessionAttach'],
      ['sessionDetach', 'sessionDetach'],
      ['sessionStop', 'sessionStop'],
      ['sessionRestart', 'sessionRestart'],
    ] as const)('should pass the game to %s', async (method, serviceMethod) => {
      const { controller, service } = make();
      await controller[method]('mc');
      expect(service[serviceMethod]).toHaveBeenCalledWith('mc');
    });

    it('should delegate each file channel with its volume reference', async () => {
      const { controller, service } = make();
      const ref = { game: 'mc', volume: 'saves' };
      await controller.list({ ...ref, path: '/a' });
      await controller.mkdir({ ...ref, parent: '/a', name: 'n' });
      await controller.rename({ ...ref, path: '/a', newName: 'b' });
      await controller.remove({ ...ref, path: '/a' });
      await controller.readText({ ...ref, path: '/a' });
      await controller.writeText({ ...ref, path: '/a', content: 'hi', expectedModifiedMs: 7 });
      await controller.download({ ...ref, path: '/a', isDir: true });
      await controller.uploadFiles({ ...ref, dir: '/a', localPaths: ['/tmp/x'] });
      await controller.uploadFolder({ ...ref, dir: '/a' });
      expect(service.list).toHaveBeenCalledWith(ref, '/a');
      expect(service.mkdir).toHaveBeenCalledWith(ref, '/a', 'n');
      expect(service.rename).toHaveBeenCalledWith(ref, '/a', 'b');
      expect(service.remove).toHaveBeenCalledWith(ref, '/a');
      expect(service.readText).toHaveBeenCalledWith(ref, '/a');
      expect(service.writeText).toHaveBeenCalledWith(ref, '/a', 'hi', 7);
      expect(service.download).toHaveBeenCalledWith(ref, '/a', true);
      expect(service.uploadFiles).toHaveBeenCalledWith(ref, '/a', ['/tmp/x']);
      expect(service.uploadFolder).toHaveBeenCalledWith(ref, '/a');
    });

    it('should pass undefined local paths when the renderer sends none', async () => {
      const { controller, service } = make();
      await controller.uploadFiles({ game: 'mc', volume: 'saves', dir: '/' });
      expect(service.uploadFiles).toHaveBeenCalledWith({ game: 'mc', volume: 'saves' }, '/', undefined);
    });

    it('should accept the legacy unnamed volume on list', async () => {
      const { controller, service } = make();
      await controller.list({ game: 'mc', volume: '', path: '/' });
      expect(service.list).toHaveBeenCalledWith({ game: 'mc', volume: '' }, '/');
    });

    it('should delegate cancelTransfer', () => {
      const { controller, service } = make();
      expect(controller.cancelTransfer({ game: 'mc', transferId: 't' })).toEqual({ cancelled: true });
      expect(service.cancelTransfer).toHaveBeenCalledWith('mc', 't');
    });
  });

  describe('malformed payloads', () => {
    const ref = { game: 'mc', volume: 'saves' };

    it.each([
      ['no volume', { game: 'mc', path: '/' }],
      ['no game', { volume: 'saves', path: '/' }],
      ['empty path', { ...ref, path: '' }],
      ['numeric path', { ...ref, path: 5 }],
      ['null payload', null],
      ['string payload', 'mc'],
      ['undefined payload', undefined],
    ])('should reject a list request with %s', async (_label, payload) => {
      const { controller, service } = make();
      await expect(controller.list(payload)).resolves.toEqual(INVALID);
      expect(service.list).not.toHaveBeenCalled();
    });

    it.each([
      ['mkdir without a name', (c: VolumeFilesController) => c.mkdir({ ...ref, parent: '/' })],
      ['rename without newName', (c: VolumeFilesController) => c.rename({ ...ref, path: '/a' })],
      ['delete without a path', (c: VolumeFilesController) => c.remove({ ...ref })],
      ['readText with a numeric volume', (c: VolumeFilesController) => c.readText({ game: 'mc', volume: 1, path: '/a' })],
      ['writeText with non-string content', (c: VolumeFilesController) => c.writeText({ ...ref, path: '/a', content: 1, expectedModifiedMs: 1 })],
      ['writeText with a NaN modified time', (c: VolumeFilesController) => c.writeText({ ...ref, path: '/a', content: 'x', expectedModifiedMs: NaN })],
      ['writeText with a string modified time', (c: VolumeFilesController) => c.writeText({ ...ref, path: '/a', content: 'x', expectedModifiedMs: '1' })],
      ['download with a non-boolean isDir', (c: VolumeFilesController) => c.download({ ...ref, path: '/a', isDir: 'yes' })],
      ['uploadFiles without a dir', (c: VolumeFilesController) => c.uploadFiles({ ...ref })],
      ['uploadFiles with non-array local paths', (c: VolumeFilesController) => c.uploadFiles({ ...ref, dir: '/', localPaths: '/tmp/a' })],
      ['uploadFiles with a non-string local path', (c: VolumeFilesController) => c.uploadFiles({ ...ref, dir: '/', localPaths: ['/tmp/a', 3] })],
      ['uploadFolder without a dir', (c: VolumeFilesController) => c.uploadFolder({ ...ref })],
      ['stop with an empty game', (c: VolumeFilesController) => c.sessionStop('')],
      ['restart with a non-string game', (c: VolumeFilesController) => c.sessionRestart(7)],
    ])('should reject %s', async (_label, call) => {
      const { controller, service } = make();
      await expect(call(controller)).resolves.toEqual(INVALID);
      for (const fn of Object.values(service)) expect(fn).not.toHaveBeenCalled();
    });

    it.each([
      ['status', (c: VolumeFilesController) => c.sessionStatus('')],
      ['start', (c: VolumeFilesController) => c.sessionStart(undefined)],
      ['attach', (c: VolumeFilesController) => c.sessionAttach(3)],
      ['detach', (c: VolumeFilesController) => c.sessionDetach({ game: 'mc' })],
    ])('should answer a session %s request with a bad game as a failed status', async (_label, call) => {
      const { controller, service } = make();
      const status = await call(controller);
      expect(status).toMatchObject({ state: 'failed', error: 'Invalid request.', volumes: [], browseHeld: false });
      expect(Object.values(service).every((fn) => !fn.mock.calls.length)).toBe(true);
    });

    it('should echo a string game in the failed status and use an empty game otherwise', async () => {
      const { controller } = make();
      expect(await controller.sessionStatus('')).toEqual({ ...INVALID_STATUS, game: '' });
    });

    it.each([
      ['no transfer id', { game: 'mc' }],
      ['an empty game', { game: '', transferId: 't' }],
      ['null', null],
    ])('should answer cancelTransfer with %s as not cancelled', (_label, payload) => {
      const { controller, service } = make();
      expect(controller.cancelTransfer(payload)).toEqual({ cancelled: false });
      expect(service.cancelTransfer).not.toHaveBeenCalled();
    });
  });

  describe('logging', () => {
    it('should log each invocation with the game and without file content', async () => {
      const { controller } = make();
      await controller.writeText({ game: 'mc', volume: 'saves', path: '/a.txt', content: 'SECRET-CONTENT', expectedModifiedMs: 1 });
      expect(logger.debug).toHaveBeenCalledWith('VolumeFilesController: volumeFiles.writeText invoked', {
        game: 'mc',
        volume: 'saves',
        path: '/a.txt',
      });
      expect(JSON.stringify(vi.mocked(logger.debug).mock.calls)).not.toContain('SECRET-CONTENT');
    });

    it('should not log local paths', async () => {
      const { controller } = make();
      await controller.uploadFiles({ game: 'mc', volume: 'saves', dir: '/mods', localPaths: ['/home/me/secret.txt'] });
      expect(vi.mocked(logger.debug)).toHaveBeenCalledWith('VolumeFilesController: volumeFiles.uploadFiles invoked', {
        game: 'mc',
        volume: 'saves',
        dir: '/mods',
      });
      expect(JSON.stringify(vi.mocked(logger.debug).mock.calls)).not.toContain('secret.txt');
    });

    it('should log session and transfer identifiers', async () => {
      const { controller } = make();
      await controller.sessionStart('mc');
      controller.cancelTransfer({ game: 'mc', transferId: 't1' });
      expect(logger.debug).toHaveBeenCalledWith('VolumeFilesController: volumeFiles.session.start invoked', { game: 'mc' });
      expect(logger.debug).toHaveBeenCalledWith('VolumeFilesController: volumeFiles.cancelTransfer invoked', { game: 'mc', transferId: 't1' });
    });

    it('should log before validating and tolerate a malformed payload', async () => {
      const { controller } = make();
      await controller.list({ game: 'mc', volume: 5, path: { toString: () => { throw new Error('boom'); } } });
      await controller.list(null);
      expect(logger.debug).toHaveBeenNthCalledWith(1, 'VolumeFilesController: volumeFiles.list invoked', { game: 'mc' });
      expect(logger.debug).toHaveBeenNthCalledWith(2, 'VolumeFilesController: volumeFiles.list invoked', {});
    });
  });

  describe('push forwarding', () => {
    it('should not subscribe outside Electron', async () => {
      forward.mockResolvedValue(null);
      const { controller, service } = make();
      await controller.onModuleInit();
      expect(service.onSession).not.toHaveBeenCalled();
      expect(service.onTransfer).not.toHaveBeenCalled();
    });

    it('should forward session and transfer events on their channels', async () => {
      const stop = vi.fn();
      forward.mockImplementation(async (subscribe: (cb: () => void) => void) => {
        subscribe(() => undefined);
        return stop;
      });
      const { controller, service } = make();
      await controller.onModuleInit();
      expect(forward.mock.calls.map((c) => c[1])).toEqual([VOLUME_FILES_SESSION_CHANNEL, VOLUME_FILES_TRANSFER_CHANNEL]);
      expect(service.onSession).toHaveBeenCalledOnce();
      expect(service.onTransfer).toHaveBeenCalledOnce();
      controller.onModuleDestroy();
      expect(stop).toHaveBeenCalledTimes(2);
    });

    it('should tolerate destroy before init', () => {
      const { controller } = make();
      expect(() => controller.onModuleDestroy()).not.toThrow();
    });
  });

  it('should return results free of secret fields', async () => {
    const { controller } = make();
    const ref = { game: 'mc', volume: 'saves' };
    const results = [
      await controller.sessionStatus('mc'),
      await controller.sessionStop('mc'),
      await controller.list({ ...ref, path: '/' }),
      await controller.mkdir({ ...ref, parent: '/', name: 'n' }),
      await controller.rename({ ...ref, path: '/a', newName: 'b' }),
      await controller.remove({ ...ref, path: '/a' }),
      await controller.readText({ ...ref, path: '/a' }),
      await controller.writeText({ ...ref, path: '/a', content: 'x', expectedModifiedMs: 1 }),
      await controller.download({ ...ref, path: '/a', isDir: false }),
      await controller.uploadFiles({ ...ref, dir: '/' }),
      await controller.uploadFolder({ ...ref, dir: '/' }),
      controller.cancelTransfer({ game: 'mc', transferId: 't' }),
      await controller.list(null),
    ];
    for (const result of results) expectNoSecretFields(result);
  });
});
