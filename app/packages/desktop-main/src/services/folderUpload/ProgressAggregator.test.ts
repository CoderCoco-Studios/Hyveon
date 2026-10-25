import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FolderUploadProgress } from '@hyveon/shared/folderUpload';
import { PROGRESS_INTERVAL_MS, ProgressAggregator } from './ProgressAggregator.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/** Builds an aggregator driven by the fake clock, collecting every emission. */
function make(bytesTotal = 1000, filesTotal = 4) {
  const emitted: FolderUploadProgress[] = [];
  const agg = new ProgressAggregator('minecraft', bytesTotal, filesTotal, (p) => emitted.push(p), () => Date.now());
  return { agg, emitted };
}

describe('ProgressAggregator', () => {
  it('should emit about every 500 ms while started and once more on stop', () => {
    const { agg, emitted } = make();
    agg.start();
    vi.advanceTimersByTime(PROGRESS_INTERVAL_MS * 3);
    agg.stop();
    expect(emitted).toHaveLength(1 + 3 + 1);
  });

  it('should report bytes, files and the current path from the counters', () => {
    const { agg } = make();
    agg.setPhase('uploading');
    agg.setCurrent('Data/a.db');
    agg.addBytes(250);
    agg.fileDone();
    expect(agg.snapshot()).toMatchObject({ phase: 'uploading', bytesDone: 250, bytesTotal: 1000, filesDone: 1, filesTotal: 4, currentPath: 'Data/a.db' });
  });

  it('should roll counted bytes back when a failed attempt subtracts them, never below zero', () => {
    const { agg } = make();
    agg.addBytes(100);
    agg.addBytes(-100);
    agg.addBytes(-5);
    expect(agg.snapshot().bytesDone).toBe(0);
  });

  it('should smooth the rate and only report an ETA after enough samples', () => {
    const { agg } = make(10_000);
    agg.setPhase('uploading');
    agg.start();
    agg.addBytes(500);
    vi.advanceTimersByTime(PROGRESS_INTERVAL_MS);
    expect(agg.snapshot().etaSeconds).toBeUndefined();
    agg.addBytes(500);
    vi.advanceTimersByTime(PROGRESS_INTERVAL_MS);
    agg.addBytes(500);
    vi.advanceTimersByTime(PROGRESS_INTERVAL_MS);
    const snap = agg.snapshot();
    expect(snap.bytesPerSecond).toBe(1000);
    expect(snap.etaSeconds).toBe(Math.ceil((10_000 - 1500) / 1000));
    agg.stop();
  });

  it('should carry the failure message and clear the current path when the phase changes', () => {
    const { agg, emitted } = make();
    agg.setPhase('uploading');
    agg.setCurrent('x');
    agg.setPhase('failed', 'boom');
    expect(emitted.at(-1)).toMatchObject({ phase: 'failed', error: 'boom', currentPath: undefined });
  });
});
