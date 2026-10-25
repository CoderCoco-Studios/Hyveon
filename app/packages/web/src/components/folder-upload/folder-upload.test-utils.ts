import type { FolderScanNode, FolderScanResult, FolderUploadProgress } from '@hyveon/shared/folderUpload';

/** Builds a file node for scan fixtures. */
export const fileNode = (relPath: string, size: number): FolderScanNode => ({
  name: relPath.split('/').pop() ?? relPath,
  kind: 'file',
  size,
  relPath,
});

/** Builds a directory node whose size is the sum of its children. */
export const dirNode = (relPath: string, children: FolderScanNode[]): FolderScanNode => ({
  name: relPath.split('/').pop() ?? relPath,
  kind: 'dir',
  size: children.reduce((sum, child) => sum + child.size, 0),
  relPath,
  children,
});

/** A scan of `Config/{a,b}.json` and `Data/w.db` (1,030 bytes, 3 files) with one skipped symlink. */
export function makeScan(overrides: Partial<FolderScanResult> = {}): FolderScanResult {
  const tree = dirNode('', [
    dirNode('Config', [fileNode('Config/a.json', 10), fileNode('Config/b.json', 20)]),
    dirNode('Data', [fileNode('Data/w.db', 1000)]),
  ]);
  return { scanId: 'scan-1', rootName: 'FoundryVTT', tree, fileCount: 3, totalBytes: 1030, skippedLinks: 1, ...overrides };
}

/** Builds a progress snapshot for `game`, defaulting to a mid-upload state. */
export function makeProgress(overrides: Partial<FolderUploadProgress> = {}): FolderUploadProgress {
  return {
    game: 'minecraft',
    phase: 'uploading',
    bytesDone: 500,
    bytesTotal: 1000,
    filesDone: 1,
    filesTotal: 3,
    currentPath: 'Data/w.db',
    bytesPerSecond: 2048,
    etaSeconds: 65,
    ...overrides,
  };
}
