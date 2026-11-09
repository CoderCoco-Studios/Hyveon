import { Controller } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import type { ExportDiagnosticsBundleResult, RendererLogEntry } from '@hyveon/shared';
import { DiagnosticsService } from '../services/DiagnosticsService.js';
import { DiagnosticsBundleService } from '../services/DiagnosticsBundleService.js';
import { NativeDialogService } from '../services/NativeDialogService.js';
import { ShellRevealService } from '../services/ShellRevealService.js';
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

// @spec APP-DIAG-SVC-005
/**
 * IPC-only controller for local application log data.
 *
 * Registers the `diagnostics.tail`, `diagnostics.path`, `diagnostics.reportError`,
 * `diagnostics.reportLog`, and `diagnostics.exportBundle` Electron IPC channels so the renderer can reach
 * them through `window.hyveon.diagnostics.*`. No HTTP routes are declared here.
 */
@Controller()
export class DiagnosticsController {
  constructor(
    private readonly diagnostics: DiagnosticsService,
    private readonly bundle: DiagnosticsBundleService,
    private readonly dialogs: NativeDialogService,
    private readonly shellReveal: ShellRevealService,
  ) {}

  // @spec APP-DIAG-TAIL-006
  /** Returns the last 500 lines from today's local log file. */
  @MessagePattern('diagnostics.tail')
  async getTail(): Promise<{ lines: string[] }> {
    logger.debug('DiagnosticsController: diagnostics.tail invoked');
    const lines = await this.diagnostics.readTail(500);
    return { lines };
  }

  // @spec APP-DIAG-TAIL-006
  /** Returns the absolute path of today's local log file. */
  @MessagePattern('diagnostics.path')
  getPath(): { path: string } {
    logger.debug('DiagnosticsController: diagnostics.path invoked');
    return { path: this.diagnostics.getTodayLogPath() };
  }

  // @spec APP-DIAG-RERR-001
  /** Forwards a renderer-side crash into the local winston log file. Never rejects. */
  @MessagePattern('diagnostics.reportError')
  reportError(@Payload() body: ReportRendererErrorInput): void {
    logger.debug('DiagnosticsController: diagnostics.reportError invoked');
    this.diagnostics.logRendererError(body.message, body.stack, body.source);
  }

  // @spec APP-DIAG-CONS-003, APP-DIAG-CONS-004, APP-DIAG-CONS-008, APP-DIAG-CONS-009
  /** Forwards a batch of renderer-side `console.*` calls into the local winston log file. Never rejects. */
  @MessagePattern('diagnostics.reportLog')
  reportLog(@Payload() body: ReportRendererLogBatchInput): void {
    logger.debug('DiagnosticsController: diagnostics.reportLog invoked');
    this.diagnostics.logRendererConsoleBatch(body.entries, body.droppedCount);
  }

  // @spec APP-DIAG-BNDL-001, APP-DIAG-BNDL-002, APP-DIAG-BNDL-015
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
    const destinationPath = await this.dialogs.pickSavePath(
      `hyveon-diagnostics-${new Date().toISOString().replace(/[:.]/g, '-')}.zip`,
      { title: 'Export diagnostics bundle', filters: [{ name: 'Zip archive', extensions: ['zip'] }] },
    );
    if (!destinationPath) {
      return { status: 'cancelled' };
    }
    try {
      const result = await this.bundle.writeBundle(destinationPath);
      this.shellReveal.record('diagnostics-bundle', result.path);
      return { status: 'written', path: result.path };
    } catch (err) {
      const message = errMessage(err);
      logger.error('DiagnosticsController: diagnostics.exportBundle failed to write bundle', { message });
      return { status: 'error', message };
    }
  }
}
