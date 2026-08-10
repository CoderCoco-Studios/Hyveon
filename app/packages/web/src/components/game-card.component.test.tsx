import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { GameStatus } from '../api.service.js';
import { GameCard } from './game-card.component.js';

const apiMock = vi.hoisted(() => ({
  stop: vi.fn().mockResolvedValue({ success: true, message: 'minecraft is stopping.' }),
  start: vi.fn().mockResolvedValue({ success: true, message: 'minecraft is starting. It may take 2–5 minutes.' }),
}));
vi.mock('../api.service.js', () => ({ api: apiMock }));

const mockIsSuppressed = vi.hoisted(() => vi.fn().mockReturnValue(false));
vi.mock('../lib/confirm-skip.utils.js', () => ({
  isSuppressed: mockIsSuppressed,
  suppress: vi.fn(),
}));

const toastMock = vi.hoisted(() =>
  Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
);
vi.mock('sonner', () => ({ toast: toastMock }));

/** A minimal running-server status fixture. */
const runningStatus: GameStatus = {
  game: 'minecraft',
  state: 'running',
};

/** A minimal stopped-server status fixture. */
const stoppedStatus: GameStatus = {
  game: 'minecraft',
  state: 'stopped',
};

/** A minimal not-deployed-server status fixture. */
const notDeployedStatus: GameStatus = {
  game: 'minecraft',
  state: 'not_deployed',
};

/** A minimal starting-server status fixture. */
const startingStatus: GameStatus = {
  game: 'minecraft',
  state: 'starting',
};

/** An error-state status fixture carrying a distinctive error reason. */
const errorStatus: GameStatus = {
  game: 'minecraft',
  state: 'error',
  message: 'Task failed to start: insufficient capacity',
};

function renderCard(status: GameStatus = runningStatus) {
  return render(
    <MemoryRouter>
      <GameCard
        status={status}
        onRefresh={vi.fn()}
        onOpenFiles={vi.fn()}
      />
    </MemoryRouter>,
  );
}

describe('GameCard — stats grid', () => {
  beforeEach(() => {
    apiMock.stop.mockResolvedValue({ success: true, message: 'minecraft is stopping.' });
    apiMock.start.mockResolvedValue({ success: true, message: 'minecraft is starting. It may take 2–5 minutes.' });
    toastMock.mockClear();
    toastMock.success.mockClear();
    toastMock.error.mockClear();
  });

  it('should render the Last run, $ per hour, and Task stats', () => {
    renderCard();

    expect(screen.getByText('Last run')).toBeInTheDocument();
    expect(screen.getByText('$ per hour')).toBeInTheDocument();
    expect(screen.getByText('Task')).toBeInTheDocument();
  });

  it('should not render a Players stat tile', () => {
    renderCard();

    expect(screen.queryByText('Players')).not.toBeInTheDocument();
  });
});

describe('GameCard — error-state recovery', () => {
  beforeEach(() => {
    apiMock.stop.mockResolvedValue({ success: true, message: 'minecraft is stopping.' });
    apiMock.start.mockResolvedValue({ success: true, message: 'minecraft is starting. It may take 2–5 minutes.' });
    toastMock.mockClear();
    toastMock.success.mockClear();
    toastMock.error.mockClear();
  });

  it('should render the Start button enabled when the server is in the error state', () => {
    renderCard(errorStatus);

    const startButton = screen.getByRole('button', { name: /start/i });
    expect(startButton).toBeInTheDocument();
    expect(startButton).not.toBeDisabled();
  });

  it('should render the error message when the server is in the error state', () => {
    renderCard(errorStatus);

    expect(screen.getByText('Task failed to start: insufficient capacity')).toBeInTheDocument();
  });

  it('should not render an error message when the error state has no message', () => {
    renderCard({ game: 'minecraft', state: 'error' });

    expect(screen.queryByText(/insufficient capacity/i)).not.toBeInTheDocument();
  });

  it('should call api.start when Start is clicked from the error state', async () => {
    renderCard(errorStatus);

    await userEvent.click(screen.getByRole('button', { name: /start/i }));

    expect(apiMock.start).toHaveBeenCalledWith('minecraft');
  });
});

describe('GameCard — Start/Stop button state per server state', () => {
  beforeEach(() => {
    apiMock.stop.mockResolvedValue({ success: true, message: 'minecraft is stopping.' });
    apiMock.start.mockResolvedValue({ success: true, message: 'minecraft is starting. It may take 2–5 minutes.' });
    toastMock.mockClear();
    toastMock.success.mockClear();
    toastMock.error.mockClear();
  });

  it('should render an enabled Start button and no Stop button when stopped', () => {
    renderCard(stoppedStatus);

    expect(screen.getByRole('button', { name: /start/i })).not.toBeDisabled();
    expect(screen.queryByRole('button', { name: /stop/i })).not.toBeInTheDocument();
  });

  it('should render an enabled Start button and no Stop button when not deployed', () => {
    renderCard(notDeployedStatus);

    expect(screen.getByRole('button', { name: /start/i })).not.toBeDisabled();
    expect(screen.queryByRole('button', { name: /stop/i })).not.toBeInTheDocument();
  });

  it('should render an enabled Stop button and no Start button when running', () => {
    renderCard(runningStatus);

    expect(screen.getByRole('button', { name: /stop/i })).not.toBeDisabled();
    expect(screen.queryByRole('button', { name: /start/i })).not.toBeInTheDocument();
  });

  it('should render an enabled Stop button and no Start button when starting', () => {
    renderCard(startingStatus);

    expect(screen.getByRole('button', { name: /stop/i })).not.toBeDisabled();
    expect(screen.queryByRole('button', { name: /start/i })).not.toBeInTheDocument();
  });
});

describe('GameCard — Stop confirmation', () => {
  beforeEach(() => {
    apiMock.stop.mockResolvedValue({ success: true, message: 'minecraft is stopping.' });
    apiMock.start.mockResolvedValue({ success: true, message: 'minecraft is starting. It may take 2–5 minutes.' });
    toastMock.mockClear();
    toastMock.success.mockClear();
    toastMock.error.mockClear();
  });

  it('should show the confirmation dialog when Stop is clicked and the action is not suppressed', async () => {
    mockIsSuppressed.mockReturnValue(false);
    renderCard();

    await userEvent.click(screen.getByRole('button', { name: /stop/i }));

    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(screen.getByText('Stop minecraft?')).toBeInTheDocument();
  });

  it('should call api.stop directly without showing the dialog when the action is suppressed', async () => {
    mockIsSuppressed.mockReturnValue(true);
    renderCard();

    await userEvent.click(screen.getByRole('button', { name: /stop/i }));

    expect(apiMock.stop).toHaveBeenCalledWith('minecraft');
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('should call api.stop after the user confirms the dialog', async () => {
    mockIsSuppressed.mockReturnValue(false);
    renderCard();

    await userEvent.click(screen.getByRole('button', { name: /stop/i }));
    await userEvent.click(screen.getByRole('button', { name: /stop server/i }));

    expect(apiMock.stop).toHaveBeenCalledWith('minecraft');
  });

  it('should not call api.stop when the user cancels the dialog', async () => {
    mockIsSuppressed.mockReturnValue(false);
    renderCard();

    await userEvent.click(screen.getByRole('button', { name: /stop/i }));
    await userEvent.click(screen.getByRole('button', { name: /cancel/i }));

    expect(apiMock.stop).not.toHaveBeenCalled();
  });
});

describe('GameCard — Start/Stop toasts', () => {
  beforeEach(() => {
    apiMock.stop.mockResolvedValue({ success: true, message: 'minecraft is stopping.' });
    apiMock.start.mockResolvedValue({ success: true, message: 'minecraft is starting. It may take 2–5 minutes.' });
    toastMock.mockClear();
    toastMock.success.mockClear();
    toastMock.error.mockClear();
  });

  it('should show a success toast when Start succeeds', async () => {
    renderCard(stoppedStatus);

    await userEvent.click(screen.getByRole('button', { name: /start/i }));

    expect(toastMock.success).toHaveBeenCalledWith('minecraft is starting. It may take 2–5 minutes.');
  });

  it('should show an error toast with the error message when Start fails', async () => {
    apiMock.start.mockRejectedValueOnce(new Error('capacity exceeded'));
    renderCard(stoppedStatus);

    await userEvent.click(screen.getByRole('button', { name: /start/i }));

    expect(toastMock.error).toHaveBeenCalledWith(
      'Failed to start minecraft',
      expect.objectContaining({ description: 'capacity exceeded' }),
    );
  });

  it('should show an error toast with the fallback description when Start fails with an unknown error', async () => {
    apiMock.start.mockRejectedValueOnce('not an Error');
    renderCard(stoppedStatus);

    await userEvent.click(screen.getByRole('button', { name: /start/i }));

    expect(toastMock.error).toHaveBeenCalledWith(
      'Failed to start minecraft',
      expect.objectContaining({ description: 'An unknown error occurred' }),
    );
  });

  it('should show an error toast, not a success toast, when Start resolves with success: false', async () => {
    apiMock.start.mockResolvedValueOnce({
      success: false,
      message: 'Unable to assume the service linked role.',
    });
    renderCard(stoppedStatus);

    await userEvent.click(screen.getByRole('button', { name: /start/i }));

    expect(toastMock.error).toHaveBeenCalledWith(
      'Failed to start minecraft',
      expect.objectContaining({ description: 'Unable to assume the service linked role.' }),
    );
    expect(toastMock.success).not.toHaveBeenCalled();
  });

  it('should show an error toast, not an Undo toast, when Stop resolves with success: false', async () => {
    mockIsSuppressed.mockReturnValue(true);
    apiMock.stop.mockResolvedValueOnce({ success: false, message: 'Task not found.' });
    renderCard(runningStatus);

    await userEvent.click(screen.getByRole('button', { name: /stop/i }));

    expect(toastMock.error).toHaveBeenCalledWith(
      'Failed to stop minecraft',
      expect.objectContaining({ description: 'Task not found.' }),
    );
    expect(toastMock).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: expect.anything() }),
    );
  });

  it('should show a stop toast with an Undo action when Stop succeeds', async () => {
    mockIsSuppressed.mockReturnValue(true);
    renderCard(runningStatus);

    await userEvent.click(screen.getByRole('button', { name: /stop/i }));

    expect(toastMock).toHaveBeenCalledWith(
      'minecraft is stopping.',
      expect.objectContaining({
        action: expect.objectContaining({ label: 'Undo' }),
      }),
    );
  });

  it('should show an error toast with the error message when Stop fails', async () => {
    mockIsSuppressed.mockReturnValue(true);
    apiMock.stop.mockRejectedValueOnce(new Error('task not found'));
    renderCard(runningStatus);

    await userEvent.click(screen.getByRole('button', { name: /stop/i }));

    expect(toastMock.error).toHaveBeenCalledWith(
      'Failed to stop minecraft',
      expect.objectContaining({ description: 'task not found' }),
    );
  });
});
