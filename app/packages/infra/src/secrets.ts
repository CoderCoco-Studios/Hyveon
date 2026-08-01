/**
 * Secrets Manager secrets for the Discord bot token and application public
 * key — ported from `terraform/aws/discord_store.tf`'s two
 * `aws_secretsmanager_secret` + `aws_secretsmanager_secret_version` pairs
 * (task 3.8 of `migrate-iac-to-pulumi`). The two `aws_secretsmanager_secret_version`
 * resources are also part of task 3.10's "imperative escapes" inventory —
 * per that task's brief, they are implemented HERE, alongside the secrets
 * they version, rather than in `escapes.ts` (see that file's doc for the
 * rest of the escapes inventory).
 *
 * | HCL address | This file |
 * | --- | --- |
 * | `aws_secretsmanager_secret.discord_bot_token` | {@link SecretsResources.discordBotTokenSecret} |
 * | `aws_secretsmanager_secret_version.discord_bot_token` | {@link SecretsResources.discordBotTokenSecretVersion} |
 * | `aws_secretsmanager_secret.discord_public_key` | {@link SecretsResources.discordPublicKeySecret} |
 * | `aws_secretsmanager_secret_version.discord_public_key` | {@link SecretsResources.discordPublicKeySecretVersion} |
 *
 * ## SPEC-CRITICAL: no secret material enters the stack
 *
 * `pulumi-infra-program`'s "No secret material enters the stack" requirement
 * (openspec) forbids this program from accepting a real credential value as
 * input. `DeploymentConfig` (`@hyveon/shared`) already dropped
 * `discord_bot_token`/`discord_public_key` (see that file's file-level doc,
 * "It intentionally excludes every secret input") — so {@link DefineSecretsArgs}
 * has no such field to accept, and every version below is created with the
 * literal string {@link PLACEHOLDER_SECRET_VALUE} unconditionally, unlike the
 * HCL's `var.discord_bot_token != "" ? var.discord_bot_token : "placeholder"`
 * ternary (which could never take its non-placeholder branch once the
 * variable itself is gone). The app's existing `DiscordConfigService` writes
 * the real values directly to Secrets Manager over the AWS SDK — this
 * program only ever creates the initial placeholder version.
 *
 * ## Create-only secret versions (`ignoreChanges: ['secretString']`)
 *
 * Reproduces the HCL's `lifecycle { ignore_changes = [secret_string] }`: the
 * version's value is written once, on creation, and thereafter excluded from
 * this program's reconciliation — a later `pulumi up` computes no diff for
 * `secretString` regardless of what value is live in Secrets Manager. Without
 * this, a re-deploy after the operator configures real Discord credentials
 * through the app would silently revert them back to
 * {@link PLACEHOLDER_SECRET_VALUE} and break the bot (the exact regression
 * `pulumi-infra-program`'s "Re-deploying does not overwrite configured
 * secrets" scenario guards against).
 *
 * {@link secretResourceOptions}`.forVersion` is factored out as its own
 * exported **object method** (not a bare function) specifically so a test
 * can verify it twofold: (1) that calling it returns the right options, and
 * (2) — the part a bare exported function cannot support — that
 * {@link defineSecrets} actually calls it at each `new aws.secretsmanager.SecretVersion(...)`
 * call site, via `vi.spyOn(secretResourceOptions, 'forVersion')`. Pulumi's
 * mock test harness (`testing/pulumiMocks.ts`) does not expose
 * `ignoreChanges` (or any other `CustomResourceOptions` field) to a
 * `newResource` mock callback — confirmed by reading `@pulumi/pulumi`'s
 * `runtime/mocks.d.ts`, whose `MockResourceArgs` carries only
 * `type`/`name`/`inputs`/`provider`/`custom`/`id` — so there is no way to
 * assert "this constructed resource carries `ignoreChanges: ['secretString']`"
 * by inspecting a recorded resource the way every other test in this package
 * does. A test that only calls `secretResourceOptions.forVersion(provider)`
 * directly and checks its return value would NOT catch a future edit that
 * quietly swaps a `SecretVersion` call site back to the plain `{ provider }`
 * options in scope — the spy closes exactly that gap, by asserting the
 * function object `defineSecrets` actually calls, not a same-named copy the
 * test constructs independently. The engine-level guarantee this option
 * requests — that a real `pulumi up` computes no diff for the value Secrets
 * Manager actually holds — is real Pulumi-engine behavior with no local mock
 * equivalent, and is only ever exercised at a real deploy
 * (`pulumi-infra-program`'s "Preservation is covered by a test" scenario's
 * fuller integration-level case belongs to a later phase's test surface, not
 * this unit-test package).
 */

import * as aws from '@pulumi/aws';
import type * as pulumi from '@pulumi/pulumi';

/** Every resource {@link defineSecrets} declares, keyed by role — see this file's doc for the full HCL→Pulumi address table. */
export interface SecretsResources {
  /** The Discord bot token secret (`aws_secretsmanager_secret.discord_bot_token`) — read by the management app to register guild slash commands. */
  discordBotTokenSecret: aws.secretsmanager.Secret;
  /** {@link discordBotTokenSecret}'s create-only placeholder version (`aws_secretsmanager_secret_version.discord_bot_token`). */
  discordBotTokenSecretVersion: aws.secretsmanager.SecretVersion;
  /** The Discord application Ed25519 public key secret (`aws_secretsmanager_secret.discord_public_key`) — read by the interactions Lambda to verify request signatures. */
  discordPublicKeySecret: aws.secretsmanager.Secret;
  /** {@link discordPublicKeySecret}'s create-only placeholder version (`aws_secretsmanager_secret_version.discord_public_key`). */
  discordPublicKeySecretVersion: aws.secretsmanager.SecretVersion;
}

/** Arguments {@link defineSecrets} needs to declare every secret and its placeholder version. Deliberately carries NO secret-value field — see this file's doc. */
export interface DefineSecretsArgs {
  /** Mirrors `var.project_name` — every secret's name below is `${projectName}/discord/...`, matching the HCL exactly. */
  projectName: string;
  /** The regional AWS provider every resource is declared against (region + default tags). */
  provider: aws.Provider;
}

/**
 * Literal value every secret version is created with — the HCL's own
 * fallback branch (`"placeholder"`), now the ONLY branch since the real-value
 * branch's input variable no longer exists. The shared `secretsStore`
 * (`discord_store.tf`'s file doc, carried over from the HCL era) already
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
 * versions (task 3.8 of `migrate-iac-to-pulumi`) — see this file's doc for
 * the full HCL→Pulumi address table and the spec-critical rationale. Must be
 * called from inside the Pulumi inline-program closure, never at module
 * scope.
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

  return { discordBotTokenSecret, discordBotTokenSecretVersion, discordPublicKeySecret, discordPublicKeySecretVersion };
}
