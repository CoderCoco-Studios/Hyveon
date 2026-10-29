import 'reflect-metadata';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import type { VolumeTransferProgress } from '@hyveon/shared/volumeFiles';
import type { HelperSessionRegistry, HelperSessionSnapshot } from './HelperSessionRegistry.js';
import { streamToFile, TransferManager, type TransferSpec } from './transfers.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'xfer-'));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe('streamToFile', () => {
  it('should rename the part file on success', async () => {
    const target = join(dir, 'out.bin');
    const seen: number[] = [];
    await streamToFile(Readable.from([Buffer.from('abc'), Buffer.from('de')]), target, {
      signal: new AbortController().signal,
      onBytes: (n) => seen.push(n),
    });
    expect(await readFile(target, 'utf8')).toBe('abcde');
    expect(await readdir(dir)).toEqual(['out.bin']);
    expect(seen.reduce((a, b) => a + b, 0)).toBe(5);
  });

  it('should leave no partial file when the source errors', async () => {
    const target = join(dir, 'out.bin');
    const source = new Readable({ read() {} });
    source.push(Buffer.from('abc'));
    const done = streamToFile(source, target, { signal: new AbortController().signal, onBytes: () => undefined });
    setTimeout(() => source.destroy(new Error('socket reset')), 20);
    await expect(done).rejects.toThrow('socket reset');
    expect(await readdir(dir)).toEqual([]);
  });

  it('should leave no partial file when cancelled', async () => {
    const target = join(dir, 'out.bin');
    const controller = new AbortController();
    const source = new PassThrough();
    source.write(Buffer.from('abc'));
    const done = streamToFile(source, target, { signal: controller.signal, onBytes: () => undefined });
    setTimeout(() => controller.abort(), 20);
    await expect(done).rejects.toMatchObject({ name: 'AbortError' });
    expect(await readdir(dir)).toEqual([]);
  });

  it('should not touch an existing target when the transfer fails', async () => {
    const target = join(dir, 'out.bin');
    await writeFile(target, 'old');
    const source = new Readable({ read() { this.destroy(new Error('boom')); } });
    await expect(streamToFile(source, target, { signal: new AbortController().signal, onBytes: () => undefined })).rejects.toThrow('boom');
    expect(await readFile(target, 'utf8')).toBe('old');
    expect(await readdir(dir)).toEqual(['out.bin']);
  });
});

const snapshot = (state: HelperSessionSnapshot['state']): HelperSessionSnapshot => ({
  game: 'mc',
  state,
  browseHeld: true,
  uploadHolders: 0,
  supportsArchive: true,
  volumes: [],
});

function managerHarness(state: HelperSessionSnapshot['state'] = 'running') {
  const registry = {
    status: vi.fn().mockResolvedValue(snapshot(state)),
    acquire: vi.fn().mockResolvedValue({ ok: true }),
    release: vi.fn(),
  };
  const manager = new TransferManager(registry as Partial<HelperSessionRegistry> as HelperSessionRegistry);
  const events: VolumeTransferProgress[] = [];
  manager.onTransfer((e) => events.push(e));
  return { manager, registry, events };
}

const spec = (over: Partial<TransferSpec> = {}): TransferSpec => ({
  game: 'mc',
  kind: 'download',
  name: 'level.dat',
  bytesTotal: 10,
  describeError: (err) => (err instanceof Error ? `failed: ${err.message}` : 'failed'),
  run: async ({ onBytes }) => onBytes(10),
  ...over,
});

const last = (events: VolumeTransferProgress[]) => events.at(-1);
const terminal = async (events: VolumeTransferProgress[]) => {
  await vi.waitFor(() => expect(['done', 'failed', 'cancelled']).toContain(last(events)?.phase));
  return last(events)!;
};

describe('TransferManager', () => {
  it('should hold the session while the transfer runs and release it afterwards', async () => {
    const { manager, registry, events } = managerHarness();
    const id = await manager.start(spec());
    await terminal(events);
    expect(registry.acquire).toHaveBeenCalledWith('mc', `upload:xfer-${id}`);
    expect(registry.release).toHaveBeenCalledWith('mc', `upload:xfer-${id}`);
  });

  it('should not join a session that is not running', async () => {
    const { manager, registry } = managerHarness('stopped');
    await expect(manager.start(spec())).rejects.toMatchObject({ name: 'NoSessionError' });
    expect(registry.acquire).not.toHaveBeenCalled();
  });

  it('should report running progress and a final done with the saved name', async () => {
    const { manager, events } = managerHarness();
    const id = await manager.start(spec({ savedAs: 'level.dat' }));
    const end = await terminal(events);
    expect(events[0]).toMatchObject({ game: 'mc', transferId: id, kind: 'download', phase: 'running', bytesDone: 0, bytesTotal: 10 });
    expect(end).toMatchObject({ phase: 'done', bytesDone: 10, savedAs: 'level.dat' });
  });

  it('should report a failure with the described message and still release the session', async () => {
    const { manager, registry, events } = managerHarness();
    await manager.start(spec({ run: async () => { throw new Error('disk full'); } }));
    expect(await terminal(events)).toMatchObject({ phase: 'failed', error: 'failed: disk full' });
    expect(registry.release).toHaveBeenCalledTimes(1);
  });

  it('should cancel a running transfer by id', async () => {
    const { manager, events } = managerHarness();
    const id = await manager.start(
      spec({ run: ({ signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))) }),
    );
    expect(manager.cancel('mc', id)).toEqual({ cancelled: true });
    expect(await terminal(events)).toMatchObject({ phase: 'cancelled' });
    expect(last(events)?.error).toBeUndefined();
  });

  it('should not cancel a transfer of another game or an unknown id', async () => {
    const { manager, events } = managerHarness();
    const id = await manager.start(spec({ run: ({ signal }) => new Promise((resolve) => signal.addEventListener('abort', () => resolve()))}));
    expect(manager.cancel('other', id)).toEqual({ cancelled: false });
    expect(manager.cancel('mc', 'nope')).toEqual({ cancelled: false });
    manager.abortGame('mc');
    await terminal(events);
  });

  it('should abort every transfer of a game when its session is stopping', async () => {
    const { manager, events } = managerHarness();
    const wait = ({ signal }: { signal: AbortSignal }) => new Promise<void>((_r, reject) => signal.addEventListener('abort', () => reject(new Error('x'))));
    await manager.start(spec({ run: wait }));
    await manager.start(spec({ run: wait, name: 'b' }));
    manager.abortGame('mc');
    await vi.waitFor(() => expect(events.filter((e) => e.phase === 'cancelled')).toHaveLength(2));
  });
});
