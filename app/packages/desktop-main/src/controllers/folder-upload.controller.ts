import { BadRequestException, Controller, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import type { BrowserWindow } from 'electron';
import type {
  FolderOverwriteDecision,
  FolderOverwriteDecisionResult,
  FolderScanResult,
  FolderUploadProgress,
  FolderUploadRequest,
  FolderUploadStartResult,
  FolderUploadStoredState,
  StrayHelperReport,
} from '@hyveon/shared/folderUpload';
import { FolderScanService } from '../services/FolderScanService.js';
import { FolderUploadService } from '../services/FolderUploadService.js';
import { logger } from '../logger.js';
import { isNonEmptyString, requireStringArray } from './validation.js';

/** Push channel carrying {@link FolderUploadProgress} snapshots to every renderer window. */
export const FOLDER_UPLOAD_PROGRESS_CHANNEL = 'folderUpload.progress';

/**
 * IPC-only controller for seeding a game's volume from a local folder. File contents and the helper credential never
 * cross this boundary: the renderer sees scan metadata, relative include paths, and progress snapshots only.
 */
@Controller()
export class FolderUploadController implements OnModuleInit, OnModuleDestroy {
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly uploads: FolderUploadService,
    private readonly scans: FolderScanService,
  ) {}

  /**
   * Forwards progress snapshots to every open window over {@link FOLDER_UPLOAD_PROGRESS_CHANNEL}. A push, not a
   * `@MessagePattern`, so it goes straight over `webContents.send`. Gated on `process.versions.electron`: outside
   * Electron (integration server, CI) importing `electron` would throw, so no forwarding is set up.
   */
  async onModuleInit(): Promise<void> {
    if (!process.versions.electron) return;
    const { BrowserWindow: Windows } = (await import('electron')) as unknown as {
      BrowserWindow: { getAllWindows(): BrowserWindow[] };
    };
    this.unsubscribe = this.uploads.onProgress((progress) => {
      for (const win of Windows.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send(FOLDER_UPLOAD_PROGRESS_CHANNEL, progress);
      }
    });
  }

  /** Stops forwarding progress. */
  onModuleDestroy(): void {
    this.unsubscribe?.();
  }

  /** Opens the native folder dialog and scans the choice; `null` when cancelled (or outside Electron). */
  @MessagePattern('folderUpload.pickFolder')
  pickFolder(): Promise<FolderScanResult | null> {
    logger.debug('FolderUploadController: folderUpload.pickFolder invoked');
    return this.scans.pickAndScan();
  }

  /** Re-scans the folder remembered for `game` so a restored selection has a live scan id; `null` if none stored. */
  @MessagePattern('folderUpload.rescanSelection')
  rescanSelection(@Payload() game: string): Promise<FolderScanResult | null> {
    logger.debug('FolderUploadController: folderUpload.rescanSelection invoked', { game });
    return this.uploads.rescanSelection(this.requireGame(game, 'folderUpload.rescanSelection'));
  }

  /** Returns the persisted selection and last-run status for `game`, or `null`. */
  @MessagePattern('folderUpload.getSelection')
  getSelection(@Payload() game: string): FolderUploadStoredState | null {
    logger.debug('FolderUploadController: folderUpload.getSelection invoked', { game });
    return this.uploads.getSelection(this.requireGame(game, 'folderUpload.getSelection'));
  }

  /** Persists the operator's selection for a game (the scan is referenced by id). */
  @MessagePattern('folderUpload.setSelection')
  setSelection(@Payload() request: FolderUploadRequest): { saved: true } {
    logger.debug('FolderUploadController: folderUpload.setSelection invoked', { game: request?.game });
    this.uploads.setSelection(this.requireRequest(request, 'folderUpload.setSelection'));
    return { saved: true };
  }

  /** Validates guards and starts the upload in the background; progress arrives on the push channel. */
  @MessagePattern('folderUpload.startUpload')
  startUpload(@Payload() request: FolderUploadRequest): Promise<FolderUploadStartResult> {
    logger.debug('FolderUploadController: folderUpload.startUpload invoked', { game: request?.game });
    return this.uploads.startUpload(this.requireRequest(request, 'folderUpload.startUpload'));
  }

  /** Cancels the upload running for `game`, if any. */
  @MessagePattern('folderUpload.cancelUpload')
  cancelUpload(@Payload() game: string): { cancelled: boolean } {
    logger.debug('FolderUploadController: folderUpload.cancelUpload invoked', { game });
    return this.uploads.cancel(this.requireGame(game, 'folderUpload.cancelUpload'));
  }

  /** Answers the overwrite warning: `proceed` continues the awaiting run, otherwise it is cancelled. */
  @MessagePattern('folderUpload.confirmOverwrite')
  confirmOverwrite(@Payload() decision: FolderOverwriteDecision): FolderOverwriteDecisionResult {
    logger.debug('FolderUploadController: folderUpload.confirmOverwrite invoked', {
      game: decision?.game,
      proceed: decision?.proceed,
    });
    if (!decision || !isNonEmptyString(decision.game) || typeof decision.proceed !== 'boolean') {
      throw new BadRequestException({ success: false, error: 'folderUpload.confirmOverwrite requires game and proceed' });
    }
    return this.uploads.confirmOverwrite(decision.game, decision.proceed);
  }

  /** Latest progress snapshot for `game`'s run in this session, so a reopened page can resume the meter. */
  @MessagePattern('folderUpload.getProgress')
  getProgress(@Payload() game: string): FolderUploadProgress | null {
    logger.debug('FolderUploadController: folderUpload.getProgress invoked', { game });
    return this.uploads.getProgress(this.requireGame(game, 'folderUpload.getProgress'));
  }

  /** Stops every file-manager helper no active run owns and reports what was stopped. */
  @MessagePattern('folderUpload.cleanupStrayHelpers')
  cleanupStrayHelpers(): Promise<StrayHelperReport> {
    logger.debug('FolderUploadController: folderUpload.cleanupStrayHelpers invoked');
    return this.uploads.cleanupStrayHelpers();
  }

  private requireGame(game: unknown, channel: string): string {
    if (!isNonEmptyString(game)) {
      throw new BadRequestException({ success: false, error: `${channel} requires a non-empty game string` });
    }
    return game;
  }

  private requireRequest(request: FolderUploadRequest | undefined, channel: string): FolderUploadRequest {
    if (!request || !isNonEmptyString(request.game) || !isNonEmptyString(request.scanId) || !isNonEmptyString(request.destination)) {
      throw new BadRequestException({ success: false, error: `${channel} requires game, scanId and destination` });
    }
    return { ...request, include: requireStringArray('include', request.include) };
  }
}
