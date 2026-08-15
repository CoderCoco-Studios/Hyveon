/**
 * Result shape for the `diagnostics.exportBundle` IPC channel — the
 * discriminant `DiagnosticsPanel` (`@hyveon/web`) switches on. Lives here,
 * not duplicated per-package, so `desktop-main`'s controller,
 * `desktop-preload`'s bridge, and `@hyveon/web`'s API layer share one
 * definition instead of three independently-maintained copies.
 */
export type ExportDiagnosticsBundleResult =
  | { status: 'written'; path: string }
  | { status: 'cancelled' }
  | { status: 'error'; message: string };
