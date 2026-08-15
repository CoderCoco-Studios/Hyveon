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
  /**
   * Network reachability for this port on the shared `game_servers`
   * security group. `'public'` ingresses from `0.0.0.0/0` (the open
   * internet); `'internal'` ingresses from the VPC's CIDR block only, so
   * the port is reachable from anything inside the VPC (e.g. the
   * health-check Lambda) but not from the internet. Omitted is treated
   * identically to `'public'` — mirrors the {@link GameServer.https}
   * `undefined ≡ false` contract — so every configuration written before
   * this field existed keeps its current `0.0.0.0/0` ingress unchanged.
   * Only affects non-HTTPS games: an HTTPS game's container ports are
   * never individually security-group-ingressed (the in-task Caddy
   * sidecar proxies to them over localhost), so this field is a no-op
   * there.
   */
  visibility?: 'public' | 'internal';
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
 * Credential reference for an authenticated health check. Carries a
 * Secrets Manager ARN — never a raw value — plus a `type` discriminator for
 * how the resolved secret's value is turned into the outbound request's
 * `Authorization` header.
 */
export interface GameServerHealthCheckAuth {
  /**
   * Credential shape this reference declares. `'raw'` (the default when
   * this field is absent) injects the resolved secret's raw value verbatim,
   * no prefix — exactly the behavior every configuration had before this
   * field existed. `'basic'` and `'bearer'` are both app-owned: the system
   * creates, updates, and deletes the backing secret itself; the operator
   * supplies only the credential's plaintext parts (never a `secretArn`) for
   * those two types. See `GamesWriteService.resolveHealthCheckAuthSecret`
   * (`@hyveon/desktop-main`) for the write-side resolution that turns
   * operator-submitted plaintext into this field's `secretArn`.
   */
  type?: 'raw' | 'basic' | 'bearer';
  /**
   * ARN of the Secrets Manager secret whose value is injected as the
   * outbound request's `Authorization` header. Operator-supplied and
   * operator-owned for `type: 'raw'` (or no `type`). App-created and
   * app-owned for `type: 'basic'`/`'bearer'` — deterministically named
   * `hyveon-{gameId}-healthcheck-auth`; the operator never sees or enters
   * this ARN for those two types.
   */
  secretArn: string;
}

/**
 * Single comparison evaluated against the health-check response body to
 * derive the active/idle verdict.
 */
export interface GameServerHealthCheckCondition {
  /**
   * JSONPath into the parsed JSON response body, restricted to plain field
   * access and numeric array indices (no wildcards, filters, slices, or
   * recursive descent). Must resolve to exactly one scalar value except for
   * the `exists` operator, which tests cardinality only.
   */
  jsonPath: string;
  /**
   * Comparison applied to the resolved value. `equals`/`notEquals` compare
   * by strict JSON type and value; `greaterThan`/`lessThan` compare
   * numerically; `contains` requires a string resolved value and tests for a
   * substring; `exists` tests only whether `jsonPath` resolves to anything.
   */
  operator: 'equals' | 'notEquals' | 'greaterThan' | 'lessThan' | 'contains' | 'exists';
  /** Value to compare the resolved value against. Required for every operator except `exists`, which takes none. */
  value?: string | number | boolean | null;
}

/**
 * Declarative HTTP health check: a request to issue against the running game
 * task, and a single condition on its response that determines the verdict.
 * The destination host is never part of this declaration — it is always the
 * checked task's own network address, resolved at check time from the
 * container platform, so no declared value can redirect a check elsewhere.
 */
export interface GameServerHealthCheck {
  /** Check-kind discriminator. Only `'http'` is supported today; more kinds may be added later without restructuring existing configuration. */
  kind: 'http';
  /** Request scheme. */
  scheme: 'http' | 'https';
  /** Container port to issue the request against. Must be one of the game's declared {@link GameServer.ports}. */
  port: number;
  /** Request path, rooted at `/`. */
  path: string;
  /** HTTP method to issue. */
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'HEAD';
  /** Additional request headers. Never used to carry a credential — see {@link auth} — and rejected at validation time if a value resembles one. */
  headers?: Record<string, string>;
  /**
   * Optional credential reference. When present, the resolved secret value
   * is injected as a single, fixed `Authorization` header (the secret's raw
   * value, no `Bearer ` prefix), overriding any `Authorization` entry in
   * {@link headers}.
   */
  auth?: GameServerHealthCheckAuth;
  /** Request timeout in milliseconds, bounding the entire request (connect, send, receive) as one wall-clock budget. Must be between 100 and 10000 inclusive. */
  timeoutMs: number;
  /** The single condition evaluated against the response body to derive the active/idle verdict. */
  activeWhen: GameServerHealthCheckCondition;
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
  /**
   * Authoritative liveness check consulted instead of the network-traffic
   * heuristic when deciding whether this game's running tasks are idle.
   * Default when omitted: the network-traffic heuristic (unchanged). When
   * present, it REPLACES that heuristic rather than combining with it, so
   * exactly one verdict source applies to this game.
   */
  healthCheck?: GameServerHealthCheck;
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
 * {@link GameServerHealthCheck} with the credential reference redacted —
 * `auth` is replaced by a `secretSet` boolean, consistent with how the
 * system treats every other secret it holds (e.g.
 * `RedactedDiscordConfig.botTokenSet`/`publicKeySet`). Every other field is
 * carried through unchanged; none of them are secret.
 */
export type RedactedGameServerHealthCheck = Omit<GameServerHealthCheck, 'auth'> & {
  /** Whether `auth` is set on the underlying declaration — never the credential reference itself. */
  secretSet: boolean;
  /**
   * `auth.type` carried through unredacted (it's a credential *shape*
   * discriminator, not a secret), defaulting to `'raw'` when `auth` is set
   * without an explicit `type` — mirroring {@link GameServerHealthCheckAuth."type"}'s
   * own default. Omitted when `secretSet` is `false`. Lets the add-game
   * wizard's edit flow (`draftFromGameServer`) restore the real `authType`
   * instead of guessing `'raw'` for every configured credential.
   */
  authType?: 'raw' | 'basic' | 'bearer';
};

/**
 * {@link GameServer} with {@link GameServer.healthCheck} redacted via
 * {@link RedactedGameServerHealthCheck} — the shape returned to the
 * renderer wherever a declared game crosses the IPC boundary (`games.list`,
 * `games.create`, `games.update`). Built by {@link redactGameServer}.
 */
export type RedactedGameServer = Omit<GameServer, 'healthCheck'> & {
  healthCheck?: RedactedGameServerHealthCheck;
};

/**
 * Redacts a {@link GameServer} for the renderer: replaces
 * `healthCheck.auth` with a `secretSet` boolean, never the credential
 * reference itself. A game with no `healthCheck` (or a `healthCheck` with
 * no `auth`) round-trips unchanged aside from `secretSet` always being
 * present when `healthCheck` is.
 *
 * Pure function — no I/O — mirroring `canRun.ts`'s convention so the
 * `games.list`/`games.create`/`games.update` IPC handlers
 * (`@hyveon/desktop-main`) and `mergeGameLists` share exactly one copy of
 * this rule instead of re-deriving it at each call site.
 *
 * @param game - The declared entry, as read from `DeploymentConfig.gameServers`.
 * @returns The same entry with `healthCheck` redacted.
 */
export function redactGameServer(game: GameServer): RedactedGameServer {
  const { healthCheck, ...rest } = game;
  if (!healthCheck) {
    return rest;
  }
  const { auth, ...healthCheckRest } = healthCheck;
  return {
    ...rest,
    healthCheck: { ...healthCheckRest, secretSet: auth != null, authType: auth ? (auth.type ?? 'raw') : undefined },
  };
}

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
   * Declared configuration for this game (parsed from
   * `DeploymentConfig.gameServers`), with any health-check credential
   * redacted via {@link redactGameServer}. Only present when `declared` is
   * true.
   */
  config?: RedactedGameServer;
  /**
   * Drift finding for this game, from `DriftService.computeDrift`. Present
   * whenever the game has an entry in the current `DriftReport`, regardless
   * of kind — but only a `'config_drift'` kind carries new information the
   * `declared`/`deployed` flags above can't already express.
   */
  drift?: { kind: DriftKind; changedFields?: DriftChangedField[] };
}
