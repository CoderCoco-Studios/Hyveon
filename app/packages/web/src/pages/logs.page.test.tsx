import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderPage } from '../test-utils/render-page.utils.js';
import { toStreamHandleMock } from '../test-utils/stream-handle.test-utils.js';

// Mock the API client so the component drives off canned data instead of real
// fetch calls. `vi.mock` is hoisted above the import so LogsPage picks up the stub.
// `status` and `costsEstimate` are stubbed too because `renderPage()` wraps
// every render in `GameStatusProvider`, which calls both on mount.
const apiMock = vi.hoisted(() => ({
  games: vi.fn(),
  status: vi.fn(),
  costsEstimate: vi.fn(),
}));
vi.mock('../api.service.js', () => ({
  api: apiMock,
}));

// Stub window.hyveon.logs so the component can open IPC streams without a real
// Electron main process. `stream(game)` returns a `HyveonStreamHandle` (the
// contextBridge-safe shape the real preload bridge now returns — see
// `toStreamHandleMock`); the default stub (set in beforeEach) yields nothing
// so tests drive off the seeded `get` snapshot. Individual tests override
// `stream` to emit chunks.
const hyveonMock = {
  logs: {
    get: vi.fn(),
    stream: vi.fn(),
  },
};
vi.stubGlobal('hyveon', hyveonMock);

import { LogsPage } from './logs.page.js';

const SAMPLE_LINES = [
  '2026-05-03T12:00:00Z INFO Server started on port 25565',
  '2026-05-03T12:00:01Z DEBUG Loaded world "world" in 1.2s',
  '2026-05-03T12:00:02Z WARN Deprecated config option',
  '2026-05-03T12:00:03Z ERROR Connection refused from 10.0.0.5',
  '2026-05-03T12:00:04Z Player joined the game',
];

describe('LogsPage', () => {
  beforeEach(() => {
    apiMock.games.mockResolvedValue({
      games: [{ name: 'minecraft', declared: true, deployed: true }],
    });
    // `renderPage()` wraps every render in `GameStatusProvider`, which calls
    // both of these on mount — stub them so it never hangs waiting on a real
    // network call.
    apiMock.status.mockResolvedValue([]);
    apiMock.costsEstimate.mockResolvedValue({ games: {}, totalPerHourIfAllOn: 0 });
    hyveonMock.logs.get.mockResolvedValue({ game: 'minecraft', lines: SAMPLE_LINES });
    // Default stream emits nothing and ends immediately — tests assert on the
    // seeded snapshot. Override per-test to drive live chunks through `for await`.
    hyveonMock.logs.stream.mockImplementation(toStreamHandleMock(async function* () {}));
  });

  it('should render the Server Logs heading and the LIVE badge', async () => {
    renderPage(<LogsPage />);

    expect(await screen.findByRole('heading', { name: 'Server Logs' })).toBeInTheDocument();
    expect(screen.getByText('Live', { selector: 'div' })).toBeInTheDocument();
  });

  it('should render seeded log lines once the snapshot resolves', async () => {
    renderPage(<LogsPage />);

    expect(await screen.findByText(/Server started on port 25565/)).toBeInTheDocument();
    expect(screen.getByText(/Connection refused from 10.0.0.5/)).toBeInTheDocument();
  });

  it('should color-code lines containing INFO/WARN/ERROR/DEBUG with badges', async () => {
    renderPage(<LogsPage />);

    // Wait until the first seeded line is rendered, then assert one badge per
    // detected level. The badge text is exact-matched to avoid colliding with
    // the same token inside the underlying log line.
    await screen.findByText(/Server started/);
    for (const lvl of ['INFO', 'WARN', 'ERROR', 'DEBUG']) {
      // The `<Badge>` for a line is a div containing exactly the level text;
      // the same token also appears inside the line itself, so we expect
      // multiple matches and assert on the first.
      const matches = screen.getAllByText(lvl, { exact: true });
      expect(matches.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('should toggle the Pause / Resume button and the LIVE / PAUSED badge', async () => {
    const user = userEvent.setup();
    renderPage(<LogsPage />);
    await screen.findByText(/Server started/);

    await user.click(screen.getByRole('button', { name: 'Pause' }));
    expect(screen.getByText('Paused', { selector: 'div' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Resume' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Resume' }));
    expect(screen.getByText('Live', { selector: 'div' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pause' })).toBeInTheDocument();
  });

  it('should highlight matches inside <mark> when typing in the search input', async () => {
    const user = userEvent.setup();
    const { container } = renderPage(<LogsPage />);
    await screen.findByText(/Server started/);

    expect(container.querySelectorAll('mark')).toHaveLength(0);

    await user.type(screen.getByPlaceholderText('Search visible buffer…'), 'Connection');

    const marks = container.querySelectorAll('mark');
    expect(marks.length).toBeGreaterThan(0);
    expect(Array.from(marks).some((m) => m.textContent === 'Connection')).toBe(true);
    // The matched line stays in the buffer — search highlights, never filters.
    expect(screen.getByText(/refused from 10.0.0.5/)).toBeInTheDocument();
  });

  it('should hide ERROR-level lines after unchecking ERROR in the Levels filter', async () => {
    const user = userEvent.setup();
    renderPage(<LogsPage />);
    await screen.findByText(/Server started/);
    expect(screen.getByText(/Connection refused/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Levels/ }));
    await user.click(await screen.findByRole('menuitemcheckbox', { name: 'ERROR' }));

    await waitFor(() => {
      expect(screen.queryByText(/Connection refused/)).toBeNull();
    });
  });

  it('should display "5 lines · oldest …" in the footer for the seeded buffer', async () => {
    renderPage(<LogsPage />);

    expect(await screen.findByText(/^5 lines · oldest /)).toBeInTheDocument();
  });

  it('should call window.hyveon.logs.get with the selected game on mount', async () => {
    renderPage(<LogsPage />);

    await waitFor(() => {
      expect(apiMock.games).toHaveBeenCalled();
      expect(hyveonMock.logs.get).toHaveBeenCalledWith('minecraft');
    });
  });

  it('should append live chunks yielded by the stream iterator after the seeded snapshot', async () => {
    hyveonMock.logs.stream.mockImplementation(
      toStreamHandleMock(async function* () {
        yield '2026-05-03T12:00:05Z INFO Live chunk one';
        yield '2026-05-03T12:00:06Z ERROR Live chunk two';
      }),
    );
    renderPage(<LogsPage />);

    // Seeded snapshot first, then the two chunks consumed via `for await`.
    await screen.findByText(/Server started on port 25565/);
    expect(await screen.findByText(/Live chunk one/)).toBeInTheDocument();
    expect(await screen.findByText(/Live chunk two/)).toBeInTheDocument();
  });

  it('should pass only the selected game to stream (no AbortSignal — cancellation goes through the returned handle)', async () => {
    renderPage(<LogsPage />);

    await waitFor(() => {
      expect(hyveonMock.logs.stream).toHaveBeenCalledWith('minecraft');
    });
  });

  describe('scroll position', () => {
    /**
     * Stubs the scroll geometry (`scrollHeight`/`clientHeight`) jsdom never
     * lays out, so tests can assert auto-scroll behavior without a real
     * layout engine — matches `AnsiLogViewer`'s test helper.
     */
    function stubScrollGeometry(
      el: HTMLElement,
      { scrollHeight, clientHeight }: { scrollHeight: number; clientHeight: number },
    ) {
      Object.defineProperty(el, 'scrollHeight', { configurable: true, value: scrollHeight });
      Object.defineProperty(el, 'clientHeight', { configurable: true, value: clientHeight });
    }

    /**
     * Backs `window.hyveon.logs.stream` with an async generator whose chunks
     * are pushed on demand, so a test can scroll the rendered viewer and then
     * feed it a live chunk within the same component instance — mirroring
     * how the real IPC stream trickles chunks in over time.
     */
    function createControllableStream() {
      const buffer: string[] = [];
      let notify: (() => void) | null = null;
      async function* gen(): AsyncGenerator<string> {
        while (true) {
          if (buffer.length > 0) {
            yield buffer.shift()!;
            continue;
          }
          await new Promise<void>((resolve) => {
            notify = resolve;
          });
        }
      }
      return {
        gen,
        push(chunk: string) {
          buffer.push(chunk);
          notify?.();
          notify = null;
        },
      };
    }

    it('should not jump to the bottom on new lines once the user has scrolled away from it', async () => {
      const stream = createControllableStream();
      hyveonMock.logs.stream.mockImplementation(toStreamHandleMock(stream.gen));
      renderPage(<LogsPage />);
      await screen.findByText(/Server started on port 25565/);

      const box = screen.getByTestId('logs-viewer');
      stubScrollGeometry(box, { scrollHeight: 500, clientHeight: 100 });
      Object.defineProperty(box, 'scrollTop', { configurable: true, writable: true, value: 50 });
      fireEvent.scroll(box);

      // Autoscroll checkbox reflects the automatic un-pin.
      expect(screen.getAllByRole('checkbox', { name: 'Autoscroll' })[0]).not.toBeChecked();

      const scrollTopSpy = vi.spyOn(box, 'scrollTop', 'set');
      stream.push('2026-05-03T12:00:05Z INFO Live chunk one');
      await screen.findByText(/Live chunk one/);

      expect(scrollTopSpy).not.toHaveBeenCalled();
    });

    it('should resume pinning to the bottom once the user scrolls back near it', async () => {
      const stream = createControllableStream();
      hyveonMock.logs.stream.mockImplementation(toStreamHandleMock(stream.gen));
      renderPage(<LogsPage />);
      await screen.findByText(/Server started on port 25565/);

      const box = screen.getByTestId('logs-viewer');
      stubScrollGeometry(box, { scrollHeight: 500, clientHeight: 100 });
      Object.defineProperty(box, 'scrollTop', { configurable: true, writable: true, value: 50 });
      fireEvent.scroll(box);
      expect(screen.getAllByRole('checkbox', { name: 'Autoscroll' })[0]).not.toBeChecked();

      Object.defineProperty(box, 'scrollTop', { configurable: true, writable: true, value: 480 });
      fireEvent.scroll(box);
      expect(screen.getAllByRole('checkbox', { name: 'Autoscroll' })[0]).toBeChecked();

      stream.push('2026-05-03T12:00:05Z INFO Live chunk one');
      await screen.findByText(/Live chunk one/);

      expect(box.scrollTop).toBe(500);
    });
  });
});

describe('LogsPage — initial game preselection', () => {
  beforeEach(() => {
    apiMock.games.mockResolvedValue({
      games: [
        { name: 'minecraft', declared: true, deployed: true },
        { name: 'valheim', declared: true, deployed: true },
      ],
    });
    apiMock.status.mockResolvedValue([]);
    apiMock.costsEstimate.mockResolvedValue({ games: {}, totalPerHourIfAllOn: 0 });
    hyveonMock.logs.get.mockResolvedValue({ game: 'minecraft', lines: [] });
    hyveonMock.logs.stream.mockImplementation(toStreamHandleMock(async function* () {}));
  });

  it('should preselect the game named in location.state when it is present in the fetched list', async () => {
    renderPage(<LogsPage />, {
      initialEntries: [{ pathname: '/logs', state: { game: 'valheim' } }],
    });

    expect(
      await screen.findByRole('button', { name: 'Game selector, valheim selected' }),
    ).toBeInTheDocument();
  });

  it('should fall back to the first game in the list when location.state is absent', async () => {
    renderPage(<LogsPage />, { initialEntries: ['/logs'] });

    expect(
      await screen.findByRole('button', { name: 'Game selector, minecraft selected' }),
    ).toBeInTheDocument();
  });

  it('should fall back to the first game in the list when location.state.game names a game not in the list', async () => {
    renderPage(<LogsPage />, {
      initialEntries: [{ pathname: '/logs', state: { game: 'terraria' } }],
    });

    expect(
      await screen.findByRole('button', { name: 'Game selector, minecraft selected' }),
    ).toBeInTheDocument();
  });
});
