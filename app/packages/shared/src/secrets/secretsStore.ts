import {
  SecretsManagerClient,
  GetSecretValueCommand,
  PutSecretValueCommand,
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
