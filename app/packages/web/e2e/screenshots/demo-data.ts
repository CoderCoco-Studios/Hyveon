/**
 * Typed demo fixture set + `window.hyveon.__test.mock` seeders for the
 * docs-site screenshot harness (`capture.spec.ts`).
 *
 * Every value here is deliberately "showroom" data — a small, internally
 * consistent fleet (minecraft/valheim/palworld) with realistic IPs, costs,
 * and history — rather than the minimal single-game fixtures used by the
 * functional e2e specs under `e2e/specs/`. Do not reuse this module from a
 * spec under `e2e/specs/` (or vice versa): the two fixture sets intentionally
 * diverge in purpose (visual completeness vs. minimal repro).
 *
 * Type provenance: the real contract types are split across two packages —
 * `@hyveon/shared` (canonical for anything Terraform/tfvars/DynamoDB-shaped:
 * `GameStatus`, `GameServer`, `GameListEntry`, `DriftReport`, `AuditEntry`,
 * etc.) and `@hyveon/desktop-preload` (canonical for the Electron IPC
 * surface: `TerraformPlanAck`, `RunHistoryRecord`, `WizardState`, etc.). A
 * handful of types the web renderer consumes are not
 * re-exported by either package's public barrel (`CostEstimates`,
 * `WatchdogConfig`, `DiscordConfigRedacted`, `AwsProfileSummary`,
 * `BootstrapResult`, `IamCheckResult`, `WizardProgress`, …) — those are
 * imported from `@hyveon/web`'s own `api.service.ts` where already defined,
 * or re-declared locally below with a "mirrors X — keep in sync" comment,
 * following the same convention `api.service.ts` itself already uses.
 */

import type { Page } from '@playwright/test';
import type {
  AuditAction,
  AuditEntry,
  AuditPageResult,
  DriftChangedField,
  DriftEntry,
  DriftReport,
  GameListEntry,
  GameServer,
  GameStatus,
} from '@hyveon/shared';
import type { WizardStep } from '@hyveon/shared';
import type {
  RunHistoryPageResult,
  RunHistoryRecord,
  StackInitPhaseEvent,
  TerraformApproveAck,
  TerraformDestroyMintAck,
  TerraformPlanAck,
  TerraformRunChunk,
  TerraformRunsGetResult,
  WizardState,
} from '@hyveon/desktop-preload';
import type {
  ActualCosts,
  CostEstimates,
  DiscordConfigRedacted,
  EnvInfo,
  GameEstimate,
  WatchdogConfig,
} from '../../src/api.service.js';

// ---------------------------------------------------------------------------
// Locally-declared types — not exported by either package's public barrel.
// ---------------------------------------------------------------------------

/**
 * Mirrors `AwsProfileSummary` in
 * `app/packages/desktop-preload/src/hyveon-api.ts` — not re-exported through
 * `@hyveon/desktop-preload`'s public barrel, so re-declared here. Keep in
 * sync with the upstream source of truth.
 */
export interface AwsProfileSummary {
  profileName: string;
  region?: string;
}

/** Mirrors `BootstrapResourceStatus` in `hyveon-api.ts` — see {@link AwsProfileSummary} for why this is local. */
export type BootstrapResourceStatus = 'created' | 'exists' | 'failed';

/** Mirrors `BootstrapResult` in `hyveon-api.ts`. */
export interface BootstrapResult {
  status: BootstrapResourceStatus;
  message?: string;
}

/** Mirrors `IamCheckStatus` in `hyveon-api.ts`. */
export type IamCheckStatus = 'passed' | 'missing' | 'warning';

/** Mirrors `IamCheckOrigin` in `hyveon-api.ts`. */
export type IamCheckOrigin = 'guided' | 'pasted' | 'profile' | 'none';

/** Mirrors `IamCheckResult` in `hyveon-api.ts`. */
export interface IamCheckResult {
  status: IamCheckStatus;
  policyJson?: string;
  message?: string;
  origin: IamCheckOrigin;
  blocking: boolean;
}

/** Mirrors `WizardProgress` in `hyveon-api.ts`. */
export interface WizardProgress {
  step: WizardStep;
}

/** Mirrors `GameLogs` in `hyveon-api.ts` — the response shape of the `logs.get` IPC channel. */
export interface GameLogs {
  game: string;
  lines: string[];
}

// ---------------------------------------------------------------------------
// Fixed clock — every timestamp-bearing fixture below is anchored to this
// instant so screenshots are byte-for-byte reproducible between runs (task
// 2.11). `capture.spec.ts` freezes `Date`/`Intl` to the same instant via
// `page.clock.install()` before any screenshot is taken.
// ---------------------------------------------------------------------------

/** The instant every demo fixture treats as "now". Keep in sync with `FROZEN_TIME` in `capture.spec.ts`. */
export const DEMO_NOW = '2026-07-26T12:00:00.000Z';

// ---------------------------------------------------------------------------
// Games
// ---------------------------------------------------------------------------

const MINECRAFT_CONFIG: GameServer = {
  name: 'minecraft',
  image: 'itzg/minecraft-server:latest',
  cpu: 2048,
  memory: 4096,
  ports: [{ container: 25565, protocol: 'tcp' }],
  environment: [
    { name: 'EULA', value: 'TRUE' },
    { name: 'MEMORY', value: '3G' },
    { name: 'DIFFICULTY', value: 'normal' },
  ],
  volumes: [{ name: 'data', container_path: '/data' }],
  https: false,
  connect_message: 'Connect at {ip}:25565',
  file_seeds: [
    {
      path: '/data/server.properties',
      content: 'motd=Welcome to the Hyveon Minecraft server\nmax-players=20\n',
      mode: '0644',
    },
  ],
};

const VALHEIM_CONFIG: GameServer = {
  name: 'valheim',
  image: 'lloesche/valheim-server',
  cpu: 2048,
  memory: 4096,
  ports: [
    { container: 2456, protocol: 'udp' },
    { container: 2457, protocol: 'udp' },
    { container: 2458, protocol: 'udp' },
  ],
  environment: [
    { name: 'SERVER_NAME', value: 'Hyveon Valheim' },
    { name: 'WORLD_NAME', value: 'Midgard' },
  ],
  volumes: [{ name: 'config', container_path: '/config' }],
  https: false,
  connect_message: 'Connect at {ip}:2456',
};

const PALWORLD_CONFIG: GameServer = {
  name: 'palworld',
  image: 'thijsvanloef/palworld-server-docker:latest',
  cpu: 4096,
  memory: 8192,
  ports: [
    { container: 8211, protocol: 'udp' },
    { container: 27015, protocol: 'udp' },
  ],
  environment: [
    { name: 'PLAYERS', value: '16' },
    { name: 'SERVER_NAME', value: 'Hyveon Palworld' },
  ],
  volumes: [{ name: 'data', container_path: '/palworld' }],
  https: true,
  connect_message: 'Connect at palworld.hyveon.example.com',
};

/** Merged declared+deployed games list — the `games.list` IPC channel's payload shape. */
export const DEMO_GAMES: GameListEntry[] = [
  { name: 'minecraft', declared: true, deployed: true, config: MINECRAFT_CONFIG },
  { name: 'valheim', declared: true, deployed: true, config: VALHEIM_CONFIG },
  { name: 'palworld', declared: true, deployed: true, config: PALWORLD_CONFIG },
];

/** Live status for each game — `minecraft`/`palworld` running, `valheim` stopped, per the task spec. */
export const DEMO_STATUSES: GameStatus[] = [
  {
    game: 'minecraft',
    state: 'running',
    publicIp: '203.0.113.42',
    hostname: 'minecraft.hyveon.example.com',
    taskArn: 'arn:aws:ecs:us-east-1:123456789012:task/hyveon-cluster/6f9c2a1b3d4e4f5a8b9c0d1e2f3a4b5c',
  },
  { game: 'valheim', state: 'stopped' },
  {
    game: 'palworld',
    state: 'running',
    publicIp: '203.0.113.77',
    hostname: 'palworld.hyveon.example.com',
    taskArn: 'arn:aws:ecs:us-east-1:123456789012:task/hyveon-cluster/1a2b3c4d5e6f47a8b9c0d1e2f3a4b5c6',
  },
];

// ---------------------------------------------------------------------------
// Env / costs / watchdog
// ---------------------------------------------------------------------------

export const DEMO_ENV: EnvInfo = {
  region: 'us-east-1',
  domain: 'hyveon.example.com',
  environment: 'prod',
};

const MINECRAFT_ESTIMATE: GameEstimate = { vcpu: 2, memoryGb: 4, costPerHour: 0.1, costPerDay24h: 2.4, costPerMonth4hpd: 12.0 };
const VALHEIM_ESTIMATE: GameEstimate = { vcpu: 2, memoryGb: 4, costPerHour: 0.1, costPerDay24h: 2.4, costPerMonth4hpd: 12.0 };
const PALWORLD_ESTIMATE: GameEstimate = { vcpu: 4, memoryGb: 8, costPerHour: 0.2, costPerDay24h: 4.8, costPerMonth4hpd: 24.0 };

export const DEMO_COST_ESTIMATES: CostEstimates = {
  games: { minecraft: MINECRAFT_ESTIMATE, valheim: VALHEIM_ESTIMATE, palworld: PALWORLD_ESTIMATE },
  totalPerHourIfAllOn: MINECRAFT_ESTIMATE.costPerHour + VALHEIM_ESTIMATE.costPerHour + PALWORLD_ESTIMATE.costPerHour,
};

/**
 * Builds a deterministic `ActualCosts` window ending at {@link DEMO_NOW},
 * for a given number of trailing days. Pure (no `Date.now()`/`Math.random()`)
 * so repeat harness runs produce byte-identical output. The sinusoidal
 * `base` term gives the Costs page's stacked bar chart and delta-vs-prior
 * pill visibly non-flat, non-zero data without hand-authoring every day.
 */
export function demoActualCosts(days: number): ActualCosts {
  const end = new Date(DEMO_NOW);
  const daily: { date: string; cost: number }[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(end);
    d.setUTCDate(d.getUTCDate() - i);
    const dateStr = d.toISOString().slice(0, 10);
    const base = 9 + 4 * Math.sin(i / 3.2) + (i % 5 === 0 ? 1.5 : 0);
    const cost = Math.round(base * 100) / 100;
    daily.push({ date: dateStr, cost });
  }
  const total = Math.round(daily.reduce((sum, d) => sum + d.cost, 0) * 100) / 100;
  return { daily, total, currency: 'USD', days };
}

export const DEMO_WATCHDOG_CONFIG: WatchdogConfig = {
  watchdog_interval_minutes: 15,
  watchdog_idle_checks: 4,
  watchdog_min_packets: 100,
};

// ---------------------------------------------------------------------------
// Discord
// ---------------------------------------------------------------------------

const DEMO_ADMIN_USER_ID = '111122223333444455';
const DEMO_MOD_ROLE_ID = '556677889900112233';
const DEMO_GUILD_ID = '223344556677889900';

export const DEMO_DISCORD_CONFIG: DiscordConfigRedacted = {
  clientId: '998877665544332211',
  allowedGuilds: [DEMO_GUILD_ID],
  admins: { userIds: [DEMO_ADMIN_USER_ID], roleIds: [] },
  gamePermissions: {
    minecraft: { userIds: [DEMO_ADMIN_USER_ID], roleIds: [], actions: ['start', 'stop', 'status'] },
    valheim: { userIds: [], roleIds: [DEMO_MOD_ROLE_ID], actions: ['status'] },
  },
  baseAllowedGuilds: [DEMO_GUILD_ID],
  baseAdmins: { userIds: [], roleIds: [] },
  botTokenSet: true,
  publicKeySet: true,
  interactionsEndpointUrl: 'https://abcd1234efgh5678.lambda-url.us-east-1.on.aws/',
};

// ---------------------------------------------------------------------------
// Drift — one small, non-empty finding so the PendingChangesBanner has
// something to show without implying the fleet is badly out of sync.
// ---------------------------------------------------------------------------

const DEMO_DRIFT_ENTRY: DriftEntry = {
  game: 'palworld',
  kind: 'config_drift',
  changedFields: ['memory' as DriftChangedField],
};

export const DEMO_DRIFT_REPORT: DriftReport = { entries: [DEMO_DRIFT_ENTRY] };

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

function auditEntry(
  offsetHours: number,
  actor: string,
  action: AuditAction,
  game: string,
  before: GameServer | null,
  after: GameServer | null,
  versionId?: string,
): AuditEntry {
  const timestamp = new Date(new Date(DEMO_NOW).getTime() - offsetHours * 3_600_000).toISOString();
  return { sk: `${timestamp}#01J9DEMO${String(offsetHours).padStart(4, '0')}`, timestamp, actor, action, game, before, after, versionId };
}

export const DEMO_AUDIT: AuditPageResult = {
  entries: [
    auditEntry(2, 'chris@hyveon.example.com', 'edit', 'palworld', { ...PALWORLD_CONFIG, memory: 6144 }, PALWORLD_CONFIG, 'v48'),
    auditEntry(20, 'chris@hyveon.example.com', 'plan', 'palworld', null, null),
    auditEntry(30, 'ops@hyveon.example.com', 'add', 'palworld', null, PALWORLD_CONFIG, 'v47'),
    auditEntry(72, 'chris@hyveon.example.com', 'edit', 'minecraft', { ...MINECRAFT_CONFIG, memory: 2048 }, MINECRAFT_CONFIG, 'v40'),
    auditEntry(96, 'ops@hyveon.example.com', 'remove', 'rust', { ...MINECRAFT_CONFIG, name: 'rust', image: 'didstopia/rust-server' }, null, 'v39'),
  ],
};

// ---------------------------------------------------------------------------
// Logs — ~30 lines spanning INFO/WARN/ERROR/DEBUG, minecraft-flavoured since
// LogsPage auto-selects the first game in the list.
// ---------------------------------------------------------------------------

export const DEMO_LOG_LINES: string[] = [
  '2026-07-26T11:58:02Z INFO Starting minecraft server version 1.21.1',
  '2026-07-26T11:58:02Z INFO Loading properties',
  '2026-07-26T11:58:03Z DEBUG Default game type: SURVIVAL',
  '2026-07-26T11:58:03Z INFO Generating keypair',
  '2026-07-26T11:58:04Z INFO Starting Minecraft server on *:25565',
  '2026-07-26T11:58:04Z INFO Using epoll channel type',
  '2026-07-26T11:58:05Z DEBUG Reloading ResourceManager: Default, minecraft:core',
  '2026-07-26T11:58:07Z INFO Preparing level "world"',
  '2026-07-26T11:58:09Z DEBUG Loaded 1246 recipes',
  '2026-07-26T11:58:09Z DEBUG Loaded 1348 advancements',
  '2026-07-26T11:58:12Z INFO Preparing start region for dimension minecraft:overworld',
  '2026-07-26T11:58:15Z WARN Can\'t keep up! Is the server overloaded? Running 612ms behind, skipping 12 tick(s)',
  '2026-07-26T11:58:18Z INFO Time elapsed: 8734 ms',
  '2026-07-26T11:58:18Z INFO Done (9.312s)! For help, type "help"',
  '2026-07-26T11:58:18Z INFO Starting remote control listener',
  '2026-07-26T11:58:18Z INFO Thread RCON Listener started',
  '2026-07-26T12:00:41Z INFO UUID of player chris is 4f3a2b1c-0d9e-4f8a-8b7c-6d5e4f3a2b1c',
  '2026-07-26T12:00:41Z INFO chris[/203.0.113.9:52344] logged in with entity id 312 at (12.5, 64.0, -8.2)',
  '2026-07-26T12:00:41Z INFO chris joined the game',
  '2026-07-26T12:01:03Z DEBUG Saving chunks for level \'ServerLevel[world]\'/minecraft:overworld',
  '2026-07-26T12:03:15Z WARN Deprecated config option "max-tick-time" in server.properties; use "max-tick-time-ms" instead',
  '2026-07-26T12:05:22Z ERROR Connection reset by peer for connection /198.51.100.14:51022',
  '2026-07-26T12:05:22Z INFO Disconnecting steve: Connection reset',
  '2026-07-26T12:06:00Z DEBUG Autosave started',
  '2026-07-26T12:06:04Z DEBUG Autosave finished in 3841 ms',
  '2026-07-26T12:08:12Z INFO alex[/203.0.113.55:44881] logged in with entity id 318 at (-4.0, 70.0, 15.3)',
  '2026-07-26T12:08:12Z INFO alex joined the game',
  '2026-07-26T12:11:47Z WARN alex moved too quickly! -0.02,-1.53,0.01',
  '2026-07-26T12:14:30Z ERROR Encountered an unexpected exception handling packet ServerboundInteractPacket',
  '2026-07-26T12:14:30Z DEBUG   at net.minecraft.network.PacketDecoder.decode(PacketDecoder.java:37)',
  '2026-07-26T12:15:00Z INFO Saved the game',
];

/**
 * Lines delivered over the *live* `logs.stream` channel, arriving after the
 * `logs.get` snapshot above ({@link DEMO_LOG_LINES}) is already on screen —
 * this is what proves the tail is actually live in `logs.png`, not just a
 * static snapshot. Timestamps continue on from `DEMO_LOG_LINES`'s last line.
 */
export const DEMO_LOG_STREAM_LINES: string[] = [
  '2026-07-26T12:15:04Z INFO alex issued server command: [tp chris 12 64 -8]',
  '2026-07-26T12:15:09Z DEBUG Autosave started',
  '2026-07-26T12:15:12Z INFO Autosave finished in 2984 ms',
];

// ---------------------------------------------------------------------------
// Diagnostics tail (Settings page)
// ---------------------------------------------------------------------------

export const DEMO_DIAGNOSTICS_TAIL: string[] = [
  '2026-07-26T11:55:01Z info  desktop-main started (pid 41823)',
  '2026-07-26T11:55:01Z info  Loaded terraform.tfstate (3 games deployed)',
  '2026-07-26T11:55:02Z info  ConfigService cache warmed',
  '2026-07-26T11:58:20Z info  games.start minecraft → RunTask ok, task 6f9c2a1b3d4e4f5a',
  '2026-07-26T12:03:15Z warn  watchdog: minecraft idle check 1/4',
  '2026-07-26T12:05:22Z error CloudWatch tail: connection reset, retrying',
];

// ---------------------------------------------------------------------------
// Terraform run history — five records covering every kind/status
// combination the history table renders differently.
// ---------------------------------------------------------------------------

const RUN_9: RunHistoryRecord = {
  sk: '2026-07-26T09:32:10.000Z#run-9', runId: 'run-9', kind: 'apply', status: 'success',
  startedAt: '2026-07-26T09:32:10.000Z', completedAt: '2026-07-26T09:36:02.000Z', exitCode: 0,
  planHash: 'a1b2c3d4', approvedBy: 'chris@hyveon.example.com', approvedAt: '2026-07-26T09:31:40.000Z',
  tfvarsVersionId: 'v48',
};
const RUN_8: RunHistoryRecord = {
  sk: '2026-07-26T09:28:00.000Z#run-8', runId: 'run-8', kind: 'plan', status: 'success',
  startedAt: '2026-07-26T09:28:00.000Z', completedAt: '2026-07-26T09:29:12.000Z', exitCode: 0, planHash: 'a1b2c3d4',
};
const RUN_7: RunHistoryRecord = {
  sk: '2026-07-25T14:14:00.000Z#run-7', runId: 'run-7', kind: 'plan', status: 'failed',
  startedAt: '2026-07-25T14:14:00.000Z', completedAt: '2026-07-25T14:14:41.000Z', exitCode: 1,
};
const RUN_6: RunHistoryRecord = {
  sk: '2026-07-24T18:02:00.000Z#run-6', runId: 'run-6', kind: 'destroy', status: 'aborted',
  startedAt: '2026-07-24T18:02:00.000Z', completedAt: '2026-07-24T18:05:30.000Z', exitCode: null,
};
const RUN_5: RunHistoryRecord = {
  sk: '2026-07-23T11:00:00.000Z#run-5', runId: 'run-5', kind: 'apply', status: 'success',
  startedAt: '2026-07-23T11:00:00.000Z', completedAt: '2026-07-23T11:07:15.000Z', exitCode: 0,
  approvedBy: 'ops@hyveon.example.com', tfvarsVersionId: 'v41', rolledBackFrom: 'run-3',
};

export const DEMO_TERRAFORM_HISTORY: RunHistoryPageResult = {
  records: [RUN_9, RUN_8, RUN_7, RUN_6, RUN_5],
  // Omitted on purpose: with 5 records under the 25-per-page default, the
  // history page's "Load more" button should stay hidden.
};

// ---------------------------------------------------------------------------
// Terraform streamed output — realistic ANSI-colored chunks for the
// `terraform.runs.logs` streaming channel (a plan/apply run), keyed to line
// up with the rest of the demo fixture set (the plan below mirrors
// {@link DEMO_DRIFT_REPORT}'s palworld memory drift, and the apply chunks
// mirror the same change count so
// `terraform-awaiting-approval.png`/`terraform-apply.png` tell one
// consistent story). Colors use the same SGR subset `AnsiLogViewer` parses:
// `\x1b[32m` green, `\x1b[33m` amber, `\x1b[1m` bold, `\x1b[0m` reset. The
// wizard's stack-init step has no log output of its own to model this way —
// see {@link DEMO_STACK_INIT_EVENTS} below.
// ---------------------------------------------------------------------------

/** Streamed `terraform plan` output for the `run-plan-demo` run — ends with the summary line `TerraformPage.parsePlanSummary` scrapes. */
export const DEMO_TERRAFORM_PLAN_CHUNKS: TerraformRunChunk[] = [
  { stream: 'stdout', line: 'Refreshing Terraform state in-memory prior to plan...' },
  { stream: 'stdout', line: 'module.cloud.aws_ecs_cluster.this: Refreshing state... [id=hyveon-cluster]' },
  { stream: 'stdout', line: 'module.cloud.aws_ecs_task_definition.game["palworld"]: Refreshing state... [id=palworld-server]' },
  { stream: 'stdout', line: '' },
  {
    stream: 'stdout',
    line: 'Terraform used the selected providers to generate the following execution plan. Resource actions are indicated with the following symbols:',
  },
  { stream: 'stdout', line: '  \x1b[33m~\x1b[0m update in-place' },
  { stream: 'stdout', line: '  \x1b[32m+\x1b[0m create' },
  { stream: 'stdout', line: '' },
  { stream: 'stdout', line: 'Terraform will perform the following actions:' },
  { stream: 'stdout', line: '' },
  { stream: 'stdout', line: '  # module.cloud.aws_ecs_task_definition.game["palworld"] will be updated in-place' },
  { stream: 'stdout', line: '  \x1b[33m~\x1b[0m resource "aws_ecs_task_definition" "game" {' },
  { stream: 'stdout', line: '        id      = "palworld-server"' },
  { stream: 'stdout', line: '      \x1b[33m~\x1b[0m memory  = "6144" -> "8192"' },
  { stream: 'stdout', line: '        # (14 unchanged attributes hidden)' },
  { stream: 'stdout', line: '    }' },
  { stream: 'stdout', line: '' },
  { stream: 'stdout', line: '  # module.cloud.aws_cloudwatch_log_group.game["terraria"] will be created' },
  { stream: 'stdout', line: '  \x1b[32m+\x1b[0m resource "aws_cloudwatch_log_group" "game" {' },
  { stream: 'stdout', line: '      \x1b[32m+\x1b[0m name              = "/ecs/terraria-server"' },
  { stream: 'stdout', line: '      \x1b[32m+\x1b[0m retention_in_days = 14' },
  { stream: 'stdout', line: '    }' },
  { stream: 'stdout', line: '' },
  { stream: 'stdout', line: '\x1b[1mPlan: 1 to add, 1 to change, 0 to destroy.\x1b[0m' },
];

/** Streamed `terraform apply` output for the `run-apply-demo` run — same 1 add / 1 change / 0 destroy shape as {@link DEMO_TERRAFORM_PLAN_CHUNKS}, ending with the summary line `TerraformPage.parseApplySummary` scrapes. */
export const DEMO_TERRAFORM_APPLY_CHUNKS: TerraformRunChunk[] = [
  { stream: 'stdout', line: 'module.cloud.aws_ecs_task_definition.game["palworld"]: Modifying... [id=palworld-server]' },
  { stream: 'stdout', line: 'module.cloud.aws_ecs_task_definition.game["palworld"]: Modifications complete after 1s [id=palworld-server]' },
  { stream: 'stdout', line: 'module.cloud.aws_cloudwatch_log_group.game["terraria"]: Creating...' },
  { stream: 'stdout', line: 'module.cloud.aws_cloudwatch_log_group.game["terraria"]: Creation complete after 0s [id=/ecs/terraria-server]' },
  { stream: 'stdout', line: '' },
  { stream: 'stdout', line: '\x1b[1m\x1b[32mApply complete! Resources: 1 added, 1 changed, 0 destroyed.\x1b[0m' },
];

/**
 * Streamed `iac.stack.initialize` phase events — the fourth first-run-wizard
 * step and Settings' Reconfigure flow both drive this to completion (task
 * 10.3 replaced the fifth-step `terraform init` this constant used to model
 * with a fourth-step Pulumi stack-initialization step reporting three coarse
 * phases instead of scrolling log lines).
 */
export const DEMO_STACK_INIT_EVENTS: StackInitPhaseEvent[] = [
  { phase: 'engine', status: 'start' },
  { phase: 'engine', status: 'end' },
  { phase: 'plugins', status: 'start' },
  { phase: 'plugins', status: 'end' },
  { phase: 'operation', status: 'start' },
  { phase: 'operation', status: 'end' },
];

// ---------------------------------------------------------------------------
// seedDemo — installs every IPC mock the routed app (dashboard, games,
// discord, logs, costs, audit, settings, terraform) needs to render fully
// populated. Values are passed as a single serialisable argument to
// `win.evaluate` rather than captured in the closure, since mock handlers
// registered via `window.hyveon.__test.mock` are re-evaluated inside the
// page's own JS context.
// ---------------------------------------------------------------------------

/** Per-call overrides for {@link seedDemo} — every field defaults to the module's `DEMO_*` constant. */
export interface DemoOverrides {
  env?: EnvInfo;
  statuses?: GameStatus[];
  games?: GameListEntry[];
  costEstimates?: CostEstimates;
  watchdog?: WatchdogConfig;
  discord?: DiscordConfigRedacted;
  drift?: DriftReport;
  audit?: AuditPageResult;
  logLines?: string[];
  /** Lines delivered over the live `logs.stream` channel, after `logLines`' snapshot is already on screen. */
  logStreamLines?: string[];
  terraformHistory?: RunHistoryPageResult;
  /** Streamed `terraform plan` chunks for the `run-plan-demo` run. */
  terraformPlanChunks?: TerraformRunChunk[];
  /** Streamed `terraform apply` chunks for the `run-apply-demo` run. */
  terraformApplyChunks?: TerraformRunChunk[];
}

/**
 * Seeds every IPC channel the routed application (i.e. everything except the
 * first-run wizard — see {@link seedWizard} for that) touches, using the
 * `window.hyveon.__test.mock` seam exposed by the preload script under
 * `HYVEON_TEST_MODE=1`.
 *
 * Registers via `win.addInitScript(...)` rather than `win.evaluate(...)`:
 * several channels (`wizard.state.get` at app-root mount, `costs.estimate`
 * at `GameStatusProvider` mount) are read exactly once, above the router, the
 * instant the renderer's bundle runs — by the time `_electron.launch()`
 * resolves `app.firstWindow()`, that mount has often already happened with
 * no mocks in place. `addInitScript` queues this registration to run again
 * on the *next* navigation, before the page's own scripts execute, so the
 * caller must follow this call with a same-URL reload
 * (`await win.goto(win.url())` — `win.reload()` throws `net::ERR_ABORTED` on
 * a `file://` origin) for the seeded mocks to actually take effect. See
 * `capture.spec.ts`'s `launchSeeded` helper, which does exactly this.
 *
 * Always mocks `wizard.state.get` to `{ wizardCompleted: true }` so the app
 * root renders the normal router instead of the first-run wizard, regardless
 * of what's persisted in the Electron profile the harness happens to run
 * against.
 *
 * Streaming channels (`logs.stream`, `terraform.runs.logs`, `iac.stack.initialize`)
 * are registered with a **plain-object async-iterable** mock (built by the
 * local `toIterable` helper below), not a real `async function*` — a real
 * generator instance returned from a mock handler still can't cross the
 * renderer→preload direction (the mock itself runs in the renderer, invoked
 * from preload via a reverse proxy), so it hits the same structured-clone
 * wall the original production bug did, just in the opposite direction. This
 * is a pre-existing property of the `__test.mock` convenience surface, not
 * the bug the app's own `HyveonStreamHandle` wrapper (see `preload.ts`) was
 * built to fix — see `streaming-handle-roundtrip.spec.ts` for the spec that
 * pins this pattern down directly against the real preload script. Every
 * streaming mock below follows that pattern, and each channel now yields
 * real content so `capture.spec.ts` can assert on it before taking a shot.
 */
export async function seedDemo(win: Page, overrides: DemoOverrides = {}): Promise<void> {
  const data = {
    env: overrides.env ?? DEMO_ENV,
    statuses: overrides.statuses ?? DEMO_STATUSES,
    games: overrides.games ?? DEMO_GAMES,
    costEstimates: overrides.costEstimates ?? DEMO_COST_ESTIMATES,
    actualCostsByDays: {
      '7': demoActualCosts(7),
      '14': demoActualCosts(14),
      '30': demoActualCosts(30),
      '60': demoActualCosts(60),
    } as Record<string, ActualCosts>,
    watchdog: overrides.watchdog ?? DEMO_WATCHDOG_CONFIG,
    discord: overrides.discord ?? DEMO_DISCORD_CONFIG,
    drift: overrides.drift ?? DEMO_DRIFT_REPORT,
    audit: overrides.audit ?? DEMO_AUDIT,
    logLines: overrides.logLines ?? DEMO_LOG_LINES,
    logStreamLines: overrides.logStreamLines ?? DEMO_LOG_STREAM_LINES,
    terraformHistory: overrides.terraformHistory ?? DEMO_TERRAFORM_HISTORY,
    terraformPlanChunks: overrides.terraformPlanChunks ?? DEMO_TERRAFORM_PLAN_CHUNKS,
    terraformApplyChunks: overrides.terraformApplyChunks ?? DEMO_TERRAFORM_APPLY_CHUNKS,
    stackInitEvents: DEMO_STACK_INIT_EVENTS,
    diagnosticsLines: DEMO_DIAGNOSTICS_TAIL,
    diagnosticsPath: '/home/hyveon/.config/Hyveon/logs/desktop-main.log',
  };

  await win.addInitScript((d) => {
    const bridge = (window as unknown as { hyveon: { __test: { mock: (channel: string, handler: unknown) => void } } })
      .hyveon;
    const mock = bridge.__test.mock;

    /**
     * Builds a plain-object async-iterable mock from a fixed array of items —
     * the renderer→preload-safe shape `window.hyveon.__test.mock` needs for a
     * streaming channel (see this function's own module-level TSDoc above for
     * why a real `async function*` doesn't survive that crossing).
     */
    function toIterable<T>(items: T[]) {
      let index = 0;
      return {
        [Symbol.asyncIterator]() {
          return this;
        },
        next: () =>
          index < items.length
            ? Promise.resolve({ done: false, value: items[index++]! })
            : Promise.resolve({ done: true, value: undefined as T | undefined }),
      };
    }

    mock('wizard.state.get', () => Promise.resolve({ wizardCompleted: true }));

    mock('env.get', () => Promise.resolve(d.env));
    mock('games.status', () => Promise.resolve(d.statuses));
    mock('games.getStatus', (game: unknown) => {
      const found = d.statuses.find((s) => s.game === game);
      return Promise.resolve(found ?? { game: String(game), state: 'not_deployed' });
    });
    mock('games.list', () => Promise.resolve({ games: d.games }));
    mock('games.start', (game: unknown) => Promise.resolve({ success: true, message: `${String(game)} is starting` }));
    mock('games.stop', (game: unknown) => Promise.resolve({ success: true, message: `${String(game)} is stopping` }));

    mock('costs.estimate', () => Promise.resolve(d.costEstimates));
    mock('costs.actual', (days: unknown) => {
      const key = String(typeof days === 'number' ? days : 7);
      return Promise.resolve(d.actualCostsByDays[key] ?? d.actualCostsByDays['7']);
    });

    mock('discord.getConfig', () => Promise.resolve(d.discord));
    mock('discord.putConfig', () => Promise.resolve({ success: true, config: d.discord }));
    mock('discord.listGuilds', () => Promise.resolve({ guilds: d.discord.allowedGuilds, baseGuilds: d.discord.baseAllowedGuilds }));
    mock('discord.addGuild', () => Promise.resolve({ success: true, guilds: d.discord.allowedGuilds }));
    mock('discord.removeGuild', () => Promise.resolve({ success: true, guilds: d.discord.allowedGuilds }));
    mock('discord.registerCommands', () => Promise.resolve({ success: true, message: 'Registered' }));
    mock('discord.getAdmins', () => Promise.resolve({ ...d.discord.admins, baseAdmins: d.discord.baseAdmins }));
    mock('discord.putAdmins', () => Promise.resolve({ success: true, admins: d.discord.admins, baseAdmins: d.discord.baseAdmins }));
    mock('discord.getPermissions', () => Promise.resolve(d.discord.gamePermissions));
    mock('discord.putPermission', () => Promise.resolve({ success: true, permissions: d.discord.gamePermissions }));
    mock('discord.deletePermission', () => Promise.resolve({ success: true, permissions: d.discord.gamePermissions }));

    mock('config.get', () => Promise.resolve(d.watchdog));
    mock('config.update', () => Promise.resolve({ success: true, config: d.watchdog }));

    mock('drift.get', () => Promise.resolve(d.drift));
    mock('audit.list', () => Promise.resolve(d.audit));

    mock('logs.get', (arg: unknown) => {
      const opts = (arg ?? {}) as { game?: string; limit?: number };
      return Promise.resolve({ game: opts.game ?? 'minecraft', lines: d.logLines });
    });
    // Live tail: yields the lines in `d.logStreamLines` after the `logs.get`
    // snapshot above is already rendered — see `toIterable`'s TSDoc for why
    // this is a plain-object iterable rather than a real `async function*`.
    mock('logs.stream', () => toIterable(d.logStreamLines));

    mock('diagnostics.tail', () => Promise.resolve({ lines: d.diagnosticsLines }));
    mock('diagnostics.path', () => Promise.resolve({ path: d.diagnosticsPath }));

    // ---- Terraform ----
    mock('iac.plan', () => Promise.resolve({ started: true, runId: 'run-plan-demo' }));
    mock('iac.approve', () =>
      Promise.resolve({ approved: true, approvedBy: 'chris@hyveon.example.com', approvedAt: new Date().toISOString() }),
    );
    mock('iac.apply', () => Promise.resolve({ started: true, runId: 'run-apply-demo' }));
    mock('iac.destroy.mintToken', () => Promise.resolve({ token: 'demo-destroy-token' }));
    mock('iac.destroy', () => Promise.resolve({ started: true, runId: 'run-destroy-demo' }));
    mock('iac.output', () => Promise.resolve(null));
    mock('iac.runs.get', (arg: unknown) => {
      const { runId } = (arg ?? {}) as { runId?: string };
      if (runId === 'run-plan-demo') {
        return Promise.resolve({
          found: true,
          status: 'awaiting_approval',
          record: {
            runId: 'run-plan-demo',
            kind: 'plan',
            startedAt: '2026-07-26T11:58:00.000Z',
            completedAt: '2026-07-26T11:58:42.000Z',
            exitCode: 0,
            planHash: 'demo-plan-hash-1',
            // Structured resource-change summary — see `ChangeSummary`'s
            // TSDoc (`@hyveon/shared/src/changeSummary.ts`): the UI reads
            // this directly (`ChangeSummaryStatus` in `iac.page.tsx`), never
            // by parsing `DEMO_TERRAFORM_PLAN_CHUNKS`'s streamed text, even
            // though the two are kept in the same 1 create / 1 update shape
            // so the log and the badges tell one consistent story.
            changeSummary: { create: 1, update: 1 },
          },
        });
      }
      if (runId === 'run-apply-demo') {
        return Promise.resolve({
          found: true,
          status: 'success',
          record: {
            runId: 'run-apply-demo',
            kind: 'apply',
            startedAt: '2026-07-26T12:01:00.000Z',
            completedAt: '2026-07-26T12:03:12.000Z',
            exitCode: 0,
            changeSummary: { create: 1, update: 1 },
          },
        });
      }
      return Promise.resolve({ found: false });
    });
    mock('iac.runs.list', () => Promise.resolve(d.terraformHistory));
    mock('iac.runs.logUrl', () => Promise.resolve({ url: 'https://example-logs.s3.amazonaws.com/demo-run.log' }));
    // Keyed on `runId` (the preload calls this handler with `(runId, signal)`
    // — see `streamTerraformRunLogs` in `preload.ts`) so the plan and apply
    // runs each stream their own realistic output.
    mock('iac.runs.logs', (runId: unknown) => {
      if (runId === 'run-plan-demo') return toIterable(d.terraformPlanChunks);
      if (runId === 'run-apply-demo') return toIterable(d.terraformApplyChunks);
      return toIterable([]);
    });
    mock('iac.stack.initialize', () => toIterable(d.stackInitEvents));
  }, data);
}

// ---------------------------------------------------------------------------
// seedWizard — installs every IPC mock the first-run wizard needs. The
// caller is responsible for driving step-specific UI interactions
// (`capture.spec.ts` does this) — this only seeds data, it does not click
// through the flow.
// ---------------------------------------------------------------------------

/**
 * Seeds every `wizard.*` (and `iac.stack.initialize`) IPC channel used
 * across all five first-run-wizard steps, plus `wizard.state.get` set to
 * `{ wizardCompleted: false }` so `app.component.tsx` renders
 * `<FirstRunWizard>` instead of the normal router.
 *
 * `resumeStep` seeds `wizard.progress.get`'s `{ step }` response, which the
 * wizard shell uses on mount to jump directly to `'pick-cloud'`,
 * `'guided-iam'`, `'credentials'`, or `'bootstrap'` (resuming past
 * `'stack-init'` is intentionally clamped to `'bootstrap'` by the app itself
 * — see `first-run-wizard.component.tsx`'s resume-on-mount effect — so
 * `capture.spec.ts` always reaches step 5 via one `Next` click from a
 * bootstrap-complete state, never via a direct resume jump).
 *
 * Like {@link seedDemo}, registers via `win.addInitScript(...)` (not
 * `win.evaluate(...)`) because `wizard.state.get` and `wizard.progress.get`
 * are both read once, synchronously on mount, by `app.component.tsx` and
 * `FirstRunWizard` respectively — the caller must follow this call with
 * `await win.goto(win.url())` for the seed to take effect.
 */
export async function seedWizard(win: Page, resumeStep: WizardStep = 'pick-cloud'): Promise<void> {
  const data = {
    resumeStep,
    profiles: [
      { profileName: 'default', region: 'us-east-1' },
      { profileName: 'hyveon-deploy', region: 'eu-west-2' },
    ] as AwsProfileSummary[],
    bootstrapCreated: { status: 'created' as BootstrapResourceStatus },
    bootstrapExists: { status: 'exists' as BootstrapResourceStatus },
    iamPassed: { status: 'passed', origin: 'profile', blocking: false } as IamCheckResult,
    wizardState: { wizardCompleted: false } as WizardState,
    stackInitEvents: DEMO_STACK_INIT_EVENTS,
    /** Fixed showroom path for the rendered `iam-bootstrap.yaml` — matches `DEMO_DIAGNOSTICS_TAIL`'s `diagnosticsPath` convention rather than a real on-disk path. */
    guidedIamTemplatePath: '/home/hyveon/.config/Hyveon/iam-bootstrap/iam-bootstrap-2026-07-26.yaml',
  };

  await win.addInitScript((d) => {
    const bridge = (window as unknown as { hyveon: { __test: { mock: (channel: string, handler: unknown) => void } } })
      .hyveon;
    const mock = bridge.__test.mock;

    // See `seedDemo`'s `toIterable` helper — same plain-object
    // async-iterable pattern, duplicated here since each `addInitScript`
    // callback is serialised independently and can't share a closure.
    function toIterable<T>(items: T[]) {
      let index = 0;
      return {
        [Symbol.asyncIterator]() {
          return this;
        },
        next: () =>
          index < items.length
            ? Promise.resolve({ done: false, value: items[index++]! })
            : Promise.resolve({ done: true, value: undefined as T | undefined }),
      };
    }

    mock('wizard.state.get', () => Promise.resolve({ wizardCompleted: false }));
    mock('wizard.progress.get', () => Promise.resolve({ step: d.resumeStep }));
    mock('wizard.progress.save', () => Promise.resolve());
    mock('wizard.aws.listProfiles', () => Promise.resolve(d.profiles));
    mock('wizard.aws.saveCredentials', () => Promise.resolve({ profileName: 'hyveon-pasted' }));
    mock('wizard.state.save', (input: unknown) =>
      Promise.resolve({ wizardCompleted: false, ...(input as object) }),
    );
    mock('wizard.bootstrap.stateBucket', () => Promise.resolve(d.bootstrapCreated));
    mock('wizard.bootstrap.configurationBucket', () => Promise.resolve(d.bootstrapExists));
    mock('wizard.iam.simulate', () => Promise.resolve(d.iamPassed));
    mock('wizard.complete', () => Promise.resolve({ wizardCompleted: true }));
    // `GuidedIamStep`'s template screen — mocked so the harness never shells
    // out to the real `GuidedIamService.prepareTemplate()` (which renders
    // and writes an actual `iam-bootstrap.yaml` to disk under a real,
    // machine-specific path).
    mock('wizard.guidedIam.prepareTemplate', () => Promise.resolve({ path: d.guidedIamTemplatePath }));
    // Streams a full engine/plugins/operation phase sequence to completion —
    // see `seedDemo`'s TSDoc for why this is a plain-object iterable rather
    // than a real `async function*`. `StackInitializationStep` reaches its
    // `'success'` state once the iteration completes without throwing.
    mock('iac.stack.initialize', () => toIterable(d.stackInitEvents));
  }, data);
}

export type { TerraformApproveAck, TerraformDestroyMintAck, TerraformPlanAck, TerraformRunsGetResult };
