/**
 * Resolves after `ms` milliseconds via `setTimeout`. Shared by any service
 * that needs to defer action — e.g. `AwsProfileService`/`GuidedIamService`'s
 * `protected sleep` seams, which delegate here so their retry loops (see
 * {@link verifyAccessKeyWithRetry}) have one real implementation to keep in
 * sync, while each service still exposes its own overridable method for
 * tests to stub.
 *
 * @param ms - Milliseconds to sleep for.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
