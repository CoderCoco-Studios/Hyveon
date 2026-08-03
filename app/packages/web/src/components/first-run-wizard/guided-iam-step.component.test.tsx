import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const hyveonMock = {
  wizard: {
    getState: vi.fn(),
    saveProgress: vi.fn(),
    guidedIamPrepareTemplate: vi.fn(),
    guidedIamOpenConsole: vi.fn(),
    guidedIamSubmitBootstrapKey: vi.fn(),
    guidedIamRotate: vi.fn(),
    guidedIamRevokeBootstrapKey: vi.fn(),
  },
};
vi.stubGlobal('hyveon', hyveonMock);

import { GuidedIamStep } from './guided-iam-step.component.js';

/** Reasonable default resolved values so a happy-path flow can run end to end without each test re-stubbing every call. */
function stubHappyPathDefaults() {
  hyveonMock.wizard.saveProgress.mockResolvedValue(undefined);
  hyveonMock.wizard.guidedIamPrepareTemplate.mockResolvedValue({ path: '/tmp/iam-bootstrap-rendered.yaml' });
  hyveonMock.wizard.guidedIamOpenConsole.mockResolvedValue({ opened: true });
  hyveonMock.wizard.guidedIamSubmitBootstrapKey.mockResolvedValue({ accountId: '123456789012' });
  hyveonMock.wizard.guidedIamRotate.mockResolvedValue({ status: 'complete' });
}

/** Drives the component from the region screen through the template screen into the key-intake form. */
async function advanceToIntake() {
  await userEvent.type(screen.getByLabelText('AWS region'), 'us-east-1');
  await userEvent.click(screen.getByRole('button', { name: /continue with guided setup/i }));
  await screen.findByLabelText('Template path');
  await userEvent.click(screen.getByRole('button', { name: /continue to key entry/i }));
  await screen.findByLabelText('Access key ID');
}

beforeEach(() => {
  Object.values(hyveonMock.wizard).forEach((fn) => fn.mockReset());
  Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
});

afterEach(() => {
  cleanup();
});

describe('GuidedIamStep', () => {
  describe('region and choice screen', () => {
    it('should render the region input and both choice actions on a fresh mount', () => {
      render(<GuidedIamStep onComplete={vi.fn()} onSkipToManual={vi.fn()} />);

      expect(screen.getByLabelText('AWS region')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /continue with guided setup/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /i already have credentials/i })).toBeInTheDocument();
    });

    it('should call onSkipToManual immediately when "I already have credentials" is clicked', async () => {
      const onSkipToManual = vi.fn();
      render(<GuidedIamStep onComplete={vi.fn()} onSkipToManual={onSkipToManual} />);

      await userEvent.click(screen.getByRole('button', { name: /i already have credentials/i }));

      expect(onSkipToManual).toHaveBeenCalledTimes(1);
      expect(hyveonMock.wizard.saveProgress).not.toHaveBeenCalled();
    });

    it('should reject an empty region instead of advancing', async () => {
      render(<GuidedIamStep onComplete={vi.fn()} onSkipToManual={vi.fn()} />);

      await userEvent.click(screen.getByRole('button', { name: /continue with guided setup/i }));

      expect(await screen.findByRole('alert')).toHaveTextContent(/enter an aws region/i);
      expect(hyveonMock.wizard.guidedIamPrepareTemplate).not.toHaveBeenCalled();
    });

    it('should persist not-started before rendering the template on the guided path', async () => {
      stubHappyPathDefaults();
      render(<GuidedIamStep onComplete={vi.fn()} onSkipToManual={vi.fn()} />);

      await userEvent.type(screen.getByLabelText('AWS region'), 'us-east-1');
      await userEvent.click(screen.getByRole('button', { name: /continue with guided setup/i }));

      await waitFor(() =>
        expect(hyveonMock.wizard.saveProgress).toHaveBeenCalledWith({
          step: 'guided-iam',
          guidedIam: { subState: 'not-started', hasBootstrapKey: false },
        }),
      );
      await waitFor(() => expect(hyveonMock.wizard.guidedIamPrepareTemplate).toHaveBeenCalledTimes(1));
    });
  });

  describe('template screen', () => {
    it('should show the rendered template path and never persist secret material', async () => {
      stubHappyPathDefaults();
      render(<GuidedIamStep onComplete={vi.fn()} onSkipToManual={vi.fn()} />);

      await userEvent.type(screen.getByLabelText('AWS region'), 'us-east-1');
      await userEvent.click(screen.getByRole('button', { name: /continue with guided setup/i }));

      expect(await screen.findByLabelText('Template path')).toHaveValue('/tmp/iam-bootstrap-rendered.yaml');
      await waitFor(() =>
        expect(hyveonMock.wizard.saveProgress).toHaveBeenCalledWith({
          step: 'guided-iam',
          guidedIam: { subState: 'template-written', hasBootstrapKey: false },
        }),
      );
      for (const call of hyveonMock.wizard.saveProgress.mock.calls) {
        expect(JSON.stringify(call)).not.toMatch(/secretAccessKey|accessKeyId/i);
      }
    });

    it('should show an inline error with a Retry action when rendering the template fails, and succeed on retry', async () => {
      stubHappyPathDefaults();
      hyveonMock.wizard.guidedIamPrepareTemplate.mockRejectedValueOnce(new Error('disk full'));
      render(<GuidedIamStep onComplete={vi.fn()} onSkipToManual={vi.fn()} />);

      await userEvent.type(screen.getByLabelText('AWS region'), 'us-east-1');
      await userEvent.click(screen.getByRole('button', { name: /continue with guided setup/i }));

      expect(await screen.findByRole('alert')).toHaveTextContent('disk full');
      expect(screen.queryByLabelText('Template path')).not.toBeInTheDocument();

      await userEvent.click(screen.getByRole('button', { name: /retry/i }));

      expect(await screen.findByLabelText('Template path')).toHaveValue('/tmp/iam-bootstrap-rendered.yaml');
      expect(hyveonMock.wizard.guidedIamPrepareTemplate).toHaveBeenCalledTimes(2);
    });

    it('should open the AWS console and show a success message when opened', async () => {
      stubHappyPathDefaults();
      render(<GuidedIamStep onComplete={vi.fn()} onSkipToManual={vi.fn()} />);

      await userEvent.type(screen.getByLabelText('AWS region'), 'us-east-1');
      await userEvent.click(screen.getByRole('button', { name: /continue with guided setup/i }));
      await screen.findByLabelText('Template path');

      await userEvent.click(screen.getByRole('button', { name: /open aws console/i }));

      expect(await screen.findByText(/opened in your default browser/i)).toBeInTheDocument();
      expect(hyveonMock.wizard.guidedIamOpenConsole).toHaveBeenCalledWith({ region: 'us-east-1' });
    });

    it('should show the console URL as text when the browser could not be opened', async () => {
      stubHappyPathDefaults();
      hyveonMock.wizard.guidedIamOpenConsole.mockResolvedValue({
        opened: false,
        url: 'https://us-east-1.console.aws.amazon.com/cloudformation/home?region=us-east-1#/stacks/create',
      });
      render(<GuidedIamStep onComplete={vi.fn()} onSkipToManual={vi.fn()} />);

      await userEvent.type(screen.getByLabelText('AWS region'), 'us-east-1');
      await userEvent.click(screen.getByRole('button', { name: /continue with guided setup/i }));
      await screen.findByLabelText('Template path');

      await userEvent.click(screen.getByRole('button', { name: /open aws console/i }));

      expect(
        await screen.findByDisplayValue(
          'https://us-east-1.console.aws.amazon.com/cloudformation/home?region=us-east-1#/stacks/create',
        ),
      ).toBeInTheDocument();
    });

    it('should surface a console-open error inline without blocking "Continue to key entry"', async () => {
      stubHappyPathDefaults();
      hyveonMock.wizard.guidedIamOpenConsole.mockRejectedValue(new Error('failed to launch browser'));
      render(<GuidedIamStep onComplete={vi.fn()} onSkipToManual={vi.fn()} />);

      await userEvent.type(screen.getByLabelText('AWS region'), 'us-east-1');
      await userEvent.click(screen.getByRole('button', { name: /continue with guided setup/i }));
      await screen.findByLabelText('Template path');

      await userEvent.click(screen.getByRole('button', { name: /open aws console/i }));

      expect(await screen.findByRole('alert')).toHaveTextContent('failed to launch browser');
      expect(screen.getByRole('button', { name: /continue to key entry/i })).toBeEnabled();
    });

    it('should persist awaiting-key-intake and move to the intake form on "Continue to key entry"', async () => {
      stubHappyPathDefaults();
      render(<GuidedIamStep onComplete={vi.fn()} onSkipToManual={vi.fn()} />);

      await userEvent.type(screen.getByLabelText('AWS region'), 'us-east-1');
      await userEvent.click(screen.getByRole('button', { name: /continue with guided setup/i }));
      await screen.findByLabelText('Template path');

      await userEvent.click(screen.getByRole('button', { name: /continue to key entry/i }));

      expect(await screen.findByLabelText('Access key ID')).toBeInTheDocument();
      expect(hyveonMock.wizard.saveProgress).toHaveBeenCalledWith({
        step: 'guided-iam',
        guidedIam: { subState: 'awaiting-key-intake', hasBootstrapKey: false },
      });
    });
  });

  describe('key intake and rotation', () => {
    it('should validate the key, persist rotation-pending, rotate, and call onComplete on success', async () => {
      stubHappyPathDefaults();
      const onComplete = vi.fn();
      render(<GuidedIamStep onComplete={onComplete} onSkipToManual={vi.fn()} />);

      await advanceToIntake();
      await userEvent.type(screen.getByLabelText('Access key ID'), 'AKIAEXAMPLE');
      await userEvent.type(screen.getByLabelText('Secret access key'), 'super-secret-value');
      await userEvent.click(screen.getByRole('button', { name: /validate and rotate key/i }));

      await waitFor(() =>
        expect(hyveonMock.wizard.guidedIamSubmitBootstrapKey).toHaveBeenCalledWith({
          accessKeyId: 'AKIAEXAMPLE',
          secretAccessKey: 'super-secret-value',
          region: 'us-east-1',
        }),
      );
      await waitFor(() =>
        expect(hyveonMock.wizard.saveProgress).toHaveBeenCalledWith({
          step: 'guided-iam',
          guidedIam: { subState: 'rotation-pending', hasBootstrapKey: true },
        }),
      );
      await waitFor(() =>
        expect(hyveonMock.wizard.guidedIamRotate).toHaveBeenCalledWith({
          bootstrapAccessKeyId: 'AKIAEXAMPLE',
          bootstrapSecretAccessKey: 'super-secret-value',
          region: 'us-east-1',
        }),
      );
      await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
      await waitFor(() =>
        expect(hyveonMock.wizard.saveProgress).toHaveBeenCalledWith({
          step: 'guided-iam',
          guidedIam: { subState: 'complete', hasBootstrapKey: false },
        }),
      );

      // The secret must never appear in any saveProgress call.
      for (const call of hyveonMock.wizard.saveProgress.mock.calls) {
        expect(JSON.stringify(call)).not.toMatch(/super-secret-value|AKIAEXAMPLE/);
      }
    });

    it('should show an inline error and stay on the intake screen when key validation fails', async () => {
      stubHappyPathDefaults();
      hyveonMock.wizard.guidedIamSubmitBootstrapKey.mockRejectedValue(new Error('invalid bootstrap key'));
      render(<GuidedIamStep onComplete={vi.fn()} onSkipToManual={vi.fn()} />);

      await advanceToIntake();
      await userEvent.type(screen.getByLabelText('Access key ID'), 'AKIAEXAMPLE');
      await userEvent.type(screen.getByLabelText('Secret access key'), 'super-secret-value');
      await userEvent.click(screen.getByRole('button', { name: /validate and rotate key/i }));

      expect(await screen.findByRole('alert')).toHaveTextContent('invalid bootstrap key');
      expect(hyveonMock.wizard.guidedIamRotate).not.toHaveBeenCalled();
      expect(screen.getByLabelText('Access key ID')).toBeInTheDocument();
    });
  });

  describe('rotation outcomes', () => {
    it('should render a distinct verification-failed screen and retry with the same key on demand', async () => {
      stubHappyPathDefaults();
      hyveonMock.wizard.guidedIamRotate
        .mockResolvedValueOnce({ status: 'verification-failed', error: 'sts:GetCallerIdentity failed' })
        .mockResolvedValueOnce({ status: 'complete' });
      const onComplete = vi.fn();
      render(<GuidedIamStep onComplete={onComplete} onSkipToManual={vi.fn()} />);

      await advanceToIntake();
      await userEvent.type(screen.getByLabelText('Access key ID'), 'AKIAEXAMPLE');
      await userEvent.type(screen.getByLabelText('Secret access key'), 'super-secret-value');
      await userEvent.click(screen.getByRole('button', { name: /validate and rotate key/i }));

      expect(await screen.findByRole('alert')).toHaveTextContent('sts:GetCallerIdentity failed');
      expect(screen.getByRole('button', { name: /retry rotation/i })).toBeInTheDocument();
      // Not re-shown: retry does not re-intake, so there is no key-entry form on this screen.
      expect(screen.queryByLabelText('Access key ID')).not.toBeInTheDocument();

      await userEvent.click(screen.getByRole('button', { name: /retry rotation/i }));

      await waitFor(() => expect(hyveonMock.wizard.guidedIamSubmitBootstrapKey).toHaveBeenCalledTimes(1));
      await waitFor(() =>
        expect(hyveonMock.wizard.guidedIamRotate).toHaveBeenNthCalledWith(2, {
          bootstrapAccessKeyId: 'AKIAEXAMPLE',
          bootstrapSecretAccessKey: 'super-secret-value',
          region: 'us-east-1',
        }),
      );
      await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
    });

    it('should leave the persisted sub-state at rotation-pending on a verification-failed outcome', async () => {
      stubHappyPathDefaults();
      hyveonMock.wizard.guidedIamRotate.mockResolvedValue({ status: 'verification-failed', error: 'nope' });
      render(<GuidedIamStep onComplete={vi.fn()} onSkipToManual={vi.fn()} />);

      await advanceToIntake();
      await userEvent.type(screen.getByLabelText('Access key ID'), 'AKIAEXAMPLE');
      await userEvent.type(screen.getByLabelText('Secret access key'), 'super-secret-value');
      await userEvent.click(screen.getByRole('button', { name: /validate and rotate key/i }));

      await screen.findByRole('alert');
      const callCountAtFailure = hyveonMock.wizard.saveProgress.mock.calls.length;
      const lastCall = hyveonMock.wizard.saveProgress.mock.calls.at(-1)?.[0];

      // The most recent persisted sub-state is still `rotation-pending` (from
      // the intake success handler) — the verification-failed outcome itself
      // makes no further saveProgress call.
      expect(lastCall).toEqual({
        step: 'guided-iam',
        guidedIam: { subState: 'rotation-pending', hasBootstrapKey: true },
      });

      // Give any stray microtask a chance to run, then confirm the call count didn't move.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(hyveonMock.wizard.saveProgress).toHaveBeenCalledTimes(callCountAtFailure);
    });

    it('should render a distinct delete-failed screen with a Revoke action and console URL', async () => {
      stubHappyPathDefaults();
      hyveonMock.wizard.guidedIamRotate.mockResolvedValue({
        status: 'delete-failed',
        consoleUrl: 'https://console.aws.amazon.com/iam/home#/security_credentials',
      });
      render(<GuidedIamStep onComplete={vi.fn()} onSkipToManual={vi.fn()} />);

      await advanceToIntake();
      await userEvent.type(screen.getByLabelText('Access key ID'), 'AKIAEXAMPLE');
      await userEvent.type(screen.getByLabelText('Secret access key'), 'super-secret-value');
      await userEvent.click(screen.getByRole('button', { name: /validate and rotate key/i }));

      expect(await screen.findByText(/still active/i)).toBeInTheDocument();
      expect(
        screen.getByRole('link', { name: 'https://console.aws.amazon.com/iam/home#/security_credentials' }),
      ).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /revoke now/i })).toBeInTheDocument();
      // No bypass: onComplete must not be reachable from this screen except via a successful revoke.
      expect(screen.queryByRole('button', { name: /continue without revoking/i })).not.toBeInTheDocument();
    });

    it('should call onComplete and persist complete when Revoke now succeeds', async () => {
      stubHappyPathDefaults();
      hyveonMock.wizard.guidedIamRotate.mockResolvedValue({
        status: 'delete-failed',
        consoleUrl: 'https://console.aws.amazon.com/iam/home#/security_credentials',
      });
      hyveonMock.wizard.guidedIamRevokeBootstrapKey.mockResolvedValue({ revoked: true });
      const onComplete = vi.fn();
      render(<GuidedIamStep onComplete={onComplete} onSkipToManual={vi.fn()} />);

      await advanceToIntake();
      await userEvent.type(screen.getByLabelText('Access key ID'), 'AKIAEXAMPLE');
      await userEvent.type(screen.getByLabelText('Secret access key'), 'super-secret-value');
      await userEvent.click(screen.getByRole('button', { name: /validate and rotate key/i }));
      await screen.findByRole('button', { name: /revoke now/i });

      await userEvent.click(screen.getByRole('button', { name: /revoke now/i }));

      expect(hyveonMock.wizard.guidedIamRevokeBootstrapKey).toHaveBeenCalledWith({
        bootstrapAccessKeyId: 'AKIAEXAMPLE',
        region: 'us-east-1',
      });
      await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
    });

    it('should show a message and allow retrying Revoke now after a failure, with no other way to reach onComplete', async () => {
      stubHappyPathDefaults();
      hyveonMock.wizard.guidedIamRotate.mockResolvedValue({
        status: 'delete-failed',
        consoleUrl: 'https://console.aws.amazon.com/iam/home#/security_credentials',
      });
      hyveonMock.wizard.guidedIamRevokeBootstrapKey
        .mockResolvedValueOnce({ revoked: false, message: 'access denied' })
        .mockResolvedValueOnce({ revoked: true });
      const onComplete = vi.fn();
      render(<GuidedIamStep onComplete={onComplete} onSkipToManual={vi.fn()} />);

      await advanceToIntake();
      await userEvent.type(screen.getByLabelText('Access key ID'), 'AKIAEXAMPLE');
      await userEvent.type(screen.getByLabelText('Secret access key'), 'super-secret-value');
      await userEvent.click(screen.getByRole('button', { name: /validate and rotate key/i }));
      await screen.findByRole('button', { name: /revoke now/i });

      await userEvent.click(screen.getByRole('button', { name: /revoke now/i }));

      expect(await screen.findByRole('alert')).toHaveTextContent('access denied');
      expect(onComplete).not.toHaveBeenCalled();
      expect(screen.queryByRole('button', { name: /continue without revoking/i })).not.toBeInTheDocument();

      // Retry the exact same action — same in-memory bootstrap key — and this time it succeeds.
      await userEvent.click(screen.getByRole('button', { name: /revoke now/i }));

      await waitFor(() => expect(hyveonMock.wizard.guidedIamRevokeBootstrapKey).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
    });
  });

  describe('resume semantics', () => {
    it('should resume directly into the intake screen with a banner and pre-filled region when a region is recoverable', async () => {
      hyveonMock.wizard.getState.mockResolvedValue({ wizardCompleted: false, aws: { region: 'eu-west-1' } });

      render(
        <GuidedIamStep
          onComplete={vi.fn()}
          onSkipToManual={vi.fn()}
          initialProgress={{ subState: 'rotation-pending', hasBootstrapKey: true }}
        />,
      );

      expect(await screen.findByLabelText('Access key ID')).toBeInTheDocument();
      expect(screen.getByText(/previously submitted/i)).toBeInTheDocument();
      expect(screen.getByLabelText('AWS region')).toHaveValue('eu-west-1');
      // Never the region/choice screen — landing there would regress the persisted sub-state.
      expect(screen.queryByRole('button', { name: /continue with guided setup/i })).not.toBeInTheDocument();
    });

    it('should land directly on the intake screen — never the region screen — when rotation-pending resumes with no recoverable region', async () => {
      // The realistic "operator quit mid-rotation" case: `GuidedIamService.rotate()`
      // only writes `aws.region` at its step 4, after verification succeeds, so a
      // quit between intake and rotation settling (or on `verification-failed`)
      // leaves `aws.region` unset. Falling back to the region/choice screen here
      // would regress the persisted sub-state back to `not-started` on the next
      // "Continue with guided setup" click — this must never happen.
      hyveonMock.wizard.getState.mockResolvedValue({ wizardCompleted: false });

      render(
        <GuidedIamStep
          onComplete={vi.fn()}
          onSkipToManual={vi.fn()}
          initialProgress={{ subState: 'rotation-pending', hasBootstrapKey: true }}
        />,
      );

      expect(await screen.findByLabelText('Access key ID')).toBeInTheDocument();
      expect(screen.getByText(/previously submitted/i)).toBeInTheDocument();
      expect(screen.getByLabelText('AWS region')).toHaveValue('');
      expect(screen.queryByRole('button', { name: /continue with guided setup/i })).not.toBeInTheDocument();
    });

    it('should let the operator complete rotation after filling in a region that could not be recovered on a rotation-pending resume', async () => {
      stubHappyPathDefaults();
      hyveonMock.wizard.getState.mockResolvedValue({ wizardCompleted: false });
      const onComplete = vi.fn();

      render(
        <GuidedIamStep
          onComplete={onComplete}
          onSkipToManual={vi.fn()}
          initialProgress={{ subState: 'rotation-pending', hasBootstrapKey: true }}
        />,
      );

      await screen.findByLabelText('Access key ID');
      await userEvent.type(screen.getByLabelText('AWS region'), 'ap-southeast-2');
      await userEvent.type(screen.getByLabelText('Access key ID'), 'AKIAEXAMPLE');
      await userEvent.type(screen.getByLabelText('Secret access key'), 'super-secret-value');
      await userEvent.click(screen.getByRole('button', { name: /validate and rotate key/i }));

      await waitFor(() =>
        expect(hyveonMock.wizard.guidedIamSubmitBootstrapKey).toHaveBeenCalledWith({
          accessKeyId: 'AKIAEXAMPLE',
          secretAccessKey: 'super-secret-value',
          region: 'ap-southeast-2',
        }),
      );
      await waitFor(() =>
        expect(hyveonMock.wizard.guidedIamRotate).toHaveBeenCalledWith({
          bootstrapAccessKeyId: 'AKIAEXAMPLE',
          bootstrapSecretAccessKey: 'super-secret-value',
          region: 'ap-southeast-2',
        }),
      );
      await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
    });

    it('should resume directly into the template screen when subState is template-written', async () => {
      stubHappyPathDefaults();
      hyveonMock.wizard.getState.mockResolvedValue({ wizardCompleted: false, aws: { region: 'eu-west-1' } });

      render(
        <GuidedIamStep
          onComplete={vi.fn()}
          onSkipToManual={vi.fn()}
          initialProgress={{ subState: 'template-written', hasBootstrapKey: false }}
        />,
      );

      expect(await screen.findByLabelText('Template path')).toBeInTheDocument();
      expect(screen.queryByLabelText('AWS region')).not.toBeInTheDocument();
      expect(hyveonMock.wizard.guidedIamPrepareTemplate).toHaveBeenCalledTimes(1);
    });

    it('should resume directly into the template screen when subState is awaiting-key-intake', async () => {
      stubHappyPathDefaults();
      hyveonMock.wizard.getState.mockResolvedValue({ wizardCompleted: false, aws: { region: 'eu-west-1' } });

      render(
        <GuidedIamStep
          onComplete={vi.fn()}
          onSkipToManual={vi.fn()}
          initialProgress={{ subState: 'awaiting-key-intake', hasBootstrapKey: false }}
        />,
      );

      expect(await screen.findByLabelText('Template path')).toBeInTheDocument();
    });

    it('should fall back to the region screen when no region can be recovered on resume', async () => {
      hyveonMock.wizard.getState.mockResolvedValue({ wizardCompleted: false });

      render(
        <GuidedIamStep
          onComplete={vi.fn()}
          onSkipToManual={vi.fn()}
          initialProgress={{ subState: 'template-written', hasBootstrapKey: false }}
        />,
      );

      expect(await screen.findByLabelText('AWS region')).toBeInTheDocument();
      expect(screen.getByText(/resuming a previous session/i)).toBeInTheDocument();
    });

    it('should start fresh from the region screen when initialProgress is absent', () => {
      render(<GuidedIamStep onComplete={vi.fn()} onSkipToManual={vi.fn()} />);

      expect(screen.getByLabelText('AWS region')).toBeInTheDocument();
      expect(hyveonMock.wizard.getState).not.toHaveBeenCalled();
    });

    it('should start fresh from the region screen when subState is not-started', () => {
      render(
        <GuidedIamStep
          onComplete={vi.fn()}
          onSkipToManual={vi.fn()}
          initialProgress={{ subState: 'not-started', hasBootstrapKey: false }}
        />,
      );

      expect(screen.getByLabelText('AWS region')).toBeInTheDocument();
      expect(hyveonMock.wizard.getState).not.toHaveBeenCalled();
    });
  });
});
