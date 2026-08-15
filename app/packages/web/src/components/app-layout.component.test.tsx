import { useEffect } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
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

  it('should mark the active route link with aria-current="page"', () => {
    render(
      <PollingProvider>
        <MemoryRouter initialEntries={['/logs']}>
          <AppLayout>content</AppLayout>
        </MemoryRouter>
      </PollingProvider>,
    );

    expect(screen.getByRole('link', { name: 'Logs' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Dashboard' })).not.toHaveAttribute('aria-current');
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
    await user.click(within(document.getElementById('mobile-nav')!).getByRole('link', { name: 'Logs' }));
    expect(screen.queryByRole('button', { name: 'Close navigation' })).not.toBeInTheDocument();
  });
});

// jsdom has no IDL binding for `-webkit-app-region` — it's an Electron/Chromium-only
// CSS property, not part of the standard set jsdom's CSSStyleDeclaration recognizes.
// React sets non-custom style properties via plain assignment (`style.WebkitAppRegion
// = value`); on real Chromium that reaches the underlying CSSOM store because Chromium
// implements an IDL accessor for it, but under jsdom it just becomes an inert own
// property that `getPropertyValue('-webkit-app-region')` never sees. Patch the two
// together for this one property so the assertions below observe what Electron's
// Chromium renderer would actually do.
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

  it('should mark the header as a drag region when window.hyveon.window is present', () => {
    vi.stubGlobal('hyveon', {
      window: {
        platform: 'linux',
        minimize: vi.fn().mockResolvedValue(undefined),
        toggleMaximize: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
        isMaximized: vi.fn().mockResolvedValue(false),
        onMaximizedChange: vi.fn().mockReturnValue(vi.fn()),
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

  it('should mark every interactive header child as no-drag', () => {
    vi.stubGlobal('hyveon', {
      window: {
        platform: 'linux',
        minimize: vi.fn().mockResolvedValue(undefined),
        toggleMaximize: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
        isMaximized: vi.fn().mockResolvedValue(false),
        onMaximizedChange: vi.fn().mockReturnValue(vi.fn()),
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

  it('should render Linux minimize/maximize/close buttons when platform is linux', () => {
    vi.stubGlobal('hyveon', {
      window: {
        platform: 'linux',
        minimize: vi.fn().mockResolvedValue(undefined),
        toggleMaximize: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
        isMaximized: vi.fn().mockResolvedValue(false),
        onMaximizedChange: vi.fn().mockReturnValue(vi.fn()),
      },
    });

    render(
      <PollingProvider>
        <MemoryRouter>
          <AppLayout>content</AppLayout>
        </MemoryRouter>
      </PollingProvider>,
    );

    expect(screen.getByRole('button', { name: 'Minimize' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Maximize' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();
  });

  it('should not render any window-control buttons when platform is darwin', () => {
    vi.stubGlobal('hyveon', {
      window: {
        platform: 'darwin',
        minimize: vi.fn().mockResolvedValue(undefined),
        toggleMaximize: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
        isMaximized: vi.fn().mockResolvedValue(false),
        onMaximizedChange: vi.fn().mockReturnValue(vi.fn()),
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

  it('should not render any window-control buttons when platform is win32', () => {
    vi.stubGlobal('hyveon', {
      window: {
        platform: 'win32',
        minimize: vi.fn().mockResolvedValue(undefined),
        toggleMaximize: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
        isMaximized: vi.fn().mockResolvedValue(false),
        onMaximizedChange: vi.fn().mockReturnValue(vi.fn()),
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

  it('should reserve space for the Windows titleBarOverlay in the header trailing group on win32', () => {
    vi.stubGlobal('hyveon', {
      window: {
        platform: 'win32',
        minimize: vi.fn().mockResolvedValue(undefined),
        toggleMaximize: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
        isMaximized: vi.fn().mockResolvedValue(false),
        onMaximizedChange: vi.fn().mockReturnValue(vi.fn()),
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
  });

  it('should NOT reserve space for the Windows titleBarOverlay on linux or darwin', () => {
    vi.stubGlobal('hyveon', {
      window: {
        platform: 'linux',
        minimize: vi.fn().mockResolvedValue(undefined),
        toggleMaximize: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
        isMaximized: vi.fn().mockResolvedValue(false),
        onMaximizedChange: vi.fn().mockReturnValue(vi.fn()),
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

  it('should mark the sidebar brand block as a drag region on darwin when window.hyveon.window is present', () => {
    vi.stubGlobal('hyveon', {
      window: {
        platform: 'darwin',
        minimize: vi.fn().mockResolvedValue(undefined),
        toggleMaximize: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
        isMaximized: vi.fn().mockResolvedValue(false),
        onMaximizedChange: vi.fn().mockReturnValue(vi.fn()),
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
        minimize: vi.fn().mockResolvedValue(undefined),
        toggleMaximize: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
        isMaximized: vi.fn().mockResolvedValue(false),
        onMaximizedChange: vi.fn().mockReturnValue(vi.fn()),
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
        minimize: vi.fn().mockResolvedValue(undefined),
        toggleMaximize: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
        isMaximized: vi.fn().mockResolvedValue(false),
        onMaximizedChange: vi.fn().mockReturnValue(vi.fn()),
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

  it('should call window.hyveon.window.minimize() when the Minimize button is clicked', async () => {
    const minimize = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('hyveon', {
      window: {
        platform: 'linux',
        minimize,
        toggleMaximize: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
        isMaximized: vi.fn().mockResolvedValue(false),
        onMaximizedChange: vi.fn().mockReturnValue(vi.fn()),
      },
    });
    const user = userEvent.setup();

    render(
      <PollingProvider>
        <MemoryRouter>
          <AppLayout>content</AppLayout>
        </MemoryRouter>
      </PollingProvider>,
    );

    await user.click(screen.getByRole('button', { name: 'Minimize' }));
    expect(minimize).toHaveBeenCalledOnce();
  });

  it('should call window.hyveon.window.close() when the Close button is clicked', async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('hyveon', {
      window: {
        platform: 'linux',
        minimize: vi.fn().mockResolvedValue(undefined),
        toggleMaximize: vi.fn().mockResolvedValue(undefined),
        close,
        isMaximized: vi.fn().mockResolvedValue(false),
        onMaximizedChange: vi.fn().mockReturnValue(vi.fn()),
      },
    });
    const user = userEvent.setup();

    render(
      <PollingProvider>
        <MemoryRouter>
          <AppLayout>content</AppLayout>
        </MemoryRouter>
      </PollingProvider>,
    );

    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(close).toHaveBeenCalledOnce();
  });

  it('should swap the maximize button to a restore icon when onMaximizedChange reports true', async () => {
    let fireMaximizedChange: (isMaximized: boolean) => void = () => undefined;
    vi.stubGlobal('hyveon', {
      window: {
        platform: 'linux',
        minimize: vi.fn().mockResolvedValue(undefined),
        toggleMaximize: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
        isMaximized: vi.fn().mockResolvedValue(false),
        onMaximizedChange: vi.fn((cb: (isMaximized: boolean) => void) => {
          fireMaximizedChange = cb;
          return vi.fn();
        }),
      },
    });

    render(
      <PollingProvider>
        <MemoryRouter>
          <AppLayout>content</AppLayout>
        </MemoryRouter>
      </PollingProvider>,
    );

    const maximizeButton = screen.getByRole('button', { name: 'Maximize' });
    expect(maximizeButton).toBeInTheDocument();
    expect(maximizeButton.querySelector('svg.lucide-square')).toBeInTheDocument();
    expect(maximizeButton.querySelector('svg.lucide-copy')).not.toBeInTheDocument();

    await act(async () => {
      fireMaximizedChange(true);
    });

    expect(screen.queryByRole('button', { name: 'Maximize' })).not.toBeInTheDocument();
    const restoreButton = screen.getByRole('button', { name: 'Restore' });
    expect(restoreButton).toBeInTheDocument();
    expect(restoreButton.querySelector('svg.lucide-copy')).toBeInTheDocument();
    expect(restoreButton.querySelector('svg.lucide-square')).not.toBeInTheDocument();
  });
});
