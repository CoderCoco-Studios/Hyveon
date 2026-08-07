import { Injectable } from '@nestjs/common';
import { mkdir, readFile, rm, writeFile } from 'fs/promises';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { createRequire } from 'module';
import { WIZARD_STEPS, type WizardStep } from '@hyveon/shared';
import { logger } from '../logger.js';
import { ElectronStoreService } from './ElectronStoreService.js';

/** A single first-run wizard step name (see {@link WIZARD_STEPS} in `@hyveon/shared`, the single source of truth for step ordering). */
export type WizardStepName = WizardStep;

/**
 * Sub-state of the guided-IAM step's own internal (5-call) flow, tracked
 * separately from the overall wizard step name so a relaunch mid-flow can
 * resume directly into the right screen instead of restarting the whole
 * step. Only meaningful when `step === 'guided-iam'` — this is a documented
 * convention, not a type-level constraint, since the guided-IAM step is the
 * only wizard step with internal sub-progress worth persisting.
 */
export type GuidedIamSubState = 'not-started' | 'template-written' | 'awaiting-key-intake' | 'rotation-pending' | 'complete';

/** The full set of valid {@link GuidedIamSubState} values, used to validate a persisted or IPC-supplied sub-state before trusting it. */
const GUIDED_IAM_SUB_STATES: readonly GuidedIamSubState[] = [
  'not-started',
  'template-written',
  'awaiting-key-intake',
  'rotation-pending',
  'complete',
];

/** Resumable wizard progress persisted to `userData/wizard-state.json`. */
export interface WizardProgress {
  step: WizardStepName;
  /** Present only while `step === 'guided-iam'` has ever recorded sub-progress. */
  guidedIam?: {
    subState: GuidedIamSubState;
    /** Whether a bootstrap key was ever submitted this session — never the key itself. */
    hasBootstrapKey: boolean;
  };
}

/** Progress returned when the state file is missing, unreadable, or holds an unrecognized step name. */
const DEFAULT_PROGRESS: WizardProgress = { step: 'pick-cloud' };

/**
 * Owns the first-run wizard's resumable step-progress file
 * (`userData/state.json`; corrupt or missing state starts at step 1). Durable
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

  /**
   * Reads the last-recorded step, defaulting to `pick-cloud` when the file
   * is missing, unreadable, or corrupt. `guidedIam` is validated the same
   * way — trust nothing read off disk — and degrades to `undefined` (the
   * field simply absent from the returned {@link WizardProgress}) rather
   * than passing through a malformed sub-state, matching the top-level
   * `step` degrade-on-corruption behavior below.
   */
  async getProgress(): Promise<WizardProgress> {
    try {
      const raw = await readFile(this.stateFilePath(), 'utf-8');
      const parsed = JSON.parse(raw) as Partial<WizardProgress>;
      if (!parsed.step || !WIZARD_STEPS.includes(parsed.step)) {
        return DEFAULT_PROGRESS;
      }
      const guidedIam = this.validateGuidedIam(parsed.guidedIam);
      return guidedIam ? { step: parsed.step, guidedIam } : { step: parsed.step };
    } catch {
      return DEFAULT_PROGRESS;
    }
  }

  /**
   * Persists `step` (and, once the guided-IAM step has made progress, its
   * `guidedIam` sub-state) so the wizard resumes here if the app is closed
   * and reopened before completion. Both fields' compile-time types are
   * erased at the IPC boundary — the caller in `WizardController.saveProgress`
   * is only as trustworthy as the renderer process — so this validates `step`
   * against {@link WIZARD_STEPS} and, when supplied, both `guidedIam.subState`
   * against {@link GUIDED_IAM_SUB_STATES} and `guidedIam.hasBootstrapKey`'s
   * runtime type (must be a genuine `boolean`) before writing — mirroring
   * `getProgress`'s own read-side validation, so a malformed/malicious
   * `hasBootstrapKey` (e.g. a pasted access key string) can never even reach
   * disk, not just get stripped back out on the next read. The object
   * actually written is rebuilt field-by-field from the validated values
   * (see the `progress` assignment below), not the caller's `guidedIam`
   * object verbatim — an excess property on that object (anything beyond
   * `subState`/`hasBootstrapKey`) is dropped before `JSON.stringify` ever
   * sees it, not merely stripped back out on the next `getProgress()` read.
   * `guidedIam` never carries `secretAccessKey`/`accessKeyId` — see
   * {@link WizardProgress.guidedIam}'s own doc comment; `hasBootstrapKey` is
   * a boolean flag only.
   */
  async recordStep(step: WizardStepName, guidedIam?: WizardProgress['guidedIam']): Promise<void> {
    if (!WIZARD_STEPS.includes(step)) {
      throw new Error(`Unsupported wizard step: ${String(step)}`);
    }
    if (guidedIam && !GUIDED_IAM_SUB_STATES.includes(guidedIam.subState)) {
      throw new Error(`Unsupported guided-IAM sub-state: ${String(guidedIam.subState)}`);
    }
    // `hasBootstrapKey`'s value is deliberately never echoed into this error
    // message (unlike `subState` above) — a malformed/malicious IPC payload
    // could otherwise smuggle secret-shaped material (e.g. a pasted access
    // key) into a thrown error that a caller might log.
    if (guidedIam && typeof guidedIam.hasBootstrapKey !== 'boolean') {
      throw new Error('Unsupported guided-IAM sub-state: hasBootstrapKey must be a boolean');
    }
    logger.debug(`FirstRunWizardService: recording wizard step "${step}"`, {
      step,
      guidedIamSubState: guidedIam?.subState,
    });
    const path = this.stateFilePath();
    await mkdir(dirname(path), { recursive: true });
    // Rebuilt from only the two known fields — never the caller's
    // `guidedIam` object spread/passed through verbatim — so an excess
    // property on a malformed/malicious payload (e.g.
    // `{ subState, hasBootstrapKey, smuggled: '...' }`, which passes the
    // enum/type guards above unnoticed) never reaches `JSON.stringify` and
    // never lands on disk.
    const progress: WizardProgress = guidedIam
      ? { step, guidedIam: { subState: guidedIam.subState, hasBootstrapKey: guidedIam.hasBootstrapKey } }
      : { step };
    await writeFile(path, JSON.stringify(progress), 'utf-8');
    logger.info(`FirstRunWizardService: wizard advanced to step "${step}"${guidedIam ? ` (guided-IAM: ${guidedIam.subState})` : ''}`);
  }

  /**
   * Validates a persisted `guidedIam` blob read off disk, returning
   * `undefined` (the field treated as wholly absent) unless both `subState`
   * is one of the five {@link GuidedIamSubState} literals and
   * `hasBootstrapKey` is a plain boolean — never partially trusting a
   * malformed value.
   */
  private validateGuidedIam(value: unknown): WizardProgress['guidedIam'] {
    if (typeof value !== 'object' || value === null) {
      return undefined;
    }
    const candidate = value as Partial<NonNullable<WizardProgress['guidedIam']>>;
    if (typeof candidate.subState !== 'string' || !GUIDED_IAM_SUB_STATES.includes(candidate.subState as GuidedIamSubState)) {
      return undefined;
    }
    if (typeof candidate.hasBootstrapKey !== 'boolean') {
      return undefined;
    }
    return { subState: candidate.subState as GuidedIamSubState, hasBootstrapKey: candidate.hasBootstrapKey };
  }

  /**
   * Marks the wizard complete. Setting `wizardCompleted: true` in
   * `ElectronStoreService` is what actually gates the app router past the
   * wizard (`WizardController.getState`). Also clears the resume file —
   * without this, a future re-entry into the wizard (e.g. #211's Settings
   * "Reconfigure" flow) would call `getProgress()` and jump straight back
   * to whatever step was last recorded (often `stack-init`), skipping
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
    logger.info('FirstRunWizardService: wizard marked complete');
  }

  /**
   * Resets the wizard back to its pre-first-run state: removes the resumable
   * `wizard-state.json` and clears every wizard-collected answer from
   * `ElectronStoreService` (`wizardCompleted`, `activeCloud`, `aws`,
   * `bootstrap`, `creds` — the pasted-credentials profiles from the
   * credentials/guided-IAM steps). The operator-facing escape hatch for a
   * wizard stuck in a bad state with no other way to start over.
   *
   * Deliberately does **not** touch `pulumi.*` (passphrase, lock-ownership
   * records, orphaned-rollback marker) — that state belongs to an
   * already-provisioned Pulumi stack, not wizard progress, and clearing the
   * passphrase would make that stack's encrypted state undecryptable.
   */
  async reset(): Promise<void> {
    await rm(this.stateFilePath(), { force: true });
    this.store.set('wizardCompleted', false);
    this.store.delete('activeCloud');
    this.store.delete('aws');
    this.store.delete('bootstrap');
    this.store.delete('creds');
    logger.warn('FirstRunWizardService: wizard state reset (operator-initiated)');
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
