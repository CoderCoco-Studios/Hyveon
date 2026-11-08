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
import { BRIDGE_UNAVAILABLE } from '@/lib/bridge.utils';

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
  /**
   * Reconfigure mode only: true once the operator submitted the paste form but nothing was written yet — the keys
   * are held in this hook's state and saved by {@link UseAwsCredentialsFormResult.flushStagedPaste} on entering stack-init.
   */
  pasteStaged: boolean;
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
  /**
   * Saves the staged paste (reconfigure mode) through `wizard.aws.saveCredentials` — the only point where it touches
   * the store — and resolves with the saved profile name. Resolves `undefined` when nothing is staged for the active
   * mode; rejects with the save error (e.g. keychain unavailable).
   */
  flushStagedPaste: () => Promise<string | undefined>;
}

// @spec APP-WIZARD-CREDS-006
/**
 * Owns the credentials step's form state: the discovered-profile fetch, the
 * profile/paste mode toggle, and the paste-flow's safeStorage save.
 *
 * @remarks
 * In `'reconfigure'` mode the paste form stages its keys in memory instead of saving on submit, because a save
 * overwrites `creds.aws.<profile>` and a Cancel must leave the stored configuration as it was; the save happens in
 * {@link UseAwsCredentialsFormResult.flushStagedPaste} when the operator enters stack-init.
 *
 * @param mode - The wizard mode; `'first-run'` (default) saves pasted keys immediately.
 */
export function useAwsCredentialsForm(mode: 'first-run' | 'reconfigure' = 'first-run'): UseAwsCredentialsFormResult {
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
  const [pasteStaged, setPasteStaged] = useState(false);

  useEffect(() => {
    async function fetchProfiles() {
      if (!window.hyveon) {
        setProfilesError(BRIDGE_UNAVAILABLE);
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

  // @spec APP-WIZARD-CREDS-007
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
    setPasteStaged(false);
  }

  // @spec APP-WIZARD-KEYCH-003, APP-WIZARD-RECONF-007
  /** Runs the safeStorage paste-flow immediately (not deferred to Next), per the credentials-step spec; stages it instead in reconfigure mode. */
  async function submitPaste() {
    if (mode === 'reconfigure') {
      if (pasteAccessKeyId.trim() === '' || pasteSecretAccessKey.trim() === '') {
        setPasteError('Enter both the access key ID and the secret access key.');
        return;
      }
      setPasteError(null);
      setPasteStaged(true);
      return;
    }
    if (!window.hyveon) {
      setPasteError(BRIDGE_UNAVAILABLE);
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

  async function flushStagedPaste(): Promise<string | undefined> {
    if (!pasteStaged || credentialMode !== 'paste') return undefined;
    if (!window.hyveon) throw new Error(BRIDGE_UNAVAILABLE);
    const result = await window.hyveon.wizard.saveCredentials({
      accessKeyId: pasteAccessKeyId,
      secretAccessKey: pasteSecretAccessKey,
      region: pasteRegion || undefined,
    });
    setPastedProfileName(result.profileName);
    setPasteStaged(false);
    return result.profileName;
  }

  // @spec APP-WIZARD-CREDS-008
  function toStatePayload(): { profile?: string; region?: string } {
    const profile = credentialMode === 'profile' ? selectedProfileName : (pastedProfileName ?? undefined);
    const chosenRegion = credentialMode === 'profile' ? region : pasteRegion;
    return { profile, region: chosenRegion || undefined };
  }

  // @spec APP-WIZARD-SHELL-007
  const isFormComplete =
    credentialMode === 'profile'
      ? selectedProfileName !== '' && region !== ''
      : (pastedProfileName !== null || pasteStaged) && pasteRegion !== '';

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
    pasteStaged,
    pastedProfileName,
    setPastedProfileName,
    isFormComplete,
    toStatePayload,
    flushStagedPaste,
  };
}
