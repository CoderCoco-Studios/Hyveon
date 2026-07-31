import { DiscordController } from '@hyveon/desktop-main/dist/controllers/discord.controller.js';
import { test, expect, DEFAULT_STACK_OUTPUTS } from './index.js';

/**
 * Verifies the server-side secret-redaction contract for `DiscordController.getConfig`.
 *
 * `DiscordController.getConfig()` delegates to `DiscordConfigService.getRedacted()`,
 * which returns `botTokenSet`/`publicKeySet` booleans in place of the raw secrets.
 * This spec dispatches directly to the IPC controller and asserts that the raw
 * `botToken` and `publicKey` fields are absent from the response body.
 *
 * `DiscordConfigService` resolves its DynamoDB table name and Secrets Manager
 * ARNs from `ConfigService.getStackOutputs()`, so the `ipc` harness's
 * `PulumiService` DI-seam stub is scripted with `DEFAULT_STACK_OUTPUTS` first
 * — without it, `getRedacted()` throws before ever reaching DynamoDB/Secrets
 * Manager (see `DiscordConfigService.botTokenSecretArn`/`publicKeySecretArn`,
 * "not in the deployed stack outputs"). The subsequent DynamoDB and Secrets
 * Manager calls themselves still fail gracefully in the test environment (no
 * real AWS credentials), so the service returns an empty config with both
 * `*Set` flags false — which is still sufficient to prove the redaction
 * contract.
 */
test.describe('Discord config — secret redaction', () => {
  test('should never echo the bot token or public key in the config response', async ({
    ipc,
    serverMocks: _reset,
  }) => {
    ipc.mocks.pulumi.scriptStackOutputs(DEFAULT_STACK_OUTPUTS);

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
