/**
 * Health-check Lambda — invoked synchronously by the watchdog for a game
 * that declares a `healthCheck`, in place of the Container Insights network-traffic
 * heuristic. Takes the checked task's private address from the invoke payload (resolved by the watchdog from ECS), never from
 * the declared configuration, so no configuration value can redirect a check at a different host. Makes no ECS call. Fetches the
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
import { isIPv4 } from 'node:net';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import {
  HEALTH_CHECK_SECRET_DEADLINE_MS,
  type GameServerHealthCheck,
  type GameServerHealthCheckAuth,
} from '@hyveon/shared';
import { evaluateHealthCheck, type HealthCheckVerdict } from './engine.js';

/** Invocation payload the watchdog sends: the game whose task is being checked, the task's ARN, and its declared health check. */
export interface HealthCheckEvent {
  game: string;
  taskArn: string;
  /** The task's private IPv4 address as the watchdog resolved it; validated before use. */
  privateIp: string;
  healthCheck: GameServerHealthCheck;
}

// @spec RT-HEALTH-PROV-006
function region(): string {
  // AWS_REGION_ (trailing underscore) — AWS_REGION is reserved by the Lambda runtime and cannot be set as a function env var.
  return process.env['AWS_REGION_'] ?? process.env['AWS_REGION'] ?? process.env['AWS_DEFAULT_REGION'] ?? 'us-east-1';
}

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
 * Overall-deadline wrapper for the credential fetch: one abort signal covers the whole secret call,
 * SDK retry attempts included, so an unreachable endpoint fails the check instead of running to the function timeout.
 */
async function fetchSecretString(secretArn: string): Promise<string> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`secret fetch exceeded ${HEALTH_CHECK_SECRET_DEADLINE_MS} ms`));
    }, HEALTH_CHECK_SECRET_DEADLINE_MS);
  });
  try {
    const resp = await Promise.race([
      secretsManager.send(new GetSecretValueCommand({ SecretId: secretArn }), { abortSignal: controller.signal }),
      deadline,
    ]);
    if (resp.SecretString === undefined) {
      throw new Error('Secret has no string value');
    }
    return resp.SecretString;
  } finally {
    clearTimeout(timer);
  }
}

/** Resolves the declared credential's raw secret string, or `undefined` when the health check declares no `auth`. */
async function resolveAuthSecretValue(healthCheck: GameServerHealthCheck): Promise<string | undefined> {
  return healthCheck.auth ? fetchSecretString(healthCheck.auth.secretArn) : undefined;
}

// @spec RT-HEALTH-HTTP-002, RT-HEALTH-HTTP-007, RT-HEALTH-HTTP-008, RT-HEALTH-HTTP-010
/**
 * Validates the payload's `privateIp`, the sole source of the request's destination host.
 *
 * @remarks
 * Accepts exactly what `net.isIPv4` accepts, applied to the value as received with no trimming; there is no VPC CIDR
 * or private-range check because the watchdog, the function's only invoker, reads the address from ECS.
 *
 * @param privateIp - The payload field, which may be absent despite its type.
 * @returns The validated IPv4 literal.
 * @throws When the value is absent or is not a well-formed IPv4 literal.
 */
function requirePayloadHost(privateIp: string | null | undefined): string {
  if (privateIp === undefined || privateIp === null) {
    throw new Error('invoke payload has no privateIp');
  }
  if (typeof privateIp !== 'string' || !isIPv4(privateIp)) {
    throw new Error('invoke payload privateIp is not a well-formed IPv4 address');
  }
  return privateIp;
}

/** Builds the request URL so the declared `path` can never change the authority; the connect address stays `host`. */
function buildRequestUrl(healthCheck: GameServerHealthCheck, host: string): string {
  const base = new URL(`${healthCheck.scheme}://${host}:${healthCheck.port}/`);
  const target = new URL(healthCheck.path, base);
  if (target.host !== base.host) {
    throw new Error('declared path changes the request authority');
  }
  return target.toString();
}

// @spec RT-HEALTH-AUTH-001, RT-HEALTH-AUTH-002, RT-HEALTH-AUTH-003, RT-HEALTH-AUTH-004
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

// @spec RT-HEALTH-AUTH-005, RT-HEALTH-AUTH-006
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

// @spec RT-HEALTH-DECL-006, RT-HEALTH-HTTP-001, RT-HEALTH-HTTP-003, RT-HEALTH-HTTP-006, RT-HEALTH-HTTP-009
// @spec RT-HEALTH-HTTP-011, RT-HEALTH-FAIL-004, RT-HEALTH-FAIL-005, RT-HEALTH-FAIL-007, RT-HEALTH-LOG-001, RT-HEALTH-LOG-004
/**
 * Invoked synchronously by the watchdog for a game with a declared health
 * check. Takes the task's host from the payload, issues the declared request,
 * and returns the verdict — fail-active for any transport, credential, or
 * response-shaped failure.
 */
export const handler = async (event: HealthCheckEvent): Promise<HealthCheckVerdict> => {
  const { game, privateIp, healthCheck } = event;
  log('debug', 'health check invoked', { game, kind: healthCheck.kind, port: healthCheck.port });

  try {
    const host = requirePayloadHost(privateIp);
    const secretValue = await resolveAuthSecretValue(healthCheck);
    const authorizationValue =
      secretValue !== undefined && healthCheck.auth ? buildAuthorizationHeader(healthCheck.auth, secretValue) : undefined;
    const headers = buildHeaders(healthCheck, authorizationValue);
    const url = buildRequestUrl(healthCheck, host);

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
