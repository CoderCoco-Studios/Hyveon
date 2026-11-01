import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SessionBar } from './session-bar.component.js';
import { makeSessionStatus } from './volume-files.test-utils.js';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('SessionBar', () => {
  // @spec HELPER-FB-020
  it('should report once when the auto-stop countdown reaches zero', async () => {
    vi.useFakeTimers();
    const onAutoStopDue = vi.fn();
    const status = makeSessionStatus({ startedAt: new Date().toISOString(), autoStopAt: new Date(Date.now() + 2500).toISOString() });
    render(<SessionBar status={status} transferActive={false} actionError={null} onStart={vi.fn()} onStop={vi.fn()} onRestart={vi.fn()} onAutoStopDue={onAutoStopDue} />);
    expect(onAutoStopDue).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });

    expect(onAutoStopDue).toHaveBeenCalledTimes(1);
  });

  describe('Stop', () => {
    function renderBar(uploadHolders: number, transferActive: boolean) {
      const onStop = vi.fn();
      render(
        <SessionBar status={makeSessionStatus({ uploadHolders })} transferActive={transferActive} actionError={null} onStart={vi.fn()} onStop={onStop} onRestart={vi.fn()} />,
      );
      return onStop;
    }

    // @spec HELPER-FB-017
    it('should confirm before stopping while a download runs with no upload holders', async () => {
      const onStop = renderBar(0, true);

      await userEvent.click(screen.getByRole('button', { name: 'Stop' }));

      expect(screen.getByText('This cancels the running transfer.')).toBeInTheDocument();
      expect(onStop).not.toHaveBeenCalled();
      await userEvent.click(screen.getByRole('button', { name: 'Stop session' }));
      expect(onStop).toHaveBeenCalledTimes(1);
    });

    it('should stop directly with no transfers and no upload holders', async () => {
      const onStop = renderBar(0, false);

      await userEvent.click(screen.getByRole('button', { name: 'Stop' }));

      expect(onStop).toHaveBeenCalledTimes(1);
      expect(screen.queryByText('This cancels the running transfer.')).not.toBeInTheDocument();
    });

    // @spec HELPER-FB-017
    it('should confirm before stopping while an upload holder is present', async () => {
      const onStop = renderBar(1, false);

      await userEvent.click(screen.getByRole('button', { name: 'Stop' }));

      expect(screen.getByText('This cancels the running transfer.')).toBeInTheDocument();
      expect(onStop).not.toHaveBeenCalled();
    });
  });
});
