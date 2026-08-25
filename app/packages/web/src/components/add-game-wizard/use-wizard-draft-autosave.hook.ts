/**
 * Debounce-autosave machinery for the add-game wizard's in-progress
 * {@link WizardDraft}, extracted from `AddGameWizard` (finding E5): the
 * caller owns `draft`/`stepIndex`/`submitting` as render state and passes
 * the current values in on every render; this hook owns everything about
 * *persisting* them — the RxJS debounce pipeline, the "has this draft ever
 * been saved" bookkeeping, and the immediate-flush path used on dialog
 * close/unmount.
 *
 * The effects below are declared in a specific order for a real reason —
 * **do not reorder them**. React runs effect cleanups in reverse
 * declaration order, and the unmount-flush effect's cleanup must still be
 * able to push into a *live* subscription, which requires the subscribe
 * effect's cleanup (unconditional `unsubscribe()`) to run *after* it. See
 * that effect's own comment below for the full reasoning.
 */

import { useEffect, useRef, useState } from 'react';
import { Subject, merge } from 'rxjs';
import { debounceTime, filter } from 'rxjs/operators';
import { api } from '../../api.service.js';
import type { WizardDraft } from './wizard-form.utils.js';

/**
 * One pending autosave/step-index-update, pushed through the debounce
 * subject below. `hasFieldEdit` tells the subscriber whether to persist the
 * full `draft` (a genuine field edit happened) or only `stepIndex`
 * (step-only navigation, e.g. on a resumed draft) — see the
 * `hasFieldEditRef` doc in {@link useWizardDraftAutosave} for why the
 * distinction matters.
 */
interface DraftSaveEvent {
  draft: WizardDraft;
  stepIndex: number;
  hasFieldEdit: boolean;
}

/** Options for {@link useWizardDraftAutosave}, refreshed by the caller every render. */
export interface UseWizardDraftAutosaveOptions {
  /** Current in-progress draft — persisted (debounced) whenever a field has been edited. */
  draft: WizardDraft;
  /** Current wizard step index — persisted alongside `draft`, or alone for a resumed draft's step-only navigation. */
  stepIndex: number;
  /** Suppresses the debounced autosave while `true` — the in-flight submit's own result decides whether the saved draft should be cleared or left alone. */
  submitting: boolean;
  /** Whether a draft is already known to exist on disk at mount — `true` when resuming a previously saved draft. */
  hasStoredDraftInitially: boolean;
}

/** Imperative handle returned by {@link useWizardDraftAutosave}. */
export interface UseWizardDraftAutosaveResult {
  /** Marks that the operator has made at least one genuine field edit, gating the full-draft autosave path (see `hasFieldEditRef`'s doc). Call this from every field-patch handler. */
  markFieldEdited: () => void;
  /** Immediately persists any pending change, bypassing the debounce — call before the `draft`/`stepIndex` it captures is discarded (dialog close, unmount). */
  flush: () => void;
  /** Clears the "has been edited" / "has been stored" bookkeeping back to a fresh-draft state — call when the wizard itself resets. */
  reset: () => void;
}

/**
 * Debounce-autosaves `draft` (~1s after the operator stops editing, via
 * `api.saveGameDraft`) so a crash/close mid-edit still leaves a near-current
 * draft on disk, and exposes an imperative `flush`/`reset`/`markFieldEdited`
 * handle for the events the debounce timer can't cover on its own (dialog
 * close, unmount, wizard reset).
 */
export function useWizardDraftAutosave({
  draft,
  stepIndex,
  submitting,
  hasStoredDraftInitially,
}: UseWizardDraftAutosaveOptions): UseWizardDraftAutosaveResult {
  // True once the operator has made at least one *field* edit — gates the
  // full `api.saveGameDraft` autosave so an untouched draft never writes
  // itself back out. This is distinct from `hasStoredDraftRef` below: a
  // *resumed* draft's in-memory copy came back from `api.getGameDraft()`
  // with `environment[].value` and `file_seeds[].content`/`content_base64`
  // already blanked out by `GameWizardDraftService.get()`'s redaction (see
  // that service's class doc) — autosaving it via the same full-draft path
  // the instant the operator merely navigates a step, before they've
  // touched a field, would permanently overwrite the real, unredacted
  // values still on disk with those blanks. Step-only navigation on a
  // resumed draft is instead persisted through `updateGameDraftStepIndex`,
  // which only ever touches `stepIndex` on the main-process side and never
  // re-sends `draft` at all.
  const hasFieldEditRef = useRef(false);

  // True once a draft is known to exist on disk for *this* wizard session —
  // seeded from `hasStoredDraftInitially` for a resumed draft, and flipped
  // on after the first successful full autosave. Gates the step-only
  // `updateGameDraftStepIndex` persistence: there's nothing to update the
  // `stepIndex` of if no draft has ever been saved yet.
  const hasStoredDraftRef = useRef(hasStoredDraftInitially);

  // Mirrors `submitting` synchronously (not via effect timing alone) so the
  // debounced-save subscriber below can re-check it at the moment a
  // debounced value actually *fires* — not just at the moment it was
  // pushed. A value can be pushed while `submitting` is still `false` and
  // sit in `debounceTime`'s buffer for up to ~1s; if the caller flips
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
   * bypasses both the debounce and the `submitting` check, for an
   * immediate, unconditional save on close/unmount (the caller's dialog may
   * permit closing even mid-submit, and the operator still needs their
   * draft preserved if that submit then fails). Both use `useState`'s lazy
   * initializer form so the `Subject` is constructed exactly once per mount
   * rather than every render — the setter is never called, this is
   * "create-once storage," not render state.
   */
  const [save$] = useState(() => new Subject<DraftSaveEvent>());
  const [flush$] = useState(() => new Subject<DraftSaveEvent>());

  /** Immediately persists any pending change, bypassing the debounce — call before the draft state it captures is discarded (dialog close, unmount). */
  function flush() {
    if (!hasFieldEditRef.current && !hasStoredDraftRef.current) return;
    flush$.next({ draft, stepIndex, hasFieldEdit: hasFieldEditRef.current });
  }

  // `flush` closes over this render's `draft`/`stepIndex`, so a *stable*
  // ref to "the latest one" is kept in sync after every render (an effect,
  // not a render-body assignment — refs must not be written during
  // render). The unmount-only effect below reads through this ref rather
  // than calling `flush` directly, so that when it actually fires
  // (component torn down entirely, e.g. the operator navigates away from
  // `/games` while the dialog is still open) it flushes the draft as of
  // that moment — not the stale one captured back when the hook first
  // mounted.
  const flushRef = useRef(flush);
  useEffect(() => {
    flushRef.current = flush;
  });

  // Declared *before* the subscribe effect below so its cleanup runs first
  // at unmount: the subscribe effect's own cleanup unconditionally
  // unsubscribes, which would otherwise make a flush pushed from this
  // effect's cleanup fire into a dead subscription and silently do nothing.
  // The caller already flushes synchronously on a normal dialog close
  // (Escape/overlay/Cancel/Submit), so this ordering only matters for the
  // component being unmounted directly.
  useEffect(() => {
    return () => flushRef.current();
  }, []);

  // Subscribes once for the hook's lifetime — `merge` combines the
  // debounced stream (gated on `submitting` at fire-time, via `filter`
  // placed *after* `debounceTime` so it re-checks the ref when the buffered
  // value actually emits) with the un-debounced, ungated flush stream into
  // one subscriber, which decides per-event whether to persist the full
  // draft or just the step index (see `hasFieldEditRef`'s doc above).
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

  return {
    markFieldEdited: () => {
      hasFieldEditRef.current = true;
    },
    flush,
    reset: () => {
      hasFieldEditRef.current = false;
      hasStoredDraftRef.current = false;
    },
  };
}
