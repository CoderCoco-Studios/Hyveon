/**
 * Sleeps for `ms` milliseconds, rejecting with an `AbortError` as soon as `signal` aborts so a poll loop exits promptly
 * instead of waiting out a full cadence.
 *
 * @param ms - Milliseconds to sleep for.
 * @param signal - Aborting this signal cancels the sleep.
 * @throws DOMException — `AbortError`, when `signal` is (or becomes) aborted.
 */
export function sleepInterruptible(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
