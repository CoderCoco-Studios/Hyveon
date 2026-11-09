import { useEffect } from 'react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { AppLayout, LiveIndicator, RefreshAllButton } from './app-layout.component.js';
import { PollingProvider, usePollingActions } from '../polling/polling-provider.component.js';

const { envMock } = vi.hoisted(() => ({ envMock: vi.fn() }));

vi.mock('../api.service.js', () => ({
  api: { env: envMock },
}));

beforeEach(() => {
  envMock.mockReset();
  envMock.mockResolvedValue(null);
});

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

// @spec APP-SHELL-TOP-003
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

  // @spec APP-LOGS-NAV-001, APP-LOGS-NAV-002
  // @spec APP-SHELL-NAV-005
  it('should render a Logs group with Game Logs and Infra Logs child links', () => {
    render(
      <PollingProvider>
        <MemoryRouter>
          <AppLayout>content</AppLayout>
        </MemoryRouter>
      </PollingProvider>,
    );
    // `getByText` (unlike `getByRole`) doesn't respect `aria-hidden`, so the
    // "Logs" group heading — rendered by both the desktop sidebar and the
    // (aria-hidden, closed) mobile drawer — must be scoped to the visible
    // Monitoring list to avoid matching both copies.
    const monitoring = within(screen.getByRole('list', { name: 'Monitoring' }));
    expect(monitoring.getByText('Logs')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Game Logs' })).toHaveAttribute('href', '/logs');
    expect(screen.getByRole('link', { name: 'Infra Logs' })).toHaveAttribute('href', '/logs/infrastructure');
  });

  // @spec APP-LOGS-NAV-003
  // @spec APP-SHELL-NAV-006
  it('should mark only the Game Logs child link active on /logs', () => {
    render(
      <PollingProvider>
        <MemoryRouter initialEntries={['/logs']}>
          <AppLayout>content</AppLayout>
        </MemoryRouter>
      </PollingProvider>,
    );
    expect(screen.getByRole('link', { name: 'Game Logs' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Infra Logs' })).not.toHaveAttribute('aria-current');
  });

  // @spec APP-LOGS-NAV-003
  // @spec APP-SHELL-NAV-006
  it('should mark only the Infra Logs child link active on /logs/infrastructure', () => {
    render(
      <PollingProvider>
        <MemoryRouter initialEntries={['/logs/infrastructure']}>
          <AppLayout>content</AppLayout>
        </MemoryRouter>
      </PollingProvider>,
    );
    expect(screen.getByRole('link', { name: 'Infra Logs' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Game Logs' })).not.toHaveAttribute('aria-current');
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

  // @spec APP-SHELL-NAV-004
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

  // @spec APP-SHELL-UI-001
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

  // @spec APP-SHELL-UI-001
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

  // @spec APP-SHELL-UI-002
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

// @spec APP-SHELL-TOP-004
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
  // @spec APP-SHELL-NAV-007
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

  // @spec APP-SHELL-NAV-008
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
    // Scoped to the mobile drawer's Monitoring list: with the drawer open, both
    // the desktop sidebar and the mobile drawer render a "Monitoring" list (and
    // its "Game Logs" child) in the accessible tree at once, so an unscoped
    // query would match more than one element.
    const mobileMonitoring = within(within(document.getElementById('mobile-nav')!).getByRole('list', { name: 'Monitoring' }));
    await user.click(mobileMonitoring.getByRole('link', { name: 'Game Logs' }));
    expect(screen.queryByRole('button', { name: 'Close navigation' })).not.toBeInTheDocument();
  });
});

/**
 * jsdom CSS shim for `-webkit-app-region`, installed once for every test in
 * this file.
 *
 * @remarks
 * jsdom has no IDL binding for `-webkit-app-region` — it's an
 * Electron/Chromium-only CSS property, not part of the standard set jsdom's
 * `CSSStyleDeclaration` recognizes. React sets non-custom style properties via
 * plain assignment (`style.WebkitAppRegion = value`); on real Chromium that
 * reaches the underlying CSSOM store because Chromium implements an IDL
 * accessor for it, but under jsdom it just becomes an inert own property that
 * `getPropertyValue('-webkit-app-region')` never sees. Patches the two
 * together for this one property so the assertions below observe what
 * Electron's Chromium renderer would actually do.
 */
/** Backing store for the `WebkitAppRegion` getter/setter patched onto `CSSStyleDeclaration.prototype` below. */
const webkitAppRegionStore = new WeakMap<CSSStyleDeclaration, string>();
Object.defineProperty(CSSStyleDeclaration.prototype, 'WebkitAppRegion', {
  configurable: true,
  get(this: CSSStyleDeclaration) {
    return webkitAppRegionStore.get(this) ?? '';
  },
  set(this: CSSStyleDeclaration, value: string) {
    webkitAppRegionStore.set(this, value);
  },
});
const originalGetPropertyValue = CSSStyleDeclaration.prototype.getPropertyValue;
CSSStyleDeclaration.prototype.getPropertyValue = function (this: CSSStyleDeclaration, property: string) {
  if (property === '-webkit-app-region') {
    return webkitAppRegionStore.get(this) ?? '';
  }
  return originalGetPropertyValue.call(this, property);
};

describe('AppLayout — window chrome (custom title bar)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // @spec APP-SHELL-CHROME-013
  it('should not add drag-region styling or render window controls when window.hyveon is absent', () => {
    vi.unstubAllGlobals();
    render(
      <PollingProvider>
        <MemoryRouter>
          <AppLayout>content</AppLayout>
        </MemoryRouter>
      </PollingProvider>,
    );

    const header = screen.getByRole('banner');
    expect(header.style.getPropertyValue('-webkit-app-region')).not.toBe('drag');
    expect(screen.queryByRole('button', { name: 'Minimize' })).not.toBeInTheDocument();
  });

  // @spec APP-SHELL-CHROME-002
  it('should mark the header as a drag region when window.hyveon.window is present', () => {
    vi.stubGlobal('hyveon', {
      window: {
        platform: 'linux',
      },
    });

    render(
      <PollingProvider>
        <MemoryRouter>
          <AppLayout>content</AppLayout>
        </MemoryRouter>
      </PollingProvider>,
    );

    const header = screen.getByRole('banner');
    expect(header.style.getPropertyValue('-webkit-app-region')).toBe('drag');
  });

  // @spec APP-SHELL-CHROME-003
  it('should mark every interactive header child as no-drag', () => {
    vi.stubGlobal('hyveon', {
      window: {
        platform: 'linux',
      },
    });

    render(
      <PollingProvider>
        <MemoryRouter>
          <AppLayout>content</AppLayout>
        </MemoryRouter>
      </PollingProvider>,
    );

    const refreshButton = screen.getByRole('button', { name: 'Refresh all' });
    expect(refreshButton.style.getPropertyValue('-webkit-app-region')).toBe('no-drag');
  });

  // @spec APP-SHELL-CHROME-012
  it('should not render any app-drawn window-control buttons when platform is linux', () => {
    vi.stubGlobal('hyveon', {
      window: {
        platform: 'linux',
      },
    });

    render(
      <PollingProvider>
        <MemoryRouter>
          <AppLayout>content</AppLayout>
        </MemoryRouter>
      </PollingProvider>,
    );

    for (const name of ['Minimize', 'Maximize', 'Restore', 'Close']) {
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    }
  });

  // @spec APP-SHELL-CHROME-005
  it('should not render any window-control buttons when platform is darwin', () => {
    vi.stubGlobal('hyveon', {
      window: {
        platform: 'darwin',
      },
    });

    render(
      <PollingProvider>
        <MemoryRouter>
          <AppLayout>content</AppLayout>
        </MemoryRouter>
      </PollingProvider>,
    );

    expect(screen.queryByRole('button', { name: 'Minimize' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Close' })).not.toBeInTheDocument();
  });

  // @spec APP-SHELL-CHROME-008
  it('should not render any window-control buttons when platform is win32', () => {
    vi.stubGlobal('hyveon', {
      window: {
        platform: 'win32',
      },
    });

    render(
      <PollingProvider>
        <MemoryRouter>
          <AppLayout>content</AppLayout>
        </MemoryRouter>
      </PollingProvider>,
    );

    expect(screen.queryByRole('button', { name: 'Minimize' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Close' })).not.toBeInTheDocument();
  });

  // @spec APP-SHELL-CHROME-009, APP-SHELL-CHROME-012
  it.each(['win32', 'linux'])('should reserve space for the titleBarOverlay in the header trailing group on %s', (platform) => {
    vi.stubGlobal('hyveon', {
      window: {
        platform,
      },
    });

    render(
      <PollingProvider>
        <MemoryRouter>
          <AppLayout>content</AppLayout>
        </MemoryRouter>
      </PollingProvider>,
    );

    const header = screen.getByRole('banner');
    const trailingGroup = header.querySelector('[data-titlebar-overlay-spacer]');
    expect(trailingGroup).not.toBeNull();
    // jsdom's CSS parser (cssstyle) re-serializes calc()/env() nesting in a
    // different token order than authored, so assert on the substrings that
    // survive re-serialization rather than the literal `env(titlebar-area-width`
    // call syntax.
    const style = trailingGroup?.getAttribute('style') ?? '';
    expect(style).toContain('titlebar-area-width');
    expect(style).toContain('calc(');
    // Pins the formula's *base* to the viewport (100vw), not the spacer's own
    // containing block (100%) — the bug this test guards against: env(...) is
    // an absolute length, so subtracting it from 100% of a few-hundred-px-wide
    // flex group always resolves negative and clamps to 0px, reserving nothing.
    expect(style).toContain('100vw');
    expect(style).not.toMatch(/calc\(\s*100%/);
    expect(trailingGroup).toHaveStyle({ flexShrink: '0' });
  });

  it('should NOT reserve space for the titleBarOverlay on darwin', () => {
    vi.stubGlobal('hyveon', {
      window: {
        platform: 'darwin',
      },
    });

    render(
      <PollingProvider>
        <MemoryRouter>
          <AppLayout>content</AppLayout>
        </MemoryRouter>
      </PollingProvider>,
    );

    const header = screen.getByRole('banner');
    expect(header.querySelector('[data-titlebar-overlay-spacer]')).toBeNull();
  });

  // @spec APP-SHELL-CHROME-007
  it('should reserve leading space in the header for the macOS traffic lights on darwin', () => {
    vi.stubGlobal('hyveon', {
      window: {
        platform: 'darwin',
      },
    });

    render(
      <PollingProvider>
        <MemoryRouter>
          <AppLayout>content</AppLayout>
        </MemoryRouter>
      </PollingProvider>,
    );

    const header = screen.getByRole('banner');
    const spacer = header.querySelector('[data-traffic-light-spacer]');
    expect(spacer).not.toBeNull();
  });

  it('should NOT reserve leading space for macOS traffic lights on win32, linux, or when window.hyveon is absent', () => {
    vi.stubGlobal('hyveon', {
      window: {
        platform: 'win32',
      },
    });

    const { rerender } = render(
      <PollingProvider>
        <MemoryRouter>
          <AppLayout>content</AppLayout>
        </MemoryRouter>
      </PollingProvider>,
    );

    let header = screen.getByRole('banner');
    expect(header.querySelector('[data-traffic-light-spacer]')).toBeNull();

    vi.stubGlobal('hyveon', {
      window: {
        platform: 'linux',
      },
    });
    rerender(
      <PollingProvider>
        <MemoryRouter>
          <AppLayout>content</AppLayout>
        </MemoryRouter>
      </PollingProvider>,
    );
    header = screen.getByRole('banner');
    expect(header.querySelector('[data-traffic-light-spacer]')).toBeNull();

    vi.unstubAllGlobals();
    rerender(
      <PollingProvider>
        <MemoryRouter>
          <AppLayout>content</AppLayout>
        </MemoryRouter>
      </PollingProvider>,
    );
    header = screen.getByRole('banner');
    expect(header.querySelector('[data-traffic-light-spacer]')).toBeNull();
  });

  // @spec APP-SHELL-CHROME-004
  it('should mark the sidebar brand block as a drag region on darwin when window.hyveon.window is present', () => {
    vi.stubGlobal('hyveon', {
      window: {
        platform: 'darwin',
      },
    });

    render(
      <PollingProvider>
        <MemoryRouter>
          <AppLayout>content</AppLayout>
        </MemoryRouter>
      </PollingProvider>,
    );

    const brandBlock = screen.getByTestId('sidebar-brand-block');
    expect(brandBlock.style.getPropertyValue('-webkit-app-region')).toBe('drag');
  });

  it('should NOT mark the sidebar brand block as a drag region on win32', () => {
    vi.stubGlobal('hyveon', {
      window: {
        platform: 'win32',
      },
    });

    render(
      <PollingProvider>
        <MemoryRouter>
          <AppLayout>content</AppLayout>
        </MemoryRouter>
      </PollingProvider>,
    );

    const brandBlock = screen.getByTestId('sidebar-brand-block');
    expect(brandBlock.style.getPropertyValue('-webkit-app-region')).not.toBe('drag');
  });

  it('should NOT mark the sidebar brand block as a drag region on linux', () => {
    vi.stubGlobal('hyveon', {
      window: {
        platform: 'linux',
      },
    });

    render(
      <PollingProvider>
        <MemoryRouter>
          <AppLayout>content</AppLayout>
        </MemoryRouter>
      </PollingProvider>,
    );

    const brandBlock = screen.getByTestId('sidebar-brand-block');
    expect(brandBlock.style.getPropertyValue('-webkit-app-region')).not.toBe('drag');
  });

  it('should NOT mark the sidebar brand block as a drag region when window.hyveon is absent', () => {
    vi.unstubAllGlobals();
    render(
      <PollingProvider>
        <MemoryRouter>
          <AppLayout>content</AppLayout>
        </MemoryRouter>
      </PollingProvider>,
    );

    const brandBlock = screen.getByTestId('sidebar-brand-block');
    expect(brandBlock.style.getPropertyValue('-webkit-app-region')).not.toBe('drag');
  });
});

describe('AppLayout — shell chrome behaviour gaps', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** Renders the layout inside the providers it needs. */
  function renderLayout(): void {
    render(
      <PollingProvider>
        <MemoryRouter>
          <AppLayout>content</AppLayout>
        </MemoryRouter>
      </PollingProvider>,
    );
  }

  // @spec APP-SHELL-CHROME-014
  it('should apply no -webkit-app-region style to any element outside Electron', () => {
    vi.unstubAllGlobals();

    renderLayout();

    const withRegion = Array.from(document.body.querySelectorAll<HTMLElement>('*')).filter(
      (el) => el.style.getPropertyValue('-webkit-app-region') !== '',
    );
    expect(withRegion).toEqual([]);
  });

  // @spec APP-SHELL-CHROME-014
  it('should keep the skip link no-drag inside Electron', () => {
    vi.stubGlobal('hyveon', { window: { platform: 'darwin' } });

    renderLayout();

    const skipLink = screen.getByRole('link', { name: 'Skip to main content' });
    expect(skipLink.style.getPropertyValue('-webkit-app-region')).toBe('no-drag');
  });

  // @spec APP-SHELL-NAV-009
  it('should show the product name Hyveon in the sidebar brand block, the drawer header and the top bar', () => {
    renderLayout();

    expect(within(screen.getByTestId('sidebar-brand-block')).getByText('Hyveon')).toBeInTheDocument();
    expect(within(document.getElementById('mobile-nav')!).getByText('Hyveon')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Hyveon' })).toBeInTheDocument();
    expect(screen.queryByText('Game Servers')).not.toBeInTheDocument();
  });

  // @spec APP-SHELL-TOP-001
  it('should show the environment and region in the env pill once env resolves', async () => {
    envMock.mockResolvedValue({ environment: 'prod', region: 'us-east-1' });

    renderLayout();

    expect(await screen.findByText('prod · us-east-1')).toBeInTheDocument();
  });

  // @spec APP-SHELL-TOP-002
  it('should show a failure state in the env pill, distinct from local, when the env call rejects', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    envMock.mockRejectedValue(new Error('ipc down'));

    renderLayout();

    const pill = await screen.findByText('env unavailable');
    expect(pill).toBeInTheDocument();
    expect(pill).toHaveAttribute('title', expect.stringContaining('ipc down'));
    expect(screen.queryByText('local')).not.toBeInTheDocument();
  });

  // @spec APP-SHELL-TOP-002
  it('should keep reading local while the env call is still in flight', () => {
    envMock.mockReturnValue(new Promise(() => undefined));

    renderLayout();

    expect(screen.getByText('local')).toBeInTheDocument();
  });
});
