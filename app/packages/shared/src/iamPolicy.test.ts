import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  HYVEON_DEPLOY_ALL_ACTIONS,
  HYVEON_DEPLOY_ALL_STATEMENTS,
  generateHyveonDeployAllPolicy,
  generateHyveonSelfRotatePolicy,
} from './iamPolicy.js';

/** Default project name used by {@link generateHyveonDeployAllPolicy} when none is passed. */
const DEFAULT_PROJECT_NAME = 'hyveon';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Absolute path to the doc holding the canonical `HyveonDeployAll` policy JSON. */
const SETUP_DOC_PATH = resolve(__dirname, '../../../../docs/docs/setup.md');

/**
 * Parses the `HyveonDeployAll` policy JSON fenced block out of
 * `docs/docs/setup.md`.
 */
function parseDocPolicy(): {
  Statement: Array<{
    Sid: string;
    Effect: string;
    Action: string | string[];
    Resource: string | string[];
    Condition?: Record<string, Record<string, string>>;
  }>;
} {
  const markdown = readFileSync(SETUP_DOC_PATH, 'utf-8');
  const match = markdown.match(/```json\n([\s\S]*?)\n```/);
  if (!match) {
    throw new Error('Could not find the HyveonDeployAll policy JSON block in docs/docs/setup.md');
  }
  return JSON.parse(match[1]!) as {
    Statement: Array<{
      Sid: string;
      Effect: string;
      Action: string | string[];
      Resource: string | string[];
      Condition?: Record<string, Record<string, string>>;
    }>;
  };
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
 * Normalizes an IAM statement's `Resource` field — a bare string (e.g.
 * `HyveonDeploy`'s `"*"`) or an array — into an array, so per-statement
 * resource lists can be compared uniformly regardless of which shape either
 * side used.
 */
function normalizeResource(resource: string | readonly string[]): string[] {
  return typeof resource === 'string' ? [resource] : [...resource];
}

/**
 * Extracts `{ Sid, Effect, Action, Resource }[]` per statement from the
 * `HyveonDeployAll` policy JSON block in `docs/docs/setup.md`, with `Action`
 * and `Resource` normalized to arrays (see {@link normalizeActions} and
 * {@link normalizeResource}) — the shape needed to compare
 * statement-for-statement, including `Resource` scoping, against
 * {@link generateHyveonDeployAllPolicy}'s output. The doc's `${project_name}`
 * notation in `Resource` ARNs is substituted with `projectName` so it can be
 * compared directly against the generator's concrete ARNs — the doc uses
 * `${project_name}` as documentation notation, not a literal CloudFormation
 * intrinsic.
 */
function extractDocStatements(
  projectName: string,
): Array<{ Sid: string; Effect: string; Action: string[]; Resource: string[]; Condition?: Record<string, Record<string, string>> }> {
  const policy = parseDocPolicy();
  return policy.Statement.map((statement) => ({
    Sid: statement.Sid,
    Effect: statement.Effect,
    Action: normalizeActions(statement.Action),
    Resource: normalizeResource(statement.Resource).map((arn) => arn.replaceAll('${project_name}', projectName)),
    Condition: statement.Condition,
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
    const docStatements = extractDocStatements(DEFAULT_PROJECT_NAME);
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

  it('should match the HyveonDeployAll policy JSON in docs/docs/setup.md statement-for-statement, including Effect and Resource', () => {
    const docStatements = extractDocStatements(DEFAULT_PROJECT_NAME);
    const generatedStatements = generateHyveonDeployAllPolicy(DEFAULT_PROJECT_NAME).Statement.map((statement) => ({
      Sid: statement.Sid,
      Effect: statement.Effect,
      Action: normalizeActions(statement.Action),
      Resource: normalizeResource(statement.Resource),
      Condition: statement.Condition,
    }));

    expect(generatedStatements).toHaveLength(docStatements.length);
    generatedStatements.forEach((statement, index) => {
      const docStatement = docStatements[index]!;
      expect(statement.Sid).toBe(docStatement.Sid);
      expect(statement.Effect).toBe(docStatement.Effect);
      expect(new Set(statement.Action)).toEqual(new Set(docStatement.Action));
      expect(new Set(statement.Resource)).toEqual(new Set(docStatement.Resource));
      expect(statement.Condition).toEqual(docStatement.Condition);
    });
  });
});

describe('generateHyveonSelfRotatePolicy', () => {
  it('should grant exactly the three self-rotate actions scoped to the UserName parameter via Fn::Sub', () => {
    const policy = generateHyveonSelfRotatePolicy();

    expect(policy.Version).toBe('2012-10-17');
    expect(policy.Statement).toHaveLength(1);
    const [statement] = policy.Statement;
    expect(statement!.Effect).toBe('Allow');
    expect(new Set(statement!.Action)).toEqual(
      new Set(['iam:CreateAccessKey', 'iam:DeleteAccessKey', 'iam:ListAccessKeys']),
    );
    expect(statement!.Resource).toEqual({ 'Fn::Sub': 'arn:aws:iam::*:user/${UserName}' });
  });

  it('should JSON.stringify the Fn::Sub resource as a nested object, not a mangled template string', () => {
    const json = JSON.stringify(generateHyveonSelfRotatePolicy());
    const parsed = JSON.parse(json) as { Statement: Array<{ Resource: { 'Fn::Sub': string } }> };

    expect(parsed.Statement[0]!.Resource).toEqual({ 'Fn::Sub': 'arn:aws:iam::*:user/${UserName}' });
  });
});

describe('HYVEON_DEPLOY_ALL_STATEMENTS', () => {
  it('should have a flattened, deduplicated action set matching HYVEON_DEPLOY_ALL_ACTIONS', () => {
    const statementActions = [...new Set(HYVEON_DEPLOY_ALL_STATEMENTS.flatMap((s) => normalizeActions(s.Action)))];

    expect(new Set(statementActions)).toEqual(new Set(HYVEON_DEPLOY_ALL_ACTIONS));
  });
});
