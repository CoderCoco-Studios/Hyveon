import { errMessage } from '@hyveon/shared';
import { logger } from './logger.js';
import type { PulumiService } from './services/PulumiService.js';

/** The slice of Electron's `app` the quit coordinator needs. */
export interface OperationQuitApp {
  on(event: 'before-quit', fn: (e: { preventDefault(): void }) => void): void;
  quit(): void;
  exit(exitCode?: number): void;
}

/** A shutdown step the coordinator runs in parallel with the others; it settles once its resource is released. */
export type QuitStopper = () => Promise<unknown>;

/** Timing knobs for {@link installOperationQuitHook}. */
export interface OperationQuitTimings {
  /** Longest the coordinator waits for every stopper before quitting anyway. */
  boundMs?: number;
  /** How long after `quit()` a still-alive process is force-exited. */
  forceExitMs?: number;
}

/** Longest the quit waits for aborted operations, run records and helpers to wind down. */
export const OPERATION_QUIT_BOUND_MS = 15_000;

/** How long after `quit()` the app force-exits if a wedged handle keeps the process alive. */
export const OPERATION_QUIT_FORCE_EXIT_MS = 10_000;

// @spec IAC-ENGINE-LIFE-009
/**
 * The app's single `before-quit` coordinator. The first `before-quit` is prevented; the running infrastructure
 * operations are aborted and awaited until idle (run record persisted, durable lock released) in parallel with every
 * extra stopper (the file manager helpers), bounded by `boundMs`. Then `quit()` is called once and the follow-up
 * `before-quit` passes through.
 *
 * @remarks
 * Without the prevent, Electron would exit milliseconds after the abort and lose the run record, the apply lock
 * release and any partial-apply steps. After `quit()` an unref'd timer force-exits a process that is still alive after
 * `forceExitMs`. Stopper failures and timeouts are logged and never block the quit.
 *
 * @param app - The Electron app (or a stand-in).
 * @param pulumi - Source of the abort action and the idle signal.
 * @param stoppers - Extra shutdown steps to run alongside the operation wind-down.
 * @param timings - Optional overrides for the wait bound and the force-exit delay.
 */
export function installOperationQuitHook(
  app: OperationQuitApp,
  pulumi: Pick<PulumiService, 'abortInFlightOperations' | 'whenIdle'>,
  stoppers: QuitStopper[] = [],
  timings: OperationQuitTimings = {},
): void {
  const boundMs = timings.boundMs ?? OPERATION_QUIT_BOUND_MS;
  const forceExitMs = timings.forceExitMs ?? OPERATION_QUIT_FORCE_EXIT_MS;
  let shuttingDown = false;
  let released = false;

  app.on('before-quit', (event) => {
    if (released) return;
    event.preventDefault();
    if (shuttingDown) return;
    shuttingDown = true;

    const busy = pulumi.abortInFlightOperations();
    if (busy) logger.warn('Quit: aborting the running infrastructure operation', { boundMs });

    const steps: QuitStopper[] = [() => pulumi.whenIdle(), ...stoppers];
    const settled = Promise.allSettled(
      steps.map((step) =>
        step().catch((err: unknown) => {
          logger.warn('Quit: a shutdown step failed', { error: errMessage(err) });
        }),
      ),
    );
    let timer: NodeJS.Timeout | undefined;
    const bound = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), boundMs);
    });
    void Promise.race([settled.then(() => 'done' as const), bound]).then((outcome) => {
      clearTimeout(timer);
      if (outcome === 'timeout') logger.warn('Quit: shutdown steps timed out, quitting anyway', { boundMs });
      released = true;
      setTimeout(() => app.exit(0), forceExitMs).unref();
      app.quit();
    });
  });
}
