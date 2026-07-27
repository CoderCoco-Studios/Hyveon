import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { TerraformInitConfig } from '@hyveon/desktop-preload';

const hyveonMock = {
  terraform: {
    init: vi.fn(),
  },
  wizard: {
    complete: vi.fn(),
  },
};
vi.stubGlobal('hyveon', hyveonMock);

import { TerraformInitStep } from './terraform-init-step.component.js';

const BACKEND_CONFIG: TerraformInitConfig = {
  bucket: 'hyveon-tfstate',
  region: 'us-east-1',
  dynamodbTable: 'hyveon-tflock',
};

beforeEach(() => {
  hyveonMock.terraform.init.mockReset();
  hyveonMock.wizard.complete.mockReset();
});

afterEach(() => {
  cleanup();
});

describe('TerraformInitStep', () => {
  it('should stream chunks from hyveon.terraform.init and render them', async () => {
    hyveonMock.terraform.init.mockImplementation(async function* () {
      yield { stream: 'stdout', line: 'Initializing the backend...' };
      yield { stream: 'stdout', line: 'Terraform has been successfully initialized!' };
    });

    render(<TerraformInitStep backendConfig={BACKEND_CONFIG} onFinished={vi.fn()} />);

    expect(await screen.findByText('Initializing the backend...')).toBeInTheDocument();
    expect(await screen.findByText('Terraform has been successfully initialized!')).toBeInTheDocument();
    expect(hyveonMock.terraform.init).toHaveBeenCalledWith(BACKEND_CONFIG, expect.any(AbortSignal));
  });

  it('should render ANSI-colored output', async () => {
    hyveonMock.terraform.init.mockImplementation(async function* () {
      yield { stream: 'stdout', line: '\x1b[32msuccess\x1b[0m' };
    });

    render(<TerraformInitStep backendConfig={BACKEND_CONFIG} onFinished={vi.fn()} />);

    const el = await screen.findByText('success');
    expect(el).toHaveClass('text-[var(--color-green)]');
  });

  it('should enable Finish setup only once the run exits successfully', async () => {
    hyveonMock.terraform.init.mockImplementation(async function* () {
      yield { stream: 'stdout', line: 'Terraform has been successfully initialized!' };
    });

    render(<TerraformInitStep backendConfig={BACKEND_CONFIG} onFinished={vi.fn()} />);

    await waitFor(() => expect(screen.getByRole('button', { name: /finish setup/i })).toBeEnabled());
    expect(screen.getByText(/terraform init complete/i)).toBeInTheDocument();
  });

  it('should keep Finish setup disabled while the run is in progress', () => {
    // eslint-disable-next-line require-yield -- generator intentionally never yields/returns to keep the run "in progress" for this test
    hyveonMock.terraform.init.mockImplementation(async function* () {
      await new Promise(() => {});
    });

    render(<TerraformInitStep backendConfig={BACKEND_CONFIG} onFinished={vi.fn()} />);

    expect(screen.getByRole('button', { name: /finish setup/i })).toBeDisabled();
  });

  it('should show captured log and a retry affordance when the run fails (non-zero exit)', async () => {
    hyveonMock.terraform.init.mockImplementation(async function* () {
      yield { stream: 'stderr', line: 'Error: failed to read backend config' };
      throw new Error('terraform init exited with code 1');
    });

    render(<TerraformInitStep backendConfig={BACKEND_CONFIG} onFinished={vi.fn()} />);

    expect(await screen.findByText('Error: failed to read backend config')).toBeInTheDocument();
    expect(await screen.findByRole('alert')).toHaveTextContent('terraform init exited with code 1');
    expect(screen.getByRole('button', { name: /finish setup/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });

  it('should re-invoke hyveon.terraform.init when Retry is clicked after a failure', async () => {
    hyveonMock.terraform.init
      // eslint-disable-next-line require-yield -- generator must throw before yielding to simulate a failed first attempt
      .mockImplementationOnce(async function* () {
        throw new Error('first attempt failed');
      })
      .mockImplementationOnce(async function* () {
        yield { stream: 'stdout', line: 'Terraform has been successfully initialized!' };
      });

    render(<TerraformInitStep backendConfig={BACKEND_CONFIG} onFinished={vi.fn()} />);
    await screen.findByRole('alert');

    await userEvent.click(screen.getByRole('button', { name: /retry/i }));

    await waitFor(() => expect(screen.getByRole('button', { name: /finish setup/i })).toBeEnabled());
    expect(hyveonMock.terraform.init).toHaveBeenCalledTimes(2);
  });

  it('should call wizard.complete and onFinished when Finish setup is clicked', async () => {
    hyveonMock.terraform.init.mockImplementation(async function* () {
      yield { stream: 'stdout', line: 'Terraform has been successfully initialized!' };
    });
    hyveonMock.wizard.complete.mockResolvedValue({ wizardCompleted: true });
    const onFinished = vi.fn();

    render(<TerraformInitStep backendConfig={BACKEND_CONFIG} onFinished={onFinished} />);
    await waitFor(() => expect(screen.getByRole('button', { name: /finish setup/i })).toBeEnabled());

    await userEvent.click(screen.getByRole('button', { name: /finish setup/i }));

    await waitFor(() => expect(hyveonMock.wizard.complete).toHaveBeenCalledTimes(1));
    expect(onFinished).toHaveBeenCalledTimes(1);
  });

  it('should show an error and not call onFinished when wizard.complete fails', async () => {
    hyveonMock.terraform.init.mockImplementation(async function* () {
      yield { stream: 'stdout', line: 'Terraform has been successfully initialized!' };
    });
    hyveonMock.wizard.complete.mockRejectedValue(new Error('disk full'));
    const onFinished = vi.fn();

    render(<TerraformInitStep backendConfig={BACKEND_CONFIG} onFinished={onFinished} />);
    await waitFor(() => expect(screen.getByRole('button', { name: /finish setup/i })).toBeEnabled());

    await userEvent.click(screen.getByRole('button', { name: /finish setup/i }));

    expect(await screen.findByText('disk full')).toBeInTheDocument();
    expect(onFinished).not.toHaveBeenCalled();
  });
});
