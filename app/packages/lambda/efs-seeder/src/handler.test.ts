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
const chmodSyncMock = vi.fn();

vi.mock('fs', () => ({
  mkdirSync: (...args: unknown[]) => mkdirSyncMock(...args),
  writeFileSync: (...args: unknown[]) => writeFileSyncMock(...args),
  chmodSync: (...args: unknown[]) => chmodSyncMock(...args),
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

  // @spec HELPER-SEED-005
  it('should chmod each written file to the seed mode so a rewrite of an existing file applies it', async () => {
    await handler({
      game: GAME,
      seeds: [
        { path: '/palworld/server.sh', content: '#!/bin/sh', mode: '0755' },
        { path: '/palworld/a.ini', content: 'a=1' },
      ],
      container_path: CONTAINER_PATH,
    });

    expect(chmodSyncMock).toHaveBeenCalledWith('/mnt/efs/server.sh', 0o755);
    expect(chmodSyncMock).toHaveBeenCalledWith('/mnt/efs/a.ini', 0o644);
  });

  // @spec HELPER-SEED-006
  it.each([
    ['game', { seeds: [], container_path: CONTAINER_PATH }],
    ['seeds', { game: GAME, container_path: CONTAINER_PATH }],
    ['seeds', { game: GAME, seeds: 'nope', container_path: CONTAINER_PATH }],
    ['container_path', { game: GAME, seeds: [] }],
    ['container_path', { game: GAME, seeds: [], container_path: '' }],
  ])('should fail with a validation error naming %s before writing when the event is malformed', async (field, event) => {
    // @ts-expect-error deliberately malformed event
    await expect(handler(event)).rejects.toThrow(new RegExp(`Invalid efs-seeder event.*${field}`));
    expect(writeFileSyncMock).not.toHaveBeenCalled();
  });

  // @spec HELPER-SEED-006
  it('should fail before writing anything when a later seed is malformed', async () => {
    await expect(
      handler({
        game: GAME,
        seeds: [
          { path: '/palworld/a.ini', content: 'a=1' },
          // @ts-expect-error deliberately malformed seed
          { content: 'b=2' },
        ],
        container_path: CONTAINER_PATH,
      }),
    ).rejects.toThrow(/Invalid efs-seeder event.*seeds\[1\]/);
    expect(writeFileSyncMock).not.toHaveBeenCalled();
  });

  // @spec HELPER-SEED-006
  it.each([
    ['an invalid mode', { path: '/palworld/b.ini', content: 'b=2', mode: '9zz' }, /invalid mode/],
    ['no content', { path: '/palworld/b.ini' }, /neither content nor content_base64/],
    ['both contents', { path: '/palworld/b.ini', content: 'b', content_base64: 'Yg==' }, /both content and content_base64/],
    ['a path outside the volume', { path: '/other/b.ini', content: 'b' }, /does not start with container_path/],
  ])('should write nothing when a later seed has %s', async (_label, bad, message) => {
    await expect(
      handler({
        game: GAME,
        seeds: [{ path: '/palworld/a.ini', content: 'a=1' }, bad],
        container_path: CONTAINER_PATH,
      }),
    ).rejects.toThrow(message);

    expect(mkdirSyncMock).not.toHaveBeenCalled();
    expect(writeFileSyncMock).not.toHaveBeenCalled();
    expect(chmodSyncMock).not.toHaveBeenCalled();
  });
});
