/**
 * Secrets Manager secrets for the Discord bot token, application public key,
 * and the FileBrowser helper's per-launch credential. All three secret
 * versions are "imperative escapes" implemented outside `escapes.ts` — see
 * that file's doc for the rest of the inventory.
 *
 * ## SPEC-CRITICAL: no secret material enters the stack
 *
 * This program never accepts a real credential value as input —
 * `DeploymentConfig` (`@hyveon/shared`) has no such field. Every secret
 * version below is created with the literal placeholder
 * {@link PLACEHOLDER_SECRET_VALUE}; the app's `DiscordConfigService` writes
 * real values directly to Secrets Manager over the AWS SDK afterward.
 *
 * ## Create-only secret versions (`ignoreChanges: ['secretString']`)
 *
 * Every version's value is written once, on creation, and excluded from
 * this program's reconciliation thereafter — a later `pulumi up` computes no
 * diff for `secretString` regardless of the live value. Without this, a
 * re-deploy after the operator configures real Discord credentials would
 * silently revert them back to the placeholder and break the bot.
 *
 * ## The FileBrowser credential secret — one shared secret, not per-game
 *
 * A single secret (not one per game) because the credential is ephemeral and
 * rotates on every FileBrowser helper launch regardless of which game the
 * helper is for — a per-game secret would only add recurring cost for a
 * value nothing ever reads back across launches.
 */

import * as aws from '@pulumi/aws';
import type * as pulumi from '@pulumi/pulumi';

/** Every resource {@link defineSecrets} declares, keyed by role — see this file's doc for the full resource table. */
export interface SecretsResources {
  /** The Discord bot token secret — read by the management app to register guild slash commands. */
  discordBotTokenSecret: aws.secretsmanager.Secret;
  /** {@link discordBotTokenSecret}'s create-only placeholder version. */
  discordBotTokenSecretVersion: aws.secretsmanager.SecretVersion;
  /** The Discord application Ed25519 public key secret — read by the interactions Lambda to verify request signatures. */
  discordPublicKeySecret: aws.secretsmanager.Secret;
  /** {@link discordPublicKeySecret}'s create-only placeholder version. */
  discordPublicKeySecretVersion: aws.secretsmanager.SecretVersion;
  /** The FileBrowser helper's per-launch credential-hash secret — one shared secret across every game, not per-game. See this file's doc, "The FileBrowser credential secret". */
  fileBrowserCredentialSecret: aws.secretsmanager.Secret;
  /** {@link fileBrowserCredentialSecret}'s create-only placeholder version. */
  fileBrowserCredentialSecretVersion: aws.secretsmanager.SecretVersion;
}

/** Arguments {@link defineSecrets} needs to declare every secret and its placeholder version. Deliberately carries NO secret-value field — see this file's doc. */
export interface DefineSecretsArgs {
  /** Project name — every secret's name below is `${projectName}/discord/...`. */
  projectName: string;
  /** The regional AWS provider every resource is declared against (region + default tags). */
  provider: aws.Provider;
}

/**
 * Literal value every secret version is created with — the HCL's own
 * fallback branch (`"placeholder"`), now the ONLY branch since the real-value
 * branch's input variable no longer exists. The shared `secretsStore`
 * (`dynamodb.ts`'s file doc, carried over from the legacy tool era) already
 * treats this exact string (and an empty string) as "not configured", so
 * every consumer already handles it safely.
 *
 * `secretString` is itself schema-marked `secret: true` by the AWS provider,
 * so Pulumi wraps it in its own secret-tracking machinery independent of
 * this program (confirmed by `secrets.test.ts`'s mock output — the recorded
 * input is the SDK's secret-wrapper shape, not the plain string) — one more
 * reason a literal placeholder here is fine: even this non-sensitive literal
 * value never appears in plaintext in `pulumi up`/`preview` output.
 */
const PLACEHOLDER_SECRET_VALUE = 'placeholder';

/**
 * Builds the `pulumi.CustomResourceOptions` every placeholder secret version
 * is declared with — `ignoreChanges: ['secretString']`. Exposed as a method
 * on an exported object (not a bare function) specifically so a spec can
 * `vi.spyOn(secretResourceOptions, 'forVersion')` and assert `defineSecrets`
 * itself calls this exact function at each `SecretVersion` call site — see
 * this file's doc, "Create-only secret versions", for the full rationale and
 * why a bare exported function can't support that call-site assertion.
 */
export const secretResourceOptions = {
  /**
   * @param provider - The regional AWS provider the version is declared against.
   * @returns The resource options, provider plus the create-only `ignoreChanges` entry.
   */
  forVersion(provider: aws.Provider): pulumi.CustomResourceOptions {
    return { provider, ignoreChanges: ['secretString'] };
  },
};

/**
 * Declares the two Discord secrets and their create-only placeholder
 * versions — see this file's doc for the full HCL→Pulumi address table and
 * the spec-critical rationale. Must be called from inside the Pulumi
 * inline-program closure, never at module scope.
 *
 * @param args - Naming and provider inputs — see {@link DefineSecretsArgs}.
 * @returns The declared secrets and versions — see {@link SecretsResources}.
 */
export function defineSecrets(args: DefineSecretsArgs): SecretsResources {
  const { projectName, provider } = args;
  const opts: pulumi.CustomResourceOptions = { provider };

  const discordBotTokenSecret = new aws.secretsmanager.Secret(
    `${projectName}-discord-bot-token`,
    {
      name: `${projectName}/discord/bot-token`,
      description: 'Discord bot token — used by the management app to register guild slash commands',
      recoveryWindowInDays: 0,
    },
    opts,
  );

  const discordBotTokenSecretVersion = new aws.secretsmanager.SecretVersion(
    `${projectName}-discord-bot-token-version`,
    {
      secretId: discordBotTokenSecret.id,
      secretString: PLACEHOLDER_SECRET_VALUE,
    },
    secretResourceOptions.forVersion(provider),
  );

  const discordPublicKeySecret = new aws.secretsmanager.Secret(
    `${projectName}-discord-public-key`,
    {
      name: `${projectName}/discord/public-key`,
      description: 'Discord application Ed25519 public key — used by InteractionsLambda for signature verification',
      recoveryWindowInDays: 0,
    },
    opts,
  );

  const discordPublicKeySecretVersion = new aws.secretsmanager.SecretVersion(
    `${projectName}-discord-public-key-version`,
    {
      secretId: discordPublicKeySecret.id,
      secretString: PLACEHOLDER_SECRET_VALUE,
    },
    secretResourceOptions.forVersion(provider),
  );

  const fileBrowserCredentialSecret = new aws.secretsmanager.Secret(
    `${projectName}-filebrowser-credential`,
    {
      name: `${projectName}/filebrowser/credential`,
      description: 'FileBrowser helper — bcrypt hash of the most recently generated per-launch credential',
      recoveryWindowInDays: 0,
    },
    opts,
  );

  const fileBrowserCredentialSecretVersion = new aws.secretsmanager.SecretVersion(
    `${projectName}-filebrowser-credential-version`,
    {
      secretId: fileBrowserCredentialSecret.id,
      secretString: PLACEHOLDER_SECRET_VALUE,
    },
    secretResourceOptions.forVersion(provider),
  );

  return {
    discordBotTokenSecret,
    discordBotTokenSecretVersion,
    discordPublicKeySecret,
    discordPublicKeySecretVersion,
    fileBrowserCredentialSecret,
    fileBrowserCredentialSecretVersion,
  };
}
