import { canRun } from '@hyveon/shared';
import type { DiscordConfig } from '@hyveon/shared';
import { DiscordController } from '@hyveon/desktop-main/dist/controllers/discord.controller.js';
import { test, expect, DEFAULT_STACK_OUTPUTS } from './index.js';

/**
 * Verifies `canRun()` permission enforcement against config seeded through the real
 * `DiscordController` IPC channels — not a hand-built `DiscordConfig` — so the spec also
 * exercises the write/read path (`addGuild`/`putAdmins`/`putPermission`/`getConfig`).
 *
 * Scope note: this only covers the dynamic `CONFIG#discord` row `DiscordController` writes.
 * Production (`InteractionsLambda`/`FollowupLambda`) calls `canRun()` against
 * `getEffectiveDiscordConfig()` — the union of this row with the Pulumi-managed
 * `BASE#discord` row (`DiscordConfig`'s own doc comment) — which isn't writable via IPC and
 * so isn't exercised here.
 *
 * Also: no dedicated DynamoDB mock backs the Discord config table in this harness (unlike
 * `run-record-mock.ts`), so `getConfig()`'s read here is served by `DiscordConfigService`'s
 * in-memory cache rather than a real round-trip through the (unmocked) `CONFIG#discord`
 * key — the seeded writes above never actually reach a working persistence fake.
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
    await ipc.dispatch(DiscordController, 'putAdmins', { userIds: ['ADMIN'], roleIds: ['ADMIN_ROLE'] });
    await ipc.dispatch(DiscordController, 'putPermission', {
      game: 'minecraft',
      body: { userIds: ['U1'], roleIds: ['R1'], actions: ['start'] },
    });

    const cfg: DiscordConfig = await ipc.dispatch(DiscordController, 'getConfig');

    // Positive control: proves the seeding above took effect, so the negative cases below aren't passing vacuously.
    expect(
      canRun(cfg, { guildId: 'G1', userId: 'U1', roleIds: [], game: 'minecraft', action: 'start' }),
    ).toBe(true);

    // Admins bypass per-game permissions entirely (matched by user ID).
    expect(
      canRun(cfg, { guildId: 'G1', userId: 'ADMIN', roleIds: [], game: 'minecraft', action: 'stop' }),
    ).toBe(true);

    // Admins bypass per-game permissions entirely (matched by role ID).
    expect(
      canRun(cfg, { guildId: 'G1', userId: 'RANDOM', roleIds: ['ADMIN_ROLE'], game: 'minecraft', action: 'stop' }),
    ).toBe(true);

    // Per-game grant matched by role ID rather than user ID.
    expect(
      canRun(cfg, { guildId: 'G1', userId: 'RANDOM2', roleIds: ['R1'], game: 'minecraft', action: 'start' }),
    ).toBe(true);

    // Guild not in allowedGuilds.
    expect(
      canRun(cfg, { guildId: 'G-OTHER', userId: 'U1', roleIds: [], game: 'minecraft', action: 'start' }),
    ).toBe(false);

    // User isn't listed (by ID or role) in the per-game entry that does exist for this game.
    expect(
      canRun(cfg, { guildId: 'G1', userId: 'U-STRANGER', roleIds: [], game: 'minecraft', action: 'start' }),
    ).toBe(false);

    // User has a per-game entry, but the entry doesn't grant the requested action.
    expect(
      canRun(cfg, { guildId: 'G1', userId: 'U1', roleIds: [], game: 'minecraft', action: 'stop' }),
    ).toBe(false);
  });
});
