// Typed API wrappers — every call is delegated to the Electron IPC bridge
// (`window.hyveon.*`) exposed by the preload script. There are no `fetch` calls and
// no bearer-token plumbing left in this module: the renderer talks to the main
// process over IPC, not HTTP.
//
// Types shared with `desktop-main`/`desktop-preload` are imported from
// `@hyveon/shared`/`@hyveon/desktop-preload` below rather than re-declared —
// the remaining local interfaces (`GameWizardDraft`, `FileMgr*`, `Discord*`,
// `EnvInfo`, etc.) have no shared-package counterpart and are genuinely
// web-only shapes.

import type {
  ExportDiagnosticsBundleResult,
  GameServerHealthCheckAuth,
  GameServerHealthCheckAuthWriteInput,
  GameServerHealthCheckCondition,
  GameServerHealthCheck,
  RedactedGameServerHealthCheck,
  GameServerHealthCheckWriteInput,
  GameServer,
  RedactedGameServer,
  GameServerWriteConfig,
  GameListEntry,
  GameServerValidationIssue,
  GameWriteSuccess,
  GameWriteConflict,
  GameWriteValidationFailure,
  GameWriteNotFound,
  GameWriteSetupIncomplete,
  GameWriteFailure,
  GameWriteResult,
  CreateGamePayload,
  UpdateGamePayload,
  DeleteGamePayload,
  DriftKind,
  DriftChangedField,
  DriftEntry,
  DriftReport,
  AuditAction,
  AuditEntry,
  AuditPageResult,
} from '@hyveon/shared';
import type {
  CloudHealthCheckStatus,
  CloudHealthCheckSummary,
  CloudHealthFixOutcome,
  CloudHealthFixResult,
  OpenConsoleResult,
} from '@hyveon/desktop-preload';

export type {
  ExportDiagnosticsBundleResult,
  GameServerHealthCheckAuth,
  GameServerHealthCheckAuthWriteInput,
  GameServerHealthCheckCondition,
  GameServerHealthCheck,
  RedactedGameServerHealthCheck,
  GameServerHealthCheckWriteInput,
  GameServer,
  RedactedGameServer,
  GameServerWriteConfig,
  GameListEntry,
  GameServerValidationIssue,
  GameWriteSuccess,
  GameWriteConflict,
  GameWriteValidationFailure,
  GameWriteNotFound,
  GameWriteSetupIncomplete,
  GameWriteFailure,
  GameWriteResult,
  CreateGamePayload,
  UpdateGamePayload,
  DeleteGamePayload,
  DriftKind,
  DriftChangedField,
  DriftEntry,
  DriftReport,
  AuditAction,
  AuditEntry,
  AuditPageResult,
  CloudHealthCheckStatus,
  CloudHealthCheckSummary,
  CloudHealthFixOutcome,
  CloudHealthFixResult,
  OpenConsoleResult,
};

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
