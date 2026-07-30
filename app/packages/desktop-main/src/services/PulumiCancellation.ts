import { logger } from '../logger.js';

/**
 * Reusable cancellation-with-escalation primitive for Task 4.7 of the
 * `migrate-iac-to-pulumi` change, satisfying the `pulumi-engine-runtime`
 * delta spec's "Engine process lifecycle" requirement ("cancellation MUST
 * escalate to a forceful termination after a bounded timeout rather than
 * waiting indefinitely").
 *
 * ## What the SDK actually does on abort (verified from source)
 *
 * `node_modules/@pulumi/pulumi/automation/cmd.js`'s internal `exec()`
 * function (the thing every `stack.preview()`/`.up()`/`.destroy()` call
 * eventually reaches via `PulumiCommand.run()`) wires cancellation like this,
 * verbatim:
 *
 * ```js
 * if (signal) {
 *   signal.addEventListener("abort", () => {
 *     proc.kill("SIGINT", { forceKillAfterTimeout: false });
 *   });
 * }
 * ```
 *
 * This confirms design.md's "Streaming and cancellation" section exactly:
 * exactly one `SIGINT` is sent, `forceKillAfterTimeout` is hard-coded
 * `false`, and there is no second, stronger signal the SDK will ever send on
 * its own. A wedged engine that ignores `SIGINT` (or is stuck in a
 * cloud-provider API call between signal checks) stays alive forever as far
 * as the SDK is concerned.
 *
 * ## No PID, no process handle — verified, not assumed
 *
 * The brief asked whether a stronger signal could be delivered by tracking
 * the child process's PID ourselves. It cannot, at least not through any
 * documented API: `exec()`'s `const proc = execa(...)` is a function-local
 * variable — `PulumiCommand.run()`'s public return type is `Promise<CommandResult>`
 * (`{ stdout, stderr, code }`), and grepping every `.js` file under
 * `automation/` for `.pid` returns zero matches. No `Stack`/`Workspace`
 * method anywhere in the Automation API surface exposes the spawned
 * process, its PID, or any other handle to it. So "forceful termination" at
 * this layer cannot mean "send SIGKILL to the exact process the SDK
 * spawned" — that process is never observable outside `cmd.js`.
 *
 * Given that, what {@link runWithEscalatingCancellation} implements is a
 * **logical** escalation, not a literal SIGKILL: once the bounded escalation
 * window elapses without `operation` settling, this function stops waiting
 * on it and settles its own returned promise as forcefully terminated
 * (rejecting with {@link PulumiOperationEscalatedError}) — satisfying "the
 * app does not wait on it indefinitely" and "the run still settles as
 * aborted either way" without pretending to a kill mechanism the SDK does
 * not expose. The abandoned `operation` promise, if it ever settles in the
 * background, is still awaited internally (so it can never produce an
 * unhandled rejection) but its result is discarded. The optional
 * {@link EscalatingCancellationOptions.onEscalate} hook exists as the
 * extension point for whatever *does* become possible once Phase 7's real
 * call sites exist — e.g. an OS-level "find and kill the one `pulumi` child
 * process this app could possibly have spawned" mechanism, which this task
 * deliberately does not build: it would be untestable in any meaningful way
 * without a real caller to integrate against, and it is inherently
 * platform-specific (POSIX `pgrep -P`/`kill` vs. Windows
 * `taskkill`/WMI) in a way a primitives-only task without a real integration
 * point cannot responsibly commit to. See task-4.7-4.9-report.md for the
 * full discussion.
 *
 * ## A pre-aborted signal must never reach the SDK (verified gotcha)
 *
 * `AbortSignal`'s `addEventListener('abort', ...)` does **not** fire for a
 * listener attached to a signal that is *already* aborted — confirmed
 * directly against this repo's Node runtime:
 *
 * ```js
 * const c = new AbortController();
 * c.abort();
 * c.signal.addEventListener('abort', () => console.log('fired'));
 * // never logs
 * ```
 *
 * Combined with the `cmd.js` snippet above, this means: if a caller passes
 * an *already-aborted* signal straight into `PreviewOptions.signal`/
 * `UpOptions.signal`/`DestroyOptions.signal`, the SDK's own
 * `addEventListener` call is a permanent no-op — the spawned CLI process
 * would never receive `SIGINT` at all and would run to completion entirely
 * ungoverned by the cancellation the caller thought they had already
 * requested. This is a materially more dangerous failure mode than
 * `TerraformService`'s equivalent pre-spawn `if (signal?.aborted)` guard
 * (that guard exists purely to skip an unnecessary spawn; here, skipping it
 * would let a genuinely undesired operation run uninterrupted). This is why
 * {@link runWithEscalatingCancellation} checks `userSignal?.aborted` first
 * and refuses to invoke `operation` at all in that case, mirroring
 * `TerraformService`'s precedent but for a strictly higher-stakes reason.
 */

/**
 * Bounded window a cancelled operation is given to exit gracefully (i.e. to
 * respond to the SDK's own `SIGINT`) before {@link runWithEscalatingCancellation}
 * gives up waiting and escalates. Neither the `pulumi-engine-runtime` delta
 * spec nor design.md names a specific value — design.md only says "a wedged
 * engine would keep the Electron main process alive forever, so we add our
 * own escalation timer" — so this is a deliberately chosen default rather
 * than one derived from the spec.
 *
 * 30 seconds was chosen over a shorter value because a graceful `SIGINT`
 * during a real `up`/`destroy` can legitimately need time to let an
 * in-flight cloud-provider API call (e.g. an ECS `RunTask`/`StopTask` or an
 * S3 multipart upload) return before the CLI can act on the signal — a
 * timeout of a few seconds would routinely escalate healthy, still-working
 * cancellations. 30s was chosen over a longer value (e.g. 60s) so an
 * operator who has already asked to cancel is not left staring at a
 * "cancelling…" state for an excessive stretch when the engine genuinely is
 * wedged. This is a single named constant specifically so it can be tuned
 * later without hunting for a magic number.
 */
export const PULUMI_CANCELLATION_ESCALATION_TIMEOUT_MS = 30_000;

/**
 * Thrown by {@link runWithEscalatingCancellation} when `userSignal` is
 * already `aborted` at call time — see this file's top-level TSDoc for why
 * this must short-circuit before `operation` is ever invoked, rather than
 * invoking it and trusting the SDK's own signal handling to interrupt it.
 */
export class PulumiOperationAbortedError extends Error {
  constructor() {
    super('Pulumi operation was not started: cancellation was already requested before it began.');
    this.name = 'PulumiOperationAbortedError';
  }
}

/**
 * Thrown by {@link runWithEscalatingCancellation} when `operation` does not
 * settle within `escalationTimeoutMs` of `userSignal` aborting. See this
 * file's top-level TSDoc "No PID, no process handle" section for why this
 * represents this layer giving up waiting on the operation (a *logical*
 * forceful termination) rather than a literal `SIGKILL` of the underlying
 * engine process, which the SDK does not expose a way to perform.
 */
export class PulumiOperationEscalatedError extends Error {
  constructor(public readonly escalationTimeoutMs: number) {
    super(
      `Pulumi engine invocation did not exit within the ${escalationTimeoutMs}ms escalation timeout after ` +
        'cancellation was requested; it has been forcefully terminated so the app does not wait on it indefinitely.',
    );
    this.name = 'PulumiOperationEscalatedError';
  }
}

/** Options for {@link runWithEscalatingCancellation}. */
export interface EscalatingCancellationOptions {
  /** Overrides {@link PULUMI_CANCELLATION_ESCALATION_TIMEOUT_MS} — primarily for tests. */
  escalationTimeoutMs?: number;
  /**
   * Invoked synchronously, at most once, the instant the escalation timeout
   * elapses without `operation` having settled — before this function's own
   * returned promise rejects with {@link PulumiOperationEscalatedError}. See
   * this file's top-level TSDoc for why this hook cannot itself deliver a
   * literal `SIGKILL` through anything this module builds — it exists as the
   * extension point for whatever process-level mechanism Phase 7 chooses to
   * add once it has a real call site to integrate against.
   */
  onEscalate?: () => void;
}

/**
 * Runs `operation` with a bounded escalation window layered on top of
 * whatever cancellation behaviour `operation` itself implements in response
 * to `userSignal` aborting.
 *
 * `operation` receives an `AbortSignal` to forward into the SDK call it
 * wraps (e.g. `stack.up({ signal, ... })`) — this is `userSignal` itself
 * when one is supplied (not a derived/wrapped signal), so the SDK's own
 * `addEventListener('abort', ...)` fires at exactly the same moment this
 * function's own abort handling does, with no extra indirection.
 *
 * Behaviour:
 * - If `userSignal` is already `aborted` when this is called, `operation` is
 *   **never invoked** and this rejects immediately with
 *   {@link PulumiOperationAbortedError} — see the file TSDoc's "pre-aborted
 *   signal" section for why.
 * - If `userSignal` is `undefined`, `operation` runs with a signal that will
 *   never abort — no escalation timer is ever armed, since there is nothing
 *   for it to escalate past.
 * - Otherwise, `operation` runs normally until either:
 *   1. It settles (resolves or rejects) on its own — including via the
 *      SDK's own graceful `SIGINT` handling once `userSignal` aborts. This
 *      function's returned promise settles the same way, and the escalation
 *      timer (if armed) is cancelled.
 *   2. `userSignal` aborts and then `escalationTimeoutMs` elapses with
 *      `operation` still pending — `onEscalate` (if supplied) is invoked
 *      once, and this function's returned promise rejects with
 *      {@link PulumiOperationEscalatedError} **without waiting further** for
 *      `operation` to settle. `operation`'s eventual settlement (if any) is
 *      still consumed internally so it can never produce an unhandled
 *      rejection, but its result/error is discarded.
 *
 * @param operation - The cancellable work to run, given a signal to forward
 *   into the underlying SDK call.
 * @param userSignal - The user-facing Cancel signal, or `undefined` if this
 *   operation cannot be cancelled by the caller.
 * @param options - See {@link EscalatingCancellationOptions}.
 */
export function runWithEscalatingCancellation<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  userSignal: AbortSignal | undefined,
  options: EscalatingCancellationOptions = {},
): Promise<T> {
  if (userSignal?.aborted) {
    return Promise.reject(new PulumiOperationAbortedError());
  }

  if (!userSignal) {
    return operation(new AbortController().signal);
  }

  const escalationTimeoutMs = options.escalationTimeoutMs ?? PULUMI_CANCELLATION_ESCALATION_TIMEOUT_MS;

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let escalationTimer: ReturnType<typeof setTimeout> | null = null;

    const onAbort = (): void => {
      escalationTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        userSignal.removeEventListener('abort', onAbort);
        logger.warn('Pulumi engine invocation did not exit within the escalation timeout — force-terminating', {
          escalationTimeoutMs,
        });
        options.onEscalate?.();
        reject(new PulumiOperationEscalatedError(escalationTimeoutMs));
      }, escalationTimeoutMs);
    };
    userSignal.addEventListener('abort', onAbort);

    operation(userSignal).then(
      (value) => {
        if (settled) return;
        settled = true;
        if (escalationTimer) clearTimeout(escalationTimer);
        userSignal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err: unknown) => {
        if (settled) return;
        settled = true;
        if (escalationTimer) clearTimeout(escalationTimer);
        userSignal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}
