import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { RunHistoryRecord } from '@hyveon/desktop-preload';
import { RunHistoryRow } from './run-history-row.component.js';

/** Stub for `window.hyveon.iac.rollback` — the only channel `RollbackAction` invokes. */
const hyveonMock = {
  iac: {
    rollback: {
      resolve: vi.fn(),
      confirm: vi.fn(),
    },
  },
};
vi.stubGlobal('hyveon', hyveonMock);

/** Builds a sample `RunHistoryRecord`, overridable per-test. */
function makeRecord(overrides: Partial<RunHistoryRecord> = {}): RunHistoryRecord {
  return {
    sk: '2026-07-17T00:00:00.000Z#run-1',
    runId: 'run-1',
    kind: 'apply',
    status: 'success',
    startedAt: '2026-07-17T00:00:00.000Z',
    completedAt: '2026-07-17T00:05:00.000Z',
    exitCode: 0,
    ...overrides,
  } as RunHistoryRecord;
}

/** Renders `RunHistoryRow` inside a minimal routed `<table>` shell, matching production usage. */
function renderRow(record: RunHistoryRecord) {
  return render(
    <MemoryRouter>
      <table>
        <tbody>
          <RunHistoryRow record={record} onRolledBack={vi.fn()} />
        </tbody>
      </table>
    </MemoryRouter>,
  );
}

describe('RunHistoryRow', () => {
  beforeEach(() => {
    hyveonMock.iac.rollback.resolve.mockReset();
    hyveonMock.iac.rollback.confirm.mockReset();
  });

  it('should link the kind cell to the run-detail route', () => {
    renderRow(makeRecord({ runId: 'run-42' }));

    expect(screen.getByRole('link', { name: 'apply' })).toHaveAttribute('href', '/iac/history/run-42');
  });

  it('should render a rollback badge when the record carries rolledBackFrom', () => {
    renderRow(makeRecord({ kind: 'plan', rolledBackFrom: 'apply-1' }));

    expect(screen.getByText('rollback')).toBeInTheDocument();
  });

  it('should not render a rollback badge when the record has no rolledBackFrom', () => {
    renderRow(makeRecord());

    expect(screen.queryByText('rollback')).not.toBeInTheDocument();
  });

  it('should render a partial badge only when partialApply is true', () => {
    renderRow(makeRecord({ partialApply: true }));

    expect(screen.getByText('partial')).toBeInTheDocument();
  });

  it('should render an em dash when approvedBy is absent', () => {
    renderRow(makeRecord());

    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('should render approvedBy when present', () => {
    renderRow(makeRecord({ approvedBy: 'alice' }));

    expect(screen.getByText('alice')).toBeInTheDocument();
  });

  it('should show a Rollback action only for apply rows with a configVersionId', () => {
    renderRow(makeRecord({ kind: 'apply', configVersionId: 'v-1' }));

    expect(screen.getByRole('button', { name: 'Rollback' })).toBeInTheDocument();
  });

  it('should not show a Rollback action for an apply row without a configVersionId', () => {
    renderRow(makeRecord({ kind: 'apply', configVersionId: undefined }));

    expect(screen.queryByRole('button', { name: 'Rollback' })).not.toBeInTheDocument();
  });

  it('should not show a Rollback action for a non-apply row even with a configVersionId', () => {
    renderRow(makeRecord({ kind: 'plan', configVersionId: 'v-1' }));

    expect(screen.queryByRole('button', { name: 'Rollback' })).not.toBeInTheDocument();
  });
});
