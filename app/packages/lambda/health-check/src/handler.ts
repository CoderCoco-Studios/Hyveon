/**
 * Health-check Lambda — invoked synchronously by the watchdog for a game
 * that declares a `healthCheck`, in place of the CloudWatch network-packet
 * heuristic. Resolves the checked task's private address from ECS
 * (`DescribeTasks`), never from the declared configuration, so no
 * configuration value can redirect a check at a different host. Fetches the
 * credential from Secrets Manager only when the declaration references one,
 * issues the declared request, and delegates the verdict to the pure
 * evaluation engine.
 *
 * Every transport or credential failure (timeout, refused connection, an
 * unavailable secret) is fail-active, matching the engine's own fail-active
 * behavior for a response-shaped failure — the layer closest to the
 * failure handles it, rather than relying on a lower layer that may never
 * run at all.
 */
import { ECSClient, DescribeTasksCommand, type Task } from '@aws-sdk/client-ecs';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import type { GameServerHealthCheck, GameServerHealthCheckAuth } from '@hyveon/shared';
import { evaluateHealthCheck, type HealthCheckVerdict } from './engine.js';

/** Invocation payload the watchdog sends: the game whose task is being checked, the task's ARN, and its declared health check. */
export interface HealthCheckEvent {
  game: string;
  taskArn: string;
  healthCheck: GameServerHealthCheck;
}

function region(): string {
  return process.env['AWS_REGION_'] ?? process.env['AWS_REGION'] ?? process.env['AWS_DEFAULT_REGION'] ?? 'us-east-1';
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name}`);
  return v;
}

const ECS_CLUSTER = requireEnv('ECS_CLUSTER');
const ecs = new ECSClient({ region: region() });
const secretsManager = new SecretsManagerClient({ region: region() });

/** Structured single-line log, matching the repo-wide convention of never emitting a raw credential or response body. */
function log(level: 'debug' | 'warn', message: string, fields: Record<string, unknown>): void {
  const line = JSON.stringify({ level, message, ...fields });
  if (level === 'warn') {
    console.warn(line);
  } else {
    console.debug(line);
  }
}

/**
 * Resolves a running task's private IPv4 address from its ECS attachment
 * details — the same attachment-walking shape the watchdog's own
 * `getEniId` uses, reading a different detail (`privateIPv4Address` rather
 * than `networkInterfaceId`). This is the sole source of the request's
 * destination host; the declared configuration never supplies one.
 */
function getPrivateIpAddress(task: Task): string | null {
  for (const attachment of task.attachments ?? []) {
    if (attachment.type !== 'ElasticNetworkInterface') {
      continue;
    }
    for (const detail of attachment.details ?? []) {
      if (detail.name === 'privateIPv4Address') {
        return detail.value ?? null;
      }
    }
  }
  return null;
}

async function resolveTaskHost(taskArn: string): Promise<string> {
  const resp = await ecs.send(new DescribeTasksCommand({ cluster: ECS_CLUSTER, tasks: [taskArn] }));
  const task = resp.tasks?.[0];
  if (!task) {
    throw new Error(`ECS task ${taskArn} was not found`);
  }
  const host = getPrivateIpAddress(task);
  if (!host) {
    throw new Error(`No private IPv4 address found for task ${taskArn}`);
  }
  return host;
}

/** Resolves the declared credential's raw secret string, or `undefined` when the health check declares no `auth`. */
async function resolveAuthSecretValue(healthCheck: GameServerHealthCheck): Promise<string | undefined> {
  if (!healthCheck.auth) {
    return undefined;
  }
  const resp = await secretsManager.send(new GetSecretValueCommand({ SecretId: healthCheck.auth.secretArn }));
  if (resp.SecretString === undefined) {
    throw new Error('Secret has no string value');
  }
  return resp.SecretString;
}

/**
 * Builds the `Authorization` header value for a resolved secret, branching
 * on `auth.type` (absent or `'raw'` injects `secretValue` verbatim, no
 * prefix — unchanged from before `type` existed). Throws for a `basic`
 * credential whose secret isn't valid `{ username, password }` JSON — the
 * caller's existing top-level try/catch turns that into the same fail-active
 * verdict as any other resolve failure.
 *
 * @param auth - The health check's credential declaration.
 * @param secretValue - The raw string fetched from Secrets Manager for `auth.secretArn`.
 * @throws When `auth.type === 'basic'` and `secretValue` isn't valid JSON shaped as a username/password object.
 */
function buildAuthorizationHeader(auth: GameServerHealthCheckAuth, secretValue: string): string {
  const type = auth.type ?? 'raw';
  if (type === 'raw') {
    return secretValue;
  }
  if (type === 'bearer') {
    return `Bearer ${secretValue}`;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(secretValue);
  } catch {
    throw new Error('basic credential secret is not valid JSON');
  }
  const record = parsed as Record<string, unknown> | null;
  if (
    typeof record !== 'object' ||
    record === null ||
    typeof record['username'] !== 'string' ||
    typeof record['password'] !== 'string'
  ) {
    throw new Error('basic credential secret is not a { username, password } object');
  }
  const encoded = Buffer.from(`${record['username']}:${record['password']}`, 'utf8').toString('base64');
  return `Basic ${encoded}`;
}

/**
 * Merges the declared headers with the resolved, type-branched credential.
 * The injected `Authorization` header always takes precedence over an
 * operator-supplied one of the same name, so a working credential can't be
 * silently overridden by a stray declared header.
 */
function buildHeaders(healthCheck: GameServerHealthCheck, authorizationValue: string | undefined): Record<string, string> {
  const headers = { ...(healthCheck.headers ?? {}) };
  if (authorizationValue !== undefined) {
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === 'authorization') {
        delete headers[key];
      }
    }
    headers['Authorization'] = authorizationValue;
  }
  return headers;
}

/** Logs a check's verdict at `warn` when it was forced active by a failure, `debug` otherwise. */
function logVerdict(game: string, healthCheck: GameServerHealthCheck, verdict: HealthCheckVerdict): void {
  const fields = { game, kind: healthCheck.kind, active: verdict.active, reason: verdict.reason };
  log(verdict.failureDerived ? 'warn' : 'debug', 'health check verdict', fields);
}

/**
 * Invoked synchronously by the watchdog for a game with a declared health
 * check. Resolves the task's host from ECS, issues the declared request,
 * and returns the verdict — fail-active for any transport, credential, or
 * response-shaped failure.
 */
export const handler = async (event: HealthCheckEvent): Promise<HealthCheckVerdict> => {
  const { game, taskArn, healthCheck } = event;
  log('debug', 'health check invoked', { game, kind: healthCheck.kind, port: healthCheck.port });

  try {
    const [host, secretValue] = await Promise.all([resolveTaskHost(taskArn), resolveAuthSecretValue(healthCheck)]);
    const authorizationValue =
      secretValue !== undefined && healthCheck.auth ? buildAuthorizationHeader(healthCheck.auth, secretValue) : undefined;
    const headers = buildHeaders(healthCheck, authorizationValue);
    const url = `${healthCheck.scheme}://${host}:${healthCheck.port}${healthCheck.path}`;

    const response = await fetch(url, {
      method: healthCheck.method,
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(healthCheck.timeoutMs),
    });
    const rawBody = await response.text();

    const verdict = evaluateHealthCheck(healthCheck, response.status, rawBody);
    logVerdict(game, healthCheck, verdict);
    return verdict;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const verdict: HealthCheckVerdict = {
      active: true,
      reason: `health check failed: ${message}`,
      failureDerived: true,
    };
    logVerdict(game, healthCheck, verdict);
    return verdict;
  }
};
