import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AwsProfileSummary } from '@hyveon/desktop-preload';
import { CredentialsStep, type CredentialsStepProps } from './credentials-step.component.js';

afterEach(() => {
  cleanup();
});

const SAMPLE_PROFILES: AwsProfileSummary[] = [
  { profileName: 'default', region: 'us-east-1' },
  { profileName: 'personal' },
];

/** Builds default props for {@link CredentialsStep}; overrides merge in per-test. */
function makeProps(overrides: Partial<CredentialsStepProps> = {}): CredentialsStepProps {
  return {
    mode: 'profile',
    onModeChange: vi.fn(),
    profiles: SAMPLE_PROFILES,
    profilesLoading: false,
    profilesError: null,
    selectedProfileName: '',
    onSelectProfile: vi.fn(),
    region: '',
    onRegionChange: vi.fn(),
    pasteAccessKeyId: '',
    pasteSecretAccessKey: '',
    pasteRegion: '',
    onPasteFieldChange: vi.fn(),
    onSubmitPaste: vi.fn(),
    pasteSaving: false,
    pasteError: null,
    pastedProfileName: null,
    ...overrides,
  };
}

describe('CredentialsStep', () => {
  describe('profile mode', () => {
    it('should populate the dropdown with the discovered profiles', () => {
      render(<CredentialsStep {...makeProps()} />);

      const select = screen.getByLabelText('Profile') as HTMLSelectElement;
      const optionLabels = Array.from(select.options).map((o) => o.value);
      expect(optionLabels).toEqual(['', 'default', 'personal']);
    });

    it('should show a loading message before the initial profile list resolves', () => {
      render(<CredentialsStep {...makeProps({ profiles: null, profilesLoading: true })} />);
      expect(screen.getByText(/loading aws profiles/i)).toBeInTheDocument();
    });

    it('should show a no-profiles message when the list resolves empty', () => {
      render(<CredentialsStep {...makeProps({ profiles: [] })} />);
      expect(screen.getByText(/no aws cli profiles found/i)).toBeInTheDocument();
    });

    it('should surface a profiles-list error', () => {
      render(<CredentialsStep {...makeProps({ profiles: null, profilesError: 'IPC bridge unavailable' })} />);
      expect(screen.getByRole('alert')).toHaveTextContent('IPC bridge unavailable');
    });

    it('should call onSelectProfile when a profile is chosen', async () => {
      const onSelectProfile = vi.fn();
      render(<CredentialsStep {...makeProps({ onSelectProfile })} />);

      await userEvent.selectOptions(screen.getByLabelText('Profile'), 'personal');

      expect(onSelectProfile).toHaveBeenCalledWith('personal');
    });

    it('should default the region field from the selected profile', () => {
      render(<CredentialsStep {...makeProps({ selectedProfileName: 'default', region: 'us-east-1' })} />);
      expect(screen.getByLabelText('Region')).toHaveValue('us-east-1');
    });

    it('should call onRegionChange when the operator edits the region', async () => {
      const onRegionChange = vi.fn();
      render(<CredentialsStep {...makeProps({ selectedProfileName: 'default', region: '', onRegionChange })} />);

      await userEvent.type(screen.getByLabelText('Region'), 'e');

      expect(onRegionChange).toHaveBeenCalledWith('e');
    });
  });

  describe('mode toggle', () => {
    it('should call onModeChange with "paste" when "Paste keys instead" is clicked', async () => {
      const onModeChange = vi.fn();
      render(<CredentialsStep {...makeProps({ onModeChange })} />);

      await userEvent.click(screen.getByRole('button', { name: /paste keys instead/i }));

      expect(onModeChange).toHaveBeenCalledWith('paste');
    });

    it('should mark the active mode button as pressed', () => {
      render(<CredentialsStep {...makeProps({ mode: 'paste' })} />);
      expect(screen.getByRole('button', { name: /paste keys instead/i })).toHaveAttribute('aria-pressed', 'true');
      expect(screen.getByRole('button', { name: /use an existing profile/i })).toHaveAttribute('aria-pressed', 'false');
    });
  });

  describe('paste mode', () => {
    function pasteProps(overrides: Partial<CredentialsStepProps> = {}) {
      return makeProps({ mode: 'paste', ...overrides });
    }

    it('should render the paste form fields', () => {
      render(<CredentialsStep {...pasteProps()} />);
      expect(screen.getByLabelText('Access key ID')).toBeInTheDocument();
      expect(screen.getByLabelText('Secret access key')).toBeInTheDocument();
      expect(screen.getByLabelText('Region')).toBeInTheDocument();
    });

    it('should call onPasteFieldChange when the access key ID is typed', async () => {
      const onPasteFieldChange = vi.fn();
      render(<CredentialsStep {...pasteProps({ onPasteFieldChange })} />);

      await userEvent.type(screen.getByLabelText('Access key ID'), 'A');

      expect(onPasteFieldChange).toHaveBeenCalledWith('accessKeyId', 'A');
    });

    it('should call onSubmitPaste when "Save credentials" is clicked', async () => {
      const onSubmitPaste = vi.fn();
      render(<CredentialsStep {...pasteProps({ onSubmitPaste })} />);

      await userEvent.click(screen.getByRole('button', { name: /save credentials/i }));

      expect(onSubmitPaste).toHaveBeenCalledTimes(1);
    });

    it('should disable "Save credentials" while a save is in flight', () => {
      render(<CredentialsStep {...pasteProps({ pasteSaving: true })} />);
      expect(screen.getByRole('button', { name: /save credentials/i })).toBeDisabled();
    });

    it('should surface a paste-flow error', () => {
      render(<CredentialsStep {...pasteProps({ pasteError: 'OS keychain unavailable' })} />);
      expect(screen.getByRole('alert')).toHaveTextContent('OS keychain unavailable');
    });

    it('should show a saved confirmation once the paste flow succeeds', () => {
      render(<CredentialsStep {...pasteProps({ pastedProfileName: 'gsd-pasted' })} />);
      expect(screen.getByText(/saved as profile "gsd-pasted"/i)).toBeInTheDocument();
    });
  });
});
