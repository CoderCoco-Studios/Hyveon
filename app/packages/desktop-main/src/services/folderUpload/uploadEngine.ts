import { stat } from 'node:fs/promises';
import { errMessage } from '@hyveon/shared';
import { MAX_OVERWRITE_SAMPLES, type OverwriteSummary } from '@hyveon/shared/folderUpload';
import { FileBrowserHttpError, PinMismatchError, type FileBrowserApi, type RemoteEntry } from './FileBrowserClient.js';
import type { ProgressAggregator } from './ProgressAggregator.js';

/** A file resolved for upload: where it is locally, where it lands on the helper, and what the scan recorded. */
export interface UploadItem {
  relPath: string;
  localPath: string;
  /** Absolute path on the helper, already traversal-checked via `toRemotePath`. */
  remotePath: string;
  size: number;
  mtimeMs: number;
}

/** Tunables; the defaults are the production values. */
export interface UploadEngineOptions {
  concurrency: number;
  /** Total attempts per file, including the first. */
  maxAttempts: number;
  /** Waits `ms`, rejecting early when `signal` aborts. */
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** Production defaults: four files in flight, three attempts per file. */
export const DEFAULT_ENGINE_OPTIONS: UploadEngineOptions = {
  concurrency: 4,
  maxAttempts: 3,
  sleep: abortableSleep,
};

/** Thrown when the run is cancelled via its `AbortSignal`. */
export class UploadCancelledError extends Error {
  constructor() {
    super('Upload cancelled');
    this.name = 'UploadCancelledError';
  }
}

/** Thrown when the operator never answered the overwrite warning in time; the run ends as cancelled. */
export class ConfirmationTimeoutError extends UploadCancelledError {
  constructor() {
    super();
    this.message = 'Timed out waiting for overwrite confirmation';
  }
}

/** Thrown when a local file no longer matches what the scan recorded; retrying cannot help. */
export class FileChangedError extends Error {
  constructor(relPath: string) {
    super(`${relPath} changed on disk since it was scanned; rescan the folder`);
    this.name = 'FileChangedError';
  }
}

/** Thrown when a file exhausts its attempts; carries the offending path. */
export class UploadFileError extends Error {
  constructor(
    readonly relPath: string,
    cause: unknown,
  ) {
    super(`${relPath}: ${errMessage(cause)}`);
    this.name = 'UploadFileError';
  }
}

/** Result of comparing the volume against the plan. */
export interface VerifyResult {
  ok: boolean;
  missing: string[];
  mismatched: string[];
}

/** `setTimeout`-based sleep that rejects with {@link UploadCancelledError} if `signal` aborts first. */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new UploadCancelledError());
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new UploadCancelledError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Every ancestor directory of the given absolute remote paths, shallowest first, excluding `/`. */
export function ancestorDirs(remotePaths: string[]): string[] {
  const dirs = new Set<string>();
  for (const p of remotePaths) {
    const parts = p.split('/').filter(Boolean).slice(0, -1);
    for (let i = 1; i <= parts.length; i += 1) dirs.add('/' + parts.slice(0, i).join('/'));
  }
  return [...dirs].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
}

/** Runs `fn` over `inputs` with at most `limit` in flight; rejects with the first failure and stops starting new work. */
async function mapPool<T>(inputs: T[], limit: number, fn: (input: T) => Promise<void>): Promise<void> {
  let next = 0;
  let failure: unknown;
  let failed = false;
  const worker = async (): Promise<void> => {
    while (!failed && next < inputs.length) {
      const input = inputs[next++]!;
      try {
        await fn(input);
      } catch (err) {
        if (!failed) {
          failed = true;
          failure = err;
        }
        return;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, inputs.length) }, worker));
  if (failed) throw failure;
}

/** Creates every ancestor directory of the planned files, parents first. */
export async function ensureDirs(client: FileBrowserApi, items: UploadItem[], signal?: AbortSignal): Promise<void> {
  for (const dir of ancestorDirs(items.map((i) => i.remotePath))) {
    throwIfAborted(signal);
    await client.mkdir(dir, signal);
  }
}

/** Lists the parent directory of every planned file; missing directories are absent from the result. */
export async function listPlannedDirs(
  client: FileBrowserApi,
  items: UploadItem[],
  signal?: AbortSignal,
  concurrency = DEFAULT_ENGINE_OPTIONS.concurrency,
): Promise<Map<string, RemoteEntry[]>> {
  const parents = [...new Set(items.map((i) => i.remotePath.slice(0, i.remotePath.lastIndexOf('/')) || '/'))];
  const listings = new Map<string, RemoteEntry[]>();
  await mapPool(parents, concurrency, async (dir) => {
    throwIfAborted(signal);
    const entries = await client.list(dir, signal);
    if (entries) listings.set(dir, entries);
  });
  return listings;
}

const joinRemote = (dir: string, name: string): string => `${dir === '/' ? '' : dir}/${name}`;

/** Flattens directory listings into `remotePath -> size` for the files that exist. */
export function remoteSizesOf(listings: Map<string, RemoteEntry[]>): Map<string, number> {
  const sizes = new Map<string, number>();
  for (const [dir, entries] of listings) {
    for (const e of entries) if (!e.isDir) sizes.set(joinRemote(dir, e.name), e.size);
  }
  return sizes;
}

/** Lists the parent directory of every planned file and returns `remotePath -> size` for the files that exist. */
export async function listRemoteSizes(
  client: FileBrowserApi,
  items: UploadItem[],
  signal?: AbortSignal,
  concurrency = DEFAULT_ENGINE_OPTIONS.concurrency,
): Promise<Map<string, number>> {
  return remoteSizesOf(await listPlannedDirs(client, items, signal, concurrency));
}

/**
 * Classifies each planned file against the volume: new, identical (same size; resume skips it) or a conflict (exists
 * with a different size and would be overwritten). Existing files the plan does not include are only counted.
 *
 * @param remoteSizes - `remotePath -> size` from {@link remoteSizesOf}.
 */
export function classifyUpload(items: UploadItem[], remoteSizes: Map<string, number>): OverwriteSummary {
  const summary: OverwriteSummary = { conflictCount: 0, identicalCount: 0, newCount: 0, otherExistingCount: 0, samples: [] };
  for (const item of items) {
    const existing = remoteSizes.get(item.remotePath);
    if (existing === undefined) summary.newCount += 1;
    else if (existing === item.size) summary.identicalCount += 1;
    else {
      summary.conflictCount += 1;
      if (summary.samples.length < MAX_OVERWRITE_SAMPLES) {
        summary.samples.push({ relPath: item.relPath, existingSize: existing, newSize: item.size });
      }
    }
  }
  summary.otherExistingCount = remoteSizes.size - summary.conflictCount - summary.identicalCount;
  return summary;
}

/** Compares the volume's listing against the plan (count and per-file size). */
export async function verifyUpload(client: FileBrowserApi, items: UploadItem[], signal?: AbortSignal): Promise<VerifyResult> {
  const sizes = await listRemoteSizes(client, items, signal);
  const missing: string[] = [];
  const mismatched: string[] = [];
  for (const item of items) {
    const remote = sizes.get(item.remotePath);
    if (remote === undefined) missing.push(item.relPath);
    else if (remote !== item.size) mismatched.push(item.relPath);
  }
  return { ok: missing.length === 0 && mismatched.length === 0, missing, mismatched };
}

/** Errors a retry cannot fix: cancellation, a pin failure, a changed local file, or a 4xx other than 408/429. */
function isPermanent(err: unknown): boolean {
  if (err instanceof UploadCancelledError || err instanceof PinMismatchError || err instanceof FileChangedError) return true;
  if (err instanceof FileBrowserHttpError) return err.status >= 400 && err.status < 500 && err.status !== 408 && err.status !== 429;
  return false;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new UploadCancelledError();
}

/** Uploads one file with bounded retries, rolling back its counted bytes after each failed attempt. */
async function uploadOne(
  client: FileBrowserApi,
  item: UploadItem,
  progress: ProgressAggregator,
  signal: AbortSignal | undefined,
  opts: UploadEngineOptions,
): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    throwIfAborted(signal);
    let counted = 0;
    try {
      const local = await stat(item.localPath);
      if (local.size !== item.size || local.mtimeMs !== item.mtimeMs) throw new FileChangedError(item.relPath);
      throwIfAborted(signal);
      progress.setCurrent(item.relPath);
      await client.uploadFile({
        remotePath: item.remotePath,
        localPath: item.localPath,
        size: item.size,
        signal,
        onBytes: (n) => {
          counted += n;
          progress.addBytes(n);
        },
      });
      progress.fileDone();
      return;
    } catch (err) {
      progress.addBytes(-counted);
      if (signal?.aborted) throw new UploadCancelledError();
      if (isPermanent(err) || attempt >= opts.maxAttempts) throw new UploadFileError(item.relPath, err);
      await opts.sleep(500 * attempt, signal);
    }
  }
}

/**
 * Uploads `items`, skipping files the volume already holds at the expected size (resume), with bounded concurrency.
 *
 * @param remoteSizes - `remotePath -> size` from {@link listRemoteSizes}; matching files are counted as done, anything
 * else (including a partially written file) is re-sent with `override=true`.
 * @throws UploadCancelledError when `signal` aborts; UploadFileError for the first file to exhaust its attempts.
 */
export async function uploadAll(
  client: FileBrowserApi,
  items: UploadItem[],
  remoteSizes: Map<string, number>,
  progress: ProgressAggregator,
  signal?: AbortSignal,
  opts: UploadEngineOptions = DEFAULT_ENGINE_OPTIONS,
): Promise<void> {
  const pending: UploadItem[] = [];
  for (const item of items) {
    if (remoteSizes.get(item.remotePath) === item.size) {
      progress.addBytes(item.size);
      progress.fileDone();
    } else {
      pending.push(item);
    }
  }
  const inner = new AbortController();
  const onOuterAbort = () => inner.abort();
  signal?.addEventListener('abort', onOuterAbort, { once: true });
  try {
    await mapPool(pending, opts.concurrency, async (item) => {
      try {
        await uploadOne(client, item, progress, inner.signal, opts);
      } catch (err) {
        inner.abort();
        throw err;
      }
    });
  } catch (err) {
    if (signal?.aborted) throw new UploadCancelledError();
    throw err;
  } finally {
    signal?.removeEventListener('abort', onOuterAbort);
  }
}
