import { randomUUID } from 'node:crypto';
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Injectable } from '@nestjs/common';
import { errMessage } from '@hyveon/shared';
import type { FolderScanNode, FolderScanResult } from '@hyveon/shared/folderUpload';
import { logger } from '../logger.js';

/** A scan retained in main so the renderer only ever references it by id. */
export interface HeldScan {
  scanId: string;
  rootPath: string;
  tree: FolderScanNode;
  /** `relPath -> mtimeMs` for every file, used to detect changes between scan and send. */
  mtimes: Map<string, number>;
}

/** Scans kept at once; older ones are evicted so abandoned pickers do not accumulate. */
const MAX_HELD_SCANS = 8;

/**
 * Picks a local folder with the native dialog and scans it into a {@link FolderScanNode} tree.
 * Symlinks are skipped and counted; file contents are never read here and never leave main.
 */
@Injectable()
export class FolderScanService {
  private readonly scans = new Map<string, HeldScan>();

  /**
   * Opens the native directory picker.
   *
   * @returns The chosen path, or `null` when cancelled or when not running inside Electron.
   */
  async pickDirectory(): Promise<string | null> {
    if (!process.versions.electron) return null;
    const { dialog } = (await import('electron')) as unknown as {
      dialog: { showOpenDialog(opts: { properties: string[] }): Promise<{ canceled: boolean; filePaths: string[] }> };
    };
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] });
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]!;
  }

  /** Picks a folder and scans it; `null` when the operator cancels. */
  async pickAndScan(): Promise<FolderScanResult | null> {
    const picked = await this.pickDirectory();
    return picked ? this.scan(picked) : null;
  }

  /**
   * Scans `rootPath` and holds the result under a fresh `scanId`.
   *
   * @throws Error with a normalized message when the root cannot be read.
   */
  async scan(rootPath: string): Promise<FolderScanResult> {
    try {
      const mtimes = new Map<string, number>();
      const counters = { skippedLinks: 0, fileCount: 0 };
      const rootName = rootPath.split(/[\\/]/).filter(Boolean).pop() ?? rootPath;
      const tree = await this.walk(rootPath, '', rootName, mtimes, counters);
      const scanId = randomUUID();
      this.scans.set(scanId, { scanId, rootPath, tree, mtimes });
      while (this.scans.size > MAX_HELD_SCANS) this.scans.delete(this.scans.keys().next().value as string);
      logger.info('FolderScanService: scan complete', { rootName, files: counters.fileCount, skippedLinks: counters.skippedLinks });
      return { scanId, rootName, tree, fileCount: counters.fileCount, totalBytes: tree.size, skippedLinks: counters.skippedLinks };
    } catch (err) {
      const message = errMessage(err);
      logger.warn('FolderScanService: scan failed', { rootPath, error: message });
      throw new Error(`Could not scan folder: ${message}`);
    }
  }

  /** Returns the held scan for `scanId`, if it has not been evicted. */
  get(scanId: string): HeldScan | undefined {
    return this.scans.get(scanId);
  }

  private async walk(
    absPath: string,
    relPath: string,
    name: string,
    mtimes: Map<string, number>,
    counters: { skippedLinks: number; fileCount: number },
  ): Promise<FolderScanNode> {
    const entries = await readdir(absPath, { withFileTypes: true });
    const children: FolderScanNode[] = [];
    for (const entry of entries) {
      const childRel = relPath ? `${relPath}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) {
        counters.skippedLinks += 1;
      } else if (entry.isDirectory()) {
        children.push(await this.walk(join(absPath, entry.name), childRel, entry.name, mtimes, counters));
      } else if (entry.isFile()) {
        const st = await lstat(join(absPath, entry.name));
        mtimes.set(childRel, st.mtimeMs);
        counters.fileCount += 1;
        children.push({ name: entry.name, kind: 'file', size: st.size, relPath: childRel });
      }
    }
    children.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1));
    return { name, kind: 'dir', size: children.reduce((sum, c) => sum + c.size, 0), relPath, children };
  }
}
