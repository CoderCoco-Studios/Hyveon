import { logger } from '../logger.js';

/**
 * Task 4.9's leaked-promise-handling primitive, satisfying design.md's Risks
 * section: "If the inline program leaves dangling promises, `onPulumiExit`
 * throws *after* an otherwise successful operation. Handle 'succeeded then
 * threw' so a successful apply is not reported as a failure."
 *
 * ## Verified from source: exactly where and why this throw happens
 *
 * `node_modules/@pulumi/pulumi/automation/server.js`'s `LanguageServer.onPulumiExit`:
 *
 * ```js
 * onPulumiExit(hasError) {
 *     // Check for leaks once the CLI exits but skip if the program otherwise
 *     // errored to keep error output clean
 *     if (!hasError) {
 *         const [leaks, leakMessage] = debuggable.leakedPromises();
 *         if (leaks.size !== 0) {
 *             throw new Error(leakMessage);
 *         }
 *     }
 * }
 * ```
 *
 * and `stack.js`'s `up()` (`preview()`/`destroy()` are structured
 * identically — same `onExit`/`try`/`finally` shape, confirmed by reading
 * all six `onPulumiExit` call sites in that file):
 *
 * ```js
 * let upResult;
 * try {
 *     upResult = await this.runPulumiCmd(args, opts?.onOutput, opts?.onError, opts?.signal);
 * } catch (e) {
 *     didError = true;
 *     throw e;
 * } finally {
 *     onExit(didError);  // -> languageServer.onPulumiExit(didError)
 *     await cleanUp(logFile, await logPromise, eventsServer);
 * }
 * // outputs()/info()/return only reached if the `finally` block above didn't throw
 * ```
 *
 * JavaScript's `try`/`catch`/`finally` semantics mean a throw *inside*
 * `finally` replaces whatever the `try`/`catch` block was about to do — so
 * when `runPulumiCmd` succeeds (`didError` stays `false`), `onPulumiExit(false)`
 * runs the leak check, and if it throws, that exception **replaces the
 * successful return** even though `upResult` (the actual CLI operation's
 * result) was already obtained. The caller's `stack.up()`/`.preview()`/`.destroy()`
 * promise rejects with a bare `new Error(leakMessage)`, and `outputs()`/`info()`
 * (lines after the `finally` block) are never reached — the summary/outputs
 * data is genuinely unavailable from that same call, not merely inconvenient
 * to extract.
 *
 * ## Why message-pattern matching is provably sufficient (not just best-effort)
 *
 * `onPulumiExit`'s leak check is *only ever reached* when `hasError` is
 * `false` — i.e. only on the branch where `runPulumiCmd` itself succeeded.
 * When `runPulumiCmd` throws (a genuine CLI failure), `didError` is set
 * `true` *before* `finally` runs, so `onPulumiExit(true)` skips the leak
 * check entirely (`if (!hasError)`) and never throws for that reason. These
 * two throw paths are therefore mutually exclusive by construction of the
 * SDK's own control flow: **any** error caught from `stack.up()`/`.preview()`/
 * `.destroy()` whose message matches `debuggable.leakedPromises()`'s format
 * (`node_modules/@pulumi/pulumi/runtime/debuggable.js` — a message starting
 * "The Pulumi runtime detected that N promise(s) was/were still active...")
 * is, by that same construction, proof the actual CLI operation succeeded —
 * no separate CLI-exit-code tracking is needed to corroborate it.
 *
 * ## Verified: recovering "success" this way still leaks gRPC servers and a temp log file
 *
 * A review of this task's first draft caught that its own quoted source
 * already proved a further, unaddressed consequence. Re-reading `stack.js`'s
 * `up()` (lines ~276-279 for `onExit`'s definition, ~303-306 for the
 * `finally` block that calls it) closely: `onExit` itself is
 *
 * ```js
 * onExit = (hasError) => {
 *     languageServer.onPulumiExit(hasError);  // <- can throw (the leak check)
 *     server.forceShutdown();                 // <- never reached if the line above throws
 * };
 * ```
 *
 * and the `finally` block that calls it is
 *
 * ```js
 * finally {
 *     onExit(didError);
 *     await cleanUp(logFile, await logPromise, eventsServer);  // <- never reached either
 * }
 * ```
 *
 * A throw partway through a `finally` block aborts the *rest of that same
 * `finally` block*, not just the `try`'s outcome. So when the leak check
 * throws: `server.forceShutdown()` — which would have torn down the
 * inline-program language-server gRPC server bound to `127.0.0.1:<port>` —
 * **never runs**, and neither does `cleanUp(logFile, ..., eventsServer)`,
 * which would have closed the event-log gRPC server (when `onEvent` was
 * used) and deleted the temp log file. All three resources are left
 * dangling for the lifetime of the Electron process. Converting this
 * rejection into a reported success (via
 * {@link runTreatingLeakedPromiseAsSuccess}) makes the leak *silent* on top
 * of that — the operation is recorded as having succeeded, so nothing
 * downstream has any reason to notice a server or file was left behind.
 *
 * This directly contradicts design.md's Risks section claim ("every gRPC
 * server and temp resource is torn down in a `finally`") for this one
 * specific path — that claim is true for every *other* exit from `up`/
 * `preview`/`destroy` (a genuine failure, or a genuine success with no
 * leaked promise), just not this one, and design.md has been corrected to
 * say so. This is the same class of failure as the `@cdktf/hcl2json`
 * quit-hang incident this repo has already been burned by once. Nothing in
 * this module can fix it — `server`, `eventsServer`, and `logFile` are
 * local variables entirely inside `stack.js`, never exposed to any caller —
 * so the mitigation is process-level, not code-level: **Phase 7/11's "app
 * quits cleanly after an operation" e2e check must specifically include a
 * run that exercises this leaked-promise-recovery path** (an inline program
 * that deliberately leaves a dangling promise), not only the ordinary
 * happy-path `up`/`destroy`, since the happy path alone cannot catch this.
 *
 * ## What this task could and could not complete
 *
 * {@link isLeakedPromiseError} (the classifier) and
 * {@link runTreatingLeakedPromiseAsSuccess} (the generic recovery wrapper)
 * are complete and tested now — they depend on nothing from Phase 7.
 * What they cannot do yet: actually reconstruct the lost `UpResult`/
 * `PreviewResult`/`DestroyResult` (outputs, summary, stdout/stderr) once the
 * SDK's promise has rejected this way, since that data was never returned
 * to any caller in the first place — it's local to the now-unwinding
 * `stack.up()` call inside the SDK, not something this module or Phase 7 can
 * reach after it has already thrown. Phase 7's `PulumiService.preview`/`.up`/`.destroy`
 * must supply `recoverResult` — most plausibly by calling `stack.outputs()`
 * and `stack.info()` again as fresh, independent read-only calls (these
 * don't re-run the operation, they just read current stack state) to
 * reconstruct a synthetic success result, since the update itself already
 * landed in the backend by the time this throw happens.
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
 *   rejection, given the leak error — see this file's top-level TSDoc for
 *   why Phase 7 will need this to re-read `stack.outputs()`/`stack.info()`
 *   rather than reconstruct anything from the rejected promise itself (there
 *   is nothing to reconstruct from). If `recoverResult` itself throws, that
 *   error propagates instead of the original leak error.
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
