import { expect, test } from 'bun:test';
import { buildSnapshot, diffSnapshots, snippet } from './watch-pr.ts';

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
