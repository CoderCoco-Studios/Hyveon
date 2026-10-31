import type { VolumeEntryInfo, VolumeSessionStatus, VolumeTransferProgress } from '@hyveon/shared/volumeFiles';

/** Builds a session status for `minecraft`, defaulting to a running session with one mounted volume. */
export function makeSessionStatus(overrides: Partial<VolumeSessionStatus> = {}): VolumeSessionStatus {
  return {
    game: 'minecraft',
    state: 'running',
    browseHeld: true,
    uploadHolders: 0,
    supportsArchive: true,
    volumes: [{ name: 'data', containerPath: '/data', mounted: true }],
    ...overrides,
  };
}

/** Builds a directory entry (`isDir` true, zero size). */
export function makeDirEntry(name: string, modifiedMs = 1000): VolumeEntryInfo {
  return { name, isDir: true, size: 0, modifiedMs };
}

/** Builds a file entry. */
export function makeFileEntry(name: string, size = 10, modifiedMs = 1000): VolumeEntryInfo {
  return { name, isDir: false, size, modifiedMs };
}

/** Builds a transfer progress push for `minecraft`, defaulting to a running upload. */
export function makeTransfer(overrides: Partial<VolumeTransferProgress> = {}): VolumeTransferProgress {
  return {
    game: 'minecraft',
    transferId: 't1',
    kind: 'upload',
    name: 'a.txt',
    bytesDone: 0,
    bytesTotal: 10,
    phase: 'running',
    ...overrides,
  };
}
