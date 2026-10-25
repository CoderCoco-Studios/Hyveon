import { expect, test } from 'bun:test';
import { buildSnapshot, diffSnapshots, failureAction, snippet } from './watch-pr.ts';

test('snippet strips control chars and caps length', () => {
  expect(snippet('a\nb\x1bc\td')).toBe('a b c d');
  expect(snippet('x'.repeat(500)).length).toBe(120);
});

test('diff reports only new items, concluded checks, and merge', () => {
  const a = buildSnapshot(
    { state: 'OPEN', statusCheckRollup: [{ name: 'ci', status: 'IN_PROGRESS' }], comments: [{ id: '1', author: { login: 'u' }, body: 'hi' }] },
    [],
  );
  const b = buildSnapshot(
    {
      state: 'MERGED',
      mergedAt: 'now',
      statusCheckRollup: [{ name: 'ci', conclusion: 'SUCCESS' }],
      comments: [
        { id: '1', author: { login: 'u' }, body: 'hi' },
        { id: '2', author: { login: 'v' }, body: 'yo\nthere' },
      ],
    },
    [{ id: 9, user: { login: 'w' }, path: 'f.ts', body: 'nit' }],
  );
  expect(diffSnapshots(a, b)).toEqual([
    'comment by v: yo there',
    'inline comment by w on f.ts: nit',
    'check ci -> SUCCESS',
    'PR merged',
  ]);
  expect(diffSnapshots(b, b)).toEqual([]);
});

test('same-named checks in different workflows are keyed separately and labelled', () => {
  const a = buildSnapshot({ state: 'OPEN', statusCheckRollup: [
    { __typename: 'CheckRun', workflowName: 'CI', name: 'changes', status: 'IN_PROGRESS' },
    { __typename: 'CheckRun', workflowName: 'Docs', name: 'changes', status: 'IN_PROGRESS' },
    { __typename: 'StatusContext', context: 'cr', state: 'PENDING' },
  ] }, []);
  const b = buildSnapshot({ state: 'OPEN', statusCheckRollup: [
    { __typename: 'CheckRun', workflowName: 'CI', name: 'changes', conclusion: 'SUCCESS' },
    { __typename: 'CheckRun', workflowName: 'Docs', name: 'changes', conclusion: 'FAILURE' },
    { __typename: 'StatusContext', context: 'cr', state: 'SUCCESS' },
  ] }, []);
  expect(Object.keys(b.checks).length).toBe(3);
  expect(diffSnapshots(a, b)).toEqual(['check CI/changes -> SUCCESS', 'check Docs/changes -> FAILURE', 'check cr -> SUCCESS']);
});

test('failureAction warns on 1st and 5th failure, exits at 10th', () => {
  expect(failureAction(1, new Error('boom\nx')).message).toBe('watcher error: boom x');
  expect(failureAction(2, 'e')).toEqual({ message: null, exit: false });
  expect(failureAction(5, 'e').message).not.toBeNull();
  expect(failureAction(10, 'e').exit).toBe(true);
});
