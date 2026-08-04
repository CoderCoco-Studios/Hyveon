import * as aws from '@pulumi/aws';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineSecrets, secretResourceOptions, type SecretsResources } from './secrets.js';
import { installPulumiMocks, promiseOf, type RecordedResource } from './testing/pulumiMocks.js';

/** Resolves every leaf resource `defineSecrets` declares, guaranteeing the mock recorder has captured the full set before assertions run (see `pulumiMocks.ts`'s `promiseOf` doc). */
async function runDefineSecrets(args: Parameters<typeof defineSecrets>[0]): Promise<SecretsResources> {
  const result = defineSecrets(args);
  await Promise.all([
    promiseOf(result.discordBotTokenSecret.id),
    promiseOf(result.discordBotTokenSecretVersion.id),
    promiseOf(result.discordPublicKeySecret.id),
    promiseOf(result.discordPublicKeySecretVersion.id),
  ]);
  return result;
}

/** Finds the single recorded resource with the given Pulumi logical name, failing loudly if there isn't exactly one. */
function findByName(resources: RecordedResource[], name: string): RecordedResource {
  const matches = resources.filter((resource) => resource.name === name);
  if (matches.length !== 1) {
    throw new Error(`expected exactly one recorded resource named "${name}", found ${matches.length}`);
  }
  return matches[0];
}

/**
 * `aws.secretsmanager.SecretVersion.secretString`'s provider schema marks it
 * `secret: true`, so the mock protocol's recorded `inputs.secretString` is
 * not the plain string — it's Pulumi's well-known secret-wrapper RPC shape
 * (`{ [specialSigKey]: specialSecretSig, value: <the string> }`, per
 * `@pulumi/pulumi`'s `runtime/rpc.d.ts`, confirmed empirically against this
 * test's own mock output). Unwraps it back to the plain string.
 */
function unwrapSecretString(recordedValue: unknown): string {
  return (recordedValue as { value: string }).value;
}

// File-level, not per-`describe`: `secretResourceOptions.forVersion` is a
// shared exported object property — a `vi.spyOn` on it in one test must not
// leak into a later one (in this file or, if module state were ever shared,
// another), so every test that spies on it gets a fresh unwrapped function.
afterEach(() => {
  vi.restoreAllMocks();
});

describe('defineSecrets', () => {
  let mocks: ReturnType<typeof installPulumiMocks>;

  beforeEach(() => {
    mocks = installPulumiMocks();
  });

  it('should declare the bot-token secret at ${projectName}/discord/bot-token with a 0-day recovery window', async () => {
    const provider = new aws.Provider('aws', { region: 'us-east-1' });
    await runDefineSecrets({ projectName: 'hyveon', provider });

    const secret = findByName(mocks.resources, 'hyveon-discord-bot-token');
    expect(secret.type).toBe('aws:secretsmanager/secret:Secret');
    expect(secret.inputs.name).toBe('hyveon/discord/bot-token');
    expect(secret.inputs.recoveryWindowInDays).toBe(0);
    expect(secret.inputs.description).toBe('Discord bot token — used by the management app to register guild slash commands');
  });

  it('should declare the public-key secret at ${projectName}/discord/public-key with a 0-day recovery window', async () => {
    const provider = new aws.Provider('aws', { region: 'us-east-1' });
    await runDefineSecrets({ projectName: 'hyveon', provider });

    const secret = findByName(mocks.resources, 'hyveon-discord-public-key');
    expect(secret.type).toBe('aws:secretsmanager/secret:Secret');
    expect(secret.inputs.name).toBe('hyveon/discord/public-key');
    expect(secret.inputs.recoveryWindowInDays).toBe(0);
    expect(secret.inputs.description).toBe(
      'Discord application Ed25519 public key — used by InteractionsLambda for signature verification',
    );
  });

  it('should create both secret versions with the literal placeholder string, never a real credential', async () => {
    const provider = new aws.Provider('aws', { region: 'us-east-1' });
    const result = await runDefineSecrets({ projectName: 'hyveon', provider });

    const botTokenVersion = findByName(mocks.resources, 'hyveon-discord-bot-token-version');
    expect(botTokenVersion.type).toBe('aws:secretsmanager/secretVersion:SecretVersion');
    expect(unwrapSecretString(botTokenVersion.inputs.secretString)).toBe('placeholder');
    expect(botTokenVersion.inputs.secretId).toBe(await promiseOf(result.discordBotTokenSecret.id));

    const publicKeyVersion = findByName(mocks.resources, 'hyveon-discord-public-key-version');
    expect(unwrapSecretString(publicKeyVersion.inputs.secretString)).toBe('placeholder');
    expect(publicKeyVersion.inputs.secretId).toBe(await promiseOf(result.discordPublicKeySecret.id));
  });

  it('should accept no field anywhere in its arguments capable of carrying a real secret value', () => {
    // Type-level guard: `DefineSecretsArgs` only has `projectName`/`provider`.
    // If a future edit adds a secret-value field to this type, this object
    // literal (using `satisfies` against the real parameter type) fails to
    // compile — the enforcement is at the type-checker, this assertion is
    // just documentation that the check exists.
    // Fails to compile if `DefineSecretsArgs` gains ANY field, optional or not.
    type AllowedKeys = 'projectName' | 'provider';
    type ActualKeys = keyof Parameters<typeof defineSecrets>[0];
    const keysAreExactlyAllowed: AllowedKeys extends ActualKeys
      ? ActualKeys extends AllowedKeys
        ? true
        : never
      : never = true;
    expect(keysAreExactlyAllowed).toBe(true);
  });

  it('should declare both SecretVersion resources via secretResourceOptions.forVersion, not an equivalent-but-uninspected options object', async () => {
    // Call-site coverage, not just factory-output coverage: spies the exact
    // function object `defineSecrets` calls, so a future edit that quietly
    // swaps a `new aws.secretsmanager.SecretVersion(...)` call site back to
    // the plain `{ provider }` options already in scope (silently dropping
    // the create-only `ignoreChanges` guard) fails this test — a test that
    // only called `secretResourceOptions.forVersion(provider)` directly and
    // asserted its return value would NOT catch that regression. See
    // `secrets.ts`'s file doc, the paragraph on `secretResourceOptions`, for
    // the full rationale (mocks can't observe `ignoreChanges` on the
    // constructed resource itself).
    const forVersionSpy = vi.spyOn(secretResourceOptions, 'forVersion');
    const provider = new aws.Provider('aws', { region: 'us-east-1' });

    await runDefineSecrets({ projectName: 'hyveon', provider });

    expect(forVersionSpy).toHaveBeenCalledTimes(2);
    expect(forVersionSpy).toHaveBeenNthCalledWith(1, provider);
    expect(forVersionSpy).toHaveBeenNthCalledWith(2, provider);
    for (const call of forVersionSpy.mock.results) {
      expect(call.value).toEqual({ provider, ignoreChanges: ['secretString'] });
    }
  });
});

describe('secretResourceOptions.forVersion', () => {
  it('should carry ignoreChanges: ["secretString"] so a re-deploy never resets a configured secret back to its placeholder', () => {
    const provider = new aws.Provider('aws', { region: 'us-east-1' });
    const opts = secretResourceOptions.forVersion(provider);

    expect(opts.ignoreChanges).toEqual(['secretString']);
    expect(opts.provider).toBe(provider);
  });
});
