import { Component, type ErrorInfo, type ReactNode } from 'react';
import { errMessage } from '@hyveon/shared';
import { reportRendererError } from '../lib/report-renderer-error.utils.js';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
}

// @spec APP-DIAG-RERR-003, APP-DIAG-RERR-006, APP-DIAG-RERR-007
/**
 * Top-level render-error boundary. Renders a visible fallback instead of
 * silently unmounting the tree (React 18's default with no boundary), and
 * forwards the crash to the main-process log via `componentDidCatch` — the
 * `window.onerror`/`unhandledrejection` listeners installed in `main.tsx`
 * do NOT see errors React's own render try/catch already swallowed, so this
 * is the only path that logs an in-render crash.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  /**
   * React lifecycle hook invoked after a descendant throws during render.
   * Flags the boundary so the next render shows the fallback UI. Tracks a boolean rather than the thrown value,
   * because a descendant can `throw` a falsy value (`0`, `''`, `null`).
   *
   * @returns The updated state.
   */
  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  /**
   * React lifecycle hook invoked after a descendant throws during render.
   * Forwards the crash to the main-process log.
   *
   * @param error - The value thrown by a descendant component. React does not
   * guarantee this is an `Error` — a descendant can `throw` any value.
   * @param info - React-supplied details, including the component stack.
   */
  componentDidCatch(error: unknown, info: ErrorInfo): void {
    const message = errMessage(error);
    const stack = error instanceof Error ? error.stack : undefined;
    const combinedStack = [stack, info.componentStack]
      .filter((part): part is string => Boolean(part))
      .join('\n\nComponent stack:');
    reportRendererError(message, combinedStack || undefined, 'boundary');
  }

  /** Renders the fallback UI when a descendant has thrown, otherwise the children. */
  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div role="alert" className="flex h-screen items-center justify-center p-8 text-center">
          <div className="max-w-md space-y-2">
            <h1 className="text-lg font-semibold text-[var(--color-foreground)]">Something went wrong</h1>
            <p className="text-sm text-[var(--color-muted-foreground)]">
              Hyveon hit an unexpected error and can&apos;t continue. Check Settings → Diagnostics, or restart the app.
            </p>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
