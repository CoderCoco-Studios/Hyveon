import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { GUIDED_PROFILE_NAME, type AwsProfileSummary } from '@hyveon/desktop-preload';
import { toStreamHandleMock } from '../../test-utils/stream-handle.test-utils.js';

// Stubs the real `GuidedIamStep` (its own multi-phase flow is covered by
// `guided-iam-step.component.test.tsx`) with a minimal component exposing
// its `onComplete`/`onSkipToManual` callbacks as buttons — this file only
// needs to verify the shell wires them correctly (advancing `stepIndex`,
// re-deriving the credentials step's satisfied prop), not re-drive the
// guided-provisioning flow itself.
vi.mock('./guided-iam-step.component.js', () => ({
  GuidedIamStep: ({ onComplete, onSkipToManual }: { onComplete: () => void; onSkipToManual: () => void }) => (
    <div>
      <span>guided-iam-step-stub</span>
      <button type="button" onClick={onComplete}>
        stub-complete
      </button>
      <button type="button" onClick={onSkipToManual}>
        stub-skip
      </button>
    </div>
  ),
}));

const hyveonMock = {
  wizard: {
    getState: vi.fn(),
    saveState: vi.fn(),
    listAwsProfiles: vi.fn(),
    saveCredentials: vi.fn(),
    bootstrapStateBucket: vi.fn(),
    bootstrapConfigurationBucket: vi.fn(),
    bootstrapDeploymentConfig: vi.fn(),
    bootstrapRunsTable: vi.fn(),
    simulateIamPermissions: vi.fn(),
    getProgress: vi.fn(),
    saveProgress: vi.fn(),
    complete: vi.fn(),
    reset: vi.fn(),
    // Guided-IAM step (Group 7, Task 4): only exercised by tests that don't
    // click straight through via "I already have credentials" — the shared
    // `advanceToCredentials()` helper below skips guided provisioning
    // entirely, so most describe blocks never call these.
    guidedIamPrepareTemplate: vi.fn(),
    guidedIamOpenConsole: vi.fn(),
    guidedIamSubmitBootstrapKey: vi.fn(),
    guidedIamRotate: vi.fn(),
    guidedIamRevokeBootstrapKey: vi.fn(),
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
  // Defaulted (not just reset): runBootstrap() chains this call onto a
  // successful `bootstrapConfigurationBucket` resolution, but it never gates
  // `bootstrapComplete`/"Next" — an unmocked resolution to `undefined` would
  // otherwise throw reading `.status` off it in every test that clicks
  // "Bootstrap AWS resources" with the configuration bucket succeeding,
  // regardless of whether that test cares about the initial-configuration
  // seed at all.
  hyveonMock.wizard.bootstrapDeploymentConfig.mockReset().mockResolvedValue({ status: 'created' });
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
  hyveonMock.wizard.reset.mockReset().mockResolvedValue({ wizardCompleted: false });
  // Defaulted (not just reset): the shell's `refreshGuidedCredentials`
  // effect calls this on every mount to decide the credentials step's
  // `satisfiedByGuidedProvisioning` prop — an unmocked call would otherwise
  // throw reading `.aws` off `undefined`. No test in this file's default
  // path has a guided profile on record, so the normal credentials form
  // renders unless a test overrides this.
  hyveonMock.wizard.getState.mockReset().mockResolvedValue({ wizardCompleted: false });
  hyveonMock.wizard.guidedIamPrepareTemplate.mockReset();
  hyveonMock.wizard.guidedIamOpenConsole.mockReset();
  hyveonMock.wizard.guidedIamSubmitBootstrapKey.mockReset();
  hyveonMock.wizard.guidedIamRotate.mockReset();
  hyveonMock.wizard.guidedIamRevokeBootstrapKey.mockReset();
  hyveonMock.iac.stack.initialize.mockReset();
});

/** Renders the wizard, which starts directly on the pick-cloud step (the first step now that prerequisites was removed). */
async function advanceToPickCloud(): Promise<void> {
  render(<FirstRunWizard />);
  await screen.findByText(/choose the cloud provider/i);
}

/**
 * Advances the wizard from pick-cloud to the credentials step, passing
 * through the guided-IAM step in between (#Group 7, Task 4) via the stubbed
 * `GuidedIamStep`'s `onSkipToManual` button ("I already have credentials",
 * in the real component) — the guided-provisioning path itself has its own
 * dedicated `guided-iam-step.component.test.tsx`, and this file's own
 * "guided-iam step wiring" describe block below exercises the real
 * `onComplete`/`onSkipToManual` wiring directly; every other describe block
 * only cares about what happens from the credentials step onward, so
 * skipping straight past the stub here keeps those tests focused on their
 * own step.
 */
async function advanceToCredentials(): Promise<void> {
  hyveonMock.wizard.saveState.mockResolvedValue({ wizardCompleted: false, activeCloud: 'aws' });
  await advanceToPickCloud();
  await userEvent.click(screen.getByRole('button', { name: /^next$/i }));
  await screen.findByText(/provision aws access/i, { selector: 'p' });
  await userEvent.click(screen.getByRole('button', { name: /stub-skip/i }));
  await screen.findByText(/choose the aws credentials/i);
}

/** Advances the wizard from pick-cloud and credentials (profile path) to the bootstrap step. */
async function advanceToBootstrap(): Promise<void> {
  hyveonMock.wizard.saveState.mockResolvedValue({ wizardCompleted: false, aws: { profile: 'default', region: 'us-east-1' } });
  await advanceToCredentials();
  const select = await screen.findByLabelText('Profile');
  await userEvent.selectOptions(select, 'default');
  await userEvent.click(screen.getByRole('button', { name: /^next$/i }));
  await screen.findByLabelText('State bucket name');
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

  it('should render the step-progress sidebar in first-run mode', async () => {
    await advanceToPickCloud();

    expect(screen.getByRole('navigation', { name: 'Wizard progress' })).toBeInTheDocument();
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
      expect(hyveonMock.wizard.bootstrapConfigurationBucket).toHaveBeenCalledWith({ bucketName: 'hyveon-config' });
      // No `wizard.bootstrap.lockTable` channel exists, and this wizard has
      // no client method for it either — there is nothing left to assert
      // was "not called" here beyond the two real calls above.
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

    describe('initial configuration seed (fresh-install-bricking fix)', () => {
      it('should call wizard.bootstrap.deploymentConfig with the configuration bucket name once the configuration bucket succeeds', async () => {
        hyveonMock.wizard.bootstrapStateBucket.mockResolvedValue({ status: 'created' });
        hyveonMock.wizard.bootstrapConfigurationBucket.mockResolvedValue({ status: 'created' });
        hyveonMock.wizard.bootstrapDeploymentConfig.mockResolvedValue({ status: 'created' });
        await advanceToBootstrap();

        await userEvent.click(screen.getByRole('button', { name: /bootstrap aws resources/i }));

        await waitFor(() =>
          expect(hyveonMock.wizard.bootstrapDeploymentConfig).toHaveBeenCalledWith({ bucketName: 'hyveon-config' }),
        );
        expect(await screen.findByText('Initial configuration')).toBeInTheDocument();
      });

      it('should not call wizard.bootstrap.deploymentConfig and should report it failed when the configuration bucket itself fails', async () => {
        hyveonMock.wizard.bootstrapStateBucket.mockResolvedValue({ status: 'created' });
        hyveonMock.wizard.bootstrapConfigurationBucket.mockResolvedValue({ status: 'failed', message: 'bucket taken' });
        await advanceToBootstrap();

        await userEvent.click(screen.getByRole('button', { name: /bootstrap aws resources/i }));

        await screen.findByText('bucket taken');
        expect(hyveonMock.wizard.bootstrapDeploymentConfig).not.toHaveBeenCalled();
        expect(
          await screen.findByText(
            'The configuration bucket must be created before its initial configuration can be seeded.',
          ),
        ).toBeInTheDocument();
      });

      it('should not block Next when the initial configuration seed fails — only the two buckets gate progression', async () => {
        hyveonMock.wizard.bootstrapStateBucket.mockResolvedValue({ status: 'created' });
        hyveonMock.wizard.bootstrapConfigurationBucket.mockResolvedValue({ status: 'created' });
        hyveonMock.wizard.bootstrapDeploymentConfig.mockRejectedValue(new Error('AccessDenied seeding configuration'));
        await advanceToBootstrap();

        await userEvent.click(screen.getByRole('button', { name: /bootstrap aws resources/i }));

        expect(await screen.findByText('AccessDenied seeding configuration')).toBeInTheDocument();
        await waitFor(() => expect(screen.getByRole('button', { name: /^next$/i })).toBeEnabled());
      });
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
          bootstrap: { stateBucket: 'hyveon-tfstate', configurationBucket: 'hyveon-config' },
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
      await screen.findByText(/provision aws access/i, { selector: 'p' });
      await userEvent.click(screen.getByRole('button', { name: /stub-skip/i }));
      await screen.findByText(/choose the aws credentials/i);
      await userEvent.selectOptions(await screen.findByLabelText('Profile'), 'default');
      await userEvent.click(screen.getByRole('button', { name: /^next$/i }));
      await screen.findByLabelText('State bucket name');
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

      expect(await screen.findByLabelText('State bucket name')).toBeInTheDocument();
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

    it('should preserve a resumed guided-iam sub-state in its own save-on-change call, rather than wiping it back to undefined', async () => {
      // Regression test (final-review Finding 1): the shell's save-on-change
      // effect used to fire `saveProgress({ step })` with NO `guidedIam`
      // field the instant the resume-on-mount jump landed on `guided-iam`,
      // silently dropping whatever sub-state was on disk. The CURRENT
      // session still resumed correctly (this component already received
      // the real sub-state via `initialProgress` before the effect ran),
      // but a second relaunch with no further action taken would then land
      // back on a fresh region screen instead of resuming again.
      hyveonMock.wizard.getProgress.mockResolvedValue({
        step: 'guided-iam',
        guidedIam: { subState: 'rotation-pending', hasBootstrapKey: true },
      });

      render(<FirstRunWizard />);

      await screen.findByText('guided-iam-step-stub');
      await waitFor(() =>
        expect(hyveonMock.wizard.saveProgress).toHaveBeenCalledWith({
          step: 'guided-iam',
          guidedIam: { subState: 'rotation-pending', hasBootstrapKey: true },
        }),
      );
    });
  });

  describe('guided-iam step wiring', () => {
    it('should render GuidedIamStep after pick-cloud, hiding the shared Next button', async () => {
      await advanceToPickCloud();

      await userEvent.click(screen.getByRole('button', { name: /^next$/i }));

      expect(await screen.findByText('guided-iam-step-stub')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /^next$/i })).not.toBeInTheDocument();
    });

    it('should advance to the normal credentials form when GuidedIamStep calls onSkipToManual', async () => {
      await advanceToPickCloud();
      await userEvent.click(screen.getByRole('button', { name: /^next$/i }));
      await screen.findByText('guided-iam-step-stub');

      await userEvent.click(screen.getByRole('button', { name: /stub-skip/i }));

      expect(await screen.findByText(/choose the aws credentials/i)).toBeInTheDocument();
    });

    it('should not resurrect a stale guided-iam sub-state on the save effect after Back navigation past the step', async () => {
      // Regression test: a mount-time guided-iam sub-state used to stay in
      // `guidedIamInitialProgress` forever, even after the step's own exit
      // handlers fired — so re-entering `guided-iam` via Back re-ran the
      // save-on-change effect with that stale value, overwriting whatever
      // GuidedIamStep itself had persisted since.
      hyveonMock.wizard.getProgress.mockResolvedValue({
        step: 'guided-iam',
        guidedIam: { subState: 'awaiting-key-intake', hasBootstrapKey: false },
      });
      render(<FirstRunWizard />);
      await screen.findByText('guided-iam-step-stub');
      await waitFor(() =>
        expect(hyveonMock.wizard.saveProgress).toHaveBeenCalledWith({
          step: 'guided-iam',
          guidedIam: { subState: 'awaiting-key-intake', hasBootstrapKey: false },
        }),
      );

      await userEvent.click(screen.getByRole('button', { name: /stub-skip/i }));
      await screen.findByText(/choose the aws credentials/i);
      hyveonMock.wizard.saveProgress.mockClear();

      await userEvent.click(screen.getByRole('button', { name: /back/i }));

      await screen.findByText('guided-iam-step-stub');
      await waitFor(() => expect(hyveonMock.wizard.saveProgress).toHaveBeenCalledWith({ step: 'guided-iam' }));
      expect(hyveonMock.wizard.saveProgress).not.toHaveBeenCalledWith(
        expect.objectContaining({ guidedIam: expect.anything() }),
      );
    });

    it("should render the credentials step's satisfied summary when GuidedIamStep calls onComplete with a guided profile on record", async () => {
      hyveonMock.wizard.getState.mockResolvedValue({
        wizardCompleted: false,
        aws: { profile: GUIDED_PROFILE_NAME, region: 'us-east-1' },
      });
      await advanceToPickCloud();
      await userEvent.click(screen.getByRole('button', { name: /^next$/i }));
      await screen.findByText('guided-iam-step-stub');

      await userEvent.click(screen.getByRole('button', { name: /stub-complete/i }));

      expect(await screen.findByText(/already provisioned and activated aws credentials/i)).toBeInTheDocument();
      expect(screen.getByText(/AWS account \(guided setup\)/)).toBeInTheDocument();
      expect(screen.getByText(/us-east-1/)).toBeInTheDocument();
      expect(screen.queryByLabelText('Profile')).not.toBeInTheDocument();
    });

    it('should fall through to the normal form — never a dead end — when "Switch to a different source" is clicked', async () => {
      hyveonMock.wizard.getState.mockResolvedValue({
        wizardCompleted: false,
        aws: { profile: GUIDED_PROFILE_NAME, region: 'us-east-1' },
      });
      await advanceToPickCloud();
      await userEvent.click(screen.getByRole('button', { name: /^next$/i }));
      await screen.findByText('guided-iam-step-stub');
      await userEvent.click(screen.getByRole('button', { name: /stub-complete/i }));
      await screen.findByText(/already provisioned/i);

      await userEvent.click(screen.getByRole('button', { name: /switch to a different source/i }));

      expect(await screen.findByText(/choose the aws credentials/i)).toBeInTheDocument();
      expect(screen.queryByText(/already provisioned/i)).not.toBeInTheDocument();
    });
  });

  describe('reconfigure mode — guided-iam pre-completion', () => {
    it('should NOT pre-complete guided-iam without evidence of guided provisioning', async () => {
      hyveonMock.wizard.getState.mockResolvedValue({
        wizardCompleted: true,
        activeCloud: 'aws',
        aws: { profile: 'default', region: 'us-east-1' },
      });
      render(<FirstRunWizard mode="reconfigure" />);
      await screen.findByText(/choose your cloud is already configured/i);
      await waitFor(() => expect(hyveonMock.wizard.getState).toHaveBeenCalled());

      await userEvent.click(screen.getByRole('button', { name: /^next$/i }));

      expect(await screen.findByText('guided-iam-step-stub')).toBeInTheDocument();
    });

    it("should pre-complete guided-iam when wizard.state.get's aws.profile is the guided profile", async () => {
      hyveonMock.wizard.getState.mockResolvedValue({
        wizardCompleted: true,
        activeCloud: 'aws',
        aws: { profile: GUIDED_PROFILE_NAME, region: 'us-east-1' },
      });
      render(<FirstRunWizard mode="reconfigure" />);
      await screen.findByText(/choose your cloud is already configured/i);
      await waitFor(() => expect(hyveonMock.wizard.getState).toHaveBeenCalled());

      await userEvent.click(screen.getByRole('button', { name: /^next$/i }));

      expect(await screen.findByText(/provision aws access is already configured/i)).toBeInTheDocument();
    });
  });

  describe('reconfigure mode — layout', () => {
    it('should not render the step-progress sidebar in reconfigure mode', async () => {
      hyveonMock.wizard.getState.mockResolvedValue({
        wizardCompleted: true,
        activeCloud: 'aws',
        aws: { profile: 'default', region: 'us-east-1' },
      });
      render(<FirstRunWizard mode="reconfigure" />);
      await screen.findByText(/choose your cloud is already configured/i);

      expect(screen.queryByRole('navigation', { name: 'Wizard progress' })).not.toBeInTheDocument();
    });
  });

  describe('start over', () => {
    it('should render a "Start over" action in first-run mode', async () => {
      await advanceToPickCloud();

      expect(screen.getByRole('button', { name: 'Start over' })).toBeInTheDocument();
    });

    it('should not render a "Start over" action in reconfigure mode, which has its own Cancel', async () => {
      hyveonMock.wizard.getState.mockResolvedValue({
        wizardCompleted: true,
        activeCloud: 'aws',
        aws: { profile: 'default', region: 'us-east-1' },
      });
      render(<FirstRunWizard mode="reconfigure" onCancel={vi.fn()} />);
      await screen.findByText(/choose your cloud is already configured/i);

      expect(screen.queryByRole('button', { name: 'Start over' })).not.toBeInTheDocument();
    });

    it('should call wizard.reset and reload the window once the operator confirms', async () => {
      // jsdom's `window.location.reload` isn't a configurable own property,
      // so `vi.spyOn` can't redefine it directly — replace `window.location`
      // itself with a stub carrying the same fields plus a mockable `reload`.
      const originalLocation = window.location;
      const reloadSpy = vi.fn();
      Object.defineProperty(window, 'location', {
        configurable: true,
        value: { ...originalLocation, reload: reloadSpy },
      });
      const user = userEvent.setup();
      await advanceToPickCloud();

      await user.click(screen.getByRole('button', { name: 'Start over' }));
      const dialog = await screen.findByRole('alertdialog');
      await user.click(within(dialog).getByRole('button', { name: 'Start over' }));

      await waitFor(() => expect(hyveonMock.wizard.reset).toHaveBeenCalledTimes(1));
      expect(reloadSpy).toHaveBeenCalledTimes(1);
      Object.defineProperty(window, 'location', { configurable: true, value: originalLocation });
    });

    it('should not call wizard.reset when the operator cancels the confirm dialog', async () => {
      const user = userEvent.setup();
      await advanceToPickCloud();

      await user.click(screen.getByRole('button', { name: 'Start over' }));
      const dialog = await screen.findByRole('alertdialog');
      await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));

      expect(hyveonMock.wizard.reset).not.toHaveBeenCalled();
    });
  });
});
