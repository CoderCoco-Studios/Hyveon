import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { VolumeSessionStatus } from '@hyveon/shared/volumeFiles';
import { PollingProvider } from '../../polling/polling-provider.component.js';
import { useVolumeSession } from './use-volume-session.hook.js';
import { makeSessionStatus } from './volume-files.test-utils.js';

const apiMock = vi.hoisted(() => ({
  volumeSessionAttach: vi.fn(),
  volumeSessionDetach: vi.fn(),
  volumeSessionStatus: vi.fn(),
  volumeSessionStart: vi.fn(),
  volumeSessionStop: vi.fn(),
  volumeSessionRestart: vi.fn(),
  volumeOnSession: vi.fn(),
}));
vi.mock('../../api.service.js', () => ({ api: apiMock }));

const wrapper = ({ children }: { children: ReactNode }) => <PollingProvider>{children}</PollingProvider>;

let pushSession: (status: VolumeSessionStatus) => void;
const unsubscribe = vi.fn();

beforeEach(() => {
  apiMock.volumeSessionAttach.mockResolvedValue(makeSessionStatus());
  apiMock.volumeSessionDetach.mockResolvedValue(makeSessionStatus());
  apiMock.volumeSessionStatus.mockResolvedValue(makeSessionStatus());
  apiMock.volumeOnSession.mockImplementation((cb: (status: VolumeSessionStatus) => void) => {
    pushSession = cb;
    return unsubscribe;
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('useVolumeSession', () => {
  it('should attach on mount and detach on unmount', async () => {
    const { result, unmount } = renderHook(() => useVolumeSession('minecraft'), { wrapper });

    await waitFor(() => expect(result.current.status?.state).toBe('running'));
    expect(apiMock.volumeSessionAttach).toHaveBeenCalledWith('minecraft');
    expect(apiMock.volumeSessionDetach).not.toHaveBeenCalled();

    unmount();
    expect(apiMock.volumeSessionDetach).toHaveBeenCalledWith('minecraft');
    expect(unsubscribe).toHaveBeenCalled();
  });

  it('should keep polling while starting and stop once running', async () => {
    vi.useFakeTimers();
    apiMock.volumeSessionAttach.mockResolvedValue(makeSessionStatus({ state: 'starting' }));
    apiMock.volumeSessionStatus
      .mockResolvedValueOnce(makeSessionStatus({ state: 'starting' }))
      .mockResolvedValueOnce(makeSessionStatus({ state: 'running' }));

    const { result } = renderHook(() => useVolumeSession('minecraft'), { wrapper });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.status?.state).toBe('starting');
    expect(apiMock.volumeSessionStatus).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(result.current.status?.state).toBe('running');
    expect(apiMock.volumeSessionStatus).toHaveBeenCalledTimes(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(apiMock.volumeSessionStatus).toHaveBeenCalledTimes(2);
  });

  it('should replace the status with a pushed update for this game and ignore other games', async () => {
    const { result } = renderHook(() => useVolumeSession('minecraft'), { wrapper });
    await waitFor(() => expect(result.current.status?.state).toBe('running'));

    act(() => pushSession(makeSessionStatus({ game: 'palworld', state: 'failed' })));
    expect(result.current.status?.state).toBe('running');

    act(() => pushSession(makeSessionStatus({ state: 'orphaned' })));
    expect(result.current.status?.state).toBe('orphaned');
  });

  it('should set the status from the bare return of start()', async () => {
    apiMock.volumeSessionAttach.mockResolvedValue(makeSessionStatus({ state: 'stopped' }));
    apiMock.volumeSessionStart.mockResolvedValue(makeSessionStatus({ state: 'starting' }));
    apiMock.volumeSessionStatus.mockResolvedValue(makeSessionStatus({ state: 'starting' }));
    const { result } = renderHook(() => useVolumeSession('minecraft'), { wrapper });
    await waitFor(() => expect(result.current.status?.state).toBe('stopped'));

    await act(() => result.current.start());

    expect(apiMock.volumeSessionStart).toHaveBeenCalledWith('minecraft');
    expect(result.current.status?.state).toBe('starting');
    expect(result.current.error).toBeNull();
  });

  it('should unwrap the result of stop() into the status', async () => {
    apiMock.volumeSessionStop.mockResolvedValue({ ok: true, value: makeSessionStatus({ state: 'stopped' }) });
    const { result } = renderHook(() => useVolumeSession('minecraft'), { wrapper });
    await waitFor(() => expect(result.current.status?.state).toBe('running'));

    await act(() => result.current.stop());

    expect(apiMock.volumeSessionStop).toHaveBeenCalledWith('minecraft');
    expect(result.current.status?.state).toBe('stopped');
  });

  it('should surface the message of a failed restart() and keep the status', async () => {
    apiMock.volumeSessionRestart.mockResolvedValue({ ok: false, code: 'failed', message: 'restart refused' });
    const { result } = renderHook(() => useVolumeSession('minecraft'), { wrapper });
    await waitFor(() => expect(result.current.status?.state).toBe('running'));

    await act(() => result.current.restart());

    expect(result.current.error).toBe('restart refused');
    expect(result.current.status?.state).toBe('running');
  });

  it('should surface a rejected start() as an error message', async () => {
    apiMock.volumeSessionStart.mockRejectedValue(new Error('bridge down'));
    const { result } = renderHook(() => useVolumeSession('minecraft'), { wrapper });
    await waitFor(() => expect(result.current.status).not.toBeNull());

    await act(() => result.current.start());

    expect(result.current.error).toBe('bridge down');
  });

  it('should not show the previous game status after the game changes', async () => {
    apiMock.volumeSessionAttach.mockImplementation(async (game: string) => makeSessionStatus({ game }));
    const { result, rerender } = renderHook(({ game }) => useVolumeSession(game), {
      wrapper,
      initialProps: { game: 'minecraft' },
    });
    await waitFor(() => expect(result.current.status?.game).toBe('minecraft'));

    apiMock.volumeSessionAttach.mockReturnValue(new Promise(() => undefined));
    rerender({ game: 'palworld' });

    expect(result.current.status).toBeNull();
    expect(apiMock.volumeSessionDetach).toHaveBeenCalledWith('minecraft');
  });
});
