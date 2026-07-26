import { Injectable } from '@nestjs/common';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { createRequire } from 'module';
import { ElectronStoreService } from './ElectronStoreService.js';

/**
 * Ordered first-run wizard steps whose progress is resumable via
 * `userData/wizard-state.json`. Mirrors `WIZARD_STEPS` in
 * `@hyveon/web`'s `wizard.utils.ts` — that file is the renderer's source of
 * truth for step ordering; keep this list in sync with it.
 */
export const WIZARD_STEP_NAMES = ['prerequisites', 'pick-cloud', 'credentials', 'bootstrap', 'terraform-init'] as const;

/** A single first-run wizard step name (see {@link WIZARD_STEP_NAMES}). */
export type WizardStepName = (typeof WIZARD_STEP_NAMES)[number];

/** Resumable wizard progress persisted to `userData/wizard-state.json`. */
export interface WizardProgress {
  step: WizardStepName;
}

/** Progress returned when the state file is missing, unreadable, or holds an unrecognized step name. */
const DEFAULT_PROGRESS: WizardProgress = { step: 'prerequisites' };

/**
 * Owns the first-run wizard's resumable step-progress file (see
 * `openspec/changes/add-first-run-wizard/design.md` decision 4 —
 * `userData/state.json`, corrupt/missing state starts at step 1). Durable
 * *answers* (`activeCloud`, `aws`, `wizardCompleted`) live in
 * `ElectronStoreService`; this service only tracks *which step* the
 * operator was on, so a wizard interrupted mid-flow resumes there instead of
 * restarting from scratch. A broken or missing resume file must never lock
 * an operator out of the wizard — every read degrades to
 * {@link DEFAULT_PROGRESS} rather than throwing.
 */
@Injectable()
export class FirstRunWizardService {
  constructor(private readonly store: ElectronStoreService) {}

  /** Reads the last-recorded step, defaulting to `prerequisites` when the file is missing, unreadable, or corrupt. */
  async getProgress(): Promise<WizardProgress> {
    try {
      const raw = await readFile(this.stateFilePath(), 'utf-8');
      const parsed = JSON.parse(raw) as Partial<WizardProgress>;
      if (parsed.step && (WIZARD_STEP_NAMES as readonly string[]).includes(parsed.step)) {
        return { step: parsed.step };
      }
      return DEFAULT_PROGRESS;
    } catch {
      return DEFAULT_PROGRESS;
    }
  }

  /** Persists `step` so the wizard resumes here if the app is closed and reopened before completion. */
  async recordStep(step: WizardStepName): Promise<void> {
    const path = this.stateFilePath();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({ step } satisfies WizardProgress), 'utf-8');
  }

  /**
   * Marks the wizard complete. Setting `wizardCompleted: true` in
   * `ElectronStoreService` is what actually gates the app router past the
   * wizard (`WizardController.getState`) — the resume file is left in place
   * but becomes irrelevant once this flag is set.
   */
  complete(): void {
    this.store.set('wizardCompleted', true);
  }

  /** Absolute path to the resumable state file. Extracted as a seam so tests can `vi.spyOn` it. */
  protected stateFilePath(): string {
    return join(this.userDataPath(), 'wizard-state.json');
  }

  /**
   * Resolves a writable per-user directory: the Electron `userData` path
   * when running inside Electron, or the OS temp directory in
   * plain-Node/test contexts. Mirrors `ConfigService.readUserDataPath`'s
   * dynamic-require seam so this module has no static `electron` import
   * (which would fail to resolve outside an Electron process).
   */
  protected userDataPath(): string {
    if (process.versions['electron']) {
      try {
        const require = createRequire(import.meta.url);
        const electron = require('electron') as { app: { getPath(name: string): string } };
        return electron.app.getPath('userData');
      } catch {
        // Fall through to the tmpdir fallback below.
      }
    }
    return tmpdir();
  }
}
