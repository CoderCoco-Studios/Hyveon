/**
 * Phase machine and IPC orchestration for the first-run wizard's guided-IAM
 * step, extracted from `GuidedIamStep` (finding D7): the five chained
 * `window.hyveon.wizard.guidedIam*` calls, the StrictMode remount guard, the
 * resume-on-mount effect, and `persistProgress`. `GuidedIamStep` itself is
 * left owning only the phase→screen switch.
 */
import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { WizardProgress } from '@hyveon/desktop-preload';
import { BRIDGE_UNAVAILABLE } from '@/lib/bridge.utils';

/**
 * Screen this step renders. Unlike `stack-init-step.component.tsx`'s
 * `StackInitPhase` (three phases that only ever advance forward in one
 * pass), these do not progress in a fixed linear order: `verification-failed`
 * loops back to `rotating` on retry, and resume (see
 * {@link UseGuidedIamOptions.initialProgress}) can land directly on `template`
 * or `intake` instead of starting at `region`. There is no `'complete'`
 * phase — the `complete` rotation outcome calls {@link UseGuidedIamOptions.onComplete}
 * directly rather than rendering a terminal screen of its own, since the
 * caller is expected to unmount this step once that fires.
 */
export type GuidedIamPhase = 'region' | 'template' | 'intake' | 'rotating' | 'verification-failed' | 'delete-failed';

/** The bootstrap key pair, held only in this hook's memory once the intake form validates it — never persisted, never logged. */
interface BootstrapKeyMaterial {
  accessKeyId: string;
  secretAccessKey: string;
}

/** Options for {@link useGuidedIam} — mirrors `GuidedIamStepProps`. */
export interface UseGuidedIamOptions {
  /**
   * Guided provisioning has finished and the rotated key is now the active
   * AWS credential source — fires when `guidedIamRotate()` returns
   * `{ status: 'complete' }`, or when a `delete-failed` bootstrap key is
   * successfully revoked via `guidedIamRevokeBootstrapKey`.
   */
  onComplete: () => void;
  /** The shell's `getProgress()` result for this step, passed down only when `progress.step === 'guided-iam'`. */
  initialProgress?: WizardProgress['guidedIam'];
  /** Fires whenever this step has an AWS-mutating IPC call in flight. */
  onBusyChange?: (busy: boolean) => void;
}

/** Return value of {@link useGuidedIam}. */
export interface UseGuidedIamResult {
  /** True while this mount is still resolving a resumed screen — render a loading state and nothing else while true. */
  resuming: boolean;
  phase: GuidedIamPhase;
  /** True once a resume attempt found no recoverable region and fell back to the region screen. */
  resumedWithoutRegion: boolean;
  /** True when this mount resumed directly into `intake` with `subState: 'rotation-pending'`. */
  resumedRotationPending: boolean;
  region: string;
  setRegion: Dispatch<SetStateAction<string>>;
  regionError: string | null;
  manualRegionEntry: boolean;
  setManualRegionEntry: Dispatch<SetStateAction<boolean>>;
  templatePath: string | null;
  templateError: string | null;
  pathCopied: boolean;
  /** True exactly while the template render is owed and hasn't settled either way. */
  preparingTemplate: boolean;
  openingConsole: boolean;
  consoleError: string | null;
  consoleOpened: boolean;
  consoleUrl: string | null;
  accessKeyId: string;
  setAccessKeyId: Dispatch<SetStateAction<string>>;
  secretAccessKey: string;
  setSecretAccessKey: Dispatch<SetStateAction<string>>;
  submitting: boolean;
  intakeError: string | null;
  rotationError: string | null;
  deleteFailedConsoleUrl: string | null;
  revoking: boolean;
  revokeError: string | null;
  /** Validates the region input and moves from `region` to `template`. */
  onChooseGuided: () => void;
  /** Opens the region-scoped CloudFormation console URL in the operator's browser. */
  onOpenConsole: () => void;
  /** Moves from `template` to `intake`. */
  onContinueToIntake: () => void;
  /** Validates the region + pasted bootstrap key pair, then kicks off rotation. */
  onSubmitKey: () => void;
  /** Retries rotation from `verification-failed` using the same in-memory bootstrap key and region. */
  onRetryRotation: () => void;
  /** Manual-retry action for `delete-failed`: revokes the still-live bootstrap key. */
  onRevoke: () => void;
  /** Copies `templatePath` to the clipboard. */
  onCopyPath: () => void;
  /** Clears `templateError`, re-triggering the template-render effect. */
  onRetryTemplate: () => void;
}

/**
 * Owns the guided-IAM step's phase machine: rendering `iam-bootstrap.yaml`,
 * intaking the resulting bootstrap access key, and driving the mandatory
 * mint-then-revoke rotation — five chained `window.hyveon.wizard.guidedIam*`
 * IPC calls in total. See `GuidedIamStep`'s own doc comment for the full
 * screen flow this drives.
 */
export function useGuidedIam({ onComplete, initialProgress, onBusyChange }: UseGuidedIamOptions): UseGuidedIamResult {
  /**
   * Whether this mount needs to resolve a resumed screen before rendering
   * anything interactive — true only when `initialProgress.subState` names a
   * screen past the region input. Captured once via `useState`'s lazy
   * initializer; `initialProgress` is a one-shot prop from the shell's own
   * `getProgress()` call, mirrored by every other resuming wizard step, so
   * this deliberately does not react to later prop changes.
   */
  const [resuming, setResuming] = useState(
    () =>
      initialProgress?.subState === 'template-written' ||
      initialProgress?.subState === 'awaiting-key-intake' ||
      initialProgress?.subState === 'rotation-pending',
  );
  const [phase, setPhase] = useState<GuidedIamPhase>('region');
  /** True once a resume attempt found no recoverable region and fell back to the region screen — renders an explanatory note instead of a bare blank form. */
  const [resumedWithoutRegion, setResumedWithoutRegion] = useState(false);
  /** True when this mount resumed directly into `intake` with `subState: 'rotation-pending'` — renders the "a bootstrap key was previously submitted" banner. */
  const [resumedRotationPending, setResumedRotationPending] = useState(false);

  const [region, setRegion] = useState('');
  const [regionError, setRegionError] = useState<string | null>(null);
  const [manualRegionEntry, setManualRegionEntry] = useState(false);

  const [templatePath, setTemplatePath] = useState<string | null>(null);
  const [templateError, setTemplateError] = useState<string | null>(null);
  const [pathCopied, setPathCopied] = useState(false);
  /**
   * Derived, not stored: true exactly while the template render is owed and
   * hasn't settled either way. Deriving this (rather than a separate
   * `useState`) is what lets the render-effect below avoid a synchronous
   * `setState` call at its own entry — see that effect's doc comment.
   */
  const preparingTemplate = phase === 'template' && templatePath === null && templateError === null;

  const [openingConsole, setOpeningConsole] = useState(false);
  const [consoleError, setConsoleError] = useState<string | null>(null);
  const [consoleOpened, setConsoleOpened] = useState(false);
  const [consoleUrl, setConsoleUrl] = useState<string | null>(null);

  const [accessKeyId, setAccessKeyId] = useState('');
  const [secretAccessKey, setSecretAccessKey] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [intakeError, setIntakeError] = useState<string | null>(null);

  /** The validated bootstrap key pair, kept only in memory — see {@link BootstrapKeyMaterial}'s own doc comment. */
  const [bootstrapKey, setBootstrapKey] = useState<BootstrapKeyMaterial | null>(null);

  const [rotationError, setRotationError] = useState<string | null>(null);
  const [deleteFailedConsoleUrl, setDeleteFailedConsoleUrl] = useState<string | null>(null);
  const [revoking, setRevoking] = useState(false);
  const [revokeError, setRevokeError] = useState<string | null>(null);

  /**
   * Guards every post-await `setState` call against firing after unmount,
   * since this hook chains several IPC round trips. Re-armed to `true` at
   * the start of the mount effect's setup body (not just the initial
   * `useRef(true)`) so React StrictMode's simulated mount→unmount→remount
   * (`main.tsx` wraps the app in `<StrictMode>`) doesn't leave this
   * permanently `false` after the first, discarded mount's cleanup flips it
   * — every guard below would otherwise silently bail forever.
   */
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  /** Reports {@link UseGuidedIamOptions.onBusyChange} whenever an AWS-mutating IPC call is in flight. */
  const busy = submitting || phase === 'rotating' || revoking;
  useEffect(() => {
    onBusyChange?.(busy);
  }, [busy, onBusyChange]);
  useEffect(() => {
    return () => onBusyChange?.(false);
  }, [onBusyChange]);

  /**
   * Persists this step's sub-state via `wizard.saveProgress`, per the plan's
   * exact call-site list — swallows failures, since a failed resume-hint
   * write must never block the live, in-memory flow the operator is
   * actually driving.
   */
  const persistProgress = useCallback(async (guidedIam: NonNullable<WizardProgress['guidedIam']>) => {
    if (!window.hyveon) return;
    try {
      await window.hyveon.wizard.saveProgress({ step: 'guided-iam', guidedIam });
    } catch {
      // Best-effort — see this function's own doc comment.
    }
  }, []);

  // Resolve a resumed screen on mount. Region is never persisted in
  // `WizardProgress.guidedIam` (only `subState`/`hasBootstrapKey` are), so
  // this falls back to `wizard.state.get()`'s `aws.region` — but
  // `GuidedIamService.rotate()` only ever writes `aws.region` at its step 4,
  // AFTER verification succeeds. For a `rotation-pending` resume — the
  // "operator quit between intake and rotation settling" scenario this
  // sub-state exists to make resumable — `aws.region` is almost always still
  // unset (rotation hadn't reached step 4 yet, or failed verification before
  // it). A `rotation-pending` resume MUST still land on the intake screen
  // regardless: falling back to the region/choice screen would regress the
  // persisted sub-state back to `not-started` on the next "Continue with
  // guided setup" click, defeating the entire point of this persistence —
  // see the intake screen's own region field for how a genuinely
  // unrecoverable region is handled without leaving this phase.
  // `template-written`/`awaiting-key-intake` resumes have no such
  // constraint (no bootstrap key is in flight yet), so those alone fall back
  // to the region screen when no region is recoverable.
  useEffect(() => {
    if (!resuming) return;
    let cancelled = false;
    void (async () => {
      let resumedRegion: string | undefined;
      try {
        if (window.hyveon) {
          const state = await window.hyveon.wizard.getState();
          resumedRegion = state.aws?.region;
        }
      } catch {
        // Falls through below with `resumedRegion` left `undefined`.
      }
      if (cancelled || !mountedRef.current) return;

      if (resumedRegion) setRegion(resumedRegion);

      if (initialProgress?.subState === 'rotation-pending') {
        // Always lands on `intake`, with or without a recovered region — see
        // this effect's own doc comment.
        setResumedRotationPending(true);
        setPhase('intake');
        setResuming(false);
        return;
      }

      if (!resumedRegion) {
        setResumedWithoutRegion(true);
        setResuming(false);
        return;
      }

      setPhase('template');
      setResuming(false);
    })();
    return () => {
      cancelled = true;
    };
    // Runs once on mount only — see `resuming`'s own doc comment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Renders `iam-bootstrap.yaml` and persists `template-written` on success —
  // fires automatically on entering the template phase (fresh choice or
  // resume) and again any time `templateError` is cleared (the Retry
  // button's `onClick`), since both drive `preparingTemplate` back to `true`.
  // Deliberately has no synchronous `setState` call in the effect body
  // itself (`react-hooks/set-state-in-effect`) — `preparingTemplate` is
  // derived at render instead of set here, and every `setTemplatePath`/
  // `setTemplateError` call below only ever runs inside a `.then()`/`.catch()`
  // continuation, never synchronously within this effect's own call frame.
  useEffect(() => {
    if (!preparingTemplate) return;
    let cancelled = false;
    const request = window.hyveon
      ? window.hyveon.wizard.guidedIamPrepareTemplate()
      : Promise.reject(new Error(BRIDGE_UNAVAILABLE));
    request
      .then(async (result) => {
        if (cancelled || !mountedRef.current) return;
        setTemplatePath(result.path);
        await persistProgress({ subState: 'template-written', hasBootstrapKey: false });
      })
      .catch((err: unknown) => {
        if (cancelled || !mountedRef.current) return;
        setTemplateError(err instanceof Error ? err.message : 'Failed to render the CloudFormation template.');
      });
    return () => {
      cancelled = true;
    };
  }, [preparingTemplate, persistProgress]);

  /** Validates the region input and moves from `region` to `template`, persisting `not-started` first per the plan's call-site list. */
  async function onChooseGuided() {
    const trimmed = region.trim();
    if (!trimmed) {
      setRegionError('Enter an AWS region to continue.');
      return;
    }
    setRegionError(null);
    setRegion(trimmed);
    await persistProgress({ subState: 'not-started', hasBootstrapKey: false });
    if (!mountedRef.current) return;
    setPhase('template');
  }

  /** Opens the region-scoped CloudFormation console URL in the operator's browser, falling back to displaying the URL as selectable text. */
  async function onOpenConsole() {
    if (!window.hyveon) {
      setConsoleError(BRIDGE_UNAVAILABLE);
      return;
    }
    setOpeningConsole(true);
    setConsoleError(null);
    try {
      const result = await window.hyveon.wizard.guidedIamOpenConsole({ region });
      if (!mountedRef.current) return;
      setConsoleOpened(result.opened);
      setConsoleUrl(result.opened ? null : result.url);
    } catch (err) {
      if (!mountedRef.current) return;
      setConsoleError(err instanceof Error ? err.message : 'Failed to open the AWS console.');
    } finally {
      if (mountedRef.current) setOpeningConsole(false);
    }
  }

  /** Moves from `template` to `intake`, persisting `awaiting-key-intake` — the plan treats "console opened" and "key-intake form reached" as the same UI moment, so this single transition covers both. */
  async function onContinueToIntake() {
    await persistProgress({ subState: 'awaiting-key-intake', hasBootstrapKey: false });
    if (!mountedRef.current) return;
    setPhase('intake');
  }

  /**
   * Drives one `guidedIamRotate()` attempt against `key`/`rotationRegion` and
   * applies its outcome — called both right after a successful intake and
   * from the verification-failed retry action, always with the same
   * in-memory key. Takes the region as an explicit parameter rather than
   * reading the `region` state closure directly: `onSubmitKey` may have
   * just called `setRegion(...)` moments earlier (e.g. filling in a region
   * recovered nowhere else, on a `rotation-pending` resume with no
   * `aws.region` to fall back to), and that state update is not guaranteed
   * to have committed yet by the time this runs — passing the already-known
   * value in avoids a stale-closure race.
   */
  const runRotation = useCallback(
    async (key: BootstrapKeyMaterial, rotationRegion: string) => {
      if (!window.hyveon) {
        setRotationError(BRIDGE_UNAVAILABLE);
        setPhase('verification-failed');
        return;
      }
      try {
        const result = await window.hyveon.wizard.guidedIamRotate({
          bootstrapAccessKeyId: key.accessKeyId,
          bootstrapSecretAccessKey: key.secretAccessKey,
          region: rotationRegion,
        });
        if (!mountedRef.current) return;
        if (result.status === 'complete') {
          await persistProgress({ subState: 'complete', hasBootstrapKey: false });
          if (!mountedRef.current) return;
          onComplete();
          return;
        }
        if (result.status === 'verification-failed') {
          // Sub-state deliberately stays at `rotation-pending` (already
          // persisted by the intake handler) — this is not a fresh
          // transition per the plan's persistence call-site list.
          setRotationError(result.error);
          setPhase('verification-failed');
          return;
        }
        setDeleteFailedConsoleUrl(result.consoleUrl);
        setPhase('delete-failed');
      } catch (err) {
        if (!mountedRef.current) return;
        setRotationError(err instanceof Error ? err.message : 'Failed to rotate the bootstrap key.');
        setPhase('verification-failed');
      }
    },
    [persistProgress, onComplete],
  );

  /** Validates the region + pasted bootstrap key pair, then immediately kicks off rotation with them. */
  async function onSubmitKey() {
    if (!window.hyveon) {
      setIntakeError(BRIDGE_UNAVAILABLE);
      return;
    }
    const trimmedRegion = region.trim();
    const trimmedAccessKeyId = accessKeyId.trim();
    const trimmedSecret = secretAccessKey.trim();
    if (!trimmedRegion || !trimmedAccessKeyId || !trimmedSecret) {
      setIntakeError('Enter the AWS region, access key ID, and secret access key.');
      return;
    }
    setRegion(trimmedRegion);
    setSubmitting(true);
    setIntakeError(null);
    try {
      await window.hyveon.wizard.guidedIamSubmitBootstrapKey({
        accessKeyId: trimmedAccessKeyId,
        secretAccessKey: trimmedSecret,
        region: trimmedRegion,
      });
      if (!mountedRef.current) return;
      const key: BootstrapKeyMaterial = { accessKeyId: trimmedAccessKeyId, secretAccessKey: trimmedSecret };
      setBootstrapKey(key);
      // Clear the form's secret field now that it has been captured into
      // `bootstrapKey` — it is never re-displayed.
      setSecretAccessKey('');
      await persistProgress({ subState: 'rotation-pending', hasBootstrapKey: true });
      if (!mountedRef.current) return;
      setPhase('rotating');
      await runRotation(key, trimmedRegion);
    } catch (err) {
      if (!mountedRef.current) return;
      setIntakeError(err instanceof Error ? err.message : 'Failed to validate the bootstrap key.');
    } finally {
      if (mountedRef.current) setSubmitting(false);
    }
  }

  /** Retries rotation from `verification-failed` using the same in-memory bootstrap key and region — no re-intake needed. */
  function onRetryRotation() {
    if (!bootstrapKey) return;
    setRotationError(null);
    setPhase('rotating');
    void runRotation(bootstrapKey, region);
  }

  /** Manual-retry action for `delete-failed`: revokes the still-live bootstrap key without re-running mint/verify. On success this is treated as fully complete, since rotation already activated the new key. */
  async function onRevoke() {
    if (!bootstrapKey || !window.hyveon) return;
    setRevoking(true);
    setRevokeError(null);
    try {
      const result = await window.hyveon.wizard.guidedIamRevokeBootstrapKey({
        bootstrapAccessKeyId: bootstrapKey.accessKeyId,
        region,
      });
      if (!mountedRef.current) return;
      if (result.revoked) {
        await persistProgress({ subState: 'complete', hasBootstrapKey: false });
        if (!mountedRef.current) return;
        onComplete();
        return;
      }
      setRevokeError(result.message ?? 'Failed to revoke the bootstrap key.');
    } catch (err) {
      if (!mountedRef.current) return;
      setRevokeError(err instanceof Error ? err.message : 'Failed to revoke the bootstrap key.');
    } finally {
      if (mountedRef.current) setRevoking(false);
    }
  }

  /**
   * Copies `templatePath` to the clipboard; a denied/unavailable clipboard is non-critical since the path is already visible on screen.
   *
   * @remarks
   * Disclosed scope reduction: the `template` screen this backs ships a
   * copy-path action ONLY — it does not also offer a reveal-in-file-manager
   * action, even though `guided-iam-provisioning`'s spec
   * (`openspec/changes/add-one-click-aws-bootstrap/specs/guided-iam-provisioning/spec.md`)
   * calls for both. No `shell.showItemInFolder`-equivalent IPC channel
   * exists anywhere in this codebase's `desktop-main`↔renderer surface, and
   * building that channel end-to-end was judged out of scope for this
   * UI-wiring group (`add-one-click-aws-bootstrap` Group 7) — this is a
   * deliberate, disclosed reduction, not an oversight. The operator can
   * navigate to the printed `templatePath` manually in the meantime; a
   * follow-up change can add the IPC channel and wire a "Reveal in
   * Finder/Explorer" button here without touching this function.
   */
  function onCopyPath() {
    if (!templatePath || !navigator.clipboard) return;
    void navigator.clipboard
      .writeText(templatePath)
      .then(() => setPathCopied(true))
      .catch(() => {
        /* clipboard denial is non-critical; the path is still visible above */
      });
  }

  return {
    resuming,
    phase,
    resumedWithoutRegion,
    resumedRotationPending,
    region,
    setRegion,
    regionError,
    manualRegionEntry,
    setManualRegionEntry,
    templatePath,
    templateError,
    pathCopied,
    preparingTemplate,
    openingConsole,
    consoleError,
    consoleOpened,
    consoleUrl,
    accessKeyId,
    setAccessKeyId,
    secretAccessKey,
    setSecretAccessKey,
    submitting,
    intakeError,
    rotationError,
    deleteFailedConsoleUrl,
    revoking,
    revokeError,
    onChooseGuided: () => void onChooseGuided(),
    onOpenConsole: () => void onOpenConsole(),
    onContinueToIntake: () => void onContinueToIntake(),
    onSubmitKey: () => void onSubmitKey(),
    onRetryRotation,
    onRevoke: () => void onRevoke(),
    onCopyPath,
    onRetryTemplate: () => setTemplateError(null),
  };
}
