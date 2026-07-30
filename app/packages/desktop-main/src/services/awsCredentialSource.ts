import type { ElectronStoreService } from './ElectronStoreService.js';

/**
 * The wizard's chosen AWS credential source, resolved from
 * `ElectronStoreService`'s `aws: { region, profile }` selection plus the
 * pasted-credentials map (`creds.aws.<profileName>`) — the exact decision
 * `BootstrapService` and `IamCheckService` each duplicated privately as
 * `resolveClientConfig` before this was extracted (Task 4.5). There is no
 * discriminator field in the store: a stored `profile` name either IS a real
 * `~/.aws` profile or a `creds.aws.<profileName>` pasted entry, distinguished
 * only by whether {@link ElectronStoreService.getPastedCredentials} finds a
 * match — the pasted lookup always wins when both could apply, matching the
 * three services' pre-existing behaviour.
 */
export type AwsCredentialSource =
  /** No profile is stored at all — the wizard's credentials step has not run, or was skipped. */
  | { readonly kind: 'none' }
  /** `profile` resolved to a pasted-credentials entry — decrypted plaintext keys, never a provider function. */
  | { readonly kind: 'pasted'; readonly profile: string; readonly accessKeyId: string; readonly secretAccessKey: string }
  /** `profile` did not resolve to a pasted entry — treated as a real `~/.aws` CLI profile name. */
  | { readonly kind: 'profile'; readonly profile: string };

/**
 * Resolves which AWS credential source the wizard's credentials step
 * selected, without shaping the result for any particular consumer.
 * {@link BootstrapService}/{@link IamCheckService} turn this into an AWS SDK
 * `{ region, credentials }` client config; `PulumiCredentialResolver.ts`
 * (Task 4.5) turns it into engine `envVars`. Both transforms are
 * consumer-specific — this function only makes the *decision* once, so it is
 * never duplicated a third time.
 *
 * @remarks
 * Deliberately takes no `region` and returns none — `region` is a separate,
 * independent field on the store's `aws` object that each consumer already
 * has its own requirements around (e.g. `BootstrapCredentialsNotConfiguredError`
 * when absent); folding it in here would force every caller through this
 * function's error handling for a concern unrelated to *which credentials* to use.
 */
export function resolveAwsCredentialSource(store: ElectronStoreService): AwsCredentialSource {
  const profile = store.get('aws')?.profile;
  if (!profile) {
    return { kind: 'none' };
  }
  const pasted = store.getPastedCredentials(profile);
  if (pasted) {
    return { kind: 'pasted', profile, accessKeyId: pasted.accessKeyId, secretAccessKey: pasted.secretAccessKey };
  }
  return { kind: 'profile', profile };
}
