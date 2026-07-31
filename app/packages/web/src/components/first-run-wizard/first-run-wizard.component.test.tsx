import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AwsProfileSummary } from '@hyveon/desktop-preload';
import { toStreamHandleMock } from '../../test-utils/stream-handle.test-utils.js';

const hyveonMock = {
  wizard: {
    saveState: vi.fn(),
    listAwsProfiles: vi.fn(),
    saveCredentials: vi.fn(),
    bootstrapStateBucket: vi.fn(),
    bootstrapConfigurationBucket: vi.fn(),
    bootstrapRunsTable: vi.fn(),
    simulateIamPermissions: vi.fn(),
    getProgress: vi.fn(),
    saveProgress: vi.fn(),
    complete: vi.fn(),
  },
  iac: {
    stack: {
      initialize: vi.fn(),
    },
  },
};
vi.stubGlobal('hyveon', hyveonMock);

import { FirstRunWizard } from './first-run-wizard.component.js';

const SAMPLE_PROFILES: AwsProfileSummary[] = [
  { profileName: 'default', region: 'us-east-1' },
  { profileName: 'personal' },
];

beforeEach(() => {
  // Defaulted (not just reset): the bootstrap step's fire-and-forget
  // `wizard.state.save({ bootstrap })` call (see `goNext`) uses a bare
  // `.catch()`, not an awaited try/catch, so an unmocked call (returning
  // `undefined`) would throw synchronously. Individual tests still override
  // this with a more specific resolved value where the response shape matters.
  hyveonMock.wizard.saveState.mockReset().mockResolvedValue({ wizardCompleted: false });
  hyveonMock.wizard.listAwsProfiles.mockReset().mockResolvedValue(SAMPLE_PROFILES);
  hyveonMock.wizard.saveCredentials.mockReset();
  hyveonMock.wizard.bootstrapStateBucket.mockReset();
  hyveonMock.wizard.bootstrapConfigurationBucket.mockReset();
  // Defaulted (not just reset): runBootstrap() fires this alongside the two
  // bucket calls, but it never gates `bootstrapComplete`/"Next" — an
  // unmocked resolution to `undefined` would otherwise throw reading
  // `.status` off it in every test that reaches the bootstrap step,
  // regardless of whether that test cares about the runs table at all.
  hyveonMock.wizard.bootstrapRunsTable.mockReset().mockResolvedValue({ status: 'created' });
  hyveonMock.wizard.simulateIamPermissions.mockReset();
  // Defaulted (not just reset) so the shell's resume-on-mount/per-step-save
  // effects — present on every render regardless of which step a test cares
  // about — never throw on an unmocked call.
  hyveonMock.wizard.getProgress.mockReset().mockResolvedValue({ step: 'pick-cloud' });
  hyveonMock.wizard.saveProgress.mockReset().mockResolvedValue(undefined);
  hyveonMock.wizard.complete.mockReset();
  hyveonMock.iac.stack.initialize.mockReset();
});

/** Renders the wizard, which starts directly on the pick-cloud step (the first step now that prerequisites was removed). */
async function advanceToPickCloud(): Promise<void> {
  render(<FirstRunWizard />);
  await screen.findByText(/choose the cloud provider/i);
}

/** Advances the wizard from pick-cloud to the credentials step. */
async function advanceToCredentials(): Promise<void> {
  hyveonMock.wizard.saveState.mockResolvedValue({ wizardCompleted: false, activeCloud: 'aws' });
  await advanceToPickCloud();
  await userEvent.click(screen.getByRole('button', { name: /^next$/i }));
  await screen.findByText(/choose the aws credentials/i);
}

/** Advances the wizard from pick-cloud and credentials (profile path) to the bootstrap step. */
async function advanceToBootstrap(): Promise<void> {
  hyveonMock.wizard.saveState.mockResolvedValue({ wizardCompleted: false, aws: { profile: 'default', region: 'us-east-1' } });
  await advanceToCredentials();
  const select = await screen.findByLabelText('Profile');
  await userEvent.selectOptions(select, 'default');
  await userEvent.click(screen.getByRole('button', { name: /^next$/i }));
  await screen.findByLabelText('Terraform state bucket name');
}

/** Advances the wizard all the way to the stack-init step, with both bootstrap resources succeeding. */
async function advanceToStackInit(): Promise<void> {
  hyveonMock.wizard.bootstrapStateBucket.mockResolvedValue({ status: 'created' });
  hyveonMock.wizard.bootstrapConfigurationBucket.mockResolvedValue({ status: 'created' });
  hyveonMock.iac.stack.initialize.mockImplementation(
    toStreamHandleMock(async function* () {
      // No phase events needed by default — individual tests override this.
    }),
  );
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
  it('should disable Back on the first step', async () => {
    render(<FirstRunWizard />);
    await screen.findByText(/choose the cloud provider/i);

    expect(screen.getByRole('button', { name: /back/i })).toBeDisabled();
  });

  it('should render the pick-cloud step as the first step', async () => {
    await advanceToPickCloud();
    expect(screen.getByRole('radio', { name: /Amazon Web Services/i })).toBeInTheDocument();
  });

  it('should persist the selected cloud via wizard.state.save when advancing past pick-cloud', async () => {
    hyveonMock.wizard.saveState.mockResolvedValue({ wizardCompleted: false, activeCloud: 'aws' });
    await advanceToPickCloud();

    await userEvent.click(screen.getByRole('button', { name: /^next$/i }));

    await waitFor(() => expect(hyveonMock.wizard.saveState).toHaveBeenCalledWith({ activeCloud: 'aws' }));
  });

  it('should show an error and stay on pick-cloud when saving the cloud choice fails', async () => {
    hyveonMock.wizard.saveState.mockRejectedValue(new Error('disk full'));
    await advanceToPickCloud();

    await userEvent.click(screen.getByRole('button', { name: /^next$/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('disk full');
    // Still on pick-cloud, not advanced further.
    expect(screen.getByRole('radio', { name: /Amazon Web Services/i })).toBeInTheDocument();
  });

  it('should disable Back while the cloud choice save is pending, to avoid a race with the step transition', async () => {
    let resolveSave!: (value: { wizardCompleted: boolean; activeCloud: 'aws' }) => void;
    hyveonMock.wizard.saveState.mockReturnValue(
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

      await waitFor(() => expect(hyveonMock.wizard.listAwsProfiles).toHaveBeenCalledTimes(1));
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
      hyveonMock.wizard.saveState.mockResolvedValue({ wizardCompleted: false, aws: { profile: 'default', region: 'us-east-1' } });
      await advanceToCredentials();
      const select = await screen.findByLabelText('Profile');
      await userEvent.selectOptions(select, 'default');

      await userEvent.click(screen.getByRole('button', { name: /^next$/i }));

      await waitFor(() =>
        expect(hyveonMock.wizard.saveState).toHaveBeenCalledWith({ aws: { profile: 'default', region: 'us-east-1' } }),
      );
    });

    it('should persist an operator-overridden region instead of the profile default', async () => {
      hyveonMock.wizard.saveState.mockResolvedValue({ wizardCompleted: false, aws: { profile: 'default', region: 'eu-west-1' } });
      await advanceToCredentials();
      const select = await screen.findByLabelText('Profile');
      await userEvent.selectOptions(select, 'default');
      const regionInput = screen.getByLabelText('Region');
      await userEvent.clear(regionInput);
      await userEvent.type(regionInput, 'eu-west-1');

      await userEvent.click(screen.getByRole('button', { name: /^next$/i }));

      await waitFor(() =>
        expect(hyveonMock.wizard.saveState).toHaveBeenCalledWith({ aws: { profile: 'default', region: 'eu-west-1' } }),
      );
    });

    it('should switch to the paste form and save pasted credentials via wizard.aws.saveCredentials', async () => {
      hyveonMock.wizard.saveCredentials.mockResolvedValue({ profileName: 'hyveon-pasted' });
      await advanceToCredentials();

      await userEvent.click(screen.getByRole('button', { name: /paste keys instead/i }));
      await userEvent.type(screen.getByLabelText('Access key ID'), 'AKID');
      await userEvent.type(screen.getByLabelText('Secret access key'), 'SECRET');
      await userEvent.type(screen.getByLabelText('Region'), 'us-west-2');
      await userEvent.click(screen.getByRole('button', { name: /save credentials/i }));

      await waitFor(() =>
        expect(hyveonMock.wizard.saveCredentials).toHaveBeenCalledWith({
          accessKeyId: 'AKID',
          secretAccessKey: 'SECRET',
          region: 'us-west-2',
        }),
      );
      expect(await screen.findByText(/saved as profile "hyveon-pasted"/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^next$/i })).toBeEnabled();
    });

    it('should keep Next disabled after a successful paste save when no region was entered', async () => {
      hyveonMock.wizard.saveCredentials.mockResolvedValue({ profileName: 'hyveon-pasted' });
      await advanceToCredentials();

      await userEvent.click(screen.getByRole('button', { name: /paste keys instead/i }));
      await userEvent.type(screen.getByLabelText('Access key ID'), 'AKID');
      await userEvent.type(screen.getByLabelText('Secret access key'), 'SECRET');
      await userEvent.click(screen.getByRole('button', { name: /save credentials/i }));

      expect(await screen.findByText(/saved as profile "hyveon-pasted"/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^next$/i })).toBeDisabled();
    });

    it('should invalidate a successful paste save when a field is edited afterward, disabling Next again', async () => {
      hyveonMock.wizard.saveCredentials.mockResolvedValue({ profileName: 'hyveon-pasted' });
      await advanceToCredentials();

      await userEvent.click(screen.getByRole('button', { name: /paste keys instead/i }));
      await userEvent.type(screen.getByLabelText('Access key ID'), 'AKID');
      await userEvent.type(screen.getByLabelText('Secret access key'), 'SECRET');
      await userEvent.click(screen.getByRole('button', { name: /save credentials/i }));
      await screen.findByText(/saved as profile "hyveon-pasted"/i);

      await userEvent.type(screen.getByLabelText('Secret access key'), '2');

      expect(screen.queryByText(/saved as profile/i)).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^next$/i })).toBeDisabled();
    });

    it('should show a paste error and keep Next disabled when saveCredentials fails', async () => {
      hyveonMock.wizard.saveCredentials.mockRejectedValue(new Error('OS keychain unavailable'));
      await advanceToCredentials();

      await userEvent.click(screen.getByRole('button', { name: /paste keys instead/i }));
      await userEvent.type(screen.getByLabelText('Access key ID'), 'AKID');
      await userEvent.type(screen.getByLabelText('Secret access key'), 'SECRET');
      await userEvent.click(screen.getByRole('button', { name: /save credentials/i }));

      expect(await screen.findByRole('alert')).toHaveTextContent('OS keychain unavailable');
      expect(screen.getByRole('button', { name: /^next$/i })).toBeDisabled();
    });

    it('should persist the pasted profile via wizard.state.save when advancing after a successful paste', async () => {
      hyveonMock.wizard.saveCredentials.mockResolvedValue({ profileName: 'hyveon-pasted' });
      hyveonMock.wizard.saveState.mockResolvedValue({ wizardCompleted: false, aws: { profile: 'hyveon-pasted', region: 'us-west-2' } });
      await advanceToCredentials();

      await userEvent.click(screen.getByRole('button', { name: /paste keys instead/i }));
      await userEvent.type(screen.getByLabelText('Access key ID'), 'AKID');
      await userEvent.type(screen.getByLabelText('Secret access key'), 'SECRET');
      await userEvent.type(screen.getByLabelText('Region'), 'us-west-2');
      await userEvent.click(screen.getByRole('button', { name: /save credentials/i }));
      await screen.findByText(/saved as profile/i);

      await userEvent.click(screen.getByRole('button', { name: /^next$/i }));

      await waitFor(() =>
        expect(hyveonMock.wizard.saveState).toHaveBeenCalledWith({ aws: { profile: 'hyveon-pasted', region: 'us-west-2' } }),
      );
    });
  });

  describe('bootstrap step', () => {
    it('should disable Next until both resources are created or already exist', async () => {
      await advanceToBootstrap();

      expect(screen.getByRole('button', { name: /^next$/i })).toBeDisabled();
    });

    it('should call both bootstrap IPC methods with the current resource names when the bootstrap button is clicked, and never call the removed lock-table channel', async () => {
      hyveonMock.wizard.bootstrapStateBucket.mockResolvedValue({ status: 'created' });
      hyveonMock.wizard.bootstrapConfigurationBucket.mockResolvedValue({ status: 'created' });
      await advanceToBootstrap();

      await userEvent.click(screen.getByRole('button', { name: /bootstrap aws resources/i }));

      await waitFor(() =>
        expect(hyveonMock.wizard.bootstrapStateBucket).toHaveBeenCalledWith({ bucketName: 'hyveon-tfstate' }),
      );
      expect(hyveonMock.wizard.bootstrapConfigurationBucket).toHaveBeenCalledWith({ bucketName: 'hyveon-tfvars' });
      // No `wizard.bootstrap.lockTable` channel exists anymore (task 5.1
      // removed the main-process handler entirely) and this wizard has no
      // client method for it either (task 5.5) — there is nothing left to
      // assert was "not called" here beyond the two real calls above.
    });

    it('should call wizard.bootstrap.runsTable alongside the two bucket calls when the bootstrap button is clicked (bootstrap-deadlock fix)', async () => {
      hyveonMock.wizard.bootstrapStateBucket.mockResolvedValue({ status: 'created' });
      hyveonMock.wizard.bootstrapConfigurationBucket.mockResolvedValue({ status: 'created' });
      hyveonMock.wizard.bootstrapRunsTable.mockResolvedValue({ status: 'created' });
      await advanceToBootstrap();

      await userEvent.click(screen.getByRole('button', { name: /bootstrap aws resources/i }));

      await waitFor(() => expect(hyveonMock.wizard.bootstrapRunsTable).toHaveBeenCalledTimes(1));
      expect(await screen.findByText('Run-history table')).toBeInTheDocument();
    });

    it('should not block Next when the run-history table bootstrap fails — only the two buckets gate progression', async () => {
      hyveonMock.wizard.bootstrapStateBucket.mockResolvedValue({ status: 'created' });
      hyveonMock.wizard.bootstrapConfigurationBucket.mockResolvedValue({ status: 'created' });
      hyveonMock.wizard.bootstrapRunsTable.mockRejectedValue(new Error('AccessDenied creating table'));
      await advanceToBootstrap();

      await userEvent.click(screen.getByRole('button', { name: /bootstrap aws resources/i }));

      expect(await screen.findByText('AccessDenied creating table')).toBeInTheDocument();
      await waitFor(() => expect(screen.getByRole('button', { name: /^next$/i })).toBeEnabled());
    });

    it('should enable Next once both resources report created or exists', async () => {
      hyveonMock.wizard.bootstrapStateBucket.mockResolvedValue({ status: 'created' });
      hyveonMock.wizard.bootstrapConfigurationBucket.mockResolvedValue({ status: 'created' });
      await advanceToBootstrap();

      await userEvent.click(screen.getByRole('button', { name: /bootstrap aws resources/i }));

      await waitFor(() => expect(screen.getByRole('button', { name: /^next$/i })).toBeEnabled());
    });

    it('should independently report each resource\'s outcome when only one bootstrap call fails, never masking the other\'s success', async () => {
      hyveonMock.wizard.bootstrapStateBucket.mockResolvedValue({ status: 'failed', message: 'bucket taken' });
      hyveonMock.wizard.bootstrapConfigurationBucket.mockResolvedValue({ status: 'created' });
      await advanceToBootstrap();

      await userEvent.click(screen.getByRole('button', { name: /bootstrap aws resources/i }));

      // The failing resource: its failure message renders, and it gates Next.
      expect(await screen.findByText('bucket taken')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^next$/i })).toBeDisabled();
      // The succeeding sibling: reported fully and independently — its name
      // field locks in as succeeded and its public-access-block outcome
      // renders, unaffected by the other resource's failure. Exactly one
      // "Public access blocked" line renders (the failed resource gets none).
      expect(screen.getByLabelText('Configuration bucket name')).toBeDisabled();
      expect(screen.getAllByText('Public access blocked')).toHaveLength(1);
    });

    it('should run the IAM check via wizard.iam.simulate and render a passed result', async () => {
      hyveonMock.wizard.simulateIamPermissions.mockResolvedValue({ status: 'passed' });
      await advanceToBootstrap();

      await userEvent.click(screen.getByRole('button', { name: /check permissions/i }));

      expect(await screen.findByText(/all required permissions are present/i)).toBeInTheDocument();
    });

    it('should not block Next on a failed or missing IAM check — only the two bootstrap resources gate progression', async () => {
      hyveonMock.wizard.bootstrapStateBucket.mockResolvedValue({ status: 'created' });
      hyveonMock.wizard.bootstrapConfigurationBucket.mockResolvedValue({ status: 'created' });
      hyveonMock.wizard.simulateIamPermissions.mockResolvedValue({ status: 'missing', policyJson: '{}' });
      await advanceToBootstrap();

      await userEvent.click(screen.getByRole('button', { name: /bootstrap aws resources/i }));
      await waitFor(() => expect(screen.getByRole('button', { name: /^next$/i })).toBeEnabled());
      await userEvent.click(screen.getByRole('button', { name: /check permissions/i }));

      expect(await screen.findByText(/some permissions are missing/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^next$/i })).toBeEnabled();
    });

    it('should persist the current resource names via wizard.state.save when advancing past bootstrap', async () => {
      hyveonMock.wizard.bootstrapStateBucket.mockResolvedValue({ status: 'created' });
      hyveonMock.wizard.bootstrapConfigurationBucket.mockResolvedValue({ status: 'created' });
      hyveonMock.wizard.saveState.mockResolvedValue({ wizardCompleted: false });
      await advanceToBootstrap();
      await userEvent.click(screen.getByRole('button', { name: /bootstrap aws resources/i }));
      await waitFor(() => expect(screen.getByRole('button', { name: /^next$/i })).toBeEnabled());

      await userEvent.click(screen.getByRole('button', { name: /^next$/i }));

      await waitFor(() =>
        expect(hyveonMock.wizard.saveState).toHaveBeenCalledWith({
          bootstrap: { stateBucket: 'hyveon-tfstate', configurationBucket: 'hyveon-tfvars' },
        }),
      );
    });
  });

  describe('stack-init step', () => {
    it('should hide the shared Next button once on the stack-init step', async () => {
      await advanceToStackInit();

      expect(screen.queryByRole('button', { name: /^next$/i })).not.toBeInTheDocument();
    });

    it('should call wizard.complete and invoke onComplete when Finish setup succeeds', async () => {
      hyveonMock.iac.stack.initialize.mockImplementation(
        toStreamHandleMock(async function* () {
          yield { phase: 'engine', status: 'start' };
          yield { phase: 'engine', status: 'end' };
          yield { phase: 'plugins', status: 'start' };
          yield { phase: 'plugins', status: 'end' };
          yield { phase: 'operation', status: 'start' };
          yield { phase: 'operation', status: 'end' };
        }),
      );
      hyveonMock.wizard.complete.mockResolvedValue({ wizardCompleted: true });
      const onComplete = vi.fn();
      render(<FirstRunWizard onComplete={onComplete} />);
      await screen.findByText(/choose the cloud provider/i);
      await userEvent.click(screen.getByRole('button', { name: /^next$/i }));
      await screen.findByText(/choose the aws credentials/i);
      await userEvent.selectOptions(await screen.findByLabelText('Profile'), 'default');
      await userEvent.click(screen.getByRole('button', { name: /^next$/i }));
      await screen.findByLabelText('Terraform state bucket name');
      hyveonMock.wizard.bootstrapStateBucket.mockResolvedValue({ status: 'created' });
      hyveonMock.wizard.bootstrapConfigurationBucket.mockResolvedValue({ status: 'created' });
      await userEvent.click(screen.getByRole('button', { name: /bootstrap aws resources/i }));
      await waitFor(() => expect(screen.getByRole('button', { name: /^next$/i })).toBeEnabled());
      await userEvent.click(screen.getByRole('button', { name: /^next$/i }));
      await waitFor(() => expect(screen.getByRole('button', { name: /finish setup/i })).toBeEnabled());

      await userEvent.click(screen.getByRole('button', { name: /finish setup/i }));

      await waitFor(() => expect(hyveonMock.wizard.complete).toHaveBeenCalledTimes(1));
      expect(onComplete).toHaveBeenCalledTimes(1);
    });

    it('should persist each step via wizard.progress.save as the wizard advances', async () => {
      await advanceToBootstrap();

      await waitFor(() => expect(hyveonMock.wizard.saveProgress).toHaveBeenCalledWith({ step: 'bootstrap' }));
    });
  });

  describe('resume-on-mount', () => {
    it('should start at pick-cloud when wizard.progress.get resolves to the pick-cloud step', async () => {
      hyveonMock.wizard.getProgress.mockResolvedValue({ step: 'pick-cloud' });

      render(<FirstRunWizard />);

      expect(await screen.findByText(/choose the cloud provider/i)).toBeInTheDocument();
    });

    it('should jump straight to the recorded step when wizard.progress.get resolves to a later step', async () => {
      hyveonMock.wizard.listAwsProfiles.mockResolvedValue(SAMPLE_PROFILES);
      hyveonMock.wizard.getProgress.mockResolvedValue({ step: 'credentials' });

      render(<FirstRunWizard />);

      expect(await screen.findByText(/choose the aws credentials/i)).toBeInTheDocument();
    });

    it('should stay on pick-cloud when wizard.progress.get rejects', async () => {
      hyveonMock.wizard.getProgress.mockRejectedValue(new Error('state file corrupt'));

      render(<FirstRunWizard />);

      expect(await screen.findByText(/choose the cloud provider/i)).toBeInTheDocument();
    });

    it('should clamp a recorded stack-init step down to bootstrap, rather than auto-initializing the stack on mount', async () => {
      hyveonMock.wizard.getProgress.mockResolvedValue({ step: 'stack-init' });

      render(<FirstRunWizard />);

      expect(await screen.findByLabelText('Terraform state bucket name')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /finish setup/i })).not.toBeInTheDocument();
      expect(hyveonMock.iac.stack.initialize).not.toHaveBeenCalled();
    });

    it('should not save progress before the resume check has settled, so a fast render never clobbers a resumed step', async () => {
      let resolveProgress!: (value: { step: 'credentials' }) => void;
      hyveonMock.wizard.getProgress.mockReturnValue(
        new Promise((resolve) => {
          resolveProgress = resolve;
        }),
      );

      render(<FirstRunWizard />);
      // The mount-time synchronous pass must not have persisted anything yet —
      // resume hasn't settled, so writing here could race the pending read.
      expect(hyveonMock.wizard.saveProgress).not.toHaveBeenCalled();

      resolveProgress({ step: 'credentials' });

      await waitFor(() => expect(hyveonMock.wizard.saveProgress).toHaveBeenCalledWith({ step: 'credentials' }));
    });
  });
});
