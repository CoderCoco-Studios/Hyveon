import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BootstrapStep } from './bootstrap-step.component.js';
import type { BootstrapResourceKey, BootstrapResourceState } from './wizard.utils.js';
import type { IamCheckResult } from '@hyveon/desktop-preload';

const NAMES: Record<BootstrapResourceKey, string> = {
  stateBucket: 'hyveon-tfstate',
  configurationBucket: 'hyveon-tfvars',
};

const PENDING: Record<BootstrapResourceKey, BootstrapResourceState> = {
  stateBucket: 'pending',
  configurationBucket: 'pending',
};

/** Renders `BootstrapStep` with sensible defaults, letting each test override just what it cares about. */
function renderStep(overrides: Partial<Parameters<typeof BootstrapStep>[0]> = {}) {
  return render(
    <BootstrapStep
      names={NAMES}
      statuses={PENDING}
      messages={{}}
      onNameChange={vi.fn()}
      onRunBootstrap={vi.fn()}
      bootstrapping={false}
      iamCheck={null}
      iamChecking={false}
      iamError={null}
      onRunIamCheck={vi.fn()}
      {...overrides}
    />,
  );
}

afterEach(() => {
  cleanup();
});

describe('BootstrapStep', () => {
  it('should render the two bootstrapped resource rows with their names', () => {
    renderStep();
    expect(screen.getByLabelText('Terraform state bucket name')).toHaveValue('hyveon-tfstate');
    expect(screen.getByLabelText('Configuration bucket name')).toHaveValue('hyveon-tfvars');
  });

  it('should call onNameChange when a resource name field is edited', async () => {
    const onNameChange = vi.fn();
    renderStep({ onNameChange });

    await userEvent.type(screen.getByLabelText('Terraform state bucket name'), 'x');

    expect(onNameChange).toHaveBeenCalledWith('stateBucket', expect.any(String));
  });

  it('should call onRunBootstrap when the bootstrap button is clicked', async () => {
    const onRunBootstrap = vi.fn();
    renderStep({ onRunBootstrap });

    await userEvent.click(screen.getByRole('button', { name: /bootstrap aws resources/i }));

    expect(onRunBootstrap).toHaveBeenCalledTimes(1);
  });

  it('should show a failure message under a resource whose status is failed', () => {
    renderStep({
      statuses: { ...PENDING, stateBucket: 'failed' },
      messages: { stateBucket: 'Bucket name already taken' },
    });
    expect(screen.getByText('Bucket name already taken')).toBeInTheDocument();
  });

  it('should render the public-access-block outcome once a resource is created or already exists', () => {
    renderStep({ statuses: { ...PENDING, stateBucket: 'created', configurationBucket: 'exists' } });

    expect(screen.getAllByText('Public access blocked')).toHaveLength(2);
  });

  it('should not render the public-access-block outcome for a pending, creating, or failed resource', () => {
    renderStep({
      statuses: { ...PENDING, stateBucket: 'creating', configurationBucket: 'failed' },
      messages: { configurationBucket: 'access denied' },
    });

    expect(screen.queryByText('Public access blocked')).not.toBeInTheDocument();
  });

  it('should report a failed resource without masking its sibling — one row shows failed, the other shows created independently', () => {
    renderStep({
      statuses: { ...PENDING, stateBucket: 'created', configurationBucket: 'failed' },
      messages: { configurationBucket: 'access denied applying public-access-block' },
    });

    // The failing resource: failure badge + message, no success indication.
    const configRow = screen.getByLabelText('Configuration bucket name').closest('div')!;
    expect(within(configRow).getByText('Failed')).toBeInTheDocument();
    expect(within(configRow).getByText('access denied applying public-access-block')).toBeInTheDocument();
    expect(within(configRow).queryByText('Public access blocked')).not.toBeInTheDocument();

    // The sibling resource: fully succeeded, unaffected by the other's failure.
    const stateRow = screen.getByLabelText('Terraform state bucket name').closest('div')!;
    expect(within(stateRow).getByText('Created')).toBeInTheDocument();
    expect(within(stateRow).getByText('Public access blocked')).toBeInTheDocument();
    expect(within(stateRow).queryByText('access denied applying public-access-block')).not.toBeInTheDocument();
  });

  it('should disable name fields and the bootstrap button while bootstrapping', () => {
    renderStep({ bootstrapping: true });
    expect(screen.getByLabelText('Terraform state bucket name')).toBeDisabled();
    expect(screen.getByRole('button', { name: /bootstrap aws resources/i })).toBeDisabled();
  });

  it('should call onRunIamCheck when the IAM check button is clicked', async () => {
    const onRunIamCheck = vi.fn();
    renderStep({ onRunIamCheck });

    await userEvent.click(screen.getByRole('button', { name: /check permissions/i }));

    expect(onRunIamCheck).toHaveBeenCalledTimes(1);
  });

  describe('IAM panel states', () => {
    it('should render a passed message when the check reports passed', () => {
      const passed: IamCheckResult = { status: 'passed' };
      renderStep({ iamCheck: passed });
      expect(screen.getByText(/all required permissions are present/i)).toBeInTheDocument();
    });

    it('should render the policy JSON when the check reports missing actions', () => {
      const missing: IamCheckResult = {
        status: 'missing',
        policyJson: '{\n  "Version": "2012-10-17"\n}',
      };
      renderStep({ iamCheck: missing });
      expect(screen.getByText(/some permissions are missing/i)).toBeInTheDocument();
      expect(screen.getByText(/"Version": "2012-10-17"/)).toBeInTheDocument();
    });

    it('should copy the policy JSON to the clipboard when the copy button is clicked', async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.assign(navigator, { clipboard: { writeText } });
      const missing: IamCheckResult = { status: 'missing', policyJson: '{"Version":"2012-10-17"}' };
      renderStep({ iamCheck: missing });

      await userEvent.click(screen.getByRole('button', { name: /copy required iam json/i }));

      expect(writeText).toHaveBeenCalledWith('{"Version":"2012-10-17"}');
    });

    it('should render the warning message and full action checklist when simulation itself fails', () => {
      const warning: IamCheckResult = { status: 'warning', message: 'iam:SimulatePrincipalPolicy not permitted' };
      renderStep({ iamCheck: warning });
      expect(screen.getByText('iam:SimulatePrincipalPolicy not permitted')).toBeInTheDocument();
      expect(screen.getByText('ecs:*')).toBeInTheDocument();
    });

    it('should render the IPC-level error message when the check call itself fails', () => {
      renderStep({ iamError: 'IPC bridge (window.hyveon) is not available in this context.' });
      expect(screen.getByRole('alert')).toHaveTextContent('IPC bridge (window.hyveon) is not available');
    });
  });
});
