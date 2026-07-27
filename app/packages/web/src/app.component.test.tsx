import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

/**
 * The routed shell and the wizard are both stubbed: this spec is about the
 * first-run gate in `App`/`useWizardCompleted`, not about what either branch
 * renders. Stubbing them also keeps the test off the real router, polling
 * providers and API client, none of which the gate depends on.
 */
vi.mock('./components/app-layout.component.js', () => ({
  AppLayout: ({ children }: { children: React.ReactNode }) => <div data-testid="app-shell">{children}</div>,
}));
vi.mock('./components/first-run-wizard/first-run-wizard.component.js', () => ({
  FirstRunWizard: ({ onComplete }: { onComplete: () => void }) => (
    <button type="button" data-testid="wizard" onClick={onComplete}>
      wizard
    </button>
  ),
}));
vi.mock('./polling/polling-provider.component.js', () => ({
  PollingProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('./polling/game-status-provider.component.js', () => ({
  GameStatusProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('./components/ui/sonner.component.js', () => ({ Toaster: () => null }));
vi.mock('./pages/dashboard.page.js', () => ({ DashboardPage: () => <div>dashboard</div> }));
vi.mock('./pages/costs.page.js', () => ({ CostsPage: () => null }));
vi.mock('./pages/discord.page.js', () => ({ DiscordPage: () => null }));
vi.mock('./pages/logs.page.js', () => ({ LogsPage: () => null }));
vi.mock('./pages/terraform.page.js', () => ({ TerraformPage: () => null }));
vi.mock('./pages/terraform-history.page.js', () => ({ TerraformHistoryPage: () => null }));
vi.mock('./pages/terraform-run-detail.page.js', () => ({ TerraformRunDetailPage: () => null }));
vi.mock('./pages/settings.page.js', () => ({ SettingsPage: () => null }));
vi.mock('./pages/games.page.js', () => ({ GamesPage: () => null }));
vi.mock('./pages/game-detail.page.js', () => ({ GameDetailPage: () => null }));
vi.mock('./pages/audit.page.js', () => ({ AuditPage: () => null }));

import App from './app.component.js';

/**
 * Install a `window.hyveon` stub whose `wizard.getState` behaves as `getState`
 * describes. Pass `null` to simulate no bridge at all, or an object without a
 * `wizard` key to simulate a bridge predating the wizard namespace.
 */
function stubBridge(bridge: unknown): void {
  vi.stubGlobal('hyveon', bridge);
}

describe('App first-run gate', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('should render the routed shell without waiting when there is no IPC bridge', () => {
    stubBridge(undefined);

    render(<App />);

    expect(screen.getByTestId('app-shell')).toBeInTheDocument();
    expect(screen.queryByTestId('wizard')).not.toBeInTheDocument();
  });

  it('should render the routed shell when the bridge predates the wizard namespace', () => {
    // A stub bridge with no `.wizard` key must not throw, and must not stall
    // the gate at its in-flight state.
    stubBridge({ games: {} });

    render(<App />);

    expect(screen.getByTestId('app-shell')).toBeInTheDocument();
  });

  it('should render nothing while the wizard state check is in flight', () => {
    stubBridge({ wizard: { getState: vi.fn(() => new Promise(() => undefined)) } });

    const { container } = render(<App />);

    expect(container).toBeEmptyDOMElement();
  });

  it('should render the routed shell once the wizard reports it is already complete', async () => {
    stubBridge({ wizard: { getState: vi.fn().mockResolvedValue({ wizardCompleted: true }) } });

    render(<App />);

    expect(await screen.findByTestId('app-shell')).toBeInTheDocument();
  });

  it('should render the wizard when the wizard reports it has not been completed', async () => {
    stubBridge({ wizard: { getState: vi.fn().mockResolvedValue({ wizardCompleted: false }) } });

    render(<App />);

    expect(await screen.findByTestId('wizard')).toBeInTheDocument();
    expect(screen.queryByTestId('app-shell')).not.toBeInTheDocument();
  });

  it('should fall back to the routed shell when the wizard state check rejects', async () => {
    // Fail-open: a broken IPC call must never lock an otherwise-working
    // install out of its own dashboard.
    stubBridge({ wizard: { getState: vi.fn().mockRejectedValue(new Error('ipc down')) } });

    render(<App />);

    expect(await screen.findByTestId('app-shell')).toBeInTheDocument();
  });

  it('should switch straight to the routed shell when the wizard signals completion', async () => {
    stubBridge({ wizard: { getState: vi.fn().mockResolvedValue({ wizardCompleted: false }) } });

    render(<App />);
    await userEvent.click(await screen.findByTestId('wizard'));

    await waitFor(() => expect(screen.getByTestId('app-shell')).toBeInTheDocument());
    expect(screen.queryByTestId('wizard')).not.toBeInTheDocument();
  });
});
