import type { GameServerConfig, GameServerPort } from './gameServerConfig.js';

/** Container ports the in-task Caddy sidecar binds publicly on any `https: true` game. */
export const HTTPS_RESERVED_PORTS = [80, 443] as const;

/** `true` when `port` is one of {@link HTTPS_RESERVED_PORTS}. */
export function isReservedHttpsPort(port: number): boolean {
  return (HTTPS_RESERVED_PORTS as readonly number[]).includes(port);
}

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
