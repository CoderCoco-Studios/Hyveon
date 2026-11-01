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
import { streamToFile, TransferManager, transferErrorMessage, type TransferSpec } from './transfers.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'xfer-'));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe('streamToFile', () => {
  // @spec HELPER-XFER-002
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

  // @spec HELPER-XFER-002, HELPER-FB-027
  it('should leave no partial file when the source errors', async () => {
    const target = join(dir, 'out.bin');
    const source = new Readable({ read() {} });
    source.push(Buffer.from('abc'));
    const done = streamToFile(source, target, { signal: new AbortController().signal, onBytes: () => undefined });
    setTimeout(() => source.destroy(new Error('socket reset')), 20);
    await expect(done).rejects.toThrow('socket reset');
    expect(await readdir(dir)).toEqual([]);
  });

  // @spec HELPER-XFER-002, HELPER-FB-027
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

  // @spec HELPER-XFER-002
  it('should not touch an existing target when the transfer fails', async () => {
    const target = join(dir, 'out.bin');
    await writeFile(target, 'old');
    const source = new Readable({ read() { this.destroy(new Error('boom')); } });
    await expect(streamToFile(source, target, { signal: new AbortController().signal, onBytes: () => undefined })).rejects.toThrow('boom');
    expect(await readFile(target, 'utf8')).toBe('old');
    expect(await readdir(dir)).toEqual(['out.bin']);
  });
});

// @spec HELPER-XFER-002
describe('streamToFile with an existing neighbouring file', () => {
  it('should not touch a file already named like a part file, on success or failure', async () => {
    const target = join(dir, 'out.bin');
    await writeFile(`${target}.part`, 'mine');
    await streamToFile(Readable.from([Buffer.from('abc')]), target, { signal: new AbortController().signal, onBytes: () => undefined });
    const failing = new Readable({ read() { this.destroy(new Error('boom')); } });
    await expect(streamToFile(failing, join(dir, 'other.bin'), { signal: new AbortController().signal, onBytes: () => undefined })).rejects.toThrow('boom');
    await writeFile(`${target}.part`, 'mine');
    const stuck = new Readable({ read() { this.destroy(new Error('boom')); } });
    await expect(streamToFile(stuck, target, { signal: new AbortController().signal, onBytes: () => undefined })).rejects.toThrow('boom');
    expect(await readFile(`${target}.part`, 'utf8')).toBe('mine');
    expect((await readdir(dir)).sort()).toEqual(['out.bin', 'out.bin.part']);
  });
});

describe('transferErrorMessage', () => {
  const names = { missing: '/a', existing: 'a' };
  /** An error carrying a Node-style `code` (and optional `syscall`). */
  const coded = (code: string, syscall?: string) => Object.assign(new Error('x'), { code, ...(syscall && { syscall }) });

  it('should call Node file-system errors local', () => {
    expect(transferErrorMessage(coded('ENOSPC', 'write'), names, 'LOCAL')).toBe('LOCAL');
    expect(transferErrorMessage(coded('EACCES'), names, 'LOCAL')).toBe('LOCAL');
    expect(transferErrorMessage(coded('EXDEV', 'rename'), names, 'LOCAL')).toBe('LOCAL');
  });

  it('should report a dropped connection as the file manager being unreachable', () => {
    const unreachable = "The file manager isn't reachable. Stop and start the session.";
    expect(transferErrorMessage(coded('UND_ERR_SOCKET'), names, 'LOCAL')).toBe(unreachable);
    expect(transferErrorMessage(coded('UND_ERR_BODY_TIMEOUT'), names, 'LOCAL')).toBe(unreachable);
    expect(transferErrorMessage(coded('ECONNRESET', 'read'), names, 'LOCAL')).toBe(unreachable);
  });
});

/** A registry snapshot for game `mc` in `state`, with a browse hold and no volumes. */
const snapshot = (state: HelperSessionSnapshot['state']): HelperSessionSnapshot => ({
  game: 'mc',
  state,
  browseHeld: true,
  uploadHolders: 0,
  supportsArchive: true,
  volumes: [],
});

/** Builds a {@link TransferManager} over a registry stub and collects every event it emits. */
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

/** A {@link TransferSpec} that moves 10 bytes and succeeds, with `over` applied. */
const spec = (over: Partial<TransferSpec> = {}): TransferSpec => ({
  game: 'mc',
  kind: 'download',
  name: 'level.dat',
  bytesTotal: 10,
  describeError: (err) => (err instanceof Error ? `failed: ${err.message}` : 'failed'),
  run: async ({ onBytes }) => onBytes(10),
  ...over,
});

/** The most recent event, if any. */
const last = (events: VolumeTransferProgress[]) => events.at(-1);
/** Waits for a `done`, `failed` or `cancelled` event and returns it. */
const terminal = async (events: VolumeTransferProgress[]) => {
  await vi.waitFor(() => expect(['done', 'failed', 'cancelled']).toContain(last(events)?.phase));
  return last(events)!;
};

describe('TransferManager', () => {
  // @spec HELPER-XFER-005
  it('should hold the session while the transfer runs and release it afterwards', async () => {
    const { manager, registry, events } = managerHarness();
    const id = await manager.start(spec());
    await terminal(events);
    expect(registry.acquire).toHaveBeenCalledWith('mc', `download:xfer-${id}`);
    expect(registry.release).toHaveBeenCalledWith('mc', `download:xfer-${id}`);
  });

  // @spec HELPER-FB-041
  it('should hold an upload transfer as an upload holder so a game start is refused while it runs', async () => {
    const { manager, registry, events } = managerHarness();
    const id = await manager.start(spec({ kind: 'upload' }));
    await terminal(events);
    expect(registry.acquire).toHaveBeenCalledWith('mc', `upload:xfer-${id}`);
    expect(registry.release).toHaveBeenCalledWith('mc', `upload:xfer-${id}`);
  });

  // @spec HELPER-XFER-004
  it('should not join a session that is not running', async () => {
    const { manager, registry } = managerHarness('stopped');
    await expect(manager.start(spec())).rejects.toMatchObject({ name: 'NoSessionError' });
    expect(registry.acquire).not.toHaveBeenCalled();
  });

  // @spec HELPER-XFER-006
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

  // @spec HELPER-XFER-010
  it('should cancel a running transfer by id', async () => {
    const { manager, events } = managerHarness();
    const id = await manager.start(
      spec({ run: ({ signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))) }),
    );
    expect(manager.cancel('mc', id)).toEqual({ cancelled: true });
    expect(await terminal(events)).toMatchObject({ phase: 'cancelled' });
    expect(last(events)?.error).toBeUndefined();
  });

  // @spec HELPER-XFER-010
  it('should not cancel a transfer of another game or an unknown id', async () => {
    const { manager, events } = managerHarness();
    const id = await manager.start(spec({ run: ({ signal }) => new Promise((resolve) => signal.addEventListener('abort', () => resolve()))}));
    expect(manager.cancel('other', id)).toEqual({ cancelled: false });
    expect(manager.cancel('mc', 'nope')).toEqual({ cancelled: false });
    manager.abortGame('mc');
    await terminal(events);
  });

  // @spec HELPER-SESS-008, HELPER-FB-017
  it('should abort every transfer of a game when its session is stopping', async () => {
    const { manager, events } = managerHarness();
    const wait = ({ signal }: { signal: AbortSignal }) => new Promise<void>((_r, reject) => signal.addEventListener('abort', () => reject(new Error('x'))));
    await manager.start(spec({ run: wait }));
    await manager.start(spec({ run: wait, name: 'b' }));
    manager.abortGame('mc');
    await vi.waitFor(() => expect(events.filter((e) => e.phase === 'cancelled')).toHaveLength(2));
  });

  it('should return the transfer id before any progress event is delivered', async () => {
    const { manager, events } = managerHarness();
    const id = await manager.start(spec());
    expect(events).toEqual([]);
    expect(id).toEqual(expect.any(String));
    expect((await terminal(events)).transferId).toBe(id);
  });

  it('should release the session and finish even when a listener throws', async () => {
    const { manager, registry, events } = managerHarness();
    manager.onTransfer(() => {
      throw new Error('listener broke');
    });
    const id = await manager.start(spec());
    expect(await terminal(events)).toMatchObject({ phase: 'done' });
    expect(registry.release).toHaveBeenCalledWith('mc', `download:xfer-${id}`);
    expect(manager.cancel('mc', id)).toEqual({ cancelled: false });
  });

  it('should call onSettled once after the session is released, whatever the outcome', async () => {
    const { manager, registry, events } = managerHarness();
    const order: string[] = [];
    registry.release.mockImplementation(() => order.push('release'));
    const onSettled = vi.fn(() => order.push('settled'));
    await manager.start(spec({ onSettled }));
    await terminal(events);
    await manager.start(spec({ onSettled, run: async () => { throw new Error('disk full'); } }));
    await vi.waitFor(() => expect(onSettled).toHaveBeenCalledTimes(2));
    const id = await manager.start(spec({ onSettled, run: vi.fn() }));
    manager.cancel('mc', id);
    await vi.waitFor(() => expect(onSettled).toHaveBeenCalledTimes(3));
    expect(order.slice(0, 2)).toEqual(['release', 'settled']);
  });

  it('should not call onSettled for a transfer that could not start', async () => {
    const { manager } = managerHarness('stopped');
    const onSettled = vi.fn();
    await expect(manager.start(spec({ onSettled }))).rejects.toMatchObject({ name: 'NoSessionError' });
    expect(onSettled).not.toHaveBeenCalled();
  });

  it('should cancel a transfer cancelled before its work begins without running it', async () => {
    const { manager, events } = managerHarness();
    const run = vi.fn();
    const id = await manager.start(spec({ run }));
    expect(manager.cancel('mc', id)).toEqual({ cancelled: true });
    expect(await terminal(events)).toMatchObject({ phase: 'cancelled' });
    expect(run).not.toHaveBeenCalled();
  });
});
