import 'reflect-metadata';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { FolderScanService } from './FolderScanService.js';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'scan-'));
  await mkdir(join(root, 'Config'));
  await mkdir(join(root, 'Data', 'worlds'), { recursive: true });
  await writeFile(join(root, 'Config', 'options.json'), '12345');
  await writeFile(join(root, 'Data', 'worlds', 'a.db'), 'x'.repeat(100));
  await writeFile(join(root, 'readme.txt'), 'hi');
  await symlink(join(root, 'readme.txt'), join(root, 'link.txt'));
  await symlink(join(root, 'Data'), join(root, 'dirlink'));
});
afterEach(() => rm(root, { recursive: true, force: true }));

describe('FolderScanService', () => {
  it('should build a tree with POSIX relPaths, rolled-up sizes and counts', async () => {
    const result = await new FolderScanService().scan(root);
    expect(result.fileCount).toBe(3);
    expect(result.totalBytes).toBe(107);
    expect(result.tree.children?.map((c) => c.name)).toEqual(['Config', 'Data', 'readme.txt']);
    const data = result.tree.children!.find((c) => c.name === 'Data')!;
    expect(data).toMatchObject({ kind: 'dir', size: 100, relPath: 'Data' });
    expect(data.children![0]!.children![0]).toMatchObject({ kind: 'file', relPath: 'Data/worlds/a.db', size: 100 });
  });

  it('should skip symlinks to files and directories and count them', async () => {
    const result = await new FolderScanService().scan(root);
    expect(result.skippedLinks).toBe(2);
    expect(JSON.stringify(result.tree)).not.toContain('link');
  });

  it('should hold the scan by id with per-file mtimes and never expose the absolute path in the result', async () => {
    const svc = new FolderScanService();
    const result = await svc.scan(root);
    const held = svc.get(result.scanId);
    expect(held?.rootPath).toBe(root);
    expect(held?.mtimes.has('Data/worlds/a.db')).toBe(true);
    expect(JSON.stringify(result)).not.toContain(root);
  });

  it('should evict the oldest scans beyond the retention limit', async () => {
    const svc = new FolderScanService();
    const first = await svc.scan(root);
    for (let i = 0; i < 8; i += 1) await svc.scan(root);
    expect(svc.get(first.scanId)).toBeUndefined();
  });

  it('should reject with a normalized message when the root cannot be read', async () => {
    await expect(new FolderScanService().scan(join(root, 'nope'))).rejects.toThrow(/Could not scan folder/);
  });

  it('should return null from the picker outside Electron', async () => {
    expect(await new FolderScanService().pickAndScan()).toBeNull();
  });
});
