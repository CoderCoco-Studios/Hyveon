import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import type { VolumeTransferProgress } from '@hyveon/shared/volumeFiles';
import { useVolumeTransfers } from './use-volume-transfers.hook.js';
import { makeTransfer } from './volume-files.test-utils.js';

const apiMock = vi.hoisted(() => ({ volumeOnTransfer: vi.fn() }));
vi.mock('../../api.service.js', () => ({ api: apiMock }));

let push: (progress: VolumeTransferProgress) => void;
const unsubscribe = vi.fn();

beforeEach(() => {
  apiMock.volumeOnTransfer.mockImplementation((cb: (progress: VolumeTransferProgress) => void) => {
    push = cb;
    return unsubscribe;
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('useVolumeTransfers', () => {
  it('should upsert pushed progress by transferId and keep first-seen order', () => {
    const { result } = renderHook(() => useVolumeTransfers('minecraft'));

    act(() => push(makeTransfer({ transferId: 'a' })));
    act(() => push(makeTransfer({ transferId: 'b' })));
    act(() => push(makeTransfer({ transferId: 'a', bytesDone: 10, phase: 'done' })));

    expect(result.current.map((t) => [t.transferId, t.phase])).toEqual([
      ['a', 'done'],
      ['b', 'running'],
    ]);
  });

  it('should ignore progress for other games', () => {
    const { result } = renderHook(() => useVolumeTransfers('minecraft'));

    act(() => push(makeTransfer({ game: 'palworld' })));

    expect(result.current).toEqual([]);
  });

  it('should drop the previous game transfers when the game changes', () => {
    const { result, rerender } = renderHook(({ game }) => useVolumeTransfers(game), {
      initialProps: { game: 'minecraft' },
    });
    act(() => push(makeTransfer()));
    expect(result.current).toHaveLength(1);

    rerender({ game: 'palworld' });

    expect(result.current).toEqual([]);
  });

  it('should call onUploadDone once when an upload settles as done', () => {
    const onUploadDone = vi.fn();
    renderHook(() => useVolumeTransfers('minecraft', onUploadDone));

    act(() => push(makeTransfer({ phase: 'running' })));
    act(() => push(makeTransfer({ transferId: 'd', kind: 'download', phase: 'done' })));
    act(() => push(makeTransfer({ transferId: 'f', phase: 'failed' })));
    expect(onUploadDone).not.toHaveBeenCalled();

    act(() => push(makeTransfer({ phase: 'done' })));
    expect(onUploadDone).toHaveBeenCalledOnce();
  });

  it('should unsubscribe on unmount', () => {
    const { unmount } = renderHook(() => useVolumeTransfers('minecraft'));
    unmount();
    expect(unsubscribe).toHaveBeenCalled();
  });
});
