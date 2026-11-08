import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LogTailView } from './log-tail-view.component.js';
import type { UseLogTailResult } from '../hooks/use-log-tail.hook.js';

vi.mock('../polling/polling-indicator.component.js', () => ({ PollingIndicator: () => null }));

/** Build a {@link UseLogTailResult} stub with live-mode defaults, overridable per test. */
function makeTail(overrides: Partial<UseLogTailResult> = {}): UseLogTailResult {
  return {
    lines: [],
    paused: false,
    autoscroll: true,
    setAutoscroll: vi.fn(),
    search: '',
    setSearch: vi.fn(),
    error: null,
    bufferedCount: 0,
    ageLabel: null,
    boxRef: { current: null },
    handlePauseToggle: vi.fn(),
    handleScroll: vi.fn(),
    mode: 'live',
    atOldest: false,
    loadingOlder: false,
    hasNewer: false,
    atNewest: false,
    jumpingToLatest: false,
    jumpToLatest: vi.fn(),
    ...overrides,
  };
}

/** Stubs `window.matchMedia` so the `md` breakpoint query reports `matches`. */
function stubViewport(matches: boolean): void {
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockImplementation((query: string) => ({
      matches,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('LogTailView', () => {
  // @spec APP-LOGS-UI-008
  it('should show a non-live badge and the buffered count while in historical mode, even when not paused', () => {
    render(
      <LogTailView
        title="Logs"
        emptyMessage="none"
        error={null}
        tail={makeTail({ mode: 'historical', hasNewer: true, bufferedCount: 7 })}
      />,
    );
    expect(screen.getByText('Historical')).toBeInTheDocument();
    expect(screen.queryByText('Live')).not.toBeInTheDocument();
    expect(screen.getByText('buffered 7')).toBeInTheDocument();
  });

  // @spec APP-LOGS-UI-008
  it('should show the Live badge and no buffered count in live mode', () => {
    render(<LogTailView title="Logs" emptyMessage="none" error={null} tail={makeTail()} />);
    expect(screen.getByText('Live')).toBeInTheDocument();
    expect(screen.queryByText(/buffered/)).not.toBeInTheDocument();
  });

  describe('mobile filter drawer', () => {
    // @spec APP-LOGS-UI-009
    it('should mount exactly one search input and one autoscroll toggle on a desktop viewport', () => {
      stubViewport(true);
      render(
        <LogTailView title="Logs" emptyMessage="none" error={null} tail={makeTail()} mobileFilters filtersOpen />,
      );
      expect(screen.getAllByPlaceholderText('Search visible buffer…')).toHaveLength(1);
      expect(screen.getAllByRole('checkbox', { name: 'Autoscroll' })).toHaveLength(1);
    });

    // @spec APP-LOGS-UI-009
    it('should mount only the drawer pair on a mobile viewport with the drawer open', () => {
      stubViewport(false);
      render(
        <LogTailView title="Logs" emptyMessage="none" error={null} tail={makeTail()} mobileFilters filtersOpen />,
      );
      expect(screen.getAllByPlaceholderText('Search visible buffer…')).toHaveLength(1);
      expect(screen.getAllByRole('checkbox', { name: 'Autoscroll' })).toHaveLength(1);
      expect(document.getElementById('logs-filters')).not.toBeNull();
    });

    // @spec APP-LOGS-UI-009
    it('should mount no search input or autoscroll toggle on a mobile viewport with the drawer closed', () => {
      stubViewport(false);
      render(<LogTailView title="Logs" emptyMessage="none" error={null} tail={makeTail()} mobileFilters />);
      expect(screen.queryByPlaceholderText('Search visible buffer…')).not.toBeInTheDocument();
      expect(screen.queryByRole('checkbox', { name: 'Autoscroll' })).not.toBeInTheDocument();
    });
  });
});
