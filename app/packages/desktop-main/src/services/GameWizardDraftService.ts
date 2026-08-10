import { Injectable } from '@nestjs/common';
import { logger } from '../logger.js';
import { ElectronStoreService, type GameWizardDraft, type StoredGameWizardDraft } from './ElectronStoreService.js';

/**
 * Owns the single in-progress add-game wizard draft slot in
 * `ElectronStoreService`. A corrupt or unexpectedly-shaped stored entry is
 * treated the same as no draft — {@link get} never throws and never returns
 * a value the caller can't trust, matching `FirstRunWizardService`'s
 * degrade-on-corruption behavior for its own resumable state.
 */
@Injectable()
export class GameWizardDraftService {
  constructor(private readonly store: ElectronStoreService) {}

  /**
   * Reads the saved draft, if any.
   *
   * @returns The saved draft, or `null` if none is saved or the stored
   *   entry is corrupt/unreadable.
   */
  get(): StoredGameWizardDraft | null {
    try {
      const stored = this.store.get('addGameWizardDraft');
      if (!isStoredGameWizardDraft(stored)) {
        if (stored !== undefined) {
          logger.warn('GameWizardDraftService: stored draft is malformed, treating as absent');
        }
        return null;
      }
      return stored;
    } catch (err) {
      logger.warn(`GameWizardDraftService: failed to read draft, treating as absent (${errorMessage(err)})`);
      return null;
    }
  }

  /**
   * Saves `draft` and `stepIndex`, stamping `savedAt` with the current time.
   * Failures are logged and swallowed — autosave is best-effort and must
   * never interrupt the operator mid-wizard.
   *
   * @param draft - The current wizard field values.
   * @param stepIndex - The wizard step the operator was on when this save fired.
   */
  save(draft: GameWizardDraft, stepIndex: number): void {
    try {
      this.store.set('addGameWizardDraft', { draft, stepIndex, savedAt: new Date().toISOString() });
    } catch (err) {
      logger.warn(`GameWizardDraftService: failed to save draft (${errorMessage(err)})`);
    }
  }

  /** Deletes the saved draft, if any. A no-op (still logged on failure) if none was saved. */
  clear(): void {
    try {
      this.store.delete('addGameWizardDraft');
    } catch (err) {
      logger.warn(`GameWizardDraftService: failed to clear draft (${errorMessage(err)})`);
    }
  }
}

/** Narrows `value` to a well-formed {@link StoredGameWizardDraft} — never partially trusting a malformed read. */
function isStoredGameWizardDraft(value: unknown): value is StoredGameWizardDraft {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<StoredGameWizardDraft>;
  if (typeof candidate.stepIndex !== 'number' || typeof candidate.savedAt !== 'string') return false;
  return isGameWizardDraft(candidate.draft);
}

/** Narrows `value` to a well-formed {@link GameWizardDraft}. */
function isGameWizardDraft(value: unknown): value is GameWizardDraft {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<GameWizardDraft>;
  return (
    typeof candidate.name === 'string' &&
    typeof candidate.image === 'string' &&
    typeof candidate.connect_message === 'string' &&
    (typeof candidate.cpu === 'number' || candidate.cpu === null) &&
    (typeof candidate.memory === 'number' || candidate.memory === null) &&
    Array.isArray(candidate.ports) &&
    Array.isArray(candidate.volumes) &&
    Array.isArray(candidate.file_seeds) &&
    Array.isArray(candidate.environment) &&
    typeof candidate.https === 'boolean'
  );
}

/** `Error.message` for a genuine `Error`, or `String(err)` otherwise — never logs a raw thrown value. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
