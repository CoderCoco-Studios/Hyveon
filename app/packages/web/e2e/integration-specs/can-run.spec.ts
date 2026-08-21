import { canRun } from '@hyveon/shared';
import type { DiscordConfig } from '@hyveon/shared';
import { DiscordController } from '@hyveon/desktop-main/dist/controllers/discord.controller.js';
import { test, expect, DEFAULT_STACK_OUTPUTS } from './index.js';

/**
 * Verifies `canRun()` permission enforcement against config seeded through the real
 * `DiscordController` IPC channels — not a hand-built `DiscordConfig` — so the spec also
 * exercises the write/read path (`addGuild`/`putAdmins`/`putPermission`/`getConfig`) that
 * produces the config `canRun()` evaluates in production.
 *
 * `canRun()` is a pure function that returns a boolean; it never throws, so there is no
 * "rejected with an error" case to assert here. The user-facing deny message is a separate
 * concern owned by the Discord interaction Lambdas and covered by their own unit tests.
 */
test.describe('canRun() permission enforcement', () => {
  test('should enforce guild allowlisting, admin bypass, and per-game action grants', async ({
    ipc,
    serverMocks: _reset,
  }) => {
    ipc.mocks.pulumi.scriptStackOutputs(DEFAULT_STACK_OUTPUTS);

    await ipc.dispatch(DiscordController, 'addGuild', { guildId: 'G1' });
    await ipc.dispatch(DiscordController, 'putAdmins', { userIds: ['ADMIN'], roleIds: [] });
    await ipc.dispatch(DiscordController, 'putPermission', {
      game: 'minecraft',
      body: { userIds: ['U1'], roleIds: [], actions: ['start'] },
    });

    const cfg = (await ipc.dispatch(DiscordController, 'getConfig')) as DiscordConfig;

    // Positive control: proves the seeding above actually took effect, so the negative
    // cases below aren't passing vacuously against an empty/unseeded config.
    expect(
      canRun(cfg, { guildId: 'G1', userId: 'U1', roleIds: [], game: 'minecraft', action: 'start' }),
    ).toBe(true);

    // Admins bypass per-game permissions entirely.
    expect(
      canRun(cfg, { guildId: 'G1', userId: 'ADMIN', roleIds: [], game: 'minecraft', action: 'stop' }),
    ).toBe(true);

    // Guild not in allowedGuilds.
    expect(
      canRun(cfg, { guildId: 'G-OTHER', userId: 'U1', roleIds: [], game: 'minecraft', action: 'start' }),
    ).toBe(false);

    // Non-admin user with no per-game entry.
    expect(
      canRun(cfg, { guildId: 'G1', userId: 'U-STRANGER', roleIds: [], game: 'minecraft', action: 'start' }),
    ).toBe(false);

    // User has a per-game entry, but the entry doesn't grant the requested action.
    expect(
      canRun(cfg, { guildId: 'G1', userId: 'U1', roleIds: [], game: 'minecraft', action: 'stop' }),
    ).toBe(false);
  });
});
