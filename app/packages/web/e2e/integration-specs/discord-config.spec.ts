import { DiscordController } from '@hyveon/desktop-main/dist/controllers/discord.controller.js';
import { STACK_OUTPUTS_FIXTURE } from '../fixtures/stack-outputs.fixture.js';
import { test, expect } from './index.js';

/**
 * Verifies the server-side secret-redaction contract for `DiscordController.getConfig`.
 *
 * `DiscordController.getConfig()` delegates to `DiscordConfigService.getRedacted()`,
 * which returns `botTokenSet`/`publicKeySet` booleans in place of the raw secrets.
 * This spec dispatches directly to the IPC controller and asserts that the raw
 * `botToken` and `publicKey` fields are absent from the response body.
 *
 * `getRedacted()` resolves the Discord Secrets Manager ARNs/DynamoDB table name
 * off `PulumiService.getStackOutputs()` before it ever reaches its own
 * gracefully-catching DynamoDB/Secrets Manager calls, so a deployed-stack
 * scripted response (`STACK_OUTPUTS_FIXTURE`) is required — a never-deployed
 * stack throws before those calls are even attempted. The DynamoDB/Secrets
 * Manager calls themselves still fail gracefully in this test environment (no
 * real AWS credentials, no mock installed), so the service returns an empty
 * config with both `*Set` flags false — which is still sufficient to prove
 * the redaction contract.
 */
test.describe('Discord config — secret redaction', () => {
  test.use({ stackOutputs: STACK_OUTPUTS_FIXTURE });

  test('should never echo the bot token or public key in the config response', async ({
    ipc,
    serverMocks: _reset,
  }) => {
    const body = (await ipc.dispatch(DiscordController, 'getConfig')) as Record<string, unknown>;

    // Raw secrets must not be present — the contract is booleans-only.
    expect(body).not.toHaveProperty('botToken');
    expect(body).not.toHaveProperty('publicKey');

    // The redacted boolean flags must be present and be actual booleans.
    expect(body).toHaveProperty('botTokenSet');
    expect(body).toHaveProperty('publicKeySet');
    expect(typeof body['botTokenSet']).toBe('boolean');
    expect(typeof body['publicKeySet']).toBe('boolean');
  });
});
