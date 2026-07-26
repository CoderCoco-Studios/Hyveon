import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AwsProfileSummary, PrerequisitesReport } from '@hyveon/desktop-preload';

const gsdMock = {
  wizard: {
    checkPrereqs: vi.fn(),
    saveState: vi.fn(),
    listAwsProfiles: vi.fn(),
    saveCredentials: vi.fn(),
  },
};
vi.stubGlobal('gsd', gsdMock);

import { FirstRunWizard } from './first-run-wizard.component.js';

const SATISFIED: PrerequisitesReport = {
  terraform: { found: true, path: '/usr/local/bin/terraform', version: '1.9.0', minimumVersionSatisfied: true },
  aws: { found: true, path: '/usr/local/bin/aws', version: '2.15.30' },
};

const UNSATISFIED: PrerequisitesReport = {
  terraform: { found: false },
  aws: { found: true, path: '/usr/local/bin/aws', version: '2.15.30' },
};

const SAMPLE_PROFILES: AwsProfileSummary[] = [
  { profileName: 'default', region: 'us-east-1' },
  { profileName: 'personal' },
];

beforeEach(() => {
  gsdMock.wizard.checkPrereqs.mockReset();
  gsdMock.wizard.saveState.mockReset();
  gsdMock.wizard.listAwsProfiles.mockReset().mockResolvedValue(SAMPLE_PROFILES);
  gsdMock.wizard.saveCredentials.mockReset();
});

/** Advances the wizard from the (satisfied) prerequisites step to pick-cloud. */
async function advanceToPickCloud(): Promise<void> {
  gsdMock.wizard.checkPrereqs.mockResolvedValue(SATISFIED);
  render(<FirstRunWizard />);
  await waitFor(() => expect(screen.getByRole('button', { name: /^next$/i })).toBeEnabled());
  await userEvent.click(screen.getByRole('button', { name: /^next$/i }));
  await screen.findByText(/choose the cloud provider/i);
}

/** Advances the wizard from prerequisites through pick-cloud to the credentials step. */
async function advanceToCredentials(): Promise<void> {
  gsdMock.wizard.saveState.mockResolvedValue({ wizardCompleted: false, activeCloud: 'aws' });
  await advanceToPickCloud();
  await userEvent.click(screen.getByRole('button', { name: /^next$/i }));
  await screen.findByText(/choose the aws credentials/i);
}

afterEach(() => {
  cleanup();
});

describe('FirstRunWizard', () => {
  it('should check prerequisites on mount and render found tools once resolved', async () => {
    gsdMock.wizard.checkPrereqs.mockResolvedValue(SATISFIED);

    render(<FirstRunWizard />);

    await waitFor(() => expect(gsdMock.wizard.checkPrereqs).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('Found v1.9.0')).toBeInTheDocument();
  });

  it('should disable Next while prerequisites are unsatisfied', async () => {
    gsdMock.wizard.checkPrereqs.mockResolvedValue(UNSATISFIED);

    render(<FirstRunWizard />);

    expect(await screen.findByText('Not found')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^next$/i })).toBeDisabled();
  });

  it('should enable Next once both tools are satisfied', async () => {
    gsdMock.wizard.checkPrereqs.mockResolvedValue(SATISFIED);

    render(<FirstRunWizard />);

    await waitFor(() => expect(screen.getByRole('button', { name: /^next$/i })).toBeEnabled());
  });

  it('should re-invoke the prerequisite check when Re-check is clicked', async () => {
    gsdMock.wizard.checkPrereqs.mockResolvedValue(UNSATISFIED);

    render(<FirstRunWizard />);
    await waitFor(() => expect(gsdMock.wizard.checkPrereqs).toHaveBeenCalledTimes(1));

    gsdMock.wizard.checkPrereqs.mockResolvedValue(SATISFIED);
    await userEvent.click(screen.getByRole('button', { name: /re-check/i }));

    await waitFor(() => expect(gsdMock.wizard.checkPrereqs).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('Found v1.9.0')).toBeInTheDocument();
  });

  it('should disable Back on the first step', async () => {
    gsdMock.wizard.checkPrereqs.mockResolvedValue(SATISFIED);
    render(<FirstRunWizard />);
    await waitFor(() => expect(gsdMock.wizard.checkPrereqs).toHaveBeenCalledTimes(1));

    expect(screen.getByRole('button', { name: /back/i })).toBeDisabled();
  });

  it('should advance to the pick-cloud step once prerequisites are satisfied and Next is clicked', async () => {
    await advanceToPickCloud();
    expect(screen.getByRole('radio', { name: /Amazon Web Services/i })).toBeInTheDocument();
  });

  it('should persist the selected cloud via wizard.state.save when advancing past pick-cloud', async () => {
    gsdMock.wizard.saveState.mockResolvedValue({ wizardCompleted: false, activeCloud: 'aws' });
    await advanceToPickCloud();

    await userEvent.click(screen.getByRole('button', { name: /^next$/i }));

    await waitFor(() => expect(gsdMock.wizard.saveState).toHaveBeenCalledWith({ activeCloud: 'aws' }));
  });

  it('should show an error and stay on pick-cloud when saving the cloud choice fails', async () => {
    gsdMock.wizard.saveState.mockRejectedValue(new Error('disk full'));
    await advanceToPickCloud();

    await userEvent.click(screen.getByRole('button', { name: /^next$/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('disk full');
    // Still on pick-cloud, not advanced further.
    expect(screen.getByRole('radio', { name: /Amazon Web Services/i })).toBeInTheDocument();
  });

  it('should allow going back from pick-cloud to prerequisites', async () => {
    await advanceToPickCloud();

    await userEvent.click(screen.getByRole('button', { name: /back/i }));

    expect(await screen.findByText('Found v1.9.0')).toBeInTheDocument();
  });

  it('should disable Back while the cloud choice save is pending, to avoid a race with the step transition', async () => {
    let resolveSave!: (value: { wizardCompleted: boolean; activeCloud: 'aws' }) => void;
    gsdMock.wizard.saveState.mockReturnValue(
      new Promise((resolve) => {
        resolveSave = resolve;
      }),
    );
    await advanceToPickCloud();

    await userEvent.click(screen.getByRole('button', { name: /^next$/i }));

    await waitFor(() => expect(screen.getByRole('button', { name: /back/i })).toBeDisabled());

    resolveSave({ wizardCompleted: false, activeCloud: 'aws' });
    await waitFor(() => expect(screen.getByRole('button', { name: /back/i })).not.toBeDisabled());
  });

  describe('credentials step', () => {
    it('should list AWS profiles on mount and populate the dropdown once on the credentials step', async () => {
      await advanceToCredentials();

      await waitFor(() => expect(gsdMock.wizard.listAwsProfiles).toHaveBeenCalledTimes(1));
      expect(screen.getByRole('option', { name: 'default' })).toBeInTheDocument();
      expect(screen.getByRole('option', { name: 'personal' })).toBeInTheDocument();
    });

    it('should disable Next until a profile is selected', async () => {
      await advanceToCredentials();
      await screen.findByLabelText('Profile');

      expect(screen.getByRole('button', { name: /^next$/i })).toBeDisabled();
    });

    it('should enable Next and default the region once a profile is picked', async () => {
      await advanceToCredentials();
      const select = await screen.findByLabelText('Profile');

      await userEvent.selectOptions(select, 'default');

      expect(screen.getByRole('button', { name: /^next$/i })).toBeEnabled();
      expect(screen.getByLabelText('Region')).toHaveValue('us-east-1');
    });

    it('should persist the selected profile and region via wizard.state.save when advancing', async () => {
      gsdMock.wizard.saveState.mockResolvedValue({ wizardCompleted: false, aws: { profile: 'default', region: 'us-east-1' } });
      await advanceToCredentials();
      const select = await screen.findByLabelText('Profile');
      await userEvent.selectOptions(select, 'default');

      await userEvent.click(screen.getByRole('button', { name: /^next$/i }));

      await waitFor(() =>
        expect(gsdMock.wizard.saveState).toHaveBeenCalledWith({ aws: { profile: 'default', region: 'us-east-1' } }),
      );
    });

    it('should persist an operator-overridden region instead of the profile default', async () => {
      gsdMock.wizard.saveState.mockResolvedValue({ wizardCompleted: false, aws: { profile: 'default', region: 'eu-west-1' } });
      await advanceToCredentials();
      const select = await screen.findByLabelText('Profile');
      await userEvent.selectOptions(select, 'default');
      const regionInput = screen.getByLabelText('Region');
      await userEvent.clear(regionInput);
      await userEvent.type(regionInput, 'eu-west-1');

      await userEvent.click(screen.getByRole('button', { name: /^next$/i }));

      await waitFor(() =>
        expect(gsdMock.wizard.saveState).toHaveBeenCalledWith({ aws: { profile: 'default', region: 'eu-west-1' } }),
      );
    });

    it('should switch to the paste form and save pasted credentials via wizard.aws.saveCredentials', async () => {
      gsdMock.wizard.saveCredentials.mockResolvedValue({ profileName: 'gsd-pasted' });
      await advanceToCredentials();

      await userEvent.click(screen.getByRole('button', { name: /paste keys instead/i }));
      await userEvent.type(screen.getByLabelText('Access key ID'), 'AKID');
      await userEvent.type(screen.getByLabelText('Secret access key'), 'SECRET');
      await userEvent.click(screen.getByRole('button', { name: /save credentials/i }));

      await waitFor(() =>
        expect(gsdMock.wizard.saveCredentials).toHaveBeenCalledWith({
          accessKeyId: 'AKID',
          secretAccessKey: 'SECRET',
          region: undefined,
        }),
      );
      expect(await screen.findByText(/saved as profile "gsd-pasted"/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^next$/i })).toBeEnabled();
    });

    it('should invalidate a successful paste save when a field is edited afterward, disabling Next again', async () => {
      gsdMock.wizard.saveCredentials.mockResolvedValue({ profileName: 'gsd-pasted' });
      await advanceToCredentials();

      await userEvent.click(screen.getByRole('button', { name: /paste keys instead/i }));
      await userEvent.type(screen.getByLabelText('Access key ID'), 'AKID');
      await userEvent.type(screen.getByLabelText('Secret access key'), 'SECRET');
      await userEvent.click(screen.getByRole('button', { name: /save credentials/i }));
      await screen.findByText(/saved as profile "gsd-pasted"/i);

      await userEvent.type(screen.getByLabelText('Secret access key'), '2');

      expect(screen.queryByText(/saved as profile/i)).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^next$/i })).toBeDisabled();
    });

    it('should show a paste error and keep Next disabled when saveCredentials fails', async () => {
      gsdMock.wizard.saveCredentials.mockRejectedValue(new Error('OS keychain unavailable'));
      await advanceToCredentials();

      await userEvent.click(screen.getByRole('button', { name: /paste keys instead/i }));
      await userEvent.type(screen.getByLabelText('Access key ID'), 'AKID');
      await userEvent.type(screen.getByLabelText('Secret access key'), 'SECRET');
      await userEvent.click(screen.getByRole('button', { name: /save credentials/i }));

      expect(await screen.findByRole('alert')).toHaveTextContent('OS keychain unavailable');
      expect(screen.getByRole('button', { name: /^next$/i })).toBeDisabled();
    });

    it('should persist the pasted profile via wizard.state.save when advancing after a successful paste', async () => {
      gsdMock.wizard.saveCredentials.mockResolvedValue({ profileName: 'gsd-pasted' });
      gsdMock.wizard.saveState.mockResolvedValue({ wizardCompleted: false, aws: { profile: 'gsd-pasted', region: 'us-west-2' } });
      await advanceToCredentials();

      await userEvent.click(screen.getByRole('button', { name: /paste keys instead/i }));
      await userEvent.type(screen.getByLabelText('Access key ID'), 'AKID');
      await userEvent.type(screen.getByLabelText('Secret access key'), 'SECRET');
      await userEvent.type(screen.getByLabelText('Region'), 'us-west-2');
      await userEvent.click(screen.getByRole('button', { name: /save credentials/i }));
      await screen.findByText(/saved as profile/i);

      await userEvent.click(screen.getByRole('button', { name: /^next$/i }));

      await waitFor(() =>
        expect(gsdMock.wizard.saveState).toHaveBeenCalledWith({ aws: { profile: 'gsd-pasted', region: 'us-west-2' } }),
      );
    });
  });
});
