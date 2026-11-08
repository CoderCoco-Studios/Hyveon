import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { errMessage } from '@hyveon/shared';
import { api, type AwsKeyRotateResult } from '../api.service.js';
import { Button } from './ui/button.component.js';
import { Input } from './ui/input.component.js';
import { InlineAlert } from './inline-alert.component.js';
import { SettingsRow } from './settings-row.component.js';

/** Alert text for a rotation outcome that left nothing changed, or `null` for the outcomes rendered as notices. */
function refusalMessage(result: AwsKeyRotateResult): string | null {
  switch (result.status) {
    case 'keychain-unavailable':
      return 'The OS keychain is unavailable, so the key was not rotated. Unlock the keychain and try again.';
    case 'unsupported':
    case 'failed':
      return result.message;
    default:
      return null;
  }
}

// @spec APP-WIZARD-ROTKEY-005
/**
 * Settings row that rotates the active pasted or guided access key in place: the app mints a new key, verifies it,
 * stores it, then revokes the old one. Later AWS calls and Pulumi operations resolve the stored key on every call, so
 * they pick up the new key without a restart.
 *
 * @returns the row with its Rotate key button and the latest outcome.
 */
export function RotateAccessKeyRow() {
  const [rotating, setRotating] = useState(false);
  const [result, setResult] = useState<AwsKeyRotateResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  /** Runs one rotation and records its outcome; the controller de-duplicates concurrent calls. */
  async function handleRotate() {
    setRotating(true);
    setResult(null);
    setError(null);
    try {
      setResult(await api.rotateAwsKey());
    } catch (err) {
      setError(errMessage(err));
    } finally {
      setRotating(false);
    }
  }

  const refusal = result ? refusalMessage(result) : null;

  return (
    <div className="space-y-2">
      <SettingsRow
        label="AWS access key"
        description="Replace the access key the app uses with a freshly minted one and revoke the old key."
      >
        <Button type="button" variant="outline" onClick={() => void handleRotate()} disabled={rotating}>
          {rotating && <Loader2 className="animate-spin" />}
          {rotating ? 'Rotating…' : 'Rotate key'}
        </Button>
      </SettingsRow>
      <InlineAlert message={error ?? refusal} />
      {result?.status === 'complete' && (
        <p className="text-sm text-[var(--color-green)]">Access key rotated. The old key has been revoked.</p>
      )}
      {result?.status === 'verification-failed' && (
        <p className="text-sm text-[var(--color-amber)]">
          The new key could not be verified, so your previous key is still active: {result.error}
        </p>
      )}
      {result?.status === 'delete-failed' && (
        <div className="space-y-1">
          <p className="text-sm text-[var(--color-amber)]">
            The new key is active, but the old key could not be deleted. Revoke it manually in the IAM console:
          </p>
          <Input value={result.consoleUrl} readOnly onFocus={(e) => e.currentTarget.select()} />
        </div>
      )}
    </div>
  );
}
