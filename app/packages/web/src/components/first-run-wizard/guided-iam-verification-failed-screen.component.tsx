import { RotateCcw } from 'lucide-react';
import { InlineAlert } from '@/components/inline-alert.component';
import { Button } from '@/components/ui/button.component';

/** Props for {@link GuidedIamVerificationFailedScreen}. */
export interface GuidedIamVerificationFailedScreenProps {
  rotationError: string | null;
  /** Retries rotation using the same in-memory bootstrap key and region — no re-intake needed. */
  onRetryRotation: () => void;
}

/** `verification-failed` phase: the newly minted key could not be verified; offers a retry. */
export function GuidedIamVerificationFailedScreen({
  rotationError,
  onRetryRotation,
}: GuidedIamVerificationFailedScreenProps) {
  return (
    <div className="space-y-4">
      <InlineAlert message={rotationError ?? 'Key rotation failed verification.'} />
      <p className="text-sm text-muted-foreground">
        The newly minted key could not be verified. This can happen if AWS hasn&apos;t finished propagating the key
        yet — retrying with the same bootstrap key is safe.
      </p>
      <Button type="button" variant="outline" onClick={onRetryRotation}>
        <RotateCcw className="size-4" />
        Retry rotation
      </Button>
    </div>
  );
}
