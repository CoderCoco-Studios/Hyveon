import { lstat } from 'node:fs/promises';
import { basename } from 'node:path';

/** A local regular file chosen for upload. */
export interface LocalFile {
  /** Absolute local path; never leaves the main process. */
  path: string;
  /** Base name, which becomes the entry name on the volume. */
  name: string;
  size: number;
}

/** Outcome of {@link statLocalFiles}: the files, or an operator message that names no local directory. */
export type LocalFilesResult = { ok: true; files: LocalFile[] } | { ok: false; message: string };

/**
 * Checks that every path is a regular file (links and folders are refused) and reads its size.
 *
 * @param paths - Local paths chosen by the operator.
 */
export async function statLocalFiles(paths: string[]): Promise<LocalFilesResult> {
  const files: LocalFile[] = [];
  for (const path of paths) {
    const name = basename(path);
    const info = await lstat(path).catch(() => null);
    if (!info) return { ok: false, message: `Couldn't read '${name}'.` };
    if (!info.isFile()) return { ok: false, message: `'${name}' isn't a file. Use Upload folder for folders.` };
    files.push({ path, name, size: info.size });
  }
  return { ok: true, files };
}
