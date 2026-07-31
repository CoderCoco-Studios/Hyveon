/**
 * Typed shape of the `window.hyveon` object exposed by the Electron preload script.
 *
 * Import this interface in the renderer process to get fully-typed access to the
 * IPC bridge without importing anything from `electron` or Node.js.
 *
 * Keep this file in sync with the `contextBridge.exposeInMainWorld('hyveon', {...})`
 * call in `src/index.ts` — the two must always agree on method signatures and
 * namespace names.
 */

import type {
  ChangeSummary,
  DeploymentConfigDiff,
  DeploymentSettingsGetResult,
  DeploymentSettingsWriteResult,
  OpType,
  PulumiEngineVersionResult,
  TopLevelDeploymentSettings,
  UpdateDeploymentSettingsPayload,
} from '@hyveon/shared';

/**
 * Re-exported verbatim from `@hyveon/shared` rather than duplicated —
 * deliberately deviating from every other `Terraform*` type in this file's
 * usual "duplicate the shape + `Mirrors X — keep in sync` TSDoc" convention.
 * That convention exists to isolate the preload from the `@pulumi/pulumi`
 * Automation API's own types leaking across the IPC boundary — but
 * `ChangeSummary`/`OpType` (`@hyveon/shared/src/changeSummary.ts`) is
 * ALREADY that hand-maintained isolation layer, not a raw SDK re-export
 * (that file's own TSDoc explains it deliberately duplicates rather than
 * imports `@pulumi/pulumi/automation`'s `OpType`/`OpMap` byte-for-byte, for
 * exactly this reason). `@hyveon/web` already depends on `@hyveon/shared`
 * directly elsewhere, so re-exporting here avoids a 15-member `OpType`
 * union silently drifting out of sync between two independently
 * hand-maintained copies. Do not "fix" this back to duplication.
 *
 * `DeploymentConfigDiff` (`@hyveon/shared/src/deploymentConfig.ts`) joins
 * this re-exported group for the same reason (task 9.6): it's a pure data
 * shape with no `@pulumi/pulumi`/Node dependency to isolate the renderer
 * from, so re-exporting rather than hand-duplicating its fields here avoids
 * the same kind of drift risk.
 *
 * `TopLevelDeploymentSettings` (`@hyveon/shared/src/deploymentConfig.ts`) and
 * `DeploymentSettingsGetResult`/`DeploymentSettingsWriteResult`/
 * `UpdateDeploymentSettingsPayload` (`@hyveon/shared/src/deploymentSettingsWrite.ts`)
 * join this group for the same reason (task 9.7, the Settings page's
 * deployment-settings editor): all four are pure data shapes with no
 * `@pulumi/pulumi`/Node dependency to isolate the renderer from.
 *
 * `PulumiEngineVersionResult` (`@hyveon/shared/src/pulumiVersion.ts`) joins
 * this group for the same reason (task 10.4, Settings' Cloud Setup version
 * row): a pure `{ resolvedVersion: string | null }` data shape with nothing
 * to isolate the renderer from.
 */
export type {
  ChangeSummary,
  DeploymentConfigDiff,
  DeploymentSettingsGetResult,
  DeploymentSettingsWriteResult,
  OpType,
  PulumiEngineVersionResult,
  TopLevelDeploymentSettings,
  UpdateDeploymentSettingsPayload,
};

// ---------------------------------------------------------------------------
// Shared payload shapes (mirrors types from @hyveon/shared and desktop-main)
// ---------------------------------------------------------------------------

/** Current ECS state of a game server. */
export interface GameStatus {
  game: string;
  state: 'running' | 'starting' | 'stopped' | 'not_deployed' | 'error';
  publicIp?: string;
  hostname?: string;
  taskArn?: string;
  message?: string;
}

/** Result of a start or stop operation. */
export interface StartResult {
  success: boolean;
  message: string;
  taskArn?: string;
}

/** Per-game Fargate cost projection. */
export interface GameEstimate {
  vcpu: number;
  memoryGb: number;
  costPerHour: number;
  costPerDay24h: number;
  costPerMonth4hpd: number;
}

/** Cost estimates for all games plus a "if everything were running" total. */
export interface CostEstimates {
  games: Record<string, GameEstimate>;
  totalPerHourIfAllOn: number;
}

/** Historical daily cost entry from Cost Explorer. */
export interface DailyCost {
  date: string;
  cost: number;
}

/** Actual billed costs pulled from AWS Cost Explorer. */
export interface ActualCosts {
  daily: DailyCost[];
  total: number;
  currency: string;
  days: number;
  error?: string;
}

/** Log lines for a game's ECS task. */
export interface GameLogs {
  game: string;
  lines: string[];
}

/** A single chunk of streamed log text delivered over IPC. */
export type LogChunk = string;

/**
 * ContextBridge-safe async-iterable handle for a streaming IPC channel
 * (`logs.stream`, `iac.stack.initialize`, `iac.runs.streamLogs`).
 *
 * Electron's `contextBridge` structured-clones every value that crosses the
 * isolated-world boundary. A raw `AsyncGenerator` is not structured-cloneable
 * — a bridged function that returns one throws synchronously with
 * `Uncaught Error: An object could not be cloned.` the moment the renderer
 * calls it, and the generator body never executes. This plain object — an
 * own `next()` function, an own `cancel()` function, and an own
 * `[Symbol.asyncIterator]` function returning itself — was empirically
 * verified to survive the clone boundary intact (functions proxy across the
 * bridge fine; a plain object with own function/symbol-keyed properties
 * clones as a plain object retaining those properties as live proxies to the
 * preload-side functions). It satisfies both `AsyncIterable<T>` and
 * `AsyncIterator<T>`, so it can be consumed directly with
 * `for await (const chunk of handle)`.
 *
 * Cancellation is a `cancel()` method rather than an `AbortSignal` parameter:
 * `AbortSignal` instances also don't survive the `contextBridge` clone —
 * their prototype getters (`aborted`) and methods (`addEventListener`) are
 * stripped, leaving an inert plain object with no own enumerable keys, so a
 * preload-side `signal.addEventListener(...)` call throws
 * `TypeError: signal.addEventListener is not a function` the instant the
 * renderer passes one across. Call `cancel()` from a `useEffect` cleanup /
 * `finally` block instead of aborting a controller and passing its signal in.
 */
export interface HyveonStreamHandle<T> {
  /**
   * Resolves the next chunk, or a result whose `done` is `true` once the
   * stream ends (successfully or via {@link cancel}). Shaped exactly like the
   * lib-standard `AsyncIterator<T>['next']` result — a discriminated union on
   * `done`, carrying `value` only on the non-done branch — so TypeScript
   * narrows the element type of a `for await (const chunk of handle)` loop to
   * `T`, not `T | undefined`. This is deliberately not a single object type
   * with both fields optional, which would lose that narrowing. On the
   * terminal (done) result, `value` is always absent in practice: the bridge
   * clone drops object properties whose value is `undefined` in transit, and
   * these streams never resolve their return value to anything else.
   */
  next: () => Promise<{ done?: false; value: T } | { done: true; value?: undefined }>;
  /**
   * Stops consuming the stream: tells the main process to tear down the
   * underlying tail/run early (where applicable — see each streaming
   * method's own doc comment for exactly what tearing down early means for
   * that channel). Safe to call more than once and safe to call after the
   * stream has already ended on its own.
   */
  cancel: () => void;
  /** Returns itself, so the handle is directly usable in a `for await (const chunk of handle)` loop. */
  [Symbol.asyncIterator]: () => HyveonStreamHandle<T>;
}

/** State of the EFS FileBrowser helper task for a game. */
export interface FileMgrStatus {
  game: string;
  state: 'running' | 'starting' | 'stopped' | 'not_deployed';
  url?: string;
  taskArn?: string;
}

/** Result of a file-manager start or stop operation. */
export interface FileMgrResult {
  success: boolean;
  message: string;
  taskArn?: string;
}

/** Admin user/role ID lists. */
export interface DiscordAdmins {
  userIds: string[];
  roleIds: string[];
}

/** Permission entry for a single game. */
export interface DiscordGamePermission {
  userIds: string[];
  roleIds: string[];
  /** Action names from the `DiscordAction` union ('start' | 'stop' | 'status'). */
  actions: string[];
}

/**
 * Discord config returned to the renderer — secrets are redacted to
 * presence booleans so the raw bot token and public key are never sent
 * over IPC.
 */
export interface RedactedDiscordConfig {
  clientId: string;
  allowedGuilds: string[];
  admins: DiscordAdmins;
  gamePermissions: Record<string, DiscordGamePermission>;
  baseAllowedGuilds: string[];
  baseAdmins: DiscordAdmins;
  botTokenSet: boolean;
  publicKeySet: boolean;
  /** Function URL for the interactions Lambda, copied from Terraform outputs. Null if not yet applied. */
  interactionsEndpointUrl: string | null;
}

/** Result of a guild allowlist mutation. */
export interface GuildListResult {
  success: boolean;
  guilds: string[];
  baseGuilds: string[];
}

/** Result of registering slash commands for a guild. */
export interface RegisterResult {
  success: boolean;
  message: string;
}

/** Result of updating admin lists. */
export interface AdminsResult {
  success: boolean;
  admins: DiscordAdmins;
  baseAdmins: DiscordAdmins;
}

/** Result of setting or deleting a game permission entry. */
export interface PermissionsResult {
  success: boolean;
  permissions: Record<string, DiscordGamePermission>;
}

/** Result of updating Discord credentials (put-config). */
export interface PutConfigResult {
  success: boolean;
  config: RedactedDiscordConfig;
}

/** Environment metadata derived from Terraform outputs. */
export interface EnvInfo {
  region: string;
  domain: string;
  environment: string;
}

/** Watchdog tuning knobs persisted in server_config.json. */
export interface WatchdogConfig {
  watchdog_interval_minutes: number;
  watchdog_idle_checks: number;
  watchdog_min_packets: number;
}

/** Result of a watchdog config update. */
export interface WatchdogConfigResult {
  success: true;
  config: WatchdogConfig;
}

/**
 * Single TCP/UDP port a game server container listens on.
 *
 * Mirrors `GameServerPort` in `@hyveon/shared/src/tfvars.ts` — that file is
 * the source of truth; keep this copy in sync with it.
 */
export interface GameServerPort {
  container: number;
  protocol: string;
}

/**
 * Environment variable injected into the game server container.
 *
 * Mirrors `GameServerEnvironmentVariable` in `@hyveon/shared/src/tfvars.ts`
 * — that file is the source of truth; keep this copy in sync with it.
 */
export interface GameServerEnvironmentVariable {
  name: string;
  value: string;
}

/**
 * EFS-backed volume mount for a game server container.
 *
 * Mirrors `GameServerVolume` in `@hyveon/shared/src/tfvars.ts` — that file
 * is the source of truth; keep this copy in sync with it.
 */
export interface GameServerVolume {
  name: string;
  container_path: string;
}

/**
 * File seeded into the container filesystem at task start (e.g. server
 * config or mod files). Exactly one of `content` / `content_base64` is
 * normally supplied.
 *
 * Mirrors `GameServerFileSeed` in `@hyveon/shared/src/tfvars.ts` — that
 * file is the source of truth; keep this copy in sync with it.
 */
export interface GameServerFileSeed {
  path: string;
  content?: string;
  content_base64?: string;
  mode?: string;
}

/**
 * Per-game container configuration, keyed by game name in the
 * `game_servers` Terraform variable (`terraform/variables.tf`).
 *
 * Mirrors `GameServer` in `@hyveon/shared/src/tfvars.ts` — that file is the
 * source of truth; keep this copy in sync with it.
 */
export interface GameServer {
  name: string;
  image: string;
  cpu: number;
  memory: number;
  ports: GameServerPort[];
  environment?: GameServerEnvironmentVariable[];
  volumes: GameServerVolume[];
  https?: boolean;
  connect_message?: string;
  file_seeds?: GameServerFileSeed[];
}

/**
 * Response entry for the merged games list (the `games.list` IPC channel).
 * Combines the declared view (`terraform.tfvars`, via {@link GameServer})
 * with the deployed view (`terraform.tfstate`) so callers can tell
 * "declared but not yet applied" apart from "live" games.
 *
 * Mirrors `GameListEntry` in `@hyveon/shared/src/tfvars.ts` — that file is
 * the source of truth; keep this copy in sync with it.
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

/**
 * A single structural or business-rule validation failure for a proposed
 * `game_servers` entry.
 *
 * Mirrors `GameServerValidationIssue` in
 * `@hyveon/shared/src/gameServerValidator.ts` — that file is the source of
 * truth; keep this copy in sync with it.
 */
export interface GameServerValidationIssue {
  path: string;
  message: string;
}

/**
 * Successful create/update/delete. `game` is the affected entry's
 * post-write config (omitted for a delete); `games` is the full, freshly
 * merged games list so callers can refresh their view without a second
 * round trip.
 *
 * Mirrors `GameWriteSuccess` in `@hyveon/shared/src/gamesWrite.ts` — that
 * file is the source of truth; keep this copy in sync with it.
 */
export interface GameWriteSuccess {
  ok: true;
  game?: GameServer;
  games: GameListEntry[];
}

/**
 * The write was rejected because the caller's `expectedVersionId` didn't
 * match the current tfvars file version — someone else edited
 * `terraform.tfvars` since the caller last read it. `currentVersionId` lets
 * the caller re-fetch and retry.
 *
 * Mirrors `GameWriteConflict` in `@hyveon/shared/src/gamesWrite.ts` — that
 * file is the source of truth; keep this copy in sync with it.
 */
export interface GameWriteConflict {
  ok: false;
  code: 'conflict';
  expectedVersionId?: string;
  currentVersionId?: string;
  message: string;
}

/**
 * The proposed `game_servers` entry failed {@link GameServerValidationIssue}-shaped
 * structural or business-rule validation.
 *
 * Mirrors `GameWriteValidationFailure` in `@hyveon/shared/src/gamesWrite.ts`
 * — that file is the source of truth; keep this copy in sync with it.
 */
export interface GameWriteValidationFailure {
  ok: false;
  code: 'validation';
  issues: GameServerValidationIssue[];
}

/**
 * The named game does not exist (e.g. update/delete targeting an
 * undeclared game).
 *
 * Mirrors `GameWriteNotFound` in `@hyveon/shared/src/gamesWrite.ts` — that
 * file is the source of truth; keep this copy in sync with it.
 */
export interface GameWriteNotFound {
  ok: false;
  code: 'not_found';
  message: string;
}

/**
 * No configuration bucket is configured — the operator has not finished (or
 * has somehow un-finished) the First-Run Wizard's bootstrap step.
 *
 * Mirrors `GameWriteSetupIncomplete` in `@hyveon/shared/src/gamesWrite.ts` —
 * that file is the source of truth; keep this copy in sync with it.
 */
export interface GameWriteSetupIncomplete {
  ok: false;
  code: 'setup_incomplete';
  message: string;
}

/**
 * Catch-all failure for errors that aren't a conflict, validation failure,
 * not-found, or setup-incomplete (e.g. an unexpected S3 error).
 *
 * Mirrors `GameWriteFailure` in `@hyveon/shared/src/gamesWrite.ts` — that
 * file is the source of truth; keep this copy in sync with it.
 */
export interface GameWriteFailure {
  ok: false;
  code: 'error';
  message: string;
}

/**
 * Discriminated union returned by the `games.create` / `games.update` /
 * `games.delete` handlers. Discriminate on `ok` first, then `code` for the
 * failure branches.
 *
 * Mirrors `GameWriteResult` in `@hyveon/shared/src/gamesWrite.ts` — that
 * file is the source of truth; keep this copy in sync with it.
 */
export type GameWriteResult =
  | GameWriteSuccess
  | GameWriteConflict
  | GameWriteValidationFailure
  | GameWriteNotFound
  | GameWriteSetupIncomplete
  | GameWriteFailure;

/**
 * Request payload for `games.create`. `expectedVersionId`, when supplied,
 * is checked against the current tfvars file version and a
 * {@link GameWriteConflict} is returned on mismatch.
 *
 * Mirrors `CreateGamePayload` in `@hyveon/shared/src/gamesWrite.ts` — that
 * file is the source of truth; keep this copy in sync with it.
 */
export interface CreateGamePayload {
  name: string;
  config: Omit<GameServer, 'name'>;
  expectedVersionId?: string;
}

/**
 * Request payload for `games.update`. Same shape as {@link CreateGamePayload}
 * — `name` identifies the existing game to overwrite with `config`.
 *
 * Mirrors `UpdateGamePayload` in `@hyveon/shared/src/gamesWrite.ts` — that
 * file is the source of truth; keep this copy in sync with it.
 */
export interface UpdateGamePayload {
  name: string;
  config: Omit<GameServer, 'name'>;
  expectedVersionId?: string;
}

/**
 * Request payload for `games.delete`.
 *
 * Mirrors `DeleteGamePayload` in `@hyveon/shared/src/gamesWrite.ts` — that
 * file is the source of truth; keep this copy in sync with it.
 */
export interface DeleteGamePayload {
  name: string;
  expectedVersionId?: string;
}

/**
 * Category of mismatch between a game's declared (tfvars) and deployed
 * (tfstate) state.
 *
 * Mirrors `DriftKind` in `@hyveon/shared/src/drift.ts` — that file is the
 * source of truth; keep this copy in sync with it.
 */
export type DriftKind = 'pending_create' | 'pending_delete' | 'config_drift';

/**
 * Name of a top-level game server config field that can differ between the
 * declared (tfvars) and deployed (tfstate) configuration for a
 * `'config_drift'` finding.
 *
 * Mirrors `DriftChangedField` in `@hyveon/shared/src/drift.ts` — that file
 * is the source of truth; keep this copy in sync with it.
 */
export type DriftChangedField = 'ports' | 'image' | 'cpu' | 'memory' | 'volumes';

/**
 * A single per-game drift finding, produced by comparing a game's declared
 * tfvars configuration against its live tfstate configuration.
 *
 * Mirrors `DriftEntry` in `@hyveon/shared/src/drift.ts` — that file is the
 * source of truth; keep this copy in sync with it.
 */
export interface DriftEntry {
  game: string;
  kind: DriftKind;
  changedFields?: DriftChangedField[];
}

/**
 * Aggregate drift report returned by the `drift.get` IPC channel. Lists
 * every game that is out of sync between its declared and deployed
 * configuration; games that are in sync are omitted entirely.
 *
 * Mirrors `DriftReport` in `@hyveon/shared/src/drift.ts` — that file is the
 * source of truth; keep this copy in sync with it.
 */
export interface DriftReport {
  entries: DriftEntry[];
}

/**
 * The kind of mutation an {@link AuditEntry} records, plus `plan` for a
 * dry-run `terraform plan` invocation that touched no infrastructure.
 *
 * Mirrors `AuditAction` in `@hyveon/shared/src/audit.ts` — that file is the
 * source of truth; keep this copy in sync with it.
 */
export type AuditAction =
  | 'add'
  | 'edit'
  | 'remove'
  | 'plan'
  | 'approve'
  | 'apply'
  | 'destroy'
  | 'rollback';

/**
 * A single row in the DynamoDB audit log, recording who changed a game
 * server's configuration, what changed, and the resulting `terraform.tfvars`
 * S3 version.
 *
 * Mirrors `AuditEntry` in `@hyveon/shared/src/audit.ts` — that file is the
 * source of truth; keep this copy in sync with it.
 */
export interface AuditEntry {
  /** Sort key: `<ISO timestamp>#<ULID>`. */
  sk: string;
  /** ISO-8601 timestamp of the mutation. */
  timestamp: string;
  /** Identifier of the user or system that performed the mutation. */
  actor: string;
  /** The kind of mutation performed. */
  action: AuditAction;
  /** The `game_servers` map key the mutation applied to. */
  game: string;
  /** The game's configuration before the mutation, or `null` for `add`. */
  before: GameServer | null;
  /** The game's configuration after the mutation, or `null` for `remove`. */
  after: GameServer | null;
  /** S3 object version id of `terraform.tfvars` produced by the write, if known. */
  versionId?: string;
}

/**
 * A page of audit entries, newest-first, plus an optional cursor for
 * fetching the next page. Returned by the `audit.list` IPC channel.
 *
 * Mirrors `AuditPageResult` in `@hyveon/shared/src/audit.ts` — that file is
 * the source of truth; keep this copy in sync with it.
 */
export interface AuditPageResult {
  /** The page of entries, newest-first. */
  entries: AuditEntry[];
  /** Cursor (an {@link AuditEntry.sk} value) to pass as `before` to fetch the next, older page. Absent on the last page. */
  nextBefore?: string;
}

/**
 * A single line of output from a streamed Pulumi run, tagged with the stream
 * it came from.
 *
 * Structurally identical to `PulumiRunChunk` in
 * `@hyveon/desktop-main/src/services/PulumiService.ts` — that file is the
 * source of truth; keep this copy in sync with it. Named `TerraformRunChunk`
 * for historical reasons (this preload's namespace was `hyveon.terraform`
 * pre-migration) — not renamed by tasks 8.3/8.5, which rename only the IPC
 * namespace key and channel strings, not exported type names.
 */
export interface TerraformRunChunk {
  stream: 'stdout' | 'stderr';
  line: string;
}

/**
 * One of the three coarse provisioning phases `PulumiService.initializeStack`
 * reports progress for. Mirrors `PulumiProvisioningPhase` in
 * `@hyveon/desktop-main/src/services/PulumiEngineService.ts` — that file is
 * the source of truth; keep this copy in sync with it.
 */
export type StackInitPhase = 'engine' | 'plugins' | 'operation';

/**
 * Whether a {@link StackInitPhase} is beginning or has settled (success or
 * failure alike). Mirrors `PulumiPhaseStatus` in
 * `@hyveon/desktop-main/src/services/PulumiEngineService.ts` — that file is
 * the source of truth; keep this copy in sync with it.
 */
export type StackInitPhaseStatus = 'start' | 'end';

/**
 * One phase-transition event streamed by the `iac.stack.initialize` IPC
 * channel — the element type of {@link HyveonIacStackApi.initialize}'s
 * returned {@link HyveonStreamHandle}.
 */
export interface StackInitPhaseEvent {
  phase: StackInitPhase;
  status: StackInitPhaseStatus;
}

/**
 * Which subcommand produced a {@link TerraformRunRecord}. Named for the
 * pre-migration `terraform` CLI subcommands (`plan`/`apply`/`destroy`) —
 * Pulumi's equivalent Automation API calls are `preview`/`up`/`destroy`, but
 * this value is a persisted-record discriminant, not a currently-running
 * operation name, so it keeps its original vocabulary.
 *
 * Mirrors the `kind` field of `PulumiRunRecord` in
 * `@hyveon/desktop-main/src/services/PulumiService.ts` — that file is the
 * source of truth; keep this copy in sync with it.
 */
export type TerraformRunKind = 'plan' | 'apply' | 'destroy';

/**
 * Persisted local run record for a finished plan/apply/destroy run — a
 * lightweight run history entry written once the run has settled. Returned
 * on the `record` field of `iac.runs.get`'s result.
 *
 * Mirrors `PulumiRunRecord` in
 * `@hyveon/desktop-main/src/services/PulumiService.ts` — that file is the
 * source of truth; keep this copy in sync with it.
 */
export interface TerraformRunRecord {
  /** The `runId` this record describes — matches the directory it's written into. */
  runId: string;
  /** Which subcommand produced this record. */
  kind: TerraformRunKind;
  /** ISO-8601 timestamp captured immediately before the process was spawned. */
  startedAt: string;
  /** ISO-8601 timestamp captured immediately after the process closed. */
  completedAt: string;
  /** The process's exit code, or `null` if it never reported one (e.g. killed via abort signal). */
  exitCode: number | null;
  /** The tfvars version id the applied plan was generated against, if the caller supplied one. */
  tfvarsVersionId?: string;
  /**
   * SHA-256 hex digest of the persisted `.tfplan` artifact this record's
   * `plan` run produced. Set only on a successful `plan` record; a failed
   * or aborted `plan` run (and `apply`/`destroy` records generally) leave
   * this unset. The `/terraform` page passes this straight through to
   * `hyveon.iac.apply`'s `planHash` payload field.
   */
  planHash?: string;
  /** The `runId` of the `apply` run this plan rolled back, if started via the rollback flow. */
  rolledBackFrom?: string;
  /**
   * Structured resource-change summary the Pulumi engine reported for this
   * run, mirroring `PulumiRunRecord.changeSummary`. Absent/`{}` means "the
   * engine's structured summary event was never observed for this run" —
   * NOT "this operation made no changes" (a genuine no-op reports
   * `{ same: N }`). Never collapse the two — see `ChangeSummary`'s own
   * TSDoc (`@hyveon/shared/src/changeSummary.ts`) for the full sharp edge.
   */
  changeSummary?: ChangeSummary;
  /** The Pulumi engine version this run executed against, mirroring `PulumiRunRecord.engineVersion`. */
  engineVersion?: string;
  /**
   * `true` when the run's Pulumi engine settled with some resources having
   * already been mutated before the failure/abort — check this field
   * directly, independent of which non-`'success'` status the run settled
   * with, mirroring `PulumiRunRecord.partialApply`'s own doc comment. This
   * dispatch (tasks 8.3/8.5) deliberately does not surface the underlying
   * per-resource step list (`PulumiPartialApplyError.completedSteps`) — this
   * boolean is sufficient for "surface partial-apply failures with re-plan
   * guidance"; granular step detail is a future UI decision.
   */
  partialApply?: boolean;
}

/**
 * Lifecycle status surfaced by the run-detail view — a superset of the
 * persisted `success` / `failed` / `aborted` run status with two additional,
 * non-persisted values computed at read time: `running` (no
 * {@link TerraformRunRecord} exists yet because the run hasn't finished) and
 * `awaiting_approval` (a `plan` run finished successfully but its `.tfplan`
 * artifact still exists on disk, awaiting an operator's explicit apply).
 *
 * Mirrors `RunDetailStatus` in `@hyveon/shared/src/runs.ts` — that file is
 * the source of truth; keep this copy in sync with it.
 */
export type RunDetailStatus = 'success' | 'failed' | 'aborted' | 'running' | 'awaiting_approval';

/**
 * Result of the `iac.runs.get` IPC channel: `found: false` when the
 * requested `runId` is neither the currently in-flight run nor a persisted
 * {@link TerraformRunRecord} on disk. `found: true` always carries the
 * derived {@link RunDetailStatus}; `record` is present only once the run has
 * produced a persisted {@link TerraformRunRecord} (i.e. every status except
 * `running`, since a run in flight hasn't closed its process yet).
 *
 * Mirrors `TerraformRunsGetResult` in
 * `@hyveon/desktop-main/src/controllers/iac-runs.controller.ts` — that
 * file is the source of truth; keep this copy in sync with it.
 */
export type TerraformRunsGetResult =
  | { found: false }
  | { found: true; status: RunDetailStatus; record?: TerraformRunRecord };

/**
 * Lifecycle status of a {@link RunHistoryRecord}.
 *
 * Mirrors `RunStatus` in `@hyveon/shared/src/runs.ts` — that file is the
 * source of truth; keep this copy in sync with it.
 */
export type RunHistoryStatus = 'success' | 'failed' | 'aborted';

/**
 * A single row in the DynamoDB-persisted run-history table — the shape
 * `iac.runs.list` returns pages of. Distinct from the local-disk
 * {@link TerraformRunRecord} that `iac.runs.get`/`streamLogs` operate
 * on: this record additionally carries `sk`, `status`, `approvedBy`/
 * `approvedAt`, and the offloaded-log fields.
 *
 * Mirrors `RunRecord` in `@hyveon/shared/src/runs.ts` — that file is the
 * source of truth; keep this copy in sync with it.
 */
export interface RunHistoryRecord {
  /** Sort key: `<startedAt>#<runId>`. */
  sk: string;
  /** Unique identifier for the run. */
  runId: string;
  /** Which `terraform` subcommand produced this record. */
  kind: TerraformRunKind;
  /** Lifecycle status. */
  status: RunHistoryStatus;
  /** ISO-8601 timestamp captured immediately before the process was spawned. */
  startedAt: string;
  /** ISO-8601 timestamp captured immediately after the process closed. */
  completedAt: string;
  /** The process's exit code, or `null` if it never reported one. */
  exitCode: number | null;
  /** The tfvars version id the run was executed against, if the caller supplied one. */
  tfvarsVersionId?: string;
  /** Hash of the plan artifact this record's run produced or was gated against. */
  planHash?: string;
  /** Opaque identifier of the admin who approved this plan run for apply. Set only on approved `plan` records. */
  approvedBy?: string;
  /** ISO-8601 timestamp the run was approved at. */
  approvedAt?: string;
  /** The run's captured log text, embedded directly on the record when small enough. Mutually exclusive with `logS3Key`. */
  logInline?: string;
  /** Key identifying where the run's captured log was offloaded to, once too large to embed. Mutually exclusive with `logInline`. */
  logS3Key?: string;
  /** The `runId` of the `apply` run this plan rolled back, if started via the rollback flow (#112). */
  rolledBackFrom?: string;
  /**
   * Structured resource-change summary the Pulumi engine reported for this
   * run. See {@link TerraformRunRecord.changeSummary}'s doc comment for the
   * `{}`-does-not-mean-"no changes" sharp edge — it applies identically here.
   */
  changeSummary?: ChangeSummary;
  /** The Pulumi engine version this run executed against. */
  engineVersion?: string;
  /**
   * `true` when the run's Pulumi engine settled with some resources already
   * mutated before the failure/abort. See
   * {@link TerraformRunRecord.partialApply}'s doc comment for the full
   * semantics — identical here.
   */
  partialApply?: boolean;
}

/**
 * A page of {@link RunHistoryRecord}s, newest-first, plus an optional cursor
 * for fetching the next page. Returned by the `iac.runs.list` IPC
 * channel.
 *
 * Mirrors `RunPageResult` in `@hyveon/shared/src/runs.ts` — that file is the
 * source of truth; keep this copy in sync with it.
 */
export interface RunHistoryPageResult {
  /** The page of records, newest-first. */
  records: RunHistoryRecord[];
  /** Cursor (a {@link RunHistoryRecord.sk} value) to pass as `before` to fetch the next, older page. Absent on the last page. */
  nextBefore?: string;
}

/** Options accepted by the `iac.runs.list` IPC channel. */
export interface TerraformRunsListOpts {
  /** Requested page size; the main process clamps to `[1, 100]` and defaults to `25` when omitted or invalid. */
  limit?: number;
  /** Cursor (a {@link RunHistoryRecord.sk} value) to fetch the page older than. */
  before?: string;
  /** When provided, only runs with this status are returned. */
  status?: RunHistoryStatus;
}

/**
 * Payload accepted by the `iac.plan` IPC channel. `tfvarsVersionId`,
 * when the configured tfvars source is S3-backed, is forwarded verbatim to
 * `PulumiService.preview`'s pre-spawn staleness check against the current
 * head version of the tfvars object.
 *
 * Mirrors `TerraformPlanPayload` in
 * `@hyveon/desktop-main/src/controllers/iac.controller.ts` — that file
 * is the source of truth; keep this copy in sync with it.
 */
export interface TerraformPlanPayload {
  tfvarsVersionId?: string;
  /** The `runId` of the `apply` run being rolled back, if this plan was started via the rollback flow (#112). */
  rolledBackFrom?: string;
}

/**
 * Holder/age evidence for one lock entry parsed off a Pulumi backend lock
 * conflict — the preload-side mirror of the main process's `StaleLockInfo`
 * (`@hyveon/desktop-main/src/controllers/iac.controller.ts`), which itself
 * mirrors `PulumiStackLockInfo`
 * (`@hyveon/desktop-main/src/services/PulumiLockRecovery.ts`) with
 * `lockedAt` serialized to an ISO string rather than a `Date` — a raw `Date`
 * does not survive Electron's IPC structured-clone/contextBridge boundary
 * reliably.
 */
export interface TerraformStaleLockHolder {
  lockUrl: string;
  username: string;
  hostname: string;
  pid: number;
  lockedAt: string;
}

/**
 * Present on {@link TerraformPlanAck}/apply/destroy results instead of (or
 * alongside) `error` when the rejection was `PulumiUnrecognizedLockError` —
 * a Pulumi backend lock conflict that couldn't be proven to be this
 * installation's own orphaned run. This dispatch (tasks 8.3/8.5) only wires
 * the READ side through so the holder/age evidence reaches the renderer
 * instead of only `error`'s prose; task 9.4 ("stale-lock recovery UI with
 * explicit confirmation") designs the confirmation flow and any "clear the
 * lock" write path — no such channel exists yet.
 */
export interface TerraformStaleLockInfo {
  stackName: string;
  locks: TerraformStaleLockHolder[];
}

/**
 * Immediate acknowledgement the `iac.plan` IPC channel resolves with.
 * `started: true` means a `runId` was minted and the run was kicked off in
 * the background — the streamed progress/final result are delivered
 * separately over the `iac.plan.chunk` / `iac.plan.end` side channels,
 * tagged with this same `runId`, but **nothing in this preload currently
 * listens on those side channels** — this ack and the ALREADY-bridged
 * `iac.runs.get`/`iac.runs.list` channels (see
 * {@link TerraformRunRecord.changeSummary}/{@link RunHistoryRecord.changeSummary})
 * are the only paths a caller has to a plan's structured result today.
 * `started: false` means the submission was rejected before any run was
 * attempted (no `runId` is present): `error` is a human-readable description
 * of why, `conflict` additionally names the already-running operation
 * (`preview` / `up` / `destroy` / `rollback`) when the rejection was
 * specifically because the shared workspace was busy, and `staleLock`
 * additionally carries holder/age evidence when the rejection was an
 * unrecognized Pulumi backend lock conflict — see
 * {@link TerraformStaleLockInfo}. `apply`/`destroy` (both resolve this same
 * ack shape) can hit this `staleLock` case too: `PulumiUnrecognizedLockError`
 * is only ever detected once the underlying operation has already settled,
 * so it surfaces here whenever that happens before the generator's first
 * chunk would otherwise have been queued (the common case in practice, since
 * a lock conflict is detected at the very start of `stack.up()`/
 * `stack.destroy()`, before typical output exists). If the conflict is
 * instead detected after real output has already streamed, the main process
 * still records `staleLock` — on `iac.controller.ts`'s internal
 * `TerraformApplyEndMessage`/`TerraformDestroyEndMessage` — but **this
 * preload has no listener on the `iac.apply.end`/`iac.destroy.end` side
 * channels** (see `TerraformPlanEndMessage`'s doc comment in
 * `iac.controller.ts`, "nothing subscribes to this channel yet"), so that
 * variant does not currently reach the renderer through this bridge.
 *
 * Mirrors `TerraformPlanAck` in
 * `@hyveon/desktop-main/src/controllers/iac.controller.ts` — that file
 * is the source of truth; keep this copy in sync with it.
 */
export interface TerraformPlanAck {
  started: boolean;
  runId?: string;
  error?: string;
  conflict?: 'preview' | 'up' | 'destroy' | 'rollback';
  staleLock?: TerraformStaleLockInfo;
}

/**
 * Result the `iac.rollback.resolve` IPC channel resolves with.
 * `resolved: true` carries the historic version identified as the rollback
 * target — `versionId`/`lastModified` — for the confirmation dialog to
 * display before anything is written. `resolved: false` means resolution
 * was rejected; `error` is always a human-readable description of why.
 *
 * `diff` (task 9.6) is a best-effort addition: a {@link DeploymentConfigDiff}
 * summarizing how the target version differs from the current configuration
 * head, present when `resolved: true` and the backend could compute it.
 * Always treat an absent `diff` as "no diff available" — NOT as an error —
 * `resolved: true` with no `diff` is the normal, fully-successful shape of
 * this ack whenever the best-effort diff computation degrades; the
 * confirmation dialog must render normally without it.
 *
 * Mirrors `TerraformRollbackResolveAck` in
 * `@hyveon/desktop-main/src/controllers/iac.controller.ts` — that file
 * is the source of truth; keep this copy in sync with it.
 */
export interface TerraformRollbackResolveAck {
  resolved: boolean;
  versionId?: string;
  lastModified?: string;
  diff?: DeploymentConfigDiff;
  error?: string;
}

/**
 * Result the `iac.rollback.confirm` IPC channel resolves with.
 * `confirmed: true` means the historic tfvars content was restored as a new
 * head version AND the follow-up plan run `PulumiService.confirmRollback`
 * runs internally also completed successfully — `versionId` is the restored
 * version's id. `confirmed: false` means either no write was attempted, or a
 * write was attempted and the restore-then-plan unit failed partway through
 * — `error` is always a human-readable description of why. **`versionId` is
 * ALSO populated on a `confirmed: false` result** specifically when the
 * failure is a `PulumiRollbackPlanFailedError` (the restore write succeeded
 * but the follow-up plan didn't) — it names the version that was actually
 * restored as the new head despite the result reporting failure, so a caller
 * can act on it (e.g. offer "plan against the restored version" as a next
 * step) instead of only reading it out of `error`'s prose. This dispatch
 * (tasks 8.3/8.5) only fixes this doc comment to stop describing
 * `confirmed: false` as "no write was attempted" unconditionally — it does
 * not change `rollback-action.component.tsx`'s error-handling logic to
 * actually use `versionId` in the failure branch; that UI improvement is
 * task 9.6's job.
 *
 * Mirrors `TerraformRollbackConfirmAck` in
 * `@hyveon/desktop-main/src/controllers/iac.controller.ts` — that file
 * is the source of truth; keep this copy in sync with it.
 */
export interface TerraformRollbackConfirmAck {
  confirmed: boolean;
  versionId?: string;
  error?: string;
}

/**
 * Result the `iac.lock.clear` IPC channel resolves with (task 9.4's
 * stale-lock recovery flow). `cleared: true` means
 * `PulumiService.clearStaleLock` successfully called `stack.cancel()`
 * against the Pulumi backend — the operator should now resubmit their
 * original plan/apply/destroy via the normal button; this channel never
 * re-attempts it automatically. `cleared: false` means nothing was cleared
 * (another operation was already running against the shared workspace, the
 * backend isn't configured yet, or the clear attempt itself failed) —
 * `error` is always a human-readable description of why.
 *
 * Mirrors `TerraformLockClearAck` in
 * `@hyveon/desktop-main/src/controllers/iac.controller.ts` — that file
 * is the source of truth; keep this copy in sync with it.
 */
export interface TerraformLockClearAck {
  cleared: boolean;
  error?: string;
}

/**
 * Payload accepted by the `iac.apply` IPC channel. `planRunId`
 * identifies the approved plan run to apply; `planHash` is the caller's
 * expected plan hash, checked against the plan run's stored `planHash` to
 * catch drift between when the plan was approved and when apply runs.
 *
 * Mirrors the `POST /api/terraform/apply` request body described in issue
 * #109 — the desktop-main apply IPC handler is the source of truth; keep
 * this copy in sync with it.
 */
export interface TerraformApplyPayload {
  planRunId: string;
  planHash: string;
}

/**
 * Result the `iac.destroy.mintToken` IPC channel resolves with —
 * `token` must be supplied back on {@link TerraformDestroyPayload.confirmationToken}
 * within its short expiry window (see `PulumiService.mintDestroyConfirmationToken`).
 *
 * Mirrors `TerraformDestroyMintAck` in
 * `@hyveon/desktop-main/src/controllers/iac.controller.ts` — that file
 * is the source of truth; keep this copy in sync with it.
 */
export interface TerraformDestroyMintAck {
  token: string;
}

/**
 * Payload accepted by the `iac.destroy` IPC channel. `confirmationToken`
 * must be the most recently minted, unexpired, not-yet-consumed value
 * returned by `iac.destroy.mintToken` — enforced server-side, never
 * trusted from the client beyond this single round-trip.
 *
 * Mirrors `TerraformDestroyPayload` in
 * `@hyveon/desktop-main/src/controllers/iac.controller.ts` — that file
 * is the source of truth; keep this copy in sync with it.
 */
export interface TerraformDestroyPayload {
  confirmationToken: string;
}

/**
 * Immediate acknowledgement the `iac.approve` IPC channel resolves
 * with once the identified plan run has been marked approved. Mirrors
 * `TerraformApproveAck` in `@hyveon/desktop-main/src/controllers/iac.controller.ts`
 * — that type is the source of truth; keep this copy in sync with it.
 * `approved: true` means `RunRecordService.approveRun` succeeded and
 * `approvedBy`/`approvedAt` mirror the values stamped onto the persisted
 * `RunRecord`. `approved: false` means the request failed (invalid payload,
 * missing service, or a thrown error) — `error` carries a human-readable
 * description and `approvedBy`/`approvedAt` are omitted. Note there is no
 * `runId` field — the controller never returns one.
 */
export interface TerraformApproveAck {
  approved: boolean;
  approvedBy?: string;
  approvedAt?: string;
  error?: string;
}

/**
 * Shape of the subset of Terraform root outputs the management app consumes.
 *
 * Mirrors `TfOutputs` in `@hyveon/desktop-main/src/services/ConfigService.ts`
 * — that file is the source of truth; keep this copy in sync with it.
 *
 * **Dead surface (as of tasks 8.3/8.5):** `iac.controller.ts`'s `output`
 * handler now actually resolves `StackOutputs | null`
 * (`@hyveon/shared/src/stackOutputs.ts`), not `TfOutputs | null`, and its
 * `force` parameter is ignored — but this preload's `output()` type was left
 * unchanged because there is currently zero `window.hyveon.iac.output()`
 * call site anywhere in `@hyveon/web` (confirmed by grep; only
 * `e2e/screenshots/demo-data.ts` mocks the channel, to `null`). If a future
 * caller is added, this type's shape will need reconciling with
 * `StackOutputs` at that point — deliberately not done speculatively here.
 */
export interface TfOutputs {
  aws_region: string;
  ecs_cluster_name: string;
  ecs_cluster_arn: string;
  subnet_ids: string;
  security_group_id: string;
  file_manager_security_group_id: string;
  efs_file_system_id: string;
  efs_access_points: Record<string, string>;
  domain_name: string;
  game_names: string[];
  discord_table_name: string;
  audit_table_name: string;
  discord_bot_token_secret_arn: string;
  discord_public_key_secret_arn: string;
  interactions_invoke_url: string | null;
  discord_interactions_url: string | null;
  /**
   * Full per-game `game_servers` configuration as last applied by Terraform
   * (the `applied_game_servers` sensitive output — see `terraform/aws/outputs.tf`),
   * keyed by game name. `null` when the output is absent (e.g. state predates
   * this output, or `terraform apply` hasn't run since it was added).
   */
  applied_game_servers: Record<string, Omit<GameServer, 'name'>> | null;
}

// ---------------------------------------------------------------------------
// Per-namespace sub-interfaces
// ---------------------------------------------------------------------------

/** Game-server lifecycle: list games, query status, start/stop ECS tasks. */
export interface HyveonGamesApi {
  /** Lists games merged from tfvars (declared) and tfstate (deployed). */
  list: () => Promise<{ games: GameListEntry[] }>;
  /** Returns ECS status for every game in parallel. */
  status: () => Promise<GameStatus[]>;
  /** Returns ECS status for a single game. */
  getStatus: (game: string) => Promise<GameStatus>;
  /** Launches the `{game}-server` ECS task. */
  start: (game: string) => Promise<StartResult>;
  /** Stops the running ECS task for `game`. */
  stop: (game: string) => Promise<StartResult>;
  /** Adds a new entry to the tfvars `game_servers` map. */
  create: (payload: CreateGamePayload) => Promise<GameWriteResult>;
  /** Overwrites an existing entry in the tfvars `game_servers` map. */
  update: (payload: UpdateGamePayload) => Promise<GameWriteResult>;
  /** Removes an entry from the tfvars `game_servers` map. */
  delete: (payload: DeleteGamePayload) => Promise<GameWriteResult>;
}

/** Cost endpoints: forward-looking Fargate estimates and historical CE data. */
export interface HyveonCostsApi {
  /** Estimates per-game and total hourly Fargate cost. */
  estimate: () => Promise<CostEstimates>;
  /** Returns actual costs over a trailing window via Cost Explorer. */
  actual: (days?: number) => Promise<ActualCosts>;
}

/** CloudWatch log endpoints: poll recent lines or open a live IPC stream. */
export interface HyveonLogsApi {
  /** Returns recent log lines for a game's ECS task. */
  get: (game: string, limit?: number) => Promise<GameLogs>;
  /**
   * Opens a live log stream for `game`, returning a {@link HyveonStreamHandle}
   * of log chunks. Consume it with `for await (const chunk of stream(game))`.
   *
   * Call the returned handle's `cancel()` to stop the stream early: this
   * tells the main process to stop tailing CloudWatch. The iteration
   * completes normally once `cancel()` is called or the stream ends on its
   * own, and throws if it terminated due to an error. Internally this wraps
   * the per-stream chunk/end/cancel IPC channels in a preload-internal async
   * generator, exposed to the renderer via {@link HyveonStreamHandle}.
   */
  stream: (game: string) => HyveonStreamHandle<LogChunk>;
}

/** EFS file-manager task endpoints: list, start, and stop per game. */
export interface HyveonFilesApi {
  /** Lists the file-manager task for `game`, returning whether it is running plus connection details. */
  list: (game: string) => Promise<FileMgrStatus>;
  /** Launches an ECS file-manager task for `game`. */
  start: (game: string) => Promise<FileMgrResult>;
  /** Stops the file-manager task for `game`. */
  stop: (game: string) => Promise<FileMgrResult>;
}

/** Discord bot configuration: credentials, guild allowlist, admins, permissions, command registration. */
export interface HyveonDiscordApi {
  /** Returns the Discord config with secrets redacted to booleans. */
  getConfig: () => Promise<RedactedDiscordConfig>;
  /** Updates bot token, client ID, and/or public key in Secrets Manager. */
  putConfig: (body: { botToken?: string; clientId?: string; publicKey?: string }) => Promise<PutConfigResult>;
  /** Lists dynamic and Terraform-base allowed guild IDs. */
  listGuilds: () => Promise<{ guilds: string[]; baseGuilds: string[] }>;
  /** Adds a guild ID to the dynamic allowlist in DynamoDB. */
  addGuild: (guildId: string) => Promise<GuildListResult>;
  /** Removes a guild ID from the dynamic allowlist. */
  removeGuild: (guildId: string) => Promise<GuildListResult>;
  /** Registers slash commands for a guild in the Discord developer portal. */
  registerCommands: (guildId: string) => Promise<RegisterResult>;
  /** Returns the dynamic and Terraform-base admin user/role lists. */
  getAdmins: () => Promise<DiscordAdmins & { baseAdmins: DiscordAdmins }>;
  /** Replaces the dynamic admin user/role lists. */
  putAdmins: (body: { userIds?: string[]; roleIds?: string[] }) => Promise<AdminsResult>;
  /** Returns the per-game permission map. */
  getPermissions: () => Promise<Record<string, DiscordGamePermission>>;
  /**
   * Sets allowed users/roles/actions for a single game.
   *
   * **Transport note:** the preload binding collapses the two parameters into a
   * single object — `ipcRenderer.invoke('discord.putPermission', { game, body })`
   * — because `nestjs-electron-ipc-transport` only delivers the first argument to
   * `@Payload`. Callers must go through `window.hyveon.discord.putPermission` and
   * must **not** invoke the `discord.putPermission` IPC channel directly with two
   * separate arguments, as the controller would only receive the first one.
   */
  putPermission: (
    game: string,
    body: { userIds?: string[]; roleIds?: string[]; actions?: string[] },
  ) => Promise<PermissionsResult>;
  /** Removes the permission entry for a game. */
  deletePermission: (game: string) => Promise<PermissionsResult>;
}

/** Environment metadata: region, domain, and environment label for UI display. */
export interface HyveonEnvApi {
  /** Returns region, domain, and environment label derived from Terraform outputs. */
  get: () => Promise<EnvInfo>;
}

/** Watchdog configuration stored in server_config.json. */
export interface HyveonConfigApi {
  /** Returns the current watchdog config (interval, idle-check count, min packets). */
  get: () => Promise<WatchdogConfig>;
  /** Partially updates the watchdog config on disk. */
  update: (body: {
    watchdog_interval_minutes?: number;
    watchdog_idle_checks?: number;
    watchdog_min_packets?: number;
  }) => Promise<WatchdogConfigResult>;
}

/**
 * Summary of a single AWS CLI profile discovered in `~/.aws/credentials` or
 * `~/.aws/config`. Never carries key material.
 */
export interface AwsProfileSummary {
  profileName: string;
  region?: string;
}

/** Plaintext input to {@link HyveonWizardApi.saveCredentials}. */
export interface SavePastedCredentialsInput {
  /** Defaults to `hyveon-pasted` when omitted. */
  profileName?: string;
  accessKeyId: string;
  secretAccessKey: string;
  region?: string;
}

/** Payload accepted by {@link HyveonWizardApi.bootstrapStateBucket}. */
export interface BootstrapStateBucketInput {
  bucketName: string;
}

/** Payload accepted by {@link HyveonWizardApi.bootstrapConfigurationBucket}. */
export interface BootstrapConfigurationBucketInput {
  bucketName: string;
}

/** Payload accepted by {@link HyveonWizardApi.bootstrapDeploymentConfig}. */
export interface BootstrapDeploymentConfigInput {
  bucketName: string;
}

/** Outcome of {@link HyveonWizardApi.simulateIamPermissions}. */
export type IamCheckStatus = 'passed' | 'missing' | 'warning';

/** Result of the wizard's best-effort IAM permission dry-run against the `HyveonDeployAll` action set. */
export interface IamCheckResult {
  status: IamCheckStatus;
  /**
   * Present when `status` is `'missing'` — a minimal pasteable IAM policy
   * JSON document covering exactly the denied actions.
   */
  policyJson?: string;
  /**
   * Present when `status` is `'warning'` — an actionable message explaining
   * why simulation itself could not run.
   */
  message?: string;
}

/** A single first-run wizard step name, in wizard order. Mirrors `WIZARD_STEPS` in `@hyveon/shared`'s `wizardSteps.ts` (re-exported by `@hyveon/web`'s `wizard.utils.ts`). */
export type WizardStepName = 'pick-cloud' | 'credentials' | 'bootstrap' | 'stack-init';

/** Resumable wizard progress persisted to `userData/wizard-state.json`. */
export interface WizardProgress {
  step: WizardStepName;
}

/** Payload accepted by {@link HyveonWizardApi.saveProgress}. */
export interface SaveWizardProgressInput {
  step: WizardStepName;
}

/** Per-resource outcome of a `wizard.bootstrap.*` call. */
export type BootstrapResourceStatus = 'created' | 'exists' | 'failed';

/**
 * Result of a single bootstrap operation (e.g. {@link HyveonWizardApi.bootstrapStateBucket}).
 *
 * @remarks
 * There is no dedicated status/field for the public-access-block hardening
 * every bucket-bootstrap operation also applies: PAB is applied
 * unconditionally after the bucket itself is created/confirmed, so
 * `status: 'created' | 'exists'` already implies PAB succeeded, and a PAB
 * failure surfaces exactly like any other configuration failure on that
 * bucket — `status: 'failed'` with `message` set to the underlying error.
 */
export interface BootstrapResult {
  status: BootstrapResourceStatus;
  /** Present when `status` is `'failed'` — an actionable message for the wizard to display. */
  message?: string;
}

/** First-run wizard endpoints (see `openspec/changes/add-first-run-wizard`). */
export interface HyveonWizardApi {
  /** Lists AWS CLI profiles discovered in `~/.aws/credentials` and `~/.aws/config`. */
  listAwsProfiles: () => Promise<AwsProfileSummary[]>;
  /**
   * Saves pasted AWS credentials (the wizard's "paste keys instead" flow).
   * Only the resolved profile name comes back — never the values passed in.
   */
  saveCredentials: (input: SavePastedCredentialsInput) => Promise<{ profileName: string }>;
  /** Whether the first-run wizard has completed — used to gate the app router. */
  getState: () => Promise<WizardState>;
  /**
   * Persists wizard-flow answers (currently just `activeCloud`). Returns the
   * same shape as {@link getState} so the caller can update local state
   * directly from the response.
   */
  saveState: (input: SaveWizardStateInput) => Promise<WizardState>;
  /**
   * Idempotently creates/ensures the state backend S3 bucket (versioning +
   * default encryption + public-access-block, applied on both the
   * fresh-create and already-exists paths) using the credentials/region
   * chosen in the credentials step.
   */
  bootstrapStateBucket: (input: BootstrapStateBucketInput) => Promise<BootstrapResult>;
  /**
   * Idempotently creates/ensures the versioned configuration S3 bucket
   * (versioning + 90-day noncurrent-version-expiration lifecycle rule +
   * public-access-block, applied on both the fresh-create and
   * already-exists paths) using the credentials/region chosen in the
   * credentials step.
   */
  bootstrapConfigurationBucket: (input: BootstrapConfigurationBucketInput) => Promise<BootstrapResult>;
  /**
   * Idempotently seeds the initial `deployment-config.json` document in the
   * just-created/confirmed configuration bucket, fixing a Critical bootstrap
   * gap: nothing else ever created that first object, so before this call
   * existed every Settings save, every Games-page add, and every Pulumi
   * preview failed outright on a fresh install (`fetchRawConfig` throws when
   * the object doesn't exist, and every write path calls it first). Takes
   * the same `bucketName` just passed to {@link bootstrapConfigurationBucket}.
   */
  bootstrapDeploymentConfig: (input: BootstrapDeploymentConfigInput) => Promise<BootstrapResult>;
  /**
   * Idempotently creates/ensures the run-history DynamoDB table (`pk`/`sk`
   * keys, `status-index` GSI, point-in-time recovery), fixing a Critical
   * bootstrap deadlock: this table used to be created by the first Pulumi
   * apply, which itself needed the table to already exist to record its own
   * run — see `BootstrapService.ensureRunsTable`'s doc comment for the full
   * story. Takes no payload — the table's name isn't operator-editable at
   * this point in the wizard (no `DeploymentConfig` exists yet to hold an
   * override), so it always uses the project-name default.
   */
  bootstrapRunsTable: () => Promise<BootstrapResult>;
  /**
   * Runs the wizard's best-effort IAM permission dry-run against the
   * `HyveonDeployAll` action set (`sts:GetCallerIdentity` +
   * `iam:SimulatePrincipalPolicy`, batched). Never grants permissions.
   */
  simulateIamPermissions: () => Promise<IamCheckResult>;
  /** Returns the last-recorded resumable step, defaulting to `prerequisites` if unset/corrupt. */
  getProgress: () => Promise<WizardProgress>;
  /** Persists the current step so the wizard resumes here if the app closes before completion. */
  saveProgress: (input: SaveWizardProgressInput) => Promise<void>;
  /**
   * Marks the wizard complete (`wizardCompleted: true`), gating the app
   * router past the wizard. Returns the same shape as {@link getState}.
   */
  complete: () => Promise<WizardState>;
}

/**
 * The credentials step's chosen source. `profile` names either a real
 * `~/.aws` profile (the "pick an existing profile" path) or a pasted-
 * credentials profile name (the "paste keys instead" path, e.g. `hyveon-pasted`).
 */
export interface WizardAwsChoice {
  profile?: string;
  region?: string;
}

/**
 * The bootstrap step's last-submitted resource names, as persisted to
 * `ElectronStoreService.bootstrap`. Needed so Settings' Reconfigure flow
 * (#211) can rehydrate a non-default name — resource names are
 * operator-editable.
 *
 * @remarks
 * `lockTable` named this shape until task 10.3: it never described a
 * bootstrapped resource (task 5.1 removed `ensureLockTable`/
 * `wizard.bootstrap.lockTable`, and the bootstrap step renders no row for
 * it) and was kept only because the now-deleted `iac.init` call required a
 * non-empty `dynamodbTable` backend-config value, rehydrated from that field
 * on Reconfigure. Task 10.3 replaced the Terraform-init step with
 * `iac.stack.initialize`, which needs no lock-table name at all — so the
 * field is gone.
 */
export interface WizardBootstrapNames {
  stateBucket: string;
  configurationBucket: string;
}

/** Minimal wizard-progress summary the renderer needs to decide whether to show the wizard route. */
export interface WizardState {
  wizardCompleted: boolean;
  /** The cloud chosen in the pick-cloud step. Locked to `'aws'` for v1; `undefined` before that step runs. */
  activeCloud?: 'aws';
  /** The credential source chosen in the credentials step (#192), if any. */
  aws?: WizardAwsChoice;
  /** The bootstrap step's last-submitted resource names, if any. */
  bootstrap?: WizardBootstrapNames;
}

/** Payload accepted by {@link HyveonWizardApi.saveState}. */
export interface SaveWizardStateInput {
  activeCloud?: 'aws';
  aws?: WizardAwsChoice;
  bootstrap?: WizardBootstrapNames;
}

/** Drift detection: compares declared (tfvars) config against deployed (tfstate) state. */
export interface HyveonDriftApi {
  /** Returns the current drift report — games out of sync between declared and deployed state. */
  get: () => Promise<DriftReport>;
}

/** Local application log diagnostics: tail recent lines or retrieve the log file path. */
export interface HyveonDiagnosticsApi {
  /** Returns the last 500 lines from today's local log file. */
  tail: () => Promise<{ lines: string[] }>;
  /** Returns the absolute path of today's local log file. */
  path: () => Promise<{ path: string }>;
}

/** Audit log: paginated history of `game_servers` mutations from DynamoDB. */
export interface HyveonAuditApi {
  /**
   * Returns a page of audit entries, newest-first. `opts.limit` caps the
   * number of entries returned; `opts.before` is a pagination cursor (an
   * {@link AuditEntry.sk} value) from a previous page's `nextBefore`, used
   * to fetch the next, older page.
   */
  list: (opts?: { limit?: number; before?: string }) => Promise<AuditPageResult>;
}

/**
 * Iac run history: look up a single plan/apply/destroy run's current
 * status and stream its live/replayed log output (issue #108).
 */
export interface HyveonIacRunsApi {
  /**
   * Looks up the run identified by `runId` and returns its current
   * {@link TerraformRunsGetResult} — `{ found: false }` if `runId` is
   * neither the in-flight run nor a persisted {@link TerraformRunRecord},
   * otherwise `{ found: true, status, record? }`.
   *
   * Internally this is a plain `invoke('iac.runs.get', { runId })`
   * call — unlike {@link streamLogs}, there is no streaming involved.
   */
  get: (runId: string) => Promise<TerraformRunsGetResult>;
  /**
   * Opens a live/replayed log stream for the run identified by `runId`,
   * returning a {@link HyveonStreamHandle} of {@link TerraformRunChunk}.
   * Consume it with `for await (const chunk of iac.runs.streamLogs(runId))`.
   *
   * Mirrors {@link HyveonIacApi.init}'s streaming shape: the
   * `iac.runs.logs` invoke call resolves immediately with an opaque
   * `streamId`, and subsequent chunk/end messages arrive on the fixed
   * `iac.runs.logs.chunk` / `iac.runs.logs.end` side channels,
   * tagged with that `streamId` so overlapping subscriptions to different
   * runs can never cross-terminate one another.
   *
   * Call the returned handle's `cancel()` to stop consuming the stream
   * early: this stops yielding further chunks to the caller. There is no
   * dedicated cancel side channel — the run itself (and its log tailing on
   * the main-process side) keeps going in the background; only this
   * caller's consumption stops.
   *
   * The iteration completes normally once the run's output finishes
   * replaying/streaming, and throws (using the `iac.runs.logs.end`
   * payload's `error` field) if it terminated due to an error.
   */
  streamLogs: (runId: string) => HyveonStreamHandle<TerraformRunChunk>;
  /**
   * Returns a page of persisted run records, newest-first. `opts.limit` caps
   * the number of records returned; `opts.before` is a pagination cursor (a
   * {@link RunHistoryRecord.sk} value) from a previous page's `nextBefore`,
   * used to fetch the next, older page; `opts.status` filters to a single
   * run status. Each returned {@link RunHistoryRecord} carries
   * `changeSummary`/`engineVersion`/`partialApply` when the Pulumi engine
   * reported them for that run — see {@link RunHistoryRecord.changeSummary}'s
   * doc comment for the `{}`-does-not-mean-"no changes" sharp edge.
   *
   * Internally this is a plain `invoke('iac.runs.list', opts)` call —
   * no streaming involved.
   */
  list: (opts?: TerraformRunsListOpts) => Promise<RunHistoryPageResult>;
  /**
   * Resolves a temporary, fetchable URL for a run's log once it has been
   * offloaded to remote storage (i.e. the record's `logS3Key` is set,
   * distinguishing it from a small enough log embedded on `logInline`).
   *
   * Internally this is a plain `invoke` call on the `iac.runs.logUrl`
   * channel, unwrapped from the channel's `url` result field to a bare
   * string for ergonomic `fetch(url)` use at the call site.
   */
  logUrl: (logKey: string, expiresInSeconds?: number) => Promise<string>;
}

/**
 * Stack-initialization IPC surface (task 10.3, `migrate-iac-to-pulumi`) — the
 * first-run wizard's real replacement for the deleted `iac.init` channel
 * (itself a permanent no-op rejection since task 7.10; Pulumi has no
 * `terraform init` analogue).
 */
export interface HyveonIacStackApi {
  /**
   * Initializes (or, on a retry, re-verifies) the one Pulumi stack this app
   * manages, by invoking the `iac.stack.initialize` IPC channel and
   * returning its live progress as a {@link HyveonStreamHandle} of
   * {@link StackInitPhaseEvent}. Consume it with
   * `for await (const event of iac.stack.initialize())`.
   *
   * Takes no arguments — unlike the old `iac.init(config)` call this
   * replaces, `PulumiService.initializeStack` resolves the state bucket/AWS
   * region it needs internally from stored wizard state, the same way every
   * other `PulumiService` method does (see `PulumiService.initializeStack`'s
   * own TSDoc).
   *
   * Yields a `{ phase, status }` event for every `'start'`/`'end'` pair the
   * main process reports, in order: `'engine'`, then `'plugins'`, then
   * `'operation'` — a phase never reached (because an earlier one failed)
   * never yields at all. The iteration completes normally once
   * initialization finishes successfully, and throws once the underlying run
   * fails — using the failed phase's own error message where the main
   * process could attribute the failure to a specific phase, or a generic
   * message otherwise.
   *
   * Internally this wraps the fixed `iac.stack.initialize.chunk` /
   * `iac.stack.initialize.end` side-channel IPC messages
   * `IacController.initializeStack` sends in a preload-internal async
   * generator, tagged with the `streamId` minted for this call — mirrors
   * `iac.runs.streamLogs`'s shape (the same one the original, pre-7.10
   * `iac.init` channel used) exactly.
   *
   * Call the returned handle's `cancel()` to stop consuming progress early —
   * mirroring every other streaming method's cancellation semantics, this
   * does not stop `PulumiService.initializeStack` itself, which keeps
   * running to completion in the background; only this caller's consumption
   * stops.
   */
  initialize: () => HyveonStreamHandle<StackInitPhaseEvent>;
}

/**
 * Iac orchestration: initializes the Pulumi stack the first-run wizard's
 * final step needs, and submits plan/apply/destroy/rollback operations
 * against the Pulumi-backed engine.
 */
export interface HyveonIacApi {
  /** Stack initialization (task 10.3): the wizard's real `terraform init` replacement. */
  stack: HyveonIacStackApi;
  /**
   * Submits a plan (`pulumi preview`) run by invoking the `iac.plan` IPC
   * channel and resolves its immediate {@link TerraformPlanAck}.
   *
   * `opts.tfvarsVersionId`, when supplied, is forwarded to
   * `PulumiService.preview`'s staleness check against the current head
   * version of the tfvars object. The resolved ack reports whether the run
   * started (`{ started: true, runId }`) or was rejected before starting —
   * rejection happens when the shared workspace is already busy running
   * `preview`/`up`/`destroy`/`rollback` (`{ started: false, error, conflict }`)
   * or when an unrecognized Pulumi backend lock conflict was hit
   * (`{ started: false, error, staleLock }` — see
   * {@link TerraformPlanAck.staleLock}).
   *
   * This call only resolves the initial acknowledgement — it does not
   * stream the run's output itself. **Nothing in this preload currently
   * listens on the `iac.plan.chunk` / `iac.plan.end` side channels** (see
   * {@link TerraformPlanAck}'s doc comment) — for progress and the final
   * structured result, poll `iac.runs.get(runId)` (whose `record` carries
   * `changeSummary`/`engineVersion`/`partialApply` once the run settles) or
   * consume `iac.runs.streamLogs(runId)` for live text output.
   */
  plan: (opts?: TerraformPlanPayload) => Promise<TerraformPlanAck>;
  /**
   * Approves a completed plan run (identified by `opts.planRunId`, its
   * `runId`) so `apply` may proceed against it, by invoking the
   * `iac.approve` IPC channel with `opts`.
   *
   * Mirrors `POST /api/terraform/runs/:id/approve` (#109) — admin-only;
   * records the approver and approved-at timestamp on the plan run and
   * resolves the {@link TerraformApproveAck}.
   */
  approve: (opts: { planRunId: string }) => Promise<TerraformApproveAck>;
  /**
   * Submits an apply (`pulumi up`) run gated on plan-hash + approval by
   * invoking the `iac.apply` IPC channel, resolving an ack shaped like
   * {@link TerraformPlanAck}. Mirrors `POST /api/terraform/apply` (#109):
   * rejects when the plan run isn't approved, the current tfvars has
   * drifted since the plan, the supplied `planHash` doesn't match the plan
   * run's stored hash, another run already holds the shared workspace lock,
   * or an unrecognized Pulumi backend lock conflict was hit (see
   * {@link TerraformPlanAck.staleLock}).
   */
  apply: (payload: TerraformApplyPayload) => Promise<TerraformPlanAck>;
  /**
   * Mints a fresh, short-lived destroy-confirmation token by invoking the
   * `iac.destroy.mintToken` IPC channel — call this the moment the
   * operator's type-to-confirm phrase is accepted, then pass the returned
   * `token` straight through to {@link destroy}'s `confirmationToken` before
   * it expires. Minting a new token supersedes (invalidates) any prior
   * unconsumed one.
   */
  mintDestroyToken: () => Promise<TerraformDestroyMintAck>;
  /**
   * Submits a destroy (`pulumi destroy`) run gated on
   * `payload.confirmationToken` (minted via {@link mintDestroyToken}) by
   * invoking the `iac.destroy` IPC channel, resolving an ack shaped
   * like {@link TerraformPlanAck} (including the same `staleLock` case).
   * Mirrors {@link apply}: this call only resolves the initial
   * acknowledgement — it does not itself stream the run's output; consume
   * `hyveon.iac.runs.streamLogs(runId)` (tagged with the returned `runId`)
   * for progress, the same seam every other run's live output flows
   * through.
   */
  destroy: (payload: TerraformDestroyPayload) => Promise<TerraformPlanAck>;
  /**
   * Returns the current Terraform outputs by invoking the `iac.output`
   * IPC channel with `{ force }`. See {@link TfOutputs}'s doc comment: this
   * channel and its return type are currently a dead surface with no
   * renderer call site, and the main process's actual return shape has
   * already diverged from this type (`force` is now ignored).
   */
  output: (force?: boolean) => Promise<TfOutputs | null>;
  /** Iac run history: look up a single run's status and stream its log output. */
  runs: HyveonIacRunsApi;
  /** Rollback flow (#112): preview and restore a prior tfvars version from an apply run in history. */
  rollback: HyveonIacRollbackApi;
  /** Stale backend-lock recovery (task 9.4): explicitly clear an unrecognized Pulumi backend lock. */
  lock: HyveonIacLockApi;
  /** Deployment-settings editor (task 9.7): read/write every top-level `DeploymentConfig` field except `gameServers`. */
  settings: HyveonIacSettingsApi;
}

/**
 * Stale backend-lock recovery IPC surface (task 9.4, `migrate-iac-to-pulumi`).
 * A `plan`/`apply`/`destroy` ack can carry `staleLock` (see
 * {@link TerraformPlanAck.staleLock}) when the Pulumi backend is locked by
 * something this installation cannot prove is its own dead process. This
 * namespace's sole method lets the operator, after explicitly confirming via
 * the renderer's confirmation dialog that they believe the lock is genuinely
 * stale, clear it and then manually resubmit their original operation.
 */
export interface HyveonIacLockApi {
  /**
   * Clears the current Pulumi backend lock by invoking the `iac.lock.clear`
   * IPC channel, which delegates to `PulumiService.clearStaleLock()`
   * (`stack.cancel()` under the hood). Only call this after the operator has
   * explicitly confirmed — via the stale-lock recovery dialog — that they
   * believe the listed holder/age evidence describes a genuinely stale lock,
   * not a real concurrent operation. `cleared: false` means nothing was
   * cleared (e.g. another operation is already running against the shared
   * workspace, or the clear attempt itself failed) — `error` describes why.
   * This method never retries the original plan/apply/destroy itself; the
   * caller must resubmit it separately once `cleared: true`.
   */
  clear: () => Promise<TerraformLockClearAck>;
}

/**
 * Rollback flow (#112) IPC surface. A rollback is two calls: {@link resolve}
 * previews the target version for the confirmation dialog without writing
 * anything, then {@link confirm} restores it as a new tfvars head version
 * (and, internally, re-plans against it — see
 * {@link TerraformRollbackConfirmAck}'s doc comment). The caller completes
 * the rollback with an ordinary `iac.plan` call
 * (`{ tfvarsVersionId: confirm's returned versionId, rolledBackFrom: applyRunId }`)
 * so the tagged plan streams and gates through the exact same channel every
 * other plan does — see `iac.controller.ts`'s `confirmRollback` TSDoc,
 * "Known, accepted consequence", for the resulting duplicate-plan-record
 * behavior this produces today.
 */
export interface HyveonIacRollbackApi {
  /**
   * Resolves the tfvars version that was live immediately before the given
   * `apply` run, by invoking the `iac.rollback.resolve` IPC channel.
   * Read-only — performs no write. `resolved: false` means the target
   * couldn't be resolved (no matching apply run, not an apply run, no
   * recorded `tfvarsVersionId`, or no earlier version exists) — `error`
   * describes why.
   */
  resolve: (opts: { applyRunId: string }) => Promise<TerraformRollbackResolveAck>;
  /**
   * Confirms a previewed rollback of `opts.applyRunId`, by invoking the
   * `iac.rollback.confirm` IPC channel — restores the historic tfvars
   * content as a new head version. `confirmed: false` means no write was
   * attempted — `error` describes why.
   */
  confirm: (opts: { applyRunId: string }) => Promise<TerraformRollbackConfirmAck>;
}

/**
 * Deployment-settings editor IPC surface (task 9.7, `migrate-iac-to-pulumi`)
 * — the Settings page's form for every top-level `DeploymentConfig` field
 * except `gameServers` (region, hosted zone, watchdog tuning, Discord admin
 * allowlists, etc.). `gameServers` has its own dedicated add-game-wizard/
 * edit-game-form flow (`games.create`/`games.update`/`games.delete`) and is
 * never reachable through this namespace.
 */
export interface HyveonIacSettingsApi {
  /**
   * Reads the current top-level settings plus the etag to round-trip as
   * {@link update}'s `expectedVersionId`, by invoking the `iac.settings.get`
   * IPC channel. `ok: false` covers an unconfigured configuration bucket
   * (`code: 'setup_incomplete'`) or an unexpected read failure
   * (`code: 'error'`) — see {@link DeploymentSettingsGetResult}.
   */
  get: () => Promise<DeploymentSettingsGetResult>;
  /**
   * Submits a settings patch by invoking the `iac.settings.update` IPC
   * channel. `payload.expectedVersionId` should always be the etag last read
   * via {@link get} — optimistic locking is required for this form (task
   * 9.7's brief), so an omitted `expectedVersionId` risks silently
   * clobbering a concurrent edit. `ok: false` discriminates on `code`:
   * `'validation'` (client should re-render the same fields with the
   * reported issues), `'conflict'` (surface a "changed elsewhere — reload
   * and try again" message, mirroring the game-form's own optimistic-lock
   * UX), `'setup_incomplete'`, or the catch-all `'error'` — see
   * {@link DeploymentSettingsWriteResult}.
   */
  update: (payload: UpdateDeploymentSettingsPayload) => Promise<DeploymentSettingsWriteResult>;
  /**
   * Reads the resolved Pulumi engine version by invoking the
   * `iac.settings.engineVersion` IPC channel (task 10.4) — backs Settings'
   * Cloud Setup version row. `resolvedVersion: null` is a real, expected
   * "not yet provisioned" state (including a fresh install that hasn't
   * completed first-run setup), never a failure — see
   * {@link PulumiEngineVersionResult}.
   */
  engineVersion: () => Promise<PulumiEngineVersionResult>;
}

// ---------------------------------------------------------------------------
// Test-only injection surface
// ---------------------------------------------------------------------------

/**
 * Mock namespace bag: a partial copy of every `HyveonApi` namespace so test
 * harnesses can supply only the methods they care about.
 *
 * Derived as a mapped type over every `HyveonApi` namespace key (everything
 * except the `__test` injection surface itself) so a namespace added to
 * `HyveonApi` flows in automatically — no hand-maintained property list to drift.
 */
export type HyveonMockNamespaces = {
  [K in Exclude<keyof HyveonApi, '__test'>]?: Partial<HyveonApi[K]>;
};

/**
 * Test-only API surface injected under `window.hyveon.__test`.
 *
 * Present in two distinct scenarios:
 *
 * 1. **Vitest / jsdom unit tests** — the test harness replaces the entire
 *    `window.hyveon` object with a mock built from `test-mock-registry`; the mock
 *    object includes this property so individual test cases can register
 *    per-channel overrides via `window.hyveon.__test.mock(channel, handler)`.
 *
 * 2. **Electron preload at runtime** — when the app is launched with
 *    `HYVEON_TEST_MODE=1` (set by the Playwright integration-test harness),
 *    `preload.ts` appends `__test` to the real `window.hyveon` bridge so that
 *    Playwright page scripts can inject IPC mocks without touching the real
 *    Electron IPC layer.
 *
 * Production code must **never** reference this property — guard every access
 * with an `if (window.hyveon?.__test)` check or, better, avoid it entirely outside
 * tests.
 */
export interface HyveonTestApi {
  /**
   * Registers a per-channel mock handler.
   *
   * Call `mock(channel, handler)` before rendering the component under test.
   * When the preload bridge later invokes `ipcRenderer.invoke(channel, ...args)`,
   * the registered handler is called instead and its return value is resolved.
   * Pass a plain value (non-function) to have it returned verbatim.
   *
   * @param channel - The IPC channel name to intercept (e.g. `'games.list'`).
   * @param handler - A function `(...args) => result` or a static return value.
   */
  mock: (channel: string, handler: unknown) => void;
  /**
   * Clears all mock implementations stored in `mock` and resets any recorded
   * call counts on injected `vi.fn()` spies.
   *
   * Intended for use in `afterEach` hooks to prevent state leaking between
   * test cases.
   */
  clearMocks: () => void;
  /**
   * Alias for {@link clearMocks} — provided for symmetry with Vitest's
   * `vi.resetAllMocks()` naming convention.
   */
  reset: () => void;
}

// ---------------------------------------------------------------------------
// Top-level interface
// ---------------------------------------------------------------------------

/**
 * Typed shape of `window.hyveon` as exposed by the Electron preload script.
 *
 * Declare this on `Window` in a renderer-side `.d.ts` file. Mark it optional
 * (`hyveon?`) — the bridge is absent in plain browser/web contexts, so runtime
 * guards like `if (!window.hyveon)` need it to be possibly-undefined:
 * ```ts
 * import type { HyveonApi } from '@hyveon/desktop-preload/hyveon-api';
 * declare global {
 *   interface Window { hyveon?: HyveonApi; }
 * }
 * ```
 */
export interface HyveonApi {
  /** Game-server lifecycle: list games, query status, start/stop ECS tasks. */
  games: HyveonGamesApi;
  /** Cost endpoints: forward-looking Fargate estimates and historical CE data. */
  costs: HyveonCostsApi;
  /** CloudWatch log endpoints (request/response only; SSE stream is separate). */
  logs: HyveonLogsApi;
  /** EFS file-manager task endpoints: status, start, and stop per game. */
  files: HyveonFilesApi;
  /** Discord bot configuration: credentials, guild allowlist, admins, permissions, command registration. */
  discord: HyveonDiscordApi;
  /** Environment metadata: region, domain, and environment label for UI display. */
  env: HyveonEnvApi;
  /** Watchdog configuration stored in server_config.json. */
  config: HyveonConfigApi;
  /** First-run wizard endpoints: prerequisite detection, credentials, cloud bootstrap. */
  wizard: HyveonWizardApi;
  /** Drift detection: compares declared (tfvars) config against deployed (tfstate) state. */
  drift: HyveonDriftApi;
  /** Local application log diagnostics: tail recent lines or retrieve the log file path. */
  diagnostics: HyveonDiagnosticsApi;
  /** Audit log: paginated history of `game_servers` mutations from DynamoDB. */
  audit: HyveonAuditApi;
  /**
   * Iac orchestration: plan/apply/destroy/rollback against the Pulumi-backed
   * engine, plus the transitional `terraform init` stub. Namespace renamed
   * from `terraform` to `iac` by tasks 8.3/8.5 — only the namespace key and
   * IPC channel strings moved; the `Terraform*`-prefixed payload/ack type
   * names were deliberately left unrenamed (matches task 8.1's own
   * precedent on the main-process side).
   */
  iac: HyveonIacApi;
  /**
   * Test-only injection surface; `undefined` in production.
   *
   * Present in two scenarios:
   * - **Vitest / jsdom** — the test harness stubs the whole `window.hyveon`
   *   object with a mock that includes this property.
   * - **Electron preload** — appended to the real bridge when the process is
   *   started with `HYVEON_TEST_MODE=1` by the Playwright integration-test
   *   harness.
   *
   * Never reference this in production code paths.
   */
  __test?: HyveonTestApi;
}
