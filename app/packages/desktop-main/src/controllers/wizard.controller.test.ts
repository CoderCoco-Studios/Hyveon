import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import { WizardController } from './wizard.controller.js';
import type { PrerequisiteService, PrerequisitesReport } from '../services/PrerequisiteService.js';
import type { AwsProfileService, AwsProfileSummary } from '../services/AwsProfileService.js';
import { SafeStorageUnavailableError } from '../services/AwsProfileService.js';
import type { ElectronStoreService } from '../services/ElectronStoreService.js';
import type { BootstrapService, BootstrapResult } from '../services/BootstrapService.js';
import type { IamCheckService, IamCheckResult } from '../services/IamCheckService.js';
import type { FirstRunWizardService, WizardProgress } from '../services/FirstRunWizardService.js';

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
function makeStore(
  seed: {
    wizardCompleted?: boolean;
    activeCloud?: 'aws';
    aws?: { profile?: string; region?: string };
    bootstrap?: { stateBucket: string; lockTable: string; tfvarsBucket: string };
  } = {},
): ElectronStoreService {
  const data: Record<string, unknown> = { ...seed };
  return {
    get: vi.fn().mockImplementation((key: string) => data[key]),
    set: vi.fn().mockImplementation((key: string, value: unknown) => {
      data[key] = value;
    }),
  } as Partial<ElectronStoreService> as ElectronStoreService;
}

/** Build a BootstrapService stub whose `ensure*` methods resolve to the given result. */
function makeBootstrap(result: BootstrapResult = { status: 'created' }): BootstrapService {
  return {
    ensureStateBucket: vi.fn().mockResolvedValue(result),
    ensureLockTable: vi.fn().mockResolvedValue(result),
    ensureTfvarsBucket: vi.fn().mockResolvedValue(result),
  } as Partial<BootstrapService> as BootstrapService;
}

/** Build an IamCheckService stub whose `checkPermissions()` resolves to the given result. */
function makeIamCheck(result: IamCheckResult = { status: 'passed' }): IamCheckService {
  return { checkPermissions: vi.fn().mockResolvedValue(result) } as Partial<IamCheckService> as IamCheckService;
}

/** Build a FirstRunWizardService stub whose `getProgress()` resolves to the given progress. */
function makeFirstRunWizard(progress: WizardProgress = { step: 'prerequisites' }): FirstRunWizardService {
  const service: Partial<FirstRunWizardService> = {
    getProgress: vi.fn().mockResolvedValue(progress),
    recordStep: vi.fn().mockResolvedValue(undefined),
    complete: vi.fn().mockResolvedValue(undefined),
  };
  return service as FirstRunWizardService;
}

/** Builds a `WizardController` with default stubs for any dependency the caller doesn't override. */
function makeController(overrides: {
  prerequisites?: PrerequisiteService;
  awsProfiles?: AwsProfileService;
  store?: ElectronStoreService;
  bootstrap?: BootstrapService;
  iamCheck?: IamCheckService;
  firstRunWizard?: FirstRunWizardService;
} = {}): WizardController {
  return new WizardController(
    overrides.prerequisites ?? makePrerequisites(),
    overrides.awsProfiles ?? makeAwsProfiles(),
    overrides.store ?? makeStore(),
    overrides.bootstrap ?? makeBootstrap(),
    overrides.iamCheck ?? makeIamCheck(),
    overrides.firstRunWizard ?? makeFirstRunWizard(),
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

    it('should register bootstrapStateBucket on the "wizard.bootstrap.stateBucket" IPC channel', () => {
      const pattern = Reflect.getMetadata(PATTERN_METADATA_KEY, WizardController.prototype.bootstrapStateBucket);
      expect(pattern).toEqual(['wizard.bootstrap.stateBucket']);
    });

    it('should register bootstrapLockTable on the "wizard.bootstrap.lockTable" IPC channel', () => {
      const pattern = Reflect.getMetadata(PATTERN_METADATA_KEY, WizardController.prototype.bootstrapLockTable);
      expect(pattern).toEqual(['wizard.bootstrap.lockTable']);
    });

    it('should register bootstrapTfvarsBucket on the "wizard.bootstrap.tfvarsBucket" IPC channel', () => {
      const pattern = Reflect.getMetadata(PATTERN_METADATA_KEY, WizardController.prototype.bootstrapTfvarsBucket);
      expect(pattern).toEqual(['wizard.bootstrap.tfvarsBucket']);
    });

    it('should register simulateIamPermissions on the "wizard.iam.simulate" IPC channel', () => {
      const pattern = Reflect.getMetadata(PATTERN_METADATA_KEY, WizardController.prototype.simulateIamPermissions);
      expect(pattern).toEqual(['wizard.iam.simulate']);
    });

    it('should register getProgress on the "wizard.progress.get" IPC channel', () => {
      const pattern = Reflect.getMetadata(PATTERN_METADATA_KEY, WizardController.prototype.getProgress);
      expect(pattern).toEqual(['wizard.progress.get']);
    });

    it('should register saveProgress on the "wizard.progress.save" IPC channel', () => {
      const pattern = Reflect.getMetadata(PATTERN_METADATA_KEY, WizardController.prototype.saveProgress);
      expect(pattern).toEqual(['wizard.progress.save']);
    });

    it('should register complete on the "wizard.complete" IPC channel', () => {
      const pattern = Reflect.getMetadata(PATTERN_METADATA_KEY, WizardController.prototype.complete);
      expect(pattern).toEqual(['wizard.complete']);
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

    it('should include the stored aws credential choice when present', () => {
      const store = makeStore({ wizardCompleted: true, aws: { profile: 'default', region: 'us-east-1' } });
      const result = makeController({ store }).getState();
      expect(result).toEqual({
        wizardCompleted: true,
        activeCloud: undefined,
        aws: { profile: 'default', region: 'us-east-1' },
      });
    });

    it('should include the stored bootstrap resource names when present', () => {
      const bootstrap = { stateBucket: 'my-tfstate', lockTable: 'my-tflock', tfvarsBucket: 'my-tfvars' };
      const store = makeStore({ wizardCompleted: true, bootstrap });
      const result = makeController({ store }).getState();
      expect(result).toEqual({ wizardCompleted: true, activeCloud: undefined, bootstrap });
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

    it('should throw and write nothing when activeCloud is not the supported "aws" value', () => {
      const store = makeStore({ wizardCompleted: false });
      const controller = makeController({ store });

      expect(() =>
        controller.saveState({ activeCloud: 'gcp' as unknown as 'aws' }),
      ).toThrow('Unsupported cloud provider: gcp');
      expect(store.set).not.toHaveBeenCalled();
    });

    it('should persist the aws credential choice and return the updated state', () => {
      const store = makeStore({ wizardCompleted: false });
      const controller = makeController({ store });

      const result = controller.saveState({ aws: { profile: 'default', region: 'us-east-1' } });

      expect(store.set).toHaveBeenCalledWith('aws', { profile: 'default', region: 'us-east-1' });
      expect(result).toEqual({
        wizardCompleted: false,
        activeCloud: undefined,
        aws: { profile: 'default', region: 'us-east-1' },
      });
    });

    it('should merge a partial aws update onto the existing stored value', () => {
      const store = makeStore({ wizardCompleted: false, aws: { profile: 'default', region: 'us-east-1' } });
      const controller = makeController({ store });

      controller.saveState({ aws: { region: 'eu-west-1' } });

      expect(store.set).toHaveBeenCalledWith('aws', { profile: 'default', region: 'eu-west-1' });
    });

    it('should not write to the store when aws is omitted', () => {
      const store = makeStore({ wizardCompleted: true });
      const controller = makeController({ store });

      controller.saveState({});

      expect(store.set).not.toHaveBeenCalled();
    });

    it('should persist the bootstrap resource names and return them in the updated state', () => {
      const store = makeStore({ wizardCompleted: true });
      const controller = makeController({ store });
      const bootstrap = { stateBucket: 'my-tfstate', lockTable: 'my-tflock', tfvarsBucket: 'my-tfvars' };

      const result = controller.saveState({ bootstrap });

      expect(store.set).toHaveBeenCalledWith('bootstrap', bootstrap);
      expect(result).toEqual({ wizardCompleted: true, activeCloud: undefined, aws: undefined, bootstrap });
    });

    it('should replace the stored bootstrap resource names wholesale rather than merging', () => {
      const store = makeStore({
        wizardCompleted: true,
        bootstrap: { stateBucket: 'old-tfstate', lockTable: 'old-tflock', tfvarsBucket: 'old-tfvars' },
      });
      const controller = makeController({ store });
      const bootstrap = { stateBucket: 'new-tfstate', lockTable: 'old-tflock', tfvarsBucket: 'old-tfvars' };

      controller.saveState({ bootstrap });

      expect(store.set).toHaveBeenCalledWith('bootstrap', bootstrap);
    });
  });

  describe('bootstrapStateBucket', () => {
    it('should delegate to BootstrapService.ensureStateBucket with the given bucket name', async () => {
      const bootstrap = makeBootstrap({ status: 'created' });

      const result = await makeController({ bootstrap }).bootstrapStateBucket({ bucketName: 'my-state-bucket' });

      expect(bootstrap.ensureStateBucket).toHaveBeenCalledWith('my-state-bucket');
      expect(result).toEqual({ status: 'created' });
    });

    it('should propagate a failed result unchanged rather than throwing', async () => {
      const bootstrap = makeBootstrap({ status: 'failed', message: 'bucket taken' });

      const result = await makeController({ bootstrap }).bootstrapStateBucket({ bucketName: 'taken' });

      expect(result).toEqual({ status: 'failed', message: 'bucket taken' });
    });
  });

  describe('bootstrapLockTable', () => {
    it('should delegate to BootstrapService.ensureLockTable with the given table name', async () => {
      const bootstrap = makeBootstrap({ status: 'created' });

      const result = await makeController({ bootstrap }).bootstrapLockTable({ tableName: 'my-lock-table' });

      expect(bootstrap.ensureLockTable).toHaveBeenCalledWith('my-lock-table');
      expect(result).toEqual({ status: 'created' });
    });

    it('should propagate a failed result unchanged rather than throwing', async () => {
      const bootstrap = makeBootstrap({ status: 'failed', message: 'access denied' });

      const result = await makeController({ bootstrap }).bootstrapLockTable({ tableName: 'my-lock-table' });

      expect(result).toEqual({ status: 'failed', message: 'access denied' });
    });
  });

  describe('bootstrapTfvarsBucket', () => {
    it('should delegate to BootstrapService.ensureTfvarsBucket with the given bucket name', async () => {
      const bootstrap = makeBootstrap({ status: 'created' });

      const result = await makeController({ bootstrap }).bootstrapTfvarsBucket({ bucketName: 'my-tfvars-bucket' });

      expect(bootstrap.ensureTfvarsBucket).toHaveBeenCalledWith('my-tfvars-bucket');
      expect(result).toEqual({ status: 'created' });
    });

    it('should propagate a failed result unchanged rather than throwing', async () => {
      const bootstrap = makeBootstrap({ status: 'failed', message: 'access denied' });

      const result = await makeController({ bootstrap }).bootstrapTfvarsBucket({ bucketName: 'my-tfvars-bucket' });

      expect(result).toEqual({ status: 'failed', message: 'access denied' });
    });
  });

  describe('simulateIamPermissions', () => {
    it('should delegate to IamCheckService.checkPermissions and return the result unchanged', async () => {
      const iamCheck = makeIamCheck({ status: 'passed' });

      const result = await makeController({ iamCheck }).simulateIamPermissions();

      expect(iamCheck.checkPermissions).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ status: 'passed' });
    });

    it('should propagate a missing-permissions result with its policy JSON unchanged', async () => {
      const iamCheck = makeIamCheck({ status: 'missing', policyJson: '{"Version":"2012-10-17"}' });

      const result = await makeController({ iamCheck }).simulateIamPermissions();

      expect(result).toEqual({ status: 'missing', policyJson: '{"Version":"2012-10-17"}' });
    });

    it('should propagate a warning result unchanged rather than throwing', async () => {
      const iamCheck = makeIamCheck({ status: 'warning', message: 'access denied' });

      const result = await makeController({ iamCheck }).simulateIamPermissions();

      expect(result).toEqual({ status: 'warning', message: 'access denied' });
    });
  });

  describe('getProgress', () => {
    it('should return the progress produced by FirstRunWizardService.getProgress', async () => {
      const firstRunWizard = makeFirstRunWizard({ step: 'bootstrap' });

      const result = await makeController({ firstRunWizard }).getProgress();

      expect(result).toEqual({ step: 'bootstrap' });
    });
  });

  describe('saveProgress', () => {
    it('should delegate to FirstRunWizardService.recordStep with the given step', async () => {
      const firstRunWizard = makeFirstRunWizard();

      await makeController({ firstRunWizard }).saveProgress({ step: 'credentials' });

      expect(firstRunWizard.recordStep).toHaveBeenCalledWith('credentials');
    });
  });

  describe('complete', () => {
    it('should call FirstRunWizardService.complete and return the resulting wizard state', async () => {
      const firstRunWizard = makeFirstRunWizard();
      const store = makeStore({ wizardCompleted: true, activeCloud: 'aws' });

      const result = await makeController({ firstRunWizard, store }).complete();

      expect(firstRunWizard.complete).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ wizardCompleted: true, activeCloud: 'aws', aws: undefined });
    });
  });
});
