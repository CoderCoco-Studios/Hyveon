import 'reflect-metadata';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { FirstRunWizardService } from './FirstRunWizardService.js';
import type { ElectronStoreService } from './ElectronStoreService.js';

/** Test-only subclass exposing the protected `stateFilePath` seam so tests can point it at a real scratch directory. */
class TestableFirstRunWizardService extends FirstRunWizardService {
  public override stateFilePath(): string {
    return super.stateFilePath();
  }
}

/** Build an `ElectronStoreService` stub whose `set()` calls are observable. */
function makeStore(): ElectronStoreService {
  return { set: vi.fn() } as Partial<ElectronStoreService> as ElectronStoreService;
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
    it('should default to the prerequisites step when the state file does not exist', async () => {
      const progress = await service.getProgress();
      expect(progress).toEqual({ step: 'prerequisites' });
    });

    it('should return the persisted step when the state file holds a recognized step name', async () => {
      writeFileSync(statePath, JSON.stringify({ step: 'bootstrap' }), 'utf-8');
      const progress = await service.getProgress();
      expect(progress).toEqual({ step: 'bootstrap' });
    });

    it('should default to the prerequisites step when the file contains invalid JSON', async () => {
      writeFileSync(statePath, 'not valid json{{{', 'utf-8');
      const progress = await service.getProgress();
      expect(progress).toEqual({ step: 'prerequisites' });
    });

    it('should default to the prerequisites step when the file holds an unrecognized step name', async () => {
      writeFileSync(statePath, JSON.stringify({ step: 'some-future-step' }), 'utf-8');
      const progress = await service.getProgress();
      expect(progress).toEqual({ step: 'prerequisites' });
    });
  });

  describe('recordStep', () => {
    it('should write the given step to the state file, creating parent directories as needed', async () => {
      expect(existsSync(statePath)).toBe(false);

      await service.recordStep('credentials');

      expect(JSON.parse(readFileSync(statePath, 'utf-8'))).toEqual({ step: 'credentials' });
    });

    it('should be resumable: a later getProgress reflects the step recorded by an earlier recordStep', async () => {
      await service.recordStep('terraform-init');

      const progress = await service.getProgress();

      expect(progress).toEqual({ step: 'terraform-init' });
    });

    it('should overwrite a previously recorded step', async () => {
      await service.recordStep('pick-cloud');
      await service.recordStep('bootstrap');

      expect(await service.getProgress()).toEqual({ step: 'bootstrap' });
    });
  });

  describe('complete', () => {
    it('should set wizardCompleted to true in ElectronStoreService', () => {
      service.complete();
      expect(store.set).toHaveBeenCalledWith('wizardCompleted', true);
    });
  });
});
