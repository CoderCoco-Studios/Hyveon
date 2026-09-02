import { logger } from '../logger.js';

/**
 * Leaked-promise-handling primitive: if the inline Pulumi program leaves
 * dangling promises, the SDK's `onPulumiExit` runs a leak check inside the
 * `finally` block of `stack.up()`/`.preview()`/`.destroy()` — only on the
 * branch where the CLI call itself succeeded, since a genuine CLI failure
 * skips the check entirely. A throw partway through `finally` replaces the
 * successful return, so a real success gets reported as a rejection even
 * though the operation's data (outputs, summary) was already obtained.
 *
 * Because the leak check only runs on that success branch, any caught error
 * whose message matches the SDK's leak-message format is, by construction,
 * proof the CLI operation itself succeeded — message matching alone is
 * sufficient, no separate exit-code tracking needed.
 *
 * The same throw also aborts the rest of that `finally` block, so the
 * language-server and event-log gRPC servers and the temp log file that
 * `finally` would otherwise have torn down are left dangling for the life of
 * the Electron process — the same class of leak as the `@cdktf/hcl2json`
 * quit-hang incident. Nothing in this module can close them (they're local
 * variables inside the SDK, never exposed to a caller); recovering "success"
 * here only makes that leak silent, it doesn't fix it.
 *
 * {@link isLeakedPromiseError} and {@link runTreatingLeakedPromiseAsSuccess}
 * cannot reconstruct the lost `UpResult`/`PreviewResult`/`DestroyResult` —
 * that data was never returned to any caller. The caller's `recoverResult`
 * rebuilds it instead; `PulumiService` does this via fresh `stack.outputs()`/
 * `stack.info()` reads, since the update already landed in the backend by the
 * time this throw happens.
 */

/**
 * Matches `debuggable.leakedPromises()`'s message format
 * (`node_modules/@pulumi/pulumi/runtime/debuggable.js`) — see this file's
 * top-level TSDoc for the verified source and why matching this message is
 * provably sufficient to identify "succeeded then threw" rather than merely
 * suggestive of it.
 */
const LEAKED_PROMISE_MESSAGE_PATTERN = /The Pulumi runtime detected that \d+ promises? (?:was|were) still active/;

/**
 * True when `err` is the SDK's "leaked promise" throw — see this file's
 * top-level TSDoc for the verified proof that this can only ever be reached
 * after the actual Pulumi operation (`up`/`preview`/`destroy`) itself
 * succeeded.
 */
export function isLeakedPromiseError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return LEAKED_PROMISE_MESSAGE_PATTERN.test(message);
}

/**
 * Runs `operation`, and if it rejects with {@link isLeakedPromiseError},
 * recovers by calling `recoverResult` instead of propagating the rejection —
 * so a genuinely successful Pulumi operation is never reported as a failure
 * merely because the inline program left a dangling promise. Any other
 * rejection (a real operation failure) propagates unchanged.
 *
 * @param operation - The Pulumi SDK call to run (e.g. `() => stack.up(opts)`).
 * @param recoverResult - Builds the result to return in place of the
 *   rejection, given the leak error — see this file's top-level TSDoc,
 *   "Division of responsibility with the caller", for why this needs to
 *   re-read `stack.outputs()`/`stack.info()` rather than reconstruct
 *   anything from the rejected promise itself (there is nothing to
 *   reconstruct from). If `recoverResult` itself throws, that error
 *   propagates instead of the original leak error.
 */
export async function runTreatingLeakedPromiseAsSuccess<T>(
  operation: () => Promise<T>,
  recoverResult: (leakError: Error) => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (err) {
    if (!isLeakedPromiseError(err)) {
      throw err;
    }
    const leakError = err instanceof Error ? err : new Error(String(err));
    // Logged as `message`/`stack` rather than the raw Error object: `Error`'s
    // own properties are non-enumerable, so passing `{ err: leakError }`
    // directly would serialize to `{}` through this logger's
    // `JSON.stringify`-based formatters (both the dev `devPrintf` format and
    // the production `winston.format.json()` format), silently discarding
    // the detail this log line exists to capture.
    logger.warn(
      'Pulumi inline program left a leaked promise after an otherwise successful operation — recovering the ' +
        'result out-of-band rather than reporting a false failure',
      { message: leakError.message, stack: leakError.stack },
    );
    return recoverResult(leakError);
  }
}
