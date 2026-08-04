import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DeploymentSettingsForm } from './deployment-settings-form.component.js';

const toastMock = vi.hoisted(() => Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast: toastMock }));

const hyveonMock = {
  iac: {
    settings: {
      get: vi.fn(),
      update: vi.fn(),
    },
  },
};
vi.stubGlobal('hyveon', hyveonMock);

/** Fully-populated top-level settings fixture used by most tests. */
const SETTINGS = {
  projectName: 'hyveon',
  awsRegion: 'us-east-1',
  vpcCidr: '10.0.0.0/16',
  hostedZoneName: 'example.com',
  dnsTtl: 30,
  watchdogIntervalMinutes: 15,
  watchdogIdleChecks: 4,
  watchdogMinPackets: 100,
  baseAllowedGuilds: ['123456789012345678'],
  baseAdminUserIds: [],
  baseAdminRoleIds: [],
  discordApplicationId: '',
  auditTableName: '',
  runsTableName: '',
};

describe('DeploymentSettingsForm', () => {
  beforeEach(() => {
    hyveonMock.iac.settings.get.mockReset().mockResolvedValue({ ok: true, settings: SETTINGS, etag: 'etag-1' });
    hyveonMock.iac.settings.update.mockReset();
    toastMock.success.mockClear();
    toastMock.error.mockClear();
  });

  it('should show a loading message before the initial iac.settings.get() resolves', () => {
    hyveonMock.iac.settings.get.mockReturnValue(new Promise(() => {}));
    render(<DeploymentSettingsForm />);
    expect(screen.getByText(/loading deployment settings/i)).toBeInTheDocument();
  });

  it('should populate every field from the loaded settings', async () => {
    render(<DeploymentSettingsForm />);

    expect(await screen.findByLabelText('Hosted zone name')).toHaveValue('example.com');
    expect(screen.getByLabelText('Project name')).toHaveValue('hyveon');
    expect(screen.getByLabelText('AWS region')).toHaveValue('us-east-1');
    expect(screen.getByLabelText('VPC CIDR')).toHaveValue('10.0.0.0/16');
    expect(screen.getByLabelText('DNS TTL (seconds)')).toHaveValue(30);
    expect(screen.getByLabelText('Check interval (minutes)')).toHaveValue(15);
    expect(screen.getByText('123456789012345678')).toBeInTheDocument();
  });

  it('should render a "finish the wizard" message when the read reports setup_incomplete', async () => {
    hyveonMock.iac.settings.get.mockResolvedValue({
      ok: false,
      code: 'setup_incomplete',
      message: 'No configuration bucket is configured.',
    });
    render(<DeploymentSettingsForm />);
    expect(await screen.findByText('No configuration bucket is configured.')).toBeInTheDocument();
  });

  it('should render an inline error with a Retry button when the read fails, and retry on click', async () => {
    hyveonMock.iac.settings.get
      .mockResolvedValueOnce({ ok: false, code: 'error', message: 'S3 unreachable' })
      .mockResolvedValueOnce({ ok: true, settings: SETTINGS, etag: 'etag-1' });

    render(<DeploymentSettingsForm />);
    expect(await screen.findByRole('alert')).toHaveTextContent('S3 unreachable');

    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByLabelText('Hosted zone name')).toHaveValue('example.com');
    expect(hyveonMock.iac.settings.get).toHaveBeenCalledTimes(2);
  });

  describe('client-side validation', () => {
    it('should disable Save and show an inline issue when hostedZoneName is cleared', async () => {
      render(<DeploymentSettingsForm />);
      const hostedZoneInput = await screen.findByLabelText('Hosted zone name');

      await userEvent.clear(hostedZoneInput);

      expect(screen.getByRole('button', { name: /save settings/i })).toBeDisabled();
      expect(screen.getByText('Must not be empty.')).toBeInTheDocument();
    });

    it('should disable Save and show an inline issue for a malformed vpcCidr', async () => {
      render(<DeploymentSettingsForm />);
      const cidrInput = await screen.findByLabelText('VPC CIDR');

      await userEvent.clear(cidrInput);
      await userEvent.type(cidrInput, 'not-a-cidr');

      expect(screen.getByRole('button', { name: /save settings/i })).toBeDisabled();
      expect(screen.getByText('Must be a valid IPv4 CIDR block, e.g. "10.0.0.0/16".')).toBeInTheDocument();
    });

    it('should disable Save when a numeric field is set to zero', async () => {
      render(<DeploymentSettingsForm />);
      const dnsTtlInput = await screen.findByLabelText('DNS TTL (seconds)');

      await userEvent.clear(dnsTtlInput);
      await userEvent.type(dnsTtlInput, '0');

      expect(screen.getByRole('button', { name: /save settings/i })).toBeDisabled();
      expect(screen.getByText('Must be a positive whole number.')).toBeInTheDocument();
    });

    it('should never flag an empty auditTableName/runsTableName as invalid', async () => {
      render(<DeploymentSettingsForm />);
      await screen.findByLabelText('Hosted zone name');

      expect(screen.getByLabelText('Audit table name')).toHaveValue('');
      expect(screen.getByLabelText('Runs table name')).toHaveValue('');
      expect(screen.getByRole('button', { name: /save settings/i })).toBeEnabled();
      expect(screen.getByPlaceholderText('auto (hyveon-audit)')).toBeInTheDocument();
      expect(screen.getByPlaceholderText('auto (hyveon-runs)')).toBeInTheDocument();
    });
  });

  describe('defensive defaulting for an incomplete settings object', () => {
    it('should render without crashing when the three base-allowlist arrays are absent from the fetched settings', async () => {
      // Simulates a stored document that predates these fields — the
      // backend now defaults them too (TfvarsService.getTopLevelSettings),
      // but this pins the renderer's OWN independent defense, since
      // `iac.settings.get()`'s declared return type is a compile-time
      // promise only, not a runtime guarantee for every possible caller
      // (a stale preload build, a test mock, ...).
      const incompleteSettings = { ...SETTINGS } as Record<string, unknown>;
      delete incompleteSettings['baseAllowedGuilds'];
      delete incompleteSettings['baseAdminUserIds'];
      delete incompleteSettings['baseAdminRoleIds'];
      hyveonMock.iac.settings.get.mockResolvedValue({ ok: true, settings: incompleteSettings, etag: 'etag-1' });

      render(<DeploymentSettingsForm />);

      // Would previously throw inside SnowflakeListField's `value.map(...)`
      // and white-screen the route — reaching this assertion at all is the
      // regression test.
      expect(await screen.findByLabelText('Hosted zone name')).toHaveValue('example.com');
      expect(screen.getByLabelText('Base allowed guild IDs')).toBeInTheDocument();
      expect(screen.getByLabelText('Base admin user IDs')).toBeInTheDocument();
      expect(screen.getByLabelText('Base admin role IDs')).toBeInTheDocument();
    });

    it('should fall back to the deployment-config default numeric values, never the literal string "undefined", when numeric fields are absent', async () => {
      const incompleteSettings = { ...SETTINGS } as Record<string, unknown>;
      delete incompleteSettings['dnsTtl'];
      delete incompleteSettings['watchdogIntervalMinutes'];
      delete incompleteSettings['watchdogIdleChecks'];
      delete incompleteSettings['watchdogMinPackets'];
      hyveonMock.iac.settings.get.mockResolvedValue({ ok: true, settings: incompleteSettings, etag: 'etag-1' });

      render(<DeploymentSettingsForm />);

      expect(await screen.findByLabelText('DNS TTL (seconds)')).toHaveValue(30);
      expect(screen.getByLabelText('Check interval (minutes)')).toHaveValue(15);
      expect(screen.getByLabelText('Idle checks before shutdown')).toHaveValue(4);
      expect(screen.getByLabelText('Min packets (activity threshold)')).toHaveValue(100);
    });
  });

  describe('Discord ID chip fields', () => {
    it('should add a chip on Enter and remove it via its remove button', async () => {
      render(<DeploymentSettingsForm />);
      const input = await screen.findByLabelText('Base admin user IDs');

      await userEvent.type(input, '234567890123456789{Enter}');
      expect(screen.getByText('234567890123456789')).toBeInTheDocument();

      await userEvent.click(screen.getByRole('button', { name: 'Remove 234567890123456789' }));
      expect(screen.queryByText('234567890123456789')).not.toBeInTheDocument();
    });
  });

  describe('submit', () => {
    it('should submit the patch with the etag last read as expectedVersionId', async () => {
      hyveonMock.iac.settings.update.mockResolvedValue({
        ok: true,
        settings: { ...SETTINGS, dnsTtl: 60 },
        etag: 'etag-2',
        versionId: 'v-2',
      });
      render(<DeploymentSettingsForm />);
      const dnsTtlInput = await screen.findByLabelText('DNS TTL (seconds)');
      await userEvent.clear(dnsTtlInput);
      await userEvent.type(dnsTtlInput, '60');

      await userEvent.click(screen.getByRole('button', { name: /save settings/i }));

      await waitFor(() =>
        expect(hyveonMock.iac.settings.update).toHaveBeenCalledWith(
          expect.objectContaining({ expectedVersionId: 'etag-1', patch: expect.objectContaining({ dnsTtl: 60 }) }),
        ),
      );
      expect(toastMock.success).toHaveBeenCalledWith('Deployment settings saved');
    });

    it('should re-render the same fields with server-reported issues on a validation rejection', async () => {
      hyveonMock.iac.settings.update.mockResolvedValue({
        ok: false,
        code: 'validation',
        issues: [{ path: 'hostedZoneName', message: 'Already in use by another deployment.' }],
      });
      render(<DeploymentSettingsForm />);
      await screen.findByLabelText('Hosted zone name');

      await userEvent.click(screen.getByRole('button', { name: /save settings/i }));

      expect(await screen.findByText('Already in use by another deployment.')).toBeInTheDocument();
      // The draft itself is left untouched — the hosted zone field still shows the original value.
      expect(screen.getByLabelText('Hosted zone name')).toHaveValue('example.com');
    });

    it('should surface a clear "reload and try again" message on a conflict, without silently retrying or overwriting', async () => {
      hyveonMock.iac.settings.update.mockResolvedValue({
        ok: false,
        code: 'conflict',
        expectedVersionId: 'etag-1',
        currentVersionId: 'etag-current',
        message: 'stale etag',
      });
      render(<DeploymentSettingsForm />);
      await screen.findByLabelText('Hosted zone name');

      await userEvent.click(screen.getByRole('button', { name: /save settings/i }));

      expect(
        await screen.findByText(
          'This setting was changed elsewhere since you loaded this page — reload and try again.',
        ),
      ).toBeInTheDocument();
      expect(hyveonMock.iac.settings.update).toHaveBeenCalledTimes(1);
    });

    it('should reload settings + etag when the operator clicks Reload after a conflict', async () => {
      hyveonMock.iac.settings.update.mockResolvedValue({
        ok: false,
        code: 'conflict',
        message: 'stale etag',
      });
      render(<DeploymentSettingsForm />);
      await screen.findByLabelText('Hosted zone name');
      await userEvent.click(screen.getByRole('button', { name: /save settings/i }));
      await screen.findByText(/reload and try again/);

      hyveonMock.iac.settings.get.mockResolvedValue({
        ok: true,
        settings: { ...SETTINGS, dnsTtl: 999 },
        etag: 'etag-fresh',
      });
      await userEvent.click(screen.getByRole('button', { name: 'Reload' }));

      await waitFor(() => expect(screen.getByLabelText('DNS TTL (seconds)')).toHaveValue(999));
    });

    it('should surface the message inline for a setup_incomplete write rejection', async () => {
      hyveonMock.iac.settings.update.mockResolvedValue({
        ok: false,
        code: 'setup_incomplete',
        message: 'No configuration bucket is configured.',
      });
      render(<DeploymentSettingsForm />);
      await screen.findByLabelText('Hosted zone name');

      await userEvent.click(screen.getByRole('button', { name: /save settings/i }));

      expect(await screen.findByText('No configuration bucket is configured.')).toBeInTheDocument();
    });

    it('should surface a thrown error message inline', async () => {
      hyveonMock.iac.settings.update.mockRejectedValue(new Error('IPC transport failed'));
      render(<DeploymentSettingsForm />);
      await screen.findByLabelText('Hosted zone name');

      await userEvent.click(screen.getByRole('button', { name: /save settings/i }));

      expect(await screen.findByText('IPC transport failed')).toBeInTheDocument();
    });

    it('should refuse to save and never call iac.settings.update when the loaded settings carried no etag', async () => {
      hyveonMock.iac.settings.get.mockResolvedValue({ ok: true, settings: SETTINGS, etag: undefined });
      render(<DeploymentSettingsForm />);
      await screen.findByLabelText('Hosted zone name');

      await userEvent.click(screen.getByRole('button', { name: /save settings/i }));

      expect(
        await screen.findByText(
          'No version tag for the current settings — reload the page before saving, so a concurrent edit cannot be silently overwritten.',
        ),
      ).toBeInTheDocument();
      expect(hyveonMock.iac.settings.update).not.toHaveBeenCalled();
    });
  });
});
