import type { DiscordAction, DiscordConfig } from './types.js';

/**
 * Resolve whether a user with given role IDs is allowed to run `action` on
 * `game` in `guildId`. Evaluation order:
 *
 * 1. **Guild allowlist** — unknown guild → deny.
 * 2. **Admin user/role** — listed in `admins` → allow any action on any game.
 * 3. **Per-game entry** — user ID or one of their roles matches *and* the
 *    requested action is in that entry's `actions` → allow.
 * 4. Otherwise → deny.
 *
 * Pure function — no I/O, no `this`. Same logic that lived in
 * DiscordConfigService.canRun() before the serverless migration.
 *
 * Exactly one copy — imported verbatim by `@hyveon/desktop-main` and every Lambda. Never fork
 * or re-implement this logic (CLAUDE.md invariant).
 */
export function canRun(
  cfg: DiscordConfig,
  params: {
    guildId: string;
    userId: string;
    roleIds: string[];
    game: string;
    action: DiscordAction;
  },
): boolean {
  if (!cfg.allowedGuilds.includes(params.guildId)) return false;
  if (cfg.admins.userIds.includes(params.userId)) return true;
  if (cfg.admins.roleIds.some((r) => params.roleIds.includes(r))) return true;
  const perm = cfg.gamePermissions[params.game];
  if (!perm) return false;
  if (!perm.actions.includes(params.action)) return false;
  if (perm.userIds.includes(params.userId)) return true;
  if (perm.roleIds.some((r) => params.roleIds.includes(r))) return true;
  return false;
}
