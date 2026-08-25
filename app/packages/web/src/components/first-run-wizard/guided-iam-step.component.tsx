import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import type { WizardProgress } from '@hyveon/desktop-preload';
import { AWS_REGIONS, type AwsRegionInfo } from '@hyveon/shared';
import { GuidedIamRegionScreen } from '@/components/first-run-wizard/guided-iam-region-screen.component';
import { GuidedIamTemplateScreen } from '@/components/first-run-wizard/guided-iam-template-screen.component';
import { GuidedIamIntakeScreen } from '@/components/first-run-wizard/guided-iam-intake-screen.component';
import { GuidedIamVerificationFailedScreen } from '@/components/first-run-wizard/guided-iam-verification-failed-screen.component';
import { GuidedIamDeleteFailedScreen } from '@/components/first-run-wizard/guided-iam-delete-failed-screen.component';

/** Reported whenever an action in this step is attempted outside Electron, where there is no IPC bridge to drive the guided flow through. */
const BRIDGE_UNAVAILABLE = 'IPC bridge (window.hyveon) is not available in this context.';

/** {@link AWS_REGIONS} grouped by continent, preserving the generated file's continent-then-name sort order. Computed once at module load since the source data is static. */
const REGIONS_BY_CONTINENT: Array<[string, AwsRegionInfo[]]> = (() => {
  const groups = new Map<string, AwsRegionInfo[]>();
  for (const region of AWS_REGIONS) {
    const list = groups.get(region.continent) ?? [];
    list.push(region);
    groups.set(region.continent, list);
  }
  return [...groups.entries()];
})();

/**
 * Internal screen this step renders. Unlike `stack-init-step.component.tsx`'s
 * `StackInitPhase` (three phases that only ever advance forward in one
 * pass), these do not progress in a fixed linear order: `verification-failed`
 * loops back to `rotating` on retry, and resume (see
 * {@link GuidedIamStepProps.initialProgress}) can land directly on `template`
 * or `intake` instead of starting at `region`. There is no `'complete'`
 * phase — the `complete` rotation outcome calls {@link GuidedIamStepProps.onComplete}
 * directly rather than rendering a terminal screen of its own, since the
 * shell is expected to unmount this component once that fires.
 */
type GuidedIamPhase = 'region' | 'template' | 'intake' | 'rotating' | 'verification-failed' | 'delete-failed';

/** The bootstrap key pair, held only in this component's memory once {@link GuidedIamStep}'s intake form validates it — never persisted, never logged. */
interface BootstrapKeyMaterial {
  accessKeyId: string;
  secretAccessKey: string;
}

/** Props for {@link GuidedIamStep}. */
export interface GuidedIamStepProps {
  /**
   * Guided provisioning has finished and the rotated key is now the active
   * AWS credential source — fires when `guidedIamRotate()` returns
   * `{ status: 'complete' }`, or when a `delete-failed` bootstrap key is
   * successfully revoked via {@link Window.hyveon}'s `guidedIamRevokeBootstrapKey`.
   * There is no bypass for an unresolved `delete-failed` state: the still-live
   * bootstrap key must be revoked (or the flow retried) before this fires.
   * Like `stack-init-step.component.tsx`'s `onFinished`, this step owns its
   * own state machine and does not rely on the wizard shell's shared Next
   * button to advance.
   */
  onComplete: () => void;
  /**
   * The operator chose "I already have credentials" from the initial
   * region/choice screen — advances straight to the credentials step
   * without provisioning anything. Fires immediately on the button click;
   * no sub-state is persisted for this path.
   */
  onSkipToManual: () => void;
  /**
   * The shell's `getProgress()` result for this step, passed down only when
   * `progress.step === 'guided-iam'`. Determines which screen this
   * component renders into on mount — see the module-level "Resume
   * semantics" notes in `docs/superpowers/plans/bootstrap-7-wizard-ui.md`.
   * Absent, or `subState` of `'not-started'`/`'complete'`, starts fresh from
   * the region screen.
   */
  initialProgress?: WizardProgress['guidedIam'];
  /**
   * Fires whenever this step has an AWS-mutating IPC call in flight
   * (key intake, mint/verify/activate rotation, or bootstrap-key revocation)
   * — lets the shell disable actions like "Start over" that would otherwise
   * race a reset against these calls, most critically `rotating`, which
   * irreversibly deletes the old bootstrap key from AWS regardless of what
   * the shell does locally in the meantime.
   */
  onBusyChange?: (busy: boolean) => void;
}

/**
 * Guided IAM bootstrap step of the first-run wizard
 * (`openspec/changes/add-one-click-aws-bootstrap`). Self-contained and
 * stateful, following `stack-init-step.component.tsx`'s ownership model
 * rather than every other step's purely-presentational one: it owns an
 * internal region input, renders the `iam-bootstrap.yaml` CloudFormation
 * template and hands the operator off to the AWS console, intakes the
 * resulting bootstrap access key, and drives the mandatory mint-then-revoke
 * rotation — five chained `window.hyveon.wizard.guidedIam*` IPC calls in
 * total, none of which the wizard shell needs to orchestrate step-by-step.
 *
 * Screen flow: `region` (region input + guided-vs-manual choice) →
 * `template` (renders the template, offers "Copy Path" and "Open AWS
 * Console", then a "Continue to key entry" action) → `intake` (access key
 * ID / secret access key form) → `rotating` (spinner while
 * `guidedIamRotate()` is in flight) → one of three outcomes: `onComplete()`
 * fires directly on `complete`, `verification-failed` renders its own error
 * + retry screen, `delete-failed` renders its own "revoke manually" screen.
 * The secret access key is held in local component state only long enough
 * to submit it and drive rotation/retry — it is never written to
 * `saveProgress`, which only ever receives the `hasBootstrapKey` boolean.
 */
export function GuidedIamStep({ onComplete, onSkipToManual, initialProgress, onBusyChange }: GuidedIamStepProps) {
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
   * since this component chains several IPC round trips. Re-armed to `true`
   * at the start of the mount effect's setup body (not just the initial
   * `useRef(true)`) so React StrictMode's simulated
   * mount→unmount→remount (`main.tsx` wraps the app in `<StrictMode>`) doesn't
   * leave this permanently `false` after the first, discarded mount's cleanup
   * flips it — every guard below would otherwise silently bail forever.
   */
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  /** Reports {@link GuidedIamStepProps.onBusyChange} whenever an AWS-mutating IPC call is in flight — see that prop's own doc comment. */
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
  async function handleChooseGuided() {
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
  async function handleOpenConsole() {
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
  async function handleContinueToIntake() {
    await persistProgress({ subState: 'awaiting-key-intake', hasBootstrapKey: false });
    if (!mountedRef.current) return;
    setPhase('intake');
  }

  /**
   * Drives one `guidedIamRotate()` attempt against `key`/`rotationRegion` and
   * applies its outcome — called both right after a successful intake and
   * from the verification-failed retry action, always with the same
   * in-memory key. Takes the region as an explicit parameter rather than
   * reading the `region` state closure directly: `handleSubmitKey` may have
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
  async function handleSubmitKey() {
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
  function handleRetryRotation() {
    if (!bootstrapKey) return;
    setRotationError(null);
    setPhase('rotating');
    void runRotation(bootstrapKey, region);
  }

  /** Manual-retry action for `delete-failed`: revokes the still-live bootstrap key without re-running mint/verify. On success this is treated as fully complete, since rotation already activated the new key. */
  async function handleRevoke() {
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
  function handleCopyPath() {
    if (!templatePath || !navigator.clipboard) return;
    void navigator.clipboard
      .writeText(templatePath)
      .then(() => setPathCopied(true))
      .catch(() => {
        /* clipboard denial is non-critical; the path is still visible above */
      });
  }

  if (resuming) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" aria-hidden="true" />
        Resuming guided setup…
      </div>
    );
  }

  // A single switch returning exactly one screen component keeps the
  // mutual-exclusion invariant `guided-iam-wizard.spec.ts` relies on: only
  // one phase's markup can ever be in the DOM at a time.
  switch (phase) {
    case 'region':
      return (
        <GuidedIamRegionScreen
          resumedWithoutRegion={resumedWithoutRegion}
          regionsByContinent={REGIONS_BY_CONTINENT}
          region={region}
          setRegion={setRegion}
          regionError={regionError}
          manualRegionEntry={manualRegionEntry}
          setManualRegionEntry={setManualRegionEntry}
          onContinueGuided={() => void handleChooseGuided()}
          onSkipToManual={onSkipToManual}
        />
      );
    case 'template':
      return (
        <GuidedIamTemplateScreen
          preparingTemplate={preparingTemplate}
          templateError={templateError}
          onRetryTemplate={() => setTemplateError(null)}
          templatePath={templatePath}
          onCopyPath={handleCopyPath}
          pathCopied={pathCopied}
          openingConsole={openingConsole}
          onOpenConsole={() => void handleOpenConsole()}
          consoleError={consoleError}
          consoleOpened={consoleOpened}
          consoleUrl={consoleUrl}
          onContinueToIntake={() => void handleContinueToIntake()}
        />
      );
    case 'intake':
    case 'rotating':
      return (
        <GuidedIamIntakeScreen
          isRotating={phase === 'rotating'}
          resumedRotationPending={resumedRotationPending}
          region={region}
          setRegion={setRegion}
          accessKeyId={accessKeyId}
          setAccessKeyId={setAccessKeyId}
          secretAccessKey={secretAccessKey}
          setSecretAccessKey={setSecretAccessKey}
          intakeError={intakeError}
          submitting={submitting}
          onSubmit={() => void handleSubmitKey()}
        />
      );
    case 'verification-failed':
      return <GuidedIamVerificationFailedScreen rotationError={rotationError} onRetryRotation={handleRetryRotation} />;
    case 'delete-failed':
      return (
        <GuidedIamDeleteFailedScreen
          deleteFailedConsoleUrl={deleteFailedConsoleUrl}
          revokeError={revokeError}
          revoking={revoking}
          onRevoke={() => void handleRevoke()}
        />
      );
  }
}
