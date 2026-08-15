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
  healthCheck: {
    enabled: false,
    scheme: 'http',
    port: null,
    path: '',
    method: 'GET',
    timeoutMs: 2000,
    jsonPath: '',
    operator: 'equals',
    value: '',
    authType: 'none',
    secretArn: '',
    username: '',
    password: '',
    token: '',
    secretSet: false,
  },
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

    it('should return null and log a warning when the stored stepIndex is negative or non-integer', () => {
      const store = makeStore();
      const service = new GameWizardDraftService(store);

      vi.mocked(store.get).mockReturnValue({
        draft: sampleDraft,
        stepIndex: -1,
        savedAt: '2026-08-09T00:00:00.000Z',
      } as StoredGameWizardDraft);
      expect(service.get()).toBeNull();

      vi.mocked(store.get).mockReturnValue({
        draft: sampleDraft,
        stepIndex: 1.5,
        savedAt: '2026-08-09T00:00:00.000Z',
      } as StoredGameWizardDraft);
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

    it('should return null when stepIndex is at or beyond the number of wizard steps', () => {
      const store = makeStore();
      const service = new GameWizardDraftService(store);

      vi.mocked(store.get).mockReturnValue({
        draft: sampleDraft,
        stepIndex: 6,
        savedAt: '2026-08-09T00:00:00.000Z',
      } as StoredGameWizardDraft);

      expect(service.get()).toBeNull();
    });

    it('should return null when savedAt is not a parseable date string', () => {
      const store = makeStore();
      const service = new GameWizardDraftService(store);

      vi.mocked(store.get).mockReturnValue({
        draft: sampleDraft,
        stepIndex: 0,
        savedAt: 'not-a-date',
      } as StoredGameWizardDraft);

      expect(service.get()).toBeNull();
    });

    it('should return null when cpu or memory is not a finite number', () => {
      const store = makeStore();
      const service = new GameWizardDraftService(store);

      vi.mocked(store.get).mockReturnValue({
        draft: { ...sampleDraft, cpu: Number.NaN },
        stepIndex: 0,
        savedAt: '2026-08-09T00:00:00.000Z',
      } as StoredGameWizardDraft);

      expect(service.get()).toBeNull();
    });

    it('should return null when a ports/volumes/file_seeds/environment entry has the wrong shape', () => {
      const store = makeStore();
      const service = new GameWizardDraftService(store);

      const malformedPorts: StoredGameWizardDraft = {
        draft: { ...sampleDraft, ports: [null] as unknown as GameWizardDraft['ports'] },
        stepIndex: 0,
        savedAt: '2026-08-09T00:00:00.000Z',
      };
      vi.mocked(store.get).mockReturnValue(malformedPorts);
      expect(service.get()).toBeNull();

      const malformedEnvironment: StoredGameWizardDraft = {
        draft: {
          ...sampleDraft,
          environment: [{ name: 'FOO' }] as unknown as GameWizardDraft['environment'],
        },
        stepIndex: 0,
        savedAt: '2026-08-09T00:00:00.000Z',
      };
      vi.mocked(store.get).mockReturnValue(malformedEnvironment);
      expect(service.get()).toBeNull();
    });

    it('should blank out environment values and file-seed content before returning the draft', () => {
      const draftWithSecrets: GameWizardDraft = {
        ...sampleDraft,
        file_seeds: [{ path: '/data/config.yml', content: 'top secret', content_base64: 'c2VjcmV0', mode: '0644' }],
        environment: [{ name: 'DB_PASSWORD', value: 'hunter2' }],
      };
      const stored: StoredGameWizardDraft = {
        draft: draftWithSecrets,
        stepIndex: 4,
        savedAt: '2026-08-09T00:00:00.000Z',
      };
      const service = new GameWizardDraftService(makeStore(stored));

      const result = service.get();

      expect(result?.draft.file_seeds).toEqual([{ path: '/data/config.yml', content: '', content_base64: '', mode: '0644' }]);
      expect(result?.draft.environment).toEqual([{ name: 'DB_PASSWORD', value: '' }]);
    });

    it('should blank out healthCheck.secretArn while preserving secretSet before returning the draft', () => {
      const draftWithSecret: GameWizardDraft = {
        ...sampleDraft,
        healthCheck: { ...sampleDraft.healthCheck, enabled: true, secretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:token', secretSet: true },
      };
      const stored: StoredGameWizardDraft = { draft: draftWithSecret, stepIndex: 2, savedAt: '2026-08-09T00:00:00.000Z' };
      const service = new GameWizardDraftService(makeStore(stored));

      const result = service.get();

      expect(result?.draft.healthCheck.secretArn).toBe('');
      expect(result?.draft.healthCheck.secretSet).toBe(true);
      expect(result?.draft.healthCheck.enabled).toBe(true);
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
