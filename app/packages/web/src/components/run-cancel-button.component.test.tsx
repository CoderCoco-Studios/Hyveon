import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RunCancelButton } from './run-cancel-button.component.js';

describe('RunCancelButton', () => {
  // @spec IAC-RUN-CANCEL-006
  it('should cancel a plan immediately, with no confirmation', async () => {
    const onCancel = vi.fn();
    render(<RunCancelButton kind="plan" cancelling={false} onCancel={onCancel} />);

    await userEvent.click(screen.getByRole('button', { name: 'Cancel plan' }));

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  // @spec IAC-RUN-CANCEL-006
  it.each(['apply', 'destroy'] as const)('should ask for confirmation before cancelling a %s', async (kind) => {
    const onCancel = vi.fn();
    render(<RunCancelButton kind={kind} cancelling={false} onCancel={onCancel} />);

    await userEvent.click(screen.getByRole('button', { name: `Cancel ${kind}` }));

    expect(await screen.findByRole('alertdialog')).toBeInTheDocument();
    expect(screen.getByText(`Cancel this ${kind}?`)).toBeInTheDocument();
    expect(screen.getByText(/can leave the infrastructure partially changed/)).toBeInTheDocument();
    expect(onCancel).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: `Stop ${kind}` }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  // @spec IAC-RUN-CANCEL-006
  it('should not cancel when the operator dismisses the confirmation', async () => {
    const onCancel = vi.fn();
    render(<RunCancelButton kind="apply" cancelling={false} onCancel={onCancel} />);

    await userEvent.click(screen.getByRole('button', { name: 'Cancel apply' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel' }));

    expect(onCancel).not.toHaveBeenCalled();
  });

  // @spec IAC-RUN-CANCEL-005
  it('should disable the button and say it is cancelling while the cancel is pending', () => {
    render(<RunCancelButton kind="destroy" cancelling onCancel={vi.fn()} />);

    expect(screen.getByRole('button', { name: /Cancelling/ })).toBeDisabled();
  });
});
