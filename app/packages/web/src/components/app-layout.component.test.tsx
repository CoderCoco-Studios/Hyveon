import { useEffect } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { AppLayout, LiveIndicator, RefreshAllButton } from './app-layout.component.js';
import { PollingProvider, usePollingActions } from '../polling/polling-provider.component.js';

vi.mock('../api.service.js', () => ({
  api: { env: () => Promise.resolve(null) },
}));

/**
 * Mounts a child component that registers a poller in `useEffect` so the
 * surrounding render captures the resulting registry entry without
 * triggering a setState-during-render warning.
 */
function MountPoller({
  name,
  intervalMs,
  fn,
}: {
  name: string;
  intervalMs: number;
  fn: () => Promise<void>;
}) {
  const { register } = usePollingActions();
  useEffect(() => register(name, fn, intervalMs), [register, name, intervalMs, fn]);
  return null;
}

describe('AppLayout — RefreshAllButton', () => {
  it('should be disabled when the polling registry is empty', () => {
    render(
      <PollingProvider>
        <RefreshAllButton />
      </PollingProvider>,
    );

    expect(screen.getByRole('button', { name: 'Refresh all' })).toBeDisabled();
  });

  it('should fire every registered poller when clicked', async () => {
    const fn = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();

    render(
      <PollingProvider>
        <MountPoller name="status" intervalMs={20_000} fn={fn} />
        <RefreshAllButton />
      </PollingProvider>,
    );

    // Let the registration's automatic first run complete so we can compare.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const before = fn.mock.calls.length;

    await user.click(screen.getByRole('button', { name: 'Refresh all' }));

    await act(async () => {
      await Promise.resolve();
    });
    expect(fn.mock.calls.length).toBeGreaterThan(before);
  });
});

describe('AppLayout — skip link and nav landmarks', () => {
  it('should render a skip-to-main-content link as the first focusable element', () => {
    render(
      <PollingProvider>
        <MemoryRouter>
          <AppLayout>content</AppLayout>
        </MemoryRouter>
      </PollingProvider>,
    );

    const skipLink = screen.getByRole('link', { name: 'Skip to main content' });
    expect(skipLink).toBeInTheDocument();
    expect(skipLink).toHaveAttribute('href', '#main');
  });

  it('should render a Logs group with Games and Infrastructure child links', () => {
    render(
      <PollingProvider>
        <MemoryRouter>
          <AppLayout>content</AppLayout>
        </MemoryRouter>
      </PollingProvider>,
    );
    // Scoped to the Monitoring list: the desktop/mobile drawers both render this
    // heading (only the mobile copy is excluded via aria-hidden), and the
    // Configuration section separately has its own "Infrastructure" link (`/iac`)
    // with the same accessible name, so an unscoped query would match more than
    // one element.
    const monitoring = within(screen.getByRole('list', { name: 'Monitoring' }));
    expect(monitoring.getByText('Logs')).toBeInTheDocument();
    expect(monitoring.getByRole('link', { name: 'Games' })).toHaveAttribute('href', '/logs');
    expect(monitoring.getByRole('link', { name: 'Infrastructure' })).toHaveAttribute('href', '/logs/infrastructure');
  });

  it('should mark only the Games child link active on /logs', () => {
    render(
      <PollingProvider>
        <MemoryRouter initialEntries={['/logs']}>
          <AppLayout>content</AppLayout>
        </MemoryRouter>
      </PollingProvider>,
    );
    const monitoring = within(screen.getByRole('list', { name: 'Monitoring' }));
    expect(monitoring.getByRole('link', { name: 'Games' })).toHaveAttribute('aria-current', 'page');
    expect(monitoring.getByRole('link', { name: 'Infrastructure' })).not.toHaveAttribute('aria-current');
  });

  it('should mark only the Infrastructure child link active on /logs/infrastructure', () => {
    render(
      <PollingProvider>
        <MemoryRouter initialEntries={['/logs/infrastructure']}>
          <AppLayout>content</AppLayout>
        </MemoryRouter>
      </PollingProvider>,
    );
    const monitoring = within(screen.getByRole('list', { name: 'Monitoring' }));
    expect(monitoring.getByRole('link', { name: 'Infrastructure' })).toHaveAttribute('aria-current', 'page');
    expect(monitoring.getByRole('link', { name: 'Games' })).not.toHaveAttribute('aria-current');
  });

  it('should render an Audit nav link and highlight it on /audit', () => {
    render(
      <PollingProvider>
        <MemoryRouter initialEntries={['/audit']}>
          <AppLayout>content</AppLayout>
        </MemoryRouter>
      </PollingProvider>,
    );

    expect(screen.getByRole('link', { name: 'Audit' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Dashboard' })).not.toHaveAttribute('aria-current');
  });

  it('should render a Costs nav entry that links to /costs', () => {
    render(
      <PollingProvider>
        <MemoryRouter>
          <AppLayout>content</AppLayout>
        </MemoryRouter>
      </PollingProvider>,
    );

    expect(screen.getByRole('link', { name: 'Costs' })).toHaveAttribute('href', '/costs');
  });

  it('should highlight the Costs nav link on /costs', () => {
    render(
      <PollingProvider>
        <MemoryRouter initialEntries={['/costs']}>
          <AppLayout>content</AppLayout>
        </MemoryRouter>
      </PollingProvider>,
    );

    expect(screen.getByRole('link', { name: 'Costs' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Dashboard' })).not.toHaveAttribute('aria-current');
  });

  it('should not render any disabled (aria-disabled) nav entries', () => {
    render(
      <PollingProvider>
        <MemoryRouter>
          <AppLayout>content</AppLayout>
        </MemoryRouter>
      </PollingProvider>,
    );

    expect(document.querySelector('[aria-disabled]')).not.toBeInTheDocument();
  });

  it('should not render the Servers, Metrics, or Alerts nav entries', () => {
    render(
      <PollingProvider>
        <MemoryRouter>
          <AppLayout>content</AppLayout>
        </MemoryRouter>
      </PollingProvider>,
    );

    expect(screen.queryByRole('link', { name: 'Servers' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Metrics' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Alerts' })).not.toBeInTheDocument();
  });

  it('should not render the top-bar search input', () => {
    render(
      <PollingProvider>
        <MemoryRouter>
          <AppLayout>content</AppLayout>
        </MemoryRouter>
      </PollingProvider>,
    );

    expect(screen.queryByPlaceholderText(/search/i)).not.toBeInTheDocument();
    expect(document.querySelector('input[type="text"]')).not.toBeInTheDocument();
  });
});

describe('AppLayout — LiveIndicator', () => {
  it('should render the LIVE label element in the DOM regardless of screen size', () => {
    render(
      <PollingProvider>
        <LiveIndicator />
      </PollingProvider>,
    );

    expect(screen.getByText('LIVE')).toBeInTheDocument();
  });

  it('should show a pulsing cyan dot once a registered poller has reported success', async () => {
    const fn = vi.fn().mockResolvedValue(undefined);
    const { container } = render(
      <PollingProvider>
        <MountPoller name="status" intervalMs={20_000} fn={fn} />
        <LiveIndicator />
      </PollingProvider>,
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const dot = container.querySelector('div.rounded-full');
    expect(dot?.className).toMatch(/animate-pulse/);
    expect(dot?.className).toMatch(/var\(--color-cyan\)/);
  });
});

describe('AppLayout — mobile navigation', () => {
  it('should render a hamburger button that opens the mobile nav', async () => {
    const user = userEvent.setup();
    render(
      <PollingProvider>
        <MemoryRouter>
          <AppLayout>content</AppLayout>
        </MemoryRouter>
      </PollingProvider>,
    );
    const hamburger = screen.getByRole('button', { name: 'Open navigation' });
    expect(hamburger).toBeInTheDocument();
    await user.click(hamburger);
    expect(screen.getByRole('button', { name: 'Close navigation' })).toBeInTheDocument();
  });

  it('should close the mobile nav when the close button is clicked', async () => {
    const user = userEvent.setup();
    render(
      <PollingProvider>
        <MemoryRouter>
          <AppLayout>content</AppLayout>
        </MemoryRouter>
      </PollingProvider>,
    );
    await user.click(screen.getByRole('button', { name: 'Open navigation' }));
    await user.click(screen.getByRole('button', { name: 'Close navigation' }));
    expect(screen.queryByRole('button', { name: 'Close navigation' })).not.toBeInTheDocument();
  });

  it('should close the mobile nav when a nav link is clicked', async () => {
    const user = userEvent.setup();
    render(
      <PollingProvider>
        <MemoryRouter initialEntries={['/']}>
          <AppLayout>content</AppLayout>
        </MemoryRouter>
      </PollingProvider>,
    );
    await user.click(screen.getByRole('button', { name: 'Open navigation' }));
    // Scoped to the mobile drawer's Monitoring list: the Configuration section
    // separately has its own "Games" link (`/games`) with the same accessible
    // name as the new Logs-group child, so an unscoped query would be ambiguous.
    const mobileMonitoring = within(within(document.getElementById('mobile-nav')!).getByRole('list', { name: 'Monitoring' }));
    await user.click(mobileMonitoring.getByRole('link', { name: 'Games' }));
    expect(screen.queryByRole('button', { name: 'Close navigation' })).not.toBeInTheDocument();
  });
});
