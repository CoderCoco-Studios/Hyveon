import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { CloudHealthController } from './cloud-health.controller.js';
import type { CloudHealthService, CloudHealthCheck } from '../services/CloudHealthService.js';

/** Builds a stub {@link CloudHealthService} whose `getChecks()` returns the given fixed set of checks. */
function makeService(checks: CloudHealthCheck[]): CloudHealthService {
  return { getChecks: vi.fn().mockReturnValue(checks) } as Partial<CloudHealthService> as CloudHealthService;
}

describe('CloudHealthController.list', () => {
  it('should return one summary per registered check', async () => {
    const check: CloudHealthCheck = {
      id: 'ecs-service-linked-role',
      label: 'ECS service-linked role',
      check: vi.fn().mockResolvedValue({ status: 'ok' }),
      fix: vi.fn(),
    };
    const controller = new CloudHealthController(makeService([check]));

    const result = await controller.list();

    expect(result).toEqual([{ id: 'ecs-service-linked-role', label: 'ECS service-linked role', status: 'ok' }]);
  });
});

describe('CloudHealthController.fix', () => {
  it('should call fix() on the matching check', async () => {
    const check: CloudHealthCheck = {
      id: 'ecs-service-linked-role',
      label: 'ECS service-linked role',
      check: vi.fn(),
      fix: vi.fn().mockResolvedValue({ outcome: 'fixed' }),
    };
    const controller = new CloudHealthController(makeService([check]));

    const result = await controller.fix({ id: 'ecs-service-linked-role' });

    expect(result).toEqual({ outcome: 'fixed' });
  });

  it('should return a failed outcome for an unknown check id', async () => {
    const controller = new CloudHealthController(makeService([]));

    const result = await controller.fix({ id: 'nonexistent' });

    expect(result).toEqual({ outcome: 'failed', message: 'Unknown health check id: nonexistent' });
  });
});
