import 'reflect-metadata';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { FirstRunWizardService } from './FirstRunWizardService.js';
import type { ElectronStoreService } from './ElectronStoreService.js';
import { logger } from '../logger.js';

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

/** Test-only subclass exposing the protected `stateFilePath`/`userDataPath` seams so tests can point them at a real scratch directory or assert their composition directly. */
class TestableFirstRunWizardService extends FirstRunWizardService {
  public override stateFilePath(): string {
    return super.stateFilePath();
  }
  public override userDataPath(): string {
    return super.userDataPath();
  }
}

/** Build an `ElectronStoreService` stub whose `set()`/`delete()` calls are observable. */
function makeStore(): ElectronStoreService {
  const store: Partial<ElectronStoreService> = { set: vi.fn(), delete: vi.fn() };
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
    vi.mocked(logger.debug).mockClear();
    vi.mocked(logger.info).mockClear();
    vi.mocked(logger.warn).mockClear();
    vi.mocked(logger.error).mockClear();
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

    it('should never write an excess property on the guidedIam payload to disk, even though it passes the enum/type guards unnoticed', async () => {
      await service.recordStep(
        'guided-iam',
        {
          subState: 'complete',
          hasBootstrapKey: false,
          smuggled: 'should-never-reach-disk',
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- deliberately smuggling an extra field past the compile-time type to exercise the write-side allowlist
        } as any,
      );

      const rawContent = readFileSync(statePath, 'utf-8');
      expect(rawContent).not.toContain('smuggled');
      expect(rawContent).not.toContain('should-never-reach-disk');
      expect(JSON.parse(rawContent)).toEqual({
        step: 'guided-iam',
        guidedIam: { subState: 'complete', hasBootstrapKey: false },
      });
    });

    it('should omit guidedIam from the written file when not supplied', async () => {
      await service.recordStep('guided-iam');

      expect(JSON.parse(readFileSync(statePath, 'utf-8'))).toEqual({ step: 'guided-iam' });
    });

    it('should log the step name at debug before writing the state file', async () => {
      await service.recordStep('bootstrap');

      expect(vi.mocked(logger.debug)).toHaveBeenCalledWith(
        expect.stringContaining('bootstrap'),
        expect.objectContaining({ step: 'bootstrap' }),
      );
    });

    it('should include the guided-IAM sub-state in the debug log when present', async () => {
      await service.recordStep('guided-iam', { subState: 'awaiting-key-intake', hasBootstrapKey: false });

      expect(vi.mocked(logger.debug)).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ step: 'guided-iam', guidedIamSubState: 'awaiting-key-intake' }),
      );
    });

    it('should reject a guidedIam sub-state outside GuidedIamSubState rather than writing it', async () => {
      await expect(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- deliberately bypassing the compile-time type to exercise the runtime guard
        service.recordStep('guided-iam', { subState: 'not-a-real-substate' as any, hasBootstrapKey: false }),
      ).rejects.toThrow('Unsupported guided-IAM sub-state');
      expect(existsSync(statePath)).toBe(false);
    });

    it('should reject a non-boolean hasBootstrapKey rather than writing it, without echoing the value into the thrown error', async () => {
      await expect(
        service.recordStep('guided-iam', {
          subState: 'complete',
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- deliberately bypassing the compile-time type to exercise the runtime guard: a malicious/malformed IPC payload could smuggle secret-shaped material here
          hasBootstrapKey: 'AKIAABCDEFGHIJKLMNOP' as any,
        }),
      ).rejects.toThrow(/Unsupported guided-IAM sub-state/);
      // The rejected value must never be written to disk...
      expect(existsSync(statePath)).toBe(false);
      // ...nor echoed into the thrown error message.
      try {
        await service.recordStep('guided-iam', {
          subState: 'complete',
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- deliberately bypassing the compile-time type to exercise the runtime guard
          hasBootstrapKey: 'AKIAABCDEFGHIJKLMNOP' as any,
        });
        expect.unreachable('recordStep should have thrown');
      } catch (err) {
        expect(String(err)).not.toContain('AKIAABCDEFGHIJKLMNOP');
      }
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

    it('should log at info once the wizard is marked complete', async () => {
      await service.complete();

      expect(vi.mocked(logger.info)).toHaveBeenCalledWith('FirstRunWizardService: wizard marked complete');
    });
  });

  describe('reset', () => {
    it('should clear the resume file', async () => {
      await service.recordStep('bootstrap');
      expect(existsSync(statePath)).toBe(true);

      await service.reset();

      expect(existsSync(statePath)).toBe(false);
      expect(await service.getProgress()).toEqual({ step: 'pick-cloud' });
    });

    it('should set wizardCompleted to false rather than deleting it', async () => {
      await service.reset();

      expect(store.set).toHaveBeenCalledWith('wizardCompleted', false);
    });

    it('should delete activeCloud, aws, bootstrap, and creds from the store', async () => {
      await service.reset();

      expect(store.delete).toHaveBeenCalledWith('activeCloud');
      expect(store.delete).toHaveBeenCalledWith('aws');
      expect(store.delete).toHaveBeenCalledWith('bootstrap');
      expect(store.delete).toHaveBeenCalledWith('creds');
    });

    it('should never touch pulumi state — passphrase and lock-ownership records belong to an already-provisioned stack, not wizard progress', async () => {
      await service.reset();

      expect(store.delete).not.toHaveBeenCalledWith('pulumi');
      expect(store.set).not.toHaveBeenCalledWith('pulumi', expect.anything());
    });

    it('should not throw when the resume file never existed', async () => {
      await expect(service.reset()).resolves.toBeUndefined();
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
