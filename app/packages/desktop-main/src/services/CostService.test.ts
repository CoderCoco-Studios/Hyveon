import { describe, it, expect, beforeEach, vi } from 'vitest';
import { estimateFargateHourlyCost } from '@hyveon/shared';

vi.mock('@hyveon/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@hyveon/shared')>();
  return { ...actual, estimateFargateHourlyCost: vi.fn(actual.estimateFargateHourlyCost) };
});
import { CostService } from './CostService.js';

describe('CostService', () => {
  let service: CostService;

  beforeEach(() => {
    service = new CostService();
  });

  // @spec RT-TASK-COST-010
  it('should report the same hourly cost as the wizard estimate for every Fargate pairing', () => {
    for (const [cpu, memory] of [[256, 512], [1024, 2048], [2048, 8192], [4096, 30720]] as const) {
      expect(service.estimateForSpec(cpu, memory).costPerHour).toBe(estimateFargateHourlyCost(cpu, memory));
    }
  });

  // @spec RT-TASK-COST-010
  it('should take costPerHour from the shared pricing function', () => {
    vi.mocked(estimateFargateHourlyCost).mockReturnValueOnce(7.7777);

    expect(service.estimateForSpec(1024, 2048).costPerHour).toBe(7.7777);
    expect(estimateFargateHourlyCost).toHaveBeenCalledWith(1024, 2048);
  });

  // @spec RT-TASK-COST-007
  describe('estimateForSpec', () => {
    it('should compute Fargate hourly, daily, and monthly costs for 1 vCPU + 2 GiB', () => {
      const est = service.estimateForSpec(1024, 2048);
      expect(est.vcpu).toBe(1);
      expect(est.memoryGb).toBe(2);
      // 1 * 0.04048 + 2 * 0.004445 = 0.04937
      expect(est.costPerHour).toBeCloseTo(0.0494, 4);
      // 0.04937 * 24 = 1.18488 -> 1.18
      expect(est.costPerDay24h).toBeCloseTo(1.18, 2);
      // 0.04937 * 4 * 30 = 5.9244 -> 5.92
      expect(est.costPerMonth4hpd).toBeCloseTo(5.92, 2);
    });

    it('should scale cost linearly with CPU and memory', () => {
      const half = service.estimateForSpec(512, 1024);
      const full = service.estimateForSpec(1024, 2048);
      expect(half.costPerHour).toBeCloseTo(full.costPerHour / 2, 6);
    });

    it('should round hourly cost to at most 4 decimals', () => {
      const est = service.estimateForSpec(256, 512);
      expect(Number.isFinite(est.costPerHour)).toBe(true);
      const decimals = est.costPerHour.toString().split('.')[1] ?? '';
      expect(decimals.length).toBeLessThanOrEqual(4);
    });
  });

  // @spec RT-TASK-COST-001, RT-TASK-COST-002
  it('should not expose a getActualCosts method', () => {
    expect('getActualCosts' in service).toBe(false);
  });
});
