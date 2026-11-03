import { afterEach, describe, expect, it, vi } from 'vitest';
import { patchInteractionOriginal } from './patchOriginal.js';

describe('patchInteractionOriginal', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // @spec DISCORD-RUN-014
  it('should log and swallow a rejected fetch without leaking the token', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('fetch failed')));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(patchInteractionOriginal('app', 'SECRET-TOKEN-xyz', 'hi')).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('SECRET-TOKEN-xyz');
  });

  // @spec DISCORD-RUN-015
  it('should log the status and body of a non-2xx response without throwing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404, text: async () => 'nope' }));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(patchInteractionOriginal('app', 'tok', 'hi')).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledWith('Discord PATCH failed', { status: 404, body: 'nope' });
  });
});
