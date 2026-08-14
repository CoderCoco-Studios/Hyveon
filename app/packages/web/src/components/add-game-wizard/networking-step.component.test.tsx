import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NetworkingStep } from './networking-step.component.js';
import { createEmptyWizardDraft, type WizardDraftPort } from './wizard-form.utils.js';

/** Two-row port fixture used across most cases below. */
function makePorts(): WizardDraftPort[] {
  return [
    { container: 25565, protocol: 'tcp', visibility: 'public' },
    { container: 25566, protocol: 'udp', visibility: 'public' },
  ];
}

/** Disabled health-check draft shared by every case below that isn't specifically testing the health-check block. */
const DISABLED_HEALTH_CHECK = createEmptyWizardDraft().healthCheck;

describe('NetworkingStep', () => {
  it('should render "No ports configured yet" when the ports array is empty', () => {
    render(<NetworkingStep ports={[]} issues={[]} onChange={vi.fn()} https={false} onHttpsChange={vi.fn()}
        healthCheck={DISABLED_HEALTH_CHECK}
        onHealthCheckChange={vi.fn()} />);

    expect(screen.getByText('No ports configured yet.')).toBeInTheDocument();
  });

  it('should append a blank row when "Add port" is clicked', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <NetworkingStep
        ports={makePorts()}
        issues={[]}
        onChange={onChange}
        https={false}
        onHttpsChange={vi.fn()}
        healthCheck={DISABLED_HEALTH_CHECK}
        onHealthCheckChange={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Add port' }));

    expect(onChange).toHaveBeenCalledWith([
      { container: 25565, protocol: 'tcp', visibility: 'public' },
      { container: 25566, protocol: 'udp', visibility: 'public' },
      { container: null, protocol: 'tcp', visibility: 'public' },
    ]);
  });

  it('should remove the corresponding row when its "Remove" button is clicked', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <NetworkingStep
        ports={makePorts()}
        issues={[]}
        onChange={onChange}
        https={false}
        onHttpsChange={vi.fn()}
        healthCheck={DISABLED_HEALTH_CHECK}
        onHealthCheckChange={vi.fn()}
      />,
    );

    const removeButtons = screen.getAllByRole('button', { name: /Remove port/ });
    await user.click(removeButtons[0]);

    expect(onChange).toHaveBeenCalledWith([{ container: 25566, protocol: 'udp', visibility: 'public' }]);
  });

  it('should update the container port for the edited row when its number input changes', () => {
    const onChange = vi.fn();
    render(
      <NetworkingStep
        ports={makePorts()}
        issues={[]}
        onChange={onChange}
        https={false}
        onHttpsChange={vi.fn()}
        healthCheck={DISABLED_HEALTH_CHECK}
        onHealthCheckChange={vi.fn()}
      />,
    );

    const containerInput = screen.getByLabelText('Container port', {
      selector: '#port-container-1',
    });
    fireEvent.change(containerInput, { target: { value: '9000' } });

    expect(onChange).toHaveBeenCalledWith([
      { container: 25565, protocol: 'tcp', visibility: 'public' },
      { container: 9000, protocol: 'udp', visibility: 'public' },
    ]);
  });

  it('should update the protocol for the edited row when its select changes', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <NetworkingStep
        ports={makePorts()}
        issues={[]}
        onChange={onChange}
        https={false}
        onHttpsChange={vi.fn()}
        healthCheck={DISABLED_HEALTH_CHECK}
        onHealthCheckChange={vi.fn()}
      />,
    );

    const protocolSelect = screen.getByLabelText('Protocol', { selector: '#port-protocol-0' });
    await user.selectOptions(protocolSelect, 'udp');

    expect(onChange).toHaveBeenCalledWith([
      { container: 25565, protocol: 'udp', visibility: 'public' },
      { container: 25566, protocol: 'udp', visibility: 'public' },
    ]);
  });

  it('should update the visibility for the edited row when its select changes to "internal"', () => {
    const onChange = vi.fn();
    render(
      <NetworkingStep
        ports={makePorts()}
        issues={[]}
        onChange={onChange}
        https={false}
        onHttpsChange={vi.fn()}
        healthCheck={DISABLED_HEALTH_CHECK}
        onHealthCheckChange={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText('Visibility', { selector: '#port-visibility-0' }), {
      target: { value: 'internal' },
    });

    expect(onChange).toHaveBeenCalledWith([
      { container: 25565, protocol: 'tcp', visibility: 'internal' },
      { container: 25566, protocol: 'udp', visibility: 'public' },
    ]);
  });

  it('should highlight only the second row when the error path is ports[1]', () => {
    render(
      <NetworkingStep
        ports={makePorts()}
        issues={[{ path: 'ports[1]', message: 'Port 25566/udp collides with ports[0].' }]}
        onChange={vi.fn()}
        https={false}
        onHttpsChange={vi.fn()}
        healthCheck={DISABLED_HEALTH_CHECK}
        onHealthCheckChange={vi.fn()}
      />,
    );

    const firstRow = screen.getByTestId('port-row-0');
    const secondRow = screen.getByTestId('port-row-1');

    expect(firstRow.className).not.toContain('border-[var(--color-red)]');
    expect(secondRow.className).toContain('border-[var(--color-red)]');
    expect(screen.getByRole('alert')).toHaveTextContent('Port 25566/udp collides with ports[0].');
  });

  it('should highlight the row and surface the message when the error path is a field-level ports[N].field', () => {
    render(
      <NetworkingStep
        ports={makePorts()}
        issues={[{ path: 'ports[0].container', message: 'Expected number, received null' }]}
        onChange={vi.fn()}
        https={false}
        onHttpsChange={vi.fn()}
        healthCheck={DISABLED_HEALTH_CHECK}
        onHealthCheckChange={vi.fn()}
      />,
    );

    const firstRow = screen.getByTestId('port-row-0');
    const secondRow = screen.getByTestId('port-row-1');

    expect(firstRow.className).toContain('border-[var(--color-red)]');
    expect(secondRow.className).not.toContain('border-[var(--color-red)]');
    expect(screen.getByRole('alert')).toHaveTextContent('Expected number, received null');
  });

  describe('HTTPS toggle', () => {
    it('should render unchecked and without a callout by default', () => {
      render(<NetworkingStep ports={makePorts()} issues={[]} onChange={vi.fn()} https={false} onHttpsChange={vi.fn()}
        healthCheck={DISABLED_HEALTH_CHECK}
        onHealthCheckChange={vi.fn()} />);

      expect(screen.getByLabelText('Enable HTTPS (Caddy sidecar)')).not.toBeChecked();
      expect(screen.queryByText(/opens ports 443 and 80/)).not.toBeInTheDocument();
    });

    it('should fire onHttpsChange with true when the toggle is checked', async () => {
      const user = userEvent.setup();
      const onHttpsChange = vi.fn();
      render(
        <NetworkingStep
          ports={makePorts()}
          issues={[]}
          onChange={vi.fn()}
          https={false}
          onHttpsChange={onHttpsChange}
        healthCheck={DISABLED_HEALTH_CHECK}
        onHealthCheckChange={vi.fn()}
        />,
      );

      await user.click(screen.getByLabelText('Enable HTTPS (Caddy sidecar)'));

      expect(onHttpsChange).toHaveBeenCalledWith(true);
    });

    it('should fire onHttpsChange with false when an enabled toggle is unchecked', async () => {
      const user = userEvent.setup();
      const onHttpsChange = vi.fn();
      render(
        <NetworkingStep
          ports={makePorts()}
          issues={[]}
          onChange={vi.fn()}
          https={true}
          onHttpsChange={onHttpsChange}
        healthCheck={DISABLED_HEALTH_CHECK}
        onHealthCheckChange={vi.fn()}
        />,
      );

      await user.click(screen.getByLabelText('Enable HTTPS (Caddy sidecar)'));

      expect(onHttpsChange).toHaveBeenCalledWith(false);
    });

    it('should render the warning callout, describing all three consequences, only when enabled', () => {
      render(
        <NetworkingStep ports={makePorts()} issues={[]} onChange={vi.fn()} https={true} onHttpsChange={vi.fn()}
        healthCheck={DISABLED_HEALTH_CHECK}
        onHealthCheckChange={vi.fn()} />,
      );

      const callout = screen.getByText(/opens ports 443 and 80/);
      expect(callout).toHaveTextContent('opens ports 443 and 80 to the internet for the whole stack');
      expect(callout).toHaveTextContent('loses its public ingress rule');
      expect(callout).toHaveTextContent("Let's Encrypt (ACME) issuance");
    });

    it('should reference the callout via aria-describedby on the toggle while it is shown', () => {
      render(
        <NetworkingStep ports={makePorts()} issues={[]} onChange={vi.fn()} https={true} onHttpsChange={vi.fn()}
        healthCheck={DISABLED_HEALTH_CHECK}
        onHealthCheckChange={vi.fn()} />,
      );

      const toggle = screen.getByLabelText('Enable HTTPS (Caddy sidecar)');
      expect(toggle).toHaveAttribute('aria-describedby', expect.stringContaining('https-callout'));
    });

    it('should mark the toggle invalid and surface the message when the no-ports HTTPS rule is violated', () => {
      render(
        <NetworkingStep
          ports={[]}
          issues={[{ path: 'ports', message: 'An https = true game server must declare at least one port.' }]}
          onChange={vi.fn()}
          https={true}
          onHttpsChange={vi.fn()}
        healthCheck={DISABLED_HEALTH_CHECK}
        onHealthCheckChange={vi.fn()}
        />,
      );

      const toggle = screen.getByLabelText('Enable HTTPS (Caddy sidecar)');
      expect(toggle).toHaveAttribute('aria-invalid', 'true');
      expect(toggle).toHaveAttribute('aria-describedby', expect.stringContaining('https-error'));
      expect(screen.getByText('An https = true game server must declare at least one port.')).toBeInTheDocument();
    });
  });
});
