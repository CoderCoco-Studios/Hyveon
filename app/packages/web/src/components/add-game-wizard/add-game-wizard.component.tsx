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
import { Subject, merge } from 'rxjs';
import { debounceTime, filter } from 'rxjs/operators';
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

/**
 * One pending autosave/step-index-update, pushed through the debounce
 * subject in {@link AddGameWizard}. `hasFieldEdit` tells the subscriber
 * whether to persist the full `draft` (a genuine field edit happened) or
 * only `stepIndex` (step-only navigation, e.g. on a resumed draft) — see
 * `hasFieldEditRef`'s doc in {@link AddGameWizard} for why the distinction
 * matters.
 */
interface DraftSaveEvent {
  draft: WizardDraft;
  stepIndex: number;
  hasFieldEdit: boolean;
}

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

  // True once the operator has made at least one *field* edit via
  // `patchDraft` — gates the full `api.saveGameDraft` autosave so an
  // untouched draft never writes itself back out. This is distinct from
  // `hasStoredDraftRef` below: a *resumed* draft's in-memory copy came back
  // from `api.getGameDraft()` with `environment[].value` and
  // `file_seeds[].content`/`content_base64` already blanked out by
  // `GameWizardDraftService.get()`'s redaction (see that service's class
  // doc) — autosaving it via the same full-draft path the instant the
  // operator merely navigates a step, before they've touched a field, would
  // permanently overwrite the real, unredacted values still on disk with
  // those blanks. Step-only navigation on a resumed draft is instead
  // persisted through `updateGameDraftStepIndex`, which only ever touches
  // `stepIndex` on the main-process side and never re-sends `draft` at all.
  const hasFieldEditRef = useRef(false);

  // True once a draft is known to exist on disk for *this* wizard session —
  // seeded from `initialDraft` for a resumed draft, and flipped on after the
  // first successful full autosave. Gates the step-only
  // `updateGameDraftStepIndex` persistence: there's nothing to update the
  // `stepIndex` of if no draft has ever been saved yet.
  const hasStoredDraftRef = useRef(initialDraft !== undefined);

  // Mirrors `submitting` synchronously (same pattern as `openRef`) so the
  // debounced-save subscriber below can re-check it at the moment a debounced
  // value actually *fires* — not just at the moment it was pushed. A value
  // can be pushed while `submitting` is still `false` and sit in
  // `debounceTime`'s buffer for up to ~1s; if `handleSubmit` flips
  // `submitting` to `true` during that window, the buffered emission must
  // still be suppressed when it eventually fires.
  const submittingRef = useRef(submitting);
  useEffect(() => {
    submittingRef.current = submitting;
  });

  /**
   * Draft/step-index changes are pushed through this subject and debounced
   * ~1s (via RxJS's `debounceTime`, which resets its own internal timer on
   * every `next()` — no manual `setTimeout`/`clearTimeout` bookkeeping
   * needed) before persisting. `flush$` carries the same event shape but
   * bypasses both the debounce and the `submitting` check, for an immediate,
   * unconditional save on close/unmount (Radix permits closing the dialog
   * even mid-submit — see `openRef`'s doc — and the operator still needs
   * their draft preserved if that submit then fails). Both use `useState`'s
   * lazy-initializer form so the `Subject` is constructed exactly once per
   * mount rather than every render — the setter is never called, this is
   * "create-once storage," not render state.
   */
  const [save$] = useState(() => new Subject<DraftSaveEvent>());
  const [flush$] = useState(() => new Subject<DraftSaveEvent>());

  /** Immediately persists any pending change, bypassing the debounce — call before the draft state it captures is discarded (dialog close, unmount). */
  function flushPendingSave() {
    if (!hasFieldEditRef.current && !hasStoredDraftRef.current) return;
    flush$.next({ draft, stepIndex, hasFieldEdit: hasFieldEditRef.current });
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

  // Declared *before* the subscribe effect below so its cleanup runs first
  // at unmount: the subscribe effect's own cleanup unconditionally
  // unsubscribes, which would otherwise make a flush pushed from this
  // effect's cleanup fire into a dead subscription and silently do nothing.
  // `handleOpenChange` already flushes synchronously on a normal dialog
  // close (Escape/overlay/Cancel/Submit), so this ordering only matters for
  // the component being unmounted directly.
  useEffect(() => {
    return () => flushPendingSaveRef.current();
  }, []);

  // Subscribes once for the component's lifetime — `merge` combines the
  // debounced stream (gated on `submitting` at fire-time, via `filter` placed
  // *after* `debounceTime` so it re-checks the ref when the buffered value
  // actually emits) with the un-debounced, ungated flush stream into one
  // subscriber, which decides per-event whether to persist the full draft or
  // just the step index (see `hasFieldEditRef`'s doc above).
  useEffect(() => {
    const subscription = merge(
      save$.pipe(
        debounceTime(1000),
        filter(() => !submittingRef.current),
      ),
      flush$,
    ).subscribe(({ draft: eventDraft, stepIndex: eventStepIndex, hasFieldEdit }) => {
      if (hasFieldEdit) {
        void api.saveGameDraft(eventDraft, eventStepIndex);
        hasStoredDraftRef.current = true;
      } else if (hasStoredDraftRef.current) {
        void api.updateGameDraftStepIndex(eventStepIndex);
      }
    });
    return () => subscription.unsubscribe();
  }, [save$, flush$]);

  // Debounce-autosaves the draft ~1s after the operator stops editing, so a
  // crash/close mid-edit still leaves a near-current draft on disk. Skipped
  // entirely until either a field has been edited or a draft is already
  // known to exist on disk (`hasFieldEditRef`/`hasStoredDraftRef`), and
  // while a submit is in flight (`submitting`) — the submit result itself
  // decides whether the saved draft should be cleared or left alone.
  useEffect(() => {
    if (submitting) return;
    if (!hasFieldEditRef.current && !hasStoredDraftRef.current) return;
    save$.next({ draft, stepIndex, hasFieldEdit: hasFieldEditRef.current });
  }, [draft, stepIndex, submitting, save$]);

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
    hasFieldEditRef.current = false;
    hasStoredDraftRef.current = false;
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
    hasFieldEditRef.current = true;
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
