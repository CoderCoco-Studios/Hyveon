import type { ElectronStoreService } from './ElectronStoreService.js';
import { logger } from '../logger.js';
import { resolveAwsCredentialSource } from './awsCredentialSource.js';
import { errMessage } from '@hyveon/shared';

/**
 * Thrown by {@link resolveCredentialEnvVars} when the wizard's credentials
 * step has never selected an AWS credential source at all (no `profile`
 * stored under `aws.profile`) — see the `pulumi-engine-runtime` delta spec's
 * "Wizard-selected credentials reach the engine" requirement: "The engine
 * MUST NOT be left to resolve credentials through its own default chain,
 * because that silently ignores the operator's choice." Falling through to
 * `LocalWorkspaceOptions.envVars` without any credential keys at all would do
 * exactly that (the engine would fall back to its own default AWS credential
 * chain), so this is a hard failure rather than an empty `envVars` object.
 */
export class PulumiCredentialsNotConfiguredError extends Error {
  constructor() {
    super(
      'Cannot run this Pulumi operation: no AWS credential source is configured. ' +
        'Complete the credentials step of the wizard (or Settings → AWS Resources) before running ' +
        'infrastructure operations.',
    );
    this.name = 'PulumiCredentialsNotConfiguredError';
  }
}

/**
 * `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`/`AWS_SESSION_TOKEN` — the
 * pasted-keys credential variables. Cleared (see {@link resolveCredentialEnvVars})
 * whenever the named-profile path is selected, per the spec's "Ambient keys
 * cannot override a selected profile" scenario.
 */
const PASTED_KEY_ENV_VARS = ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN'] as const;

/**
 * `AWS_PROFILE`/`AWS_DEFAULT_PROFILE` — the named-profile credential
 * variables. Cleared (see {@link resolveCredentialEnvVars}) whenever the
 * pasted-keys path is selected, per the spec's "Ambient profile cannot
 * override pasted keys" scenario.
 */
const PROFILE_ENV_VARS = ['AWS_PROFILE', 'AWS_DEFAULT_PROFILE'] as const;

/** Builds a `Record<string, ''>` clearing every key in `keys` — see {@link resolveCredentialEnvVars}. */
function clearedEnvVars(keys: readonly string[]): Record<string, string> {
  return Object.fromEntries(keys.map((key) => [key, '']));
}

/**
 * Resolves the wizard-selected AWS credential source
 * ({@link resolveAwsCredentialSource}) into the exact `envVars` overlay
 * {@link PulumiWorkspaceService.getOrCreateStack} merges into the engine's
 * environment via `PulumiWorkspaceInput.credentialEnvVars` — named profile
 * via `AWS_PROFILE`, or the main-process-decrypted pasted keys via
 * `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` — satisfying the
 * `pulumi-engine-runtime` delta spec's "Wizard-selected credentials reach the
 * engine" requirement.
 *
 * @remarks
 * The selected source's variables are set, and the *other* source's
 * variables are explicitly set to `''` in the same returned object — never
 * merely omitted. This matters because the seam's `envVars` become an
 * `execa` `env` option with `extendEnv: true`, which spreads `process.env`
 * first and `env` second: a key this function omits is simply absent from
 * the overlay, so the spread leaves whatever ambient value `process.env` had
 * (an operator's shell `AWS_PROFILE`, a launcher's stray
 * `AWS_ACCESS_KEY_ID`) completely untouched and silently outranking the
 * wizard's selection. Supplying the key with value `''` instead means the
 * later spread always wins for that key regardless of what `process.env`
 * held — this is what "cleared, not merely omitted" means at the mechanism
 * level.
 *
 * `''` is "present but empty", not "absent from the process' environment
 * table" — this relies on well-documented downstream behaviour: both the AWS
 * SDK for Go (used by the `pulumi` CLI binary and its provider plugins) and
 * the AWS SDK for JavaScript resolve
 * `AWS_PROFILE`/`AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` by checking for a
 * *non-empty* string, not merely a *set* one, so `''` is treated the same as
 * "not set" by every consumer these variables are meant for.
 *
 * @throws {@link PulumiCredentialsNotConfiguredError} when no credential
 *   source is selected at all (`resolveAwsCredentialSource` returns `'none'`).
 */
export function resolveCredentialEnvVars(store: ElectronStoreService): Record<string, string> {
  let source: ReturnType<typeof resolveAwsCredentialSource>;
  try {
    source = resolveAwsCredentialSource(store);
  } catch (err) {
    logger.warn('resolveCredentialEnvVars: failed to resolve the AWS credential source', {
      error: errMessage(err),
    });
    throw err;
  }
  switch (source.kind) {
    case 'none':
      logger.warn('resolveCredentialEnvVars: no AWS credential source is configured');
      throw new PulumiCredentialsNotConfiguredError();
    case 'profile':
      logger.debug('resolveCredentialEnvVars: resolved credential source', { source: 'profile' });
      return {
        AWS_PROFILE: source.profile,
        ...clearedEnvVars(PASTED_KEY_ENV_VARS),
      };
    case 'pasted':
      logger.debug('resolveCredentialEnvVars: resolved credential source', { source: 'pasted' });
      return {
        AWS_ACCESS_KEY_ID: source.accessKeyId,
        AWS_SECRET_ACCESS_KEY: source.secretAccessKey,
        // The paste flow has no session-token field of its own to set
        // (`ElectronStoreService.getPastedCredentials` only ever returns
        // `accessKeyId`/`secretAccessKey`) — but an ambient `AWS_SESSION_TOKEN`
        // (e.g. from an `aws sso`/assume-role shell session the app was
        // launched from) MUST still be cleared here, not merely left unset.
        // Left uncleared, the final env would carry the wizard's long-term
        // pasted keys alongside an inherited *temporary* session token for a
        // different identity — AWS rejects that combination outright
        // ("security token included in the request is invalid"), and the
        // failure would be unexplainable to the operator. See
        // `PulumiCredentialResolver.test.ts`'s pasted-path exclusivity test.
        AWS_SESSION_TOKEN: '',
        ...clearedEnvVars(PROFILE_ENV_VARS),
      };
  }
}
