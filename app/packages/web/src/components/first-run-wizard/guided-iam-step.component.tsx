import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Copy, ExternalLink, Loader2, RotateCcw } from 'lucide-react';
import type { WizardProgress } from '@hyveon/desktop-preload';
import { Button } from '@/components/ui/button.component';
import { Input } from '@/components/ui/input.component';
import { Label } from '@/components/ui/label.component';

/** Reported whenever an action in this step is attempted outside Electron, where there is no IPC bridge to drive the guided flow through. */
const BRIDGE_UNAVAILABLE = 'IPC bridge (window.hyveon) is not available in this context.';

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
   * `{ status: 'complete' }`, when a `delete-failed` bootstrap key is
   * successfully revoked via {@link Window.hyveon}'s `guidedIamRevokeBootstrapKey`,
   * or when the operator explicitly chooses to continue past an
   * unresolved `delete-failed` state (the rotated key is already active
   * either way — only the stale bootstrap key differs). Like
   * `stack-init-step.component.tsx`'s `onFinished`, this step owns its own
   * state machine and does not rely on the wizard shell's shared Next
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
export function GuidedIamStep({ onComplete, onSkipToManual, initialProgress }: GuidedIamStepProps) {
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

  /** Guards every post-await `setState` call against firing after unmount, since this component chains several IPC round trips. */
  const mountedRef = useRef(true);
  useEffect(
    () => () => {
      mountedRef.current = false;
    },
    [],
  );

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
  // this falls back to `wizard.state.get()`'s `aws.region` — set by
  // `GuidedIamService.rotate()` on `awaiting-key-intake`/`rotation-pending`
  // sub-states reached after a prior rotate attempt activated it, or simply
  // absent for a fresh `template-written` resume that never got that far.
  // If no region is recoverable either way, this degrades to the plain
  // region screen rather than guessing.
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
        // Falls through to the "no region recoverable" branch below.
      }
      if (cancelled || !mountedRef.current) return;

      if (!resumedRegion) {
        setResumedWithoutRegion(true);
        setResuming(false);
        return;
      }

      setRegion(resumedRegion);
      if (initialProgress?.subState === 'rotation-pending') {
        setResumedRotationPending(true);
        setPhase('intake');
      } else {
        setPhase('template');
      }
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
   * Drives one `guidedIamRotate()` attempt against `key` and applies its
   * outcome — called both right after a successful intake and from the
   * verification-failed retry action, always with the same in-memory key.
   */
  const runRotation = useCallback(
    async (key: BootstrapKeyMaterial) => {
      if (!window.hyveon) {
        setRotationError(BRIDGE_UNAVAILABLE);
        setPhase('verification-failed');
        return;
      }
      try {
        const result = await window.hyveon.wizard.guidedIamRotate({
          bootstrapAccessKeyId: key.accessKeyId,
          bootstrapSecretAccessKey: key.secretAccessKey,
          region,
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
    [region, persistProgress, onComplete],
  );

  /** Validates the pasted bootstrap key pair, then immediately kicks off rotation with it. */
  async function handleSubmitKey() {
    if (!window.hyveon) {
      setIntakeError(BRIDGE_UNAVAILABLE);
      return;
    }
    const trimmedAccessKeyId = accessKeyId.trim();
    const trimmedSecret = secretAccessKey.trim();
    if (!trimmedAccessKeyId || !trimmedSecret) {
      setIntakeError('Enter both the access key ID and secret access key.');
      return;
    }
    setSubmitting(true);
    setIntakeError(null);
    try {
      await window.hyveon.wizard.guidedIamSubmitBootstrapKey({
        accessKeyId: trimmedAccessKeyId,
        secretAccessKey: trimmedSecret,
        region,
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
      await runRotation(key);
    } catch (err) {
      if (!mountedRef.current) return;
      setIntakeError(err instanceof Error ? err.message : 'Failed to validate the bootstrap key.');
    } finally {
      if (mountedRef.current) setSubmitting(false);
    }
  }

  /** Retries rotation from `verification-failed` using the same in-memory bootstrap key — no re-intake needed. */
  function handleRetryRotation() {
    if (!bootstrapKey) return;
    setRotationError(null);
    setPhase('rotating');
    void runRotation(bootstrapKey);
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

  /** Copies `templatePath` to the clipboard; a denied/unavailable clipboard is non-critical since the path is already visible on screen. */
  function handleCopyPath() {
    if (!templatePath) return;
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

  if (phase === 'region') {
    return (
      <div className="space-y-6">
        <p className="text-sm text-muted-foreground">
          Hyveon can provision the AWS access it needs for you, or you can supply your own credentials.
        </p>

        {resumedWithoutRegion && (
          <p className="text-sm text-muted-foreground">
            Resuming a previous session — re-enter your AWS region to continue.
          </p>
        )}

        <div className="space-y-2">
          <Label htmlFor="wizard-guided-iam-region">AWS region</Label>
          <Input
            id="wizard-guided-iam-region"
            value={region}
            placeholder="us-east-1"
            onChange={(e) => setRegion(e.target.value)}
          />
          {regionError && (
            <p role="alert" className="text-sm text-[var(--color-red)]">
              {regionError}
            </p>
          )}
        </div>

        <div className="flex gap-2">
          <Button type="button" onClick={() => void handleChooseGuided()}>
            Continue with guided setup
          </Button>
          <Button type="button" variant="outline" onClick={onSkipToManual}>
            I already have credentials
          </Button>
        </div>
      </div>
    );
  }

  if (phase === 'template') {
    return (
      <div className="space-y-6">
        <p className="text-sm text-muted-foreground">
          Upload the rendered CloudFormation template in the AWS console to create a bootstrap IAM user, then come
          back here with the access key it outputs.
        </p>

        {preparingTemplate && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            Rendering the CloudFormation template…
          </div>
        )}

        {templateError && (
          <div className="space-y-2">
            <p role="alert" className="text-sm text-[var(--color-red)]">
              {templateError}
            </p>
            <Button type="button" variant="outline" onClick={() => setTemplateError(null)}>
              <RotateCcw className="size-4" />
              Retry
            </Button>
          </div>
        )}

        {templatePath && (
          <div className="space-y-2">
            <Label htmlFor="wizard-guided-iam-template-path">Template path</Label>
            <div className="flex items-center gap-2">
              <Input id="wizard-guided-iam-template-path" value={templatePath} readOnly />
              <Button type="button" variant="outline" size="sm" onClick={handleCopyPath} aria-label="Copy template path">
                <Copy className="size-3" />
              </Button>
            </div>
            {pathCopied && (
              <p className="flex items-center gap-1 text-sm text-[var(--color-green)]">
                <CheckCircle2 className="size-4" />
                Path copied.
              </p>
            )}
          </div>
        )}

        {templatePath && (
          <div className="space-y-2 border-t border-[var(--color-border)] pt-4">
            <Button type="button" variant="outline" onClick={() => void handleOpenConsole()} disabled={openingConsole}>
              {openingConsole && <Loader2 className="animate-spin" />}
              <ExternalLink className="size-4" />
              Open AWS Console
            </Button>

            {consoleError && (
              <p role="alert" className="text-sm text-[var(--color-red)]">
                {consoleError}
              </p>
            )}

            {consoleOpened && (
              <p className="flex items-center gap-1 text-sm text-[var(--color-green)]">
                <CheckCircle2 className="size-4" />
                Opened in your default browser.
              </p>
            )}

            {consoleUrl && (
              <div className="space-y-1">
                <p className="text-sm text-muted-foreground">
                  Could not open a browser automatically — open this URL manually:
                </p>
                <Input value={consoleUrl} readOnly onFocus={(e) => e.currentTarget.select()} />
              </div>
            )}
          </div>
        )}

        {templatePath && (
          <Button type="button" onClick={() => void handleContinueToIntake()}>
            Continue to key entry
          </Button>
        )}
      </div>
    );
  }

  if (phase === 'intake' || phase === 'rotating') {
    return (
      <div className="space-y-6">
        {resumedRotationPending && (
          <p className="text-sm text-muted-foreground">
            A bootstrap key was previously submitted, but rotation didn&apos;t finish before Hyveon closed. Re-enter
            the access key ID and secret access key from your CloudFormation stack&apos;s outputs to retry.
          </p>
        )}

        <p className="text-sm text-muted-foreground">
          Paste the bootstrap access key pair from your CloudFormation stack&apos;s outputs.
        </p>

        <div className="space-y-2">
          <Label htmlFor="wizard-guided-iam-access-key-id">Access key ID</Label>
          <Input
            id="wizard-guided-iam-access-key-id"
            value={accessKeyId}
            onChange={(e) => setAccessKeyId(e.target.value)}
            disabled={phase === 'rotating'}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="wizard-guided-iam-secret-access-key">Secret access key</Label>
          <Input
            id="wizard-guided-iam-secret-access-key"
            type="password"
            value={secretAccessKey}
            onChange={(e) => setSecretAccessKey(e.target.value)}
            disabled={phase === 'rotating'}
          />
        </div>

        {intakeError && (
          <p role="alert" className="text-sm text-[var(--color-red)]">
            {intakeError}
          </p>
        )}

        {phase === 'rotating' ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            Rotating your AWS credentials…
          </div>
        ) : (
          <Button type="button" onClick={() => void handleSubmitKey()} disabled={submitting}>
            {submitting && <Loader2 className="animate-spin" />}
            Validate and rotate key
          </Button>
        )}
      </div>
    );
  }

  if (phase === 'verification-failed') {
    return (
      <div className="space-y-4">
        <p role="alert" className="text-sm text-[var(--color-red)]">
          {rotationError ?? 'Key rotation failed verification.'}
        </p>
        <p className="text-sm text-muted-foreground">
          The newly minted key could not be verified. This can happen if AWS hasn&apos;t finished propagating the key
          yet — retrying with the same bootstrap key is safe.
        </p>
        <Button type="button" variant="outline" onClick={handleRetryRotation}>
          <RotateCcw className="size-4" />
          Retry rotation
        </Button>
      </div>
    );
  }

  // phase === 'delete-failed'
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-sm text-[var(--color-amber)]">
        <AlertTriangle className="size-4" />
        The new key is active, but the bootstrap key is still active too — revoke it manually.
      </div>

      {deleteFailedConsoleUrl && (
        <div className="space-y-1">
          <p className="text-sm text-muted-foreground">Revoke it from the IAM console:</p>
          <a
            href={deleteFailedConsoleUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="block text-sm text-[var(--color-primary-light)] underline break-all"
          >
            {deleteFailedConsoleUrl}
          </a>
        </div>
      )}

      {revokeError && (
        <p role="alert" className="text-sm text-[var(--color-red)]">
          {revokeError}
        </p>
      )}

      <div className="flex gap-2">
        <Button type="button" variant="outline" onClick={() => void handleRevoke()} disabled={revoking}>
          {revoking && <Loader2 className="animate-spin" />}
          Revoke now
        </Button>
        <Button type="button" variant="ghost" onClick={onComplete}>
          Continue without revoking
        </Button>
      </div>
    </div>
  );
}
