import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { HYVEON_DEPLOY_ALL_ACTIONS, HYVEON_DEPLOY_ALL_STATEMENTS, generateHyveonDeployAllPolicy } from './iamPolicy.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Absolute path to the doc holding the canonical `HyveonDeployAll` policy JSON. */
const SETUP_DOC_PATH = resolve(__dirname, '../../../../docs/docs/setup.md');

/**
 * Parses the `HyveonDeployAll` policy JSON fenced block out of
 * `docs/docs/setup.md`.
 */
function parseDocPolicy(): { Statement: Array<{ Sid: string; Action: string | string[] }> } {
  const markdown = readFileSync(SETUP_DOC_PATH, 'utf-8');
  const match = markdown.match(/```json\n([\s\S]*?)\n```/);
  if (!match) {
    throw new Error('Could not find the HyveonDeployAll policy JSON block in docs/docs/setup.md');
  }
  return JSON.parse(match[1]!) as { Statement: Array<{ Sid: string; Action: string | string[] }> };
}

/**
 * Parses the `HyveonDeployAll` policy JSON fenced block out of
 * `docs/docs/setup.md` and returns its flattened, deduplicated action list —
 * the same shape as {@link HYVEON_DEPLOY_ALL_ACTIONS}, so the two can
 * be compared directly.
 */
function extractDocActions(): string[] {
  const policy = parseDocPolicy();
  const actions = policy.Statement.flatMap((statement) =>
    Array.isArray(statement.Action) ? statement.Action : [statement.Action],
  );
  return [...new Set(actions)];
}

/**
 * Normalizes an IAM statement's `Action` field — a bare string for a
 * single-action statement (e.g. `HyveonIAM`'s `"iam:*"`), or an array for a
 * multi-action statement — into an array, so per-statement action lists can
 * be compared uniformly regardless of which shape either side used.
 */
function normalizeActions(action: string | readonly string[]): string[] {
  return typeof action === 'string' ? [action] : [...action];
}

/**
 * Extracts `{ Sid, Action }[]` per statement from the `HyveonDeployAll`
 * policy JSON block in `docs/docs/setup.md`, with `Action` normalized to an
 * array in every statement (see {@link normalizeActions}) — the shape needed
 * to compare statement-for-statement, action-for-action against
 * {@link generateHyveonDeployAllPolicy}'s output.
 */
function extractDocStatements(): Array<{ Sid: string; Action: string[] }> {
  const policy = parseDocPolicy();
  return policy.Statement.map((statement) => ({
    Sid: statement.Sid,
    Action: normalizeActions(statement.Action),
  }));
}

describe('HYVEON_DEPLOY_ALL_ACTIONS', () => {
  it('should stay in sync with the HyveonDeployAll policy JSON in docs/docs/setup.md', () => {
    const docActions = extractDocActions();

    expect(new Set(HYVEON_DEPLOY_ALL_ACTIONS)).toEqual(new Set(docActions));
  });
});

describe('generateHyveonDeployAllPolicy', () => {
  it('should match the HyveonDeployAll policy JSON in docs/docs/setup.md Sid-for-Sid and action-for-action', () => {
    const docStatements = extractDocStatements();
    const generatedStatements = generateHyveonDeployAllPolicy().Statement.map((statement) => ({
      Sid: statement.Sid,
      Action: normalizeActions(statement.Action),
    }));

    expect(generatedStatements).toHaveLength(docStatements.length);
    generatedStatements.forEach((statement, index) => {
      const docStatement = docStatements[index]!;
      expect(statement.Sid).toBe(docStatement.Sid);
      expect(new Set(statement.Action)).toEqual(new Set(docStatement.Action));
    });
  });
});

describe('HYVEON_DEPLOY_ALL_STATEMENTS', () => {
  it('should have a flattened, deduplicated action set matching HYVEON_DEPLOY_ALL_ACTIONS', () => {
    const statementActions = [...new Set(HYVEON_DEPLOY_ALL_STATEMENTS.flatMap((s) => normalizeActions(s.Action)))];

    expect(new Set(statementActions)).toEqual(new Set(HYVEON_DEPLOY_ALL_ACTIONS));
  });
});
