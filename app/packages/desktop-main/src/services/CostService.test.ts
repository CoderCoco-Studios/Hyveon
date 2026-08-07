import { describe, it, expect, beforeEach } from 'vitest';
import { CostService } from './CostService.js';

describe('CostService', () => {
  let service: CostService;

  beforeEach(() => {
    service = new CostService();
  });

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

  it('should not expose a getActualCosts method', () => {
    expect('getActualCosts' in service).toBe(false);
  });
});
