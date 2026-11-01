import { describe, expect, it } from 'vitest';
import { settleVolumeResult, sortVolumeEntries } from './volume-files.utils.js';
import { makeDirEntry, makeFileEntry } from './volume-files.test-utils.js';

// @spec HELPER-FB-024
describe('sortVolumeEntries', () => {
  it('should order names case-insensitively with a deterministic tiebreak', () => {
    const sorted = sortVolumeEntries([makeFileEntry('b'), makeFileEntry('a'), makeFileEntry('B'), makeFileEntry('A')], {
      key: 'name',
      dir: 'asc',
    });
    expect(sorted.map((e) => e.name)).toEqual(['A', 'a', 'B', 'b']);
  });

  it('should reverse files but keep folders first when descending', () => {
    const sorted = sortVolumeEntries([makeFileEntry('a'), makeDirEntry('x'), makeFileEntry('b'), makeDirEntry('y')], {
      key: 'name',
      dir: 'desc',
    });
    expect(sorted.map((e) => e.name)).toEqual(['y', 'x', 'b', 'a']);
  });

  it('should sort by modified time and fall back to name on ties', () => {
    const sorted = sortVolumeEntries([makeFileEntry('b', 1, 5), makeFileEntry('a', 1, 5), makeFileEntry('c', 1, 1)], {
      key: 'modifiedMs',
      dir: 'asc',
    });
    expect(sorted.map((e) => e.name)).toEqual(['c', 'a', 'b']);
  });

  it('should not mutate the input array', () => {
    const entries = [makeFileEntry('b'), makeFileEntry('a')];
    sortVolumeEntries(entries, { key: 'name', dir: 'asc' });
    expect(entries.map((e) => e.name)).toEqual(['b', 'a']);
  });
});

describe('settleVolumeResult', () => {
  it('should pass a result through unchanged', async () => {
    await expect(settleVolumeResult(async () => ({ ok: true, value: 1 }))).resolves.toEqual({ ok: true, value: 1 });
  });

  it('should convert a rejection into a failed result carrying the message', async () => {
    const result = await settleVolumeResult(async () => {
      throw new Error('boom');
    });
    expect(result).toEqual({ ok: false, code: 'failed', message: 'boom' });
  });

  it('should convert a non-Error rejection into its string form', async () => {
    const result = await settleVolumeResult(() => Promise.reject('plain'));
    expect(result).toEqual({ ok: false, code: 'failed', message: 'plain' });
  });
});
