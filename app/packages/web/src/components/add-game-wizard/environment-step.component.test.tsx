import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EnvironmentStep } from './environment-step.component.js';
import type { WizardDraft } from './wizard-form.utils.js';

/** Builds a minimal draft for the Environment step; only `environment` matters here. */
function makeDraft(overrides: Partial<WizardDraft> = {}): WizardDraft {
  return {
    name: 'minecraft',
    image: 'itzg/minecraft-server',
    connect_message: '',
    cpu: 1024,
    memory: 2048,
    ports: [],
    volumes: [],
    file_seeds: [],
    environment: [],
    https: false,
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
});
