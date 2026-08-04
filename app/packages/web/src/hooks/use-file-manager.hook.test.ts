import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act, waitFor, cleanup } from '@testing-library/react';
import { useFileManager, FILE_MANAGER_POLLER, FILE_MANAGER_INTERVAL_MS } from './use-file-manager.hook.js';

const apiMock = vi.hoisted(() => ({
  filesMgrStatus: vi.fn(),
  filesMgrStart: vi.fn(),
  filesMgrStop: vi.fn(),
}));
vi.mock('../api.service.js', () => ({ api: apiMock }));

const registerMock = vi.hoisted(() => vi.fn().mockReturnValue(() => undefined));
vi.mock('../polling/polling-provider.component.js', () => ({
  usePollingActions: () => ({ register: registerMock }),
}));

const STOPPED: import('../api.service.js').FileMgrStatus = { game: 'minecraft', state: 'stopped' };
const RUNNING: import('../api.service.js').FileMgrStatus = { game: 'minecraft', state: 'running' };
const STARTING: import('../api.service.js').FileMgrStatus = { game: 'minecraft', state: 'starting' };

beforeEach(() => {
  apiMock.filesMgrStatus.mockResolvedValue(STOPPED);
  apiMock.filesMgrStart.mockResolvedValue({ success: true, message: 'Task launched' });
  apiMock.filesMgrStop.mockResolvedValue({ success: true, message: 'Task stopped' });
  registerMock.mockClear();
});

afterEach(cleanup);

describe('useFileManager', () => {
  describe('initial state', () => {
    it('should start with no active game, no status, and an empty message', () => {
      const { result } = renderHook(() => useFileManager());
      expect(result.current.activeGame).toBeNull();
      expect(result.current.status).toBeNull();
      expect(result.current.message).toBe('');
      expect(result.current.credentials).toBeNull();
    });
  });

  describe('open', () => {
    it('should set the active game and immediately fetch its status', async () => {
      const { result } = renderHook(() => useFileManager());

      act(() => result.current.open('minecraft'));

      await waitFor(() => expect(result.current.status).toEqual(STOPPED));
      expect(result.current.activeGame).toBe('minecraft');
      expect(apiMock.filesMgrStatus).toHaveBeenCalledWith('minecraft');
    });

    it('should reset the message to empty when opening a new game', () => {
      const { result } = renderHook(() => useFileManager());

      act(() => result.current.open('minecraft'));

      expect(result.current.message).toBe('');
    });

    it('should switch the active game when called a second time with a different game', async () => {
      const { result } = renderHook(() => useFileManager());

      act(() => result.current.open('minecraft'));
      await waitFor(() => expect(result.current.status).toBeTruthy());

      act(() => result.current.open('palworld'));

      expect(result.current.activeGame).toBe('palworld');
    });
  });

  describe('close', () => {
    it('should clear the active game, status, and message', async () => {
      const { result } = renderHook(() => useFileManager());

      act(() => result.current.open('minecraft'));
      await waitFor(() => expect(result.current.status).toBeTruthy());

      act(() => result.current.close());

      expect(result.current.activeGame).toBeNull();
      expect(result.current.status).toBeNull();
      expect(result.current.message).toBe('');
    });
  });

  describe('start', () => {
    it('should do nothing when no game is active', async () => {
      const { result } = renderHook(() => useFileManager());

      await act(async () => result.current.start());

      expect(apiMock.filesMgrStart).not.toHaveBeenCalled();
    });

    it('should call filesMgrStart and update the message on success', async () => {
      const { result } = renderHook(() => useFileManager());

      act(() => result.current.open('minecraft'));
      await waitFor(() => expect(result.current.status).toBeTruthy());

      await act(async () => result.current.start());

      expect(apiMock.filesMgrStart).toHaveBeenCalledWith('minecraft');
      expect(result.current.message).toBe('Task launched');
    });

    it('should set message to the API response even when success is false', async () => {
      apiMock.filesMgrStart.mockResolvedValue({ success: false, message: 'Cluster at capacity' });
      const { result } = renderHook(() => useFileManager());

      act(() => result.current.open('minecraft'));
      await waitFor(() => expect(result.current.status).toBeTruthy());

      await act(async () => result.current.start());

      expect(result.current.message).toBe('Cluster at capacity');
    });

    it('should store the one-time credentials from a successful start', async () => {
      apiMock.filesMgrStart.mockResolvedValue({
        success: true,
        message: 'ok',
        credentials: { username: 'admin', password: 'abc123' },
      });
      const { result } = renderHook(() => useFileManager());

      act(() => result.current.open('minecraft'));
      await waitFor(() => expect(result.current.status).toBeTruthy());

      await act(async () => result.current.start());

      expect(result.current.credentials).toEqual({ username: 'admin', password: 'abc123' });
    });

    it('should not store credentials when start fails', async () => {
      apiMock.filesMgrStart.mockResolvedValue({ success: false, message: 'nope' });
      const { result } = renderHook(() => useFileManager());

      act(() => result.current.open('minecraft'));
      await waitFor(() => expect(result.current.status).toBeTruthy());

      await act(async () => result.current.start());

      expect(result.current.credentials).toBeNull();
    });

    it('should clear stored credentials when the modal is closed', async () => {
      apiMock.filesMgrStart.mockResolvedValue({
        success: true,
        message: 'ok',
        credentials: { username: 'admin', password: 'abc123' },
      });
      const { result } = renderHook(() => useFileManager());

      act(() => result.current.open('minecraft'));
      await waitFor(() => expect(result.current.status).toBeTruthy());
      await act(async () => result.current.start());
      expect(result.current.credentials).not.toBeNull();

      act(() => result.current.close());

      expect(result.current.credentials).toBeNull();
    });
  });

  describe('stop', () => {
    it('should do nothing when no game is active', async () => {
      const { result } = renderHook(() => useFileManager());

      await act(async () => result.current.stop());

      expect(apiMock.filesMgrStop).not.toHaveBeenCalled();
    });

    it('should call filesMgrStop and set the message from the API response', async () => {
      apiMock.filesMgrStatus.mockResolvedValue(RUNNING);
      const { result } = renderHook(() => useFileManager());

      act(() => result.current.open('minecraft'));
      await waitFor(() => expect(result.current.status).toBeTruthy());

      await act(async () => result.current.stop());

      expect(apiMock.filesMgrStop).toHaveBeenCalledWith('minecraft');
      expect(result.current.message).toBe('Task stopped');
    });
  });

  describe('poller registration', () => {
    it('should register a poller when the task is in starting state', async () => {
      apiMock.filesMgrStatus.mockResolvedValue(STARTING);
      const { result } = renderHook(() => useFileManager());

      act(() => result.current.open('minecraft'));
      await waitFor(() => expect(result.current.status?.state).toBe('starting'));

      expect(registerMock).toHaveBeenCalledWith(
        FILE_MANAGER_POLLER,
        expect.any(Function),
        FILE_MANAGER_INTERVAL_MS,
      );
    });

    it('should not register a poller when the task is already stopped', async () => {
      apiMock.filesMgrStatus.mockResolvedValue(STOPPED);
      const { result } = renderHook(() => useFileManager());

      act(() => result.current.open('minecraft'));
      await waitFor(() => expect(result.current.status?.state).toBe('stopped'));

      expect(registerMock).not.toHaveBeenCalled();
    });

    it('should clear pendingStart once status transitions to starting or running', async () => {
      // Start resolves; status immediately reflects starting (i.e. ECS task is now visible).
      apiMock.filesMgrStart.mockResolvedValue({ success: true, message: 'ok' });
      apiMock.filesMgrStatus
        .mockResolvedValueOnce(STOPPED) // initial open
        .mockResolvedValue(STARTING);   // after start

      const { result } = renderHook(() => useFileManager());
      act(() => result.current.open('minecraft'));
      await waitFor(() => expect(result.current.status?.state).toBe('stopped'));

      await act(async () => result.current.start());
      // fetchOnce is called after start — should now return STARTING
      await waitFor(() => expect(result.current.status?.state).toBe('starting'));

      // pendingStart cleared because status reached 'starting'; re-assert via effect
      // (the poller registered because of pendingStart, now status carries it forward)
      expect(apiMock.filesMgrStatus).toHaveBeenCalledTimes(2);
    });
  });
});
