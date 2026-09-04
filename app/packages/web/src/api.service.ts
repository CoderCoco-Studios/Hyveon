// Typed API wrappers — every call is delegated to the Electron IPC bridge
// (`window.hyveon.*`) exposed by the preload script. There are no `fetch` calls and
// no bearer-token plumbing left in this module: the renderer talks to the main
// process over IPC, not HTTP.

import type { ExportDiagnosticsBundleResult } from '@hyveon/shared';

export type { ExportDiagnosticsBundleResult };

/** Live status for a single game, as returned by `GET /api/status` and `/api/status/:game`. */
export interface GameStatus {
  game: string;
  state: 'running' | 'starting' | 'stopped' | 'not_deployed' | 'error';
  publicIp?: string;
  hostname?: string;
  taskArn?: string;
  message?: string;
}

/** Result envelope for mutation endpoints (start/stop), with a user-facing message. */
export interface ActionResult {
  success: boolean;
  message: string;
  taskArn?: string;
}

/** Per-game Fargate cost breakdown used by `CostsPage` and `GameCard` to surface hourly/monthly estimates. */
export interface GameEstimate {
  vcpu: number;
  memoryGb: number;
  costPerHour: number;
  costPerDay24h: number;
  costPerMonth4hpd: number;
}

/** Aggregate cost estimates returned by `GET /api/costs/estimate`. */
export interface CostEstimates {
  games: Record<string, GameEstimate>;
  totalPerHourIfAllOn: number;
}

/**
 * Credential reference for an authenticated health check.
 *
 * Mirrors `GameServerHealthCheckAuth` in `@hyveon/shared/src/gameServerConfig.ts`
 * — that file is the source of truth; keep this copy in sync with it.
 */
export interface GameServerHealthCheckAuth {
  secretArn: string;
}

/**
 * Operator-submitted shape of a health-check credential — only ever appears
 * in a create/update payload, never in a persisted `GameServerHealthCheck`.
 * `secretArn` is only meaningful for `type: 'raw'` (the operator's own
 * pre-existing ARN); `basic`/`bearer` instead carry plaintext
 * (`username`/`password`, or `token`) that the write path consumes once to
 * create or update an app-owned secret, never persisting the plaintext
 * itself.
 *
 * Mirrors `GameServerHealthCheckAuthWriteInput` in
 * `@hyveon/shared/src/gameServerValidator.ts` — that file is the source of
 * truth; keep this copy in sync with it.
 */
export interface GameServerHealthCheckAuthWriteInput {
  type?: 'raw' | 'basic' | 'bearer';
  secretArn?: string;
  username?: string;
  password?: string;
  token?: string;
}

/**
 * Single comparison evaluated against a health check's response body.
 *
 * Mirrors `GameServerHealthCheckCondition` in
 * `@hyveon/shared/src/gameServerConfig.ts` — that file is the source of
 * truth; keep this copy in sync with it.
 */
export interface GameServerHealthCheckCondition {
  jsonPath: string;
  operator: 'equals' | 'notEquals' | 'greaterThan' | 'lessThan' | 'contains' | 'exists';
  value?: string | number | boolean | null;
}

/**
 * Declarative HTTP health check. Carries the full declaration, including
 * `auth.secretArn` when authenticated — used for the write-side
 * ({@link CreateGamePayload}/{@link UpdateGamePayload}) shape only; the
 * read-side shape ({@link RedactedGameServer}) redacts `auth` down to a
 * `secretSet` boolean.
 *
 * Mirrors `GameServerHealthCheck` in `@hyveon/shared/src/gameServerConfig.ts`
 * — that file is the source of truth; keep this copy in sync with it.
 */
export interface GameServerHealthCheck {
  kind: 'http';
  scheme: 'http' | 'https';
  port: number;
  path: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'HEAD';
  headers?: Record<string, string>;
  auth?: GameServerHealthCheckAuth;
  timeoutMs: number;
  activeWhen: GameServerHealthCheckCondition;
}

/**
 * {@link GameServerHealthCheck} with the credential reference redacted —
 * `auth` replaced by a `secretSet` boolean, never the credential reference
 * itself. This is what the renderer actually receives; it never sees the
 * write-side `auth` shape back.
 *
 * Mirrors `RedactedGameServerHealthCheck` in
 * `@hyveon/shared/src/gameServerConfig.ts` — that file is the source of
 * truth; keep this copy in sync with it.
 */
export interface RedactedGameServerHealthCheck extends Omit<GameServerHealthCheck, 'auth'> {
  secretSet: boolean;
  authType?: 'raw' | 'basic' | 'bearer';
}

/**
 * Write-side shape of `GameServerHealthCheck.auth`: the operator-submitted
 * {@link GameServerHealthCheckAuthWriteInput}, `null` to explicitly clear an
 * existing credential, or `undefined` to leave whatever credential is
 * already on record unchanged. Only ever appears in a create/update
 * payload.
 *
 * Mirrors `GameServerHealthCheckWriteInput` in
 * `@hyveon/shared/src/gamesWrite.ts` — that file is the source of truth;
 * keep this copy in sync with it.
 */
export type GameServerHealthCheckWriteInput = Omit<GameServerHealthCheck, 'auth'> & {
  auth?: GameServerHealthCheckAuthWriteInput | null;
};

/**
 * Per-game container configuration, keyed by game name in
 * `DeploymentConfig.gameServers` (`@hyveon/shared/src/deploymentConfig.ts`).
 * `healthCheck` here is the full, write-capable shape (with `auth`) — used
 * for {@link CreateGamePayload}/{@link UpdateGamePayload}. The renderer
 * only ever reads back {@link RedactedGameServer}.
 *
 * Mirrors `GameServer` in `@hyveon/shared/src/gameServerConfig.ts` — that file is the
 * source of truth; keep this copy in sync with it.
 */
export interface GameServer {
  name: string;
  image: string;
  cpu: number;
  memory: number;
  ports: { container: number; protocol: string; visibility?: 'public' | 'internal' }[];
  environment?: { name: string; value: string }[];
  volumes: { name: string; container_path: string }[];
  https?: boolean;
  connect_message?: string;
  file_seeds?: { path: string; content?: string; content_base64?: string; mode?: string }[];
  healthCheck?: GameServerHealthCheck;
}

/**
 * {@link GameServer} with {@link GameServer.healthCheck} redacted via
 * {@link RedactedGameServerHealthCheck} — the shape the renderer actually
 * receives wherever a declared game crosses the IPC boundary
 * (`GameListEntry.config`, `GameWriteSuccess.game`).
 *
 * Mirrors `RedactedGameServer` in `@hyveon/shared/src/gameServerConfig.ts`
 * — that file is the source of truth; keep this copy in sync with it.
 */
export interface RedactedGameServer extends Omit<GameServer, 'healthCheck'> {
  healthCheck?: RedactedGameServerHealthCheck;
}

/**
 * Write-side shape of a `game_servers` entry submitted to `games.create` /
 * `games.update`: identical to `Omit<GameServer, 'name'>` except
 * `healthCheck`, which uses {@link GameServerHealthCheckWriteInput} so a
 * `basic`/`bearer` credential can be submitted as plaintext rather than a
 * pre-resolved `secretArn`.
 *
 * Mirrors `GameServerWriteConfig` in `@hyveon/shared/src/gamesWrite.ts` —
 * that file is the source of truth; keep this copy in sync with it.
 */
export type GameServerWriteConfig = Omit<GameServer, 'name' | 'healthCheck'> & {
  healthCheck?: GameServerHealthCheckWriteInput;
};

/**
 * Response entry for the merged games list (the `games.list` IPC channel).
 * Combines the declared view (`DeploymentConfig.gameServers`, via
 * {@link GameServer}) with the deployed view (tfstate) so callers can tell
 * "declared but not yet applied" apart from "live" games.
 *
 * Mirrors `GameListEntry` in `@hyveon/shared/src/gameServerConfig.ts` — that file is
 * the source of truth; keep this copy in sync with it.
 */
export interface GameListEntry {
  /**
   * Game key. Sourced from the declared `gameServers` map key when
   * `declared` is true, otherwise from the tfstate game name.
   */
  name: string;
  /** True when this game has an entry in the declared `gameServers` map. */
  declared: boolean;
  /** True when this game has a deployed ECS task definition in tfstate. */
  deployed: boolean;
  /**
   * Declared configuration for this game, with any health-check credential
   * redacted. Only present when `declared` is true.
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

/**
 * In-progress add-game wizard field values.
 *
 * Mirrors `WizardDraft` in
 * `app/packages/web/src/components/add-game-wizard/wizard-form.utils.ts` —
 * that file is the source of truth; keep this copy in sync with it.
 */
export interface GameWizardDraft {
  name: string;
  image: string;
  connect_message: string;
  cpu: number | null;
  memory: number | null;
  ports: { container: number | null; protocol: string; visibility: 'public' | 'internal' }[];
  volumes: { name: string; container_path: string }[];
  file_seeds: { path: string; content: string; content_base64: string; mode: string }[];
  environment: { name: string; value: string }[];
  https: boolean;
  healthCheck: {
    enabled: boolean;
    scheme: string;
    port: number | null;
    path: string;
    method: string;
    timeoutMs: number | null;
    jsonPath: string;
    operator: string;
    value: string;
    authType: 'none' | 'raw' | 'basic' | 'bearer';
    secretArn: string;
    username: string;
    password: string;
    token: string;
    secretSet: boolean;
  };
}

/** A saved add-game wizard draft plus which step the operator was on and when it was last autosaved. */
export interface StoredGameWizardDraft {
  draft: GameWizardDraft;
  stepIndex: number;
  savedAt: string;
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
  game?: RedactedGameServer;
  games: GameListEntry[];
}

/**
 * The write was rejected because the caller's `expectedVersionId` didn't
 * match the deployment config's current S3 object version — someone else
 * edited the declared configuration since the caller last read it.
 * `currentVersionId` lets the caller re-fetch and retry.
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
 * is checked against the deployment config's current S3 object version and
 * a {@link GameWriteConflict} is returned on mismatch.
 *
 * Mirrors `CreateGamePayload` in `@hyveon/shared/src/gamesWrite.ts` — that
 * file is the source of truth; keep this copy in sync with it.
 */
export interface CreateGamePayload {
  name: string;
  config: GameServerWriteConfig;
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
  config: GameServerWriteConfig;
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

/** Status of the FileBrowser helper task per game, returned by `GET /api/files/:game`. */
export interface FileMgrStatus {
  game: string;
  state: 'running' | 'starting' | 'stopped' | 'not_deployed';
  url?: string;
  taskArn?: string;
}

/** The plaintext credential a FileBrowser launch was just seeded with — shown to the operator exactly once, in {@link FileMgrResult.credentials}. */
export interface FileMgrCredentials {
  username: string;
  password: string;
}

/** Result of a file-manager start/stop operation — {@link ActionResult} plus the one-time credential a successful start seeds the task with. */
export interface FileMgrResult extends ActionResult {
  /** Only present on a successful start — never on a stop result. */
  credentials?: FileMgrCredentials;
}

/** Discord slash-command action a user can be permitted to invoke on a game. */
export type DiscordAction = 'start' | 'stop' | 'status';

/** Users and roles with server-wide admin privileges (all commands on all games). */
export interface DiscordAdmins {
  userIds: string[];
  roleIds: string[];
}

/** Per-game permission entry: which users/roles can run which actions on this game. */
export interface DiscordGamePermission {
  userIds: string[];
  roleIds: string[];
  actions: DiscordAction[];
}

/**
 * Discord config returned by `GET /api/discord/config`. Neither the bot token
 * nor the application public key is ever sent to the client — the `*Set`
 * booleans indicate whether each secret is configured in AWS Secrets Manager.
 *
 * `interactionsEndpointUrl` is the Lambda Function URL the operator pastes
 * into the Discord developer portal as the "Interactions Endpoint URL".
 */
export interface DiscordConfigRedacted {
  clientId: string;
  allowedGuilds: string[];
  admins: DiscordAdmins;
  gamePermissions: Record<string, DiscordGamePermission>;
  /** Guild IDs locked in by the deployment config's immutable "base" allowlist — non-removable via the UI. */
  baseAllowedGuilds: string[];
  /** Admin user/role IDs locked in by the deployment config's immutable "base" allowlist — non-removable via the UI. */
  baseAdmins: DiscordAdmins;
  botTokenSet: boolean;
  publicKeySet: boolean;
  interactionsEndpointUrl: string | null;
}

/** Result of a server-side mutation that may surface a human-readable error to the UI. */
export interface DiscordMutationResult {
  success: boolean;
  message: string;
}

/** Environment context returned by `GET /api/env`. */
export interface EnvInfo {
  region: string;
  domain: string;
  environment: string;
}

/**
 * Category of mismatch between a game's declared (deployment config) and
 * deployed (tfstate) state.
 *
 * Mirrors `DriftKind` in `@hyveon/shared/src/drift.ts` — that file is the
 * source of truth; keep this copy in sync with it.
 */
export type DriftKind = 'pending_create' | 'pending_delete' | 'config_drift';

/**
 * Name of a top-level game server config field that can differ between the
 * declared (deployment config) and deployed (tfstate) configuration for a
 * `'config_drift'` finding.
 *
 * Mirrors `DriftChangedField` in `@hyveon/shared/src/drift.ts` — that file
 * is the source of truth; keep this copy in sync with it.
 */
export type DriftChangedField = 'ports' | 'image' | 'cpu' | 'memory' | 'volumes';

/**
 * A single per-game drift finding, produced by comparing a game's declared
 * configuration against its live tfstate configuration.
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
 * Aggregate drift report returned by `GET /api/drift` (the `drift.get` IPC
 * channel). Lists every game that is out of sync between its declared and
 * deployed configuration; games that are in sync are omitted entirely.
 *
 * Mirrors `DriftReport` in `@hyveon/shared/src/drift.ts` — that file is the
 * source of truth; keep this copy in sync with it.
 */
export interface DriftReport {
  entries: DriftEntry[];
}

/**
 * The kind of mutation an {@link AuditEntry} records: `add` | `edit` | `remove`
 * for game-server CRUD, `plan` for a dry-run `pulumi preview` that touched no
 * infrastructure, `approve` for marking a `plan` run approved for a later
 * `apply`, `apply` for a `pulumi up` that mutated infrastructure,
 * `destroy` for a confirmed `pulumi destroy`, and `rollback` for restoring
 * a prior deployment config version as a new head.
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
 * server's configuration, what changed, and the resulting deployment
 * config S3 object version.
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
  /** S3 object version id of the deployment config produced by the write, if known. */
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
 * Status of a single Cloud Health check.
 *
 * Mirrors `CloudHealthCheckStatus` in `@hyveon/desktop-preload` — keep this
 * copy in sync with it.
 */
export type CloudHealthCheckStatus = 'ok' | 'missing' | 'error';

/**
 * One row's worth of data for the Settings page's Cloud Health checklist.
 *
 * Mirrors `CloudHealthCheckSummary` in `@hyveon/desktop-preload` — keep this
 * copy in sync with it.
 */
export interface CloudHealthCheckSummary {
  id: string;
  label: string;
  status: CloudHealthCheckStatus;
  message?: string;
}

/**
 * Outcome of attempting to fix a single Cloud Health check.
 *
 * Mirrors `CloudHealthFixOutcome` in `@hyveon/desktop-preload` — keep this
 * copy in sync with it.
 */
export type CloudHealthFixOutcome = 'fixed' | 'needsPolicyUpdate' | 'failed';

/**
 * Result of a Cloud Health fix attempt.
 *
 * Mirrors `CloudHealthFixResult` in `@hyveon/desktop-preload` — keep this
 * copy in sync with it.
 */
export interface CloudHealthFixResult {
  outcome: CloudHealthFixOutcome;
  policyJson?: string;
  policyConsoleUrl?: string;
  message?: string;
}

/**
 * Result of attempting to open a console URL in the operator's default
 * browser.
 *
 * Mirrors `OpenConsoleResult` in `@hyveon/desktop-preload` — keep this copy
 * in sync with it.
 */
export type OpenConsoleResult = { opened: true } | { opened: false; url: string };

/**
 * Returns the `window.hyveon` IPC bridge, throwing a descriptive error if it is
 * absent. The bridge is injected by the Electron preload script, so a missing
 * one means the renderer is running outside Electron (e.g. a plain browser).
 */
function hyveon() {
  const bridge = window.hyveon;
  if (!bridge) {
    throw new Error(
      'window.hyveon IPC bridge is unavailable — the renderer must run inside the Electron preload context.',
    );
  }
  return bridge;
}

// The Discord `actions` field is typed as the narrower `DiscordAction[]` in this
// module but as the wider `string[]` in the preload bridge. The runtime values
// are identical, so the single-step narrowings below (never `as unknown as`) are
// safe — `DiscordAction[]` is assignable to `string[]`, which makes the cast legal.
//
// Every method is `async` so the missing-bridge guard in `hyveon()` surfaces as a
// rejected promise rather than a synchronous throw: callers that chain
// `.then().catch()` (rather than `await`) still route the failure to `.catch`.

export const api = {
  env: async (): Promise<EnvInfo> => hyveon().env.get(),
  games: async (): Promise<{ games: GameListEntry[] }> => hyveon().games.list(),
  status: async (): Promise<GameStatus[]> => hyveon().games.status(),
  statusGame: async (game: string): Promise<GameStatus> => hyveon().games.getStatus(game),
  start: async (game: string): Promise<ActionResult> => hyveon().games.start(game),
  stop: async (game: string): Promise<ActionResult> => hyveon().games.stop(game),
  costsEstimate: async (): Promise<CostEstimates> => hyveon().costs.estimate(),
  filesMgrStatus: async (game: string): Promise<FileMgrStatus> => hyveon().files.list(game),
  filesMgrStart: async (game: string): Promise<FileMgrResult> => hyveon().files.start(game),
  filesMgrStop: async (game: string): Promise<FileMgrResult> => hyveon().files.stop(game),
  createGame: async (payload: CreateGamePayload): Promise<GameWriteResult> =>
    hyveon().games.create(payload) as Promise<GameWriteResult>,
  updateGame: async (payload: UpdateGamePayload): Promise<GameWriteResult> =>
    hyveon().games.update(payload) as Promise<GameWriteResult>,
  deleteGame: async (payload: DeleteGamePayload): Promise<GameWriteResult> =>
    hyveon().games.delete(payload) as Promise<GameWriteResult>,
  getGameDraft: async (): Promise<StoredGameWizardDraft | null> =>
    hyveon().games.draft.get() as Promise<StoredGameWizardDraft | null>,
  saveGameDraft: async (draft: GameWizardDraft, stepIndex: number): Promise<void> =>
    hyveon().games.draft.save({ draft, stepIndex }) as Promise<void>,
  updateGameDraftStepIndex: async (stepIndex: number): Promise<void> =>
    hyveon().games.draft.updateStepIndex(stepIndex) as Promise<void>,
  clearGameDraft: async (): Promise<void> => hyveon().games.draft.clear() as Promise<void>,

  discordConfig: async (): Promise<DiscordConfigRedacted> =>
    hyveon().discord.getConfig() as Promise<DiscordConfigRedacted>,
  discordSaveCredentials: async (body: {
    botToken?: string;
    clientId?: string;
    publicKey?: string;
  }): Promise<{ success: boolean; config: DiscordConfigRedacted }> =>
    hyveon().discord.putConfig(body) as Promise<{ success: boolean; config: DiscordConfigRedacted }>,
  discordAddGuild: async (guildId: string): Promise<{ success: boolean; guilds: string[] }> =>
    hyveon().discord.addGuild(guildId),
  discordRemoveGuild: async (guildId: string): Promise<{ success: boolean; guilds: string[] }> =>
    hyveon().discord.removeGuild(guildId),
  discordRegisterCommands: async (guildId: string): Promise<DiscordMutationResult> =>
    hyveon().discord.registerCommands(guildId),
  discordSaveAdmins: async (admins: DiscordAdmins): Promise<{ success: boolean; admins: DiscordAdmins }> =>
    hyveon().discord.putAdmins(admins),
  discordSavePermission: async (
    game: string,
    perm: DiscordGamePermission,
  ): Promise<{ success: boolean; permissions: Record<string, DiscordGamePermission> }> =>
    hyveon().discord.putPermission(game, perm) as Promise<{
      success: boolean;
      permissions: Record<string, DiscordGamePermission>;
    }>,
  discordDeletePermission: async (
    game: string,
  ): Promise<{ success: boolean; permissions: Record<string, DiscordGamePermission> }> =>
    hyveon().discord.deletePermission(game) as Promise<{
      success: boolean;
      permissions: Record<string, DiscordGamePermission>;
    }>,

  diagnosticsTail: async (): Promise<{ lines: string[] }> => hyveon().diagnostics.tail(),
  diagnosticsLogPath: async (): Promise<{ path: string }> => hyveon().diagnostics.path(),
  diagnosticsExportBundle: async (): Promise<ExportDiagnosticsBundleResult> => hyveon().diagnostics.exportBundle(),
  diagnosticsShowInFolder: async (path: string): Promise<void> => hyveon().diagnostics.showInFolder(path),

  drift: async (): Promise<DriftReport> => hyveon().drift.get(),

  audit: async (opts?: { limit?: number; before?: string }): Promise<AuditPageResult> =>
    hyveon().audit.list(opts),

  cloudHealthList: async (): Promise<CloudHealthCheckSummary[]> => hyveon().cloudHealth.list(),
  cloudHealthFix: async (id: string): Promise<CloudHealthFixResult> => hyveon().cloudHealth.fix(id),
  cloudHealthDownloadPolicy: async (policyJson: string): Promise<{ path: string }> =>
    hyveon().cloudHealth.downloadPolicy(policyJson),
  cloudHealthOpenPolicyConsole: async (url: string): Promise<OpenConsoleResult> =>
    hyveon().cloudHealth.openPolicyConsole(url),
};
