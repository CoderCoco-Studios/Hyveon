import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AwsProfileSummary, PrerequisitesReport } from '@hyveon/desktop-preload';

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

const gsdMock = {
  wizard: {
    checkPrereqs: vi.fn(),
    getState: vi.fn(),
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

import { SettingsPage } from './settings.page.js';
import { renderPage } from '../test-utils/render-page.utils.js';

/** Satisfies the prerequisites step so the version row has something to render. */
const SATISFIED: PrerequisitesReport = {
  terraform: { found: true, path: '/usr/local/bin/terraform', version: '1.9.0', minimumVersionSatisfied: true },
  aws: { found: true, path: '/usr/local/bin/aws', version: '2.15.30' },
};

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
    gsdMock.wizard.checkPrereqs.mockReset().mockResolvedValue(SATISFIED);
    gsdMock.wizard.getState
      .mockReset()
      .mockResolvedValue({ wizardCompleted: true, activeCloud: 'aws', aws: { profile: 'default', region: 'us-east-1' } });
    gsdMock.wizard.saveState.mockReset().mockResolvedValue({ wizardCompleted: true });
    gsdMock.wizard.listAwsProfiles.mockReset().mockResolvedValue(SAMPLE_PROFILES);
    gsdMock.wizard.saveCredentials.mockReset();
    gsdMock.wizard.bootstrapStateBucket.mockReset().mockResolvedValue({ status: 'exists' });
    gsdMock.wizard.bootstrapLockTable.mockReset().mockResolvedValue({ status: 'exists' });
    gsdMock.wizard.bootstrapTfvarsBucket.mockReset().mockResolvedValue({ status: 'exists' });
    gsdMock.wizard.simulateIamPermissions.mockReset();
    gsdMock.wizard.getProgress.mockReset().mockResolvedValue({ step: 'prerequisites' });
    gsdMock.wizard.saveProgress.mockReset().mockResolvedValue(undefined);
    gsdMock.wizard.complete.mockReset().mockResolvedValue({ wizardCompleted: true });
    gsdMock.terraform.init.mockReset().mockImplementation(async function* () {
      // No chunks needed by default — the Reconfigure tests below just need it to succeed.
    });
  });

  afterEach(() => {
    cleanup();
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

  it('should render the Diagnostics section heading', () => {
    renderPage(<SettingsPage />, { initialEntries: ['/settings'] });
    expect(screen.getByRole('heading', { name: 'Diagnostics' })).toBeInTheDocument();
  });

  it('should render the DiagnosticsPanel inside the Diagnostics section', () => {
    renderPage(<SettingsPage />, { initialEntries: ['/settings'] });
    expect(screen.getByTestId('diagnostics-panel')).toBeInTheDocument();
  });

  it('should show the resolved Terraform version alongside the pinned minimum', async () => {
    renderPage(<SettingsPage />, { initialEntries: ['/settings'] });
    expect(await screen.findByText(/detected v1\.9\.0/i)).toBeInTheDocument();
    expect(screen.getByText(/minimum v1\.5\.0/)).toBeInTheDocument();
  });

  it('should show "Not detected" when the Terraform prerequisite check fails', async () => {
    gsdMock.wizard.checkPrereqs.mockRejectedValue(new Error('terraform not on PATH'));
    renderPage(<SettingsPage />, { initialEntries: ['/settings'] });
    expect(await screen.findByText(/not detected/i)).toBeInTheDocument();
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
      expect(screen.getByText(/step 1 of 4/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^edit$/i })).toBeInTheDocument();
    });

    it('should preserve every other stored setting when only the credentials-step region is edited', async () => {
      renderPage(<SettingsPage />, { initialEntries: ['/settings'] });
      await userEvent.click(screen.getByRole('button', { name: /^reconfigure$/i }));
      await screen.findByText(/choose your cloud is already configured/i);

      // pick-cloud: leave collapsed, advance to credentials.
      await userEvent.click(screen.getByRole('button', { name: /^next$/i }));
      await screen.findByText(/aws credentials is already configured/i);

      // credentials: open for editing, change only the region.
      await userEvent.click(screen.getByRole('button', { name: /^edit$/i }));
      const regionInput = await screen.findByLabelText('Region');
      await waitFor(() => expect(regionInput).toHaveValue('us-east-1'));
      await userEvent.clear(regionInput);
      await userEvent.type(regionInput, 'eu-west-1');
      await userEvent.click(screen.getByRole('button', { name: /^next$/i }));

      // bootstrap: leave collapsed, advance to terraform-init and finish.
      await screen.findByText(/bootstrap aws resources is already configured/i);
      await userEvent.click(screen.getByRole('button', { name: /^next$/i }));
      await waitFor(() => expect(screen.getByRole('button', { name: /finish setup/i })).toBeEnabled());
      await userEvent.click(screen.getByRole('button', { name: /finish setup/i }));

      await waitFor(() =>
        expect(gsdMock.wizard.saveState).toHaveBeenCalledWith({
          activeCloud: 'aws',
          aws: { profile: 'default', region: 'eu-west-1' },
        }),
      );
      expect(gsdMock.wizard.saveState).toHaveBeenCalledTimes(1);
    });

    it('should commit nothing and return to Settings when Reconfigure is cancelled mid-flow', async () => {
      renderPage(<SettingsPage />, { initialEntries: ['/settings'] });
      await userEvent.click(screen.getByRole('button', { name: /^reconfigure$/i }));
      await screen.findByText(/choose your cloud is already configured/i);

      await userEvent.click(screen.getByRole('button', { name: /^cancel$/i }));

      expect(gsdMock.wizard.saveState).not.toHaveBeenCalled();
      expect(gsdMock.wizard.complete).not.toHaveBeenCalled();
      expect(screen.getByRole('heading', { name: 'Settings' })).toBeInTheDocument();
    });
  });
});
