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
      // in between (Group 7 Task 1) but isn't in RECONFIGURE_PRE_COMPLETED_STEPS
      // and has no component yet, so its blank screen is clicked straight through.
      await userEvent.click(screen.getByRole('button', { name: /^next$/i }));
      await screen.findByText(/provision aws access/i);
      await userEvent.click(screen.getByRole('button', { name: /^next$/i }));
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
        bootstrap: { stateBucket: 'renamed-tfstate', configurationBucket: 'renamed-tfvars' },
      });
      renderPage(<SettingsPage />, { initialEntries: ['/settings'] });
      await userEvent.click(screen.getByRole('button', { name: /^reconfigure$/i }));
      await screen.findByText(/choose your cloud is already configured/i);

      await userEvent.click(screen.getByRole('button', { name: /^next$/i }));
      // Guided-IAM step has no component yet (a later task builds it) — click straight through.
      await screen.findByText(/provision aws access/i);
      await userEvent.click(screen.getByRole('button', { name: /^next$/i }));
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
      // deleted `terraform init` call this replaces, the renderer passes it
      // no config at all.
      expect(hyveonMock.iac.stack.initialize).toHaveBeenCalledWith();
    });

    it('should not clobber stored config on Finish when the prefill itself fails and nothing was edited', async () => {
      hyveonMock.wizard.getState.mockRejectedValue(new Error('IPC unavailable'));
      renderPage(<SettingsPage />, { initialEntries: ['/settings'] });
      await userEvent.click(screen.getByRole('button', { name: /^reconfigure$/i }));
      await screen.findByText(/choose your cloud is already configured/i);

      await userEvent.click(screen.getByRole('button', { name: /^next$/i }));
      // Guided-IAM step has no component yet (a later task builds it) — click straight through.
      await screen.findByText(/provision aws access/i);
      await userEvent.click(screen.getByRole('button', { name: /^next$/i }));
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
