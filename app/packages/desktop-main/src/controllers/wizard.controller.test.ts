import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import { WizardController } from './wizard.controller.js';
import type { AwsProfileService, AwsProfileSummary } from '../services/AwsProfileService.js';
import { SafeStorageUnavailableError } from '../services/AwsProfileService.js';
import type { ElectronStoreService } from '../services/ElectronStoreService.js';
import type { BootstrapService, BootstrapResult } from '../services/BootstrapService.js';
import type { IamCheckService, IamCheckResult } from '../services/IamCheckService.js';
import type { FirstRunWizardService, WizardProgress } from '../services/FirstRunWizardService.js';
import type { GuidedIamService } from '../services/GuidedIamService.js';

const SAMPLE_PROFILES: AwsProfileSummary[] = [
  { profileName: 'default', region: 'us-east-1' },
  { profileName: 'dev', region: 'us-west-2' },
];

/** Build an AwsProfileService stub whose `listProfiles()` resolves to the given profiles. */
function makeAwsProfiles(profiles: AwsProfileSummary[] = SAMPLE_PROFILES): AwsProfileService {
  return {
    listProfiles: vi.fn().mockResolvedValue(profiles),
    savePastedCredentials: vi.fn().mockReturnValue({ profileName: 'hyveon-pasted' }),
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
    bootstrap?: { stateBucket: string; configurationBucket: string };
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
    ensureConfigurationBucket: vi.fn().mockResolvedValue(result),
    ensureRunsTable: vi.fn().mockResolvedValue(result),
  } as Partial<BootstrapService> as BootstrapService;
}

/** Build an IamCheckService stub whose `checkPermissions()` resolves to the given result. */
function makeIamCheck(result: IamCheckResult = { status: 'passed', origin: 'none', blocking: false }): IamCheckService {
  return { checkPermissions: vi.fn().mockResolvedValue(result) } as Partial<IamCheckService> as IamCheckService;
}

/** Build a FirstRunWizardService stub whose `getProgress()` resolves to the given progress. */
function makeFirstRunWizard(progress: WizardProgress = { step: 'pick-cloud' }): FirstRunWizardService {
  const service: Partial<FirstRunWizardService> = {
    getProgress: vi.fn().mockResolvedValue(progress),
    recordStep: vi.fn().mockResolvedValue(undefined),
    complete: vi.fn().mockResolvedValue(undefined),
  };
  return service as FirstRunWizardService;
}

/**
 * Build a `GuidedIamService` stub. This controller's `GuidedIamService`
 * handlers are wiring-only pass-throughs, proven by Task 3's tier-2
 * integration specs rather than unit tests here — this stub exists only so
 * `makeController` can satisfy the constructor's now-five dependencies.
 */
function makeGuidedIam(): GuidedIamService {
  return {
    renderTemplate: vi.fn(),
    buildCloudFormationConsoleUrl: vi.fn(),
    openConsole: vi.fn(),
    intakeBootstrapKey: vi.fn(),
    rotate: vi.fn(),
    revokeBootstrapKey: vi.fn(),
  } as Partial<GuidedIamService> as GuidedIamService;
}

/** Builds a `WizardController` with default stubs for any dependency the caller doesn't override. */
function makeController(overrides: {
  awsProfiles?: AwsProfileService;
  store?: ElectronStoreService;
  bootstrap?: BootstrapService;
  iamCheck?: IamCheckService;
  firstRunWizard?: FirstRunWizardService;
  guidedIam?: GuidedIamService;
} = {}): WizardController {
  return new WizardController(
    overrides.awsProfiles ?? makeAwsProfiles(),
    overrides.store ?? makeStore(),
    overrides.bootstrap ?? makeBootstrap(),
    overrides.iamCheck ?? makeIamCheck(),
    overrides.firstRunWizard ?? makeFirstRunWizard(),
    overrides.guidedIam ?? makeGuidedIam(),
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

    it('should register bootstrapConfigurationBucket on the "wizard.bootstrap.configurationBucket" IPC channel', () => {
      const pattern = Reflect.getMetadata(PATTERN_METADATA_KEY, WizardController.prototype.bootstrapConfigurationBucket);
      expect(pattern).toEqual(['wizard.bootstrap.configurationBucket']);
    });

    it('should register bootstrapRunsTable on the "wizard.bootstrap.runsTable" IPC channel', () => {
      const pattern = Reflect.getMetadata(PATTERN_METADATA_KEY, WizardController.prototype.bootstrapRunsTable);
      expect(pattern).toEqual(['wizard.bootstrap.runsTable']);
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

    it('should register prepareGuidedIamTemplate on the "wizard.guidedIam.prepareTemplate" IPC channel', () => {
      const pattern = Reflect.getMetadata(PATTERN_METADATA_KEY, WizardController.prototype.prepareGuidedIamTemplate);
      expect(pattern).toEqual(['wizard.guidedIam.prepareTemplate']);
    });

    it('should register openGuidedIamConsole on the "wizard.guidedIam.openConsole" IPC channel', () => {
      const pattern = Reflect.getMetadata(PATTERN_METADATA_KEY, WizardController.prototype.openGuidedIamConsole);
      expect(pattern).toEqual(['wizard.guidedIam.openConsole']);
    });

    it('should register submitGuidedIamBootstrapKey on the "wizard.guidedIam.submitBootstrapKey" IPC channel', () => {
      const pattern = Reflect.getMetadata(
        PATTERN_METADATA_KEY,
        WizardController.prototype.submitGuidedIamBootstrapKey,
      );
      expect(pattern).toEqual(['wizard.guidedIam.submitBootstrapKey']);
    });

    it('should register rotateGuidedIamKey on the "wizard.guidedIam.rotate" IPC channel', () => {
      const pattern = Reflect.getMetadata(PATTERN_METADATA_KEY, WizardController.prototype.rotateGuidedIamKey);
      expect(pattern).toEqual(['wizard.guidedIam.rotate']);
    });

    it('should register revokeGuidedIamBootstrapKey on the "wizard.guidedIam.revokeBootstrapKey" IPC channel', () => {
      const pattern = Reflect.getMetadata(
        PATTERN_METADATA_KEY,
        WizardController.prototype.revokeGuidedIamBootstrapKey,
      );
      expect(pattern).toEqual(['wizard.guidedIam.revokeBootstrapKey']);
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
      expect(result).toEqual({ profileName: 'hyveon-pasted' });
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
      const bootstrap = { stateBucket: 'my-tfstate', configurationBucket: 'my-config' };
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
      const bootstrap = { stateBucket: 'my-tfstate', configurationBucket: 'my-config' };

      const result = controller.saveState({ bootstrap });

      expect(store.set).toHaveBeenCalledWith('bootstrap', bootstrap);
      expect(result).toEqual({ wizardCompleted: true, activeCloud: undefined, aws: undefined, bootstrap });
    });

    it('should replace the stored bootstrap resource names wholesale rather than merging', () => {
      const store = makeStore({
        wizardCompleted: true,
        bootstrap: { stateBucket: 'old-tfstate', configurationBucket: 'old-config' },
      });
      const controller = makeController({ store });
      const bootstrap = { stateBucket: 'new-tfstate', configurationBucket: 'old-config' };

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

  describe('bootstrapConfigurationBucket', () => {
    it('should delegate to BootstrapService.ensureConfigurationBucket with the given bucket name', async () => {
      const bootstrap = makeBootstrap({ status: 'created' });

      const result = await makeController({ bootstrap }).bootstrapConfigurationBucket({ bucketName: 'my-config-bucket' });

      expect(bootstrap.ensureConfigurationBucket).toHaveBeenCalledWith('my-config-bucket');
      expect(result).toEqual({ status: 'created' });
    });

    it('should propagate a failed result unchanged rather than throwing', async () => {
      const bootstrap = makeBootstrap({ status: 'failed', message: 'access denied' });

      const result = await makeController({ bootstrap }).bootstrapConfigurationBucket({ bucketName: 'my-config-bucket' });

      expect(result).toEqual({ status: 'failed', message: 'access denied' });
    });
  });

  describe('bootstrapRunsTable', () => {
    it('should delegate to BootstrapService.ensureRunsTable with the default project-prefixed table name', async () => {
      const bootstrap = makeBootstrap({ status: 'created' });

      const result = await makeController({ bootstrap }).bootstrapRunsTable();

      expect(bootstrap.ensureRunsTable).toHaveBeenCalledWith('hyveon-runs');
      expect(result).toEqual({ status: 'created' });
    });

    it('should propagate a failed result unchanged rather than throwing', async () => {
      const bootstrap = makeBootstrap({ status: 'failed', message: 'access denied' });

      const result = await makeController({ bootstrap }).bootstrapRunsTable();

      expect(result).toEqual({ status: 'failed', message: 'access denied' });
    });
  });

  describe('simulateIamPermissions', () => {
    it('should delegate to IamCheckService.checkPermissions and return the result unchanged', async () => {
      const iamCheck = makeIamCheck({ status: 'passed', origin: 'profile', blocking: false });

      const result = await makeController({ iamCheck }).simulateIamPermissions();

      expect(iamCheck.checkPermissions).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ status: 'passed', origin: 'profile', blocking: false });
    });

    it('should propagate a missing-permissions result with its policy JSON unchanged', async () => {
      const iamCheck = makeIamCheck({
        status: 'missing',
        policyJson: '{"Version":"2012-10-17"}',
        origin: 'guided',
        blocking: true,
      });

      const result = await makeController({ iamCheck }).simulateIamPermissions();

      expect(result).toEqual({
        status: 'missing',
        policyJson: '{"Version":"2012-10-17"}',
        origin: 'guided',
        blocking: true,
      });
    });

    it('should propagate a warning result unchanged rather than throwing', async () => {
      const iamCheck = makeIamCheck({ status: 'warning', message: 'access denied', origin: 'none', blocking: false });

      const result = await makeController({ iamCheck }).simulateIamPermissions();

      expect(result).toEqual({ status: 'warning', message: 'access denied', origin: 'none', blocking: false });
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

      expect(firstRunWizard.recordStep).toHaveBeenCalledWith('credentials', undefined);
    });

    it('should pass through a guidedIam sub-state payload to FirstRunWizardService.recordStep', async () => {
      const firstRunWizard = makeFirstRunWizard();
      const guidedIam = { subState: 'rotation-pending' as const, hasBootstrapKey: true };

      await makeController({ firstRunWizard }).saveProgress({ step: 'guided-iam', guidedIam });

      expect(firstRunWizard.recordStep).toHaveBeenCalledWith('guided-iam', guidedIam);
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
