import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const apiMock = vi.hoisted(() => ({
  status: vi.fn(),
  costsEstimate: vi.fn(),
}));
vi.mock('../api.service.js', () => ({ api: apiMock }));

/**
 * Stub for `react-router-dom`'s `useNavigate`, keeping every other export
 * (`Link`, `MemoryRouter`, ...) real — the rollback flow's `handleRolledBack`
 * navigates to `/iac`, and this lets tests assert on the call without
 * standing up a second routed page.
 */
const navigateMock = vi.hoisted(() => vi.fn());
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => navigateMock };
});

/** Stub for `window.hyveon.iac.runs.list` and the rollback flow's two IPC channels. */
const hyveonMock = {
  iac: {
    runs: {
      list: vi.fn(),
    },
    rollback: {
      resolve: vi.fn(),
      confirm: vi.fn(),
    },
  },
};
vi.stubGlobal('hyveon', hyveonMock);

import { IacHistoryPage } from './iac-history.page.js';
import { renderPage } from '../test-utils/render-page.utils.js';

/** Builds a sample `RunHistoryRecord`, overridable per-test. */
function makeRecord(overrides: Record<string, unknown> = {}) {
  return {
    sk: '2026-07-17T00:00:00.000Z#run-1',
    runId: 'run-1',
    kind: 'apply',
    status: 'success',
    startedAt: '2026-07-17T00:00:00.000Z',
    completedAt: '2026-07-17T00:05:00.000Z',
    exitCode: 0,
    ...overrides,
  };
}

describe('IacHistoryPage', () => {
  beforeEach(() => {
    apiMock.status.mockResolvedValue([]);
    apiMock.costsEstimate.mockResolvedValue({ games: {}, totalPerHourIfAllOn: 0 });
    hyveonMock.iac.runs.list.mockReset();
    hyveonMock.iac.rollback.resolve.mockReset();
    hyveonMock.iac.rollback.confirm.mockReset();
    navigateMock.mockClear();
  });

  it('should render recent runs newest-first with kind, status, and timestamps', async () => {
    hyveonMock.iac.runs.list.mockResolvedValue({ records: [makeRecord()] });
    renderPage(<IacHistoryPage />);

    expect(await screen.findByText('apply')).toBeInTheDocument();
    const table = screen.getByRole('table');
    expect(within(table).getByText('Success')).toBeInTheDocument();
  });

  it('should show the empty state when no runs match the current filters', async () => {
    hyveonMock.iac.runs.list.mockResolvedValue({ records: [] });
    renderPage(<IacHistoryPage />);

    expect(await screen.findByText(/No runs match the current filters\./)).toBeInTheDocument();
  });

  it('should fetch the next, older page and append it when Load more is clicked', async () => {
    hyveonMock.iac.runs.list.mockResolvedValueOnce({
      records: [makeRecord({ runId: 'run-1', sk: 'sk-1' })],
      nextBefore: 'sk-1',
    });
    renderPage(<IacHistoryPage />);
    await screen.findByText('apply');

    hyveonMock.iac.runs.list.mockResolvedValueOnce({
      records: [makeRecord({ runId: 'run-2', sk: 'sk-2', kind: 'plan' })],
    });
    await userEvent.click(screen.getByRole('button', { name: /Load more/ }));

    expect(await screen.findByText('plan')).toBeInTheDocument();
    expect(hyveonMock.iac.runs.list).toHaveBeenLastCalledWith({ limit: 25, before: 'sk-1', status: undefined });
  });

  it('should re-fetch with the selected status filter', async () => {
    hyveonMock.iac.runs.list.mockResolvedValue({ records: [makeRecord({ status: 'failed' })] });
    renderPage(<IacHistoryPage />);
    await screen.findByText('apply');

    await userEvent.selectOptions(screen.getByLabelText('Status'), 'failed');

    await waitFor(() =>
      expect(hyveonMock.iac.runs.list).toHaveBeenLastCalledWith({ limit: 25, status: 'failed' }),
    );
  });

  it('should apply the kind filter client-side without an extra fetch', async () => {
    hyveonMock.iac.runs.list.mockResolvedValue({
      records: [makeRecord({ runId: 'run-apply', kind: 'apply' }), makeRecord({ runId: 'run-plan', sk: 'sk-2', kind: 'plan' })],
    });
    renderPage(<IacHistoryPage />);
    await screen.findByText('apply');
    const callCountBefore = hyveonMock.iac.runs.list.mock.calls.length;

    await userEvent.selectOptions(screen.getByLabelText('Kind'), 'plan');

    expect(screen.queryByText('apply')).not.toBeInTheDocument();
    expect(screen.getByText('plan')).toBeInTheDocument();
    expect(hyveonMock.iac.runs.list.mock.calls.length).toBe(callCountBefore);
  });

  it('should link each row to its run-detail route', async () => {
    hyveonMock.iac.runs.list.mockResolvedValue({ records: [makeRecord({ runId: 'run-42' })] });
    renderPage(<IacHistoryPage />);

    const link = await screen.findByRole('link', { name: 'apply' });
    expect(link).toHaveAttribute('href', '/iac/history/run-42');
  });

  it('should show approvedBy when present, else an em dash', async () => {
    hyveonMock.iac.runs.list.mockResolvedValue({
      records: [makeRecord({ runId: 'run-1', approvedBy: 'alice' }), makeRecord({ runId: 'run-2', sk: 'sk-2', kind: 'plan' })],
    });
    renderPage(<IacHistoryPage />);

    const rows = await screen.findAllByRole('row');
    const bodyRows = rows.slice(1);
    expect(within(bodyRows[0]!).getByText('alice')).toBeInTheDocument();
    expect(within(bodyRows[1]!).getByText('—')).toBeInTheDocument();
  });

  describe('change summary', () => {
    it('should render grouped change badges for a row with a populated changeSummary', async () => {
      hyveonMock.iac.runs.list.mockResolvedValue({
        records: [makeRecord({ changeSummary: { create: 3, update: 1 } })],
      });
      renderPage(<IacHistoryPage />);

      expect(await screen.findByText('3 to create')).toBeInTheDocument();
      expect(screen.getByText('1 to update')).toBeInTheDocument();
    });

    it('should render "Change summary unavailable" for a row with no changeSummary', async () => {
      hyveonMock.iac.runs.list.mockResolvedValue({ records: [makeRecord()] });
      renderPage(<IacHistoryPage />);

      expect(await screen.findByText('Change summary unavailable')).toBeInTheDocument();
    });

    it('should render a distinct "no changes" state for a row whose changeSummary reports only unchanged resources', async () => {
      hyveonMock.iac.runs.list.mockResolvedValue({
        records: [makeRecord({ changeSummary: { same: 5 } })],
      });
      renderPage(<IacHistoryPage />);

      expect(await screen.findByText('No changes — 5 unchanged')).toBeInTheDocument();
      expect(screen.queryByText('Change summary unavailable')).not.toBeInTheDocument();
    });

    it('should render a partial badge for a row whose record has partialApply true', async () => {
      hyveonMock.iac.runs.list.mockResolvedValue({
        records: [makeRecord({ runId: 'apply-partial', partialApply: true })],
      });
      renderPage(<IacHistoryPage />);

      expect(await screen.findByText('partial')).toBeInTheDocument();
    });

    it('should not render a partial badge for a row whose record has no partialApply', async () => {
      hyveonMock.iac.runs.list.mockResolvedValue({ records: [makeRecord()] });
      renderPage(<IacHistoryPage />);

      await screen.findByText('apply');
      expect(screen.queryByText('partial')).not.toBeInTheDocument();
    });
  });

  describe('rollback action (#112)', () => {
    it('should show a Rollback button only for apply rows that recorded a tfvarsVersionId', async () => {
      hyveonMock.iac.runs.list.mockResolvedValue({
        records: [
          makeRecord({ runId: 'apply-with-version', kind: 'apply', tfvarsVersionId: 'v-1' }),
          makeRecord({ runId: 'apply-without-version', sk: 'sk-2', kind: 'apply' }),
          makeRecord({ runId: 'plan-with-version', sk: 'sk-3', kind: 'plan', tfvarsVersionId: 'v-2' }),
        ],
      });
      renderPage(<IacHistoryPage />);
      await screen.findAllByRole('row');

      const rollbackButtons = await screen.findAllByRole('button', { name: 'Rollback' });
      expect(rollbackButtons).toHaveLength(1);
    });

    it('should resolve the rollback target and open a confirmation dialog naming it on click', async () => {
      hyveonMock.iac.runs.list.mockResolvedValue({
        records: [makeRecord({ runId: 'apply-1', kind: 'apply', tfvarsVersionId: 'v-1' })],
      });
      hyveonMock.iac.rollback.resolve.mockResolvedValue({
        resolved: true,
        versionId: 'v-prior',
        lastModified: '2026-07-18T00:00:00.000Z',
      });
      renderPage(<IacHistoryPage />);

      await userEvent.click(await screen.findByRole('button', { name: 'Rollback' }));

      expect(hyveonMock.iac.rollback.resolve).toHaveBeenCalledWith({ applyRunId: 'apply-1' });
      const dialog = await screen.findByRole('alertdialog');
      expect(within(dialog).getByText(/v-prior/)).toBeInTheDocument();
      expect(hyveonMock.iac.rollback.confirm).not.toHaveBeenCalled();
    });

    it('should surface a resolve failure inline without opening a confirmation dialog', async () => {
      hyveonMock.iac.runs.list.mockResolvedValue({
        records: [makeRecord({ runId: 'apply-1', kind: 'apply', tfvarsVersionId: 'v-1' })],
      });
      hyveonMock.iac.rollback.resolve.mockResolvedValue({
        resolved: false,
        error: 'Historic tfvars version "v-1" no longer exists — it may have expired. Nothing was written.',
      });
      renderPage(<IacHistoryPage />);

      await userEvent.click(await screen.findByRole('button', { name: 'Rollback' }));

      expect(await screen.findByRole('alert')).toHaveTextContent(/no longer exists/);
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    });

    it('should confirm the rollback and navigate to /iac with the new versionId and rolledBackFrom', async () => {
      hyveonMock.iac.runs.list.mockResolvedValue({
        records: [makeRecord({ runId: 'apply-1', kind: 'apply', tfvarsVersionId: 'v-1' })],
      });
      hyveonMock.iac.rollback.resolve.mockResolvedValue({
        resolved: true,
        versionId: 'v-prior',
        lastModified: '2026-07-18T00:00:00.000Z',
      });
      hyveonMock.iac.rollback.confirm.mockResolvedValue({ confirmed: true, versionId: 'v-new-head' });
      renderPage(<IacHistoryPage />);

      await userEvent.click(await screen.findByRole('button', { name: 'Rollback' }));
      await screen.findByRole('alertdialog');
      await userEvent.click(screen.getByRole('button', { name: 'Roll back' }));

      expect(hyveonMock.iac.rollback.confirm).toHaveBeenCalledWith({ applyRunId: 'apply-1' });
      await waitFor(() =>
        expect(navigateMock).toHaveBeenCalledWith('/iac', {
          state: { tfvarsVersionId: 'v-new-head', rolledBackFrom: 'apply-1' },
        }),
      );
    });

    it('should render a rollback badge on a row whose record carries rolledBackFrom', async () => {
      hyveonMock.iac.runs.list.mockResolvedValue({
        records: [makeRecord({ runId: 'plan-2', kind: 'plan', rolledBackFrom: 'apply-1' })],
      });
      renderPage(<IacHistoryPage />);

      expect(await screen.findByText('rollback')).toBeInTheDocument();
    });
  });
});
