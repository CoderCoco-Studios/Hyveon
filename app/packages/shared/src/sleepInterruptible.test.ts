import { describe, expect, it } from 'vitest';
import { sleepInterruptible } from './sleepInterruptible.js';

describe('sleepInterruptible', () => {
  // @spec APP-LOGS-TAIL-007
  it('should resolve after the delay when the signal is never aborted', async () => {
    await expect(sleepInterruptible(1, new AbortController().signal)).resolves.toBeUndefined();
  });

  // @spec APP-LOGS-TAIL-007
  it('should reject with an AbortError as soon as the signal aborts mid-sleep', async () => {
    const ac = new AbortController();
    const pending = sleepInterruptible(60_000, ac.signal);
    ac.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  // @spec APP-LOGS-TAIL-007
  it('should reject immediately when the signal is already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(sleepInterruptible(60_000, ac.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });
});
