import type { Readable } from 'node:stream';
import { vi } from 'vitest';
import { VolumeFileError, type VolumeEntry, type VolumeFileBackend, type WriteOptions } from '../services/volumeFiles/VolumeFileBackend.js';

/** A scriptable in-memory {@link VolumeFileBackend} that records uploads and serves listings from them. */
export type FakeBackend = VolumeFileBackend & { uploads: string[]; sizes: Map<string, number> };

/** Rejects like a backend whose operation the fake does not script. */
const notScripted = (op: string) => vi.fn().mockRejectedValue(new VolumeFileError('failed', `${op} is not scripted in the fake backend`));

/**
 * Builds an in-memory {@link VolumeFileBackend}. Writes count their bytes through `onBytes`, record the remote path and
 * size, and show up in subsequent `list` calls (an unknown directory rejects with `not-found`); any method can be
 * replaced via `overrides`.
 */
export function fakeBackend(overrides: Partial<VolumeFileBackend> = {}): FakeBackend {
  const sizes = new Map<string, number>();
  const uploads: string[] = [];
  const base: VolumeFileBackend = {
    supportsArchive: false,
    connect: vi.fn().mockResolvedValue(undefined),
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeStream: vi.fn(async (path: string, source: Readable, { size, onBytes }: WriteOptions) => {
      source.destroy();
      onBytes?.(size);
      uploads.push(path);
      sizes.set(path, size);
    }),
    list: vi.fn(async (dir: string): Promise<VolumeEntry[]> => {
      const prefix = dir === '/' ? '/' : `${dir}/`;
      const entries = [...sizes].filter(([p]) => p.startsWith(prefix) && !p.slice(prefix.length).includes('/'));
      if (!entries.length) throw new VolumeFileError('not-found', `list ${dir} failed (404)`, 404);
      return entries.map(([p, size]) => ({ name: p.slice(prefix.length), isDir: false, size, modifiedMs: 0 }));
    }),
    stat: notScripted('stat'),
    readStream: notScripted('readStream'),
    move: notScripted('move'),
    remove: notScripted('remove'),
    close: vi.fn().mockResolvedValue(undefined),
  };
  return Object.assign(base, overrides, { uploads, sizes });
}
