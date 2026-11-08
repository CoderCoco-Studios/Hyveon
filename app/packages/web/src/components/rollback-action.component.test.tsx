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

  // @spec IAC-RUN-RBK-002
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
      headEtag: 'etag-head',
    });
    hyveonMock.iac.rollback.confirm.mockResolvedValue({ confirmed: true, versionId: 'v-new-head', planRunId: 'plan-9' });
    const onRolledBack = vi.fn();
    render(<RollbackAction applyRunId="apply-1" onRolledBack={onRolledBack} />);

    await userEvent.click(screen.getByRole('button', { name: 'Rollback' }));
    await screen.findByRole('alertdialog');
    await userEvent.click(screen.getByRole('button', { name: 'Roll back' }));

    await waitFor(() =>
      expect(onRolledBack).toHaveBeenCalledWith({ versionId: 'v-new-head', rolledBackFrom: 'apply-1', planRunId: 'plan-9' }),
    );
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  // @spec CONFIG-RESTORE-004
  it('should pass the resolved headEtag to confirm', async () => {
    hyveonMock.iac.rollback.resolve.mockResolvedValue({
      resolved: true,
      versionId: 'v-prior',
      lastModified: '2026-07-18T00:00:00.000Z',
      headEtag: 'etag-head',
    });
    hyveonMock.iac.rollback.confirm.mockResolvedValue({ confirmed: true, versionId: 'v-new-head' });
    render(<RollbackAction applyRunId="apply-1" onRolledBack={vi.fn()} />);

    await userEvent.click(screen.getByRole('button', { name: 'Rollback' }));
    await screen.findByRole('alertdialog');
    await userEvent.click(screen.getByRole('button', { name: 'Roll back' }));

    await waitFor(() =>
      expect(hyveonMock.iac.rollback.confirm).toHaveBeenCalledWith({ applyRunId: 'apply-1', headEtag: 'etag-head' }),
    );
  });

  // @spec CONFIG-RESTORE-004
  it('should close the dialog and show the retry message when confirm reports the configuration changed', async () => {
    hyveonMock.iac.rollback.resolve.mockResolvedValue({
      resolved: true,
      versionId: 'v-prior',
      lastModified: '2026-07-18T00:00:00.000Z',
      headEtag: 'etag-head',
    });
    hyveonMock.iac.rollback.confirm.mockResolvedValue({
      confirmed: false,
      error: 'Configuration changed while restoring: review and retry the rollback',
    });
    render(<RollbackAction applyRunId="apply-1" onRolledBack={vi.fn()} />);

    await userEvent.click(screen.getByRole('button', { name: 'Rollback' }));
    await screen.findByRole('alertdialog');
    await userEvent.click(screen.getByRole('button', { name: 'Roll back' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/review and retry the rollback/);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  // @spec CONFIG-RESTORE-005
  it('should show the target but disable confirming when the preview returned no headEtag', async () => {
    hyveonMock.iac.rollback.resolve.mockResolvedValue({
      resolved: true,
      versionId: 'v-prior',
      lastModified: '2026-07-18T00:00:00.000Z',
    });
    render(<RollbackAction applyRunId="apply-1" onRolledBack={vi.fn()} />);

    await userEvent.click(screen.getByRole('button', { name: 'Rollback' }));

    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('This restores configuration version v-prior');
    expect(dialog).toHaveTextContent(/click Rollback again to retry/);
    expect(screen.getByRole('button', { name: 'Roll back' })).toBeDisabled();
    expect(hyveonMock.iac.rollback.confirm).not.toHaveBeenCalled();
  });

  it('should surface a confirm failure inline and never call onRolledBack', async () => {
    hyveonMock.iac.rollback.resolve.mockResolvedValue({
      resolved: true,
      versionId: 'v-prior',
      lastModified: '2026-07-18T00:00:00.000Z',
      headEtag: 'etag-head',
    });
    hyveonMock.iac.rollback.confirm.mockResolvedValue({
      confirmed: false,
      error: 'Historic configuration version "v-prior" no longer exists — it may have expired. Nothing was written.',
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

  // @spec IAC-RUN-RBK-003
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
    expect(dialog).toHaveTextContent('This restores configuration version v-prior');
    expect(dialog).not.toHaveTextContent(/game server/);
    expect(dialog).not.toHaveTextContent(/configuration differences/);
  });
});
