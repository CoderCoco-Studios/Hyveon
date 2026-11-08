import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

const apiMock = vi.hoisted(() => ({
  status: vi.fn(),
  statusGame: vi.fn(),
  costsEstimate: vi.fn(),
}));
vi.mock('../api.service.js', () => ({ api: apiMock }));
const toastMock = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock('sonner', () => ({ toast: toastMock }));

import { PollingProvider, usePollingState } from './polling-provider.component.js';
import { GameStatusProvider, GAME_STATUS_POLLER, useGameStatus } from './game-status-provider.component.js';

const STOPPED = { game: 'minecraft', state: 'stopped' as const };
const ESTIMATES = {
  games: {
    minecraft: { vcpu: 1, memoryGb: 2, costPerHour: 0.08, costPerDay24h: 1.92, costPerMonth4hpd: 9.6 },
  },
  totalPerHourIfAllOn: 0.08,
};

/** Minimal probe that exposes the provider's state via the DOM for assertions. */
function StatusProbe() {
  const { statuses, estimates, loading, error, refresh } = useGameStatus();
  return (
    <div>
      <div data-testid="loading">{String(loading)}</div>
      <div data-testid="count">{statuses.length}</div>
      <div data-testid="game">{statuses[0]?.game ?? '-'}</div>
      <div data-testid="hourly">{estimates ? String(estimates.totalPerHourIfAllOn) : '-'}</div>
      <div data-testid="error">{error ? error.message : '-'}</div>
      <button data-testid="refresh" onClick={() => void refresh()}>
        refresh
      </button>
    </div>
  );
}

/** Exposes the shared polling registry's `status` poller entry for assertions. */
function StatusPollerProbe() {
  const { pollers } = usePollingState();
  const poller = pollers[GAME_STATUS_POLLER];
  return (
    <div>
      <div data-testid="poller-loading">{String(poller?.loading ?? 'undefined')}</div>
      <div data-testid="poller-error">{poller?.error ? poller.error.message : '-'}</div>
    </div>
  );
}

describe('GameStatusProvider', () => {
  beforeEach(() => {
    apiMock.status.mockResolvedValue([STOPPED]);
    apiMock.costsEstimate.mockResolvedValue(ESTIMATES);
  });

  it('should fetch status on mount and expose it through useGameStatus', async () => {
    render(
      <PollingProvider>
        <GameStatusProvider>
          <StatusProbe />
        </GameStatusProvider>
      </PollingProvider>,
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(apiMock.status).toHaveBeenCalled();
    expect(screen.getByTestId('count')).toHaveTextContent('1');
    expect(screen.getByTestId('game')).toHaveTextContent('minecraft');
    expect(screen.getByTestId('loading')).toHaveTextContent('false');
  });

  // @spec RT-TASK-UI-003
  it('should fetch cost estimates exactly once on mount, not on every poll tick', async () => {
    render(
      <PollingProvider>
        <GameStatusProvider>
          <StatusProbe />
        </GameStatusProvider>
      </PollingProvider>,
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(apiMock.costsEstimate).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('hourly')).toHaveTextContent('0.08');
  });

  it('should throw a clear error when useGameStatus is read outside the provider', () => {
    // Suppress the intentional "consumer outside provider" exception React logs.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(() => render(<StatusProbe />)).toThrow(
        /useGameStatus must be used inside <GameStatusProvider>/,
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('should set loading to false even when the status fetch rejects', async () => {
    apiMock.status.mockRejectedValueOnce(new Error('network down'));

    render(
      <PollingProvider>
        <GameStatusProvider>
          <StatusProbe />
        </GameStatusProvider>
      </PollingProvider>,
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByTestId('loading')).toHaveTextContent('false');
  });

  // @spec RT-TASK-UI-002
  it('should surface the rejection on the error field and clear it on the next successful poll', async () => {
    apiMock.status.mockRejectedValueOnce(new Error('network down'));

    render(
      <PollingProvider>
        <GameStatusProvider>
          <StatusProbe />
          <StatusPollerProbe />
        </GameStatusProvider>
      </PollingProvider>,
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByTestId('error')).toHaveTextContent('network down');
    // The shared polling registry's own catch (PollingProvider.runOne) must
    // still observe the rethrown rejection so the poller's own loading/error
    // state — which LiveIndicator/PollingIndicator depend on — stays correct.
    expect(screen.getByTestId('poller-loading')).toHaveTextContent('false');
    expect(screen.getByTestId('poller-error')).toHaveTextContent('network down');

    apiMock.status.mockResolvedValueOnce([STOPPED]);

    await act(async () => {
      fireEvent.click(screen.getByTestId('refresh'));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByTestId('error')).toHaveTextContent('-');
    expect(screen.getByTestId('poller-error')).toHaveTextContent('-');
  });

  // @spec RT-TASK-UI-004
  it('should expose and toast a failed costs.estimate fetch instead of leaving estimates silently empty', async () => {
    apiMock.costsEstimate.mockRejectedValueOnce(new Error('describe denied'));

    render(
      <PollingProvider>
        <GameStatusProvider>
          <EstimatesErrorProbe />
        </GameStatusProvider>
      </PollingProvider>,
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByTestId('estimates-error')).toHaveTextContent('describe denied');
    expect(toastMock.error).toHaveBeenCalledWith('Could not load cost estimates', { description: 'describe denied' });
  });

  // @spec RT-TASK-UI-004
  it('should reload estimates on demand, clearing a previous failure', async () => {
    apiMock.costsEstimate.mockRejectedValueOnce(new Error('describe denied')).mockResolvedValueOnce(ESTIMATES);

    render(
      <PollingProvider>
        <GameStatusProvider>
          <ReloadEstimatesProbe />
        </GameStatusProvider>
      </PollingProvider>,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByTestId('estimates-error')).toHaveTextContent('describe denied');

    await act(async () => {
      fireEvent.click(screen.getByTestId('reload-estimates'));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByTestId('estimates-error')).toHaveTextContent('-');
    expect(screen.getByTestId('hourly')).toHaveTextContent('0.08');
  });

  // @spec RT-TASK-UI-005
  it('should insert a game status that the last full poll did not include when refreshing that game', async () => {
    apiMock.status.mockResolvedValue([STOPPED]);
    apiMock.statusGame.mockResolvedValue({ game: 'valheim', state: 'running' });

    render(
      <PollingProvider>
        <GameStatusProvider>
          <RefreshGameProbe />
        </GameStatusProvider>
      </PollingProvider>,
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('refresh-valheim'));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByTestId('games')).toHaveTextContent('minecraft:stopped,valheim:running');
  });
});

/** Exposes the costs.estimate failure state. */
function EstimatesErrorProbe() {
  const { estimatesError } = useGameStatus();
  return <div data-testid="estimates-error">{estimatesError ? estimatesError.message : '-'}</div>;
}

/** Lists every status and offers a button that refreshes a game absent from the initial poll. */
function RefreshGameProbe() {
  const { statuses, refreshGame } = useGameStatus();
  return (
    <div>
      <div data-testid="games">{statuses.map((s) => `${s.game}:${s.state}`).join(',')}</div>
      <button data-testid="refresh-valheim" onClick={() => void refreshGame('valheim')}>
        refresh
      </button>
    </div>
  );
}

/** Exposes estimates, their failure state, and a button that reloads them. */
function ReloadEstimatesProbe() {
  const { estimates, estimatesError, reloadEstimates } = useGameStatus();
  return (
    <div>
      <div data-testid="estimates-error">{estimatesError ? estimatesError.message : '-'}</div>
      <div data-testid="hourly">{estimates ? String(estimates.totalPerHourIfAllOn) : '-'}</div>
      <button data-testid="reload-estimates" onClick={() => void reloadEstimates()}>
        reload
      </button>
    </div>
  );
}
