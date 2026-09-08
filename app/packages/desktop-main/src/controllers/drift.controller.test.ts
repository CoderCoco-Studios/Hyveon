import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import type { DriftReport } from '@hyveon/shared';
import { DriftController } from './drift.controller.js';
import type { DriftService } from '../services/DriftService.js';
import { expectChannels } from '../testing/message-pattern.test-utils.js';

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

/** Default drift report used by most tests. */
const DEFAULT_REPORT: DriftReport = {
  entries: [{ game: 'minecraft', kind: 'config_drift', changedFields: ['cpu'] }],
};

/** Build a DriftService stub with `getDrift` pre-wired to resolve `report`. */
function makeDrift(report: DriftReport = DEFAULT_REPORT): DriftService {
  return {
    getDrift: vi.fn().mockResolvedValue(report),
  } as Partial<DriftService> as DriftService;
}

describe('DriftController', () => {
  describe('@MessagePattern channel names', () => {
    it('should register every channel', () => {
      expectChannels(DriftController.prototype, [['get', 'drift.get']] as const);
    });
  });

  describe('get', () => {
    it('should return the DriftReport from DriftService', async () => {
      const result = await new DriftController(makeDrift()).get();
      expect(result).toEqual(DEFAULT_REPORT);
    });

    it('should delegate to DriftService.getDrift', async () => {
      const drift = makeDrift();
      await new DriftController(drift).get();
      expect(drift.getDrift).toHaveBeenCalledOnce();
    });

    it('should return an empty entries list when there is no drift', async () => {
      const drift = makeDrift({ entries: [] });
      const result = await new DriftController(drift).get();
      expect(result).toEqual({ entries: [] });
    });
  });
});
