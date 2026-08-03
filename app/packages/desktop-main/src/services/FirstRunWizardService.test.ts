import 'reflect-metadata';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { FirstRunWizardService } from './FirstRunWizardService.js';
import type { ElectronStoreService } from './ElectronStoreService.js';

/** Test-only subclass exposing the protected `stateFilePath`/`userDataPath` seams so tests can point them at a real scratch directory or assert their composition directly. */
class TestableFirstRunWizardService extends FirstRunWizardService {
  public override stateFilePath(): string {
    return super.stateFilePath();
  }
  public override userDataPath(): string {
    return super.userDataPath();
  }
}

/** Build an `ElectronStoreService` stub whose `set()` calls are observable. */
function makeStore(): ElectronStoreService {
  const store: Partial<ElectronStoreService> = { set: vi.fn() };
  return store as ElectronStoreService;
}

describe('FirstRunWizardService', () => {
  let scratchDir: string;
  let statePath: string;
  let service: TestableFirstRunWizardService;
  let store: ElectronStoreService;

  beforeEach(() => {
    scratchDir = mkdtempSync(join(tmpdir(), 'wizard-state-test-'));
    statePath = join(scratchDir, 'nested', 'wizard-state.json');
    mkdirSync(join(scratchDir, 'nested'));
    store = makeStore();
    service = new TestableFirstRunWizardService(store);
    vi.spyOn(service, 'stateFilePath').mockReturnValue(statePath);
  });

  afterEach(() => {
    rmSync(scratchDir, { recursive: true, force: true });
  });

  describe('getProgress', () => {
    it('should default to the pick-cloud step when the state file does not exist', async () => {
      const progress = await service.getProgress();
      expect(progress).toEqual({ step: 'pick-cloud' });
    });

    it('should return the persisted step when the state file holds a recognized step name', async () => {
      writeFileSync(statePath, JSON.stringify({ step: 'bootstrap' }), 'utf-8');
      const progress = await service.getProgress();
      expect(progress).toEqual({ step: 'bootstrap' });
    });

    it('should default to the pick-cloud step when the file contains invalid JSON', async () => {
      writeFileSync(statePath, 'not valid json{{{', 'utf-8');
      const progress = await service.getProgress();
      expect(progress).toEqual({ step: 'pick-cloud' });
    });

    it('should default to the pick-cloud step when the file holds an unrecognized step name', async () => {
      writeFileSync(statePath, JSON.stringify({ step: 'some-future-step' }), 'utf-8');
      const progress = await service.getProgress();
      expect(progress).toEqual({ step: 'pick-cloud' });
    });

    it('should pass through a valid guidedIam sub-state alongside the recorded step', async () => {
      writeFileSync(
        statePath,
        JSON.stringify({ step: 'guided-iam', guidedIam: { subState: 'rotation-pending', hasBootstrapKey: true } }),
        'utf-8',
      );
      const progress = await service.getProgress();
      expect(progress).toEqual({ step: 'guided-iam', guidedIam: { subState: 'rotation-pending', hasBootstrapKey: true } });
    });

    it('should omit guidedIam entirely (not pass through garbage) when subState is not one of the five valid literals', async () => {
      writeFileSync(
        statePath,
        JSON.stringify({ step: 'guided-iam', guidedIam: { subState: 'made-up-state', hasBootstrapKey: true } }),
        'utf-8',
      );
      const progress = await service.getProgress();
      expect(progress).toEqual({ step: 'guided-iam' });
      expect(progress).not.toHaveProperty('guidedIam.subState', 'made-up-state');
    });

    it('should omit guidedIam entirely when hasBootstrapKey is not a boolean', async () => {
      writeFileSync(
        statePath,
        JSON.stringify({ step: 'guided-iam', guidedIam: { subState: 'complete', hasBootstrapKey: 'yes' } }),
        'utf-8',
      );
      const progress = await service.getProgress();
      expect(progress).toEqual({ step: 'guided-iam' });
    });

    it('should omit guidedIam entirely when it is present but not an object', async () => {
      writeFileSync(statePath, JSON.stringify({ step: 'guided-iam', guidedIam: 'rotation-pending' }), 'utf-8');
      const progress = await service.getProgress();
      expect(progress).toEqual({ step: 'guided-iam' });
    });

    it('should not throw when guidedIam is corrupt', async () => {
      writeFileSync(statePath, JSON.stringify({ step: 'guided-iam', guidedIam: null }), 'utf-8');
      await expect(service.getProgress()).resolves.toEqual({ step: 'guided-iam' });
    });
  });

  describe('recordStep', () => {
    it('should write the given step to the state file, creating parent directories as needed', async () => {
      expect(existsSync(statePath)).toBe(false);

      await service.recordStep('credentials');

      expect(JSON.parse(readFileSync(statePath, 'utf-8'))).toEqual({ step: 'credentials' });
    });

    it('should reject a step name outside WIZARD_STEPS rather than writing it', async () => {
      // The IPC boundary erases WizardStepName's compile-time guarantee, so a
      // malformed/unexpected value must be rejected explicitly at runtime.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- deliberately bypassing the compile-time type to exercise the runtime guard
      await expect(service.recordStep('not-a-real-step' as any)).rejects.toThrow('Unsupported wizard step');
      expect(existsSync(statePath)).toBe(false);
    });

    it('should be resumable: a later getProgress reflects the step recorded by an earlier recordStep', async () => {
      await service.recordStep('stack-init');

      const progress = await service.getProgress();

      expect(progress).toEqual({ step: 'stack-init' });
    });

    it('should overwrite a previously recorded step', async () => {
      await service.recordStep('pick-cloud');
      await service.recordStep('bootstrap');

      expect(await service.getProgress()).toEqual({ step: 'bootstrap' });
    });

    it('should round-trip a guidedIam sub-state through recordStep and getProgress', async () => {
      await service.recordStep('guided-iam', { subState: 'awaiting-key-intake', hasBootstrapKey: false });

      expect(JSON.parse(readFileSync(statePath, 'utf-8'))).toEqual({
        step: 'guided-iam',
        guidedIam: { subState: 'awaiting-key-intake', hasBootstrapKey: false },
      });
      expect(await service.getProgress()).toEqual({
        step: 'guided-iam',
        guidedIam: { subState: 'awaiting-key-intake', hasBootstrapKey: false },
      });
    });

    it('should round-trip hasBootstrapKey as a plain boolean, never the key material itself', async () => {
      await service.recordStep('guided-iam', { subState: 'rotation-pending', hasBootstrapKey: true });

      const written = JSON.parse(readFileSync(statePath, 'utf-8'));
      expect(written.guidedIam.hasBootstrapKey).toBe(true);
      expect(typeof written.guidedIam.hasBootstrapKey).toBe('boolean');
      expect(JSON.stringify(written)).not.toMatch(/secretAccessKey|accessKeyId/);
    });

    it('should omit guidedIam from the written file when not supplied', async () => {
      await service.recordStep('guided-iam');

      expect(JSON.parse(readFileSync(statePath, 'utf-8'))).toEqual({ step: 'guided-iam' });
    });

    it('should reject a guidedIam sub-state outside GuidedIamSubState rather than writing it', async () => {
      await expect(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- deliberately bypassing the compile-time type to exercise the runtime guard
        service.recordStep('guided-iam', { subState: 'not-a-real-substate' as any, hasBootstrapKey: false }),
      ).rejects.toThrow('Unsupported guided-IAM sub-state');
      expect(existsSync(statePath)).toBe(false);
    });
  });

  describe('complete', () => {
    it('should set wizardCompleted to true in ElectronStoreService', async () => {
      await service.complete();
      expect(store.set).toHaveBeenCalledWith('wizardCompleted', true);
    });

    it('should clear the resume file, so a future re-entry (e.g. Settings Reconfigure) starts clean', async () => {
      await service.recordStep('stack-init');
      expect(existsSync(statePath)).toBe(true);

      await service.complete();

      expect(existsSync(statePath)).toBe(false);
      expect(await service.getProgress()).toEqual({ step: 'pick-cloud' });
    });

    it('should not throw when the resume file never existed', async () => {
      await expect(service.complete()).resolves.toBeUndefined();
    });
  });

  describe('userDataPath', () => {
    it('should compose stateFilePath from userDataPath and the fixed filename', () => {
      const unspiedService = new TestableFirstRunWizardService(makeStore());
      vi.spyOn(unspiedService, 'userDataPath').mockReturnValue('/fake/userData');

      expect(unspiedService.stateFilePath()).toBe(join('/fake/userData', 'wizard-state.json'));
    });

    it('should fall back to a hyveon-wizard-namespaced OS temp directory outside Electron', () => {
      const unspiedService = new TestableFirstRunWizardService(makeStore());

      expect(unspiedService.userDataPath()).toBe(join(tmpdir(), 'hyveon-wizard'));
    });
  });
});
