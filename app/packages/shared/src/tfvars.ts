/**
 * Per-game container configuration shape, historically a straight
 * TypeScript mirror of the `game_servers` map entry object type declared in
 * `terraform/variables.tf` (still kept in sync with that Terraform variable
 * — `terraform/aws/variables.tf:game_servers` remains the field-inventory
 * source of truth). This is the shape `TfvarsService` parses out of
 * `terraform.tfvars` today.
 *
 * As of the `migrate-iac-to-pulumi` change, `GameServer` (via the
 * key-less {@link GameServerConfig} alias below) is also the CANONICAL
 * per-game shape embedded in `DeploymentConfig.gameServers`
 * (`./deploymentConfig.js`) — the typed configuration model that replaces
 * `terraform.tfvars` as the app's configuration source of truth going
 * forward. It is reused there rather than forked into a parallel
 * `camelCase` type specifically because it is already this deeply embedded
 * (`gameServerValidator.ts`'s zod schema, `hclEmit.ts`/`hclSurgeon.ts`,
 * the Games UI) — see `deploymentConfig.ts`'s file doc for the full
 * naming-convention rationale.
 */

/** Single TCP/UDP port a game server container listens on. */
export interface GameServerPort {
  /** Container port number the process listens on (e.g. `25565`). */
  container: number;
  /**
   * Transport protocol. Terraform requires the exact lowercase string
   * `"tcp"` or `"udp"` — passed straight through to ECS `portMappings`,
   * which rejects anything else (`terraform/aws/variables.tf`'s
   * `game_servers` validation block).
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
   * non-empty (`terraform/aws/variables.tf`'s `game_servers` validation
   * block).
   */
  name: string;
  /**
   * Absolute in-container path the volume is mounted at (e.g.
   * `"/palworld"`). Must be non-empty (same validation block as {@link name}).
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
  /** chmod octal string applied to the written file (e.g. `"0644"`). Terraform default when omitted: `"0644"`. */
  mode?: string;
}

/**
 * Per-game container configuration, keyed by game name in the
 * `game_servers` Terraform variable (`terraform/variables.tf`).
 */
export interface GameServer {
  /**
   * The `game_servers` map key for this entry. Not a Terraform object
   * attribute — flattened onto the entry here so a list of `GameServer`
   * values is self-describing without a separate keys array.
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
   * Terraform variable validation, so it lives only in that validator).
   */
  cpu: number;
  /**
   * Fargate task memory in MiB (e.g. `2048`). Must be a value Fargate
   * accepts for the paired {@link cpu} tier — see {@link cpu}'s doc.
   */
  memory: number;
  /** Container ports to expose. An `https: true` entry has additional constraints on this list — see {@link https}. */
  ports: GameServerPort[];
  /** Environment variables injected into the container. Terraform default when omitted: `[]`. */
  environment?: GameServerEnvironmentVariable[];
  /**
   * EFS-backed volume mounts. Must contain at least one entry with a
   * non-empty `name` and `container_path` (`terraform/aws/variables.tf`'s
   * `game_servers` validation block) — there is no Terraform default;
   * this field is required.
   */
  volumes: GameServerVolume[];
  /**
   * When `true`, an in-task Caddy sidecar terminates TLS via Let's Encrypt
   * in front of the game server. Terraform's `optional(bool, false)` default
   * applies whenever this field is omitted — an absent `https` MUST be read
   * as `false`, never as an unresolved third state; `hclEmit.ts` already
   * relies on this (it omits the `https = ...` line entirely rather than
   * writing `https = false`, letting Terraform's own default resolve it),
   * and every write path in the UI (`add-game-wizard`, `edit-game-form`)
   * always sets an explicit `boolean` before submission, so `undefined`
   * only ever arises on the read side (a hand-edited or pre-toggle tfvars
   * entry). When `true`, `terraform/aws/variables.tf`'s `game_servers`
   * validation block requires: at least one entry in {@link ports}; the
   * first port's `protocol` is exactly `"tcp"`; every port's `protocol` is
   * `"tcp"` or `"udp"`; and no port uses container port `80` or `443`
   * (reserved for the sidecar) — enforced client-side by
   * `gameServerValidator.ts`'s `checkHttpsPortRules`.
   */
  https?: boolean;
  /**
   * Discord connect hint shown when the server is running. Supports the
   * placeholders `{host}`, `{ip}`, `{port}` (first port), and `{game}` —
   * any other `{token}` is rejected by
   * `gameServerValidator.ts`'s `checkConnectMessagePlaceholders`. Terraform
   * default when omitted: unset (no hint shown).
   */
  connect_message?: string;
  /**
   * Files pre-seeded onto the EFS volume before the server starts (e.g.
   * server config, mods). Terraform default when omitted: `[]`. Re-applies
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
 * that was previously hand-duplicated (see `TfvarsService`'s
 * `RawGameServerEntry` and `ConfigService`'s `TfOutputs.applied_game_servers`
 * in `@hyveon/desktop-main`).
 */
export type GameServerConfig = Omit<GameServer, 'name'>;

/**
 * Response entry for the merged games list (the `games.list` IPC channel /
 * `/api/games` HTTP route). Combines the declared view (`terraform.tfvars`,
 * via {@link GameServer}) with the deployed view (`terraform.tfstate`) so
 * callers can tell "declared but not yet applied" apart from "live" games —
 * see issue #92.
 */
export interface GameListEntry {
  /**
   * Game key. Sourced from the tfvars `game_servers` map key when
   * `declared` is true, otherwise from the tfstate game name.
   */
  name: string;
  /** True when this game has an entry in the tfvars `game_servers` map. */
  declared: boolean;
  /** True when this game has a deployed ECS task definition in tfstate. */
  deployed: boolean;
  /**
   * Full tfvars-parsed configuration for this game. Only present when
   * `declared` is true.
   */
  config?: GameServer;
}
