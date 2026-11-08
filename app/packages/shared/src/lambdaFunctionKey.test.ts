import { describe, expect, it, expectTypeOf } from 'vitest';
import { LAMBDA_FUNCTION_KEYS, type LambdaFunctionKey } from './lambdaFunctionKey.js';

describe('LAMBDA_FUNCTION_KEYS', () => {
  // @spec APP-LOGS-GROUP-007
  it('should be derived from the same declaration as the LambdaFunctionKey union', () => {
    expectTypeOf<(typeof LAMBDA_FUNCTION_KEYS)[number]>().toEqualTypeOf<LambdaFunctionKey>();
    expect(Object.isFrozen(LAMBDA_FUNCTION_KEYS)).toBe(true);
    expect([...LAMBDA_FUNCTION_KEYS]).toEqual(['watchdog', 'health-check', 'dns-updater', 'interactions', 'followup']);
  });
});
