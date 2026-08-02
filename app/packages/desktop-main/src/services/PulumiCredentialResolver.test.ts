/**
 * Unit tests for `resolveCredentialEnvVars`, the credential resolver,
 * covering the `pulumi-engine-runtime` delta spec's "Wizard-selected
 * credentials reach the engine" requirement's five scenarios: named profile,
 * pasted keys, ambient-keys-cannot-override-profile,
 * ambient-profile-cannot-override-pasted-keys, and credentials-not-logged.
 *
 * The first four are plain input/output assertions on the pure function
 * itself. The fifth ("not logged") and the exclusivity/clearing mechanism
 * need something stronger than "the returned object doesn't contain the
 * ambient value" (which would also pass if the key were simply never set) —
 * see the two describe blocks below for how each is proven rather than
 * merely asserted.
 */
import { describe, it, expect, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  resolveCredentialEnvVars,
  PulumiCredentialsNotConfiguredError,
} from './PulumiCredentialResolver.js';
import type { ElectronStoreService } from './ElectronStoreService.js';

const execFileAsync = promisify(execFile);

/** Builds an `ElectronStoreService` stub whose `aws.profile` and pasted-credentials lookup are controlled directly. */
function makeStore(
  profile: string | undefined,
  pastedCredentials?: { accessKeyId: string; secretAccessKey: string },
): ElectronStoreService {
  return {
    get: vi.fn().mockImplementation((key: string) => (key === 'aws' ? { profile } : undefined)),
    getPastedCredentials: vi.fn().mockReturnValue(pastedCredentials),
  } as Partial<ElectronStoreService> as ElectronStoreService;
}

describe('resolveCredentialEnvVars — named profile is honored', () => {
  it('should return AWS_PROFILE set to the selected profile', () => {
    const store = makeStore('personal', undefined);

    const envVars = resolveCredentialEnvVars(store);

    expect(envVars['AWS_PROFILE']).toBe('personal');
  });
});

describe('resolveCredentialEnvVars — pasted keys are honored', () => {
  it('should return the decrypted access key id and secret access key', () => {
    const store = makeStore('hyveon-pasted', { accessKeyId: 'AKID123', secretAccessKey: 'SECRET456' });

    const envVars = resolveCredentialEnvVars(store);

    expect(envVars['AWS_ACCESS_KEY_ID']).toBe('AKID123');
    expect(envVars['AWS_SECRET_ACCESS_KEY']).toBe('SECRET456');
  });
});

describe('resolveCredentialEnvVars — ambient keys cannot override a selected profile', () => {
  it('should set AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, and AWS_SESSION_TOKEN to the empty string', () => {
    const store = makeStore('personal', undefined);

    const envVars = resolveCredentialEnvVars(store);

    // Explicitly *present* with an empty value — not simply absent from the
    // object. `Object.hasOwn` (rather than a truthy/falsy check on the
    // value) is the assertion that actually distinguishes "cleared" from
    // "never set" at this layer; see the describe block below for the proof
    // that an explicitly-present empty string is what makes the clearing
    // reach a spawned child process at all.
    expect(Object.hasOwn(envVars, 'AWS_ACCESS_KEY_ID')).toBe(true);
    expect(Object.hasOwn(envVars, 'AWS_SECRET_ACCESS_KEY')).toBe(true);
    expect(Object.hasOwn(envVars, 'AWS_SESSION_TOKEN')).toBe(true);
    expect(envVars['AWS_ACCESS_KEY_ID']).toBe('');
    expect(envVars['AWS_SECRET_ACCESS_KEY']).toBe('');
    expect(envVars['AWS_SESSION_TOKEN']).toBe('');
  });
});

describe('resolveCredentialEnvVars — ambient profile cannot override pasted keys', () => {
  it('should set AWS_PROFILE and AWS_DEFAULT_PROFILE to the empty string', () => {
    const store = makeStore('hyveon-pasted', { accessKeyId: 'AKID123', secretAccessKey: 'SECRET456' });

    const envVars = resolveCredentialEnvVars(store);

    expect(Object.hasOwn(envVars, 'AWS_PROFILE')).toBe(true);
    expect(Object.hasOwn(envVars, 'AWS_DEFAULT_PROFILE')).toBe(true);
    expect(envVars['AWS_PROFILE']).toBe('');
    expect(envVars['AWS_DEFAULT_PROFILE']).toBe('');
  });

  it('should also clear AWS_SESSION_TOKEN, since the paste flow never has one of its own to set', () => {
    // Regression test: the paste flow only ever collects
    // accessKeyId/secretAccessKey (ElectronStoreService.getPastedCredentials
    // has no sessionToken field), so an ambient AWS_SESSION_TOKEN — e.g. from
    // an `aws sso`/assume-role shell session the app was launched from — was
    // previously left completely untouched on this branch: neither set nor
    // cleared. That leaks a temporary session token alongside the wizard's
    // long-term pasted keys, a combination AWS rejects outright ("security
    // token included in the request is invalid").
    const store = makeStore('hyveon-pasted', { accessKeyId: 'AKID123', secretAccessKey: 'SECRET456' });

    const envVars = resolveCredentialEnvVars(store);

    expect(Object.hasOwn(envVars, 'AWS_SESSION_TOKEN')).toBe(true);
    expect(envVars['AWS_SESSION_TOKEN']).toBe('');
  });
});

describe('resolveCredentialEnvVars — no credential source configured', () => {
  it('should throw PulumiCredentialsNotConfiguredError rather than returning an empty object', () => {
    const store = makeStore(undefined);

    expect(() => resolveCredentialEnvVars(store)).toThrow(PulumiCredentialsNotConfiguredError);
  });
});

/**
 * "Credentials are not logged" at *this* layer: `PulumiCredentialResolver.ts`
 * imports nothing from `../logger.js` at all (verify with
 * `grep -n logger PulumiCredentialResolver.ts` — no match), so there is
 * structurally no logger call for a runtime spy to catch here; asserting
 * "the logger mock was never called" in this file would be vacuously true
 * and would prove nothing. The layer that DOES call `logger.debug` on this
 * path is `PulumiWorkspaceService.getOrCreateStack` (once, for
 * `pulumiHome`/`workDir`) — `PulumiWorkspaceService.test.ts`'s "credentials
 * are not logged" test proves that call (and every other logger call made
 * while resolving a stack with real pasted-key `credentialEnvVars`) never
 * carries the secret values, which is the meaningful place to make this
 * assertion. What is NOT covered by either test file: `PulumiService.preview`'s/
 * `.apply`'s (which calls `stack.up()`) future streaming of real CLI
 * stdout/stderr — scrubbing that stream is the responsibility of whichever
 * code implements it.
 */

/**
 * Proves the exclusivity/clearing mechanism reaches an actual spawned child
 * process's environment — not just that the resolver's *return value* lacks
 * the ambient value (which "not added by us" would already satisfy).
 *
 * The Pulumi Automation API SDK spawns the engine via `execa` with its
 * default `extendEnv: true` (traced in `PulumiCredentialResolver.ts`'s
 * `resolveCredentialEnvVars` TSDoc: `LocalWorkspace.runPulumiCmd` →
 * `PulumiCommand.run` → `exec` → `execa(command, args, opts)`, and
 * `execa`'s own `getEnv` function at `node_modules/execa/index.js:18`,
 * which spreads `process.env` first and the `env` option second when
 * `extendEnv` is true). This test does not re-import `execa` (avoiding a
 * phantom dependency on a package `desktop-main` doesn't declare — it's
 * only reachable today via `@pulumi/pulumi`'s own dependency tree); instead
 * it builds the *identical* shallow-spread object that formula produces
 * (ambient env spread first, resolver output spread on top) and hands that
 * exact object to Node's own `child_process.execFile` — the same
 * `node:child_process` primitive `TerraformService.ts` already uses
 * elsewhere in this codebase, and the same primitive `execa` itself uses
 * once it has built that merged `env` object. What's under test is real
 * process spawning with a real OS-level environment table, not a hand-wavy
 * object-shape assertion.
 */
describe('resolveCredentialEnvVars — exclusivity reaches a spawned child process, not merely the returned object', () => {
  /** Spawns a real Node child with `env` and returns what it read back for `varName` via `process.env`. */
  async function readEnvVarInChild(env: NodeJS.ProcessEnv, varName: string): Promise<string> {
    const { stdout } = await execFileAsync(process.execPath, [
      '-e',
      `process.stdout.write(JSON.stringify(process.env[${JSON.stringify(varName)}] ?? null))`,
    ], { env });
    return JSON.parse(stdout) as string;
  }

  it('should clear an ambient AWS_PROFILE from what a spawned child actually sees when pasted keys are selected', async () => {
    const ambientEnv: NodeJS.ProcessEnv = { ...process.env, AWS_PROFILE: 'ambient-shell-profile' };
    const store = makeStore('hyveon-pasted', { accessKeyId: 'AKID123', secretAccessKey: 'SECRET456' });
    const resolved = resolveCredentialEnvVars(store);

    // The exact merge formula execa's `getEnv` performs with `extendEnv: true`.
    const childEnv = { ...ambientEnv, ...resolved };

    const seen = await readEnvVarInChild(childEnv, 'AWS_PROFILE');

    expect(seen).toBe(''); // cleared: present-but-empty, never the ambient value
    expect(seen).not.toBe('ambient-shell-profile');
  });

  it('should clear an ambient AWS_ACCESS_KEY_ID from what a spawned child actually sees when a profile is selected', async () => {
    const ambientEnv: NodeJS.ProcessEnv = { ...process.env, AWS_ACCESS_KEY_ID: 'AMBIENT-AKID-FROM-SHELL' };
    const store = makeStore('personal', undefined);
    const resolved = resolveCredentialEnvVars(store);

    const childEnv = { ...ambientEnv, ...resolved };

    const seen = await readEnvVarInChild(childEnv, 'AWS_ACCESS_KEY_ID');

    expect(seen).toBe('');
    expect(seen).not.toBe('AMBIENT-AKID-FROM-SHELL');
  });

  it('should clear an ambient AWS_SESSION_TOKEN from what a spawned child actually sees when pasted keys are selected', async () => {
    // The failure this guards against: an operator launches the app from a
    // shell that still has a temporary `aws sso`/assume-role session
    // exported (access key + secret + session token all ambient), then
    // selects pasted keys in the wizard. Without this clear, the final child
    // env would carry the wizard's long-term access key/secret alongside the
    // ambient *temporary* session token for a different identity — a
    // combination AWS's STS rejects outright.
    const ambientEnv: NodeJS.ProcessEnv = { ...process.env, AWS_SESSION_TOKEN: 'ambient-sso-session-token' };
    const store = makeStore('hyveon-pasted', { accessKeyId: 'AKID123', secretAccessKey: 'SECRET456' });
    const resolved = resolveCredentialEnvVars(store);

    const childEnv = { ...ambientEnv, ...resolved };

    const seen = await readEnvVarInChild(childEnv, 'AWS_SESSION_TOKEN');

    expect(seen).toBe('');
    expect(seen).not.toBe('ambient-sso-session-token');
  });

  it('should let the ambient value leak through the identical merge when the key is merely omitted instead of explicitly cleared', async () => {
    // This is what "not merely omitted" in the spec is guarding against —
    // proves the explicit-empty-string mechanism is load-bearing, not
    // redundant with the merge itself.
    const ambientEnv: NodeJS.ProcessEnv = { ...process.env, AWS_PROFILE: 'ambient-shell-profile' };
    const naiveEnvVars: Record<string, string> = { AWS_ACCESS_KEY_ID: 'AKID123', AWS_SECRET_ACCESS_KEY: 'SECRET456' };
    // No AWS_PROFILE key at all in naiveEnvVars — the "just don't add it" approach.

    const childEnv = { ...ambientEnv, ...naiveEnvVars };

    const seen = await readEnvVarInChild(childEnv, 'AWS_PROFILE');

    expect(seen).toBe('ambient-shell-profile'); // leaked through — proves clearing is necessary
  });
});
