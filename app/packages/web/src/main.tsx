import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './app.component.js';
import { ErrorBoundary } from './components/error-boundary.component.js';
import { installConsoleForwarding, installGlobalErrorReporting } from './lib/report-renderer-error.utils.js';
import './index.css';

installGlobalErrorReporting();
installConsoleForwarding();
createRoot(document.getElementById('root')!, {
  // ErrorBoundary.componentDidCatch already forwards render crashes (with
  // message, stack, and component stack) via reportRendererError. React's
  // default onCaughtError also calls console.error for the same error,
  // which installConsoleForwarding would otherwise re-capture and log a
  // second time — suppress that duplicate.
  onCaughtError: () => undefined,
}).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
