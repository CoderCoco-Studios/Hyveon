import { describe, it, expect, vi } from 'vitest';
import { verifyAccessKeyWithRetry, VERIFY_ACCESS_KEY_RETRY_DELAYS_MS } from './verifyAccessKeyWithRetry.js';

describe('verifyAccessKeyWithRetry', () => {
  it('should resolve without calling sleep when verify succeeds on the first attempt', async () => {
    const verify = vi.fn().mockResolvedValue(undefined);
    const sleep = vi.fn().mockResolvedValue(undefined);

    await verifyAccessKeyWithRetry(verify, { sleep });

    expect(verify).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('should retry and resolve once verify succeeds on a later attempt, without exceeding the needed number of calls', async () => {
    const verify = vi
      .fn()
      .mockRejectedValueOnce(new Error('not yet'))
      .mockRejectedValueOnce(new Error('still not yet'))
      .mockResolvedValueOnce(undefined);
    const sleep = vi.fn().mockResolvedValue(undefined);

    await verifyAccessKeyWithRetry(verify, { sleep });

    expect(verify).toHaveBeenCalledTimes(3);
  });

  it('should call sleep with each configured delay in order between failed attempts', async () => {
    const verify = vi
      .fn()
      .mockRejectedValueOnce(new Error('not yet'))
      .mockRejectedValueOnce(new Error('still not yet'))
      .mockResolvedValueOnce(undefined);
    const sleep = vi.fn().mockResolvedValue(undefined);

    await verifyAccessKeyWithRetry(verify, { sleep });

    expect(sleep.mock.calls.map((call) => call[0])).toEqual([
      VERIFY_ACCESS_KEY_RETRY_DELAYS_MS[0],
      VERIFY_ACCESS_KEY_RETRY_DELAYS_MS[1],
    ]);
  });

  it('should not call sleep after the final failed attempt before throwing', async () => {
    const error = new Error('always fails');
    const verify = vi.fn().mockRejectedValue(error);
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(verifyAccessKeyWithRetry(verify, { sleep })).rejects.toThrow(error);

    expect(verify).toHaveBeenCalledTimes(VERIFY_ACCESS_KEY_RETRY_DELAYS_MS.length + 1);
    expect(sleep).toHaveBeenCalledTimes(VERIFY_ACCESS_KEY_RETRY_DELAYS_MS.length);
  });

  it('should throw the original, unwrapped error after exhausting all attempts when verify always fails', async () => {
    const error = new Error('always fails');
    const verify = vi.fn().mockRejectedValue(error);
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(verifyAccessKeyWithRetry(verify, { sleep })).rejects.toBe(error);
  });

  it('should call onAttemptFailed once per failed attempt with the correct 1-based attempt number and totalAttempts', async () => {
    const error = new Error('always fails');
    const verify = vi.fn().mockRejectedValue(error);
    const sleep = vi.fn().mockResolvedValue(undefined);
    const onAttemptFailed = vi.fn();

    await expect(verifyAccessKeyWithRetry(verify, { sleep, onAttemptFailed })).rejects.toThrow(error);

    const totalAttempts = VERIFY_ACCESS_KEY_RETRY_DELAYS_MS.length + 1;
    expect(onAttemptFailed).toHaveBeenCalledTimes(totalAttempts);
    for (let i = 0; i < totalAttempts; i++) {
      expect(onAttemptFailed).toHaveBeenNthCalledWith(i + 1, i + 1, totalAttempts, error);
    }
  });

  it('should not call onAttemptFailed when the first attempt succeeds', async () => {
    const verify = vi.fn().mockResolvedValue(undefined);
    const sleep = vi.fn().mockResolvedValue(undefined);
    const onAttemptFailed = vi.fn();

    await verifyAccessKeyWithRetry(verify, { sleep, onAttemptFailed });

    expect(onAttemptFailed).not.toHaveBeenCalled();
  });

  it('should honor a custom delaysMs array, deriving totalAttempts as delaysMs.length + 1', async () => {
    const error = new Error('always fails');
    const verify = vi.fn().mockRejectedValue(error);
    const sleep = vi.fn().mockResolvedValue(undefined);
    const delaysMs = [10, 20];

    await expect(verifyAccessKeyWithRetry(verify, { sleep, delaysMs })).rejects.toThrow(error);

    expect(verify).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map((call) => call[0])).toEqual([10, 20]);
  });

  it('should default to VERIFY_ACCESS_KEY_RETRY_DELAYS_MS when delaysMs is not supplied', async () => {
    const error = new Error('always fails');
    const verify = vi.fn().mockRejectedValue(error);
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(verifyAccessKeyWithRetry(verify, { sleep })).rejects.toThrow(error);

    expect(sleep.mock.calls.map((call) => call[0])).toEqual([...VERIFY_ACCESS_KEY_RETRY_DELAYS_MS]);
  });
});
