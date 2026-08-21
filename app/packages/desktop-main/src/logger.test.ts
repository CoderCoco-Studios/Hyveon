import { describe, it, expect } from 'vitest';
import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';

/**
 * Re-import logger module fresh for each test that cares about the singleton
 * state.  We use a plain import at the top for the factory tests; the
 * singleton re-assignment tests use the same module reference.
 */
import { createLogger, __testing, logger as initialLogger } from './logger.js';

const { devPrintf } = __testing;

describe('createLogger', () => {
  it('should return a winston.Logger instance', () => {
    const result = createLogger('/tmp/test-logs');
    // Winston's createLogger returns a DerivedLogger that extends EventEmitter.
    // Check the duck-typed API surface rather than constructor identity, which
    // can differ when the same package is loaded from two module cache entries.
    expect(typeof result.info).toBe('function');
    expect(typeof result.error).toBe('function');
    expect(typeof result.debug).toBe('function');
    expect(Array.isArray(result.transports)).toBe(true);
  });

  it('should include a DailyRotateFile transport in the transports array', () => {
    const result = createLogger('/tmp/test-logs');
    const hasRotate = result.transports.some((t) => t instanceof DailyRotateFile);
    expect(hasRotate).toBe(true);
  });

  it('should include a Console transport in the transports array', () => {
    const result = createLogger('/tmp/test-logs');
    const hasConsole = result.transports.some(
      (t) => t instanceof winston.transports.Console,
    );
    expect(hasConsole).toBe(true);
  });

  it('should configure the DailyRotateFile transport with the provided logDir', () => {
    const logDir = '/tmp/my-custom-log-dir';
    const result = createLogger(logDir);
    const rotateTransport = result.transports.find(
      (t) => t instanceof DailyRotateFile,
    ) as InstanceType<typeof DailyRotateFile> | undefined;

    expect(rotateTransport).toBeDefined();
    // The `dirname` option is stored as `options.dirname` on the transport.
    const opts = (rotateTransport as unknown as { options: { dirname: string } })
      .options;
    expect(opts.dirname).toBe(logDir);
  });
});

describe('devPrintf multi-line formatting', () => {
  /** Runs `devPrintf` against a winston `info`-shaped object the way a real transport would. */
  function format(message: string, meta: Record<string, unknown>): string {
    const info = { timestamp: '09:20:51', level: 'debug', message, ...meta };
    const result = devPrintf.transform(info, {}) as unknown as Record<symbol, string>;
    return result[Symbol.for('message')]!;
  }

  it('should prefix every physical line of a multi-line meta payload with timestamp and level', () => {
    const output = format('reading log file tail', { maxLines: 500, nested: { deep: true } });

    const lines = output.split('\n');
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(line).toMatch(/^09:20:51 \[debug\]/);
    }
  });

  it('should indent continuation lines relative to the first line', () => {
    const output = format('reading log file tail', { maxLines: 500 });

    const lines = output.split('\n');
    expect(lines[0]).toBe('09:20:51 [debug] reading log file tail');
    expect(lines[1]).toBe('09:20:51 [debug] \t{');
    expect(lines[2]).toBe('09:20:51 [debug] \t  "maxLines": 500');
    expect(lines[3]).toBe('09:20:51 [debug] \t}');
  });

  it('should not append a meta block when there is no meta payload', () => {
    const output = format('simple message', {});
    expect(output).toBe('09:20:51 [debug] simple message');
  });
});

describe('logger singleton', () => {
  it('should reassign the exported logger binding when createLogger is called', async () => {
    // Capture the initial (console-only) reference.
    const beforeCall = initialLogger;

    // createLogger mutates the exported binding.
    const returned = createLogger('/tmp/test-logs-singleton');

    // The returned value and the freshly-imported binding must be the same object.
    // We re-import via the same module to read the live binding.
    const { logger: afterCall } = await import('./logger.js');
    expect(afterCall).toBe(returned);
    // And it must differ from the pre-call fallback logger.
    expect(afterCall).not.toBe(beforeCall);
  });
});
