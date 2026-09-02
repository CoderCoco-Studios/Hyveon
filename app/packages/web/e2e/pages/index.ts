/**
 * Page objects for the Electron e2e project navigate via a two-step
 * `location.hash` assignment rather than `page.goto()`: the packaged app
 * loads from a `file://` origin, so `page.goto('/route')` never resolves to
 * an in-app route, and the app routes via `HashRouter`, which only
 * re-renders on the native `hashchange` event. Setting `location.hash`
 * directly fires that event — but setting it to its *current* value does
 * not, so each `gotoElectron()`/two-step `goto()` below first resets the
 * hash to `/` (or another route) before setting the real target, guaranteeing
 * a `hashchange` fires even when the target route matches where the app
 * already is.
 */
export { AppLayout } from './AppLayout.js';
export { gotoHashRoute } from './hashRoute.js';
export { DashboardPage, type ServerStateLabel } from './DashboardPage.js';
export { CostsPage } from './CostsPage.js';
export { DiscordPage } from './DiscordPage.js';
export { GuidedIamWizardPage } from './GuidedIamWizardPage.js';
export { LogsPage } from './LogsPage.js';
export { InfrastructureLogsPage } from './InfrastructureLogsPage.js';
export { IacPage } from './IacPage.js';
export { IacHistoryPage } from './IacHistoryPage.js';
export { SettingsPage } from './SettingsPage.js';
export { GamesPage, type DriftLabel } from './GamesPage.js';
export { AuditPage } from './AuditPage.js';
