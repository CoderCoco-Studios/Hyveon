import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import { GameWizardDraftService } from './GameWizardDraftService.js';
import type { ElectronStoreService, GameWizardDraft, StoredGameWizardDraft } from './ElectronStoreService.js';
import { logger } from '../logger.js';

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

/** Build an `ElectronStoreService` stub whose `get`/`set`/`delete` calls are observable/overridable per test. */
function makeStore(initial?: StoredGameWizardDraft): ElectronStoreService {
  let current = initial;
  const stub: Partial<ElectronStoreService> = {
    get: vi.fn((key: string) => (key === 'addGameWizardDraft' ? current : undefined)) as ElectronStoreService['get'],
    set: vi.fn((_key: string, value: unknown) => {
      current = value as StoredGameWizardDraft;
    }) as ElectronStoreService['set'],
    delete: vi.fn(() => {
      current = undefined;
    }) as ElectronStoreService['delete'],
  };
  return stub as ElectronStoreService;
}

const sampleDraft: GameWizardDraft = {
  name: 'mygame',
  image: 'some/image',
  connect_message: '',
  cpu: 256,
  memory: 512,
  ports: [],
  volumes: [],
  file_seeds: [],
  environment: [],
  https: false,
};

describe('GameWizardDraftService', () => {
  describe('get', () => {
    it('should return null when no draft has been saved', () => {
      const service = new GameWizardDraftService(makeStore());
      expect(service.get()).toBeNull();
    });

    it('should return the saved draft when one exists', () => {
      const stored: StoredGameWizardDraft = { draft: sampleDraft, stepIndex: 2, savedAt: '2026-08-09T00:00:00.000Z' };
      const service = new GameWizardDraftService(makeStore(stored));
      expect(service.get()).toEqual(stored);
    });

    it('should return null and log a warning when the stored entry is missing required fields', () => {
      const store = makeStore();
      vi.mocked(store.get).mockReturnValue({ draft: sampleDraft } as Partial<StoredGameWizardDraft> as StoredGameWizardDraft);
      const service = new GameWizardDraftService(store);

      expect(service.get()).toBeNull();
      expect(vi.mocked(logger.warn)).toHaveBeenCalled();
    });

    it('should return null and log a warning when reading throws', () => {
      const store = makeStore();
      vi.mocked(store.get).mockImplementation(() => {
        throw new Error('boom');
      });
      const service = new GameWizardDraftService(store);

      expect(service.get()).toBeNull();
      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(expect.stringContaining('boom'));
    });
  });

  describe('save', () => {
    it('should write the draft and step index, stamping savedAt itself', () => {
      const store = makeStore();
      const service = new GameWizardDraftService(store);

      service.save(sampleDraft, 3);

      expect(store.set).toHaveBeenCalledWith(
        'addGameWizardDraft',
        expect.objectContaining({ draft: sampleDraft, stepIndex: 3, savedAt: expect.any(String) }),
      );
    });

    it('should not throw when the underlying write fails', () => {
      const store = makeStore();
      vi.mocked(store.set).mockImplementation(() => {
        throw new Error('disk full');
      });
      const service = new GameWizardDraftService(store);

      expect(() => service.save(sampleDraft, 0)).not.toThrow();
      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(expect.stringContaining('disk full'));
    });
  });

  describe('clear', () => {
    it('should delete the stored draft', () => {
      const stored: StoredGameWizardDraft = { draft: sampleDraft, stepIndex: 0, savedAt: '2026-08-09T00:00:00.000Z' };
      const store = makeStore(stored);
      const service = new GameWizardDraftService(store);

      service.clear();

      expect(store.delete).toHaveBeenCalledWith('addGameWizardDraft');
    });

    it('should not throw when the underlying delete fails', () => {
      const store = makeStore();
      vi.mocked(store.delete).mockImplementation(() => {
        throw new Error('locked');
      });
      const service = new GameWizardDraftService(store);

      expect(() => service.clear()).not.toThrow();
    });
  });
});
