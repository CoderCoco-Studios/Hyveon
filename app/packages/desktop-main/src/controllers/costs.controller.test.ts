import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import { CostsController } from './costs.controller.js';
import type { ConfigService } from '../services/ConfigService.js';
import type { CostService } from '../services/CostService.js';
import type { EcsService } from '../services/EcsService.js';
import type { StackOutputs } from '@hyveon/shared';
import { configServiceStub } from '../testing/config-service.fixture.js';
import { stackOutputs } from '../testing/stack-outputs.fixture.js';

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

/** A canned estimate object returned by CostService stubs. */
const MOCK_ESTIMATE = {
  vcpu: 4,
  memoryGb: 16,
  costPerHour: 0.5,
  costPerDay24h: 12,
  costPerMonth4hpd: 60,
};

/** Build a ConfigService stub with a minimal set of stack outputs, or `null` to simulate an undeployed stack. */
function makeConfig(overrides: Partial<StackOutputs> | null = { gameNames: ['minecraft'] }): ConfigService {
  return configServiceStub({ outputs: overrides === null ? null : stackOutputs(overrides) });
}

/** Build a CostService stub whose estimateForSpec returns the canned estimate. */
function makeCosts(): CostService {
  return {
    estimateForSpec: vi.fn().mockReturnValue(MOCK_ESTIMATE),
  } as CostService;
}

/**
 * Build an EcsService stub. Pass `null` to simulate a missing task definition
 * (e.g. the game has never been deployed).
 */
function makeEcs(td: { cpu: number; memory: number } | null = { cpu: 4096, memory: 16384 }): EcsService {
  return {
    getTaskDefinition: vi.fn().mockResolvedValue(td),
  } as unknown as EcsService;
}

/**
 * The metadata key NestJS stores on each method decorated with
 * `@MessagePattern`. Asserting this value is the only automated guard
 * that prevents a typo in the controller from silently breaking IPC —
 * calling the method directly (as every other test does) would succeed
 * regardless of what string is registered with the transport.
 */
const PATTERN_METADATA_KEY = 'microservices:pattern';

describe('CostsController', () => {
  describe('@MessagePattern channel names', () => {
    it('should register estimate on the "costs.estimate" IPC channel', () => {
      const pattern = Reflect.getMetadata(PATTERN_METADATA_KEY, CostsController.prototype.estimate);
      expect(pattern).toEqual(['costs.estimate']);
    });

    it('should not register an actual handler', () => {
      const controller = new CostsController(makeConfig(), makeCosts(), makeEcs());
      expect('actual' in controller).toBe(false);
    });
  });

  describe('estimate', () => {
    it('should return zeroed estimates when stack outputs are missing', async () => {
      const result = await new CostsController(makeConfig(null), makeCosts(), makeEcs()).estimate();
      expect(result).toEqual({ games: {}, totalPerHourIfAllOn: 0 });
    });

    it('should call getTaskDefinition and estimateForSpec for each game', async () => {
      const ecs = makeEcs();
      const costs = makeCosts();
      await new CostsController(makeConfig(), costs, ecs).estimate();
      expect(ecs.getTaskDefinition).toHaveBeenCalledWith('minecraft');
      expect(costs.estimateForSpec).toHaveBeenCalledWith(4096, 16384);
    });

    it('should fall back to 2048 cpu / 8192 memory when getTaskDefinition returns null', async () => {
      const ecs = makeEcs(null);
      const costs = makeCosts();
      await new CostsController(makeConfig(), costs, ecs).estimate();
      expect(costs.estimateForSpec).toHaveBeenCalledWith(2048, 8192);
    });

    it('should sum costPerHour across all games for totalPerHourIfAllOn', async () => {
      const config = makeConfig({ gameNames: ['minecraft', 'palworld'] });
      const costs = makeCosts();
      vi.mocked(costs.estimateForSpec).mockReturnValue({ ...MOCK_ESTIMATE, costPerHour: 0.25 });
      const result = await new CostsController(config, costs, makeEcs()).estimate();
      // 2 games × $0.25/hr = $0.50/hr, rounded to 4 decimal places
      expect(result.totalPerHourIfAllOn).toBe(0.5);
    });

    it('should include an estimate entry for each game', async () => {
      const config = makeConfig({ gameNames: ['minecraft', 'palworld'] });
      const result = await new CostsController(config, makeCosts(), makeEcs()).estimate();
      expect(Object.keys(result.games)).toEqual(['minecraft', 'palworld']);
    });
  });
});
