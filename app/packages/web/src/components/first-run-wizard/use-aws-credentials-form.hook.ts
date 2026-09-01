/**
 * Credentials-step form state for the first-run wizard, extracted from
 * `FirstRunWizard` (finding D9): the discovered-profile list/fetch, the
 * profile-vs-paste mode, and the "paste keys instead" safeStorage flow.
 * {@link UseAwsCredentialsFormResult.toStatePayload} centralizes the
 * `credentialMode === 'profile' ? … : …` profile/region derivation, which
 * was previously duplicated at three call sites in the shell (`goNext`,
 * `commitReconfigureAnswers`, and the `credentialsChosen` gate) — now
 * computed once here.
 */
import { useEffect, useState } from 'react';
import type { AwsProfileSummary } from '@hyveon/desktop-preload';
import type { CredentialMode, PasteField } from './credentials-step.component.js';

/** Return value of {@link useAwsCredentialsForm}. */
export interface UseAwsCredentialsFormResult {
  /** Discovered `~/.aws` profiles, or `null` before the initial list resolves. */
  profiles: AwsProfileSummary[] | null;
  /** True while the initial list is in flight. */
  profilesLoading: boolean;
  /** Set when listing profiles itself fails (e.g. IPC bridge unavailable). */
  profilesError: string | null;

  credentialMode: CredentialMode;
  setCredentialMode: (mode: CredentialMode) => void;

  selectedProfileName: string;
  setSelectedProfileName: (name: string) => void;
  /** Selecting a profile defaults `region` from that profile's own configured region. */
  selectProfile: (profileName: string) => void;
  region: string;
  setRegion: (region: string) => void;

  pasteAccessKeyId: string;
  pasteSecretAccessKey: string;
  pasteRegion: string;
  setPasteRegion: (region: string) => void;
  onPasteFieldChange: (field: PasteField, value: string) => void;
  /** Runs the safeStorage paste-flow immediately (not deferred to Next), per the credentials-step spec. */
  submitPaste: () => void;
  /** True while the paste-flow save is in flight. */
  pasteSaving: boolean;
  /** Set when the paste-flow save fails (e.g. safeStorage unavailable). */
  pasteError: string | null;
  /** Set once the paste flow has successfully saved — the profile name it saved under. */
  pastedProfileName: string | null;
  setPastedProfileName: (name: string | null) => void;

  /**
   * True once the form alone has enough information to persist — a selected
   * profile with a non-empty region, or a successful paste-flow save with a
   * non-empty region. Does not factor in guided-IAM's satisfied-summary
   * bypass (`guidedCredentials`), which lives at the shell level and never
   * populates this form's fields at all.
   */
  isFormComplete: boolean;
  /**
   * Derives the `wizard.state.save({ aws })` payload from the current form
   * state: `profile` from the selected `~/.aws` profile or the paste flow's
   * saved profile name, `region` from whichever mode is active.
   */
  toStatePayload: () => { profile?: string; region?: string };
}

/**
 * Owns the credentials step's form state: the discovered-profile fetch, the
 * profile/paste mode toggle, and the paste-flow's safeStorage save.
 */
export function useAwsCredentialsForm(): UseAwsCredentialsFormResult {
  const [profiles, setProfiles] = useState<AwsProfileSummary[] | null>(null);
  const [profilesLoading, setProfilesLoading] = useState(false);
  const [profilesError, setProfilesError] = useState<string | null>(null);
  const [credentialMode, setCredentialMode] = useState<CredentialMode>('profile');
  const [selectedProfileName, setSelectedProfileName] = useState('');
  const [region, setRegion] = useState('');
  const [pasteAccessKeyId, setPasteAccessKeyId] = useState('');
  const [pasteSecretAccessKey, setPasteSecretAccessKey] = useState('');
  const [pasteRegion, setPasteRegion] = useState('');
  const [pasteSaving, setPasteSaving] = useState(false);
  const [pasteError, setPasteError] = useState<string | null>(null);
  const [pastedProfileName, setPastedProfileName] = useState<string | null>(null);

  useEffect(() => {
    async function fetchProfiles() {
      if (!window.hyveon) {
        setProfilesError('IPC bridge (window.hyveon) is not available in this context.');
        return;
      }
      setProfilesLoading(true);
      setProfilesError(null);
      try {
        const result = await window.hyveon.wizard.listAwsProfiles();
        setProfiles(result);
      } catch (err) {
        setProfilesError(err instanceof Error ? err.message : 'Failed to list AWS profiles.');
      } finally {
        setProfilesLoading(false);
      }
    }
    void fetchProfiles();
  }, []);

  /** Selecting a profile defaults `region` from that profile's own configured region. */
  function selectProfile(profileName: string) {
    setSelectedProfileName(profileName);
    const profileRegion = profiles?.find((p) => p.profileName === profileName)?.region;
    setRegion(profileRegion ?? '');
  }

  function onPasteFieldChange(field: PasteField, value: string) {
    if (field === 'accessKeyId') setPasteAccessKeyId(value);
    else if (field === 'secretAccessKey') setPasteSecretAccessKey(value);
    else setPasteRegion(value);
    setPastedProfileName(null);
  }

  /** Runs the safeStorage paste-flow immediately (not deferred to Next), per the credentials-step spec. */
  async function submitPaste() {
    if (!window.hyveon) {
      setPasteError('IPC bridge (window.hyveon) is not available in this context.');
      return;
    }
    setPasteSaving(true);
    setPasteError(null);
    try {
      const result = await window.hyveon.wizard.saveCredentials({
        accessKeyId: pasteAccessKeyId,
        secretAccessKey: pasteSecretAccessKey,
        region: pasteRegion || undefined,
      });
      setPastedProfileName(result.profileName);
    } catch (err) {
      setPasteError(err instanceof Error ? err.message : 'Failed to save credentials.');
    } finally {
      setPasteSaving(false);
    }
  }

  function toStatePayload(): { profile?: string; region?: string } {
    const profile = credentialMode === 'profile' ? selectedProfileName : (pastedProfileName ?? undefined);
    const chosenRegion = credentialMode === 'profile' ? region : pasteRegion;
    return { profile, region: chosenRegion || undefined };
  }

  const isFormComplete =
    credentialMode === 'profile'
      ? selectedProfileName !== '' && region !== ''
      : pastedProfileName !== null && pasteRegion !== '';

  return {
    profiles,
    profilesLoading,
    profilesError,
    credentialMode,
    setCredentialMode,
    selectedProfileName,
    setSelectedProfileName,
    selectProfile,
    region,
    setRegion,
    pasteAccessKeyId,
    pasteSecretAccessKey,
    pasteRegion,
    setPasteRegion,
    onPasteFieldChange,
    submitPaste: () => void submitPaste(),
    pasteSaving,
    pasteError,
    pastedProfileName,
    setPastedProfileName,
    isFormComplete,
    toStatePayload,
  };
}
