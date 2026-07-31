import { Injectable } from '@nestjs/common';
import { mkdir, readFile, rm, writeFile } from 'fs/promises';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { createRequire } from 'module';
import { WIZARD_STEPS, type WizardStep } from '@hyveon/shared';
import { ElectronStoreService } from './ElectronStoreService.js';

/** A single first-run wizard step name (see {@link WIZARD_STEPS} in `@hyveon/shared`, the single source of truth for step ordering). */
export type WizardStepName = WizardStep;

/** Resumable wizard progress persisted to `userData/wizard-state.json`. */
export interface WizardProgress {
  step: WizardStepName;
}

/** Progress returned when the state file is missing, unreadable, or holds an unrecognized step name. */
const DEFAULT_PROGRESS: WizardProgress = { step: 'pick-cloud' };

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

  /** Reads the last-recorded step, defaulting to `pick-cloud` when the file is missing, unreadable, or corrupt. */
  async getProgress(): Promise<WizardProgress> {
    try {
      const raw = await readFile(this.stateFilePath(), 'utf-8');
      const parsed = JSON.parse(raw) as Partial<WizardProgress>;
      if (parsed.step && WIZARD_STEPS.includes(parsed.step)) {
        return { step: parsed.step };
      }
      return DEFAULT_PROGRESS;
    } catch {
      return DEFAULT_PROGRESS;
    }
  }

  /**
   * Persists `step` so the wizard resumes here if the app is closed and
   * reopened before completion. `step`'s compile-time type is erased at the
   * IPC boundary — the caller in `WizardController.saveProgress` is only as
   * trustworthy as the renderer process — so this validates against
   * {@link WIZARD_STEPS} before writing, rather than silently persisting an
   * unsupported value that `getProgress` would later discard anyway.
   */
  async recordStep(step: WizardStepName): Promise<void> {
    if (!WIZARD_STEPS.includes(step)) {
      throw new Error(`Unsupported wizard step: ${String(step)}`);
    }
    const path = this.stateFilePath();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({ step } satisfies WizardProgress), 'utf-8');
  }

  /**
   * Marks the wizard complete. Setting `wizardCompleted: true` in
   * `ElectronStoreService` is what actually gates the app router past the
   * wizard (`WizardController.getState`). Also clears the resume file —
   * without this, a future re-entry into the wizard (e.g. #211's Settings
   * "Reconfigure" flow) would call `getProgress()` and jump straight back
   * to whatever step was last recorded (often `terraform-init`), skipping
   * every earlier step with none of their answers rehydrated.
   *
   * @remarks
   * The resume file is removed *before* setting the completion flag, not
   * after: if `rm` were to throw with the flag already set, the caller
   * would see `complete()` reject (a failure) while the store already says
   * the wizard is done — a future launch would then skip the wizard
   * entirely despite the IPC call having reported failure, with the stale
   * resume file still lingering. Removing first means any failure here
   * leaves the wizard genuinely incomplete, matching what the caller was told.
   */
  async complete(): Promise<void> {
    await rm(this.stateFilePath(), { force: true });
    this.store.set('wizardCompleted', true);
  }

  /** Absolute path to the resumable state file. Extracted as a seam so tests can `vi.spyOn` it. */
  protected stateFilePath(): string {
    return join(this.userDataPath(), 'wizard-state.json');
  }

  /**
   * Resolves a writable per-user directory: the Electron `userData` path
   * when running inside Electron, or a namespaced OS temp subdirectory in
   * plain-Node/test contexts. Mirrors `ConfigService.readUserDataPath`'s
   * dynamic-require seam so this module has no static `electron` import
   * (which would fail to resolve outside an Electron process).
   *
   * @remarks
   * The tmpdir fallback is namespaced under `hyveon-wizard` (mirroring
   * `ConfigService.getRunsDir`'s `hyveon-runs` prefix) rather than writing
   * directly into the bare, world-writable `tmpdir()` root — an unnamespaced
   * path there is guessable and poses a symlink-pre-creation risk, since
   * `writeFile` follows symlinks.
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
    return join(tmpdir(), 'hyveon-wizard');
  }
}
