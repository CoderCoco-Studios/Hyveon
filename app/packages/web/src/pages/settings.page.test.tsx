import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AwsProfileSummary } from '@hyveon/desktop-preload';
import { toStreamHandleMock } from '../test-utils/stream-handle.test-utils.js';

const apiMock = vi.hoisted(() => ({
  status: vi.fn(),
  costsEstimate: vi.fn(),
  config: vi.fn(),
  saveConfig: vi.fn(),
  diagnosticsTail: vi.fn(),
  diagnosticsLogPath: vi.fn(),
  cloudHealthList: vi.fn(),
  cloudHealthFix: vi.fn(),
}));
vi.mock('../api.service.js', () => ({ api: apiMock }));
vi.mock('../components/DiagnosticsPanel.js', () => ({
  DiagnosticsPanel: () => <div data-testid="diagnostics-panel">DiagnosticsPanel</div>,
}));

const hyveonMock = {
  wizard: {
    getState: vi.fn(),
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
    settings: {
      get: vi.fn(),
      update: vi.fn(),
      engineVersion: vi.fn(),
      autoUpdateGet: vi.fn(),
      autoUpdateUpdate: vi.fn(),
      autoUpdateCheck: vi.fn(),
    },
  },
};

/** Default top-level deployment settings the `DeploymentSettingsForm` loads on mount. */
const SAMPLE_DEPLOYMENT_SETTINGS = {
  projectName: 'hyveon',
  awsRegion: 'us-east-1',
  vpcCidr: '10.0.0.0/16',
  hostedZoneName: 'example.com',
  dnsTtl: 30,
  watchdogIntervalMinutes: 15,
  watchdogIdleChecks: 4,
  watchdogMinPackets: 100,
  baseAllowedGuilds: [],
  baseAdminUserIds: [],
  baseAdminRoleIds: [],
  discordApplicationId: '',
  auditTableName: '',
  runsTableName: '',
};
vi.stubGlobal('hyveon', hyveonMock);

import { SettingsPage } from './settings.page.js';
import { renderPage } from '../test-utils/render-page.utils.js';

/** A single discovered `~/.aws` profile matching the stored Reconfigure state below. */
const SAMPLE_PROFILES: AwsProfileSummary[] = [{ profileName: 'default', region: 'us-east-1' }];

describe('SettingsPage', () => {
  beforeEach(() => {
    apiMock.status.mockResolvedValue([]);
    apiMock.costsEstimate.mockResolvedValue({ games: {}, totalPerHourIfAllOn: 0 });
    apiMock.config.mockResolvedValue({
      watchdog_interval_minutes: 15,
      watchdog_idle_checks: 4,
      watchdog_min_packets: 100,
    });
    hyveonMock.wizard.getState
      .mockReset()
      .mockResolvedValue({ wizardCompleted: true, activeCloud: 'aws', aws: { profile: 'default', region: 'us-east-1' } });
    hyveonMock.wizard.saveState.mockReset().mockResolvedValue({ wizardCompleted: true });
    hyveonMock.wizard.listAwsProfiles.mockReset().mockResolvedValue(SAMPLE_PROFILES);
    hyveonMock.wizard.saveCredentials.mockReset();
    hyveonMock.wizard.bootstrapStateBucket.mockReset().mockResolvedValue({ status: 'exists' });
    hyveonMock.wizard.bootstrapConfigurationBucket.mockReset().mockResolvedValue({ status: 'exists' });
    hyveonMock.wizard.bootstrapRunsTable.mockReset().mockResolvedValue({ status: 'exists' });
    hyveonMock.wizard.simulateIamPermissions.mockReset();
    hyveonMock.wizard.getProgress.mockReset().mockResolvedValue({ step: 'pick-cloud' });
    hyveonMock.wizard.saveProgress.mockReset().mockResolvedValue(undefined);
    hyveonMock.wizard.complete.mockReset().mockResolvedValue({ wizardCompleted: true });
    hyveonMock.iac.stack.initialize.mockReset().mockImplementation(
      toStreamHandleMock(async function* () {
        // No phase events needed by default — the Reconfigure tests below just need it to succeed.
      }),
    );
    hyveonMock.iac.settings.get
      .mockReset()
      .mockResolvedValue({ ok: true, settings: SAMPLE_DEPLOYMENT_SETTINGS, etag: 'etag-1' });
    hyveonMock.iac.settings.update.mockReset();
    hyveonMock.iac.settings.engineVersion.mockReset().mockResolvedValue({ resolvedVersion: '3.255.0' });
    hyveonMock.iac.settings.autoUpdateGet.mockReset().mockResolvedValue({ ok: true, enableAutoUpdate: false });
    hyveonMock.iac.settings.autoUpdateUpdate.mockReset();
    hyveonMock.iac.settings.autoUpdateCheck.mockReset();
    apiMock.cloudHealthList.mockResolvedValue([{ id: 'ecs-service-linked-role', label: 'ECS service-linked role', status: 'ok' }]);
  });

  it('should render the Settings heading', () => {
    renderPage(<SettingsPage />, { initialEntries: ['/settings'] });
    expect(screen.getByRole('heading', { name: 'Settings' })).toBeInTheDocument();
  });

  it('should render the Watchdog Configuration section', () => {
    renderPage(<SettingsPage />, { initialEntries: ['/settings'] });
    expect(screen.getByRole('heading', { name: 'Watchdog Configuration' })).toBeInTheDocument();
  });

  it('should render the polling indicator once the status poll resolves', async () => {
    renderPage(<SettingsPage />, { initialEntries: ['/settings'] });
    expect(await screen.findByText(/^Updated\b/)).toBeInTheDocument();
  });

  it('should render the General section heading with the deployment-settings form loaded', async () => {
    renderPage(<SettingsPage />, { initialEntries: ['/settings'] });
    expect(screen.getByRole('heading', { name: 'General' })).toBeInTheDocument();
    expect(await screen.findByLabelText('Hosted zone name')).toHaveValue('example.com');
  });

  it('should render the Diagnostics section heading', () => {
    renderPage(<SettingsPage />, { initialEntries: ['/settings'] });
    expect(screen.getByRole('heading', { name: 'Diagnostics' })).toBeInTheDocument();
  });

  it('should render the DiagnosticsPanel inside the Diagnostics section', () => {
    renderPage(<SettingsPage />, { initialEntries: ['/settings'] });
    expect(screen.getByTestId('diagnostics-panel')).toBeInTheDocument();
  });

  describe('Cloud Setup — Pulumi engine version row', () => {
    it('should render the resolved engine version and the pinned version once the read resolves', async () => {
      hyveonMock.iac.settings.engineVersion.mockResolvedValue({ resolvedVersion: '3.255.0' });
      renderPage(<SettingsPage />, { initialEntries: ['/settings'] });

      expect(await screen.findByText('Pulumi engine v3.255.0 · pinned to v3.255.0')).toBeInTheDocument();
    });

    it('should render a distinct "not yet provisioned" state, alongside the pinned version, when resolvedVersion is null', async () => {
      hyveonMock.iac.settings.engineVersion.mockResolvedValue({ resolvedVersion: null });
      renderPage(<SettingsPage />, { initialEntries: ['/settings'] });

      expect(await screen.findByText('Not yet provisioned · pinned to v3.255.0')).toBeInTheDocument();
    });

    it('should render a distinct error state, not the "not yet provisioned" copy, when the engineVersion read rejects', async () => {
      hyveonMock.iac.settings.engineVersion.mockRejectedValue(new Error('IPC unavailable'));
      renderPage(<SettingsPage />, { initialEntries: ['/settings'] });

      expect(await screen.findByText('Unable to determine engine version · pinned to v3.255.0')).toBeInTheDocument();
      expect(screen.queryByText(/not yet provisioned/i)).not.toBeInTheDocument();
    });

    it('should still render the Reconfigure button when the engine version row is in its Pulumi Engine section', () => {
      renderPage(<SettingsPage />, { initialEntries: ['/settings'] });
      expect(screen.getByText('Pulumi Engine')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^reconfigure$/i })).toBeInTheDocument();
    });
  });

  describe('Updates — Automatic Updates toggle', () => {
    it('should render unchecked once the read resolves false', async () => {
      hyveonMock.iac.settings.autoUpdateGet.mockResolvedValue({ ok: true, enableAutoUpdate: false });
      renderPage(<SettingsPage />, { initialEntries: ['/settings'] });

      const toggle = await screen.findByLabelText('Automatic updates');
      expect(toggle).not.toBeChecked();
    });

    it('should render checked once the read resolves true', async () => {
      hyveonMock.iac.settings.autoUpdateGet.mockResolvedValue({ ok: true, enableAutoUpdate: true });
      renderPage(<SettingsPage />, { initialEntries: ['/settings'] });

      const toggle = await screen.findByLabelText('Automatic updates');
      await waitFor(() => expect(toggle).toBeChecked());
    });

    it('should render a distinct error message, not a false-checked toggle, when the read rejects', async () => {
      hyveonMock.iac.settings.autoUpdateGet.mockRejectedValue(new Error('IPC unavailable'));
      renderPage(<SettingsPage />, { initialEntries: ['/settings'] });

      expect(await screen.findByText('Unable to read the update setting.')).toBeInTheDocument();
    });

    it('should call autoUpdateUpdate with true and reflect the new checked state on toggle', async () => {
      hyveonMock.iac.settings.autoUpdateGet.mockResolvedValue({ ok: true, enableAutoUpdate: false });
      hyveonMock.iac.settings.autoUpdateUpdate.mockResolvedValue({ ok: true, enableAutoUpdate: true });
      renderPage(<SettingsPage />, { initialEntries: ['/settings'] });

      const toggle = await screen.findByLabelText('Automatic updates');
      await waitFor(() => expect(toggle).not.toBeChecked());
      await userEvent.click(toggle);

      expect(hyveonMock.iac.settings.autoUpdateUpdate).toHaveBeenCalledWith({ enableAutoUpdate: true });
      await waitFor(() => expect(toggle).toBeChecked());
    });

    it('should keep the checkbox reflecting the last confirmed value when the write fails, not drop to the no-value error state', async () => {
      hyveonMock.iac.settings.autoUpdateGet.mockResolvedValue({ ok: true, enableAutoUpdate: true });
      hyveonMock.iac.settings.autoUpdateUpdate.mockResolvedValue({ ok: false, code: 'error', message: 'nope' });
      renderPage(<SettingsPage />, { initialEntries: ['/settings'] });

      const toggle = await screen.findByLabelText('Automatic updates');
      await waitFor(() => expect(toggle).toBeChecked());
      await userEvent.click(toggle);

      await waitFor(() => expect(screen.getByText('Failed to save — still showing the last saved value.')).toBeInTheDocument());
      expect(toggle).toBeChecked();
      expect(screen.queryByText('Unable to read the update setting.')).not.toBeInTheDocument();
    });

    it('should keep the checkbox unchecked and clear the write-error message on a subsequent successful toggle', async () => {
      hyveonMock.iac.settings.autoUpdateGet.mockResolvedValue({ ok: true, enableAutoUpdate: false });
      hyveonMock.iac.settings.autoUpdateUpdate.mockResolvedValueOnce({ ok: false, code: 'error', message: 'nope' });
      renderPage(<SettingsPage />, { initialEntries: ['/settings'] });

      const toggle = await screen.findByLabelText('Automatic updates');
      await waitFor(() => expect(toggle).not.toBeChecked());
      await userEvent.click(toggle);
      await waitFor(() => expect(screen.getByText('Failed to save — still showing the last saved value.')).toBeInTheDocument());

      hyveonMock.iac.settings.autoUpdateUpdate.mockResolvedValueOnce({ ok: true, enableAutoUpdate: true });
      await userEvent.click(toggle);

      await waitFor(() => expect(toggle).toBeChecked());
      expect(screen.queryByText('Failed to save — still showing the last saved value.')).not.toBeInTheDocument();
    });
  });

  describe('Updates — Check for Updates button', () => {
    it('should show a loading message while the check is in flight', async () => {
      let resolveCheck!: (result: { ok: true; updateAvailable: false }) => void;
      hyveonMock.iac.settings.autoUpdateCheck.mockReturnValue(new Promise((resolve) => (resolveCheck = resolve)));
      renderPage(<SettingsPage />, { initialEntries: ['/settings'] });

      await userEvent.click(await screen.findByRole('button', { name: /check for updates/i }));

      expect(await screen.findByText('Checking for updates…')).toBeInTheDocument();
      resolveCheck({ ok: true, updateAvailable: false });
    });

    it('should report up to date when no update is available', async () => {
      hyveonMock.iac.settings.autoUpdateCheck.mockResolvedValue({ ok: true, updateAvailable: false });
      renderPage(<SettingsPage />, { initialEntries: ['/settings'] });

      await userEvent.click(await screen.findByRole('button', { name: /check for updates/i }));

      expect(await screen.findByText("You're up to date.")).toBeInTheDocument();
    });

    it('should report the version when an update is available', async () => {
      hyveonMock.iac.settings.autoUpdateCheck.mockResolvedValue({ ok: true, updateAvailable: true, version: '1.2.3' });
      renderPage(<SettingsPage />, { initialEntries: ['/settings'] });

      await userEvent.click(await screen.findByRole('button', { name: /check for updates/i }));

      expect(await screen.findByText('Update available: v1.2.3')).toBeInTheDocument();
    });

    it('should render the error message when the check fails', async () => {
      hyveonMock.iac.settings.autoUpdateCheck.mockResolvedValue({ ok: false, message: 'feed unreachable' });
      renderPage(<SettingsPage />, { initialEntries: ['/settings'] });

      await userEvent.click(await screen.findByRole('button', { name: /check for updates/i }));

      expect(await screen.findByText('feed unreachable')).toBeInTheDocument();
    });

    it('should render a fallback message when the IPC call rejects', async () => {
      hyveonMock.iac.settings.autoUpdateCheck.mockRejectedValue(new Error('IPC unavailable'));
      renderPage(<SettingsPage />, { initialEntries: ['/settings'] });

      await userEvent.click(await screen.findByRole('button', { name: /check for updates/i }));

      expect(await screen.findByText('Unable to reach the update service.')).toBeInTheDocument();
    });

    it('should work regardless of the enableAutoUpdate toggle value', async () => {
      hyveonMock.iac.settings.autoUpdateGet.mockResolvedValue({ ok: true, enableAutoUpdate: false });
      hyveonMock.iac.settings.autoUpdateCheck.mockResolvedValue({ ok: true, updateAvailable: false });
      renderPage(<SettingsPage />, { initialEntries: ['/settings'] });

      const toggle = await screen.findByLabelText('Automatic updates');
      await waitFor(() => expect(toggle).not.toBeChecked());
      await userEvent.click(await screen.findByRole('button', { name: /check for updates/i }));

      expect(hyveonMock.iac.settings.autoUpdateCheck).toHaveBeenCalledOnce();
      expect(await screen.findByText("You're up to date.")).toBeInTheDocument();
    });
  });

  describe('Reconfigure', () => {
    it('should render a Reconfigure entry point in the Cloud Setup section', () => {
      renderPage(<SettingsPage />, { initialEntries: ['/settings'] });
      expect(screen.getByRole('button', { name: /^reconfigure$/i })).toBeInTheDocument();
    });

    it('should open the wizard on pick-cloud (skipping prerequisites) with completed steps showing an Edit affordance', async () => {
      renderPage(<SettingsPage />, { initialEntries: ['/settings'] });

      await userEvent.click(screen.getByRole('button', { name: /^reconfigure$/i }));

      expect(await screen.findByText(/choose your cloud is already configured/i)).toBeInTheDocument();
      expect(screen.getByText(/step 1 of 5/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^edit$/i })).toBeInTheDocument();
    });

    it('should preserve every other stored setting when only the credentials-step region is edited', async () => {
      renderPage(<SettingsPage />, { initialEntries: ['/settings'] });
      await userEvent.click(screen.getByRole('button', { name: /^reconfigure$/i }));
      await screen.findByText(/choose your cloud is already configured/i);

      // pick-cloud: leave collapsed, advance to credentials. Guided-IAM sits
      // in between (Group 7) but isn't in RECONFIGURE_PRE_COMPLETED_STEPS —
      // the default `aws.profile: 'default'` prefill is not the guided
      // profile, so it isn't pre-completed either — skip it via "I already
      // have credentials".
      await userEvent.click(screen.getByRole('button', { name: /^next$/i }));
      await screen.findByText(/provision aws access/i, { selector: 'p' });
      await userEvent.click(screen.getByRole('button', { name: /i already have credentials/i }));
      await screen.findByText(/aws credentials is already configured/i);

      // credentials: open for editing, change only the region.
      await userEvent.click(screen.getByRole('button', { name: /^edit$/i }));
      const regionInput = await screen.findByLabelText('Region');
      await waitFor(() => expect(regionInput).toHaveValue('us-east-1'));
      await userEvent.clear(regionInput);
      await userEvent.type(regionInput, 'eu-west-1');
      await userEvent.click(screen.getByRole('button', { name: /^next$/i }));

      // bootstrap: leave collapsed, advance to stack-init and finish.
      await screen.findByText(/bootstrap aws resources is already configured/i);
      await userEvent.click(screen.getByRole('button', { name: /^next$/i }));
      await waitFor(() => expect(screen.getByRole('button', { name: /finish setup/i })).toBeEnabled());
      await userEvent.click(screen.getByRole('button', { name: /finish setup/i }));

      await waitFor(() =>
        expect(hyveonMock.wizard.saveState).toHaveBeenCalledWith({
          aws: { profile: 'default', region: 'eu-west-1' },
        }),
      );
      // pick-cloud and bootstrap were never opened via Edit — omitted from
      // the payload entirely, not resubmitted with their current (unedited)
      // values, so the stored `activeCloud`/`bootstrap` are untouched.
      expect(hyveonMock.wizard.saveState).toHaveBeenCalledTimes(1);
    });

    it('should commit only the edited step, and initialize the stack with no renderer-supplied config, when the bootstrap step is left collapsed', async () => {
      hyveonMock.wizard.getState.mockResolvedValue({
        wizardCompleted: true,
        activeCloud: 'aws',
        aws: { profile: 'default', region: 'us-east-1' },
        bootstrap: { stateBucket: 'renamed-tfstate', configurationBucket: 'renamed-config' },
      });
      renderPage(<SettingsPage />, { initialEntries: ['/settings'] });
      await userEvent.click(screen.getByRole('button', { name: /^reconfigure$/i }));
      await screen.findByText(/choose your cloud is already configured/i);

      await userEvent.click(screen.getByRole('button', { name: /^next$/i }));
      // Default `aws.profile: 'default'` is not the guided profile, so
      // guided-iam isn't pre-completed — skip it via "I already have credentials".
      await screen.findByText(/provision aws access/i, { selector: 'p' });
      await userEvent.click(screen.getByRole('button', { name: /i already have credentials/i }));
      await screen.findByText(/aws credentials is already configured/i);
      await userEvent.click(screen.getByRole('button', { name: /^next$/i }));
      await screen.findByText(/bootstrap aws resources is already configured/i);
      await userEvent.click(screen.getByRole('button', { name: /^next$/i }));
      await waitFor(() => expect(screen.getByRole('button', { name: /finish setup/i })).toBeEnabled());
      await userEvent.click(screen.getByRole('button', { name: /finish setup/i }));

      await waitFor(() => expect(hyveonMock.wizard.complete).toHaveBeenCalledTimes(1));
      expect(hyveonMock.wizard.saveState).not.toHaveBeenCalled();
      // `PulumiService.initializeStack` resolves the state bucket/region it
      // needs internally from already-persisted wizard state — unlike the
      // deleted pre-migration `init` call this replaces, the renderer passes
      // it no config at all.
      expect(hyveonMock.iac.stack.initialize).toHaveBeenCalledWith();
    });

    it('should not clobber stored config on Finish when the prefill itself fails and nothing was edited', async () => {
      hyveonMock.wizard.getState.mockRejectedValue(new Error('IPC unavailable'));
      renderPage(<SettingsPage />, { initialEntries: ['/settings'] });
      await userEvent.click(screen.getByRole('button', { name: /^reconfigure$/i }));
      await screen.findByText(/choose your cloud is already configured/i);

      await userEvent.click(screen.getByRole('button', { name: /^next$/i }));
      // Default `aws.profile: 'default'` is not the guided profile, so
      // guided-iam isn't pre-completed — skip it via "I already have credentials".
      await screen.findByText(/provision aws access/i, { selector: 'p' });
      await userEvent.click(screen.getByRole('button', { name: /i already have credentials/i }));
      await screen.findByText(/aws credentials is already configured/i);
      await userEvent.click(screen.getByRole('button', { name: /^next$/i }));
      await screen.findByText(/bootstrap aws resources is already configured/i);
      await userEvent.click(screen.getByRole('button', { name: /^next$/i }));
      await waitFor(() => expect(screen.getByRole('button', { name: /finish setup/i })).toBeEnabled());
      await userEvent.click(screen.getByRole('button', { name: /finish setup/i }));

      await waitFor(() => expect(hyveonMock.wizard.complete).toHaveBeenCalledTimes(1));
      // Every step stayed collapsed (never opened via Edit), so even though
      // the prefill never populated real values, nothing gets sent to
      // overwrite what's actually stored.
      expect(hyveonMock.wizard.saveState).not.toHaveBeenCalled();
    });

    it('should commit nothing and return to Settings when Reconfigure is cancelled mid-flow', async () => {
      renderPage(<SettingsPage />, { initialEntries: ['/settings'] });
      await userEvent.click(screen.getByRole('button', { name: /^reconfigure$/i }));
      await screen.findByText(/choose your cloud is already configured/i);

      await userEvent.click(screen.getByRole('button', { name: /^cancel$/i }));

      expect(hyveonMock.wizard.saveState).not.toHaveBeenCalled();
      expect(hyveonMock.wizard.complete).not.toHaveBeenCalled();
      expect(screen.getByRole('heading', { name: 'Settings' })).toBeInTheDocument();
    });
  });
});
