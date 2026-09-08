import { Controller } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { createRequire } from 'node:module';
import type { ExportDiagnosticsBundleResult, RendererLogEntry } from '@hyveon/shared';
import { DiagnosticsService } from '../services/DiagnosticsService.js';
import { DiagnosticsBundleService } from '../services/DiagnosticsBundleService.js';
import { logger } from '../logger.js';
import { errMessage } from '@hyveon/shared';

/** Payload accepted by `diagnostics.reportError`. */
export interface ReportRendererErrorInput {
  message: string;
  stack?: string;
  source: 'boundary' | 'window-error' | 'unhandled-rejection';
}

/** Payload accepted by `diagnostics.reportLog`. */
export interface ReportRendererLogBatchInput {
  entries: RendererLogEntry[];
  /** Entries the renderer's own client-side batch cap already dropped before sending, if any. */
  droppedCount?: number;
}

/** Payload accepted by `diagnostics.showInFolder`. */
export interface ShowInFolderInput {
  path: string;
}

/**
 * IPC-only controller for local application log data.
 *
 * Registers the `diagnostics.tail`, `diagnostics.path`, `diagnostics.reportError`,
 * `diagnostics.reportLog`, `diagnostics.exportBundle`, and
 * `diagnostics.showInFolder` Electron IPC channels so the renderer can reach
 * them through `window.hyveon.diagnostics.*`. No HTTP routes are declared here.
 */
@Controller()
export class DiagnosticsController {
  constructor(
    private readonly diagnostics: DiagnosticsService,
    private readonly bundle: DiagnosticsBundleService,
  ) {}

  /** Returns the last 500 lines from today's local log file. */
  @MessagePattern('diagnostics.tail')
  async getTail(): Promise<{ lines: string[] }> {
    logger.debug('DiagnosticsController: diagnostics.tail invoked');
    const lines = await this.diagnostics.readTail(500);
    return { lines };
  }

  /** Returns the absolute path of today's local log file. */
  @MessagePattern('diagnostics.path')
  getPath(): { path: string } {
    logger.debug('DiagnosticsController: diagnostics.path invoked');
    return { path: this.diagnostics.getTodayLogPath() };
  }

  /** Forwards a renderer-side crash into the local winston log file. Never rejects. */
  @MessagePattern('diagnostics.reportError')
  reportError(@Payload() body: ReportRendererErrorInput): void {
    logger.debug('DiagnosticsController: diagnostics.reportError invoked');
    this.diagnostics.logRendererError(body.message, body.stack, body.source);
  }

  /** Forwards a batch of renderer-side `console.*` calls into the local winston log file. Never rejects. */
  @MessagePattern('diagnostics.reportLog')
  reportLog(@Payload() body: ReportRendererLogBatchInput): void {
    logger.debug('DiagnosticsController: diagnostics.reportLog invoked');
    this.diagnostics.logRendererConsoleBatch(body.entries, body.droppedCount);
  }

  /**
   * Prompts the operator for a save location via a native save dialog, then
   * writes the diagnostics bundle there via {@link DiagnosticsBundleService.writeBundle}.
   * Cancelling the dialog is a silent no-op (`{ status: 'cancelled' }`, not
   * an error) — matches the spec's "no file is written and no error is
   * surfaced" requirement.
   */
  @MessagePattern('diagnostics.exportBundle')
  async exportBundle(): Promise<ExportDiagnosticsBundleResult> {
    logger.debug('DiagnosticsController: diagnostics.exportBundle invoked');
    const destinationPath = await this.showSaveDialog();
    if (!destinationPath) {
      return { status: 'cancelled' };
    }
    try {
      const result = await this.bundle.writeBundle(destinationPath);
      return { status: 'written', path: result.path };
    } catch (err) {
      const message = errMessage(err);
      logger.error('DiagnosticsController: diagnostics.exportBundle failed to write bundle', { message });
      return { status: 'error', message };
    }
  }

  /**
   * Opens Electron's native save dialog, lazily requiring `electron` at
   * call-time (mirrors `CloudHealthService.openExternalUrl`'s pattern).
   * Returns `undefined` when the operator cancels. Extracted as a protected
   * method so tests can stub it without a real Electron process.
   */
  protected async showSaveDialog(): Promise<string | undefined> {
    const _require = createRequire(import.meta.url);
    const { dialog } = _require('electron') as {
      dialog: { showSaveDialog(options: unknown): Promise<{ canceled: boolean; filePath?: string }> };
    };
    const result = await dialog.showSaveDialog({
      title: 'Export diagnostics bundle',
      defaultPath: `hyveon-diagnostics-${new Date().toISOString().replace(/[:.]/g, '-')}.zip`,
      filters: [{ name: 'Zip archive', extensions: ['zip'] }],
    });
    return result.canceled ? undefined : result.filePath;
  }

  /**
   * Reveals the written bundle in the OS's file manager via Electron's
   * `shell.showItemInFolder`, backing the export success toast's "Show in
   * folder" action. Never rejects — a failure to reveal the file is not
   * worth surfacing as an error over a file that was already written
   * successfully.
   */
  @MessagePattern('diagnostics.showInFolder')
  showInFolder(@Payload() body: ShowInFolderInput): void {
    logger.debug('DiagnosticsController: diagnostics.showInFolder invoked');
    try {
      this.revealInFolder(body.path);
    } catch (err) {
      const message = errMessage(err);
      logger.warn('DiagnosticsController: diagnostics.showInFolder failed', { message });
    }
  }

  /**
   * Calls `shell.showItemInFolder(path)`, lazily requiring `electron` at
   * call-time. Extracted as a protected method so tests can stub it without
   * a real Electron process.
   */
  protected revealInFolder(path: string): void {
    const _require = createRequire(import.meta.url);
    const { shell } = _require('electron') as { shell: { showItemInFolder(path: string): void } };
    shell.showItemInFolder(path);
  }
}
