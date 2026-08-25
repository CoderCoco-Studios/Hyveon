import { describe, it, expect } from 'vitest';
import type { DeploymentConfigDiff } from '@hyveon/shared';
import { formatDiffSummary } from './rollback-diff.utils.js';

/** Builds a {@link DeploymentConfigDiff} fixture, overridable per-test. */
function makeDiff(overrides: Partial<DeploymentConfigDiff> = {}): DeploymentConfigDiff {
  return {
    changedFields: [],
    gameServers: { added: [], removed: [], changed: [] },
    ...overrides,
  };
}

describe('formatDiffSummary', () => {
  it('should render "No configuration differences detected." when the diff has zero changes in every field', () => {
    expect(formatDiffSummary(makeDiff())).toBe('No configuration differences detected.');
  });

  it('should describe added, removed, and changed game servers plus other changed fields in one sentence', () => {
    const diff = makeDiff({
      changedFields: ['awsRegion', 'dnsTtl'],
      gameServers: { added: ['foo', 'bar', 'baz'], removed: ['qux'], changed: ['corn', 'potato'] },
    });

    expect(formatDiffSummary(diff)).toBe(
      '3 game servers added (foo, bar, baz), 1 removed (qux), 2 changed (corn, potato); ' +
        'other settings also changed: awsRegion, dnsTtl.',
    );
  });

  it('should use the singular "game server" when exactly one was added', () => {
    const diff = makeDiff({ gameServers: { added: ['foo'], removed: [], changed: [] } });

    expect(formatDiffSummary(diff)).toBe('1 game server added (foo).');
  });

  it('should describe only the changed fields when no game servers differ', () => {
    const diff = makeDiff({ changedFields: ['awsRegion'] });

    expect(formatDiffSummary(diff)).toBe('other settings also changed: awsRegion.');
  });

  it('should describe only the game server changes when no other fields differ', () => {
    const diff = makeDiff({ gameServers: { added: [], removed: ['qux'], changed: [] } });

    expect(formatDiffSummary(diff)).toBe('1 removed (qux).');
  });
});
