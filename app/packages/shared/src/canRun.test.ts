import { describe, it, expect } from 'vitest';
import { canRun } from './canRun.js';
import type { DiscordConfig } from './types.js';

/** Build a minimal DiscordConfig with sensible defaults; override any fields per test. */
function makeConfig(overrides: Partial<DiscordConfig> = {}): DiscordConfig {
  return {
    clientId: '',
    allowedGuilds: ['G1'],
    admins: { userIds: [], roleIds: [] },
    gamePermissions: {},
    ...overrides,
  };
}

// @spec DISCORD-PERM-001, DISCORD-PERM-002, DISCORD-PERM-003, DISCORD-PERM-004
describe('canRun', () => {
  it('should deny commands from a guild that is not in the allowlist', () => {
    const cfg = makeConfig({ allowedGuilds: ['other'] });
    const allowed = canRun(cfg, { guildId: 'G1', userId: 'U1', roleIds: [], game: 'palworld', action: 'start' });
    expect(allowed).toBe(false);
  });

  it('should allow admin user ids to run any action on any game regardless of gamePermissions', () => {
    const cfg = makeConfig({ admins: { userIds: ['U1'], roleIds: [] } });
    const allowed = canRun(cfg, { guildId: 'G1', userId: 'U1', roleIds: [], game: 'palworld', action: 'stop' });
    expect(allowed).toBe(true);
  });

  it('should allow admin role ids to run any action on any game regardless of gamePermissions', () => {
    const cfg = makeConfig({ admins: { userIds: [], roleIds: ['R-admin'] } });
    const allowed = canRun(cfg, {
      guildId: 'G1',
      userId: 'U1',
      roleIds: ['R-admin'],
      game: 'palworld',
      action: 'status',
    });
    expect(allowed).toBe(true);
  });

  it('should deny when no gamePermissions entry exists for the requested game', () => {
    const cfg = makeConfig();
    const allowed = canRun(cfg, { guildId: 'G1', userId: 'U1', roleIds: [], game: 'palworld', action: 'status' });
    expect(allowed).toBe(false);
  });

  it('should deny when the user is listed but the action is not in the entry actions', () => {
    const cfg = makeConfig({
      gamePermissions: { palworld: { userIds: ['U1'], roleIds: [], actions: ['status'] } },
    });
    const allowed = canRun(cfg, { guildId: 'G1', userId: 'U1', roleIds: [], game: 'palworld', action: 'start' });
    expect(allowed).toBe(false);
  });

  it('should allow when a user id is listed in the per-game entry and the action is permitted', () => {
    const cfg = makeConfig({
      gamePermissions: { palworld: { userIds: ['U1'], roleIds: [], actions: ['start'] } },
    });
    const allowed = canRun(cfg, { guildId: 'G1', userId: 'U1', roleIds: [], game: 'palworld', action: 'start' });
    expect(allowed).toBe(true);
  });

  it('should allow when a role id is listed in the per-game entry and the action is permitted', () => {
    const cfg = makeConfig({
      gamePermissions: { palworld: { userIds: [], roleIds: ['R-players'], actions: ['start', 'status'] } },
    });
    const allowed = canRun(cfg, {
      guildId: 'G1',
      userId: 'U1',
      roleIds: ['R-players'],
      game: 'palworld',
      action: 'start',
    });
    expect(allowed).toBe(true);
  });

  it('should deny when the user has none of the allowed user or role ids even if the action is permitted', () => {
    const cfg = makeConfig({
      gamePermissions: { palworld: { userIds: ['someone-else'], roleIds: ['R-admin'], actions: ['start'] } },
    });
    const allowed = canRun(cfg, {
      guildId: 'G1',
      userId: 'U1',
      roleIds: ['R-players'],
      game: 'palworld',
      action: 'start',
    });
    expect(allowed).toBe(false);
  });

  it('should short-circuit on guild allowlist before even consulting gamePermissions', () => {
    const cfg = makeConfig({
      allowedGuilds: ['OTHER'],
      admins: { userIds: ['U1'], roleIds: [] },
      gamePermissions: { palworld: { userIds: ['U1'], roleIds: [], actions: ['start'] } },
    });
    const allowed = canRun(cfg, { guildId: 'G1', userId: 'U1', roleIds: [], game: 'palworld', action: 'start' });
    expect(allowed).toBe(false);
  });
});
