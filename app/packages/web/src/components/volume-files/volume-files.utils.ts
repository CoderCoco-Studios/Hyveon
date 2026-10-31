import type { VolumeEntryInfo, VolumeFilesErrorCode, VolumeResult } from '@hyveon/shared/volumeFiles';

/** Column the file table sorts by. */
export type VolumeSortKey = 'name' | 'size' | 'modifiedMs';

/** Active file-table sort. */
export interface VolumeSort {
  key: VolumeSortKey;
  dir: 'asc' | 'desc';
}

/**
 * Runs a volume operation, turning a rejected IPC call into a failed {@link VolumeResult}.
 *
 * @param operation - Call that resolves to a result; may also throw synchronously or reject.
 * @returns The operation's result, or `{ ok: false, code: 'failed' }` carrying the thrown message.
 */
export async function settleVolumeResult<T>(operation: () => Promise<VolumeResult<T>>): Promise<VolumeResult<T>> {
  try {
    return await operation();
  } catch (err) {
    return { ok: false, code: 'failed', message: err instanceof Error ? err.message : String(err) };
  }
}

/** Case-insensitive name order with a raw-code tiebreak so entries differing only by case stay deterministic. */
function compareNames(a: string, b: string): number {
  const folded = a.toLowerCase().localeCompare(b.toLowerCase());
  if (folded !== 0) return folded;
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

// @spec HELPER-FB-024
/**
 * Sorts directory entries with folders first, then by the chosen key.
 *
 * @remarks
 * Folders precede files regardless of direction; `dir` only flips the order within each group. Ties on size or
 * modified time fall back to ascending name order.
 *
 * @param entries - Entries to sort; not mutated.
 * @param sort - Active sort key and direction.
 * @returns A new sorted array.
 */
export function sortVolumeEntries(entries: readonly VolumeEntryInfo[], sort: VolumeSort): VolumeEntryInfo[] {
  const sign = sort.dir === 'asc' ? 1 : -1;
  return [...entries].sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    const byKey = sort.key === 'name' ? compareNames(a.name, b.name) : a[sort.key] - b[sort.key];
    return byKey !== 0 ? byKey * sign : compareNames(a.name, b.name);
  });
}

/** Operator-facing name of a volume; the legacy synthesized volume has an empty name. */
export function volumeLabel(name: string): string {
  return name === '' ? 'Default volume' : name;
}

/** Formats a modification time, or a dash when it is unknown (`0`). */
export function formatModified(modifiedMs: number): string {
  return modifiedMs === 0 ? '—' : new Date(modifiedMs).toLocaleString();
}

/** True for the codes that mean the helper session is gone (`unreachable` / `no-session`), so the page should re-read it. */
export function isSessionLostCode(code: VolumeFilesErrorCode): boolean {
  return code === 'unreachable' || code === 'no-session';
}
