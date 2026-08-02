import { describe, it, expect, beforeEach } from 'vitest';

/**
 * Exercises the non-dev (`NODE_ENV=production`) branch of `logger.ts`'s
 * `isDev`-gated format/level ternaries. `isDev` is computed once at module
 * load time, so this lives in its own file (rather than alongside
 * `logger.test.ts`) — setting `NODE_ENV` and dynamically importing the
 * module fresh here can't disturb `logger.test.ts`'s own module-identity
 * assertions, which depend on a stable, un-reset module cache.
 */
describe('logger (NODE_ENV=production)', () => {
  beforeEach(() => {
    process.env['NODE_ENV'] = 'production';
  });

  it('should build a working console-only singleton via the non-dev format branch', async () => {
    const { logger } = await import('./logger.js');

    expect(typeof logger.info).toBe('function');
    expect(logger.level).toBe('info');
  });

  it('should build a working full logger via the non-dev format branch', async () => {
    const { createLogger } = await import('./logger.js');
    const result = createLogger('/tmp/test-logs-prod');

    expect(typeof result.info).toBe('function');
    expect(result.level).toBe('info');
  });
});
