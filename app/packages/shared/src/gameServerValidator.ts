/**
 * Zod-backed structural schema + business-rule validator for a single
 * `game_servers` map entry (historically the app's original
 * `game_servers` config input;
 * see the {@link GameServer} mirror in `./gameServerConfig.js`).
 *
 * This module is deliberately split in two:
 *  - {@link gameServerSchema} mirrors the app's original `game_servers`
 *    object type field-for-field (it does NOT include `name` — like that
 *    original object, `name` is the map key, not an attribute of the entry).
 *  - {@link validateGameServer} layers the custom business rules that can't
 *    be expressed as a pure per-field zod refinement because they either
 *    need the sibling `game_servers` entries (port collisions) or are
 *    cross-cutting checks over the already-typed entry (Fargate CPU/memory
 *    pairing, absolute paths, connect-message placeholders, HTTPS port
 *    constraints).
 *
 * Intended for both the desktop-main API (validating a proposed
 * `DeploymentConfig.gameServers` edit before writing it back) and the web
 * client (surfacing the same messages in a form).
 */

import { z } from 'zod';
import type { GameServer, GameServerPort } from './gameServerConfig.js';

/**
 * Matches a game name that's safe to use both as a `DeploymentConfig.gameServers`
 * JSON object key AND as a component of every AWS-side identifier the Pulumi
 * program derives from it — the strictest of which is the per-game DNS label
 * (`${game}.${hostedZoneName}`, used by the ECS task's Caddy sidecar and the
 * DNS-update Lambda's Route 53 record name): RFC 1123 requires a DNS label to
 * be lowercase alphanumeric with hyphens allowed only between other
 * characters, never leading or trailing.
 *
 * Exported from here (rather than duplicated) so the server-side write path
 * (`DeploymentConfigService.assertValidGameName`, `@hyveon/desktop-main`) and the web
 * wizard's client-side validation (`checkName`, `wizard-form.utils.ts`) can
 * never drift out of sync the way they briefly did — mirrors the same
 * single-source-of-truth pattern {@link checkConnectMessagePlaceholders}
 * already establishes for `connect_message` placeholder validation.
 *
 * The 32-character cap leaves headroom under the tightest fixed downstream
 * budget — the Lambda function name / IAM role name limit (64 characters)
 * shared by the `${projectName}-efs-seeder-<game>[-policy]` naming scheme
 * (`app/packages/infra/src/lambdas.ts`, `iam.ts`) — for any reasonable
 * `projectName`; neither call site has access to the configured
 * `projectName` to compute an exact per-deployment budget, so 32 is a
 * deliberately conservative fixed constant rather than a tight bound.
 *
 * Only enforced when *creating* a brand-new name — an already-declared
 * game's name is immutable (renaming is a delete+recreate) and must never be
 * re-validated against this pattern on read/update/delete, so a legacy name
 * that predates this rule (e.g. an HCL-era name containing an underscore)
 * keeps working indefinitely.
 */
export const GAME_NAME_PATTERN = /^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$/;

/** Human-readable description of {@link GAME_NAME_PATTERN}, reused verbatim in both the server-side and client-side validation-issue messages so the two never phrase the same rule differently. */
export const GAME_NAME_PATTERN_DESCRIPTION =
  'a lowercase alphanumeric DNS-safe label (letters, digits, and internal hyphens only, 1-32 characters, no leading/trailing hyphen)';

/** Zod schema mirroring {@link GameServerPort}. */
export const gameServerPortSchema = z.object({
  container: z.number(),
  protocol: z.string(),
  visibility: z.enum(['public', 'internal']).optional(),
});

/** Zod schema mirroring `GameServerEnvironmentVariable`. */
export const gameServerEnvironmentVariableSchema = z.object({
  name: z.string(),
  value: z.string(),
});

/**
 * Zod schema mirroring `GameServerVolume`. `name` and `container_path` must
 * be non-empty, matching the requirement the app's original validation
 * block on `game_servers` used to enforce.
 */
export const gameServerVolumeSchema = z.object({
  name: z.string().min(1, 'volumes[].name must not be empty.'),
  container_path: z.string().min(1, 'volumes[].container_path must not be empty.'),
});

/** Zod schema mirroring `GameServerFileSeed`. */
export const gameServerFileSeedSchema = z.object({
  path: z.string(),
  content: z.string().optional(),
  content_base64: z.string().optional(),
  mode: z.string().optional(),
});

/** Matches a Secrets Manager secret ARN, e.g. `arn:aws:secretsmanager:us-east-1:123456789012:secret:foo-AbCdEf`. */
const SECRET_ARN_PATTERN = /^arn:aws:secretsmanager:[a-z0-9-]+:\d{12}:secret:.+$/;

/**
 * Matches a header value that looks like it embeds a credential directly —
 * a bearer token, a basic-auth pair, or a long opaque API-key-shaped string
 * — rather than a plain non-sensitive value. Declared headers are for
 * non-sensitive values only; a credential must be expressed through
 * `auth.secretArn` instead.
 */
const CREDENTIAL_LIKE_HEADER_VALUE_PATTERN = /^(bearer\s+\S+|basic\s+[a-z0-9+/=]{8,}|[a-z0-9._-]{20,})$/i;

/** Matches a JSONPath restricted to plain field access and numeric array indices — no wildcards, filters, slices, or recursive descent. */
const HEALTH_CHECK_JSON_PATH_PATTERN = /^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+|\[\d+\])*$/;

/** Zod schema mirroring `GameServerHealthCheckAuth` — the persisted shape, always carrying a `secretArn` regardless of `type`. */
export const gameServerHealthCheckAuthSchema = z.object({
  type: z.enum(['raw', 'basic', 'bearer']).optional(),
  secretArn: z
    .string()
    .regex(
      SECRET_ARN_PATTERN,
      'healthCheck.auth.secretArn must be a Secrets Manager secret ARN (arn:aws:secretsmanager:<region>:<account>:secret:<name>).',
    ),
});

/**
 * Operator-submitted shape of a health-check credential, as it travels over
 * the `games.create`/`games.update` IPC channels before the write path
 * resolves a persisted `secretArn` — see `GameServerHealthCheckAuthWriteInput`'s
 * doc comment for the full write-time contract.
 */
export const gameServerHealthCheckAuthInputSchema = z
  .object({
    type: z.enum(['raw', 'basic', 'bearer']).optional(),
    secretArn: z.string().optional(),
    username: z.string().optional(),
    password: z.string().optional(),
    token: z.string().optional(),
  })
  .superRefine((auth, ctx) => {
    const type = auth.type ?? 'raw';
    if (type === 'basic') {
      if (!auth.username) {
        ctx.addIssue({ code: 'custom', message: 'healthCheck.auth.username is required for type "basic".', path: ['username'] });
      }
      if (!auth.password) {
        ctx.addIssue({ code: 'custom', message: 'healthCheck.auth.password is required for type "basic".', path: ['password'] });
      }
      return;
    }
    if (type === 'bearer') {
      if (!auth.token) {
        ctx.addIssue({ code: 'custom', message: 'healthCheck.auth.token is required for type "bearer".', path: ['token'] });
      }
      return;
    }
    if (!auth.secretArn) {
      ctx.addIssue({
        code: 'custom',
        message: 'healthCheck.auth.secretArn is required for type "raw" (or no declared type).',
        path: ['secretArn'],
      });
      return;
    }
    if (!SECRET_ARN_PATTERN.test(auth.secretArn)) {
      ctx.addIssue({
        code: 'custom',
        message: 'healthCheck.auth.secretArn must be a Secrets Manager secret ARN (arn:aws:secretsmanager:<region>:<account>:secret:<name>).',
        path: ['secretArn'],
      });
    }
  });

/**
 * Operator-submitted shape of a health-check credential — the type
 * {@link gameServerHealthCheckAuthInputSchema} validates. Distinct from the
 * persisted {@link GameServerHealthCheckAuth} (imported from
 * `./gameServerConfig.js`) in `@hyveon/shared`'s `gameServerConfig.ts`:
 * `secretArn` is only ever present here for `type: 'raw'` (the operator's
 * own pre-existing ARN); `basic`/`bearer` instead carry plaintext
 * (`username`/`password`, or `token`) that the write path consumes once to
 * create or update an app-owned secret, never persisting the plaintext
 * itself.
 */
export interface GameServerHealthCheckAuthWriteInput {
  type?: 'raw' | 'basic' | 'bearer';
  secretArn?: string;
  username?: string;
  password?: string;
  token?: string;
}

/**
 * Validates the per-type plaintext requirements of an operator-submitted
 * health-check credential: `basic` requires both `username` and `password`;
 * `bearer` requires a `token`; `raw` (or no declared `type`) requires a
 * `secretArn`. Returns no issues for `undefined` or `null` — both are valid
 * "no credential change" states on the write path (see
 * `GameServerHealthCheckAuthWriteInput`'s doc and `gamesWrite.ts`'s
 * `null`-means-clear / `undefined`-means-unchanged convention).
 *
 * Reused by both the wizard's client-side per-step validation
 * (`@hyveon/web`'s `wizard-form.utils.ts`) and `GamesWriteService`'s
 * server-side check, so the two can never phrase this rule differently.
 *
 * @param auth - The candidate write-input value, typically untrusted (e.g.
 *   parsed JSON from an IPC payload).
 * @returns Every validation issue found, each pathed under `healthCheck.auth`.
 */
export function validateHealthCheckAuthInput(auth: unknown): GameServerValidationIssue[] {
  if (auth === undefined || auth === null) {
    return [];
  }
  const result = gameServerHealthCheckAuthInputSchema.safeParse(auth);
  if (result.success) {
    return [];
  }
  return result.error.issues.map((issue) => ({
    path: issue.path.length > 0 ? `healthCheck.auth.${formatPath(issue.path)}` : 'healthCheck.auth',
    message: issue.message,
  }));
}

/** Zod schema mirroring `GameServerHealthCheckCondition`. */
export const gameServerHealthCheckConditionSchema = z.object({
  jsonPath: z
    .string()
    .regex(
      HEALTH_CHECK_JSON_PATH_PATTERN,
      'healthCheck.activeWhen.jsonPath must be a plain field-access JSONPath (e.g. "players.online"), with only field names and numeric array indices.',
    ),
  operator: z.enum(['equals', 'notEquals', 'greaterThan', 'lessThan', 'contains', 'exists']),
  value: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
});

/**
 * Zod schema mirroring `GameServerHealthCheck`. Structural only — the
 * cross-field rules (declared port must be among the entry's own `ports`;
 * every operator except `exists` requires a `value`) live in
 * {@link checkHealthCheckRules} instead, since they need sibling fields of
 * the same entry that a single-field schema can't see.
 */
export const gameServerHealthCheckSchema = z.object({
  kind: z.literal('http'),
  scheme: z.enum(['http', 'https']),
  port: z.number(),
  path: z
    .string()
    .min(1, 'healthCheck.path must not be empty.')
    .refine((path) => path.startsWith('/'), 'healthCheck.path must be an absolute path (start with "/").'),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'HEAD']),
  headers: z
    .record(z.string(), z.string())
    .optional()
    .superRefine((headers, ctx) => {
      if (!headers) {
        return;
      }
      for (const [key, value] of Object.entries(headers)) {
        if (key.toLowerCase() === 'authorization' || CREDENTIAL_LIKE_HEADER_VALUE_PATTERN.test(value)) {
          ctx.addIssue({
            code: 'custom',
            message: `healthCheck.headers.${key} looks like it embeds a credential directly; use healthCheck.auth.secretArn instead.`,
            path: [key],
          });
        }
      }
    }),
  auth: gameServerHealthCheckAuthSchema.optional(),
  timeoutMs: z
    .number()
    .int('healthCheck.timeoutMs must be an integer.')
    .min(100, 'healthCheck.timeoutMs must be between 100 and 10000 milliseconds inclusive.')
    .max(10000, 'healthCheck.timeoutMs must be between 100 and 10000 milliseconds inclusive.'),
  activeWhen: gameServerHealthCheckConditionSchema,
});

/**
 * Zod schema mirroring {@link GameServer} field-for-field, minus `name`
 * (which is the `game_servers` map key, not an attribute of the app's
 * original config-input object —
 * see {@link GameServer}'s own doc comment). Enforces only structural/shape
 * rules; the four business rules (Fargate CPU/memory pairing, absolute
 * paths, connect-message placeholders, port collisions) live in
 * {@link validateGameServer} instead, since some of them need sibling
 * `game_servers` entries that a single-entry schema can't see.
 */
export const gameServerSchema = z.object({
  image: z.string(),
  cpu: z.number(),
  memory: z.number(),
  ports: z.array(gameServerPortSchema),
  environment: z.array(gameServerEnvironmentVariableSchema).optional(),
  volumes: z
    .array(gameServerVolumeSchema)
    .min(1, 'Each game server must have at least one volume entry with non-empty name and container_path.'),
  https: z.boolean().optional(),
  connect_message: z.string().optional(),
  file_seeds: z.array(gameServerFileSeedSchema).optional(),
  healthCheck: gameServerHealthCheckSchema.optional(),
});

/** Structural (name-less) shape validated by {@link gameServerSchema}. */
export type GameServerEntryInput = z.infer<typeof gameServerSchema>;

/**
 * A single validation failure, positioned with a JSON-path-like string
 * (e.g. `volumes[0].container_path`, `ports[1]`, `memory`) so callers can
 * highlight the offending field in a form. Built either from a zod issue's
 * `path` array or from one of the custom business-rule checks below.
 */
export interface GameServerValidationIssue {
  path: string;
  message: string;
}

/** Result of {@link validateGameServer}: either the fully-typed entry, or every issue found. */
export type GameServerValidationResult =
  | { success: true; data: GameServer }
  | { success: false; issues: GameServerValidationIssue[] };

/**
 * Joins a zod issue path into a JSON-path-like string, e.g.
 * `['volumes', 0, 'container_path']` → `volumes[0].container_path`.
 *
 * Zod 4 widened `ZodIssue['path']` from `(string | number)[]` to
 * `PropertyKey[]`, so symbol segments are now possible in principle. None of
 * the schemas in this file key off symbols, but the signature accepts them and
 * renders them via `String()` so a stray symbol degrades to a readable path
 * instead of a type error.
 */
function formatPath(path: readonly PropertyKey[]): string {
  return path.reduce<string>((acc, segment) => {
    if (typeof segment === 'number') {
      return `${acc}[${segment}]`;
    }
    const key = String(segment);
    return acc.length > 0 ? `${acc}.${key}` : key;
  }, '');
}

/** Converts a raw zod issue into a {@link GameServerValidationIssue}. */
function zodIssueToValidationIssue(issue: z.core.$ZodIssue): GameServerValidationIssue {
  return { path: formatPath(issue.path), message: issue.message };
}

/**
 * The current Fargate CPU → valid memory (MiB) table. `256` only accepts
 * three discrete values; every other tier accepts a stepped range. Source:
 * AWS Fargate task size documentation, mirrored here so a proposed
 * `game_servers` edit is rejected client-side before a Pulumi apply would
 * fail.
 */
const FARGATE_CPU_MEMORY_TABLE: Readonly<
  Record<number, { values: number[] } | { min: number; max: number; step: number }>
> = {
  256: { values: [512, 1024, 2048] },
  512: { min: 1024, max: 4096, step: 1024 },
  1024: { min: 2048, max: 8192, step: 1024 },
  2048: { min: 4096, max: 16384, step: 1024 },
  4096: { min: 8192, max: 30720, step: 1024 },
  8192: { min: 16384, max: 61440, step: 4096 },
  16384: { min: 32768, max: 122880, step: 8192 },
};

/**
 * Every Fargate CPU unit accepted by {@link FARGATE_CPU_MEMORY_TABLE}, ascending
 * (e.g. `256, 512, 1024, ...`). Intended for populating a "cpu" dropdown in a
 * game-creation form so the UI never drifts from the validator's own table.
 */
export function getFargateCpuOptions(): number[] {
  return Object.keys(FARGATE_CPU_MEMORY_TABLE)
    .map(Number)
    .sort((a, b) => a - b);
}

/**
 * Every valid Fargate memory (MiB) value for a given `cpu` tier, expanded
 * from {@link FARGATE_CPU_MEMORY_TABLE} — the discrete `values` list as-is
 * for `cpu=256`, or every step from `min` to `max` (inclusive) for the
 * ranged tiers. Returns `[]` if `cpu` isn't one of {@link getFargateCpuOptions}.
 */
export function getFargateMemoryOptions(cpu: number): number[] {
  const range = FARGATE_CPU_MEMORY_TABLE[cpu];
  if (!range) {
    return [];
  }
  if ('values' in range) {
    return [...range.values];
  }
  const options: number[] = [];
  for (let memory = range.min; memory <= range.max; memory += range.step) {
    options.push(memory);
  }
  return options;
}

/**
 * Fargate on-demand price per vCPU-hour (us-east-1). `@hyveon/cloud-aws`
 * re-exports this single copy (via `AwsCloudProvider.ts`) instead of
 * declaring its own — keep every call site in sync by only ever editing the
 * value here.
 */
export const FARGATE_VCPU_PER_HOUR = 0.04048;

/** Fargate on-demand price per GB-hour (us-east-1), see {@link FARGATE_VCPU_PER_HOUR}. */
export const FARGATE_GB_PER_HOUR = 0.004445;

/**
 * Projected hourly Fargate cost for a `cpu`/`memory` pairing, in USD.
 *
 * Pure arithmetic, safe to call on every UI event (e.g. a slider drag) with
 * no debounce. Uses the same formula and rounding as
 * `CostService.estimateForSpec`'s `costPerHour` field, so the wizard's live
 * estimate and the Costs page's per-game table never disagree for the same
 * (cpu, memory) pair.
 *
 * @param cpu - Fargate CPU units (1024 = 1 vCPU).
 * @param memory - Task memory in MiB.
 * @returns The estimated hourly cost in USD, rounded to at most 4 decimal places.
 */
export function estimateFargateHourlyCost(cpu: number, memory: number): number {
  const vcpu = cpu / 1024;
  const memoryGb = memory / 1024;
  const hourly = vcpu * FARGATE_VCPU_PER_HOUR + memoryGb * FARGATE_GB_PER_HOUR;
  return Math.round(hourly * 10000) / 10000;
}

/** Human-readable description of the valid memory values/range for a given Fargate `cpu` tier. */
function describeFargateMemoryOptions(cpu: number): string {
  const range = FARGATE_CPU_MEMORY_TABLE[cpu];
  if (!range) {
    return '';
  }
  if ('values' in range) {
    return `${range.values.join(', ')} MiB`;
  }
  return `${range.min}-${range.max} MiB in steps of ${range.step}`;
}

/** Validates the `cpu`/`memory` pairing against the Fargate task-size table. */
function checkFargateCpuMemoryPairing(entry: GameServerEntryInput): GameServerValidationIssue[] {
  const range = FARGATE_CPU_MEMORY_TABLE[entry.cpu];
  if (!range) {
    return [
      {
        path: 'cpu',
        message: `cpu must be one of the supported Fargate CPU units (${Object.keys(FARGATE_CPU_MEMORY_TABLE).join(', ')}), got ${entry.cpu}.`,
      },
    ];
  }

  const isValidMemory =
    'values' in range
      ? range.values.includes(entry.memory)
      : entry.memory >= range.min && entry.memory <= range.max && (entry.memory - range.min) % range.step === 0;

  if (!isValidMemory) {
    return [
      {
        path: 'memory',
        message: `memory ${entry.memory} MiB is not a valid Fargate pairing for cpu=${entry.cpu}; must be ${describeFargateMemoryOptions(entry.cpu)}.`,
      },
    ];
  }

  return [];
}

/** Validates that `volumes[].container_path` and `file_seeds[].path` are absolute (start with `/`). */
function checkAbsolutePaths(entry: GameServerEntryInput): GameServerValidationIssue[] {
  const issues: GameServerValidationIssue[] = [];

  entry.volumes.forEach((volume, index) => {
    if (!volume.container_path.startsWith('/')) {
      issues.push({
        path: `volumes[${index}].container_path`,
        message: `volumes[${index}].container_path must be an absolute path (start with "/"), got "${volume.container_path}".`,
      });
    }
  });

  entry.file_seeds?.forEach((seed, index) => {
    if (!seed.path.startsWith('/')) {
      issues.push({
        path: `file_seeds[${index}].path`,
        message: `file_seeds[${index}].path must be an absolute path (start with "/"), got "${seed.path}".`,
      });
    }
  });

  return issues;
}

/**
 * Validates `environment[].name`: rejects an empty name, and rejects a name
 * that duplicates an earlier row's name within the same entry. No
 * constraint is placed on `value`, or on `name`'s character set/casing —
 * container images vary too much to assume a universal naming convention.
 */
function checkEnvironmentVariables(entry: GameServerEntryInput): GameServerValidationIssue[] {
  const issues: GameServerValidationIssue[] = [];
  const seenNames = new Set<string>();

  entry.environment?.forEach((variable, index) => {
    if (variable.name.length === 0) {
      issues.push({
        path: `environment[${index}].name`,
        message: `environment[${index}].name must not be empty.`,
      });
      return;
    }

    if (seenNames.has(variable.name)) {
      issues.push({
        path: `environment[${index}].name`,
        message: `environment[${index}].name "${variable.name}" duplicates an earlier environment variable in the same entry.`,
      });
      return;
    }

    seenNames.add(variable.name);
  });

  return issues;
}

/** Placeholder tokens allowed inside `connect_message`, matching the app's original config input's doc comment. */
export const ALLOWED_CONNECT_MESSAGE_PLACEHOLDERS: ReadonlySet<string> = new Set(['host', 'ip', 'port', 'game']);

/** Matches every `{token}` occurrence in a string, capturing the token itself. */
export const PLACEHOLDER_TOKEN_PATTERN = /\{([^{}]*)\}/g;

/**
 * Rejects any `{token}` in `connectMessage` outside `{host}`/`{ip}`/`{port}`/`{game}`.
 * Exported (and taking a bare string rather than a full {@link GameServerEntryInput})
 * so callers that need to run this rule independently of the rest of
 * {@link validateGameServer} — e.g. the add-game wizard's per-step validation in
 * `@hyveon/web`, which must surface a bad placeholder before `cpu`/`memory`/`volumes`
 * are filled in and so can't wait for a full structural parse to succeed — reuse this
 * exact rule and message instead of hand-duplicating it.
 */
export function checkConnectMessagePlaceholders(connectMessage: string | undefined): GameServerValidationIssue[] {
  if (!connectMessage) {
    return [];
  }

  const issues: GameServerValidationIssue[] = [];
  for (const match of connectMessage.matchAll(PLACEHOLDER_TOKEN_PATTERN)) {
    const token = match[1] ?? '';
    if (!ALLOWED_CONNECT_MESSAGE_PLACEHOLDERS.has(token)) {
      issues.push({
        path: 'connect_message',
        message: `Unknown placeholder "{${token}}" in connect_message; allowed placeholders are {host}, {ip}, {port}, {game}.`,
      });
    }
  }
  return issues;
}

/** Builds the collision key (`container/protocol`, case-insensitive on protocol) used to detect port clashes. */
function portKey(port: GameServerPort): string {
  return `${port.container}/${port.protocol.toLowerCase()}`;
}

/** `visibility` with the `undefined ≡ 'public'` contract applied (see {@link GameServerPort.visibility}). */
function effectivePortVisibility(visibility: GameServerPort['visibility']): 'public' | 'internal' {
  return visibility ?? 'public';
}

/**
 * Detects container-port collisions both within the proposed entry's own
 * `ports` list and against every other declared `game_servers` entry (the
 * entry being re-validated, identified by `name`, is skipped so editing an
 * already-declared game doesn't collide with itself).
 *
 * `icmp` pairs are exempt from the cross-game branch of this rule: the same
 * `(container, protocol)` icmp pair is allowed on multiple games as long as
 * every declaration shares the same effective visibility, since the shared
 * security group dedupes identical icmp rules into one (see
 * `defineSecurityGroups`, `@hyveon/infra`). A visibility mismatch is still
 * rejected, naming both games. The same-game duplicate rule above (within
 * `ports` of a single entry) is unaffected and still rejects a repeated
 * icmp pair.
 */
function checkPortCollisions(
  name: string,
  ports: GameServerPort[],
  existingGameServers: GameServer[],
): GameServerValidationIssue[] {
  const issues: GameServerValidationIssue[] = [];
  const seenWithinEntry = new Map<string, number>();

  ports.forEach((port, index) => {
    const key = portKey(port);
    const isIcmp = port.protocol.toLowerCase() === 'icmp';

    const firstIndex = seenWithinEntry.get(key);
    if (firstIndex !== undefined) {
      issues.push({
        path: `ports[${index}]`,
        message: `Port ${port.container}/${port.protocol} collides with ports[${firstIndex}] in the same game server.`,
      });
    } else {
      seenWithinEntry.set(key, index);
    }

    for (const existing of existingGameServers) {
      if (existing.name === name) {
        continue;
      }
      const existingPort = existing.ports.find((candidate) => portKey(candidate) === key);
      if (existingPort === undefined) {
        continue;
      }

      if (isIcmp) {
        const existingVisibility = effectivePortVisibility(existingPort.visibility);
        const proposedVisibility = effectivePortVisibility(port.visibility);
        if (existingVisibility !== proposedVisibility) {
          issues.push({
            path: `ports[${index}]`,
            message: `Port ${port.container}/icmp on game "${name}" conflicts with existing game "${existing.name}": effective visibility must match across games for icmp entries (one is "${existingVisibility}", the other "${proposedVisibility}").`,
          });
        }
        continue;
      }

      issues.push({
        path: `ports[${index}]`,
        message: `Port ${port.container}/${port.protocol} collides with existing game "${existing.name}".`,
      });
    }
  });

  return issues;
}

/** Narrows `value` to a plain object so `proposed.ports` can be read without a full parse. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Mirrors the `game_servers` variable validation block that used to live in
 * the app's now-retired original config input and gated on `cfg.https`: a
 * game with `https = true` must declare at least one port, its first port
 * must use protocol `tcp` (exact, lowercase), every port protocol must be
 * `tcp` or `udp`, and no port may use container port 80 or 443 (reserved for
 * the in-task Caddy sidecar). This function is now the sole source of truth
 * for these rules — there is no other declared config input left to stay in sync with.
 *
 * Only needs `ports` to be structurally valid — like {@link checkPortCollisions},
 * it's called independently of whether the rest of the entry parses, so a
 * structurally incomplete draft (e.g. the add-game wizard's Networking step,
 * reached before Storage supplies `volumes`) still gets HTTPS feedback rather
 * than silently skipping every business rule because `gameServerSchema` failed
 * on an unrelated field.
 */
function checkHttpsPortRules(ports: GameServerPort[]): GameServerValidationIssue[] {
  const issues: GameServerValidationIssue[] = [];

  if (ports.length === 0) {
    issues.push({
      path: 'ports',
      message: 'An https = true game server must declare at least one port.',
    });
    return issues;
  }

  if (ports[0]?.protocol !== 'tcp') {
    issues.push({
      path: 'ports[0]',
      message: 'The first port entry of an https = true game server must use protocol "tcp" (exact, lowercase).',
    });
  }

  ports.forEach((port, index) => {
    if (port.protocol !== 'tcp' && port.protocol !== 'udp') {
      issues.push({
        path: `ports[${index}]`,
        message: `ports[${index}].protocol must be "tcp" or "udp" for an https = true game server, got "${port.protocol}".`,
      });
    }
    if (port.container === 80 || port.container === 443) {
      issues.push({
        path: `ports[${index}]`,
        message: `ports[${index}] uses container port ${port.container}, which is reserved for the Caddy sidecar on an https = true game server.`,
      });
    }
  });

  return issues;
}

/**
 * `true` when `value` is a valid ICMP type: an integer between 0 and 255
 * inclusive.
 *
 * Exported (rather than left private to {@link checkIcmpPortRules}) so the
 * add-game wizard's client-side per-row range check (`checkIcmpPortType`,
 * `@hyveon/web`'s `wizard-form.utils.ts`) can reuse this exact rule instead
 * of hand-duplicating it — mirrors the same single-source-of-truth pattern
 * {@link GAME_NAME_PATTERN} already establishes for name validation.
 */
export function isValidIcmpType(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 255;
}

/**
 * Validates `icmp` port entries for a non-HTTPS game server: `container` is
 * the ICMP type (not a port number) and must be an integer between 0 and 255
 * inclusive ({@link isValidIcmpType}). HTTPS games never reach this check —
 * {@link checkHttpsPortRules} already rejects any `icmp` entry there via its
 * tcp/udp-only rule.
 *
 * Matches `protocol` case-insensitively, like {@link portKey}, so a
 * hand-edited `deployment-config.json` entry with `protocol: 'ICMP'` still
 * gets the type-range check rather than silently skipping it.
 */
function checkIcmpPortRules(ports: GameServerPort[]): GameServerValidationIssue[] {
  const issues: GameServerValidationIssue[] = [];

  ports.forEach((port, index) => {
    if (port.protocol.toLowerCase() === 'icmp' && !isValidIcmpType(port.container)) {
      issues.push({
        path: `ports[${index}].container`,
        message: `ports[${index}].container is the ICMP type when protocol is "icmp" and must be an integer between 0 and 255, got ${port.container}.`,
      });
    }
  });

  return issues;
}

/** `true` for container port 443 or 80 on protocol `tcp` (case-insensitively, like {@link portKey}) — the Caddy sidecar's fixed, unconditional ingress. `443/udp`/`80/udp` never collide with it, since Caddy only ever binds `tcp`. */
function isCaddyReservedPort(port: GameServerPort): boolean {
  return (port.container === 443 || port.container === 80) && port.protocol.toLowerCase() === 'tcp';
}

/**
 * Rejects container port 443 or 80 on protocol `tcp` for ANY game — https or
 * not — when at least one game in the whole deployment has `https: true`.
 * This is the cross-deployment counterpart to {@link checkHttpsPortRules}:
 * that function only reserves 80/443 within the `ports` array of the game
 * that itself declares `https: true`, so a *different*, non-HTTPS game was
 * previously free to declare
 * `{ container: 443, protocol: 'tcp', visibility: 'internal' }` in its own
 * entry. Since security-group ingress rules union, that internal-only
 * rule then sat alongside the Caddy sidecar's unconditional `0.0.0.0/0`
 * ingress on the same port (`defineSecurityGroups`,
 * `@hyveon/infra`'s `securityGroups.ts`) and the port was reachable from the
 * internet regardless of its declared `visibility` — this function closes
 * that gap by reserving 443/80/tcp deployment-wide whenever any HTTPS game
 * exists, matching the spec's "internal port unreachable from the internet"
 * guarantee.
 *
 * Two directions are both covered, so the write that introduces the
 * deployment-wide reservation can't be bypassed by declaring the port first
 * and enabling HTTPS on a different game second:
 *  - `!isHttps` — the proposed entry declares 80/443/tcp while some *other*,
 *    already-declared game has `https: true`: rejected against the proposed
 *    entry's own `ports`, anchored on `ports[i]`.
 *  - `isHttps` — the proposed entry is the one turning `https: true` on.
 *    {@link checkHttpsPortRules} already rejects 80/443 within its own
 *    `ports` (so checking the proposed entry's own ports again here would
 *    just duplicate that issue under different wording); instead this scans
 *    every *other* already-declared game's `ports` and rejects the write if
 *    any of them already holds 443/80/tcp — the direction the original,
 *    single-pass version of this function missed. The offending port
 *    belongs to a different game than the one being written, so the issue
 *    is anchored on `path: 'ports'` rather than a specific index.
 *
 * @param name - The `game_servers` map key the proposed entry would be saved
 *   under; excluded from the sibling scan so editing an already-`https` game
 *   in place doesn't flag itself.
 * @param ports - The proposed entry's structurally-valid `ports` list.
 * @param isHttps - Whether the proposed entry itself declares `https: true`.
 * @param existingGameServers - Every other already-declared `game_servers`
 *   entry.
 * @returns One issue per offending port, in either direction described above.
 */
function checkReservedHttpsPortsAcrossDeployment(
  name: string,
  ports: GameServerPort[],
  isHttps: boolean,
  existingGameServers: GameServer[],
): GameServerValidationIssue[] {
  if (isHttps) {
    const issues: GameServerValidationIssue[] = [];
    for (const existing of existingGameServers) {
      if (existing.name === name) {
        continue;
      }
      for (const port of existing.ports) {
        if (isCaddyReservedPort(port)) {
          issues.push({
            path: 'ports',
            message: `Cannot enable https: game "${existing.name}" already declares port ${port.container}/${port.protocol}, which becomes reserved for the Caddy sidecar once any game is https. Free that port on "${existing.name}" first.`,
          });
        }
      }
    }
    return issues;
  }

  const reservingGameName = existingGameServers.find(
    (existing) => existing.name !== name && existing.https === true,
  )?.name;
  if (reservingGameName === undefined) {
    return [];
  }

  const issues: GameServerValidationIssue[] = [];
  ports.forEach((port, index) => {
    if (isCaddyReservedPort(port)) {
      issues.push({
        path: `ports[${index}]`,
        message: `Port ${port.container}/${port.protocol} is reserved for the Caddy sidecar because game "${reservingGameName}" has https enabled.`,
      });
    }
  });

  return issues;
}

/**
 * Validates the cross-field business rules for a declared `healthCheck` that
 * the structural schema ({@link gameServerHealthCheckSchema}) can't express:
 * the declared port must be one of the entry's own `ports`, and every
 * comparison operator except `exists` requires a `value` to compare
 * against. A no-op when `healthCheck` is absent.
 */
function checkHealthCheckRules(entry: GameServerEntryInput): GameServerValidationIssue[] {
  const healthCheck = entry.healthCheck;
  if (!healthCheck) {
    return [];
  }

  const issues: GameServerValidationIssue[] = [];

  if (!entry.ports.some((port) => port.container === healthCheck.port && port.protocol === 'tcp')) {
    issues.push({
      path: 'healthCheck.port',
      message: `healthCheck.port ${healthCheck.port} is not among this game server's declared tcp ports.`,
    });
  }

  const { operator, value } = healthCheck.activeWhen;
  if (operator === 'exists') {
    if (value !== undefined) {
      issues.push({
        path: 'healthCheck.activeWhen.value',
        message: `healthCheck.activeWhen.value must not be set for operator "exists"; it takes no value.`,
      });
    }
  } else if (value === undefined) {
    issues.push({
      path: 'healthCheck.activeWhen.value',
      message: `healthCheck.activeWhen.value is required for operator "${operator}"; only "exists" takes none.`,
    });
  } else if ((operator === 'greaterThan' || operator === 'lessThan') && typeof value !== 'number') {
    issues.push({
      path: 'healthCheck.activeWhen.value',
      message: `healthCheck.activeWhen.value must be a number for operator "${operator}".`,
    });
  } else if (operator === 'contains' && typeof value !== 'string') {
    issues.push({
      path: 'healthCheck.activeWhen.value',
      message: `healthCheck.activeWhen.value must be a string for operator "contains".`,
    });
  }

  return issues;
}

/**
 * Validates a proposed `game_servers` entry: structural shape (via
 * {@link gameServerSchema}) plus the business rules — Fargate CPU/memory
 * pairing, absolute paths for volumes/file_seeds, connect-message placeholder
 * allowlisting, HTTPS port constraints (only when `https === true`),
 * container-port collisions (within the entry itself and against every
 * other entry in `existingGameServers`), the ICMP-type range for `icmp`
 * ports on non-HTTPS games ({@link checkIcmpPortRules}), and the
 * deployment-wide 443/80/tcp reservation
 * ({@link checkReservedHttpsPortsAcrossDeployment}) that applies to every
 * game, https or not, whenever any game in the deployment has `https: true`.
 *
 * @param name - The `game_servers` map key this entry would be saved under.
 *   Used to build the returned {@link GameServer} on success, and to skip
 *   self-collisions when `existingGameServers` already contains an entry
 *   being edited in place.
 * @param proposed - The candidate entry, typically untrusted input (e.g.
 *   parsed JSON from an API request body).
 * @param existingGameServers - Every other already-declared `game_servers`
 *   entry (as returned by `DeploymentConfigService.getGameServers()`), used for the
 *   cross-game port-collision check.
 */
export function validateGameServer(
  name: string,
  proposed: unknown,
  existingGameServers: GameServer[],
): GameServerValidationResult {
  const issues: GameServerValidationIssue[] = [];

  const parsed = gameServerSchema.safeParse(proposed);
  if (!parsed.success) {
    issues.push(...parsed.error.issues.map(zodIssueToValidationIssue));
  } else {
    issues.push(...checkFargateCpuMemoryPairing(parsed.data));
    issues.push(...checkAbsolutePaths(parsed.data));
    issues.push(...checkEnvironmentVariables(parsed.data));
    issues.push(...checkConnectMessagePlaceholders(parsed.data.connect_message));
    issues.push(...checkHealthCheckRules(parsed.data));
  }

  // Port-collision and HTTPS-rule detection only need `ports` (and, for
  // HTTPS, the `https` flag) to be structurally valid, so both run
  // independently of whether the rest of the entry parsed cleanly — a
  // structurally incomplete draft (e.g. missing `volumes`) must not
  // silently swallow HTTPS feedback.
  const portsResult = z
    .array(gameServerPortSchema)
    .safeParse(isRecord(proposed) ? proposed['ports'] : undefined);
  if (portsResult.success) {
    issues.push(...checkPortCollisions(name, portsResult.data, existingGameServers));
    const isHttps = isRecord(proposed) && proposed['https'] === true;
    if (isHttps) {
      issues.push(...checkHttpsPortRules(portsResult.data));
    } else {
      issues.push(...checkIcmpPortRules(portsResult.data));
    }
    issues.push(...checkReservedHttpsPortsAcrossDeployment(name, portsResult.data, isHttps, existingGameServers));
  }

  if (issues.length > 0) {
    return { success: false, issues };
  }

  // `parsed.success` is guaranteed true here: any structural failure above
  // would have pushed at least one issue and returned early.
  return { success: true, data: { name, ...(parsed as z.ZodSafeParseSuccess<GameServerEntryInput>).data } };
}
