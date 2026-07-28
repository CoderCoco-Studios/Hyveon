import type {
  GameStatus,
  CostEstimates,
  EnvInfo,
  WatchdogConfig,
  ActualCosts,
  DiscordConfigRedacted,
} from '@/api.service.js';

/** Stub response for `GET /api/env`. */
export const ENV_DATA: EnvInfo = {
  region: 'us-east-1',
  domain: 'example.com',
  environment: 'dev',
};

/** A single stopped game — use as the default single-game fixture. */
export const STOPPED_GAME: GameStatus = {
  game: 'minecraft',
  state: 'stopped',
};

/** A single running game with a public IP. */
export const RUNNING_GAME: GameStatus = {
  game: 'minecraft',
  state: 'running',
  publicIp: '1.2.3.4',
  hostname: 'minecraft.example.com',
  taskArn: 'arn:aws:ecs:us-east-1:123:task/minecraft/abc',
};

/** Two-game fixture covering stopped + running states. */
export const MULTI_GAME_STATUSES: GameStatus[] = [
  STOPPED_GAME,
  { game: 'valheim', state: 'running', publicIp: '5.6.7.8' },
];

/** Stub response for `GET /api/config` (the watchdog tuning panel). */
export const WATCHDOG_CONFIG: WatchdogConfig = {
  watchdog_interval_minutes: 15,
  watchdog_idle_checks: 4,
  watchdog_min_packets: 100,
};

/** Stub response for `GET /api/costs/estimate`. */
export const COST_DATA: CostEstimates = {
  games: {
    minecraft: {
      vcpu: 1,
      memoryGb: 2,
      costPerHour: 0.08,
      costPerDay24h: 1.92,
      costPerMonth4hpd: 9.6,
    },
  },
  totalPerHourIfAllOn: 0.08,
};

/** Multi-game estimates fixture for sort / filter specs on the Costs page. */
export const MULTI_GAME_COST_DATA: CostEstimates = {
  games: {
    minecraft: {
      vcpu: 1,
      memoryGb: 2,
      costPerHour: 0.08,
      costPerDay24h: 1.92,
      costPerMonth4hpd: 9.6,
    },
    valheim: {
      vcpu: 2,
      memoryGb: 4,
      costPerHour: 0.16,
      costPerDay24h: 3.84,
      costPerMonth4hpd: 19.2,
    },
    palworld: {
      vcpu: 4,
      memoryGb: 8,
      costPerHour: 0.32,
      costPerDay24h: 7.68,
      costPerMonth4hpd: 38.4,
    },
  },
  totalPerHourIfAllOn: 0.56,
};

/** Stub response for `GET /api/costs/actual` — 7 days of synthetic spend used by the KPI sparklines. */
export const ACTUAL_COSTS: ActualCosts = {
  daily: [
    { date: '2026-04-26', cost: 0.42 },
    { date: '2026-04-27', cost: 0.31 },
    { date: '2026-04-28', cost: 0.55 },
    { date: '2026-04-29', cost: 0.18 },
    { date: '2026-04-30', cost: 0.27 },
    { date: '2026-05-01', cost: 0.40 },
    { date: '2026-05-02', cost: 0.35 },
  ],
  total: 2.48,
  currency: 'USD',
  days: 7,
};

/**
 * Build a deterministic `ActualCosts` payload with `days` daily entries.
 * The first half of the window costs $0.50/day and the second half costs
 * $1.00/day, so the Costs page renders a non-zero delta-vs-prior pill when
 * the page fetches both `days=7` (current) and `days=14` (prior) windows
 * from the same stub.
 */
export function makeActualCosts(days: number): ActualCosts {
  const daily = Array.from({ length: days }, (_, i) => ({
    date: `2026-04-${String((i % 30) + 1).padStart(2, '0')}`,
    cost: i < days / 2 ? 0.5 : 1.0,
  }));
  const total = daily.reduce((sum, d) => sum + d.cost, 0);
  return { daily, total: Math.round(total * 100) / 100, currency: 'USD', days };
}

/** A valid Discord snowflake (17–20 digits) for use in test inputs. */
export const VALID_GUILD_ID = '123456789012345678';
/** A second valid snowflake — useful for multi-guild specs. */
export const VALID_GUILD_ID_2 = '987654321098765432';
/** A valid user-shaped snowflake for admin/permission specs. */
export const VALID_USER_ID = '111122223333444455';

/**
 * First-run Discord config — no guilds, no admins, no secrets configured.
 * Triggers the `/discord` setup-wizard render path.
 */
export const FIRST_RUN_DISCORD_CONFIG: DiscordConfigRedacted = {
  clientId: '',
  allowedGuilds: [],
  admins: { userIds: [], roleIds: [] },
  gamePermissions: {},
  baseAllowedGuilds: [],
  baseAdmins: { userIds: [], roleIds: [] },
  botTokenSet: false,
  publicKeySet: false,
  interactionsEndpointUrl: null,
};

/**
 * Fully-configured Discord config — bot token + public key set, one allowlisted
 * guild, one admin user. Used to exercise the post-setup tabs.
 */
export const CONFIGURED_DISCORD_CONFIG: DiscordConfigRedacted = {
  clientId: '111111111111111111',
  allowedGuilds: [VALID_GUILD_ID],
  admins: { userIds: [VALID_USER_ID], roleIds: [] },
  gamePermissions: {},
  baseAllowedGuilds: [],
  baseAdmins: { userIds: [], roleIds: [] },
  botTokenSet: true,
  publicKeySet: true,
  interactionsEndpointUrl: 'https://abc123.lambda-url.us-east-1.on.aws/',
};

/**
 * A handful of CloudWatch lines with mixed log levels — used by the LogsPage
 * specs to exercise level-badge detection, search highlighting, and the
 * Levels filter.
 */
export const SAMPLE_LOG_LINES: string[] = [
  '2026-05-03T12:00:00Z INFO Server started on port 25565',
  '2026-05-03T12:00:01Z DEBUG Loaded world "world" in 1.2s',
  '2026-05-03T12:00:02Z WARN Deprecated config option "max-tick-time"',
  '2026-05-03T12:00:03Z ERROR Connection refused from 10.0.0.5',
  '2026-05-03T12:00:04Z Player joined the game',
];
