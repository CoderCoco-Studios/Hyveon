import { Controller } from '@nestjs/common';
import { MessagePattern } from '@nestjs/microservices';
import { WindowService } from '../services/WindowService.js';
import { logger } from '../logger.js';

// @spec APP-SHELL-WINIPC-010
/**
 * IPC-only controller for the main window's chrome controls. Every handler is
 * bound to an IPC channel via `@MessagePattern` — no HTTP routes are
 * registered here.
 */
@Controller()
export class WindowController {
  constructor(private readonly window: WindowService) {}

  // @spec APP-SHELL-WINIPC-001
  /** Minimizes the main window. */
  @MessagePattern('window.minimize')
  minimize(): void {
    logger.debug('WindowController: window.minimize invoked');
    this.window.minimize();
  }

  // @spec APP-SHELL-WINIPC-002, APP-SHELL-WINIPC-003
  /** Toggles the main window between maximized and restored. */
  @MessagePattern('window.toggleMaximize')
  toggleMaximize(): void {
    logger.debug('WindowController: window.toggleMaximize invoked');
    this.window.toggleMaximize();
  }

  // @spec APP-SHELL-WINIPC-004
  /** Closes the main window. */
  @MessagePattern('window.close')
  close(): void {
    logger.debug('WindowController: window.close invoked');
    this.window.close();
  }

  // @spec APP-SHELL-WINIPC-005
  /** Queries the main window's current maximized state. */
  @MessagePattern('window.isMaximized')
  isMaximized(): boolean {
    logger.debug('WindowController: window.isMaximized invoked');
    return this.window.isMaximized();
  }
}
