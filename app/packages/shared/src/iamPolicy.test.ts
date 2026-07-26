import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { GAME_SERVER_DEPLOY_ALL_ACTIONS } from './iamPolicy.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Absolute path to the doc holding the canonical `GameServerDeployAll` policy JSON. */
const SETUP_DOC_PATH = resolve(__dirname, '../../../../docs/docs/setup.md');

/**
 * Parses the `GameServerDeployAll` policy JSON fenced block out of
 * `docs/docs/setup.md` and returns its flattened, deduplicated action list —
 * the same shape as {@link GAME_SERVER_DEPLOY_ALL_ACTIONS}, so the two can
 * be compared directly.
 */
function extractDocActions(): string[] {
  const markdown = readFileSync(SETUP_DOC_PATH, 'utf-8');
  const match = markdown.match(/```json\n([\s\S]*?)\n```/);
  if (!match) {
    throw new Error('Could not find the GameServerDeployAll policy JSON block in docs/docs/setup.md');
  }
  const policy = JSON.parse(match[1]!) as { Statement: Array<{ Action: string | string[] }> };
  const actions = policy.Statement.flatMap((statement) =>
    Array.isArray(statement.Action) ? statement.Action : [statement.Action],
  );
  return [...new Set(actions)];
}

describe('GAME_SERVER_DEPLOY_ALL_ACTIONS', () => {
  it('should stay in sync with the GameServerDeployAll policy JSON in docs/docs/setup.md', () => {
    const docActions = extractDocActions();

    expect(new Set(GAME_SERVER_DEPLOY_ALL_ACTIONS)).toEqual(new Set(docActions));
  });
});
