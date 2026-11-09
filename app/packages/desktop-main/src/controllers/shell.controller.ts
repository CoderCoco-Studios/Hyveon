import { Controller } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { ShellRevealService } from '../services/ShellRevealService.js';
import { logger } from '../logger.js';

/** Payload accepted by `shell.revealInFolder`. */
export interface RevealInFolderInput {
  /** Which app-owned file to reveal; validated in the main process, never a path. */
  target: unknown;
}

// @spec APP-SHELL-REVEAL-001, APP-SHELL-REVEAL-004
/** IPC-only controller exposing `shell.revealInFolder`, the shared reveal-in-file-manager channel. */
@Controller()
export class ShellController {
  constructor(private readonly reveal: ShellRevealService) {}

  /** Reveals a recorded app-owned file by target name; never rejects. */
  @MessagePattern('shell.revealInFolder')
  revealInFolder(@Payload() body: RevealInFolderInput): void {
    const target = body?.target;
    logger.debug('ShellController: shell.revealInFolder invoked', {
      target: typeof target === 'string' ? target.slice(0, 64) : typeof target,
    });
    this.reveal.reveal(target);
  }
}
