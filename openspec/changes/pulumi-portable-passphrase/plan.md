# Implementation Plan: pulumi-portable-passphrase

## Overview

`PulumiWorkspaceService.getOrCreateStack` currently generates a random
32-byte passphrase once per machine and stores it in the OS keychain via
`ElectronStoreService`/`SafeStorageService`. A second machine pointed at the
same S3 state bucket has no local record of that passphrase, and
`resolveNewPassphrase` deliberately refuses to generate a replacement
(`PulumiPassphraseUnavailableError`, reason `existing-stack-no-local-record`)
because a fresh passphrase could never decrypt the existing stack's state.
This blocks every Pulumi operation on a second/replacement machine.

This plan replaces the stored, random passphrase with a passphrase
**deterministically derived** from the AWS account ID (via STS
`GetCallerIdentity`) and the fixed stack name, recomputed on every call and
never persisted. Any machine authenticated to the same AWS account derives
the same passphrase, so `Stack.createOrSelect` can be called directly with no
"does this exist locally / does this exist remotely" branching. Existing
installs migrate automatically and silently the first time they run under
the new code. `secretsProvider` stays `'passphrase'` — only the passphrase
*source* changes.

Full rationale lives in `openspec/changes/pulumi-portable-passphrase/design.md`
(decisions D1–D4, risks, migration plan) — this plan does not repeat it,
only turns it into ordered, verifiable steps.

### Two things this plan adds beyond `tasks.md`, found during research

`tasks.md` and `design.md` were written before the actual code was
re-inspected line-by-line for this plan. Two concrete gaps surfaced that materially
change the shape of Task 3 and Task 4 below — both are called out inline at
the step that addresses them, not left implicit:

1. **`Stack.changeSecretsProvider` does not exist** in the pinned
   `@pulumi/pulumi@3.255.0` Automation API TypeScript SDK (confirmed by
   grepping `node_modules/@pulumi/pulumi/automation/*.d.ts` — `Stack`'s
   public method list has no `changeSecretsProvider`; the CLI-invocation
   plumbing (`Stack.prototype.runPulumiCmd`, `PulumiCommand.prototype.run`)
   that every other `Stack` method (`up`, `refresh`, `destroy`, `import`,
   `rename`...) uses internally to shell out to the `pulumi` CLI is declared
   `private` in `stack.d.ts`/`cmd.d.ts`, so it isn't part of the supported
   public surface either). Task 3 opens with a spike step to nail down the
   actual non-interactive invocation contract before any code is written
   against it.
2. **`pulumi.passphrase !== undefined` is used as a "has a stack ever been
   created on this install" signal in three places in `PulumiService.ts`**
   (`getStackOutputs` line 1062, `destroy` line 3761, `clearStaleLock` line
   4621) — none of which are `PulumiWorkspaceService`, and none of which
   `tasks.md`/`design.md` mention. Once the derived passphrase stops being
   stored for new stacks, this check is permanently `false` and those three
   methods silently misbehave (`getStackOutputs` always returns `null`;
   `destroy`/`clearStaleLock` always throw "no stack has ever been created").
   Task 2 introduces a plain, non-secret `pulumi.stackInitialized: boolean`
   flag as a like-for-like replacement for exactly this local bookkeeping
   role (not a re-introduction of the passphrase-portability problem — see
   that step's own note for why).

---

## Task 1: Passphrase derivation + AWS account ID resolution

Implements `tasks.md` §1 and the delta spec's "derive the passphrase
deterministically from the AWS account ID... and the stack name, using a
fixed app-level derivation constant" requirement text (`specs/pulumi-engine-runtime/spec.md`).

### Step 1.1: Add the derivation constant and `deriveStackPassphrase`

**Files:**
- Modify: `app/packages/desktop-main/src/services/PulumiWorkspaceService.ts`

**Interfaces:**
```ts
/**
 * Fixed HMAC key {@link deriveStackPassphrase} uses to turn an AWS account ID
 * and stack name into a reproducible secrets passphrase. FROZEN once
 * shipped — see {@link deriveStackPassphrase}'s doc comment for why changing
 * this value later is equivalent to a breaking migration and must be treated
 * as one (every already-migrated install's stack is encrypted under a
 * passphrase derived using this exact string).
 */
export const PULUMI_PASSPHRASE_DERIVATION_SALT = 'hyveon:pulumi-stack-passphrase:v1';

/**
 * Deterministically derives this install's Pulumi secrets passphrase from
 * the AWS account ID the current operation is authenticated against and the
 * (always-fixed) stack name, so any machine holding valid credentials for
 * the same AWS account derives the identical value — the portability
 * mechanism the `pulumi-engine-runtime` delta spec's "A second machine
 * operates on an existing stack" scenario requires. Computed fresh on every
 * `getOrCreateStack` call; the result is never written to
 * `ElectronStoreService` or anywhere else on disk.
 *
 * @remarks
 * This is HMAC-SHA256, not a general-purpose KDF (scrypt/argon2/bcrypt) —
 * deliberately, because {@link PULUMI_PASSPHRASE_DERIVATION_SALT} is not a
 * confidentiality boundary and the input space (`accountId` + `stackName`)
 * is not attacker-guessable low-entropy secret material the way a
 * user-chosen password would be; it is two identifiers already visible to
 * anyone with read access to the AWS account. Per the delta spec: "The
 * passphrase MUST NOT be treated as a confidentiality boundary — the
 * infrastructure program does not mark any Pulumi stack config or output as
 * secret." HMAC-SHA256 buys determinism and collision resistance, which is
 * all this needs.
 *
 * @param accountId - The 12-digit AWS account ID from
 *   `sts:GetCallerIdentity`'s `Account` field (see {@link resolveAwsAccountId}).
 * @param stackName - The Pulumi stack name (always {@link PULUMI_STACK_NAME}
 *   in production; parameterized here only so unit tests can assert
 *   different-input/different-output without a real STS call).
 * @returns A 64-character lowercase hex string (the raw HMAC-SHA256 digest).
 */
export function deriveStackPassphrase(accountId: string, stackName: string): string {
  return createHmac('sha256', PULUMI_PASSPHRASE_DERIVATION_SALT)
    .update(accountId + stackName)
    .digest('hex');
}
```
Add `createHmac` to the existing `import { randomBytes } from 'node:crypto';`
line's specifier list — it becomes `import { createHmac } from 'node:crypto';`
once `randomBytes`/`generatePassphrase` are deleted in Task 4 (don't delete
`randomBytes` yet in this step; Task 4 removes it together with
`generatePassphrase`).

**Step 1 (RED):** In `PulumiWorkspaceService.test.ts`, add a new top-level
`describe('deriveStackPassphrase', ...)` block (not nested under
`getOrCreateStack`, since this is now a pure exported function) with:
- `it('should return the exact pinned digest for a fixed accountId/stackName pair, regression-pinning the derivation salt')` —
  hard-code a real `accountId`/`stackName` pair and assert the exact 64-char
  hex output. Compute the expected value once via a scratch Node REPL/script
  using the real constant and implementation, then hard-code the *result*
  (not the computation) into the test, so the test fails if the salt or
  concatenation order ever changes silently. Import `deriveStackPassphrase`,
  which doesn't exist yet — compile/import failure is the RED state.
- `it('should produce a different passphrase for a different accountId, same stackName')`
- `it('should produce a different passphrase for a different stackName, same accountId')`
- `it('should always return a 64-character lowercase hex string')`

Run `npm run app:test -- PulumiWorkspaceService` — new tests fail to import.

**Step 2 (GREEN):** Add the constant + function above. Re-run — all four
pass.

**Step 3 (REFACTOR):** None expected — this is a 3-line pure function.

### Step 1.2: Add `resolveAwsAccountId`, reusing the existing credential-resolution seam

Reuses `resolveAwsClientCredentials` from `awsCredentialSource.ts` — the
function `IamCheckService`/`BootstrapService`/`AwsProfileService`'s own
callers already share for "give me an `@aws-sdk/client-*`-shaped
`credentials` value for whichever source the wizard selected" — rather than
duplicating `AwsProfileService`'s `createStsClient`, which only covers the
pasted-keys case (it's used exclusively by `rotateActiveCredentials`, which
by construction only ever runs against a `kind: 'pasted'` source). Confirmed
by reading `awsCredentialSource.ts:143-191`: `resolveAwsClientCredentials`
already branches `pasted` → static keys, `profile` → `fromIni({ profile })`,
`none` → `undefined` — exactly the two real cases `PulumiWorkspaceService`
needs and the one case (`none`) that never reaches this point anyway (see
below).

**Files:**
- Modify: `app/packages/desktop-main/src/services/PulumiWorkspaceService.ts`

**Interfaces:**
```ts
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { resolveAwsClientCredentials } from './awsCredentialSource.js';

/**
 * Resolves the AWS account ID the currently-configured credential source
 * (the same one {@link resolveCredentialEnvVars} resolves for the Pulumi
 * engine's own child-process environment — see {@link getOrCreateStack})
 * authenticates against, via `sts:GetCallerIdentity`. Feeds
 * {@link deriveStackPassphrase}'s `accountId` parameter.
 *
 * @remarks
 * Deliberately does not itself throw a typed "no credential source
 * configured" error — {@link getOrCreateStack} already calls
 * `resolveCredentialEnvVars(this.store)` earlier in the same method for the
 * exact same store, which throws `PulumiCredentialsNotConfiguredError`
 * first if nothing is selected. This function is only ever reached once that
 * call has already succeeded, so `resolveAwsClientCredentials` is
 * guaranteed not to return the `undefined` ("no profile stored") case here
 * in practice — the type still allows it (this function's own `store`
 * argument doesn't know what the caller already checked), so a defensive
 * throw is kept for that branch rather than silently constructing an
 * `STSClient` with no credentials and letting the SDK's own default
 * provider-chain fallback obscure the real cause.
 *
 * @param store - Resolves the active AWS credential source (same store
 *   `getOrCreateStack` already has).
 * @param region - Region for the `STSClient` — `GetCallerIdentity` is a
 *   global/region-agnostic STS action, but the SDK still requires a region
 *   to construct the client; `input.stateBucketRegion` is reused rather than
 *   introducing a second region concept.
 * @param stsClientFactory - Test seam — defaults to `(config) => new
 *   STSClient(config)`; tests inject a stub that returns a client whose
 *   `send` is `vi.fn()`.
 * @throws `Error` if no credential source is configured (defensive only —
 *   see remarks above) or if the `GetCallerIdentity` response has no
 *   `Account` field.
 * @throws Raw AWS SDK errors from `sts:GetCallerIdentity` propagate
 *   unchanged — `getOrCreateStack`'s existing single try/catch around the
 *   SDK calls it makes does not wrap this call (see Step 2.1), so a
 *   credentials/network failure here surfaces as-is, matching how every
 *   other pre-engine failure in this method already behaves.
 */
export async function resolveAwsAccountId(
  store: ElectronStoreService,
  region: string,
  stsClientFactory: (config: { region: string; credentials: AwsClientCredentials }) => STSClient = (config) =>
    new STSClient(config),
): Promise<string> {
  const credentials = resolveAwsClientCredentials(store);
  const client = stsClientFactory({ region, credentials });
  const response = await client.send(new GetCallerIdentityCommand({}));
  if (!response.Account) {
    throw new Error('sts:GetCallerIdentity did not return an AWS account ID.');
  }
  return response.Account;
}
```
Import `AwsClientCredentials` as a type from `./awsCredentialSource.js`
alongside the existing `resolveCredentialEnvVars` import already in this
file.

**Step 1 (RED):** New `describe('resolveAwsAccountId', ...)` block in
`PulumiWorkspaceService.test.ts`:
- `it('should return the Account field from a successful GetCallerIdentity call')` —
  build a store with `store.set('aws', { region: 'us-west-2', profile: 'personal' })`
  (mirrors this file's existing pattern), inject a `stsClientFactory` stub
  whose `send` resolves `{ Account: '123456789012' }`, assert the return
  value.
- `it('should pass the resolved credentials (pasted keys) to the STS client factory')` —
  seed `store.setPastedCredentials(...)`, assert the factory was called with
  `{ region, credentials: { accessKeyId, secretAccessKey } }`.
- `it('should pass fromIni-shaped credentials to the STS client factory for a profile source')` —
  assert the factory's `credentials` argument is the object `fromIni`
  returns (a function) rather than asserting its internal shape, mirroring
  how `awsCredentialSource.ts`'s own doc comment describes it.
- `it('should throw when GetCallerIdentity resolves with no Account field')`
- `it('should propagate a raw STS client error unchanged')`

Run `npm run app:test -- PulumiWorkspaceService` — fails to import.

**Step 2 (GREEN):** Add the function. Re-run — passes.

**Step 3 (REFACTOR):** None expected.

**Commit point:** none yet — Task 1's new exports aren't wired into
`getOrCreateStack` until Task 2; committing here would leave dead (if
correct) code. Continue to Task 2 in the same working session.

---

## Task 2: Rewire `getOrCreateStack`

Implements `tasks.md` §2 and the delta spec's "Passphrase is present before
stack creation" and "A second machine operates on an existing stack"
scenarios.

### Step 2.1: Replace the three-path resolution with derive-then-`createOrSelect`

**Files:**
- Modify: `app/packages/desktop-main/src/services/PulumiWorkspaceService.ts`

Current control flow (see the file's lines 363–464) to replace:
1. Fast path: `hasStoredPassphrase` → `resolveStoredPassphrase()`.
2. Else: `safeStorage.isAvailable()` check → throw if unavailable.
3. Resolve credentials, engine, backend URL, build `LocalWorkspace`.
4. `passphrase ??= await this.resolveNewPassphrase(ws)` (the `listStacks()`
   probe).
5. `ws.envVars['PULUMI_CONFIG_PASSPHRASE'] = passphrase`.
6. `Stack.createOrSelect(PULUMI_STACK_NAME, ws)`.

New control flow:
1. `backendReady` check (unchanged, first line of the method).
2. **Migration check** — see Task 3; inserted here, before credential
   resolution, since it needs its own `getOrCreateStack`-shaped workspace
   construction under the *legacy* passphrase first. Written as Task 3 so
   this step's diff stays reviewable on its own; the two land as one
   commit-worthy unit in practice since Task 3 physically sits inside this
   same method body.
3. Resolve credentials (`resolveCredentialEnvVars`), unchanged position/logic.
4. Resolve engine, `pulumiHome`/`workDir`, backend URL, `envVars` object —
   unchanged.
5. **New:** `const accountId = await resolveAwsAccountId(this.store, input.stateBucketRegion);`
   then `const passphrase = deriveStackPassphrase(accountId, PULUMI_STACK_NAME);`
   — placed after `engineStartedAt`/before `LocalWorkspace.create`, since
   unlike the old code this no longer needs a constructed `LocalWorkspace`
   to decide anything (no more `listStacks()` probe).
6. Build `opts` with `envVars` already including
   `PULUMI_CONFIG_PASSPHRASE: passphrase` set directly (no more post-hoc
   `ws.envVars[...] = passphrase` mutation after the fact — the value is
   known before `LocalWorkspace.create` is even called now).
7. `const ws = await LocalWorkspace.create(opts);` then
   `const stack = await Stack.createOrSelect(PULUMI_STACK_NAME, ws);`
   directly — no `listStacks()` call.
8. Existing `try/catch` → `looksLikeMissingBucket` reclassification stays,
   now wrapping steps 5–7 instead of steps 3–6 (the account-ID/STS call is
   a new failure surface inside that same try — an STS failure does not
   look like a missing-bucket error, so it will fall through
   `looksLikeMissingBucket` and propagate unchanged, which is correct: it's
   a credentials problem, not a backend-bootstrap problem).

**Interfaces (method body sketch, replacing lines 363–464):**
```ts
async getOrCreateStack(input: PulumiWorkspaceInput): Promise<Stack> {
  if (!input.backendReady) {
    throw new PulumiBackendNotBootstrappedError(input.stateBucket);
  }

  const credentialEnvVars = input.credentialEnvVars ?? resolveCredentialEnvVars(this.store);

  const engineStartedAt = Date.now();
  const pulumiCommand = await this.engine.resolve(input.onPhase);
  logger.debug('PulumiWorkspaceService: engine resolved', { elapsedMs: Date.now() - engineStartedAt });
  const pulumiHome = this.ensureDir(this.getPulumiHomeDir());
  const workDir = this.ensureDir(this.getWorkDir());
  logger.debug('PulumiWorkspaceService: resolved workspace paths', { pulumiHome, workDir });

  const backendUrl = `s3://${input.stateBucket}?region=${encodeURIComponent(input.stateBucketRegion)}`;

  const accountId = await resolveAwsAccountId(this.store, input.stateBucketRegion);
  const passphrase = deriveStackPassphrase(accountId, PULUMI_STACK_NAME);

  const envVars: LocalWorkspaceOptions['envVars'] = {
    ...credentialEnvVars,
    PULUMI_BACKEND_URL: backendUrl,
    PULUMI_SKIP_UPDATE_CHECK: 'true',
    AWS_REGION: input.stateBucketRegion,
    PULUMI_CONFIG_PASSPHRASE: passphrase,
  };

  const opts: LocalWorkspaceOptions = {
    pulumiCommand,
    pulumiHome,
    workDir,
    secretsProvider: 'passphrase',
    envVars,
    program: input.program,
    projectSettings: this.resolveInlineProjectSettings(workDir),
  };

  try {
    const createStartedAt = Date.now();
    const ws = await LocalWorkspace.create(opts);
    logger.debug('PulumiWorkspaceService: LocalWorkspace created', { elapsedMs: Date.now() - createStartedAt });
    const stackStartedAt = Date.now();
    const stack = await Stack.createOrSelect(PULUMI_STACK_NAME, ws);
    logger.debug('PulumiWorkspaceService: stack created/selected', { elapsedMs: Date.now() - stackStartedAt });
    this.store.set('pulumi', { ...(this.store.get('pulumi') ?? {}), stackInitialized: true });
    return stack;
  } catch (err) {
    if (looksLikeMissingBucket(err)) {
      throw new PulumiBackendNotBootstrappedError(input.stateBucket, err);
    }
    throw err;
  }
}
```
Note: `this.store.set('pulumi', ...)` after a successful
`createOrSelect` is the **new `stackInitialized` flag** flagged in the
Overview — see Step 2.2 for its full justification and schema change; this
step just shows where the write happens (only on the success path, mirroring
the old code's "only persist after a real stack operation succeeded"
discipline).

Also update `getOrCreateStack`'s own doc comment (the large block above the
method, lines 315–362) to drop every reference to `resolveStoredPassphrase`/
`resolveNewPassphrase`/the "Call order" section describing the
stored-vs-generate-vs-probe branching — replace with a short paragraph
describing derive-then-`createOrSelect`, referencing Task 3's migration step.
Also update the class-level doc comment (lines 276–306) bullet describing
"Passphrase generation, storage... and fail loudly, never regenerate"
semantics.

### Step 2.2: Add `pulumi.stackInitialized` to the store schema

This is the fix for the gap flagged in the Overview: `PulumiService.ts` uses
`this.store.get('pulumi')?.passphrase !== undefined` in three places
(`getStackOutputs:1062`, `destroy:3761`, `clearStaleLock:4621`) purely as a
local "has this install ever successfully created/selected a stack" signal —
unrelated to the passphrase's cryptographic role. Once the passphrase is
derived rather than stored, that signal is permanently absent. A plain
boolean flag, written on every successful `getOrCreateStack` call (idempotent,
mirrors the old code's every-first-creation write), is a like-for-like
replacement for this narrow bookkeeping role — **not** a reintroduction of
the per-machine portability problem this whole change fixes: the passphrase
itself is still never stored, only a "this install has interacted with a
stack" marker, which is exactly as informative (and exactly as
locally-scoped) as the field it replaces. `FirstRunWizardService.reset()`
already deliberately does not touch `pulumi.*` (confirmed at
`FirstRunWizardService.ts:194-202`, "Deliberately does NOT touch `pulumi.*`")
so this flag persists across a wizard reset exactly like the old passphrase
field did.

**Files:**
- Modify: `app/packages/desktop-main/src/services/ElectronStoreService.ts`

**Interfaces:**
```ts
pulumi?: {
  /**
   * Set once `getOrCreateStack` has successfully created/selected the
   * stack at least once on this install. Purely local bookkeeping for
   * "has anything ever been deployed from here" — used by
   * `PulumiService.getStackOutputs`/`destroy`/`clearStaleLock` to give a
   * clear "nothing to do yet" error/null instead of attempting a real
   * Pulumi operation against a stack that (as far as this install knows)
   * was never created. NOT a substitute for checking the real backend —
   * see `PulumiWorkspaceService.getOrCreateStack`'s doc comment for why
   * that check was deliberately removed as a per-operation network
   * round-trip once the passphrase became derived rather than stored;
   * this flag exists only for the three UX-guard call sites above, not for
   * passphrase resolution.
   */
  stackInitialized?: boolean;
  /** @deprecated Read-only during the one-time legacy migration (see `PulumiWorkspaceService.migrateLegacyPassphrase`) — never written by new code. Removed entirely in a future change once no installs can still hold a legacy value. */
  passphrase?: string;
  lockOwnership?: Record<string, PulumiLockOwnershipRecord>;
  orphanedRollback?: OrphanedRollbackRecord;
};
```
Keep `passphrase?: string` in the type (marked `@deprecated`, per
`tasks.md` §4.2's "keep the field readable during migration, remove the
write/generate paths") — Task 3's migration step still needs to read it via
`this.store.get('pulumi')?.passphrase` and `getPulumiPassphrase()`. Task 4
removes the type field once the migration-reading code path itself is also
proven safe to keep (this plan never removes the *type*, only confirms no
non-migration code still *writes* it — see Task 4's own note on this).

**Step 1 (RED):** In `ElectronStoreService.test.ts`, find the existing
`describe`/tests around `getPulumiPassphrase`/`setPulumiPassphrase` (the file
already groups `pulumi.*` accessor tests together) and add:
- `it('should round-trip pulumi.stackInitialized via plain get/set, unencrypted')` —
  `store.set('pulumi', { stackInitialized: true }); expect(store.get('pulumi')?.stackInitialized).toBe(true);`
  (mirrors the existing `lockOwnership`/`orphanedRollback` plaintext-field
  test pattern in this file — grep `orphanedRollback` in the test file for
  the exact shape to mirror).

Run `npm run app:test -- ElectronStoreService` — fails (property doesn't
exist on the type, `tsc`/vitest's type-check-on-run catches it, or the field
is simply always `undefined` at runtime if the type system doesn't block
it — either way, the assertion fails).

**Step 2 (GREEN):** Add the field to the schema. Re-run — passes.

**Step 3:** Wire the write into `getOrCreateStack` per Step 2.1's sketch
above.

**Step 4 (RED → GREEN) — `PulumiWorkspaceService.test.ts`:**
- `it('should set pulumi.stackInitialized after successfully creating/selecting a stack')` —
  call `getOrCreateStack`, then assert `store.get('pulumi')?.stackInitialized`
  is `true`.
- `it('should not set pulumi.stackInitialized when createOrSelect fails')` —
  reuse this file's existing `createOrSelectMock.mockRejectedValueOnce(...)`
  pattern (see the "backend-not-bootstrapped" describe block), assert the
  flag is still `undefined` afterward.

### Step 2.3: Update/replace the `getOrCreateStack` describe blocks that assumed the old three-path resolution

**Files:**
- Modify: `app/packages/desktop-main/src/services/PulumiWorkspaceService.test.ts`

Per `tasks.md` §2.2, cover exactly three scenarios with the SAME derived
value:

- `it('should derive and use a passphrase on first-ever stack creation, with no listStacks probe')` —
  replaces the "passphrase generated once and reused" describe block's
  first test. Assert `createOrSelectWs().envVars['PULUMI_CONFIG_PASSPHRASE']`
  equals `deriveStackPassphrase(accountId, PULUMI_STACK_NAME)` for whatever
  fixed `accountId` the test's STS stub returns, AND that `ws.listStacks`
  (if the fake workspace object still exposes it) is never called — this
  file's `FakeWorkspace` interface currently declares `listStacks:
  ReturnType<typeof vi.fn>` as a required field; once `resolveNewPassphrase`
  is deleted in Task 4, decide whether to drop `listStacks` from
  `FakeWorkspace`/`createMock`'s implementation entirely (cleaner — nothing
  in production code calls it anymore) or leave it present-but-unasserted.
  Prefer dropping it: a field on a test fixture that nothing under test ever
  reads is exactly the kind of stale-mock hazard this file's own doc
  comment (lines 1–35) explicitly walks through avoiding.
- `it('should select an already-existing stack on the SAME machine, deriving the identical passphrase as the prior call')` —
  call `getOrCreateStack` twice with the same store/STS stub, assert both
  calls' `PULUMI_CONFIG_PASSPHRASE` are equal (this is now true by
  construction — same `accountId`/`stackName` in, same output — but keep the
  test as a regression guard against something like an accidental per-call
  nonce sneaking into the derivation later).
- `it('should select an already-existing stack from a SECOND machine with no local passphrase record, deriving the identical passphrase without error')` —
  **replaces** the "Finding 1 (final review): reinstall / wiped userData /
  second machine..." describe block, which currently asserts a THROW
  (`PulumiPassphraseUnavailableError`, `existing-stack-no-local-record`).
  Under the new model this must now assert SUCCESS: build a fresh store with
  no `pulumi` key at all (mirrors the old test's setup), stub STS to return
  the same `accountId` the "first machine" test used, assert
  `createOrSelectMock` is called and the resulting `PULUMI_CONFIG_PASSPHRASE`
  matches the deterministic value — this is the literal regression test for
  the bug this whole change fixes.

Also delete or rewrite every test in the following existing describe blocks,
since they assert behavior that no longer exists:
- `'PulumiWorkspaceService.getOrCreateStack — passphrase generated once and reused'` →
  merge into the three tests above.
- `'PulumiWorkspaceService.getOrCreateStack — missing passphrase for an existing stack fails loudly (spec-critical)'` →
  **delete entirely** (Task 4 removes the underlying error type/reasons this
  whole block exists to exercise — see Task 4.3).
- The `'elapsed-time logging'` describe block's `'should log elapsedMs
  around the listStacks probe...'` test → delete (no more `listStacks`
  call, hence no more `'PulumiWorkspaceService: listStacks resolved'` log
  line).

Run `npm run app:test -- PulumiWorkspaceService` after each rewrite — full
green before moving to Task 3 (Task 3's migration tests are additive on top
of this).

**Commit point:** `git add app/packages/desktop-main/src/services/PulumiWorkspaceService.ts app/packages/desktop-main/src/services/PulumiWorkspaceService.test.ts app/packages/desktop-main/src/services/ElectronStoreService.ts app/packages/desktop-main/src/services/ElectronStoreService.test.ts` then commit
(e.g. `feat(infra): derive the Pulumi secrets passphrase from the AWS account instead of storing it`) —
this is a coherent, independently-testable unit even before Task 3's
migration logic exists (a fresh install with no legacy passphrase works
end-to-end at this point; only upgrade-in-place installs are unhandled until
Task 3 lands). Do not run `git commit` yourself if you are an agent
executing this plan on someone else's behalf without explicit instruction to
commit — confirm with the operator first per this repo's standing git rules.

---

## Task 3: Legacy migration

Implements `tasks.md` §3 and the delta spec's "A legacy per-machine
passphrase is migrated automatically" / "Legacy migration is retried after a
failed re-encryption" scenarios.

### Step 3.0 (spike, not TDD): Determine the non-interactive re-encryption mechanism

**This step must be completed, with its finding written into this plan file
(replacing this paragraph) or into a short note in the PR description, before
Step 3.1's tests are written** — the exact API/CLI surface used changes what
"success" and "failure" look like to test against, so writing tests first
here would mean guessing at a mock shape that may not match reality.

The problem: `Stack.changeSecretsProvider` doesn't exist in this SDK version
(confirmed — see Overview). Re-encryption fundamentally means rewriting the
`secrets_providers` block of the stack's checkpoint in the S3-backed state
(the salt/verification material the passphrase is checked against), which
is not something `Stack.exportStack()`/`importStack()` (the two genuinely
public state-transfer methods) touch — they round-trip the checkpoint
byte-for-byte, `secrets_providers` included, so export-under-old/import-under-new
would NOT actually re-key anything. The only implementation of this rewrite
that exists is the `pulumi` CLI's own `pulumi stack change-secrets-provider
<provider>` command.

Concrete actions for whoever executes this step:
1. Resolve the pinned engine binary the same way `PulumiEngineService`
   already does in this repo, and run
   `<resolved-pulumi-binary> stack change-secrets-provider --help` from a
   scratch directory to read the command's actual flags/prompts directly
   from the pinned CLI version — do not rely on memory or generic Pulumi
   docs, since exact non-interactive behavior (env vars vs. forced stdin
   prompts) has changed across CLI versions historically.
2. Determine: does the command accept the NEW passphrase via any documented
   environment variable, or does it always prompt on stdin for the new value
   (with confirmation) even when `PULUMI_CONFIG_PASSPHRASE` supplies the OLD
   one? If stdin is required, plan to invoke the CLI via `execa` (already an
   indirect dependency of this repo via `@pulumi/pulumi`, but not currently
   a direct dependency of `@hyveon/desktop-main` — check the npm registry
   for the current latest `execa` release before adding it as a direct
   dependency per this repo's dependency-freshness rule, and verify it is
   still CommonJS-compatible / matches the ESM/CJS interop this file's own
   top-of-file comment already documents for `@pulumi/pulumi/automation` —
   `execa@6+` is pure ESM and may need different import handling than the
   `execa@5.x` this repo's lockfile currently resolves transitively) with
   `input` piping the old passphrase (only if not already satisfied via env),
   then the new passphrase twice (entry + confirmation), matching whatever
   the `--help` output / a manual interactive run reveals the actual prompt
   sequence to be.
3. Confirm the invocation must run with `--stack <name> --cwd <workDir>`
   (or equivalent) plus the SAME `PULUMI_BACKEND_URL`/`AWS_REGION`/credential
   env vars `getOrCreateStack` already builds — the command needs to reach
   the same S3-backed state the rest of this service operates against, not
   some default local backend.
4. Write the concrete function signature and the exact args/env/stdin
   sequence discovered into `PulumiWorkspaceService.ts`'s new
   `migrateLegacyPassphrase` doc comment (Step 3.1 below) as findings, not
   assumptions.

### Step 3.1: Add the migration function

**Files:**
- Modify: `app/packages/desktop-main/src/services/PulumiWorkspaceService.ts`

**Interfaces (shape — exact CLI invocation body depends on Step 3.0's finding):**
```ts
/**
 * One-time, automatic migration for an install that still holds a legacy
 * randomly-generated passphrase in `pulumi.passphrase` (pre-dates this
 * derivation scheme). Re-encrypts the stack's secrets provider from the
 * legacy value to `newPassphrase` via the `pulumi` CLI's
 * `stack change-secrets-provider` command (see Step 3.0's spike finding for
 * the exact invocation — {@link PulumiWorkspaceService} has no public
 * Automation API method for this; `Stack.exportStack`/`importStack` do not
 * rewrite the checkpoint's secrets-provider block).
 *
 * MUST be called with the same `pulumiCommand`/`pulumiHome`/`workDir`/
 * `envVars` (backend URL, region, credentials) `getOrCreateStack` is about
 * to use for the real operation, so re-encryption targets the same S3
 * state — a mismatched backend/region would silently re-key a different
 * (or nonexistent) stack.
 *
 * Deletes the legacy `pulumi.passphrase` store entry ONLY after re-encryption
 * succeeds — see this method's own try/catch: any failure (network,
 * malformed CLI output, non-zero exit) leaves the legacy entry untouched, so
 * the NEXT `getOrCreateStack` call retries this same migration with the same
 * still-valid legacy passphrase, per the delta spec's "Legacy migration is
 * retried after a failed re-encryption" scenario.
 *
 * A no-op (returns immediately, does nothing) when
 * `store.get('pulumi')?.passphrase` is `undefined` — the overwhelmingly
 * common case for every install created after this change ships.
 *
 * @param legacyPassphrase - Decrypted legacy passphrase, read by the caller
 *   via {@link ElectronStoreService.getPulumiPassphrase} before this is
 *   called (mirrors `resolveStoredPassphrase`'s old decrypt-then-use
 *   pattern — this function never touches `SafeStorageService` itself).
 * @param newPassphrase - The freshly {@link deriveStackPassphrase}-derived
 *   value the caller is about to use for the real operation.
 * @param ctx - `pulumiCommand`/`pulumiHome`/`workDir`/`envVars` (sans
 *   `PULUMI_CONFIG_PASSPHRASE`, which this function sets itself per-call to
 *   whichever of `legacyPassphrase`/`newPassphrase` a given sub-step needs).
 * @throws A plain `Error` (never a raw child-process/SDK error — normalized
 *   per `.claude/rules/logging.md`) if the CLI invocation fails. The legacy
 *   store entry is left in place in every throw case.
 */
private async migrateLegacyPassphrase(
  legacyPassphrase: string,
  newPassphrase: string,
  ctx: { pulumiCommand: PulumiCommand; pulumiHome: string; workDir: string; envVars: Record<string, string> },
): Promise<void> {
  // Body per Step 3.0's finding.
}
```

Call site — inserted into `getOrCreateStack`, right after `pulumiHome`/
`workDir`/`pulumiCommand` are resolved (needs them for the CLI invocation)
but BEFORE the real `LocalWorkspace.create`/`Stack.createOrSelect` calls that
use the NEW passphrase, since migration must complete first:
```ts
const legacyPassphrase = this.store.get('pulumi')?.passphrase !== undefined
  ? this.store.getPulumiPassphrase()
  : undefined;
if (legacyPassphrase !== undefined) {
  await this.migrateLegacyPassphrase(legacyPassphrase, passphrase, {
    pulumiCommand, pulumiHome, workDir,
    envVars: { ...credentialEnvVars, PULUMI_BACKEND_URL: backendUrl, AWS_REGION: input.stateBucketRegion },
  });
  const current = this.store.get('pulumi') ?? {};
  const { passphrase: _removed, ...rest } = current;
  this.store.set('pulumi', rest);
  logger.debug('PulumiWorkspaceService: migrated legacy passphrase to derived value', {
    stackName: PULUMI_STACK_NAME,
  });
}
```
(Per `.claude/rules/logging.md`: this is the one required `logger.debug` on
successful migration, non-secret identifiers only — `stackName`, never
either passphrase value.) Note `getPulumiPassphrase()` can itself throw if
the keychain is unavailable or the ciphertext is corrupt (mirrors the old
`resolveStoredPassphrase`'s two failure reasons) — that throw propagates
unchanged; per the migration plan's rollback note, an install that can't
even read its legacy entry simply keeps failing until the keychain/entry
issue is fixed, exactly as it did before this change (no regression, just no
new masking of a pre-existing failure mode).

### Step 3.2: Tests

**Files:**
- Modify: `app/packages/desktop-main/src/services/PulumiWorkspaceService.test.ts`

New `describe('PulumiWorkspaceService.getOrCreateStack — legacy passphrase migration', ...)`:

- `it('should re-encrypt via the CLI and remove the legacy store entry when a legacy passphrase is present')` —
  seed `store.setPulumiPassphrase('legacy-value')`, stub whatever Step 3.0
  determined the CLI-invocation seam to be (mocked at the same boundary
  `createMock`/`createOrSelectMock` already mock — i.e. mock the specific
  function/module Step 3.0's implementation calls, not a real child
  process), assert: the mock was invoked with the legacy AND newly-derived
  passphrases in the right roles, `store.get('pulumi')?.passphrase` is
  `undefined` afterward, and the real operation still proceeds
  (`createOrSelectMock` still gets called with the NEW derived passphrase).
- `it('should log stack name only, never either passphrase value, on successful migration')` —
  mirrors this file's existing "credentials are not logged" pattern; assert
  `loggerMock.debug` was called with the migration message and that no
  logger call anywhere contains either passphrase string.
- `it('should leave the legacy passphrase in the store when re-encryption fails, so the next call retries with the same value')` —
  make the CLI-invocation mock reject; assert `getOrCreateStack` itself
  rejects (or however Step 3.0's function surfaces failure), assert
  `store.get('pulumi')?.passphrase` is UNCHANGED (still the legacy
  ciphertext), then call `getOrCreateStack` again with the mock now
  succeeding and assert THIS second call succeeds and clears the entry —
  the literal "safely retryable" regression test.
- `it('should not attempt migration at all when no legacy passphrase is stored')` —
  assert the CLI-invocation mock is never called for a store with no
  `pulumi.passphrase` (the common post-migration/fresh-install case).

Run `npm run app:test -- PulumiWorkspaceService` — RED, then implement Step
3.1's body per Step 3.0's finding, then GREEN.

**Commit point:**
`feat(infra): migrate installs with a legacy stored Pulumi passphrase to the derived one automatically` —
independent, reviewable unit on top of Task 2's commit.

---

## Task 4: Remove dead code and fix every remaining call site

Implements `tasks.md` §4, expanded with the `PulumiService.ts` findings from
the Overview.

### Step 4.1: Delete the dead passphrase machinery in `PulumiWorkspaceService.ts`

**Files:**
- Modify: `app/packages/desktop-main/src/services/PulumiWorkspaceService.ts`

Delete:
- `PASSPHRASE_ENTROPY_BYTES` constant.
- `PulumiPassphraseUnavailableReason` type and its four reason literals.
- `PulumiPassphraseUnavailableError` class.
- `describePassphraseUnavailableReason` function.
- `resolveStoredPassphrase` method.
- `resolveNewPassphrase` method.
- `generatePassphrase` method.
- The `randomBytes` import (now unused).
- The file-top comment block explaining why `Stack` is imported as a value
  "since `resolveNewPassphrase`... calls `Stack.createOrSelect` directly" —
  rewrite to state the real (now simpler, permanent) reason: `Stack` is
  still imported as a value because `Stack.createOrSelect` is called
  directly rather than through `LocalWorkspace.createOrSelectStack`'s
  convenience wrapper (this part of the old rationale — needing
  `resolveInlineProjectSettings` — is unchanged and still true; only the
  "so it can query listStacks()" clause is now false and must go).

### Step 4.2: Fix `PulumiService.ts`'s three `pulumi.passphrase`-as-existence checks

**Files:**
- Modify: `app/packages/desktop-main/src/services/PulumiService.ts`

Replace all three occurrences of
`this.store.get('pulumi')?.passphrase !== undefined` with
`this.store.get('pulumi')?.stackInitialized === true`:
- `getStackOutputs` (line 1062, variable `hasStoredPassphrase` — rename to
  `stackInitialized` for accuracy while touching this line).
- `destroy` (line 3761, variable `stackExists` — keep the variable name,
  update only the right-hand side and its neighboring error message text,
  which currently says `'(no secrets passphrase on record) — nothing to
  destroy.'`; change to `'(no Pulumi stack initialization on record) —
  nothing to destroy.'` or similar — the message must stop implying a
  passphrase check, since that's no longer what's being tested).
- `clearStaleLock` (line 4621, same pattern, same message-text fix).

Also update the large doc comment block around lines 970–1020
(`classifyGetOrCreateStackFailure`'s TSDoc) that references
`PulumiPassphraseUnavailableError` as one of the "exactly six typed errors" —
this list shrinks to five; delete the `PulumiPassphraseUnavailableError`
bullet and its accompanying "existing-stack-no-local-record and
new-stack-keychain-unavailable reasons can be thrown after engine.resolve()
succeeds" paragraph, and remove the now-unused
`PulumiPassphraseUnavailableError` import (line 46) and its
`isPreEngineOrEngineFailure` disjunct (line 1451) from
`classifyGetOrCreateStackFailure` itself.

Also fix the doc-comment prose at lines 982–995 (the "genuinely-new stack"
paragraph referencing `PulumiPassphraseUnavailableError`'s
`existing-stack-no-local-record` reason) — rewrite to describe the current
(post-Task-2) behavior: the passphrase is now always derivable, so this
round-trip/protection no longer exists in the form described; state plainly
that `getOrCreateStack` no longer has a "protect passphrase" concern for
this case.

**Step (RED → GREEN), `PulumiService.test.ts`:**
- The file's own helper at line 82–85
  (`store.set('pulumi', { passphrase: opts.passphrase })`, described in a
  comment as mirroring the `!== undefined` idiom `PulumiService` uses) must
  change to `store.set('pulumi', { stackInitialized: opts.stackInitialized ?? true })`
  (or equivalent) — update the helper's own signature/doc comment
  accordingly, and update every call site of that helper across the file.
- The test at line 294 (`'should return null (not throw) when
  getOrCreateStack throws PulumiPassphraseUnavailableError'`) — **delete**;
  the error type no longer exists, and the "never throw" contract
  `getStackOutputs` upholds is already covered by other tests in that
  describe block for other error types (`PulumiCredentialsNotConfiguredError`
  etc., if present — check the surrounding describe block for a sibling test
  to confirm coverage isn't lost, and add
  `it('should return null when getOrCreateStack throws an unrelated Error')`
  if no such general-failure test already exists there).
- Remove the `PulumiPassphraseUnavailableError` import (line 45).

**Files:**
- Modify: `app/packages/desktop-main/src/services/PulumiService.initializeStack.test.ts`

- Line 54's helper (`store.set('pulumi', { passphrase: opts.passphrase })`) —
  same fix as above.
- Line 283 (`const cause = new PulumiPassphraseUnavailableError('new-stack-keychain-unavailable');`)
  and its surrounding test — this test exercises
  `classifyGetOrCreateStackFailure`'s `'engine'`-vs-`'operation'`
  classification for this error type; since the type is deleted, delete this
  specific test case, but confirm the describe block still has at least one
  test proving a genuine pre-engine failure (e.g.
  `PulumiCredentialsNotConfiguredError`) still classifies as `'engine'`, so
  coverage of that branch isn't silently lost.
- Line 439's comment referencing
  `this.store.get('pulumi')?.passphrase !== undefined` — update to describe
  the new `stackInitialized` check.
- Remove the `PulumiPassphraseUnavailableError` import (line 36).

### Step 4.3: Codebase-wide grep verification

**Files:** none modified in this step — verification only.

Run, and confirm the ONLY remaining hits are the historical/rationale
mentions inside `openspec/changes/pulumi-portable-passphrase/design.md`
and `openspec/changes/pulumi-portable-passphrase/tasks.md` themselves (which
describe the OLD behavior being replaced and are appropriately left alone —
`openspec/changes/**` is a historical record, not live code) — every hit
inside `app/**` must be gone:

```bash
grep -rn "PulumiPassphraseUnavailableError\|resolveStoredPassphrase\|resolveNewPassphrase\|generatePassphrase\|existing-stack-no-local-record\|new-stack-keychain-unavailable\|existing-stack-keychain-unavailable\|existing-stack-decrypt-failed" app/
```
Expected output: no matches. If any remain outside a test/doc-comment file
already covered by Steps 4.1–4.2, that's a missed call site — fix it before
proceeding.

Separately, confirm no controller/renderer code ever referenced these (this
plan's own research already ran this and found nothing, but re-verify after
the deletions above, since a stale reference would now be a compile error
anyway and `npm run app:typecheck` — Step 6 — is the final backstop):
```bash
grep -rln "PulumiPassphraseUnavailableError" app/packages/desktop-main/src/controllers/ app/packages/web/
```
Expected: no output.

### Step 4.4: `FirstRunWizardService.ts` — confirm no change is actually needed, fix stale doc comment only

Research for this plan (re-reading `FirstRunWizardService.ts` and grepping
its test file) found `reset()` **already** does not touch `pulumi.*` at
all — it was never in its explicit-deletion list (`activeCloud`, `aws`,
`bootstrap`, `creds`) to begin with, and its own doc comment already states
"Deliberately does NOT touch `pulumi.*`... clearing the passphrase would
make that stack's encrypted state undecryptable." So `tasks.md` §4.4's
"update `reset()` to stop preserving `pulumi.passphrase`" describes a
behavior change that turns out not to be required — `reset()`'s *behavior*
is correct today and needs no code change; only its **doc comment's
rationale** is now stale (it explains the omission in terms of the
passphrase specifically). Similarly, no controller/wizard-side error
surfacing tied to the removed error reasons was found anywhere in
`app/packages/desktop-main/src/controllers/` or `app/packages/web/` (Step
4.3's grep confirms this) — so there is no wizard-side removal to perform
either.

**Files:**
- Modify: `app/packages/desktop-main/src/services/FirstRunWizardService.ts`

Update `reset()`'s doc comment (lines 181–193) to describe the omission in
terms of BOTH remaining `pulumi.*` fields it still must not touch — the
still-live `pulumi.stackInitialized` flag (an already-provisioned stack's
bookkeeping, same "not wizard progress" argument as before) and the
legacy `pulumi.passphrase` field for as long as it can still exist mid-
migration — rather than being written as if `passphrase` were the only
reason. No test changes required (behavior is unchanged; confirm by running
the existing `reset()` test block in `FirstRunWizardService.test.ts`
unmodified and green).

### Step 4.5: `npm run app:typecheck` clean

Run `npm run app:typecheck` from the repo root. This is the authoritative
check that every deleted export/type has no remaining reference anywhere in
the workspace (including `@hyveon/infra`, per this repo's CLAUDE.md note
that the typecheck script covers it). Fix anything it surfaces before
proceeding — do not skip straight to Task 5 on a red typecheck.

**Commit point:**
`refactor(infra): remove the dead passphrase-unavailable error machinery replaced by derivation` —
one commit covering Steps 4.1–4.5 together, since they're one coherent
"delete now-provably-dead code" unit best reviewed as a whole diff.

---

## Task 5: Docs

Implements `tasks.md` §5.

### Step 5.1: `docs/docs/components/infra.md`

**Files:**
- Modify: `docs/docs/components/infra.md`

Current text (lines 54–59, "State backend" section):
> `LocalWorkspaceOptions.envVars.PULUMI_BACKEND_URL` is set to
> `s3://<stateBucket>?region=<region>`... `secretsProvider: 'passphrase'` —
> there is no Pulumi Cloud account and no access token anywhere in this app;
> a random passphrase is generated once per stack and stored encrypted via
> `SafeStorageService`.

Rewrite that last sentence (and add a short new paragraph after it) to
describe: `secretsProvider: 'passphrase'` stays, but the passphrase itself
is now derived deterministically from `HMAC-SHA256(accountId + stackName,
<fixed salt>)` (name the actual constant,
`PULUMI_PASSPHRASE_DERIVATION_SALT`) via STS `GetCallerIdentity`, recomputed
on every operation and never stored — so any machine with valid credentials
for the deployment's AWS account can operate on the existing stack with no
locally-stored passphrase record. Explicitly state, in the same section,
that this passphrase is **not a confidentiality boundary** — the infra
program never calls `pulumi.secret()` (cite `app/packages/infra/src/program.ts`
per the design doc's own confirmation of this), so the passphrase gates
access to non-sensitive state only. Add one sentence noting the automatic,
silent, one-time migration for installs with a legacy stored passphrase.

### Step 5.2: `docs/docs/app/first-run-wizard.md`

**Files:**
- Modify: `docs/docs/app/first-run-wizard.md`

Research for this plan found no existing "multi-machine passphrase-decrypt-
failure caveat" text in this file to remove (`tasks.md` §5.2 describes
removing text that, on inspection, isn't present verbatim) — the two actual
passages that need updating are:

- Line 312 (Step 5's phase table): `"Resolving the Pulumi engine" | Downloads
  and verifies the pinned Pulumi CLI engine on first use, and constructs the
  Automation API workspace against your S3 backend — generating a fresh
  secrets passphrase the first time"` — the clause "generating a fresh
  secrets passphrase the first time" is now inaccurate (nothing is
  generated or stored). Replace with something like "...and derives the
  stack's secrets passphrase from your AWS account ID."
- Lines 371–373 ("Starting over" section): `"...It also does not touch an
  already-initialized Pulumi stack's own state or secrets passphrase, since
  that belongs to infrastructure you may already be running, not to wizard
  progress."` — update to reflect that there is no longer a stored
  passphrase to preserve; the sentence should instead say Start Over does
  not touch an already-initialized stack's own state, and that pointing the
  wizard at an existing deployment's bucket names now works from any machine
  since the passphrase is derived, not stored per-install.

Also check whether Step 4's page (around line 264, the "already taken by
another AWS account" error table, and line 231's config-bootstrap
description) implies anything about a second-machine limitation that should
now be softened — read the surrounding prose during implementation and add
one sentence, only if genuinely warranted, noting that entering an existing
deployment's bucket names on this step now completes successfully end-to-end
on a fresh machine (tying back to the delta spec's "A second machine
operates on an existing stack" scenario) — don't invent a caveat removal
that isn't there, but do confirm nothing on this page still implies the old
failure mode.

### Step 5.3: Evaluator pass

Run the `write-docs` skill's evaluator agents (accuracy, coverage, style)
over both changed pages before opening the PR, per this repo's CLAUDE.md
("Before opening a PR" docs requirement). Fix anything they flag.

**Commit point:** `docs(infra): document the derived, portable Pulumi secrets passphrase` —
docs land in their own commit per this repo's convention of docs shipping
with the behavior change (same PR, distinct commit for reviewability).

---

## Task 6: Verification gate

Implements `tasks.md` §6.1–6.4 (6.5, the real-AWS-account manual check, is
out of scope for an automated plan step — flag it to the operator as a
manual pre-merge action instead of attempting to script it here).

### Step 6.1: Lint

```bash
npm run app:lint
```
Must exit clean. If `npm run app:lint:fix` changes anything beyond
formatting, review the diff before accepting it.

### Step 6.2: Typecheck

```bash
npm run app:typecheck
```
Must exit clean (already run once at Step 4.5 — re-run here as the final
gate after Task 5's doc-only changes, which shouldn't affect it, but confirm
anyway since this is the authoritative final check before commit).

### Step 6.3: Unit tests

```bash
npm run app:test
```
Full workspace suite green, including every new/modified test from Tasks
1–4.

### Step 6.4: Integration tests

```bash
npm run app:test:integration
```
Required per this repo's CLAUDE.md whenever Pulumi orchestration changes —
this change touches `PulumiWorkspaceService`/`PulumiService`, both squarely
in scope. Must exit clean.

### Step 6.5: Manual real-AWS verification (flag to operator, don't script)

Per `tasks.md` §6.5: bootstrap from one credential set, then run a Pulumi
operation using a second, independently-created credential set (e.g. a
different IAM user) in the same AWS account, and confirm no
`PulumiPassphraseUnavailableError`-equivalent failure occurs (the error type
itself no longer exists after Task 4, so concretely: confirm the second
credential set's `getOrCreateStack` call succeeds and selects — not
recreates — the existing stack). This requires a real AWS account and is not
something this plan can execute standalone; note it in the PR description as
a manual verification step the operator should perform (or explicitly defer,
stating why, if a suitable test AWS account isn't available before merge).

**Commit point:** none new here — Task 6 only verifies; if it surfaces
failures, fix them within whichever Task's commit is responsible and amend
that step's work before the PR is opened (per this repo's git rules, prefer
a new commit over `--amend` unless explicitly instructed otherwise for a
pre-push commit).

---

## Self-review checklist

**Spec coverage** — every scenario in
`specs/pulumi-engine-runtime/spec.md`'s "Automation API workspace seam"
MODIFIED requirement has a task that satisfies it:

| Scenario | Covered by |
|---|---|
| Operations use the self-managed backend | Unchanged — no code touches this; verified indirectly by every `getOrCreateStack` test still passing (backend URL construction untouched by this plan) |
| Backend is not yet bootstrapped | Unchanged — `backendReady`/`PulumiBackendNotBootstrappedError` path untouched by Tasks 1–4 |
| Workspace is reused, not accumulated | Unchanged — `pulumiHome`/`workDir` resolution untouched |
| Passphrase is present before stack creation | Task 1 (derivation), Task 2 Step 2.1/2.3 (wired into `getOrCreateStack`, first-creation test) |
| A second machine operates on an existing stack | Task 2 Step 2.3's third new test (replaces the old throw-based "Finding 1" block with a success assertion) — this is the change's core bug fix |
| A legacy per-machine passphrase is migrated automatically | Task 3 Step 3.1 (implementation) + 3.2 (success test) |
| Legacy migration is retried after a failed re-encryption | Task 3 Step 3.2's third test |

**Placeholder scan** — every code block above either (a) is real,
copy-pasteable TypeScript against symbols confirmed to exist in the actual
files read for this plan (`resolveAwsClientCredentials`,
`resolveCredentialEnvVars`, `ElectronStoreService.getPulumiPassphrase`/
`setPulumiPassphrase`, `PULUMI_STACK_NAME`, etc. — all confirmed present at
the line numbers cited), or (b) is explicitly marked as depending on Step
3.0's spike finding (`migrateLegacyPassphrase`'s body) rather than presented
as already-known fact. No `// TODO` / `// ...` / `<placeholder>` markers
left in any interface block.

**Type consistency** — `deriveStackPassphrase(accountId: string, stackName:
string): string` and `resolveAwsAccountId(store, region, stsClientFactory?):
Promise<string>` (Task 1) feed directly into Task 2 Step 2.1's
`getOrCreateStack` body with matching signatures; `pulumi.stackInitialized?:
boolean` (Task 2 Step 2.2) is consumed with the same optional-boolean shape
by all three `PulumiService.ts` call sites fixed in Task 4 Step 4.2; the
`migrateLegacyPassphrase` context parameter's shape in Task 3 matches exactly
what Task 2's `getOrCreateStack` already has in scope at the call site shown
(`pulumiCommand`, `pulumiHome`, `workDir`, `credentialEnvVars`/`backendUrl`).

**Additional findings beyond `tasks.md`, folded in rather than left as
surprises for the implementer** (repeated from the Overview for visibility):
1. `Stack.changeSecretsProvider` doesn't exist in the pinned SDK — Task 3
   now opens with an explicit spike step instead of assuming the method.
2. Three `pulumi.passphrase`-as-existence checks in `PulumiService.ts` were
   invisible to `design.md`/`tasks.md` (neither mentions that file) but will
   silently break every `getStackOutputs`/`destroy`/`clearStaleLock` call
   post-migration without the new `stackInitialized` flag — Task 2 Step 2.2
   and Task 4 Step 4.2 now cover this.
3. `tasks.md` §4.4 and §5.2 both describe removals that, on inspection of
   the actual current files, aren't present verbatim — Task 4 Step 4.4 and
   Task 5 Step 5.2 both note this explicitly and redirect to the real
   (smaller, or differently-shaped) work actually needed, rather than
   silently padding the plan with a no-op step to match the task list's
   original wording.
