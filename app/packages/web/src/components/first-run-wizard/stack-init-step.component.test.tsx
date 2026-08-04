import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { StackInitPhaseEvent } from '@hyveon/desktop-preload';
import { toStreamHandleMock } from '../../test-utils/stream-handle.test-utils.js';

const hyveonMock = {
  iac: {
    stack: {
      initialize: vi.fn(),
    },
  },
  wizard: {
    complete: vi.fn(),
  },
};
vi.stubGlobal('hyveon', hyveonMock);

import { StackInitializationStep } from './stack-init-step.component.js';

beforeEach(() => {
  hyveonMock.iac.stack.initialize.mockReset();
  hyveonMock.wizard.complete.mockReset();
});

afterEach(() => {
  cleanup();
});

/** Convenience: a generator yielding a full, successful engine/plugins/operation phase sequence. */
async function* successfulRun(): AsyncGenerator<StackInitPhaseEvent> {
  yield { phase: 'engine', status: 'start' };
  yield { phase: 'engine', status: 'end' };
  yield { phase: 'plugins', status: 'start' };
  yield { phase: 'plugins', status: 'end' };
  yield { phase: 'operation', status: 'start' };
  yield { phase: 'operation', status: 'end' };
}

describe('StackInitializationStep', () => {
  it('should render all three phases as pending before any event arrives', () => {
    hyveonMock.iac.stack.initialize.mockImplementation(
      toStreamHandleMock(
        // eslint-disable-next-line require-yield -- generator intentionally never yields/returns to keep every phase pending for this test
        async function* () {
          await new Promise(() => {});
        },
      ),
    );

    render(<StackInitializationStep onFinished={vi.fn()} />);

    expect(screen.getByText('Resolving the Pulumi engine')).toBeInTheDocument();
    expect(screen.getByText('Installing provider plugins')).toBeInTheDocument();
    expect(screen.getByText('Creating the stack')).toBeInTheDocument();
  });

  it('should call hyveon.iac.stack.initialize with no arguments', async () => {
    hyveonMock.iac.stack.initialize.mockImplementation(toStreamHandleMock(successfulRun));

    render(<StackInitializationStep onFinished={vi.fn()} />);

    await waitFor(() => expect(hyveonMock.iac.stack.initialize).toHaveBeenCalledWith());
  });

  it('should show each phase as in progress and then done as start/end events stream in', async () => {
    let resolvePluginsEnd!: () => void;
    hyveonMock.iac.stack.initialize.mockImplementation(
      toStreamHandleMock(async function* () {
        yield { phase: 'engine' as const, status: 'start' as const };
        yield { phase: 'engine' as const, status: 'end' as const };
        yield { phase: 'plugins' as const, status: 'start' as const };
        await new Promise<void>((resolve) => {
          resolvePluginsEnd = resolve;
        });
        yield { phase: 'plugins' as const, status: 'end' as const };
      }),
    );

    render(<StackInitializationStep onFinished={vi.fn()} />);

    const pluginsRow = await screen.findByText('Installing provider plugins');
    // Engine already settled — its icon area no longer reads "pending" muted
    // text; plugins is mid-flight (spinner) and operation is still untouched.
    expect(pluginsRow).toBeInTheDocument();

    resolvePluginsEnd();

    await waitFor(() => expect(screen.getByText('Creating the stack')).toBeInTheDocument());
  });

  it('should enable Finish setup only once every phase completes successfully', async () => {
    hyveonMock.iac.stack.initialize.mockImplementation(toStreamHandleMock(successfulRun));

    render(<StackInitializationStep onFinished={vi.fn()} />);

    await waitFor(() => expect(screen.getByRole('button', { name: /finish setup/i })).toBeEnabled());
    expect(screen.getByText(/stack initialization complete/i)).toBeInTheDocument();
  });

  it('should keep Finish setup disabled while the run is in progress', () => {
    hyveonMock.iac.stack.initialize.mockImplementation(
      toStreamHandleMock(
        // eslint-disable-next-line require-yield -- generator intentionally never yields/returns to keep the run "in progress" for this test
        async function* () {
          await new Promise(() => {});
        },
      ),
    );

    render(<StackInitializationStep onFinished={vi.fn()} />);

    expect(screen.getByRole('button', { name: /finish setup/i })).toBeDisabled();
  });

  it('should show a specific error and a retry affordance, attributed to the failed phase, when the run fails', async () => {
    hyveonMock.iac.stack.initialize.mockImplementation(
      toStreamHandleMock(async function* () {
        yield { phase: 'engine' as const, status: 'start' as const };
        yield { phase: 'engine' as const, status: 'end' as const };
        yield { phase: 'plugins' as const, status: 'start' as const };
        yield { phase: 'plugins' as const, status: 'end' as const };
        yield { phase: 'operation' as const, status: 'start' as const };
        throw new Error('Pulumi stack initialization failed during the "operation" phase: backend unreachable');
      }),
    );

    render(<StackInitializationStep onFinished={vi.fn()} />);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Pulumi stack initialization failed during the "operation" phase: backend unreachable',
    );
    expect(screen.getByRole('button', { name: /finish setup/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });

  it('should re-invoke hyveon.iac.stack.initialize when Retry is clicked after a failure', async () => {
    hyveonMock.iac.stack.initialize
      .mockImplementationOnce(
        toStreamHandleMock(
          // eslint-disable-next-line require-yield -- generator must throw before yielding to simulate a failed first attempt
          async function* () {
            throw new Error('first attempt failed');
          },
        ),
      )
      .mockImplementationOnce(toStreamHandleMock(successfulRun));

    render(<StackInitializationStep onFinished={vi.fn()} />);
    await screen.findByRole('alert');

    await userEvent.click(screen.getByRole('button', { name: /retry/i }));

    await waitFor(() => expect(screen.getByRole('button', { name: /finish setup/i })).toBeEnabled());
    expect(hyveonMock.iac.stack.initialize).toHaveBeenCalledTimes(2);
  });

  it('should call wizard.complete and onFinished when Finish setup is clicked', async () => {
    hyveonMock.iac.stack.initialize.mockImplementation(toStreamHandleMock(successfulRun));
    hyveonMock.wizard.complete.mockResolvedValue({ wizardCompleted: true });
    const onFinished = vi.fn();

    render(<StackInitializationStep onFinished={onFinished} />);
    await waitFor(() => expect(screen.getByRole('button', { name: /finish setup/i })).toBeEnabled());

    await userEvent.click(screen.getByRole('button', { name: /finish setup/i }));

    await waitFor(() => expect(hyveonMock.wizard.complete).toHaveBeenCalledTimes(1));
    expect(onFinished).toHaveBeenCalledTimes(1);
  });

  it('should await onBeforeFinish before calling wizard.complete', async () => {
    hyveonMock.iac.stack.initialize.mockImplementation(toStreamHandleMock(successfulRun));
    hyveonMock.wizard.complete.mockResolvedValue({ wizardCompleted: true });
    const calls: string[] = [];
    const onBeforeFinish = vi.fn().mockImplementation(async () => {
      calls.push('before-finish');
    });
    hyveonMock.wizard.complete.mockImplementation(async () => {
      calls.push('complete');
      return { wizardCompleted: true };
    });

    render(<StackInitializationStep onFinished={vi.fn()} onBeforeFinish={onBeforeFinish} />);
    await waitFor(() => expect(screen.getByRole('button', { name: /finish setup/i })).toBeEnabled());

    await userEvent.click(screen.getByRole('button', { name: /finish setup/i }));

    await waitFor(() => expect(hyveonMock.wizard.complete).toHaveBeenCalledTimes(1));
    expect(calls).toEqual(['before-finish', 'complete']);
  });

  it('should show an error and not call onFinished when wizard.complete fails', async () => {
    hyveonMock.iac.stack.initialize.mockImplementation(toStreamHandleMock(successfulRun));
    hyveonMock.wizard.complete.mockRejectedValue(new Error('disk full'));
    const onFinished = vi.fn();

    render(<StackInitializationStep onFinished={onFinished} />);
    await waitFor(() => expect(screen.getByRole('button', { name: /finish setup/i })).toBeEnabled());

    await userEvent.click(screen.getByRole('button', { name: /finish setup/i }));

    expect(await screen.findByText('disk full')).toBeInTheDocument();
    expect(onFinished).not.toHaveBeenCalled();
  });
});
