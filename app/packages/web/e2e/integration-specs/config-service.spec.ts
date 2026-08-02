import { EnvController } from '@hyveon/desktop-main/dist/controllers/env.controller.js';
import { GamesController } from '@hyveon/desktop-main/dist/controllers/games.controller.js';
import { STACK_OUTPUTS_FIXTURE } from '../fixtures/stack-outputs.fixture.js';
import { test, expect } from './index.js';

/**
 * Verifies that ConfigService correctly reads from a scripted `PulumiService`
 * stack-outputs response, injected via the `stackOutputs` fixture option and
 * substituted at the `PulumiService` DI seam when the `ipc` harness boots.
 * Dispatches straight to the IPC controllers — no HTTP server and no
 * BrowserWindow involved.
 */
test.describe('ConfigService — deployed stack', () => {
  test.use({ stackOutputs: STACK_OUTPUTS_FIXTURE });

  test('should return aws_region and domain from the scripted stack outputs', async ({ ipc, serverMocks: _reset }) => {
    const body = await ipc.dispatch(EnvController, 'getEnv');
    expect(body.region).toBe('us-east-1');
    expect(body.domain).toBe('test.example.com');
    // 'PROD' is derived when domain_name is non-empty
    expect(body.environment).toBe('PROD');
  });

  test('should return game names from the scripted stack outputs', async ({ ipc, serverMocks: _reset }) => {
    const body = await ipc.dispatch(GamesController, 'listGames');
    // No terraform.tfvars is present in the test environment, so every game
    // in the merged list is deployed-only (declared: false, deployed: true).
    expect(body.games.map((g) => g.name).sort()).toEqual(['minecraft', 'valheim']);
    body.games.forEach((g) => {
      expect(g.declared).toBe(false);
      expect(g.deployed).toBe(true);
    });
  });

  test('should return status entries for all games in the scripted stack outputs', async ({ ipc, serverMocks: _reset }) => {
    const statuses = await ipc.dispatch(GamesController, 'listStatus');
    // Default mock state — no queued ListTasks responses → empty taskArns → stopped
    expect(statuses.map((s) => s.game).sort()).toEqual(['minecraft', 'valheim']);
    statuses.forEach((s) => expect(s.state).toBe('stopped'));
  });
});

/**
 * Covers the `orchestrator-integration-coverage` delta spec's "Never-deployed
 * stack degrades cleanly" scenario: the `stackOutputs` fixture option defaults
 * to `null`, so this describe block (no `test.use` override) exercises the
 * real never-deployed-stack path.
 */
test.describe('ConfigService — never-deployed stack', () => {
  test('should degrade EnvController.getEnv to local/empty rather than throwing', async ({ ipc, serverMocks: _reset }) => {
    const body = await ipc.dispatch(EnvController, 'getEnv');
    expect(body).toEqual({ region: 'local', domain: '', environment: 'local' });
  });
});
