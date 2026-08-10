import type { DriftEntry, GameListEntry, GameServer } from '@hyveon/shared';

/**
 * Merges the declared view of games (`deployment-config.json`'s `gameServers`
 * map, via {@link GameServer}) with the deployed view (the deployed stack's
 * `gameNames` output) into the union `GameListEntry[]` shape returned by the
 * `games.list` IPC channel / `/api/games` HTTP route — see issue #92.
 *
 * A game appears exactly once in the result, keyed by name, with `declared`
 * and `deployed` flags set independently so callers can distinguish
 * "declared but not yet applied" from "live but no longer declared" from
 * "both". `config` is only populated for declared games. `drift` is attached
 * from `driftEntries` when a matching finding exists, for any `DriftKind` —
 * callers decide which kinds are worth surfacing.
 *
 * Pure function — no I/O, no side effects. Ordering is deterministic: entries
 * appear in `declared` (`deployment-config.json`) order first, followed by any deployed-only
 * entries (present in `deployed` but not `declared`) in `deployed` order.
 *
 * @param declared - Games parsed from `deployment-config.json` (`DeploymentConfigService.getGameServers()`).
 * @param deployed - Game names present in the deployed stack's outputs (`ConfigService.getStackOutputs()?.gameNames`).
 * @param driftEntries - Per-game drift findings from `DriftService.getDrift()`. Defaults to empty.
 */
export function mergeGameLists(
  declared: GameServer[],
  deployed: string[],
  driftEntries: DriftEntry[] = [],
): GameListEntry[] {
  const entries = new Map<string, GameListEntry>();
  const driftByName = new Map(driftEntries.map((entry) => [entry.game, entry]));

  for (const config of declared) {
    entries.set(config.name, {
      name: config.name,
      declared: true,
      deployed: false,
      config,
      drift: toDrift(driftByName.get(config.name)),
    });
  }

  for (const name of deployed) {
    const existing = entries.get(name);
    if (existing) {
      existing.deployed = true;
    } else {
      entries.set(name, {
        name,
        declared: false,
        deployed: true,
        drift: toDrift(driftByName.get(name)),
      });
    }
  }

  return Array.from(entries.values());
}

/** Narrows a {@link DriftEntry} to the `kind`/`changedFields` shape `GameListEntry.drift` carries. */
function toDrift(entry: DriftEntry | undefined): GameListEntry['drift'] {
  if (!entry) return undefined;
  return { kind: entry.kind, changedFields: entry.changedFields };
}
