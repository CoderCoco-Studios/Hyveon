import type { DeploymentConfig } from './deploymentConfig.js';
import type { GameServerConfig, GameServerPort } from './gameServerConfig.js';

/** Container ports the in-task Caddy sidecar binds publicly on any `https: true` game. */
export const HTTPS_RESERVED_PORTS = [80, 443] as const;

/** `true` when `port` is one of {@link HTTPS_RESERVED_PORTS}. */
export function isReservedHttpsPort(port: number): boolean {
  return (HTTPS_RESERVED_PORTS as readonly number[]).includes(port);
}

/**
 * Marker the `GAME_PORTS` env map carries for an `https: true` game in place of
 * a port number: the player-facing connect target is the public 443 URL, never
 * `webPort` or an extra port. {@link renderConnectMessage} expands it.
 */
export const HTTPS_CONNECT_PORT = 'https' as const;

/** A `GAME_PORTS` entry: a container port number, or {@link HTTPS_CONNECT_PORT} for https games. */
export type ConnectPort = number | typeof HTTPS_CONNECT_PORT;

/**
 * Structural minimum {@link normalizeGameServer} reads. Looser than
 * {@link GameServerConfig} so wizard drafts (`container: number | null`)
 * share the one implementation.
 */
interface NormalizableGame {
  https?: boolean;
  webPort?: number | null;
  ports: readonly { container: number | null; protocol: string }[];
}

/**
 * Rewrites the legacy https shape into the explicit one: `ports[0]` becomes
 * `webPort` and the remaining entries stay as `ports`.
 *
 * @remarks
 * Legacy shape: an `https: true` game with no `webPort`, where `ports[0]` was
 * the implicit Caddy upstream. Read-time compatibility only; remove once no
 * supported release can have written it (first minor after the one shipping
 * `webPort`, plus one release of overlap).
 *
 * Pure and idempotent. Games that are not legacy-shaped are returned as the
 * same reference. A legacy game whose `ports[0]` is not `tcp` (or has no
 * container yet) or a malformed game with no `ports` array is also returned untouched, so validation reports the
 * missing `webPort` instead of this function guessing. A reserved `ports[0]`
 * (80/443) is promoted as-is and rejected by the validator on save.
 *
 * @typeParam T - The game shape; returned as the same type.
 * @param game - The game as read from storage or a draft.
 * @returns The normalised game, or `game` itself when nothing changed.
 * @deprecated Handles the legacy implicit-upstream (`ports[0]`) https shape only.
 */
export function normalizeGameServer<T extends NormalizableGame>(game: T): T {
  if (game.https !== true || (game.webPort !== undefined && game.webPort !== null)) {
    return game;
  }
  if (!Array.isArray(game.ports)) {
    return game;
  }
  const [first, ...rest] = game.ports;
  if (first === undefined || first.protocol !== 'tcp' || first.container === null) {
    return game;
  }
  return { ...game, webPort: first.container, ports: rest };
}

/**
 * Applies {@link normalizeGameServer} to every entry of `config.gameServers`.
 * For readers that consume the raw S3 object directly (the Pulumi preview/apply
 * path and rollback diffs) rather than via `DeploymentConfigService`.
 *
 * @param config - A parsed deployment config, possibly holding legacy https entries.
 * @returns `config` itself when nothing changed, otherwise a copy with normalised games.
 * @deprecated Handles the legacy implicit-upstream (`ports[0]`) https shape only; removable with {@link normalizeGameServer}.
 */
export function normalizeDeploymentConfigGames(config: DeploymentConfig): DeploymentConfig {
  const games = config.gameServers;
  if (typeof games !== 'object' || games === null) {
    return config;
  }
  let changed = false;
  // Null prototype so a legacy `__proto__` game key is stored as an own property, not swallowed by the prototype setter.
  const gameServers = Object.create(null) as DeploymentConfig['gameServers'];
  for (const [name, game] of Object.entries(games)) {
    const normalised = normalizeGameServer(game);
    changed ||= normalised !== game;
    gameServers[name] = normalised;
  }
  return changed ? { ...config, gameServers } : config;
}

/**
 * The entries of `game.ports` that receive security-group ingress: all of
 * them except a tcp entry duplicating `webPort`, which is only reachable
 * through Caddy. ICMP filtering is left to the caller.
 *
 * @param game - A normalised game config.
 * @returns The ingress-eligible port entries, in declaration order.
 */
export function ingressPorts(game: GameServerConfig): GameServerPort[] {
  const { webPort } = game;
  if (webPort === undefined) {
    return game.ports;
  }
  return game.ports.filter((port) => !(port.container === webPort && port.protocol.toLowerCase() === 'tcp'));
}

/**
 * Finds `https` games whose `webPort` is also a `tcp` extra port of a different game. The security
 * group is shared across games and ingress rules union, so that extra port's rule would expose the
 * other game's Caddy upstream directly. The write path rejects this ({@link validateGameServer}
 * in `gameServerValidator.ts`); this re-checks raw reads that bypass it, such as legacy configs.
 *
 * @param config - A normalised deployment config (see {@link normalizeDeploymentConfigGames}).
 * @returns One human-readable message per collision; empty when there are none.
 */
export function findWebPortCollisions(config: DeploymentConfig): string[] {
  const games = Object.entries(config.gameServers ?? {});
  const messages: string[] = [];
  for (const [owner, ownerGame] of games) {
    const { webPort } = ownerGame;
    if (ownerGame.https !== true || typeof webPort !== 'number') {
      continue;
    }
    for (const [other, otherGame] of games) {
      if (other === owner || !Array.isArray(otherGame.ports)) {
        continue;
      }
      if (otherGame.ports.some((port) => port.container === webPort && port.protocol.toLowerCase() === 'tcp')) {
        messages.push(`Game "${owner}" webPort ${webPort} collides with tcp port ${webPort} on game "${other}"; the shared security group would expose "${owner}"'s upstream directly, bypassing Caddy.`);
      }
    }
  }
  return messages;
}
