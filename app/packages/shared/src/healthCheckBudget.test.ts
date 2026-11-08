import { describe, expect, it } from 'vitest';
import {
  HEALTH_CHECK_RUN_BUDGET_MS,
  HEALTH_CHECK_SECRET_DEADLINE_MS,
  HEALTH_CHECK_TIMEOUT_MAX_MS,
} from './healthCheckBudget.js';

describe('health-check time budget', () => {
  // @spec RT-HEALTH-FAIL-006
  it('should fit the secret deadline plus the largest declared timeoutMs inside the per-run budget', () => {
    expect(HEALTH_CHECK_SECRET_DEADLINE_MS + HEALTH_CHECK_TIMEOUT_MAX_MS).toBeLessThanOrEqual(HEALTH_CHECK_RUN_BUDGET_MS);
  });

  // @spec RT-WATCHDOG-HC-006
  it('should leave the watchdog room inside its 60 s timeout for non-health-check work', () => {
    expect(HEALTH_CHECK_RUN_BUDGET_MS).toBeLessThan(60_000);
  });
});
