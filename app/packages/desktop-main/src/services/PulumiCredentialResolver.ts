import type { ElectronStoreService } from './ElectronStoreService.js';
import { resolveAwsCredentialSource } from './awsCredentialSource.js';

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
 * ## Exclusivity / clearing (spec-mandated, not optional)
 *
 * The selected source's variables are set, and the *other* source's
 * variables are explicitly set to `''` in the same returned object — never
 * merely omitted. This matters because the seam's `envVars` become an
 * `execa` `env` option with `extendEnv: true` (the SDK's default — see
 * `node_modules/execa/index.js`'s `getEnv` function, which spreads
 * `process.env` first and the `env` option second when `extendEnv` is
 * true), several layers down (`LocalWorkspace.runPulumiCmd` →
 * `PulumiCommand.run` → `exec` → `execa(command, args, opts)`, all in
 * `@pulumi/pulumi/automation/localWorkspace.js` and `.../cmd.js`). The
 * final child environment is therefore `process.env` spread first, then
 * our `envVars` spread on top — a plain
 * shallow spread, keyed by name, with no special-casing of `''`. A key this
 * function omits is not present in `ourEnvVars` at all, so the spread leaves
 * whatever ambient value `process.env` had for that key completely
 * untouched — an operator's shell `AWS_PROFILE`, a launcher's stray
 * `AWS_ACCESS_KEY_ID`, etc. would silently outrank the wizard's selection.
 * Supplying the key with value `''` instead means the key IS present in
 * `ourEnvVars`, so the spread's later `...ourEnvVars` always wins for that
 * key regardless of what `process.env` held — this is what "cleared, not
 * merely omitted" means at the mechanism level, and is exactly what
 * `PulumiWorkspaceService.test.ts`'s "should support clearing an inherited
 * variable via an explicit empty string" test already exercises for the
 * seam side of this contract.
 *
 * `''` is "present but empty", not "absent from the process' environment
 * table" — this function cannot make the child process's `getenv()` return
 * `NULL` for a cleared key (that would require actually deleting the key
 * from `process.env` before every spawn, which is outside what this
 * store-reading resolver does, and outside what `execa`'s public API
 * supports either). It relies instead on well-documented downstream
 * behaviour: both the AWS SDK for Go (used by the `pulumi` CLI binary and
 * its provider plugins) and the AWS SDK for JavaScript resolve
 * `AWS_PROFILE`/`AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` by checking for a
 * *non-empty* string, not merely a *set* one, so `''` is treated the same as
 * "not set" by every consumer these variables are meant for. This function's
 * own tests prove the mechanism up to "the final merged environment object
 * has `''` for the cleared key, not the ambient value" (see
 * `PulumiCredentialResolver.test.ts`'s spawn-based proof) — proving the
 * `pulumi` binary's own AWS SDK-for-Go credential chain treats that `''` as
 * absent requires actually running the real binary, which is Phase 7's
 * territory (real `preview`/`up` operations), not this task's.
 *
 * ## Not logged
 *
 * This function never calls `logger.*` — it has no side effects at all
 * beyond reading `store` — so no credential value it produces can reach the
 * application log by way of this code path. See
 * `PulumiCredentialResolver.test.ts`'s "should never call logger" test for a
 * mechanical proof of that claim, and `PulumiWorkspaceService.test.ts`'s
 * equivalent proof that `getOrCreateStack` itself never logs the resolved
 * `envVars` object either. Neither test can speak to Phase 7's future
 * `PulumiService.preview`/`.up`, which will stream real CLI stdout/stderr —
 * that streamed output is that phase's own responsibility to scrub, not
 * something this task's code path touches.
 *
 * @throws {@link PulumiCredentialsNotConfiguredError} when no credential
 *   source is selected at all (`resolveAwsCredentialSource` returns `'none'`).
 */
export function resolveCredentialEnvVars(store: ElectronStoreService): Record<string, string> {
  const source = resolveAwsCredentialSource(store);
  switch (source.kind) {
    case 'none':
      throw new PulumiCredentialsNotConfiguredError();
    case 'profile':
      return {
        AWS_PROFILE: source.profile,
        ...clearedEnvVars(PASTED_KEY_ENV_VARS),
      };
    case 'pasted':
      return {
        AWS_ACCESS_KEY_ID: source.accessKeyId,
        AWS_SECRET_ACCESS_KEY: source.secretAccessKey,
        ...clearedEnvVars(PROFILE_ENV_VARS),
      };
  }
}
