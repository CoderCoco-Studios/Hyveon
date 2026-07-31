import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { Routes, Route } from 'react-router-dom';

const apiMock = vi.hoisted(() => ({
  status: vi.fn(),
  costsEstimate: vi.fn(),
}));
vi.mock('../api.service.js', () => ({ api: apiMock }));

/** Stub for the `window.hyveon.iac.runs` channels this page invokes. */
const hyveonMock = {
  iac: {
    runs: {
      list: vi.fn(),
      streamLogs: vi.fn(),
      logUrl: vi.fn(),
    },
  },
};
vi.stubGlobal('hyveon', hyveonMock);

/**
 * Mock for the presigned-URL log fetch. Given its own `vi.fn()` (rather than
 * an inline `vi.stubGlobal('fetch', vi.fn(...))`) so `beforeEach` can fully
 * reset its implementation every test — a `mockResolvedValueOnce` queued
 * override is fragile here, since any stray extra invocation (e.g. a
 * duplicate effect run) silently falls through to whatever default was left
 * behind by a prior test instead of failing loudly.
 */
const fetchMock = vi.fn<typeof fetch>();
vi.stubGlobal('fetch', fetchMock);

import { TerraformRunDetailPage } from './terraform-run-detail.page.js';
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

/** Renders the detail page at `/terraform/history/:runId` for the given route param. */
function renderDetailPage(runId: string) {
  return renderPage(
    <Routes>
      <Route path="/terraform/history/:runId" element={<TerraformRunDetailPage />} />
    </Routes>,
    { initialEntries: [`/terraform/history/${runId}`] },
  );
}

describe('TerraformRunDetailPage', () => {
  beforeEach(() => {
    apiMock.status.mockResolvedValue([]);
    apiMock.costsEstimate.mockResolvedValue({ games: {}, totalPerHourIfAllOn: 0 });
    hyveonMock.iac.runs.list.mockReset();
    hyveonMock.iac.runs.streamLogs.mockReset();
    hyveonMock.iac.runs.logUrl.mockReset();
    hyveonMock.iac.runs.streamLogs.mockImplementation(async function* () {
      /* no local artifacts by default — subclasses override per test */
    });
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => 'offloaded log text',
    } as Response);
  });

  it('should show a not-found message when no record matches the runId', async () => {
    hyveonMock.iac.runs.list.mockResolvedValue({ records: [] });
    renderDetailPage('run-missing');

    expect(await screen.findByText(/No run history record was found for "run-missing"\./)).toBeInTheDocument();
  });

  it('should render the record status, kind, and approver once resolved', async () => {
    hyveonMock.iac.runs.list.mockResolvedValue({
      records: [makeRecord({ approvedBy: 'alice', approvedAt: '2026-07-17T00:02:00.000Z' })],
    });
    renderDetailPage('run-1');

    expect(await screen.findByText('apply')).toBeInTheDocument();
    expect(screen.getByText('Success')).toBeInTheDocument();
    expect(screen.getByText(/Approved by/)).toBeInTheDocument();
    expect(screen.getByText('alice')).toBeInTheDocument();
  });

  it('should replay the log via streamLogs when local run artifacts exist', async () => {
    hyveonMock.iac.runs.list.mockResolvedValue({ records: [makeRecord()] });
    hyveonMock.iac.runs.streamLogs.mockImplementation(async function* () {
      yield { stream: 'stdout', line: 'replayed line' };
    });
    renderDetailPage('run-1');

    expect(await screen.findByText('replayed line')).toBeInTheDocument();
    expect(hyveonMock.iac.runs.logUrl).not.toHaveBeenCalled();
  });

  it('should fall back to the inline log when streamLogs yields nothing', async () => {
    hyveonMock.iac.runs.list.mockResolvedValue({
      records: [makeRecord({ logInline: 'inline log text' })],
    });
    renderDetailPage('run-1');

    expect(await screen.findByText('inline log text')).toBeInTheDocument();
    expect(hyveonMock.iac.runs.logUrl).not.toHaveBeenCalled();
  });

  it('should fall back to streamLogs throwing, then a presigned URL fetch when logS3Key is set', async () => {
    hyveonMock.iac.runs.list.mockResolvedValue({
      records: [makeRecord({ logS3Key: 'runs/run-1.log' })],
    });
    // eslint-disable-next-line require-yield -- generator must throw before yielding to simulate missing local run artifacts
    hyveonMock.iac.runs.streamLogs.mockImplementation(async function* () {
      throw new Error('no run found for runId "run-1"');
    });
    hyveonMock.iac.runs.logUrl.mockResolvedValue('https://example.com/signed-log');
    renderDetailPage('run-1');

    expect(await screen.findByText('offloaded log text')).toBeInTheDocument();
    expect(hyveonMock.iac.runs.logUrl).toHaveBeenCalledWith('runs/run-1.log');
    expect(fetchMock).toHaveBeenCalledWith('https://example.com/signed-log');
  });

  it('should treat a non-ok presigned URL fetch as no log available rather than rendering the error body', async () => {
    hyveonMock.iac.runs.list.mockResolvedValue({
      records: [makeRecord({ logS3Key: 'runs/run-1.log' })],
    });
    // eslint-disable-next-line require-yield -- generator must throw before yielding to simulate missing local run artifacts
    hyveonMock.iac.runs.streamLogs.mockImplementation(async function* () {
      throw new Error('no run found for runId "run-1"');
    });
    hyveonMock.iac.runs.logUrl.mockResolvedValue('https://example.com/expired-log');
    fetchMock.mockResolvedValue({
      ok: false,
      status: 403,
      text: async () => '<Error>AccessDenied</Error>',
    } as Response);
    renderDetailPage('run-1');

    expect(await screen.findByText('This run has no replayable, inline, or offloaded log.')).toBeInTheDocument();
    expect(hyveonMock.iac.runs.logUrl).toHaveBeenCalledWith('runs/run-1.log');
    expect(screen.queryByText('<Error>AccessDenied</Error>')).not.toBeInTheDocument();
  });

  it('should not render any approve/apply controls for a terminal run', async () => {
    hyveonMock.iac.runs.list.mockResolvedValue({ records: [makeRecord({ logInline: 'log' })] });
    renderDetailPage('run-1');

    await screen.findByText('log');
    expect(screen.queryByRole('button', { name: /Approve/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Apply/ })).not.toBeInTheDocument();
  });

  it('should link to the rolled-back apply run when the record carries rolledBackFrom', async () => {
    hyveonMock.iac.runs.list.mockResolvedValue({
      records: [makeRecord({ kind: 'plan', logInline: 'log', rolledBackFrom: 'apply-1' })],
    });
    renderDetailPage('run-1');

    const link = await screen.findByRole('link', { name: /apply run apply-1/ });
    expect(link).toHaveAttribute('href', '/terraform/history/apply-1');
  });

  it('should not render a rollback tag when the record has no rolledBackFrom', async () => {
    hyveonMock.iac.runs.list.mockResolvedValue({ records: [makeRecord({ logInline: 'log' })] });
    renderDetailPage('run-1');

    await screen.findByText('log');
    expect(screen.queryByText(/Rollback of/)).not.toBeInTheDocument();
  });

  describe('change summary (task 9.5)', () => {
    it('should render grouped change badges when the record has a populated changeSummary', async () => {
      hyveonMock.iac.runs.list.mockResolvedValue({
        records: [makeRecord({ logInline: 'log', changeSummary: { create: 3, update: 1 } })],
      });
      renderDetailPage('run-1');

      expect(await screen.findByText('3 to create')).toBeInTheDocument();
      expect(screen.getByText('1 to update')).toBeInTheDocument();
    });

    it('should render "Change summary unavailable" when the record has no changeSummary', async () => {
      hyveonMock.iac.runs.list.mockResolvedValue({ records: [makeRecord({ logInline: 'log' })] });
      renderDetailPage('run-1');

      expect(await screen.findByText('Change summary unavailable')).toBeInTheDocument();
    });

    it('should render a distinct "no changes" state when the record\'s changeSummary reports only unchanged resources', async () => {
      hyveonMock.iac.runs.list.mockResolvedValue({
        records: [makeRecord({ logInline: 'log', changeSummary: { same: 5 } })],
      });
      renderDetailPage('run-1');

      expect(await screen.findByText('No changes — 5 unchanged')).toBeInTheDocument();
      expect(screen.queryByText('Change summary unavailable')).not.toBeInTheDocument();
    });

    it('should render a partial badge when the record has partialApply true', async () => {
      hyveonMock.iac.runs.list.mockResolvedValue({
        records: [makeRecord({ logInline: 'log', partialApply: true })],
      });
      renderDetailPage('run-1');

      expect(await screen.findByText('partial')).toBeInTheDocument();
    });

    it('should not render a partial badge when the record has no partialApply', async () => {
      hyveonMock.iac.runs.list.mockResolvedValue({ records: [makeRecord({ logInline: 'log' })] });
      renderDetailPage('run-1');

      await screen.findByText('log');
      expect(screen.queryByText('partial')).not.toBeInTheDocument();
    });
  });
});
