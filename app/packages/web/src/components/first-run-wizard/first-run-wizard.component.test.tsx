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
    bootstrapStateBucket: vi.fn(),
    bootstrapLockTable: vi.fn(),
    bootstrapTfvarsBucket: vi.fn(),
    simulateIamPermissions: vi.fn(),
    getProgress: vi.fn(),
    saveProgress: vi.fn(),
    complete: vi.fn(),
  },
  terraform: {
    init: vi.fn(),
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
  // Defaulted (not just reset): the bootstrap step's fire-and-forget
  // `wizard.state.save({ bootstrap })` call (see `goNext`) uses a bare
  // `.catch()`, not an awaited try/catch, so an unmocked call (returning
  // `undefined`) would throw synchronously. Individual tests still override
  // this with a more specific resolved value where the response shape matters.
  gsdMock.wizard.saveState.mockReset().mockResolvedValue({ wizardCompleted: false });
  gsdMock.wizard.listAwsProfiles.mockReset().mockResolvedValue(SAMPLE_PROFILES);
  gsdMock.wizard.saveCredentials.mockReset();
  gsdMock.wizard.bootstrapStateBucket.mockReset();
  gsdMock.wizard.bootstrapLockTable.mockReset();
  gsdMock.wizard.bootstrapTfvarsBucket.mockReset();
  gsdMock.wizard.simulateIamPermissions.mockReset();
  // Defaulted (not just reset) so the shell's resume-on-mount/per-step-save
  // effects — present on every render regardless of which step a test cares
  // about — never throw on an unmocked call.
  gsdMock.wizard.getProgress.mockReset().mockResolvedValue({ step: 'prerequisites' });
  gsdMock.wizard.saveProgress.mockReset().mockResolvedValue(undefined);
  gsdMock.wizard.complete.mockReset();
  gsdMock.terraform.init.mockReset();
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

/** Advances the wizard from prerequisites through pick-cloud and credentials (profile path) to the bootstrap step. */
async function advanceToBootstrap(): Promise<void> {
  gsdMock.wizard.saveState.mockResolvedValue({ wizardCompleted: false, aws: { profile: 'default', region: 'us-east-1' } });
  await advanceToCredentials();
  const select = await screen.findByLabelText('Profile');
  await userEvent.selectOptions(select, 'default');
  await userEvent.click(screen.getByRole('button', { name: /^next$/i }));
  await screen.findByLabelText('Terraform state bucket name');
}

/** Advances the wizard all the way to the terraform-init step, with all three bootstrap resources succeeding. */
async function advanceToTerraformInit(): Promise<void> {
  gsdMock.wizard.bootstrapStateBucket.mockResolvedValue({ status: 'created' });
  gsdMock.wizard.bootstrapLockTable.mockResolvedValue({ status: 'created' });
  gsdMock.wizard.bootstrapTfvarsBucket.mockResolvedValue({ status: 'created' });
  gsdMock.terraform.init.mockImplementation(async function* () {
    // No chunks needed by default — individual tests override this.
  });
  await advanceToBootstrap();
  await userEvent.click(screen.getByRole('button', { name: /bootstrap aws resources/i }));
  await waitFor(() => expect(screen.getByRole('button', { name: /^next$/i })).toBeEnabled());
  await userEvent.click(screen.getByRole('button', { name: /^next$/i }));
  await screen.findByRole('button', { name: /finish setup/i });
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

    it('should keep Next disabled when the selected profile has no region configured', async () => {
      await advanceToCredentials();
      const select = await screen.findByLabelText('Profile');

      await userEvent.selectOptions(select, 'personal');

      expect(screen.getByLabelText('Region')).toHaveValue('');
      expect(screen.getByRole('button', { name: /^next$/i })).toBeDisabled();
    });

    it('should enable Next once an operator fills in a region for a profile that had none', async () => {
      await advanceToCredentials();
      const select = await screen.findByLabelText('Profile');
      await userEvent.selectOptions(select, 'personal');

      await userEvent.type(screen.getByLabelText('Region'), 'eu-central-1');

      expect(screen.getByRole('button', { name: /^next$/i })).toBeEnabled();
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
      await userEvent.type(screen.getByLabelText('Region'), 'us-west-2');
      await userEvent.click(screen.getByRole('button', { name: /save credentials/i }));

      await waitFor(() =>
        expect(gsdMock.wizard.saveCredentials).toHaveBeenCalledWith({
          accessKeyId: 'AKID',
          secretAccessKey: 'SECRET',
          region: 'us-west-2',
        }),
      );
      expect(await screen.findByText(/saved as profile "gsd-pasted"/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^next$/i })).toBeEnabled();
    });

    it('should keep Next disabled after a successful paste save when no region was entered', async () => {
      gsdMock.wizard.saveCredentials.mockResolvedValue({ profileName: 'gsd-pasted' });
      await advanceToCredentials();

      await userEvent.click(screen.getByRole('button', { name: /paste keys instead/i }));
      await userEvent.type(screen.getByLabelText('Access key ID'), 'AKID');
      await userEvent.type(screen.getByLabelText('Secret access key'), 'SECRET');
      await userEvent.click(screen.getByRole('button', { name: /save credentials/i }));

      expect(await screen.findByText(/saved as profile "gsd-pasted"/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^next$/i })).toBeDisabled();
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

  describe('bootstrap step', () => {
    it('should disable Next until all three resources are created or already exist', async () => {
      await advanceToBootstrap();

      expect(screen.getByRole('button', { name: /^next$/i })).toBeDisabled();
    });

    it('should call all three bootstrap IPC methods with the current resource names when the bootstrap button is clicked', async () => {
      gsdMock.wizard.bootstrapStateBucket.mockResolvedValue({ status: 'created' });
      gsdMock.wizard.bootstrapLockTable.mockResolvedValue({ status: 'created' });
      gsdMock.wizard.bootstrapTfvarsBucket.mockResolvedValue({ status: 'created' });
      await advanceToBootstrap();

      await userEvent.click(screen.getByRole('button', { name: /bootstrap aws resources/i }));

      await waitFor(() =>
        expect(gsdMock.wizard.bootstrapStateBucket).toHaveBeenCalledWith({ bucketName: 'hyveon-tfstate' }),
      );
      expect(gsdMock.wizard.bootstrapLockTable).toHaveBeenCalledWith({ tableName: 'hyveon-tflock' });
      expect(gsdMock.wizard.bootstrapTfvarsBucket).toHaveBeenCalledWith({ bucketName: 'hyveon-tfvars' });
    });

    it('should enable Next once all three resources report created or exists', async () => {
      gsdMock.wizard.bootstrapStateBucket.mockResolvedValue({ status: 'created' });
      gsdMock.wizard.bootstrapLockTable.mockResolvedValue({ status: 'exists' });
      gsdMock.wizard.bootstrapTfvarsBucket.mockResolvedValue({ status: 'created' });
      await advanceToBootstrap();

      await userEvent.click(screen.getByRole('button', { name: /bootstrap aws resources/i }));

      await waitFor(() => expect(screen.getByRole('button', { name: /^next$/i })).toBeEnabled());
    });

    it('should keep Next disabled and show a failure message when one resource fails', async () => {
      gsdMock.wizard.bootstrapStateBucket.mockResolvedValue({ status: 'failed', message: 'bucket taken' });
      gsdMock.wizard.bootstrapLockTable.mockResolvedValue({ status: 'created' });
      gsdMock.wizard.bootstrapTfvarsBucket.mockResolvedValue({ status: 'created' });
      await advanceToBootstrap();

      await userEvent.click(screen.getByRole('button', { name: /bootstrap aws resources/i }));

      expect(await screen.findByText('bucket taken')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^next$/i })).toBeDisabled();
    });

    it('should run the IAM check via wizard.iam.simulate and render a passed result', async () => {
      gsdMock.wizard.simulateIamPermissions.mockResolvedValue({ status: 'passed' });
      await advanceToBootstrap();

      await userEvent.click(screen.getByRole('button', { name: /check permissions/i }));

      expect(await screen.findByText(/all required permissions are present/i)).toBeInTheDocument();
    });

    it('should not block Next on a failed or missing IAM check — only the three bootstrap resources gate progression', async () => {
      gsdMock.wizard.bootstrapStateBucket.mockResolvedValue({ status: 'created' });
      gsdMock.wizard.bootstrapLockTable.mockResolvedValue({ status: 'created' });
      gsdMock.wizard.bootstrapTfvarsBucket.mockResolvedValue({ status: 'created' });
      gsdMock.wizard.simulateIamPermissions.mockResolvedValue({ status: 'missing', policyJson: '{}' });
      await advanceToBootstrap();

      await userEvent.click(screen.getByRole('button', { name: /bootstrap aws resources/i }));
      await waitFor(() => expect(screen.getByRole('button', { name: /^next$/i })).toBeEnabled());
      await userEvent.click(screen.getByRole('button', { name: /check permissions/i }));

      expect(await screen.findByText(/some permissions are missing/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^next$/i })).toBeEnabled();
    });

    it('should persist the current resource names via wizard.state.save when advancing past bootstrap', async () => {
      gsdMock.wizard.bootstrapStateBucket.mockResolvedValue({ status: 'created' });
      gsdMock.wizard.bootstrapLockTable.mockResolvedValue({ status: 'created' });
      gsdMock.wizard.bootstrapTfvarsBucket.mockResolvedValue({ status: 'created' });
      gsdMock.wizard.saveState.mockResolvedValue({ wizardCompleted: false });
      await advanceToBootstrap();
      await userEvent.click(screen.getByRole('button', { name: /bootstrap aws resources/i }));
      await waitFor(() => expect(screen.getByRole('button', { name: /^next$/i })).toBeEnabled());

      await userEvent.click(screen.getByRole('button', { name: /^next$/i }));

      await waitFor(() =>
        expect(gsdMock.wizard.saveState).toHaveBeenCalledWith({
          bootstrap: { stateBucket: 'hyveon-tfstate', lockTable: 'hyveon-tflock', tfvarsBucket: 'hyveon-tfvars' },
        }),
      );
    });
  });

  describe('terraform-init step', () => {
    it('should hide the shared Next button once on the terraform-init step', async () => {
      await advanceToTerraformInit();

      expect(screen.queryByRole('button', { name: /^next$/i })).not.toBeInTheDocument();
    });

    it('should call wizard.complete and invoke onComplete when Finish setup succeeds', async () => {
      gsdMock.terraform.init.mockImplementation(async function* () {
        yield { stream: 'stdout', line: 'Terraform has been successfully initialized!' };
      });
      gsdMock.wizard.complete.mockResolvedValue({ wizardCompleted: true });
      gsdMock.wizard.checkPrereqs.mockResolvedValue(SATISFIED);
      const onComplete = vi.fn();
      render(<FirstRunWizard onComplete={onComplete} />);
      await waitFor(() => expect(screen.getByRole('button', { name: /^next$/i })).toBeEnabled());
      await userEvent.click(screen.getByRole('button', { name: /^next$/i }));
      await screen.findByText(/choose the cloud provider/i);
      await userEvent.click(screen.getByRole('button', { name: /^next$/i }));
      await screen.findByText(/choose the aws credentials/i);
      await userEvent.selectOptions(await screen.findByLabelText('Profile'), 'default');
      await userEvent.click(screen.getByRole('button', { name: /^next$/i }));
      await screen.findByLabelText('Terraform state bucket name');
      gsdMock.wizard.bootstrapStateBucket.mockResolvedValue({ status: 'created' });
      gsdMock.wizard.bootstrapLockTable.mockResolvedValue({ status: 'created' });
      gsdMock.wizard.bootstrapTfvarsBucket.mockResolvedValue({ status: 'created' });
      await userEvent.click(screen.getByRole('button', { name: /bootstrap aws resources/i }));
      await waitFor(() => expect(screen.getByRole('button', { name: /^next$/i })).toBeEnabled());
      await userEvent.click(screen.getByRole('button', { name: /^next$/i }));
      await waitFor(() => expect(screen.getByRole('button', { name: /finish setup/i })).toBeEnabled());

      await userEvent.click(screen.getByRole('button', { name: /finish setup/i }));

      await waitFor(() => expect(gsdMock.wizard.complete).toHaveBeenCalledTimes(1));
      expect(onComplete).toHaveBeenCalledTimes(1);
    });

    it('should persist each step via wizard.progress.save as the wizard advances', async () => {
      await advanceToBootstrap();

      await waitFor(() => expect(gsdMock.wizard.saveProgress).toHaveBeenCalledWith({ step: 'bootstrap' }));
    });
  });

  describe('resume-on-mount', () => {
    it('should start at prerequisites when wizard.progress.get resolves to the prerequisites step', async () => {
      gsdMock.wizard.checkPrereqs.mockResolvedValue(SATISFIED);
      gsdMock.wizard.getProgress.mockResolvedValue({ step: 'prerequisites' });

      render(<FirstRunWizard />);

      expect(await screen.findByText('Found v1.9.0')).toBeInTheDocument();
    });

    it('should jump straight to the recorded step when wizard.progress.get resolves to a later step', async () => {
      gsdMock.wizard.checkPrereqs.mockResolvedValue(SATISFIED);
      gsdMock.wizard.listAwsProfiles.mockResolvedValue(SAMPLE_PROFILES);
      gsdMock.wizard.getProgress.mockResolvedValue({ step: 'credentials' });

      render(<FirstRunWizard />);

      expect(await screen.findByText(/choose the aws credentials/i)).toBeInTheDocument();
    });

    it('should stay on prerequisites when wizard.progress.get rejects', async () => {
      gsdMock.wizard.checkPrereqs.mockResolvedValue(SATISFIED);
      gsdMock.wizard.getProgress.mockRejectedValue(new Error('state file corrupt'));

      render(<FirstRunWizard />);

      expect(await screen.findByText('Found v1.9.0')).toBeInTheDocument();
    });

    it('should clamp a recorded terraform-init step down to bootstrap, rather than auto-running terraform init on mount', async () => {
      gsdMock.wizard.checkPrereqs.mockResolvedValue(SATISFIED);
      gsdMock.wizard.getProgress.mockResolvedValue({ step: 'terraform-init' });

      render(<FirstRunWizard />);

      expect(await screen.findByLabelText('Terraform state bucket name')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /finish setup/i })).not.toBeInTheDocument();
      expect(gsdMock.terraform.init).not.toHaveBeenCalled();
    });

    it('should not save progress before the resume check has settled, so a fast render never clobbers a resumed step', async () => {
      gsdMock.wizard.checkPrereqs.mockResolvedValue(SATISFIED);
      let resolveProgress!: (value: { step: 'credentials' }) => void;
      gsdMock.wizard.getProgress.mockReturnValue(
        new Promise((resolve) => {
          resolveProgress = resolve;
        }),
      );

      render(<FirstRunWizard />);
      // The mount-time synchronous pass must not have persisted anything yet —
      // resume hasn't settled, so writing here could race the pending read.
      expect(gsdMock.wizard.saveProgress).not.toHaveBeenCalled();

      resolveProgress({ step: 'credentials' });

      await waitFor(() => expect(gsdMock.wizard.saveProgress).toHaveBeenCalledWith({ step: 'credentials' }));
    });
  });
});
