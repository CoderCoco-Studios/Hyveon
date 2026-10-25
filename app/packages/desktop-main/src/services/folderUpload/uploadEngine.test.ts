import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileBrowserHttpError, PinMismatchError, type UploadFileArgs } from './FileBrowserClient.js';
import { fakeClient } from '../../testing/fake-filebrowser-client.js';
import { ProgressAggregator } from './ProgressAggregator.js';
import {
  ancestorDirs,
  classifyUpload,
  ensureDirs,
  listPlannedDirs,
  listRemoteSizes,
  remoteSizesOf,
  uploadAll,
  UploadCancelledError,
  UploadFileError,
  verifyUpload,
  type UploadEngineOptions,
  type UploadItem,
} from './uploadEngine.js';

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'engine-'));
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const instantOpts: UploadEngineOptions = { concurrency: 4, maxAttempts: 3, sleep: async () => undefined };

/** Creates a local file and the matching upload item. */
async function makeItem(rel: string, size: number, remote = `/Data/${rel}`): Promise<UploadItem> {
  const localPath = join(tmp, rel.replace(/\//g, '_'));
  await writeFile(localPath, Buffer.alloc(size, 1));
  await utimes(localPath, 1_700_000_000, 1_700_000_000);
  return { relPath: rel, localPath, remotePath: remote, size, mtimeMs: 1_700_000_000_000 };
}

function aggFor(items: UploadItem[]) {
  return new ProgressAggregator('g', items.reduce((s, i) => s + i.size, 0), items.length, () => undefined);
}

describe('ancestorDirs', () => {
  it('should list every ancestor once, shallowest first', () => {
    expect(ancestorDirs(['/a/b/c.txt', '/a/d.txt', '/e.txt'])).toEqual(['/a', '/a/b']);
  });
});

describe('ensureDirs', () => {
  it('should create parents before children', async () => {
    const client = fakeClient();
    await ensureDirs(client, [{ remotePath: '/a/b/c.txt' } as UploadItem]);
    expect(vi.mocked(client.mkdir).mock.calls.map((c) => c[0])).toEqual(['/a', '/a/b']);
  });
});

describe('uploadAll', () => {
  it('should upload every file and count their bytes and completions', async () => {
    const items = [await makeItem('a.txt', 10), await makeItem('b.txt', 20)];
    const client = fakeClient();
    const agg = aggFor(items);
    await uploadAll(client, items, new Map(), agg, undefined, instantOpts);
    expect(client.uploads.sort()).toEqual(['/Data/a.txt', '/Data/b.txt']);
    expect(agg.snapshot()).toMatchObject({ bytesDone: 30, filesDone: 2 });
  });

  it('should never have more than four uploads in flight', async () => {
    const items = await Promise.all(Array.from({ length: 12 }, (_, i) => makeItem(`f${i}.txt`, 5)));
    let inFlight = 0;
    let peak = 0;
    const client = fakeClient({
      uploadFile: async ({ onBytes, size }) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        onBytes(size);
        inFlight -= 1;
      },
    });
    await uploadAll(client, items, new Map(), aggFor(items), undefined, instantOpts);
    expect(peak).toBe(4);
  });

  it('should skip files already present with the expected size and overwrite partial ones (resume)', async () => {
    const items = [await makeItem('done.txt', 10), await makeItem('partial.txt', 20)];
    const client = fakeClient();
    const agg = aggFor(items);
    const existing = new Map([['/Data/done.txt', 10], ['/Data/partial.txt', 7]]);
    await uploadAll(client, items, existing, agg, undefined, instantOpts);
    expect(client.uploads).toEqual(['/Data/partial.txt']);
    expect(agg.snapshot()).toMatchObject({ bytesDone: 30, filesDone: 2 });
  });

  it('should retry a transient failure, roll back the failed attempt\'s bytes, then succeed', async () => {
    const items = [await makeItem('a.txt', 10)];
    let calls = 0;
    const client = fakeClient({
      uploadFile: async ({ onBytes, size }) => {
        calls += 1;
        onBytes(size / 2);
        if (calls < 3) throw new Error('socket hang up');
        onBytes(size / 2);
      },
    });
    const agg = aggFor(items);
    await uploadAll(client, items, new Map(), agg, undefined, instantOpts);
    expect(calls).toBe(3);
    expect(agg.snapshot()).toMatchObject({ bytesDone: 10, filesDone: 1 });
  });

  it('should fail the run naming the path after three attempts', async () => {
    const items = [await makeItem('bad.txt', 10), await makeItem('ok.txt', 10)];
    const uploadFile = vi.fn(async ({ remotePath }: UploadFileArgs) => {
      if (remotePath.endsWith('bad.txt')) throw new Error('ECONNRESET');
    });
    const client = fakeClient({ uploadFile });
    const err = await uploadAll(client, items.slice(0, 1), new Map(), aggFor(items), undefined, instantOpts).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UploadFileError);
    expect((err as UploadFileError).relPath).toBe('bad.txt');
    expect(uploadFile).toHaveBeenCalledTimes(3);
  });

  it('should not retry a 4xx response or a pin mismatch', async () => {
    const items = [await makeItem('a.txt', 10)];
    for (const failure of [new FileBrowserHttpError(403, 'forbidden'), new PinMismatchError()]) {
      const uploadFile = vi.fn().mockRejectedValue(failure);
      await expect(uploadAll(fakeClient({ uploadFile }), items, new Map(), aggFor(items), undefined, instantOpts)).rejects.toBeInstanceOf(UploadFileError);
      expect(uploadFile).toHaveBeenCalledTimes(1);
    }
  });

  it('should retry a 5xx response', async () => {
    const items = [await makeItem('a.txt', 10)];
    const uploadFile = vi.fn().mockRejectedValue(new FileBrowserHttpError(503, 'unavailable'));
    await expect(uploadAll(fakeClient({ uploadFile }), items, new Map(), aggFor(items), undefined, instantOpts)).rejects.toBeInstanceOf(UploadFileError);
    expect(uploadFile).toHaveBeenCalledTimes(3);
  });

  it('should fail without sending when the local file changed since the scan', async () => {
    const items = [await makeItem('a.txt', 10)];
    await writeFile(items[0]!.localPath, Buffer.alloc(11, 2));
    const uploadFile = vi.fn();
    await expect(uploadAll(fakeClient({ uploadFile }), items, new Map(), aggFor(items), undefined, instantOpts)).rejects.toThrow(/changed on disk/);
    expect(uploadFile).not.toHaveBeenCalled();
  });

  it('should fail when only the mtime changed', async () => {
    const items = [await makeItem('a.txt', 10)];
    await utimes(items[0]!.localPath, 1_800_000_000, 1_800_000_000);
    const uploadFile = vi.fn();
    await expect(uploadAll(fakeClient({ uploadFile }), items, new Map(), aggFor(items), undefined, instantOpts)).rejects.toThrow(/changed on disk/);
    expect(uploadFile).not.toHaveBeenCalled();
  });

  it('should reject with UploadCancelledError and abort in-flight requests when the signal fires', async () => {
    const items = await Promise.all(Array.from({ length: 6 }, (_, i) => makeItem(`f${i}.txt`, 5)));
    const controller = new AbortController();
    const seen: AbortSignal[] = [];
    const client = fakeClient({
      uploadFile: ({ signal }) =>
        new Promise<void>((_resolve, reject) => {
          seen.push(signal!);
          signal!.addEventListener('abort', () => reject(new Error('aborted')));
          controller.abort();
        }),
    });
    await expect(uploadAll(client, items, new Map(), aggFor(items), controller.signal, instantOpts)).rejects.toBeInstanceOf(UploadCancelledError);
    expect(seen.every((s) => s.aborted)).toBe(true);
    expect(seen.length).toBeLessThanOrEqual(4);
  });
});

describe('verifyUpload', () => {
  it('should pass when every planned file exists with the planned size', async () => {
    const items = [await makeItem('a.txt', 10)];
    const client = fakeClient();
    client.sizes.set('/Data/a.txt', 10);
    expect(await verifyUpload(client, items)).toEqual({ ok: true, missing: [], mismatched: [] });
  });

  it('should report missing and size-mismatched paths', async () => {
    const items = [await makeItem('a.txt', 10), await makeItem('b.txt', 10), await makeItem('c.txt', 10)];
    const client = fakeClient();
    client.sizes.set('/Data/a.txt', 10);
    client.sizes.set('/Data/b.txt', 3);
    expect(await verifyUpload(client, items)).toEqual({ ok: false, missing: ['c.txt'], mismatched: ['b.txt'] });
  });
});

describe('listRemoteSizes', () => {
  it('should list each parent directory once', async () => {
    const items = [await makeItem('a.txt', 1), await makeItem('b.txt', 1)];
    const client = fakeClient();
    await listRemoteSizes(client, items);
    expect(client.list).toHaveBeenCalledTimes(1);
  });
});

describe('listPlannedDirs', () => {
  it('should omit directories the volume does not have yet', async () => {
    const items = [await makeItem('a.txt', 1, '/Data/a.txt'), await makeItem('b.txt', 1, '/New/b.txt')];
    const client = fakeClient();
    client.sizes.set('/Data/a.txt', 1);
    const listings = await listPlannedDirs(client, items);
    expect([...listings.keys()]).toEqual(['/Data']);
    expect(remoteSizesOf(listings)).toEqual(new Map([['/Data/a.txt', 1]]));
  });

  it('should stop listing once the signal aborts', async () => {
    const items = [await makeItem('a.txt', 1)];
    const ctl = new AbortController();
    ctl.abort();
    await expect(listPlannedDirs(fakeClient(), items, ctl.signal)).rejects.toBeInstanceOf(UploadCancelledError);
  });
});

describe('classifyUpload', () => {
  const item = (relPath: string, size: number, remotePath = `/Data/${relPath}`) => ({ relPath, size, remotePath }) as UploadItem;

  it('should split planned files into new, identical and conflicting and count unrelated files as context only', () => {
    const items = [item('new.txt', 5), item('same.txt', 5), item('diff.txt', 9)];
    const remote = new Map([
      ['/Data/same.txt', 5],
      ['/Data/diff.txt', 2],
      ['/Data/unrelated.txt', 100],
    ]);
    expect(classifyUpload(items, remote)).toEqual({
      conflictCount: 1,
      identicalCount: 1,
      newCount: 1,
      otherExistingCount: 1,
      samples: [{ relPath: 'diff.txt', existingSize: 2, newSize: 9 }],
    });
  });

  it('should treat a zero-byte mismatch as a conflict', () => {
    expect(classifyUpload([item('a', 0)], new Map([['/Data/a', 3]])).conflictCount).toBe(1);
  });

  it('should cap the samples at 20 while still counting every conflict', () => {
    const items = Array.from({ length: 25 }, (_, i) => item(`f${i}`, 10));
    const remote = new Map(items.map((i) => [i.remotePath, 1] as [string, number]));
    const summary = classifyUpload(items, remote);
    expect(summary.conflictCount).toBe(25);
    expect(summary.samples).toHaveLength(20);
    expect(summary.samples[0]).toEqual({ relPath: 'f0', existingSize: 1, newSize: 10 });
  });

  it('should report an empty volume as all new', () => {
    expect(classifyUpload([item('a', 1), item('b', 2)], new Map())).toMatchObject({ conflictCount: 0, newCount: 2, identicalCount: 0, otherExistingCount: 0 });
  });
});
