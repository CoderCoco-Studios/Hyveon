/**
 * Best-effort forward of a renderer-side error to the main process log.
 * Swallows its own failure (e.g. no `window.hyveon` bridge in a plain
 * browser/test context) — a broken reporting path must never throw on top
 * of the error it was trying to report.
 *
 * @param message - `Error.message`, or a string coercion for non-Error rejections.
 * @param stack - `Error.stack`, when available.
 * @param source - Where the report originated.
 */
export function reportRendererError(
  message: string,
  stack: string | undefined,
  source: 'boundary' | 'window-error' | 'unhandled-rejection',
): void {
  if (typeof window.hyveon?.diagnostics?.reportError !== 'function') {
    return;
  }
  void window.hyveon.diagnostics.reportError(message, stack, source)?.catch(() => undefined);
}

/**
 * Installs `window.onerror`/`unhandledrejection` listeners that forward to
 * {@link reportRendererError}. Call once, before `createRoot(...).render(...)`.
 */
export function installGlobalErrorReporting(): void {
  window.addEventListener('error', (evt) => {
    reportRendererError(evt.message, evt.error?.stack, 'window-error');
  });
  window.addEventListener('unhandledrejection', (evt) => {
    const reason = evt.reason as unknown;
    const message = reason instanceof Error ? reason.message : String(reason);
    reportRendererError(message, reason instanceof Error ? reason.stack : undefined, 'unhandled-rejection');
  });
}
