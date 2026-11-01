import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { RegistryUploadBackend } from './RegistryUploadBackend.js';
import { VolumeFileError, type VolumeFileBackend } from '../volumeFiles/VolumeFileBackend.js';
import type { HelperSessionRegistry } from '../volumeFiles/HelperSessionRegistry.js';
import { fakeBackend } from '../../testing/fake-volume-backend.js';

/**
 * A registry whose `withBackend` runs `op` once and, when `retry` is set, runs it a second time as the real registry
 * does after recovering the operator IP.
 */
function registryOver(backend: VolumeFileBackend, retry = false) {
  const withBackend = vi.fn(async (_game: string, op: (b: VolumeFileBackend) => Promise<unknown>) => {
    try {
      return await op(backend);
    } catch (err) {
      if (!retry) throw err;
      return op(backend);
    }
  });
  return { registry: { withBackend } as Partial<HelperSessionRegistry> as HelperSessionRegistry, withBackend };
}

describe('RegistryUploadBackend', () => {
  it('should route each call through its own withBackend invocation for the game', async () => {
    const backend = fakeBackend();
    const { registry, withBackend } = registryOver(backend);
    const adapter = new RegistryUploadBackend(registry, 'mc');
    await adapter.mkdir('/a', { existOk: true });
    await expect(adapter.list('/a')).rejects.toBeInstanceOf(VolumeFileError);
    expect(withBackend).toHaveBeenCalledTimes(2);
    expect(withBackend).toHaveBeenCalledWith('mc', expect.any(Function));
    expect(backend.mkdir).toHaveBeenCalledWith('/a', { existOk: true });
  });

  it('should leave connecting and closing to the registry', async () => {
    const backend = fakeBackend();
    const adapter = new RegistryUploadBackend(registryOver(backend).registry, 'mc');
    await adapter.connect();
    await adapter.close();
    expect(backend.connect).not.toHaveBeenCalled();
    expect(backend.close).not.toHaveBeenCalled();
  });

  // @spec HELPER-UPLOAD-019
  it('should not replay a consumed source stream when the registry retries a write', async () => {
    const writeStream = vi.fn().mockRejectedValue(new VolumeFileError('unreachable', 'connection reset'));
    const backend = fakeBackend({ writeStream });
    const adapter = new RegistryUploadBackend(registryOver(backend, true).registry, 'mc');
    const result = adapter.writeStream('/a', Readable.from(['x']), { size: 1, overwrite: true });
    await expect(result).rejects.toMatchObject({ code: 'unreachable' });
    expect(writeStream).toHaveBeenCalledTimes(1);
  });

  it('should allow a fresh write call after a refused retry', async () => {
    const backend = fakeBackend();
    const adapter = new RegistryUploadBackend(registryOver(backend).registry, 'mc');
    await adapter.writeStream('/a', Readable.from(['x']), { size: 1, overwrite: true });
    await adapter.writeStream('/b', Readable.from(['x']), { size: 1, overwrite: true });
    expect(backend.uploads).toEqual(['/a', '/b']);
  });
});
