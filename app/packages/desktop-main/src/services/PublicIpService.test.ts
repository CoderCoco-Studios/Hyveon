import 'reflect-metadata';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { PublicIpService } from './PublicIpService.js';

afterEach(() => vi.unstubAllGlobals());

/** Stubs global fetch to resolve with `body` and `status`. */
function stubFetch(body: string, status = 200): ReturnType<typeof vi.fn> {
  const fn = vi.fn().mockResolvedValue(new Response(body, { status }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

describe('PublicIpService', () => {
  // @spec HELPER-REACH-001
  it('should return the trimmed IPv4 from checkip.amazonaws.com over HTTPS', async () => {
    const fn = stubFetch('203.0.113.7\n');
    expect(await new PublicIpService().detect()).toBe('203.0.113.7');
    expect(fn.mock.calls[0]![0]).toBe('https://checkip.amazonaws.com');
  });

  it('should reject a response that is not an IPv4 address', async () => {
    stubFetch('<html>captive portal</html>');
    await expect(new PublicIpService().detect()).rejects.toThrow(/not an IPv4/);
  });

  it('should reject an out-of-range octet', async () => {
    stubFetch('300.1.1.1');
    await expect(new PublicIpService().detect()).rejects.toThrow(/Could not detect/);
  });

  it('should reject a non-2xx response', async () => {
    stubFetch('nope', 503);
    await expect(new PublicIpService().detect()).rejects.toThrow(/HTTP 503/);
  });

  it('should reject with a normalized message when the request fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    await expect(new PublicIpService().detect()).rejects.toThrow('Could not detect your public IP address: offline');
  });
});
