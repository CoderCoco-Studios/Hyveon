import { isCleanVolumePath } from '../volumeFiles/paths.js';
import type { FolderScanNode, PlannedFile } from './types.js';

/** Structural subset of `GameServerVolume` needed for destination checks. */
export interface VolumeLike {
  name: string;
  container_path: string;
}

/** Result of {@link validateDestination}. */
export type DestinationValidation = { ok: true; volume: VolumeLike } | { ok: false; error: string };

/** Splits a POSIX path into segments, dropping empty ones produced by leading, trailing, or doubled slashes. */
const segments = (path: string): string[] => path.split('/').filter((s) => s !== '');

/** True when `path` equals `base` or sits beneath it, comparing whole segments. */
const isWithin = (base: string[], path: string[]): boolean =>
  path.length >= base.length && base.every((seg, i) => path[i] === seg);

// @spec HELPER-SELECT-003, HELPER-SELECT-004
/**
 * Flattens a scan tree into the files to upload.
 *
 * @remarks
 * A path is included when it, or any ancestor directory, appears in `include`. A directory that is neither listed nor
 * beneath a listed directory contributes only the descendants individually listed. Symlinks never appear because the
 * scan skips them, and directories themselves are not emitted (the uploader creates them on demand).
 *
 * @param tree - Scan root; its own `relPath` is typically `''`.
 * @param include - Selected `relPath`s.
 * @returns Files in tree order.
 */
export function planUpload(tree: FolderScanNode, include: string[]): PlannedFile[] {
  const selected = new Set(include);
  const out: PlannedFile[] = [];
  const walk = (node: FolderScanNode, inherited: boolean): void => {
    const on = inherited || selected.has(node.relPath);
    if (node.kind === 'file') {
      if (on) out.push({ relPath: node.relPath, size: node.size });
      return;
    }
    for (const child of node.children ?? []) walk(child, on);
  };
  walk(tree, false);
  return out;
}

// @spec HELPER-SELECT-004, HELPER-SAFE-002
/**
 * Resolves the path a file is uploaded to within its owning volume.
 *
 * @remarks
 * The result is relative to the volume's root, not to the helper's filesystem: a helper mounts every volume under its own
 * directory, so the caller prefixes the volume's mount directory to get the helper path.
 *
 * @param destination - Absolute container path chosen by the operator.
 * @param containerPath - The `container_path` of the volume that owns `destination`; stripped from `destination`.
 * @param relPath - File path relative to the scanned folder.
 * @returns Absolute path inside the volume such as `/worlds/a.db`.
 * @throws Error when `relPath` is absolute or contains `..`, `.`, backslash, or NUL, when `destination` is not clean
 * and absolute, or when `destination` is outside `containerPath`.
 */
export function toRemotePath(destination: string, containerPath: string, relPath: string): string {
  if (relPath === '' || relPath.startsWith('/') || relPath.includes('\0') || relPath.includes('\\')) {
    throw new Error(`Invalid relative path: ${relPath}`);
  }
  const relSegs = relPath.split('/');
  if (relSegs.some((s) => s === '' || s === '.' || s === '..')) {
    throw new Error(`Invalid relative path: ${relPath}`);
  }
  if (!isCleanVolumePath(destination) || !isCleanVolumePath(containerPath)) {
    throw new Error(`Destination must be a clean absolute path: ${destination}`);
  }
  const base = segments(containerPath);
  const dest = segments(destination);
  if (!isWithin(base, dest)) {
    throw new Error(`Destination ${destination} is outside the volume path ${containerPath}`);
  }
  return '/' + [...dest.slice(base.length), ...relSegs].join('/');
}

// @spec HELPER-SELECT-005, HELPER-SELECT-006
/**
 * Checks that `destination` is a clean absolute path equal to or beneath one of the game's volume mount paths.
 *
 * @param destination - Candidate destination.
 * @param volumes - The game's volumes.
 * @returns The owning volume (the deepest matching mount) or a human-readable error.
 */
export function validateDestination(destination: string, volumes: VolumeLike[]): DestinationValidation {
  if (!isCleanVolumePath(destination)) {
    return { ok: false, error: 'Destination must be an absolute path without "..", "." or empty segments.' };
  }
  const dest = segments(destination);
  const matches = volumes
    .filter((v) => isCleanVolumePath(v.container_path) && isWithin(segments(v.container_path), dest))
    .sort((a, b) => segments(b.container_path).length - segments(a.container_path).length);
  if (matches.length === 0) {
    return { ok: false, error: 'Destination must be inside one of the game volume paths.' };
  }
  return { ok: true, volume: matches[0] };
}
