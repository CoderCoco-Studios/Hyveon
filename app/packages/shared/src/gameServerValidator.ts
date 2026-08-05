/**
 * Zod-backed structural schema + business-rule validator for a single
 * `game_servers` map entry (historically `terraform/variables.tf:game_servers`;
 * see the {@link GameServer} mirror in `./gameServerConfig.js`).
 *
 * This module is deliberately split in two:
 *  - {@link gameServerSchema} mirrors the former Terraform `game_servers`
 *    object type field-for-field (it does NOT include `name` — like that
 *    Terraform object, `name` is the map key, not an attribute of the entry).
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
});

/** Zod schema mirroring `GameServerEnvironmentVariable`. */
export const gameServerEnvironmentVariableSchema = z.object({
  name: z.string(),
  value: z.string(),
});

/**
 * Zod schema mirroring `GameServerVolume`. `name` and `container_path` must
 * be non-empty, matching the requirement the former Terraform validation
 * block on `game_servers` (`terraform/variables.tf`) used to enforce.
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

/**
 * Zod schema mirroring {@link GameServer} field-for-field, minus `name`
 * (which is the `game_servers` map key, not a Terraform object attribute —
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

/** Placeholder tokens allowed inside `connect_message`, matching the former Terraform variable's doc comment. */
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

/**
 * Detects container-port collisions both within the proposed entry's own
 * `ports` list and against every other declared `game_servers` entry (the
 * entry being re-validated, identified by `name`, is skipped so editing an
 * already-declared game doesn't collide with itself).
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
      if (existing.ports.some((existingPort) => portKey(existingPort) === key)) {
        issues.push({
          path: `ports[${index}]`,
          message: `Port ${port.container}/${port.protocol} collides with existing game "${existing.name}".`,
        });
      }
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
 * the now-retired `terraform/aws/variables.tf` and gated on `cfg.https`: a
 * game with `https = true` must declare at least one port, its first port
 * must use protocol `tcp` (exact, lowercase), every port protocol must be
 * `tcp` or `udp`, and no port may use container port 80 or 443 (reserved for
 * the in-task Caddy sidecar). This function is now the sole source of truth
 * for these rules — there is no Terraform variable left to stay in sync with.
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
 * Validates a proposed `game_servers` entry: structural shape (via
 * {@link gameServerSchema}) plus the business rules — Fargate CPU/memory
 * pairing, absolute paths for volumes/file_seeds, connect-message placeholder
 * allowlisting, HTTPS port constraints (only when `https === true`), and
 * container-port collisions (within the entry itself and against every
 * other entry in `existingGameServers`).
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
    issues.push(...checkConnectMessagePlaceholders(parsed.data.connect_message));
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
    if (isRecord(proposed) && proposed['https'] === true) {
      issues.push(...checkHttpsPortRules(portsResult.data));
    }
  }

  if (issues.length > 0) {
    return { success: false, issues };
  }

  // `parsed.success` is guaranteed true here: any structural failure above
  // would have pushed at least one issue and returned early.
  return { success: true, data: { name, ...(parsed as z.ZodSafeParseSuccess<GameServerEntryInput>).data } };
}
