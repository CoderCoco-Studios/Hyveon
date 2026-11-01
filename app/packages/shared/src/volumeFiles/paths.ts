/** Maximum UTF-8 byte length of a single directory entry name (the common POSIX `NAME_MAX`). */
const MAX_ENTRY_NAME_BYTES = 255;

/** Thrown when a volume path or entry name fails validation. */
export class VolumePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VolumePathError';
  }
}

// @spec HELPER-FB-031
/**
 * True when `path` is an absolute POSIX path with no NUL, backslash, or `.`/`..`/empty segments.
 *
 * @remarks
 * `/` is clean and a single trailing `/` is tolerated. Doubled slashes are rejected.
 *
 * @param path - Candidate path.
 */
export function isCleanVolumePath(path: string): boolean {
  if (!path.startsWith('/') || path.includes('\0') || path.includes('\\')) return false;
  let body = path.slice(1);
  if (body === '') return true;
  if (body.endsWith('/')) body = body.slice(0, -1);
  return body.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

// @spec HELPER-FB-031
/**
 * Returns the canonical form of a clean volume path: no trailing `/` except for the root.
 *
 * @param path - Candidate path.
 * @returns The canonical path.
 * @throws VolumePathError when `path` is not clean.
 */
export function normalizeVolumePath(path: string): string {
  if (!isCleanVolumePath(path)) throw new VolumePathError(`Invalid volume path: ${JSON.stringify(path)}`);
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
}

// @spec HELPER-FB-032
/**
 * True when `name` is usable as a single directory entry name.
 *
 * @param name - Candidate entry name.
 */
export function isValidEntryName(name: string): boolean {
  return (
    name !== '' &&
    name !== '.' &&
    name !== '..' &&
    !/[/\\\0]/.test(name) &&
    new TextEncoder().encode(name).length <= MAX_ENTRY_NAME_BYTES
  );
}

// @spec HELPER-FB-032
/**
 * Joins an entry name onto a directory path.
 *
 * @param dir - Clean absolute directory path.
 * @param name - Entry name.
 * @returns The canonical child path.
 * @throws VolumePathError when `dir` is not clean or `name` is not a valid entry name.
 */
export function joinVolumePath(dir: string, name: string): string {
  const base = normalizeVolumePath(dir);
  if (!isValidEntryName(name)) throw new VolumePathError(`Invalid entry name: ${JSON.stringify(name)}`);
  return base === '/' ? `/${name}` : `${base}/${name}`;
}

/**
 * Returns the parent directory of a volume path; the root is its own parent.
 *
 * @param path - Clean absolute path.
 * @throws VolumePathError when `path` is not clean.
 */
export function parentOfVolumePath(path: string): string {
  const p = normalizeVolumePath(path);
  const idx = p.lastIndexOf('/');
  return idx <= 0 ? '/' : p.slice(0, idx);
}
