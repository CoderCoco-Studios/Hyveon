import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { FolderUploadController } from './folder-upload.controller.js';
import type { FolderScanService } from '../services/FolderScanService.js';
import type { FolderUploadService } from '../services/FolderUploadService.js';
import { expectChannels } from '../testing/message-pattern.test-utils.js';

/** Builds a controller over stubbed services. */
function make() {
  const uploads: Partial<FolderUploadService> = {
    rescanSelection: vi.fn().mockResolvedValue(null),
    getSelection: vi.fn().mockReturnValue(null),
    setSelection: vi.fn(),
    clearSelection: vi.fn(),
    startUpload: vi.fn().mockResolvedValue({ started: true, runId: 'r' }),
    cancel: vi.fn().mockReturnValue({ cancelled: true }),
    confirmOverwrite: vi.fn().mockReturnValue({ resolved: true }),
    getProgress: vi.fn().mockReturnValue(null),
    cleanupStrayHelpers: vi.fn().mockResolvedValue({ stopped: [], skipped: 0, revokedRules: 0, errors: [] }),
    onProgress: vi.fn(),
  };
  const scans: Partial<FolderScanService> = { pickAndScan: vi.fn().mockResolvedValue(null) };
  return { uploads, scans, controller: new FolderUploadController(uploads as FolderUploadService, scans as FolderScanService) };
}

describe('FolderUploadController', () => {
  it('should register every channel', () => {
    expectChannels(FolderUploadController.prototype, [
      ['pickFolder', 'folderUpload.pickFolder'],
      ['rescanSelection', 'folderUpload.rescanSelection'],
      ['getSelection', 'folderUpload.getSelection'],
      ['setSelection', 'folderUpload.setSelection'],
      ['clearSelection', 'folderUpload.clearSelection'],
      ['startUpload', 'folderUpload.startUpload'],
      ['cancelUpload', 'folderUpload.cancelUpload'],
      ['confirmOverwrite', 'folderUpload.confirmOverwrite'],
      ['getProgress', 'folderUpload.getProgress'],
      ['cleanupStrayHelpers', 'folderUpload.cleanupStrayHelpers'],
    ] as const);
  });

  it('should delegate pickFolder to the scan service', async () => {
    const { controller, scans } = make();
    await controller.pickFolder();
    expect(scans.pickAndScan).toHaveBeenCalled();
  });

  it('should pass a valid start request through and default a missing include list to empty', async () => {
    const { controller, uploads } = make();
    await controller.startUpload({ game: 'g', scanId: 's', destination: '/data' } as never);
    expect(uploads.startUpload).toHaveBeenCalledWith({ game: 'g', scanId: 's', destination: '/data', include: [] });
  });

  it('should reject a start request with no scan id or a non-array include', () => {
    const { controller } = make();
    expect(() => controller.startUpload({ game: 'g', destination: '/d', include: [] } as never)).toThrow(BadRequestException);
    expect(() => controller.startUpload({ game: 'g', scanId: 's', destination: '/d', include: 'x' } as never)).toThrow(BadRequestException);
  });

  it('should reject an empty game on the per-game channels', () => {
    const { controller } = make();
    expect(() => controller.cancelUpload('')).toThrow(BadRequestException);
    expect(() => controller.getSelection(undefined as never)).toThrow(BadRequestException);
  });

  it('should pass a valid overwrite decision to the service', () => {
    const { controller, uploads } = make();
    expect(controller.confirmOverwrite({ game: 'g', proceed: false })).toEqual({ resolved: true });
    expect(uploads.confirmOverwrite).toHaveBeenCalledWith('g', false);
  });

  it.each([[undefined], [{ game: '', proceed: true }], [{ game: 'g', proceed: 'yes' }], [{ game: 'g' }]])(
    'should reject a malformed overwrite decision %j',
    (decision) => {
      const { controller, uploads } = make();
      expect(() => controller.confirmOverwrite(decision as never)).toThrow(BadRequestException);
      expect(uploads.confirmOverwrite).not.toHaveBeenCalled();
    },
  );

  it('should persist selections and report saved', () => {
    const { controller, uploads } = make();
    expect(controller.setSelection({ game: 'g', scanId: 's', include: ['a'], destination: '/d' })).toEqual({ saved: true });
    expect(uploads.setSelection).toHaveBeenCalled();
  });

  it('should clear a game selection and reject an empty game', () => {
    const { controller, uploads } = make();
    expect(controller.clearSelection('g')).toEqual({ cleared: true });
    expect(uploads.clearSelection).toHaveBeenCalledWith('g');
    expect(() => controller.clearSelection('')).toThrow(BadRequestException);
  });

  it('should not subscribe to progress outside Electron', async () => {
    const { controller, uploads } = make();
    await controller.onModuleInit();
    expect(uploads.onProgress).not.toHaveBeenCalled();
  });
});
