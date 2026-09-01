import { Loader2 } from 'lucide-react';
import type { WizardProgress } from '@hyveon/desktop-preload';
import { AWS_REGIONS, type AwsRegionInfo } from '@hyveon/shared';
import { GuidedIamRegionScreen } from '@/components/first-run-wizard/guided-iam-region-screen.component';
import { GuidedIamTemplateScreen } from '@/components/first-run-wizard/guided-iam-template-screen.component';
import { GuidedIamIntakeScreen } from '@/components/first-run-wizard/guided-iam-intake-screen.component';
import { GuidedIamVerificationFailedScreen } from '@/components/first-run-wizard/guided-iam-verification-failed-screen.component';
import { GuidedIamDeleteFailedScreen } from '@/components/first-run-wizard/guided-iam-delete-failed-screen.component';
import { useGuidedIam } from './use-guided-iam.hook.js';

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
 * rather than every other step's purely-presentational one — the phase
 * machine and IPC orchestration live in {@link useGuidedIam}; this component
 * is left owning only the phase→screen switch.
 *
 * Screen flow: `region` (region input + guided-vs-manual choice) →
 * `template` (renders the template, offers "Copy Path" and "Open AWS
 * Console", then a "Continue to key entry" action) → `intake` (access key
 * ID / secret access key form) → `rotating` (spinner while
 * `guidedIamRotate()` is in flight) → one of three outcomes: `onComplete()`
 * fires directly on `complete`, `verification-failed` renders its own error
 * + retry screen, `delete-failed` renders its own "revoke manually" screen.
 * The secret access key is held in local state only long enough to submit it
 * and drive rotation/retry — it is never written to `saveProgress`, which
 * only ever receives the `hasBootstrapKey` boolean.
 */
export function GuidedIamStep({ onComplete, onSkipToManual, initialProgress, onBusyChange }: GuidedIamStepProps) {
  const guidedIam = useGuidedIam({ onComplete, initialProgress, onBusyChange });

  if (guidedIam.resuming) {
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
  switch (guidedIam.phase) {
    case 'region':
      return (
        <GuidedIamRegionScreen
          resumedWithoutRegion={guidedIam.resumedWithoutRegion}
          regionsByContinent={REGIONS_BY_CONTINENT}
          region={guidedIam.region}
          setRegion={guidedIam.setRegion}
          regionError={guidedIam.regionError}
          manualRegionEntry={guidedIam.manualRegionEntry}
          setManualRegionEntry={guidedIam.setManualRegionEntry}
          onContinueGuided={guidedIam.onChooseGuided}
          onSkipToManual={onSkipToManual}
        />
      );
    case 'template':
      return (
        <GuidedIamTemplateScreen
          preparingTemplate={guidedIam.preparingTemplate}
          templateError={guidedIam.templateError}
          onRetryTemplate={guidedIam.onRetryTemplate}
          templatePath={guidedIam.templatePath}
          onCopyPath={guidedIam.onCopyPath}
          pathCopied={guidedIam.pathCopied}
          openingConsole={guidedIam.openingConsole}
          onOpenConsole={guidedIam.onOpenConsole}
          consoleError={guidedIam.consoleError}
          consoleOpened={guidedIam.consoleOpened}
          consoleUrl={guidedIam.consoleUrl}
          onContinueToIntake={guidedIam.onContinueToIntake}
        />
      );
    case 'intake':
    case 'rotating':
      return (
        <GuidedIamIntakeScreen
          isRotating={guidedIam.phase === 'rotating'}
          resumedRotationPending={guidedIam.resumedRotationPending}
          region={guidedIam.region}
          setRegion={guidedIam.setRegion}
          accessKeyId={guidedIam.accessKeyId}
          setAccessKeyId={guidedIam.setAccessKeyId}
          secretAccessKey={guidedIam.secretAccessKey}
          setSecretAccessKey={guidedIam.setSecretAccessKey}
          intakeError={guidedIam.intakeError}
          submitting={guidedIam.submitting}
          onSubmit={guidedIam.onSubmitKey}
        />
      );
    case 'verification-failed':
      return (
        <GuidedIamVerificationFailedScreen
          rotationError={guidedIam.rotationError}
          onRetryRotation={guidedIam.onRetryRotation}
        />
      );
    case 'delete-failed':
      return (
        <GuidedIamDeleteFailedScreen
          deleteFailedConsoleUrl={guidedIam.deleteFailedConsoleUrl}
          revokeError={guidedIam.revokeError}
          revoking={guidedIam.revoking}
          onRevoke={guidedIam.onRevoke}
        />
      );
  }
}
