import { Injectable } from '@nestjs/common';
import { ADD_GAME_WIZARD_STEPS } from '@hyveon/shared';
import { logger } from '../logger.js';
import { ElectronStoreService, type GameWizardDraft, type StoredGameWizardDraft } from './ElectronStoreService.js';

/**
 * Owns the single in-progress add-game wizard draft slot in
 * `ElectronStoreService`. A corrupt or unexpectedly-shaped stored entry is
 * treated the same as no draft — {@link get} never throws and never returns
 * a value the caller can't trust, matching `FirstRunWizardService`'s
 * degrade-on-corruption behavior for its own resumable state.
 *
 * @remarks
 * {@link get} redacts secret-shaped fields (`environment[].value`,
 * `file_seeds[].content`/`content_base64`, `healthCheck.secretArn`) before
 * returning — the operator re-enters those values on resume. This keeps
 * pasted credentials or other
 * sensitive environment values from ever crossing the IPC boundary into the
 * renderer, matching the "secrets never reach the renderer" invariant. The
 * full, unredacted draft (including those fields) is still what gets
 * persisted by {@link save}, so nothing is lost on the main-process side —
 * only what's handed back to the renderer is stripped.
 */
@Injectable()
export class GameWizardDraftService {
  constructor(private readonly store: ElectronStoreService) {}

  /**
   * Reads the saved draft, if any, with secret-shaped fields redacted (see
   * the class doc's `@remarks`).
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
      return redactSecretFields(backfillHealthCheck(stored));
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

  /**
   * Updates only the `stepIndex` of an already-saved draft, leaving the
   * stored `draft` fields untouched, and re-stamps `savedAt`. A no-op if no
   * draft is currently saved or the stored entry is malformed.
   *
   * @remarks
   * Exists so the renderer can persist step-only navigation on a *resumed*
   * draft without going through {@link save} — the renderer only ever holds
   * the redacted copy {@link get} returns, so calling `save` with it would
   * permanently overwrite the real, unredacted `environment[].value`/
   * `file_seeds[].content` still on disk with blanked-out values. Reading
   * and rewriting the raw stored entry here means the secret-shaped fields
   * never round-trip through the renderer at all.
   *
   * @param stepIndex - The wizard step the operator navigated to.
   */
  updateStepIndex(stepIndex: number): void {
    if (!Number.isInteger(stepIndex) || stepIndex < 0 || stepIndex >= ADD_GAME_WIZARD_STEP_COUNT) return;
    try {
      const stored = this.store.get('addGameWizardDraft');
      if (!isStoredGameWizardDraft(stored)) return;
      this.store.set('addGameWizardDraft', { ...stored, stepIndex, savedAt: new Date().toISOString() });
    } catch (err) {
      logger.warn(`GameWizardDraftService: failed to update draft step index (${errorMessage(err)})`);
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

/**
 * Number of steps in the add-game wizard, from {@link ADD_GAME_WIZARD_STEPS}
 * in `@hyveon/shared` — the same source of truth `wizard-form.utils.ts` in
 * `@hyveon/web` re-exports as `WIZARD_STEPS` for step navigation.
 */
const ADD_GAME_WIZARD_STEP_COUNT = ADD_GAME_WIZARD_STEPS.length;

/** Narrows `value` to a well-formed {@link StoredGameWizardDraft} — never partially trusting a malformed read. */
function isStoredGameWizardDraft(value: unknown): value is StoredGameWizardDraft {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<StoredGameWizardDraft>;
  if (
    !Number.isInteger(candidate.stepIndex) ||
    (candidate.stepIndex as number) < 0 ||
    (candidate.stepIndex as number) >= ADD_GAME_WIZARD_STEP_COUNT
  ) {
    return false;
  }
  if (typeof candidate.savedAt !== 'string' || Number.isNaN(Date.parse(candidate.savedAt))) return false;
  return isGameWizardDraft(candidate.draft);
}

/** Narrows `value` to a well-formed {@link GameWizardDraft}, including every entry of its array fields. */
function isGameWizardDraft(value: unknown): value is GameWizardDraft {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<GameWizardDraft>;
  return (
    typeof candidate.name === 'string' &&
    typeof candidate.image === 'string' &&
    typeof candidate.connect_message === 'string' &&
    (candidate.cpu === null || (typeof candidate.cpu === 'number' && Number.isFinite(candidate.cpu))) &&
    (candidate.memory === null || (typeof candidate.memory === 'number' && Number.isFinite(candidate.memory))) &&
    Array.isArray(candidate.ports) &&
    candidate.ports.every(isWizardDraftPort) &&
    Array.isArray(candidate.volumes) &&
    candidate.volumes.every(isWizardDraftVolume) &&
    Array.isArray(candidate.file_seeds) &&
    candidate.file_seeds.every(isWizardDraftFileSeed) &&
    Array.isArray(candidate.environment) &&
    candidate.environment.every(isWizardDraftEnvironmentVariable) &&
    typeof candidate.https === 'boolean' &&
    // `healthCheck` was added after this draft slot shipped — a draft
    // autosaved before then has no such field, and that must still be
    // treated as valid rather than discarding the whole draft as malformed.
    (candidate.healthCheck === undefined || isWizardDraftHealthCheck(candidate.healthCheck))
  );
}

/** Narrows `value` to a well-formed health-check draft. */
function isWizardDraftHealthCheck(value: unknown): value is NonNullable<GameWizardDraft['healthCheck']> {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<NonNullable<GameWizardDraft['healthCheck']>>;
  return (
    typeof candidate.enabled === 'boolean' &&
    typeof candidate.scheme === 'string' &&
    (candidate.port === null || (typeof candidate.port === 'number' && Number.isFinite(candidate.port))) &&
    typeof candidate.path === 'string' &&
    typeof candidate.method === 'string' &&
    (candidate.timeoutMs === null || (typeof candidate.timeoutMs === 'number' && Number.isFinite(candidate.timeoutMs))) &&
    typeof candidate.jsonPath === 'string' &&
    typeof candidate.operator === 'string' &&
    typeof candidate.value === 'string' &&
    typeof candidate.secretArn === 'string' &&
    typeof candidate.secretSet === 'boolean'
  );
}

/** Narrows `value` to a well-formed port row: `container` is a finite number or `null`, `protocol` is a string. */
function isWizardDraftPort(value: unknown): value is GameWizardDraft['ports'][number] {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { container?: unknown; protocol?: unknown };
  return (
    (candidate.container === null || (typeof candidate.container === 'number' && Number.isFinite(candidate.container))) &&
    typeof candidate.protocol === 'string'
  );
}

/** Narrows `value` to a well-formed volume row: `name`/`container_path` are both strings. */
function isWizardDraftVolume(value: unknown): value is GameWizardDraft['volumes'][number] {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { name?: unknown; container_path?: unknown };
  return typeof candidate.name === 'string' && typeof candidate.container_path === 'string';
}

/** Narrows `value` to a well-formed file-seed row: `path`/`content`/`content_base64`/`mode` are all strings. */
function isWizardDraftFileSeed(value: unknown): value is GameWizardDraft['file_seeds'][number] {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { path?: unknown; content?: unknown; content_base64?: unknown; mode?: unknown };
  return (
    typeof candidate.path === 'string' &&
    typeof candidate.content === 'string' &&
    typeof candidate.content_base64 === 'string' &&
    typeof candidate.mode === 'string'
  );
}

/** Narrows `value` to a well-formed environment-variable row: `name`/`value` are both strings. */
function isWizardDraftEnvironmentVariable(value: unknown): value is GameWizardDraft['environment'][number] {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { name?: unknown; value?: unknown };
  return typeof candidate.name === 'string' && typeof candidate.value === 'string';
}

/**
 * Returns a copy of `stored` with secret-shaped fields blanked out —
 * `environment[].value`, `file_seeds[].content`/`content_base64`, and
 * `healthCheck.secretArn` — so the renderer never receives operator-entered
 * values it might consider sensitive (e.g. a pasted database password or a
 * health-check credential reference). Everything else, including row
 * `name`/`path`/`mode` and `healthCheck.secretSet`, is preserved so the
 * resumed form can still show which rows existed and whether a credential
 * is already configured; the operator re-enters the blanked values
 * themselves.
 */
/**
 * Default "no health check configured" shape, matching
 * `emptyHealthCheckDraft()` in `wizard-form.utils.ts` (`@hyveon/web`) — kept
 * in sync manually, per {@link GameWizardDraft}'s doc comment, since
 * `desktop-main` can't import from `@hyveon/web`.
 */
const DEFAULT_HEALTH_CHECK_DRAFT: NonNullable<GameWizardDraft['healthCheck']> = {
  enabled: false,
  scheme: 'http',
  port: null,
  path: '',
  method: 'GET',
  timeoutMs: 2000,
  jsonPath: '',
  operator: 'equals',
  value: '',
  secretArn: '',
  secretSet: false,
};

/** Fills in a missing `healthCheck` on a draft autosaved before that field existed, with {@link DEFAULT_HEALTH_CHECK_DRAFT}. */
function backfillHealthCheck(stored: StoredGameWizardDraft): StoredGameWizardDraft {
  if (stored.draft.healthCheck) return stored;
  return { ...stored, draft: { ...stored.draft, healthCheck: DEFAULT_HEALTH_CHECK_DRAFT } };
}

function redactSecretFields(stored: StoredGameWizardDraft): StoredGameWizardDraft {
  return {
    ...stored,
    draft: {
      ...stored.draft,
      file_seeds: stored.draft.file_seeds.map((seed) => ({ ...seed, content: '', content_base64: '' })),
      environment: stored.draft.environment.map((variable) => ({ ...variable, value: '' })),
      healthCheck: { ...(stored.draft.healthCheck ?? DEFAULT_HEALTH_CHECK_DRAFT), secretArn: '' },
    },
  };
}

/** `Error.message` for a genuine `Error`, or `String(err)` otherwise — never logs a raw thrown value. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
