import { describe, it, expect, vi, beforeEach } from 'vitest';

const loggerMock = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock('../logger.js', () => ({ logger: loggerMock }));

import { assertInstallRegionUnlocked, lockInstallRegion } from './install-region-lock.js';
import type { ElectronStoreService } from './ElectronStoreService.js';

/** Plain-object-backed store stub so `set` then `get` round-trips. */
function makeStore(seed: Record<string, unknown> = {}): ElectronStoreService {
  const data = { ...seed };
  return {
    get: vi.fn((key: string) => data[key]),
    set: vi.fn((key: string, value: unknown) => {
      data[key] = value;
    }),
  } as Partial<ElectronStoreService> as ElectronStoreService;
}

// @spec APP-WIZARD-REGLOCK-001
describe('install region lock', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('lockInstallRegion', () => {
    it('should record the wizard region as the lock', () => {
      const store = makeStore({ aws: { region: 'eu-west-1' } });

      lockInstallRegion(store);

      expect(store.set).toHaveBeenCalledWith('installRegionLock', 'eu-west-1');
    });

    it('should leave an existing lock untouched', () => {
      const store = makeStore({ aws: { region: 'eu-west-1' }, installRegionLock: 'eu-west-1' });

      lockInstallRegion(store);

      expect(store.set).not.toHaveBeenCalled();
    });

    it('should not lock when no region is stored, since bootstrap cannot create anything without one', () => {
      const store = makeStore({});

      lockInstallRegion(store);

      expect(store.set).not.toHaveBeenCalled();
    });

    it('should throw and log when the lock cannot be persisted', () => {
      const store = makeStore({ aws: { region: 'eu-west-1' } });
      vi.mocked(store.set).mockImplementation(() => {
        throw new Error('disk full');
      });

      expect(() => lockInstallRegion(store)).toThrow(/region lock.*no resources were created/);
      expect(loggerMock.error).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ error: 'disk full' }));
    });
  });

  describe('assertInstallRegionUnlocked', () => {
    it('should refuse a different region once the lock marker is stored, with no bootstrap record', () => {
      const store = makeStore({ aws: { region: 'us-east-1' }, installRegionLock: 'us-east-1' });

      expect(() => assertInstallRegionUnlocked(store, 'eu-west-1')).toThrow(/locked to us-east-1.*Start over/s);
    });

    it('should compare against the locked region, not the current aws.region', () => {
      const store = makeStore({ aws: { region: 'eu-west-1' }, installRegionLock: 'us-east-1' });

      expect(() => assertInstallRegionUnlocked(store, 'eu-west-1')).toThrow(/locked to us-east-1/);
      expect(() => assertInstallRegionUnlocked(store, 'us-east-1')).not.toThrow();
    });

    it('should treat a stored bootstrap record as a lock on installs that predate the marker', () => {
      const store = makeStore({ aws: { region: 'us-east-1' }, bootstrap: { stateBucket: 's', configurationBucket: 'c' } });

      expect(() => assertInstallRegionUnlocked(store, 'eu-west-1')).toThrow(/locked to us-east-1/);
    });

    it('should allow any region before bootstrap has started', () => {
      const store = makeStore({ aws: { region: 'us-east-1' } });

      expect(() => assertInstallRegionUnlocked(store, 'eu-west-1')).not.toThrow();
    });

    it('should allow a call that carries no region', () => {
      const store = makeStore({ installRegionLock: 'us-east-1' });

      expect(() => assertInstallRegionUnlocked(store, undefined)).not.toThrow();
    });
  });
});
