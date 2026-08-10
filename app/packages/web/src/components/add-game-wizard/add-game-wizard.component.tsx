/**
 * Wizard shell for declaring a new `game_servers` entry (#99): a self-contained
 * `<Dialog>` — trigger, six-step navigation, and the submit handler — built
 * from the step components and validation utilities already assembled for
 * this issue (`identity-step`, `resources-step`, `networking-step`,
 * `storage-step`, `environment-step`, `review-step`, `wizard-form.utils`).
 *
 * The wizard owns every piece of its own state (open/closed, current step,
 * in-progress {@link WizardDraft}, the existing-games list used for
 * client-side collision checks, and submit status) so it can be dropped in
 * anywhere — e.g. on `/games` — without the caller wiring anything beyond
 * rendering `<AddGameWizard />`.
 *
 * "Next" (or, on the final step, "Submit") is disabled whenever the active
 * step has outstanding issues — either from client-side `validateStep`
 * (mirroring the same zod schema + business rules the server enforces, see
 * `wizard-form.utils.ts`) or from a server-reported validation failure the
 * client didn't catch. On submit, every {@link GameWriteResult} branch is
 * handled explicitly:
 *
 * - `ok: true` — success toast, redirect to `/games/:name`, dialog closes,
 *   the saved draft is cleared, and the in-memory draft resets.
 * - `code: 'validation'` — the dialog stays open; the returned issues are
 *   stored and the wizard jumps to the earliest step whose fields they
 *   belong to (via {@link stepForIssuePath}) so the offending fields render
 *   highlighted.
 * - `code: 'conflict' | 'not_found' | 'error'` — the dialog stays open, the
 *   wizard jumps to the Review step, and the server's message is surfaced
 *   via {@link ReviewStep}'s `submitError` prop.
 *
 * The in-progress draft is also debounce-autosaved (`api.saveGameDraft`,
 * ~1s after the operator stops typing) so it survives closing/relaunching
 * the app, flushed immediately on dialog close so no edit is lost to the
 * timer, and cleared (`api.clearGameDraft`) only on a successful submit —
 * never on a validation/conflict/error failure, since the operator still
 * needs it to retry. `initialDraft`/`initialStepIndex` let a caller (the
 * games-page "resume draft" banner) reopen the dialog pre-populated with a
 * previously saved draft; that same caller passes `hideTrigger` so the
 * resumed instance — which already self-opens and gets unmounted once its
 * banner goes away — never leaves behind a second, dangling "Add game"
 * trigger button once the operator closes it.
 */

import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { Plus, Loader2 } from 'lucide-react';
import type { GameServerValidationIssue } from '@hyveon/shared/gameServerValidator';
import { Button } from '@/components/ui/button.component';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog.component';
import { api, type GameServer } from '../../api.service.js';
import { IdentityStep } from './identity-step.component.js';
import { ResourcesStep } from './resources-step.component.js';
import { NetworkingStep } from './networking-step.component.js';
import { StorageStep } from './storage-step.component.js';
import { EnvironmentStep } from './environment-step.component.js';
import { ReviewStep } from './review-step.component.js';
import {
  WIZARD_STEPS,
  createEmptyWizardDraft,
  draftToPayload,
  stepForIssuePath,
  validateStep,
  type WizardDraft,
  type WizardStep,
} from './wizard-form.utils.js';

/** Human-readable heading for each {@link WizardStep}, shown in the dialog description. */
const STEP_LABELS: Record<WizardStep, string> = {
  identity: 'Identity',
  resources: 'Resources',
  networking: 'Networking',
  storage: 'Storage',
  environment: 'Environment',
  review: 'Review',
};

/** Props accepted by {@link AddGameWizard}. All optional — every existing call site (`<AddGameWizard />`) keeps working unchanged. */
export interface AddGameWizardProps {
  /** Pre-populates the draft, e.g. when resuming a saved draft from the games-page banner. Supplying this also opens the dialog immediately, skipping the trigger-button click. */
  initialDraft?: WizardDraft;
  /** Pre-populates the step index alongside `initialDraft`. Ignored without `initialDraft`. */
  initialStepIndex?: number;
  /**
   * Skips rendering the `Add game` trigger button, rendering just the
   * `Dialog`/`DialogContent`. Defaults to `false` so every pre-existing call
   * site keeps rendering its trigger unchanged. Intended for a resumed-draft
   * instance (which already self-opens via `initialDraft`) that has no
   * business offering a *second* way to re-open itself once closed — see the
   * games-page resume banner, the only caller that passes `true`.
   */
  hideTrigger?: boolean;
}

/**
 * Self-contained "Add game" dialog: renders its own trigger button, walks the
 * operator through the six wizard steps, and owns the `games.create` submit
 * handler. See the module doc above for the full submit-result contract.
 */
export function AddGameWizard({ initialDraft, initialStepIndex, hideTrigger = false }: AddGameWizardProps = {}) {
  const navigate = useNavigate();

  // Seeding `open`'s initial value from `initialDraft` (rather than a
  // controlled `open` prop the parent keeps passing every render) means the
  // dialog's own `handleOpenChange(false)` remains the single source of
  // truth for closing it — a resumed wizard can still be cancelled/closed
  // normally, unlike a parent-pinned `open={true}` prop that `Dialog` would
  // never see flip back to `false`.
  const [open, setOpen] = useState(initialDraft !== undefined);
  const [stepIndex, setStepIndex] = useState(initialStepIndex ?? 0);
  const [draft, setDraft] = useState<WizardDraft>(initialDraft ?? createEmptyWizardDraft());
  const [existingGames, setExistingGames] = useState<GameServer[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [serverIssues, setServerIssues] = useState<GameServerValidationIssue[] | null>(null);

  // Mirrors `open` synchronously (not via effect) so an in-flight
  // `handleSubmit` can tell — the instant its promise settles — whether the
  // dialog was closed (Escape/overlay click, which Radix permits even while
  // `submitting`) while it was awaiting the server. Without this, a late
  // result would mutate the freshly-reset draft with stale step/error state.
  const openRef = useRef(open);

  /** True once the operator has made at least one edit — gates autosave so an untouched (or freshly-resumed, unedited) draft never writes itself back out. */
  const hasEditedRef = useRef(false);
  /** Pending debounce timer for the autosave effect below; cleared/replaced on every draft change, flushed immediately on close/unmount. */
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** Immediately writes any pending debounced save, bypassing the timer — call before the draft state it captured is discarded (dialog close, unmount). */
  function flushPendingSave() {
    if (saveTimerRef.current === null || !hasEditedRef.current) return;
    clearTimeout(saveTimerRef.current);
    saveTimerRef.current = null;
    void api.saveGameDraft(draft, stepIndex);
  }

  // `flushPendingSave` closes over this render's `draft`/`stepIndex`, so a
  // *stable* ref to "the latest one" is kept in sync after every render (an
  // effect, not a render-body assignment — refs must not be written during
  // render). The unmount-only effect below reads through this ref rather
  // than calling `flushPendingSave` directly, so that when it actually
  // fires (component torn down entirely, e.g. the operator navigates away
  // from `/games` while the dialog is still open) it flushes the draft as
  // of that moment — not the stale one captured back when the component
  // first mounted.
  const flushPendingSaveRef = useRef(flushPendingSave);
  useEffect(() => {
    flushPendingSaveRef.current = flushPendingSave;
  });

  // Declared *before* the debounce-autosave effect below so its cleanup runs
  // first at unmount: the debounce effect's own cleanup unconditionally
  // clears `saveTimerRef`, which would otherwise make this flush see "no
  // pending timer" and become a no-op. `handleOpenChange` already flushes
  // synchronously on a normal dialog close (Escape/overlay/Cancel/Submit),
  // so this only matters for the component being unmounted directly.
  useEffect(() => {
    return () => flushPendingSaveRef.current();
  }, []);

  // Debounce-autosaves the draft ~1s after the operator stops editing, so a
  // crash/close mid-edit still leaves a near-current draft on disk. Skipped
  // entirely until at least one edit has happened (`hasEditedRef`) and while
  // a submit is in flight (`submitting`) — the submit result itself decides
  // whether the saved draft should be cleared or left alone.
  useEffect(() => {
    if (!hasEditedRef.current || submitting) return;
    if (saveTimerRef.current !== null) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null;
      void api.saveGameDraft(draft, stepIndex);
    }, 1000);
    return () => {
      if (saveTimerRef.current !== null) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
    };
  }, [draft, stepIndex, submitting]);

  const step = WIZARD_STEPS[stepIndex];

  // Refreshes the existing-games list (used for name/port collision checks)
  // every time the dialog opens, so a game declared in a previous session
  // is taken into account without requiring a page reload.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    api
      .games()
      .then(({ games }) => {
        if (cancelled) return;
        setExistingGames(games.flatMap((entry) => (entry.config ? [entry.config] : [])));
      })
      .catch(() => {
        if (!cancelled) setExistingGames([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  /** Resets every piece of wizard state back to a blank first step. */
  function resetWizard() {
    setStepIndex(0);
    setDraft(createEmptyWizardDraft());
    setSubmitError(null);
    setServerIssues(null);
    setSubmitting(false);
    hasEditedRef.current = false;
  }

  /** Handles the dialog's own open/close, flushing any pending autosave and resetting the draft on close. */
  function handleOpenChange(next: boolean) {
    openRef.current = next;
    setOpen(next);
    if (!next) {
      flushPendingSave();
      resetWizard();
    }
  }

  /**
   * Applies a partial patch to the draft. Any stale server-reported error
   * state is cleared, since the operator is actively fixing the draft that
   * produced it.
   */
  function patchDraft(patch: Partial<WizardDraft>) {
    hasEditedRef.current = true;
    setServerIssues(null);
    setSubmitError(null);
    setDraft((prev) => ({ ...prev, ...patch }));
  }

  const liveIssues = validateStep(step, draft, existingGames);
  const stepIssues = serverIssues
    ? step === 'review'
      ? serverIssues
      : serverIssues.filter((issue) => stepForIssuePath(issue.path) === step)
    : liveIssues;

  const advanceDisabled = stepIssues.length > 0;

  function goNext() {
    setStepIndex((index) => Math.min(index + 1, WIZARD_STEPS.length - 1));
  }

  function goBack() {
    setStepIndex((index) => Math.max(index - 1, 0));
  }

  /**
   * Submits the draft via `api.createGame` and routes every
   * {@link GameWriteResult} branch to the right UI reaction — see the module
   * doc for the full contract.
   */
  async function handleSubmit() {
    setSubmitting(true);
    setSubmitError(null);
    setServerIssues(null);

    try {
      const payload = draftToPayload(draft);
      const result = await api.createGame(payload);

      // The dialog may have been closed (Escape/overlay click) while this
      // request was in flight — Radix allows that even with `submitting`
      // true. `resetWizard()` already ran via `handleOpenChange`, so this
      // stale result must not overwrite the freshly-reset draft.
      if (!openRef.current) return;

      if (result.ok) {
        toast.success(`${payload.name} created`, {
          description: 'Run plan and apply on the Infrastructure page to deploy it.',
        });
        void api.clearGameDraft();
        handleOpenChange(false);
        navigate(`/games/${payload.name}`);
        return;
      }

      switch (result.code) {
        case 'validation': {
          setServerIssues(result.issues);
          const firstIssuePath = result.issues[0]?.path;
          const targetStep = firstIssuePath ? stepForIssuePath(firstIssuePath) : 'review';
          setStepIndex(WIZARD_STEPS.indexOf(targetStep));
          break;
        }
        case 'conflict':
        case 'not_found':
        case 'setup_incomplete':
        case 'error':
          setSubmitError(result.message);
          setStepIndex(WIZARD_STEPS.length - 1);
          break;
      }
    } catch (err) {
      if (!openRef.current) return;
      setSubmitError(err instanceof Error ? err.message : 'Failed to create game.');
      setStepIndex(WIZARD_STEPS.length - 1);
    } finally {
      if (openRef.current) setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      {!hideTrigger && (
        <DialogTrigger asChild>
          <Button type="button">
            <Plus />
            Add game
          </Button>
        </DialogTrigger>
      )}
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Add a game server</DialogTitle>
          <DialogDescription>
            Step {stepIndex + 1} of {WIZARD_STEPS.length}: {STEP_LABELS[step]}
          </DialogDescription>
        </DialogHeader>

        {step === 'identity' && <IdentityStep draft={draft} issues={stepIssues} onChange={patchDraft} />}
        {step === 'resources' && (
          <ResourcesStep cpu={draft.cpu} memory={draft.memory} issues={stepIssues} onChange={patchDraft} />
        )}
        {step === 'networking' && (
          <NetworkingStep
            ports={draft.ports}
            issues={stepIssues}
            onChange={(ports) => patchDraft({ ports })}
            https={draft.https}
            onHttpsChange={(https) => patchDraft({ https })}
          />
        )}
        {step === 'storage' && <StorageStep draft={draft} issues={stepIssues} onChange={patchDraft} />}
        {step === 'environment' && <EnvironmentStep draft={draft} issues={stepIssues} onChange={patchDraft} />}
        {step === 'review' && <ReviewStep draft={draft} issues={stepIssues} submitError={submitError} />}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={goBack} disabled={stepIndex === 0 || submitting}>
            Back
          </Button>
          {step === 'review' ? (
            <Button type="button" onClick={handleSubmit} disabled={advanceDisabled || submitting}>
              {submitting && <Loader2 className="animate-spin" />}
              Submit
            </Button>
          ) : (
            <Button type="button" onClick={goNext} disabled={advanceDisabled}>
              Next
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
