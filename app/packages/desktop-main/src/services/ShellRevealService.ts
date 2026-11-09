import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Injectable } from '@nestjs/common';
import { errMessage, isRevealTarget, type RevealTarget } from '@hyveon/shared';
import { logger } from '../logger.js';

// @spec APP-SHELL-REVEAL-001, APP-SHELL-REVEAL-002, APP-SHELL-REVEAL-003
/**
 * The one place that reveals a file in the OS file manager (`shell.showItemInFolder`).
 *
 * @remarks
 * The renderer names a {@link RevealTarget}, never a path. The main-process owner of each file
 * records its path when it writes it ({@link ShellRevealService.record}), so a compromised renderer
 * cannot make the main process reveal an arbitrary location. A target with no recorded path, or
 * whose file no longer exists, is a no-op.
 */
@Injectable()
export class ShellRevealService {
  private readonly recorded = new Map<RevealTarget, string>();

  /**
   * Remembers `path` as the file `target` refers to; a later call replaces the earlier path.
   *
   * @param target - Which app-owned file this is.
   * @param path - Absolute path the app itself just wrote.
   */
  record(target: RevealTarget, path: string): void {
    this.recorded.set(target, path);
  }

  /**
   * Reveals the file recorded for `target`. Never rejects or throws: an unknown target, an
   * unrecorded or missing file, or a file-manager failure is logged at `warn` and ignored.
   *
   * @param target - Untrusted renderer input; anything other than a known {@link RevealTarget} is refused.
   */
  reveal(target: unknown): void {
    if (!isRevealTarget(target)) {
      logger.warn('ShellRevealService: refused unknown reveal target');
      return;
    }
    const path = this.recorded.get(target);
    if (!path || !existsSync(path)) {
      logger.warn('ShellRevealService: nothing to reveal for target', { target });
      return;
    }
    try {
      this.showItemInFolder(path);
    } catch (err) {
      logger.warn('ShellRevealService: failed to reveal target', { target, message: errMessage(err) });
    }
  }

  /**
   * Calls `shell.showItemInFolder(path)`, lazily requiring `electron` only inside an Electron
   * process so the plain-Node integration harness never loads it. Protected so tests can stub it.
   */
  protected showItemInFolder(path: string): void {
    if (!process.versions['electron']) return;
    const _require = createRequire(import.meta.url);
    const { shell } = _require('electron') as { shell: { showItemInFolder(path: string): void } };
    shell.showItemInFolder(path);
  }
}
