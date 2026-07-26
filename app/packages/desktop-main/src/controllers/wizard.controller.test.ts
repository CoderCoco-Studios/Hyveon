import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import { WizardController } from './wizard.controller.js';
import type { PrerequisiteService, PrerequisitesReport } from '../services/PrerequisiteService.js';
import type { AwsProfileService, AwsProfileSummary } from '../services/AwsProfileService.js';
import { SafeStorageUnavailableError } from '../services/AwsProfileService.js';
import type { ElectronStoreService } from '../services/ElectronStoreService.js';

const SATISFIED_REPORT: PrerequisitesReport = {
  terraform: { found: true, path: '/usr/local/bin/terraform', version: '1.9.0', minimumVersionSatisfied: true },
  aws: { found: true, path: '/usr/local/bin/aws', version: '2.15.30' },
};

const SAMPLE_PROFILES: AwsProfileSummary[] = [
  { profileName: 'default', region: 'us-east-1' },
  { profileName: 'dev', region: 'us-west-2' },
];

/** Build a PrerequisiteService stub whose `check()` resolves to the given report. */
function makePrerequisites(report: PrerequisitesReport = SATISFIED_REPORT): PrerequisiteService {
  return { check: vi.fn().mockResolvedValue(report) } as Partial<PrerequisiteService> as PrerequisiteService;
}

/** Build an AwsProfileService stub whose `listProfiles()` resolves to the given profiles. */
function makeAwsProfiles(profiles: AwsProfileSummary[] = SAMPLE_PROFILES): AwsProfileService {
  return {
    listProfiles: vi.fn().mockResolvedValue(profiles),
    savePastedCredentials: vi.fn().mockReturnValue({ profileName: 'gsd-pasted' }),
  } as Partial<AwsProfileService> as AwsProfileService;
}

/**
 * Build an `ElectronStoreService` stub backed by a plain object so
 * `set()` followed by `get()` (as `saveState` does) round-trips like the
 * real service, instead of always returning a fixed value.
 */
function makeStore(seed: { wizardCompleted?: boolean; activeCloud?: 'aws' } = {}): ElectronStoreService {
  const data: Record<string, unknown> = { ...seed };
  return {
    get: vi.fn().mockImplementation((key: string) => data[key]),
    set: vi.fn().mockImplementation((key: string, value: unknown) => {
      data[key] = value;
    }),
  } as Partial<ElectronStoreService> as ElectronStoreService;
}

/** Builds a `WizardController` with default stubs for any dependency the caller doesn't override. */
function makeController(overrides: {
  prerequisites?: PrerequisiteService;
  awsProfiles?: AwsProfileService;
  store?: ElectronStoreService;
} = {}): WizardController {
  return new WizardController(
    overrides.prerequisites ?? makePrerequisites(),
    overrides.awsProfiles ?? makeAwsProfiles(),
    overrides.store ?? makeStore(),
  );
}

/**
 * The metadata key NestJS stores on each method decorated with
 * `@MessagePattern`. Asserting this value is the only automated guard
 * that prevents a typo in the controller from silently breaking IPC.
 */
const PATTERN_METADATA_KEY = 'microservices:pattern';

describe('WizardController', () => {
  describe('@MessagePattern channel names', () => {
    it('should register checkPrereqs on the "wizard.prereqs.check" IPC channel', () => {
      const pattern = Reflect.getMetadata(PATTERN_METADATA_KEY, WizardController.prototype.checkPrereqs);
      expect(pattern).toEqual(['wizard.prereqs.check']);
    });

    it('should register listAwsProfiles on the "wizard.aws.listProfiles" IPC channel', () => {
      const pattern = Reflect.getMetadata(PATTERN_METADATA_KEY, WizardController.prototype.listAwsProfiles);
      expect(pattern).toEqual(['wizard.aws.listProfiles']);
    });

    it('should register saveCredentials on the "wizard.aws.saveCredentials" IPC channel', () => {
      const pattern = Reflect.getMetadata(PATTERN_METADATA_KEY, WizardController.prototype.saveCredentials);
      expect(pattern).toEqual(['wizard.aws.saveCredentials']);
    });

    it('should register getState on the "wizard.state.get" IPC channel', () => {
      const pattern = Reflect.getMetadata(PATTERN_METADATA_KEY, WizardController.prototype.getState);
      expect(pattern).toEqual(['wizard.state.get']);
    });

    it('should register saveState on the "wizard.state.save" IPC channel', () => {
      const pattern = Reflect.getMetadata(PATTERN_METADATA_KEY, WizardController.prototype.saveState);
      expect(pattern).toEqual(['wizard.state.save']);
    });
  });

  describe('checkPrereqs', () => {
    it('should return the report produced by PrerequisiteService.check', async () => {
      const prerequisites = makePrerequisites();
      const result = await makeController({ prerequisites }).checkPrereqs();
      expect(result).toEqual(SATISFIED_REPORT);
      expect(prerequisites.check).toHaveBeenCalledTimes(1);
    });

    it('should propagate a report with a missing tool unchanged', async () => {
      const report: PrerequisitesReport = { terraform: { found: false }, aws: { found: false } };
      const result = await makeController({ prerequisites: makePrerequisites(report) }).checkPrereqs();
      expect(result).toEqual(report);
    });
  });

  describe('listAwsProfiles', () => {
    it('should return the profiles produced by AwsProfileService.listProfiles', async () => {
      const awsProfiles = makeAwsProfiles();
      const result = await makeController({ awsProfiles }).listAwsProfiles();
      expect(result).toEqual(SAMPLE_PROFILES);
      expect(awsProfiles.listProfiles).toHaveBeenCalledTimes(1);
    });

    it('should propagate an empty profile list unchanged', async () => {
      const result = await makeController({ awsProfiles: makeAwsProfiles([]) }).listAwsProfiles();
      expect(result).toEqual([]);
    });
  });

  describe('saveCredentials', () => {
    it('should delegate to AwsProfileService.savePastedCredentials and return only the profile name', () => {
      const awsProfiles = makeAwsProfiles();
      const body = { accessKeyId: 'AKID', secretAccessKey: 'SECRET', region: 'us-east-1' };

      const result = makeController({ awsProfiles }).saveCredentials(body);

      expect(awsProfiles.savePastedCredentials).toHaveBeenCalledWith(body);
      expect(result).toEqual({ profileName: 'gsd-pasted' });
    });

    it('should propagate a thrown SafeStorageUnavailableError rather than swallowing it', () => {
      const awsProfiles = {
        savePastedCredentials: vi.fn().mockImplementation(() => {
          throw new SafeStorageUnavailableError();
        }),
      } as Partial<AwsProfileService> as AwsProfileService;

      expect(() =>
        makeController({ awsProfiles }).saveCredentials({ accessKeyId: 'AKID', secretAccessKey: 'SECRET' }),
      ).toThrow(SafeStorageUnavailableError);
    });
  });

  describe('getState', () => {
    it('should return wizardCompleted: false when the store has never set it and test mode is off', () => {
      const controller = makeController({ store: makeStore() });
      vi.spyOn(controller as unknown as { isTestMode(): boolean }, 'isTestMode').mockReturnValue(false);

      expect(controller.getState()).toEqual({ wizardCompleted: false, activeCloud: undefined });
    });

    it('should default to wizardCompleted: true when unset and HYVEON_TEST_MODE is active', () => {
      const controller = makeController({ store: makeStore() });
      vi.spyOn(controller as unknown as { isTestMode(): boolean }, 'isTestMode').mockReturnValue(true);

      expect(controller.getState()).toEqual({ wizardCompleted: true, activeCloud: undefined });
    });

    it('should honor an explicitly-stored false value even under test mode', () => {
      const controller = makeController({ store: makeStore({ wizardCompleted: false }) });
      vi.spyOn(controller as unknown as { isTestMode(): boolean }, 'isTestMode').mockReturnValue(true);

      expect(controller.getState()).toEqual({ wizardCompleted: false, activeCloud: undefined });
    });

    it('should return wizardCompleted: true once the store has it set', () => {
      const result = makeController({ store: makeStore({ wizardCompleted: true }) }).getState();
      expect(result).toEqual({ wizardCompleted: true, activeCloud: undefined });
    });

    it('should include the stored activeCloud when present', () => {
      const result = makeController({ store: makeStore({ wizardCompleted: true, activeCloud: 'aws' }) }).getState();
      expect(result).toEqual({ wizardCompleted: true, activeCloud: 'aws' });
    });
  });

  describe('saveState', () => {
    it('should persist activeCloud to the store and return the updated state', () => {
      const store = makeStore({ wizardCompleted: false });
      const controller = makeController({ store });

      const result = controller.saveState({ activeCloud: 'aws' });

      expect(store.set).toHaveBeenCalledWith('activeCloud', 'aws');
      expect(result).toEqual({ wizardCompleted: false, activeCloud: 'aws' });
    });

    it('should not write to the store when activeCloud is omitted, but still return current state', () => {
      const store = makeStore({ wizardCompleted: true, activeCloud: 'aws' });
      const controller = makeController({ store });

      const result = controller.saveState({});

      expect(store.set).not.toHaveBeenCalled();
      expect(result).toEqual({ wizardCompleted: true, activeCloud: 'aws' });
    });
  });
});
