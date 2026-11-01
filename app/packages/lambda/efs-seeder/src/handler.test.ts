/**
 * Tests for the EFS seeder Lambda handler.
 *
 * The handler receives a list of file seeds and writes them to the EFS
 * access point mounted at /mnt/efs, resolving in-container paths by stripping
 * the first volume's container_path prefix.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mkdirSyncMock = vi.fn();
const writeFileSyncMock = vi.fn();

vi.mock('fs', () => ({
  mkdirSync: (...args: unknown[]) => mkdirSyncMock(...args),
  writeFileSync: (...args: unknown[]) => writeFileSyncMock(...args),
}));

/** Import after mocks are registered so the handler uses the mocked fs. */
const { handler } = await import('./handler.js');

const GAME = 'palworld';
const CONTAINER_PATH = '/palworld';

describe('efs-seeder handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // @spec HELPER-SEED-004
  it('should write a UTF-8 text seed to the correct EFS path', async () => {
    await handler({
      game: GAME,
      seeds: [{ path: '/palworld/Pal/Saved/Config/settings.ini', content: '[Settings]\nkey=value' }],
      container_path: CONTAINER_PATH,
    });

    expect(mkdirSyncMock).toHaveBeenCalledWith(
      '/mnt/efs/Pal/Saved/Config',
      { recursive: true },
    );
    expect(writeFileSyncMock).toHaveBeenCalledWith(
      '/mnt/efs/Pal/Saved/Config/settings.ini',
      Buffer.from('[Settings]\nkey=value', 'utf8'),
      { flag: 'w', mode: 0o644 },
    );
  });

  // @spec HELPER-SEED-004
  it('should write a binary seed decoded from base64', async () => {
    const binaryContent = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
    const b64 = binaryContent.toString('base64');

    await handler({
      game: GAME,
      seeds: [{ path: '/palworld/Pal/Content/Paks/MyMod.pak', content_base64: b64 }],
      container_path: CONTAINER_PATH,
    });

    expect(writeFileSyncMock).toHaveBeenCalledWith(
      '/mnt/efs/Pal/Content/Paks/MyMod.pak',
      binaryContent,
      { flag: 'w', mode: 0o644 },
    );
  });

  // @spec HELPER-SEED-004
  it('should apply a custom mode when provided', async () => {
    await handler({
      game: GAME,
      seeds: [{ path: '/palworld/server.sh', content: '#!/bin/sh', mode: '0755' }],
      container_path: CONTAINER_PATH,
    });

    expect(writeFileSyncMock).toHaveBeenCalledWith(
      '/mnt/efs/server.sh',
      expect.any(Buffer),
      { flag: 'w', mode: 0o755 },
    );
  });

  it('should write multiple seeds in a single invocation', async () => {
    await handler({
      game: GAME,
      seeds: [
        { path: '/palworld/a.ini', content: 'a=1' },
        { path: '/palworld/b.ini', content: 'b=2' },
      ],
      container_path: CONTAINER_PATH,
    });

    expect(writeFileSyncMock).toHaveBeenCalledTimes(2);
  });

  // @spec HELPER-SEED-002
  it('should throw when a seed path does not start with container_path', async () => {
    await expect(
      handler({
        game: GAME,
        seeds: [{ path: '/other/path/config.ini', content: 'x=1' }],
        container_path: CONTAINER_PATH,
      }),
    ).rejects.toThrow('does not start with container_path');
  });

  // @spec HELPER-SEED-002
  it('should throw when the seed path equals container_path with no file component', async () => {
    await expect(
      handler({
        game: GAME,
        seeds: [{ path: '/palworld', content: 'x=1' }],
        container_path: CONTAINER_PATH,
      }),
    ).rejects.toThrow('no file component after container_path');
  });

  // @spec HELPER-SEED-002
  it('should throw on path traversal attempts', async () => {
    await expect(
      handler({
        game: GAME,
        seeds: [{ path: '/palworld/../../../etc/passwd', content: 'evil' }],
        container_path: CONTAINER_PATH,
      }),
    ).rejects.toThrow();
  });

  // @spec HELPER-SEED-003
  it('should throw when a seed has neither content nor content_base64', async () => {
    await expect(
      handler({
        game: GAME,
        seeds: [{ path: '/palworld/empty.txt' }],
        container_path: CONTAINER_PATH,
      }),
    ).rejects.toThrow('neither content nor content_base64');
  });

  // @spec HELPER-SEED-003
  it('should throw when a seed sets both content and content_base64', async () => {
    await expect(
      handler({
        game: GAME,
        seeds: [{ path: '/palworld/a.ini', content: 'x=1', content_base64: 'eD0x' }],
        container_path: CONTAINER_PATH,
      }),
    ).rejects.toThrow('sets both content and content_base64');
  });

  // @spec HELPER-SEED-003
  it('should throw when mode is not a valid octal string', async () => {
    await expect(
      handler({
        game: GAME,
        seeds: [{ path: '/palworld/a.ini', content: 'x=1', mode: 'rwxr-xr-x' }],
        container_path: CONTAINER_PATH,
      }),
    ).rejects.toThrow('invalid mode');
  });

  it('should handle an empty seeds list without errors', async () => {
    await expect(
      handler({ game: GAME, seeds: [], container_path: CONTAINER_PATH }),
    ).resolves.toBeUndefined();

    expect(writeFileSyncMock).not.toHaveBeenCalled();
  });
});
