import { errMessage } from '@hyveon/shared';
import { VolumePathError, type VolumeFilesErrorCode, type VolumeRef, type VolumeResult } from '@hyveon/shared/volumeFiles';
import { logger } from '../../logger.js';
import { NoSessionError } from './HelperSessionRegistry.js';
import { VolumeFileError } from './VolumeFileBackend.js';

/** A failed {@link VolumeResult}. */
export type VolumeFailure = Extract<VolumeResult<never>, { ok: false }>;

/** Wraps a value as a successful {@link VolumeResult}. */
export const ok = <T>(value: T): VolumeResult<T> => ({ ok: true, value });

/** Builds a failed {@link VolumeResult}. */
export const fail = (code: VolumeFilesErrorCode, message: string): VolumeFailure => ({ ok: false, code, message });

/** Fixed operator messages for session-level backend failures that name no path. */
const OPERATOR_MESSAGES: Record<Exclude<VolumeFileError['code'], 'not-found' | 'conflict' | 'failed'>, string> = {
  unreachable: "The file manager isn't reachable. Restart the session.",
  auth: 'The file manager rejected the session. Restart the session.',
  'pin-mismatch': "The file manager's identity couldn't be verified. Restart the session.",
};

/** Raised by validation when text to save exceeds the editor limit; mapped to `too-large`. */
export class TextTooLargeError extends Error {}

/** What the operator called things in a request: used to word failures without echoing backend messages. */
export interface OpNames {
  /** Volume path that may turn out to be missing. */
  missing: string;
  /** Entry name that may turn out to exist already. */
  existing: string;
}

/** Whether `err` is an aborted or timed-out request. */
export const isAbort = (err: unknown): boolean => err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');

/** Whether `err` is an aborted request, raw or wrapped by the client as `unreachable` with the abort as its cause. */
export const isAbortOrWrapped = (err: unknown): boolean =>
  isAbort(err) || (err instanceof VolumeFileError && err.code === 'unreachable' && isAbort(err.cause));

/** The code and fixed operator message for `err`. */
export function describeFailure(err: unknown, names: OpNames): VolumeFailure {
  if (err instanceof NoSessionError) return fail('no-session', 'No file manager session is running. Start one to browse files.');
  if (err instanceof TextTooLargeError) return fail('too-large', 'That text is larger than 1 MiB and can\'t be saved here.');
  if (err instanceof VolumePathError) return fail('invalid-path', err.message);
  if (isAbortOrWrapped(err)) return fail('unreachable', "The file manager didn't respond in time.");
  if (err instanceof VolumeFileError) {
    if (err.code === 'not-found') return fail('not-found', `'${names.missing}' no longer exists.`);
    if (err.code === 'conflict') return fail('conflict', `'${names.existing}' already exists.`);
    if (err.code !== 'failed') return fail(err.code, OPERATOR_MESSAGES[err.code]);
  }
  return fail('failed', 'The file operation failed.');
}

/**
 * Logs a refusal decided by a check rather than thrown, so every refused operation leaves a line in the log.
 *
 * @remarks
 * Identifiers only; never content or local paths. `server-check-failed` is skipped because
 * `FileOps.assertWritable` already logged the cause.
 *
 * @param ref - Game and volume.
 * @param path - Raw request path.
 * @param failure - The refusal about to be returned.
 * @returns `failure`, so callers can `return logRefusal(...)`.
 */
export function logRefusal<T extends VolumeFailure>(ref: VolumeRef, path: string, failure: T): T {
  if (failure.code !== 'server-check-failed') {
    logger.info('VolumeFilesService: file operation refused', { game: ref.game, volume: ref.volume, path, code: failure.code });
  }
  return failure;
}

/** Replaces URLs and IPv4 literals (with an optional `/NN` or `:port`) in text that crosses IPC from AWS or the registry. */
export function scrubAddresses(text: string): string {
  return text.replace(/https?:\/\/\S+/gi, '<address>').replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?:\/\d{1,2}|:\d{1,5})?(?!\d)/g, '<address>');
}

/**
 * Maps a thrown error to a modeled failure and logs it with identifiers only.
 *
 * @remarks
 * Backend messages embed helper mount paths, so the operator message is built from `names` instead; the original
 * message is logged.
 *
 * @param err - What was thrown.
 * @param ref - Game and volume, for the log line.
 * @param path - Raw request path, for the log line.
 * @param names - What the operator called things, for the message.
 */
export function toVolumeResult(err: unknown, ref: VolumeRef, path: string, names: OpNames): VolumeFailure {
  const failure = describeFailure(err, names);
  const log = { game: ref.game, volume: ref.volume, path, code: failure.code, error: errMessage(err) };
  if (failure.code === 'failed') logger.error('VolumeFilesService: file operation failed', log);
  else logger.warn('VolumeFilesService: file operation refused', log);
  return failure;
}
