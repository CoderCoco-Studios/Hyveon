import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EnvironmentStep } from './environment-step.component.js';
import { createEmptyWizardDraft, type WizardDraft } from './wizard-form.utils.js';

/** Builds a minimal draft for the Environment step; only `environment` matters here. */
function makeDraft(overrides: Partial<WizardDraft> = {}): WizardDraft {
  return {
    ...createEmptyWizardDraft(),
    name: 'minecraft',
    image: 'itzg/minecraft-server',
    cpu: 1024,
    memory: 2048,
    ...overrides,
  };
}

describe('EnvironmentStep', () => {
  it('should show an empty-state message when there are no rows', () => {
    render(<EnvironmentStep draft={makeDraft()} issues={[]} onChange={vi.fn()} />);

    expect(screen.getByText(/No environment variables configured/i)).toBeInTheDocument();
  });

  it('should call onChange with a new blank row appended when "Add variable" is clicked', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<EnvironmentStep draft={makeDraft()} issues={[]} onChange={onChange} />);

    await user.click(screen.getByRole('button', { name: 'Add variable' }));

    expect(onChange).toHaveBeenCalledWith({ environment: [{ name: '', value: '' }] });
  });

  it('should call onChange with the edited name when a name field is typed into', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <EnvironmentStep
        draft={makeDraft({ environment: [{ name: '', value: '' }] })}
        issues={[]}
        onChange={onChange}
      />,
    );

    await user.type(screen.getByLabelText('Variable name'), 'E');

    expect(onChange).toHaveBeenCalledWith({ environment: [{ name: 'E', value: '' }] });
  });

  it('should call onChange with the row removed when its Remove button is clicked', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <EnvironmentStep
        draft={makeDraft({
          environment: [
            { name: 'EULA', value: 'TRUE' },
            { name: 'DIFFICULTY', value: 'hard' },
          ],
        })}
        issues={[]}
        onChange={onChange}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Remove environment variable 1' }));

    expect(onChange).toHaveBeenCalledWith({ environment: [{ name: 'DIFFICULTY', value: 'hard' }] });
  });

  it('should render a validation issue message next to the offending row', () => {
    render(
      <EnvironmentStep
        draft={makeDraft({ environment: [{ name: '', value: 'TRUE' }] })}
        issues={[{ path: 'environment[0].name', message: 'environment[0].name must not be empty.' }]}
        onChange={vi.fn()}
      />,
    );

    expect(screen.getByText('environment[0].name must not be empty.')).toBeInTheDocument();
  });

  it('should render a value error next to the offending row', () => {
    render(
      <EnvironmentStep
        draft={makeDraft({ environment: [{ name: 'HOST', value: '${hyveon.network.public-adress}' }] })}
        issues={[{ path: 'environment[0].value', message: 'Unknown token "${hyveon.network.public-adress}" in environment[0].value; allowed tokens are ${hyveon.network.public-address} and ${hyveon.network.public-ipv4}.' }]}
        onChange={vi.fn()}
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('Unknown token');
    expect(screen.getByLabelText('Value')).toHaveAttribute('aria-invalid', 'true');
  });

  it('should show the interpolation token hint', () => {
    render(<EnvironmentStep draft={makeDraft()} issues={[]} onChange={vi.fn()} />);

    expect(screen.getByText(/\$\{hyveon\.network\.public-address\}/)).toBeInTheDocument();
    expect(screen.getByText(/\$\{hyveon\.network\.public-ipv4\}/)).toBeInTheDocument();
  });

  it('should call onChange with an appended command argument', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<EnvironmentStep draft={makeDraft()} issues={[]} onChange={onChange} />);

    await user.click(screen.getByRole('button', { name: 'Add argument' }));

    expect(onChange).toHaveBeenCalledWith({ command: [''] });
  });

  it('should render a command-level error when the ipv4 token requires a command', () => {
    render(
      <EnvironmentStep
        draft={makeDraft({ environment: [{ name: 'SERVER_IP', value: '${hyveon.network.public-ipv4}' }] })}
        issues={[{ path: 'command', message: 'command is required when ${hyveon.network.public-ipv4} is used: the boot-time IP resolver replaces the image\'s built-in start command.' }]}
        onChange={vi.fn()}
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('command is required');
  });
});
