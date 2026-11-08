import { KeyRound } from 'lucide-react';
import { InlineAlert } from '@/components/inline-alert.component';
import { Button } from '@/components/ui/button.component';

/** Props for {@link GuidedIamKeychainUnavailableScreen}. */
export interface GuidedIamKeychainUnavailableScreenProps {
  /** Leaves guided setup for the credentials step, which offers the profile picker and the paste form. */
  onChooseManual: () => void;
}

// @spec APP-WIZARD-KEYCH-002
/** `keychain-unavailable` phase: guided rotation was refused before any key was minted; leads with the profile picker, the one manual path that needs no keychain. */
export function GuidedIamKeychainUnavailableScreen({ onChooseManual }: GuidedIamKeychainUnavailableScreenProps) {
  return (
    <div className="space-y-4">
      <InlineAlert message="The OS keychain is unavailable, so Hyveon cannot store a rotated access key." />
      <p className="text-sm text-muted-foreground">
        Guided setup stops here and no new access key was minted. Pick an existing AWS CLI profile on the credentials
        step, which does not need the keychain. Pasting keys fails the same way until it is unlocked.
      </p>
      <Button type="button" variant="outline" onClick={onChooseManual}>
        <KeyRound className="size-4" />
        Choose a profile
      </Button>
    </div>
  );
}
