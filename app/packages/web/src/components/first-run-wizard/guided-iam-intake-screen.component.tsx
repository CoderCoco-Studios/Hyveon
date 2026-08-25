import type { Dispatch, SetStateAction } from 'react';
import { Loader2 } from 'lucide-react';
import { InlineAlert } from '@/components/inline-alert.component';
import { Button } from '@/components/ui/button.component';
import { Input } from '@/components/ui/input.component';
import { Label } from '@/components/ui/label.component';

/** Props for {@link GuidedIamIntakeScreen}. */
export interface GuidedIamIntakeScreenProps {
  /** True while `guidedIamRotate()` is in flight — backs both `intake` and `rotating`, which share this one screen. */
  isRotating: boolean;
  /** True when this mount resumed directly into `intake` via `subState: 'rotation-pending'`. */
  resumedRotationPending: boolean;
  region: string;
  setRegion: Dispatch<SetStateAction<string>>;
  accessKeyId: string;
  setAccessKeyId: Dispatch<SetStateAction<string>>;
  secretAccessKey: string;
  setSecretAccessKey: Dispatch<SetStateAction<string>>;
  intakeError: string | null;
  submitting: boolean;
  /** Validates the region + pasted bootstrap key pair, then kicks off rotation. */
  onSubmit: () => void;
}

/** `intake`/`rotating` phases: the access-key-pair form, then a spinner while `guidedIamRotate()` runs. */
export function GuidedIamIntakeScreen({
  isRotating,
  resumedRotationPending,
  region,
  setRegion,
  accessKeyId,
  setAccessKeyId,
  secretAccessKey,
  setSecretAccessKey,
  intakeError,
  submitting,
  onSubmit,
}: GuidedIamIntakeScreenProps) {
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
        <Label htmlFor="wizard-guided-iam-intake-region">AWS region</Label>
        <Input
          id="wizard-guided-iam-intake-region"
          value={region}
          placeholder="us-east-1"
          onChange={(e) => setRegion(e.target.value)}
          disabled={isRotating}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="wizard-guided-iam-access-key-id">Access key ID</Label>
        <Input
          id="wizard-guided-iam-access-key-id"
          value={accessKeyId}
          onChange={(e) => setAccessKeyId(e.target.value)}
          disabled={isRotating}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="wizard-guided-iam-secret-access-key">Secret access key</Label>
        <Input
          id="wizard-guided-iam-secret-access-key"
          type="password"
          value={secretAccessKey}
          onChange={(e) => setSecretAccessKey(e.target.value)}
          disabled={isRotating}
        />
      </div>

      <InlineAlert message={intakeError} />

      {isRotating ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          Rotating your AWS credentials…
        </div>
      ) : (
        <Button type="button" onClick={onSubmit} disabled={submitting}>
          {submitting && <Loader2 className="animate-spin" />}
          Validate and rotate key
        </Button>
      )}
    </div>
  );
}
