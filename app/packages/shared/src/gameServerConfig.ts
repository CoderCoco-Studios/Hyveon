import type { DriftKind, DriftChangedField } from './drift.js';

/**
 * Per-game container configuration shape, historically a straight
 * TypeScript mirror of the `game_servers` map entry object type declared in
 * the app's original, now fully retired IaC config input — that retired
 * config input is this shape's historical field-inventory source;
 * `DeploymentConfig.gameServers` (`./deploymentConfig.js`)
 * is the CURRENT source of truth per `CLAUDE.md`'s invariants list.
 * `DeploymentConfigService` parses this shape out of `deployment-config.json`
 * today (originally out of the app's per-deployment IaC values file, before
 * the Pulumi migration).
 *
 * `GameServer` (via the key-less {@link GameServerConfig} alias below) is
 * the CANONICAL per-game shape embedded in `DeploymentConfig.gameServers`.
 * It is reused there rather than forked into a parallel `camelCase` type
 * specifically because it is already this deeply embedded
 * (`gameServerValidator.ts`'s zod schema, `DeploymentConfigService.ts`'s JSON read/write
 * paths, the Games UI) — see `deploymentConfig.ts`'s file doc for the full
 * naming-convention rationale.
 */

/** Single TCP/UDP port a game server container listens on. */
export interface GameServerPort {
  /** Container port number the process listens on (e.g. `25565`). */
  container: number;
  /**
   * Transport protocol. Must be the exact lowercase string `"tcp"` or
   * `"udp"` — passed straight through to ECS `portMappings`, which rejects
   * anything else. Inherited from the app's original `game_servers`
   * validation block's same requirement.
   */
  protocol: string;
}

/** Environment variable injected into the game server container. */
export interface GameServerEnvironmentVariable {
  /** Environment variable name (e.g. `"EULA"`). */
  name: string;
  /** Environment variable value, always a string (container env vars have no other type). */
  value: string;
}

/** EFS-backed volume mount for a game server container. */
export interface GameServerVolume {
  /**
   * Volume identifier, unique within the entry. Each `(game, name)` pair
   * gets its own EFS access point rooted at `/${game}/${name}`. Must be
   * non-empty — enforced by `gameServerValidator.ts`'s `gameServerVolumeSchema`,
   * mirroring the app's original `game_servers` validation block's same
   * requirement.
   */
  name: string;
  /**
   * Absolute in-container path the volume is mounted at (e.g.
   * `"/palworld"`). Must be non-empty (same schema as {@link name}).
   */
  container_path: string;
}

/**
 * File seeded into the container filesystem at task start (e.g. server
 * config or mod files). Exactly one of `content` / `content_base64` is
 * normally supplied.
 */
export interface GameServerFileSeed {
  /**
   * In-container path to write the seed file to (e.g.
   * `"/palworld/Pal/Saved/Config/LinuxServer/PalWorldSettings.ini"`). The
   * `container_path` prefix of the owning volume is stripped to resolve the
   * location within that volume's EFS access point.
   */
  path: string;
  /** UTF-8 text content to write. Mutually exclusive with {@link content_base64} in practice, though the type does not enforce it. */
  content?: string;
  /** Base64-encoded binary content to write (e.g. mods) — for files that aren't valid UTF-8. Mutually exclusive with {@link content} in practice. */
  content_base64?: string;
  /** chmod octal string applied to the written file (e.g. `"0644"`). Default when omitted: `"0644"`. */
  mode?: string;
}

/**
 * Per-game container configuration, keyed by game name in
 * `DeploymentConfig.gameServers`'s `game_servers` map (historically the
 * app's original `game_servers` config input).
 */
export interface GameServer {
  /**
   * The `game_servers` map key for this entry. Not an attribute of the map
   * value itself (mirroring that original config input's own shape) —
   * flattened onto the entry here so a list of `GameServer` values is
   * self-describing without a separate keys array.
   */
  name: string;
  /** Container image reference (e.g. `"itzg/minecraft-server:latest"`), pulled by the ECS task. */
  image: string;
  /**
   * Fargate CPU units for the task (e.g. `1024` = 1 vCPU). Must be one of
   * the discrete values Fargate accepts (256/512/1024/2048/4096/8192/16384)
   * and paired with a valid {@link memory} for that tier — the exact table
   * is enforced by `gameServerValidator.ts`'s `checkFargateCpuMemoryPairing`,
   * mirroring AWS's Fargate task-size documentation (not expressible as a
   * declarative config-input validation, so it lives only in that validator).
   */
  cpu: number;
  /**
   * Fargate task memory in MiB (e.g. `2048`). Must be a value Fargate
   * accepts for the paired {@link cpu} tier — see {@link cpu}'s doc.
   */
  memory: number;
  /** Container ports to expose. An `https: true` entry has additional constraints on this list — see {@link https}. */
  ports: GameServerPort[];
  /** Environment variables injected into the container. Default when omitted: `[]`. */
  environment?: GameServerEnvironmentVariable[];
  /**
   * EFS-backed volume mounts. Must contain at least one entry with a
   * non-empty `name` and `container_path` — enforced by
   * `gameServerValidator.ts`, mirroring the app's original
   * `game_servers` validation block's same requirement; there is no
   * default, this field is required.
   */
  volumes: GameServerVolume[];
  /**
   * When `true`, an in-task Caddy sidecar terminates TLS via Let's Encrypt
   * in front of the game server. Defaults to `false` whenever this field is
   * omitted (inherited from the app's original `optional(bool, false)`
   * declaration) — an absent `https` MUST be read as `false`, never as an
   * unresolved third state; `DeploymentConfigService.ts`'s JSON write path
   * preserves this (it round-trips whatever `https` value — present or
   * absent — the caller supplied, rather than ever synthesizing an explicit
   * `false`), and every write path in the UI (`add-game-wizard`,
   * `edit-game-form`) always sets an explicit `boolean` before submission,
   * so `undefined` only ever arises on the read side (a hand-edited or
   * pre-toggle config entry). When `true`, `gameServerValidator.ts`'s
   * `checkHttpsPortRules` requires: at least one entry in {@link ports}; the
   * first port's `protocol` is exactly `"tcp"`; every port's `protocol` is
   * `"tcp"` or `"udp"`; and no port uses container port `80` or `443`
   * (reserved for the sidecar) — mirroring the same rules the app's
   * original, retired `game_servers` validation block used to enforce.
   */
  https?: boolean;
  /**
   * Discord connect hint shown when the server is running. Supports the
   * placeholders `{host}`, `{ip}`, `{port}` (first port), and `{game}` —
   * any other `{token}` is rejected by
   * `gameServerValidator.ts`'s `checkConnectMessagePlaceholders`. Default
   * when omitted: unset (no hint shown).
   */
  connect_message?: string;
  /**
   * Files pre-seeded onto the EFS volume before the server starts (e.g.
   * server config, mods). Default when omitted: `[]`. Re-applies
   * only when seed content changes; removed entries are NOT deleted from
   * EFS.
   */
  file_seeds?: GameServerFileSeed[];
}

/**
 * A {@link GameServer} entry with the map key (`name`) stripped, matching the
 * shape of a single value in a `game_servers`-keyed map/record — `name` is
 * the map key, never an attribute of the entry itself. Used wherever a
 * `game_servers` map is represented as `Record<string, GameServerConfig>`
 * rather than a flattened list — e.g. {@link DeploymentConfig.gameServers}
 * (`./deploymentConfig.js`) and {@link StackOutputs.appliedGameServers}
 * (`./stackOutputs.js`). Consolidates the `Omit<GameServer, 'name'>` shape
 * that was previously hand-duplicated (see `DeploymentConfigService`'s
 * `RawGameServerEntry` in `@hyveon/desktop-main`).
 */
export type GameServerConfig = Omit<GameServer, 'name'>;

/**
 * Response entry for the merged games list (the `games.list` IPC channel /
 * `/api/games` HTTP route). Combines the declared view
 * (`DeploymentConfig.gameServers`, via {@link GameServer}) with the deployed
 * view (tfstate) so callers can tell "declared but not yet applied" apart
 * from "live" games — see issue #92.
 */
export interface GameListEntry {
  /**
   * Game key. Sourced from the declared `game_servers` map key when
   * `declared` is true, otherwise from the tfstate game name.
   */
  name: string;
  /** True when this game has an entry in the declared `game_servers` map (`DeploymentConfig.gameServers`). */
  declared: boolean;
  /** True when this game has a deployed ECS task definition in tfstate. */
  deployed: boolean;
  /**
   * Full declared configuration for this game (parsed from
   * `DeploymentConfig.gameServers`). Only present when `declared` is true.
   */
  config?: GameServer;
  /**
   * Drift finding for this game, from `DriftService.computeDrift`. Present
   * whenever the game has an entry in the current `DriftReport`, regardless
   * of kind — but only a `'config_drift'` kind carries new information the
   * `declared`/`deployed` flags above can't already express.
   */
  drift?: { kind: DriftKind; changedFields?: DriftChangedField[] };
}
