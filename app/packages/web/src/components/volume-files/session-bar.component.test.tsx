import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { SessionBar } from './session-bar.component.js';
import { makeSessionStatus } from './volume-files.test-utils.js';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('SessionBar', () => {
  it('should report once when the auto-stop countdown reaches zero', async () => {
    vi.useFakeTimers();
    const onAutoStopDue = vi.fn();
    const status = makeSessionStatus({ startedAt: new Date().toISOString(), autoStopAt: new Date(Date.now() + 2500).toISOString() });
    render(<SessionBar status={status} actionError={null} onStart={vi.fn()} onStop={vi.fn()} onRestart={vi.fn()} onAutoStopDue={onAutoStopDue} />);
    expect(onAutoStopDue).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });

    expect(onAutoStopDue).toHaveBeenCalledTimes(1);
  });
});
