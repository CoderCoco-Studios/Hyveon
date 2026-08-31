import { CheckCircle2, Loader2 } from 'lucide-react';
import type { AwsProfileSummary } from '@hyveon/desktop-preload';
import { InlineAlert } from '@/components/inline-alert.component';
import { Button } from '@/components/ui/button.component';
import { Input } from '@/components/ui/input.component';
import { Label } from '@/components/ui/label.component';

/** How the operator is supplying AWS credentials in {@link CredentialsStep}. */
export type CredentialMode = 'profile' | 'paste';

/** A field in the "paste keys instead" form. */
export type PasteField = 'accessKeyId' | 'secretAccessKey' | 'region';

/** Props for {@link CredentialsStep}. */
export interface CredentialsStepProps {
  mode: CredentialMode;
  onModeChange: (mode: CredentialMode) => void;

  /** Discovered `~/.aws` profiles, or `null` before the initial list resolves. */
  profiles: AwsProfileSummary[] | null;
  /** True while the initial list (or a re-list) is in flight. */
  profilesLoading: boolean;
  /** Set when listing profiles itself fails (e.g. IPC bridge unavailable). */
  profilesError: string | null;

  /** Currently selected profile name in `mode: 'profile'`; `''` means none chosen yet. */
  selectedProfileName: string;
  onSelectProfile: (profileName: string) => void;
  /** Region for the selected profile — defaults from the profile's own region, editable. */
  region: string;
  onRegionChange: (region: string) => void;

  pasteAccessKeyId: string;
  pasteSecretAccessKey: string;
  pasteRegion: string;
  onPasteFieldChange: (field: PasteField, value: string) => void;
  onSubmitPaste: () => void;
  /** True while the paste-flow save is in flight. */
  pasteSaving: boolean;
  /** Set when the paste-flow save fails (e.g. safeStorage unavailable). */
  pasteError: string | null;
  /** Set once the paste flow has successfully saved — the profile name it saved under. */
  pastedProfileName: string | null;

  /**
   * Set by the shell when it detects `wizard.state.get()`'s `aws?.profile`
   * equals `GUIDED_PROFILE_NAME` (the guided-IAM step, #Group 7, already
   * provisioned and activated a rotated credential) — renders a satisfied
   * summary of `principal`/`region` instead of the normal profile-picker/
   * paste form. `principal` is deliberately not an AWS account ID: nothing
   * in this flow surfaces one, so the shell passes a generic descriptive
   * label (e.g. `"AWS account (guided setup)"`) instead of inventing new IPC
   * plumbing to fetch one.
   */
  satisfiedByGuidedProvisioning?: { principal: string; region: string };
  /**
   * Clears {@link satisfiedByGuidedProvisioning}, falling through to the
   * normal picker/paste form — the escape hatch off the satisfied summary.
   * Parent-controlled (the shell owns whether the satisfied prop is set at
   * all), matching {@link CompletedStepSummary}'s Edit-affordance pattern
   * one level up, but living inside this step component instead of
   * replacing it wholesale, since the normal form must still be reachable.
   */
  onSwitchSource: () => void;
}

/**
 * Credentials step of the first-run wizard (#192): the operator either picks
 * a discovered `~/.aws` CLI profile or pastes an access key ID/secret
 * directly (encrypted via the safeStorage flow from #197). Purely
 * presentational — the parent wizard shell owns all state, the
 * `listAwsProfiles`/`saveCredentials` IPC calls, and persisting the final
 * choice via `wizard.state.save` when the operator advances. The one
 * exception is {@link CredentialsStepProps.satisfiedByGuidedProvisioning}:
 * when set, this renders a satisfied summary in place of the normal form
 * entirely, still purely from props the shell computed.
 */
export function CredentialsStep({
  mode,
  onModeChange,
  profiles,
  profilesLoading,
  profilesError,
  selectedProfileName,
  onSelectProfile,
  region,
  onRegionChange,
  pasteAccessKeyId,
  pasteSecretAccessKey,
  pasteRegion,
  onPasteFieldChange,
  onSubmitPaste,
  pasteSaving,
  pasteError,
  pastedProfileName,
  satisfiedByGuidedProvisioning,
  onSwitchSource,
}: CredentialsStepProps) {
  if (satisfiedByGuidedProvisioning) {
    return (
      <div className="space-y-6">
        <p className="text-sm text-muted-foreground">
          Hyveon already provisioned and activated AWS credentials during guided setup.
        </p>
        <div className="flex items-center justify-between rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-2)] p-4">
          <span className="flex items-center gap-2 text-sm text-[var(--color-green)]">
            <CheckCircle2 className="size-4" />
            {satisfiedByGuidedProvisioning.principal} · {satisfiedByGuidedProvisioning.region}
          </span>
          <Button type="button" variant="outline" size="sm" onClick={onSwitchSource}>
            Switch to a different source
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">
        Choose the AWS credentials Hyveon will use to manage your game servers.
      </p>

      <div className="flex gap-2" role="group" aria-label="Credential source">
        <Button
          type="button"
          variant={mode === 'profile' ? 'default' : 'outline'}
          aria-pressed={mode === 'profile'}
          onClick={() => onModeChange('profile')}
        >
          Use an existing profile
        </Button>
        <Button
          type="button"
          variant={mode === 'paste' ? 'default' : 'outline'}
          aria-pressed={mode === 'paste'}
          onClick={() => onModeChange('paste')}
        >
          Paste keys instead
        </Button>
      </div>

      {mode === 'profile' && (
        <div className="space-y-4">
          <InlineAlert message={profilesError} />

          {!profiles && profilesLoading && !profilesError && (
            <p className="text-sm text-muted-foreground">Loading AWS profiles…</p>
          )}

          {profiles && profiles.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No AWS CLI profiles found on this machine. Use &quot;Paste keys instead&quot; below.
            </p>
          )}

          {profiles && profiles.length > 0 && (
            <div className="space-y-2">
              <Label htmlFor="wizard-credentials-profile">Profile</Label>
              <select
                id="wizard-credentials-profile"
                value={selectedProfileName}
                onChange={(e) => onSelectProfile(e.target.value)}
                className="h-9 w-full rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 text-sm text-[var(--color-foreground)] focus:outline-none focus:ring-1 focus:ring-[var(--color-primary)]"
              >
                <option value="">Select a profile…</option>
                {profiles.map((profile) => (
                  <option key={profile.profileName} value={profile.profileName}>
                    {profile.profileName}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="wizard-credentials-profile-region">Region</Label>
            <Input
              id="wizard-credentials-profile-region"
              value={region}
              placeholder="us-east-1"
              onChange={(e) => onRegionChange(e.target.value)}
            />
          </div>
        </div>
      )}

      {mode === 'paste' && (
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="wizard-credentials-paste-access-key-id">Access key ID</Label>
            <Input
              id="wizard-credentials-paste-access-key-id"
              value={pasteAccessKeyId}
              onChange={(e) => onPasteFieldChange('accessKeyId', e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="wizard-credentials-paste-secret-access-key">Secret access key</Label>
            <Input
              id="wizard-credentials-paste-secret-access-key"
              type="password"
              value={pasteSecretAccessKey}
              onChange={(e) => onPasteFieldChange('secretAccessKey', e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="wizard-credentials-paste-region">Region</Label>
            <Input
              id="wizard-credentials-paste-region"
              value={pasteRegion}
              placeholder="us-east-1"
              onChange={(e) => onPasteFieldChange('region', e.target.value)}
            />
          </div>

          <InlineAlert message={pasteError} />

          {pastedProfileName && (
            <p className="flex items-center gap-1 text-sm text-[var(--color-green)]">
              <CheckCircle2 className="size-4" />
              Saved as profile &quot;{pastedProfileName}&quot;
            </p>
          )}

          <Button type="button" variant="outline" onClick={onSubmitPaste} disabled={pasteSaving}>
            {pasteSaving && <Loader2 className="animate-spin" />}
            Save credentials
          </Button>
        </div>
      )}
    </div>
  );
}
