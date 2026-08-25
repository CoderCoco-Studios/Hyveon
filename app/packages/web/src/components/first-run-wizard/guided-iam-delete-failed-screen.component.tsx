import { AlertTriangle, Loader2 } from 'lucide-react';
import { InlineAlert } from '@/components/inline-alert.component';
import { Button } from '@/components/ui/button.component';

/** Props for {@link GuidedIamDeleteFailedScreen}. */
export interface GuidedIamDeleteFailedScreenProps {
  deleteFailedConsoleUrl: string | null;
  revokeError: string | null;
  revoking: boolean;
  /** Revokes the still-live bootstrap key without re-running mint/verify. */
  onRevoke: () => void;
}

/** `delete-failed` phase: the new key is active but the bootstrap key is still live — offers manual revocation. */
export function GuidedIamDeleteFailedScreen({
  deleteFailedConsoleUrl,
  revokeError,
  revoking,
  onRevoke,
}: GuidedIamDeleteFailedScreenProps) {
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

      <InlineAlert message={revokeError} />

      <Button type="button" variant="outline" onClick={onRevoke} disabled={revoking}>
        {revoking && <Loader2 className="animate-spin" />}
        Revoke now
      </Button>
    </div>
  );
}
