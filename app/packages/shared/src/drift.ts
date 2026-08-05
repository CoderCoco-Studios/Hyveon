/**
 * Shared types for drift detection — comparing the declared game server
 * configuration (`deployment-config.json`, via `DeploymentConfigService.getGameServers()`)
 * against the live deployed state (read off the deployed Pulumi stack, via
 * `ConfigService.getStackOutputs()`). See issue #94.
 */

/**
 * Category of mismatch between a game's declared and deployed state.
 *
 * - `pending_create` — declared but not yet applied/deployed.
 * - `pending_delete` — deployed but no longer present in the declared config.
 * - `config_drift`   — present in both, but one or more fields (ports,
 *   image, CPU, memory, volume mounts, etc.) differ between the declared
 *   and deployed configuration.
 */
export type DriftKind = 'pending_create' | 'pending_delete' | 'config_drift';

/**
 * Name of a top-level game server config field that can differ between the
 * declared and deployed configuration for a
 * `'config_drift'` finding. Deliberately a closed set of field names — no
 * declared/deployed config payloads are echoed back, only which fields
 * changed.
 */
export type DriftChangedField = 'ports' | 'image' | 'cpu' | 'memory' | 'volumes';

/**
 * A single per-game drift finding, produced by comparing a game's declared
 * configuration against its live deployed configuration.
 */
export interface DriftEntry {
  /** Game key (matches the `game_servers` map key / deployed game name). */
  game: string;
  /** Category of drift detected for this game. */
  kind: DriftKind;
  /**
   * Names of the fields that differ between declared and deployed
   * configuration. Only present when `kind` is `'config_drift'`. No
   * declared/deployed values are included — only the field names.
   */
  changedFields?: DriftChangedField[];
}

/**
 * Aggregate drift report returned by `GET /api/drift`. Lists every game
 * that is out of sync between its declared and deployed configuration;
 * games that are in sync (declared and deployed, with matching config) are
 * omitted entirely.
 */
export interface DriftReport {
  /** Per-game drift findings. Empty when declared and deployed state match. */
  entries: DriftEntry[];
}
