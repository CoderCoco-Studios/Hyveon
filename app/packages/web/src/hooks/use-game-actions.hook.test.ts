import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';

const apiMock = vi.hoisted(() => ({ start: vi.fn(), stop: vi.fn() }));
vi.mock('../api.service.js', () => ({ api: apiMock }));

interface ToastOptions {
  action?: { label: string; onClick: () => void };
}
const toastMock = vi.hoisted(() => {
  const fn = vi.fn() as ReturnType<typeof vi.fn> & { success: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
  fn.success = vi.fn();
  fn.error = vi.fn();
  return fn;
});
vi.mock('sonner', () => ({ toast: toastMock }));

import { useGameActions } from './use-game-actions.hook.js';

describe('useGameActions', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    apiMock.stop.mockResolvedValue({ success: true, message: 'minecraft is stopping.' });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  // @spec RT-TASK-UI-010
  it('should stay busy while an Undo-after-Stop start is in flight', async () => {
    let finishUndo: (value: { success: boolean; message: string }) => void = () => undefined;
    apiMock.start.mockReturnValue(new Promise((resolve) => { finishUndo = resolve; }));
    const onRefresh = vi.fn();
    const { result } = renderHook(() => useGameActions('minecraft', onRefresh));

    act(() => result.current.stop());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(result.current.busy).toBe(false);

    const options = toastMock.mock.calls[0]![1] as ToastOptions;
    act(() => options.action!.onClick());
    expect(result.current.busy).toBe(true);

    await act(async () => {
      finishUndo({ success: true, message: 'minecraft is starting.' });
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(result.current.busy).toBe(false);
    expect(onRefresh).toHaveBeenLastCalledWith('minecraft');
  });

  // @spec RT-TASK-UI-010
  it('should stay busy when Undo is clicked before the Stop refresh timer fires', async () => {
    apiMock.start.mockReturnValue(new Promise(() => undefined));
    const { result } = renderHook(() => useGameActions('minecraft', vi.fn()));

    act(() => result.current.stop());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    const options = toastMock.mock.calls[0]![1] as ToastOptions;
    act(() => options.action!.onClick());

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });
    expect(result.current.busy).toBe(true);
  });
});
