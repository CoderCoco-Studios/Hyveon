import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RollbackAction } from './rollback-action.component.js';

/** Stub for `window.hyveon.iac.rollback` — the only channel this component invokes. */
const hyveonMock = {
  iac: {
    rollback: {
      resolve: vi.fn(),
      confirm: vi.fn(),
    },
  },
};
vi.stubGlobal('hyveon', hyveonMock);

describe('RollbackAction', () => {
  beforeEach(() => {
    hyveonMock.iac.rollback.resolve.mockReset();
    hyveonMock.iac.rollback.confirm.mockReset();
  });

  it('should not call confirm until the operator confirms the dialog', async () => {
    hyveonMock.iac.rollback.resolve.mockResolvedValue({
      resolved: true,
      versionId: 'v-prior',
      lastModified: '2026-07-18T00:00:00.000Z',
    });
    const onRolledBack = vi.fn();
    render(<RollbackAction applyRunId="apply-1" onRolledBack={onRolledBack} />);

    await userEvent.click(screen.getByRole('button', { name: 'Rollback' }));

    await screen.findByRole('alertdialog');
    expect(hyveonMock.iac.rollback.confirm).not.toHaveBeenCalled();
    expect(onRolledBack).not.toHaveBeenCalled();
  });

  it('should close the dialog and call onRolledBack with the new versionId once confirm succeeds', async () => {
    hyveonMock.iac.rollback.resolve.mockResolvedValue({
      resolved: true,
      versionId: 'v-prior',
      lastModified: '2026-07-18T00:00:00.000Z',
    });
    hyveonMock.iac.rollback.confirm.mockResolvedValue({ confirmed: true, versionId: 'v-new-head' });
    const onRolledBack = vi.fn();
    render(<RollbackAction applyRunId="apply-1" onRolledBack={onRolledBack} />);

    await userEvent.click(screen.getByRole('button', { name: 'Rollback' }));
    await screen.findByRole('alertdialog');
    await userEvent.click(screen.getByRole('button', { name: 'Roll back' }));

    await waitFor(() =>
      expect(onRolledBack).toHaveBeenCalledWith({ versionId: 'v-new-head', rolledBackFrom: 'apply-1' }),
    );
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('should surface a confirm failure inline and never call onRolledBack', async () => {
    hyveonMock.iac.rollback.resolve.mockResolvedValue({
      resolved: true,
      versionId: 'v-prior',
      lastModified: '2026-07-18T00:00:00.000Z',
    });
    hyveonMock.iac.rollback.confirm.mockResolvedValue({
      confirmed: false,
      error: 'Historic tfvars version "v-prior" no longer exists — it may have expired. Nothing was written.',
    });
    const onRolledBack = vi.fn();
    render(<RollbackAction applyRunId="apply-1" onRolledBack={onRolledBack} />);

    await userEvent.click(screen.getByRole('button', { name: 'Rollback' }));
    await screen.findByRole('alertdialog');
    await userEvent.click(screen.getByRole('button', { name: 'Roll back' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/no longer exists/);
    expect(onRolledBack).not.toHaveBeenCalled();
  });

  it('should surface a resolve failure inline without opening the dialog', async () => {
    hyveonMock.iac.rollback.resolve.mockResolvedValue({
      resolved: false,
      error: 'No run record found for apply run "apply-1" — cannot roll it back.',
    });
    const onRolledBack = vi.fn();
    render(<RollbackAction applyRunId="apply-1" onRolledBack={onRolledBack} />);

    await userEvent.click(screen.getByRole('button', { name: 'Rollback' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/No run record found/);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(onRolledBack).not.toHaveBeenCalled();
  });

  it('should append the diff summary to the confirmation dialog when the resolve ack carries one', async () => {
    hyveonMock.iac.rollback.resolve.mockResolvedValue({
      resolved: true,
      versionId: 'v-prior',
      lastModified: '2026-07-18T00:00:00.000Z',
      diff: {
        changedFields: ['awsRegion', 'dnsTtl'],
        gameServers: { added: ['foo', 'bar', 'baz'], removed: ['qux'], changed: ['corn', 'potato'] },
      },
    });
    const onRolledBack = vi.fn();
    render(<RollbackAction applyRunId="apply-1" onRolledBack={onRolledBack} />);

    await userEvent.click(screen.getByRole('button', { name: 'Rollback' }));

    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent(
      '3 game servers added (foo, bar, baz), 1 removed (qux), 2 changed (corn, potato); ' +
        'other settings also changed: awsRegion, dnsTtl.',
    );
  });

  it('should render the identify-target-only dialog with no diff line when the resolve ack has no diff', async () => {
    hyveonMock.iac.rollback.resolve.mockResolvedValue({
      resolved: true,
      versionId: 'v-prior',
      lastModified: '2026-07-18T00:00:00.000Z',
    });
    const onRolledBack = vi.fn();
    render(<RollbackAction applyRunId="apply-1" onRolledBack={onRolledBack} />);

    await userEvent.click(screen.getByRole('button', { name: 'Rollback' }));

    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('This restores tfvars version v-prior');
    expect(dialog).not.toHaveTextContent(/game server/);
    expect(dialog).not.toHaveTextContent(/configuration differences/);
  });

  it('should render "No configuration differences detected." when the diff has zero changes in every field', async () => {
    hyveonMock.iac.rollback.resolve.mockResolvedValue({
      resolved: true,
      versionId: 'v-prior',
      lastModified: '2026-07-18T00:00:00.000Z',
      diff: {
        changedFields: [],
        gameServers: { added: [], removed: [], changed: [] },
      },
    });
    const onRolledBack = vi.fn();
    render(<RollbackAction applyRunId="apply-1" onRolledBack={onRolledBack} />);

    await userEvent.click(screen.getByRole('button', { name: 'Rollback' }));

    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('No configuration differences detected.');
  });
});
