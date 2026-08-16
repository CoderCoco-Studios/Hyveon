import {
  SecretsManagerClient,
  GetSecretValueCommand,
  PutSecretValueCommand,
  CreateSecretCommand,
  DeleteSecretCommand,
  RestoreSecretCommand,
  DescribeSecretCommand,
  ResourceNotFoundException,
  InvalidRequestException,
} from '@aws-sdk/client-secrets-manager';

let cached: SecretsManagerClient | null = null;

/**
 * Placeholder value the Pulumi program (`@hyveon/infra`'s `secrets.ts`,
 * historically the app's original IaC tool) writes into a freshly-provisioned
 * secret so the resource has a version. Readers treat this as "not configured" so we never
 * ship a literal "placeholder" to Discord.
 */
export const SECRET_PLACEHOLDER = 'placeholder';

function getClient(): SecretsManagerClient {
  if (!cached) {
    const region =
      process.env['AWS_REGION_'] ?? process.env['AWS_REGION'] ?? process.env['AWS_DEFAULT_REGION'] ?? 'us-east-1';
    cached = new SecretsManagerClient({ region });
  }
  return cached;
}

/** Reset the cached client. Only used in tests. */
export function __resetSecretsClient(): void {
  cached = null;
}

interface SecretCacheEntry {
  value: string;
  expiresAt: number;
}
const inProcessCache = new Map<string, SecretCacheEntry>();
const CACHE_TTL_MS = 5 * 60 * 1000;

/** Fetch a secret string; caches the result for 5 minutes per ARN. */
async function getSecret(secretId: string): Promise<string | null> {
  const now = Date.now();
  const hit = inProcessCache.get(secretId);
  if (hit && hit.expiresAt > now) return hit.value;
  const resp = await getClient().send(new GetSecretValueCommand({ SecretId: secretId }));
  const value = resp.SecretString ?? null;
  if (value !== null) inProcessCache.set(secretId, { value, expiresAt: now + CACHE_TTL_MS });
  return value;
}

/** Overwrite a secret with a new version; invalidates the in-process cache for that ARN. */
async function putSecret(secretId: string, value: string): Promise<void> {
  await getClient().send(new PutSecretValueCommand({ SecretId: secretId, SecretString: value }));
  inProcessCache.delete(secretId);
}

/** Return the configured bot token, or `null` if not set / still on the placeholder. */
export async function getBotToken(secretArn: string): Promise<string | null> {
  const raw = await getSecret(secretArn);
  const value = raw?.trim() ?? null;
  if (!value || value === SECRET_PLACEHOLDER) return null;
  return value;
}

/** Return the configured Ed25519 public key (hex), or `null` if not set / still on the placeholder. */
export async function getPublicKey(secretArn: string): Promise<string | null> {
  const raw = await getSecret(secretArn);
  const value = raw?.trim() ?? null;
  if (!value || value === SECRET_PLACEHOLDER) return null;
  return value;
}

/** Persist a new bot token, trimmed of surrounding whitespace. */
export async function putBotToken(secretArn: string, value: string): Promise<void> {
  await putSecret(secretArn, value.trim());
}

/** Persist a new public key (hex), trimmed of surrounding whitespace. */
export async function putPublicKey(secretArn: string, value: string): Promise<void> {
  await putSecret(secretArn, value.trim());
}

/** Drop the in-process secrets cache. Exposed for the Nest app's "save credentials" path. */
export function invalidateSecretsCache(): void {
  inProcessCache.clear();
}

/** Builds the deterministic, per-game Secrets Manager secret name for an app-owned health-check credential (`basic`/`bearer`). One secret per game — `GameServerHealthCheck` allows at most one `auth`. */
export function healthCheckAuthSecretName(gameId: string): string {
  return `hyveon-${gameId}-healthcheck-auth`;
}

/**
 * `true` when `err` is Secrets Manager's `InvalidRequestException` for `name`
 * because the secret is currently scheduled for deletion (i.e. within
 * {@link deleteHealthCheckAuthSecret}'s default recovery window). Both
 * `PutSecretValueCommand` and `CreateSecretCommand` (same name) fail this
 * way for a pending-deletion secret — never `ResourceNotFoundException` —
 * so {@link upsertHealthCheckAuthSecret}'s create-fallback alone can't
 * recover from it; see that function's doc comment for the full flow.
 *
 * Confirms via `DescribeSecretCommand`'s `DeletedDate` rather than matching
 * the exception message text, which AWS doesn't document as stable.
 */
async function isPendingDeletionError(err: unknown, name: string): Promise<boolean> {
  if (!(err instanceof InvalidRequestException)) return false;
  const desc = await getClient().send(new DescribeSecretCommand({ SecretId: name }));
  return desc.DeletedDate !== undefined;
}

/**
 * Creates or updates the app-owned health-check credential secret for
 * `gameId`, and returns its ARN. Idempotent by construction: the secret name
 * is deterministic ({@link healthCheckAuthSecretName}), so this always tries
 * `PutSecretValueCommand` first (the common "already exists" case) and only
 * falls back to `CreateSecretCommand` when Secrets Manager reports the
 * secret doesn't exist yet — no separate "does it already exist" read is
 * needed, and no caller has to track prior ARNs across edits.
 *
 * A secret {@link deleteHealthCheckAuthSecret} previously scheduled for
 * deletion (still within its default recovery window) makes both
 * `PutSecretValueCommand` and `CreateSecretCommand` fail with
 * `InvalidRequestException` rather than `ResourceNotFoundException` — so the
 * create-fallback above never triggers for that case. This is the common
 * "clear a credential, then immediately re-add it" operator workflow (or
 * delete-then-recreate a game with the same name), so on that specific
 * error this un-schedules the deletion via `RestoreSecretCommand` and
 * retries `PutSecretValueCommand` once, rather than leaving the save failing
 * for up to the whole recovery window. The deliberate default-recovery-window
 * choice itself (see {@link deleteHealthCheckAuthSecret}'s doc) is
 * unaffected: a secret that's cleared and never touched again is still
 * eventually deleted by AWS.
 *
 * @param gameId - The `game_servers` map key this credential belongs to.
 * @param value - The secret's plaintext value — `JSON.stringify({ username, password })`
 *   for a `basic` credential, or the raw token for `bearer`. Never logged.
 * @returns The secret's ARN, to persist as `GameServerHealthCheckAuth.secretArn`.
 */
export async function upsertHealthCheckAuthSecret(gameId: string, value: string): Promise<string> {
  const name = healthCheckAuthSecretName(gameId);
  try {
    const putResp = await getClient().send(new PutSecretValueCommand({ SecretId: name, SecretString: value }));
    inProcessCache.delete(name);
    if (!putResp.ARN) {
      throw new Error(`PutSecretValueCommand for ${name} did not return an ARN`);
    }
    return putResp.ARN;
  } catch (err) {
    if (await isPendingDeletionError(err, name)) {
      await getClient().send(new RestoreSecretCommand({ SecretId: name }));
      const retryResp = await getClient().send(new PutSecretValueCommand({ SecretId: name, SecretString: value }));
      inProcessCache.delete(name);
      if (!retryResp.ARN) {
        throw new Error(`PutSecretValueCommand (post-restore) for ${name} did not return an ARN`);
      }
      return retryResp.ARN;
    }
    if (!(err instanceof ResourceNotFoundException)) {
      throw err;
    }
    const createResp = await getClient().send(new CreateSecretCommand({ Name: name, SecretString: value }));
    if (!createResp.ARN) {
      throw new Error(`CreateSecretCommand for ${name} did not return an ARN`);
    }
    return createResp.ARN;
  }
}

/**
 * Deletes the app-owned health-check credential secret for `gameId`, using
 * Secrets Manager's default recovery window (no `ForceDeleteWithoutRecovery`
 * — a deliberate default-recovery-window choice, safer against an
 * accidental clear than immediate, unrecoverable deletion). A no-op if the
 * secret doesn't exist — deleting an already-absent app-owned secret (e.g.
 * a retry after a partial failure) must not surface as an error.
 *
 * @param gameId - The `game_servers` map key whose credential secret should be retired.
 */
export async function deleteHealthCheckAuthSecret(gameId: string): Promise<void> {
  const name = healthCheckAuthSecretName(gameId);
  try {
    await getClient().send(new DeleteSecretCommand({ SecretId: name }));
    inProcessCache.delete(name);
  } catch (err) {
    if (!(err instanceof ResourceNotFoundException)) {
      throw err;
    }
  }
}
