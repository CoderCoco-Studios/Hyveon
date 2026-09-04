/**
 * Minimal shape {@link createCachedAwsClient} needs to build a client's
 * cache key. Extra fields a particular client's `factory` needs (e.g.
 * `credentials`) are read by that callback directly — this interface only
 * covers what the cache key itself depends on.
 */
export interface CachedAwsClientConfig {
  region: string;
  credentialsSignature?: string;
}

/**
 * Builds a memoized "get or rebuild" function for a single AWS SDK client,
 * replacing the `client`/`clientCacheKey` field pair and rebuild-if-changed
 * `if` block previously hand-written at every AWS-client call site in
 * `Ec2Service`/`EcsService`/`SchedulerService`/`LogsService`. Preserves the
 * exact rebuild semantics those services already documented: a client is
 * rebuilt only when the resolved `region` or `credentialsSignature` differs
 * from what the cached client was built with, not on every call. Credential
 * resolution itself stays in `awsCredentialSource.ts`
 * (`resolveAwsClientCredentialsWithSignature`) — this helper only owns the
 * cache/rebuild decision.
 *
 * @typeParam Config - The resolved config shape passed to `factory` on each
 *   call; must carry at least `region` and (optionally)
 *   `credentialsSignature` for the cache key.
 * @typeParam Client - The AWS SDK client type being cached.
 * @param factory - Builds a fresh client from a resolved config. Only
 *   invoked when the cache key changes. The caller resolves `Config` itself
 *   before calling the returned function.
 * @returns A function that, given the current resolved config, returns the
 *   cached client — rebuilding it first if the region or credentials
 *   signature changed since the last call.
 */
export function createCachedAwsClient<Config extends CachedAwsClientConfig, Client>(
  factory: (config: Config) => Client,
): (config: Config) => Client {
  let client: Client | null = null;
  let clientCacheKey: string | null = null;

  return (config: Config): Client => {
    const cacheKey = `${config.region}::${config.credentialsSignature ?? ''}`;
    if (!client || clientCacheKey !== cacheKey) {
      client = factory(config);
      clientCacheKey = cacheKey;
    }
    return client;
  };
}
