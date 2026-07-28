import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AuditAction, AuditEntry } from '../api.service.js';
import { AuditEntryRow } from './audit-entry-row.component.js';

/** Every {@link AuditAction} value, used to prove the action badge renders for all of them. */
const ALL_ACTIONS: AuditAction[] = ['add', 'edit', 'remove', 'plan', 'approve', 'apply', 'destroy', 'rollback'];

/** Builds a minimal {@link AuditEntry} fixture for the given `action`. */
function makeEntry(action: AuditAction): AuditEntry {
  return {
    sk: '2026-07-03T00:00:00.000Z#01J002',
    timestamp: '2026-07-03T00:00:00.000Z',
    actor: 'carol',
    action,
    game: 'minecraft',
    before: null,
    after: null,
  };
}

/** A minimal `edit` audit entry fixture with both `before` and `after` populated. */
const EDIT_ENTRY: AuditEntry = {
  sk: '2026-07-01T00:00:00.000Z#01J000',
  timestamp: '2026-07-01T00:00:00.000Z',
  actor: 'alice',
  action: 'edit',
  game: 'minecraft',
  before: { name: 'minecraft', image: 'itzg/minecraft-server:1', cpu: 1024, memory: 2048, ports: [], volumes: [] },
  after: { name: 'minecraft', image: 'itzg/minecraft-server:2', cpu: 1024, memory: 2048, ports: [], volumes: [] },
  versionId: 'v-123',
};

/** An `add` audit entry fixture — `before` is `null` and `versionId` is absent. */
const ADD_ENTRY: AuditEntry = {
  sk: '2026-07-02T00:00:00.000Z#01J001',
  timestamp: '2026-07-02T00:00:00.000Z',
  actor: 'bob',
  action: 'add',
  game: 'valheim',
  before: null,
  after: { name: 'valheim', image: 'lloesche/valheim-server', cpu: 512, memory: 1024, ports: [], volumes: [] },
};

/** Renders `AuditEntryRow` inside a minimal `<table>` shell, matching production usage. */
function renderRow(entry: AuditEntry) {
  return render(
    <table>
      <tbody>
        <AuditEntryRow entry={entry} />
      </tbody>
    </table>,
  );
}

describe('AuditEntryRow', () => {
  it('should render the timestamp, actor, action, game, and versionId summary columns', () => {
    renderRow(EDIT_ENTRY);

    expect(screen.getByText('alice')).toBeInTheDocument();
    expect(screen.getByText('edit')).toBeInTheDocument();
    expect(screen.getByText('minecraft')).toBeInTheDocument();
    expect(screen.getByText('v-123')).toBeInTheDocument();
  });

  it('should render an em dash for a missing versionId', () => {
    renderRow(ADD_ENTRY);

    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('should not render the before/after diff until expanded', () => {
    renderRow(EDIT_ENTRY);

    expect(screen.queryByText(/itzg\/minecraft-server:1/)).not.toBeInTheDocument();
    expect(screen.queryByText(/itzg\/minecraft-server:2/)).not.toBeInTheDocument();
  });

  it('should expand to show the before/after JSON diff in two pre blocks when the row is clicked', async () => {
    renderRow(EDIT_ENTRY);

    await userEvent.click(screen.getByRole('button', { name: /expand diff/i }));

    const pres = screen.getAllByText(/itzg\/minecraft-server/, { selector: 'pre' });
    expect(pres).toHaveLength(2);
    expect(pres[0]).toHaveTextContent('itzg/minecraft-server:1');
    expect(pres[1]).toHaveTextContent('itzg/minecraft-server:2');
  });

  it('should render "null" for a before value that is null (e.g. an add entry)', async () => {
    renderRow(ADD_ENTRY);

    await userEvent.click(screen.getByRole('button', { name: /expand diff/i }));

    const pres = screen.getAllByRole('button', { name: /collapse diff/i });
    expect(pres).toHaveLength(1);
    expect(screen.getByText('null', { selector: 'pre' })).toBeInTheDocument();
  });

  it('should collapse the diff when the toggle is clicked again', async () => {
    renderRow(EDIT_ENTRY);

    const toggle = () => screen.getByRole('button', { name: /(expand|collapse) diff/i });
    await userEvent.click(toggle());
    expect(screen.getAllByText(/itzg\/minecraft-server/, { selector: 'pre' })).toHaveLength(2);

    await userEvent.click(toggle());
    expect(screen.queryByText(/itzg\/minecraft-server/, { selector: 'pre' })).not.toBeInTheDocument();
  });

  /**
   * The background-color class fragment unique to each `Badge` variant (see
   * `badgeVariants` in `@/components/ui/badge.component`), keyed by the
   * `AuditAction` `ACTION_BADGE_VARIANT` maps it to. Several actions
   * deliberately share a colour — `plan`/`approve` are both the read-only
   * cyan, and `remove`/`destroy` are both destructive — so this asserts the
   * mapping, not that all eight are visually distinct.
   */
  const EXPECTED_BADGE_CLASS: Record<AuditAction, string> = {
    add: 'bg-[var(--color-green)]', // success
    edit: 'bg-[var(--color-amber)]', // warning
    remove: 'bg-[var(--color-red)]', // destructive
    plan: 'bg-[var(--color-cyan)]', // cyan
    approve: 'bg-[var(--color-cyan)]', // cyan
    apply: 'bg-[var(--color-amber)]', // warning
    destroy: 'bg-[var(--color-red)]', // destructive
    rollback: 'bg-[var(--color-surface-2)]', // secondary
  };

  it.each(ALL_ACTIONS)(
    'should render the "%s" action badge with its mapped color variant',
    (action) => {
      renderRow(makeEntry(action));

      // Regression guard for the bug where `ACTION_BADGE_VARIANT` only covered
      // 3 of the 8 `AuditAction` members: every action must render its own
      // distinct badge color, not silently fall back to the `default` variant.
      expect(screen.getByText(action).className).toContain(EXPECTED_BADGE_CLASS[action]);
    },
  );
});
