import { vi } from 'vitest';
import type { FileBrowserApi, RemoteEntry, UploadFileArgs } from '../services/folderUpload/FileBrowserClient.js';

/** A scriptable in-memory {@link FileBrowserApi} that records uploads and serves listings from them. */
export type FakeClient = FileBrowserApi & { uploads: string[]; sizes: Map<string, number> };

/**
 * Builds an in-memory {@link FileBrowserApi}. Uploads count their bytes through `onBytes`, record the remote path and
 * size, and show up in subsequent `list` calls; any method can be replaced via `overrides`.
 */
export function fakeClient(overrides: Partial<FileBrowserApi> = {}): FakeClient {
  const sizes = new Map<string, number>();
  const uploads: string[] = [];
  const base: FileBrowserApi = {
    login: vi.fn().mockResolvedValue(undefined),
    mkdir: vi.fn().mockResolvedValue(undefined),
    uploadFile: vi.fn(async ({ remotePath, size, onBytes }: UploadFileArgs) => {
      onBytes(size);
      uploads.push(remotePath);
      sizes.set(remotePath, size);
    }),
    list: vi.fn(async (dir: string): Promise<RemoteEntry[] | null> => {
      const prefix = dir === '/' ? '/' : `${dir}/`;
      const entries = [...sizes].filter(([p]) => p.startsWith(prefix) && !p.slice(prefix.length).includes('/'));
      return entries.length ? entries.map(([p, size]) => ({ name: p.slice(prefix.length), isDir: false, size })) : null;
    }),
    close: vi.fn().mockResolvedValue(undefined),
  };
  return Object.assign(base, overrides, { uploads, sizes });
}
