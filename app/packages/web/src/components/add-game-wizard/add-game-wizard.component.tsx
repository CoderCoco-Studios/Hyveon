/**
 * Wizard shell for declaring a new `game_servers` entry: a self-contained
 * `<Dialog>` with six-step navigation and a submit handler.
 *
 * On a `code: 'validation'` submit result the wizard jumps to the earliest
 * step whose fields the returned issues belong to (via
 * {@link stepForIssuePath}), so the offending fields render highlighted.
 *
 * The in-progress draft is debounce-autosaved (`api.saveGameDraft`, ~1s after
 * the operator stops typing), flushed immediately on dialog close, and
 * cleared (`api.clearGameDraft`) only on a successful submit — never on a
 * validation/conflict/error failure, since the operator still needs it to
 * retry. `initialDraft`/`hideTrigger` let a caller (the games-page "resume
 * draft" banner) reopen the dialog pre-populated with a saved draft without
 * leaving behind a second, dangling "Add game" trigger button.
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
import { useWizardDraftAutosave } from './use-wizard-draft-autosave.hook.js';
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
  /**
   * Called after the dialog closes (Escape/overlay click/Cancel, or a
   * successful submit) — after the pending autosave flush and internal
   * state reset. Lets a caller mounting a resumed-draft instance
   * (`hideTrigger`) know when to stop rendering it and restore its own
   * resume/discard banner, rather than leaving that banner permanently
   * hidden once `resuming` is set — see the games-page resume banner, the
   * only caller that passes this.
   */
  onClose?: () => void;
}

/**
 * Self-contained "Add game" dialog: renders its own trigger button, walks the
 * operator through the six wizard steps, and owns the `games.create` submit
 * handler. See the module doc above for the full submit-result contract.
 */
export function AddGameWizard({
  initialDraft,
  initialStepIndex,
  hideTrigger = false,
  onClose,
}: AddGameWizardProps = {}) {
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

  const { markFieldEdited, flush: flushPendingSave, reset: resetAutosave } = useWizardDraftAutosave({
    draft,
    stepIndex,
    submitting,
    hasStoredDraftInitially: initialDraft !== undefined,
  });

  const step = WIZARD_STEPS[stepIndex];

  // The step body's scroll container is a single persistent DOM node whose
  // children swap as `stepIndex` changes, so a scroll offset left over from
  // one step would otherwise carry over to the next.
  const stepBodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (stepBodyRef.current) stepBodyRef.current.scrollTop = 0;
  }, [stepIndex]);

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
    resetAutosave();
  }

  /** Handles the dialog's own open/close, flushing any pending autosave and resetting the draft on close. */
  function handleOpenChange(next: boolean) {
    openRef.current = next;
    setOpen(next);
    if (!next) {
      flushPendingSave();
      resetWizard();
      onClose?.();
    }
  }

  /**
   * Applies a partial patch to the draft. Any stale server-reported error
   * state is cleared, since the operator is actively fixing the draft that
   * produced it.
   */
  function patchDraft(patch: Partial<WizardDraft>) {
    markFieldEdited();
    setServerIssues(null);
    setSubmitError(null);
    setDraft((prev) => ({ ...prev, ...patch }));
  }

  /**
   * Applies a partial patch to just the `healthCheck` sub-object, merging
   * against the latest state via `setDraft`'s functional updater rather than
   * the render-scoped `draft.healthCheck` — two patches dispatched in the
   * same React batch (e.g. from a caller that fires more than one in one
   * handler) would otherwise merge both against the same pre-update
   * snapshot, and the second `setDraft` call would silently discard the
   * first's change.
   */
  function patchHealthCheck(patch: Partial<WizardDraft['healthCheck']>) {
    markFieldEdited();
    setServerIssues(null);
    setSubmitError(null);
    setDraft((prev) => ({ ...prev, healthCheck: { ...prev.healthCheck, ...patch } }));
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
        // Awaited (not fire-and-forget) so the IPC clear has actually landed
        // before the dialog closes and the caller navigates away — otherwise
        // a fast reload of `/games` (or the games-page resume banner's own
        // `getGameDraft()` effect) could race the clear and briefly still
        // see the just-submitted draft as "unfinished".
        await api.clearGameDraft();
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
      <DialogContent className="flex max-h-[85vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
        <DialogHeader className="shrink-0 space-y-1.5 px-6 pt-6">
          <DialogTitle>Add a game server</DialogTitle>
          <DialogDescription>
            Step {stepIndex + 1} of {WIZARD_STEPS.length}: {STEP_LABELS[step]}
          </DialogDescription>
        </DialogHeader>

        <div ref={stepBodyRef} className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
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
              healthCheck={draft.healthCheck}
              onHealthCheckChange={patchHealthCheck}
            />
          )}
          {step === 'storage' && <StorageStep draft={draft} issues={stepIssues} onChange={patchDraft} />}
          {step === 'environment' && <EnvironmentStep draft={draft} issues={stepIssues} onChange={patchDraft} />}
          {step === 'review' && <ReviewStep draft={draft} issues={stepIssues} submitError={submitError} />}
        </div>

        <DialogFooter className="shrink-0 border-t border-[var(--color-border)] px-6 py-4">
          <Button type="button" variant="outline" onClick={goBack} disabled={stepIndex === 0 || submitting}>
            Back
          </Button>
          {step === 'review' ? (
            <Button type="button" onClick={() => void handleSubmit()} disabled={advanceDisabled || submitting}>
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
