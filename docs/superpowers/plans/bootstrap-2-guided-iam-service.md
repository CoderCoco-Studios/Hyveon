# Group 2: GuidedIamService (main process)

## Context

Part of OpenSpec change `add-one-click-aws-bootstrap`
(`openspec/changes/add-one-click-aws-bootstrap/{proposal,design}.md`,
specs `guided-iam-provisioning` and `aws-credentials`). Group 1 (merged
onto this branch's base) shipped the static artifacts: `iamPolicy.ts`'s
`generateHyveonDeployAllPolicy()` / `generateHyveonSelfRotatePolicy()`,
the `iam-bootstrap.yaml` template shell with two placeholder tokens, and
`resolveCloudFormationTemplatePath()` (in
`app/packages/desktop-main/src/cloudformationTemplate.ts`) to locate it at
runtime. This group builds the main-process service that actually talks to
AWS: renders the template, opens the operator's browser at the
CloudFormation console, accepts the resulting bootstrap key, and performs
the mandatory mint-then-revoke rotation. **No IPC controller, no wizard UI,
no `AwsProfileService` changes** — those are separate, later groups
stacked on top of this one. This group is a single new service class plus
its collaborators, fully unit-testable with `aws-sdk-client-mock`.

## Global Constraints

**Service location:** new file `app/packages/desktop-main/src/services/GuidedIamService.ts`,
`@Injectable()`, following this codebase's NestJS service conventions
(see `IamCheckService.ts` / `BootstrapService.ts` for house style: protected
seams for AWS client construction so tests can `vi.spyOn` them, TSDoc on
every public method, no raw `process.env` in business logic).

**This service does NOT read `ElectronStoreService.get('aws')` for its own
credentials or region.** Unlike `IamCheckService`/`BootstrapService` (which
run *after* the credentials step and use the wizard's already-chosen
source), `GuidedIamService` runs *before* that step exists — it IS what
establishes the credential source. Every method that needs AWS credentials
or a region takes them as explicit parameters from its caller (a later
group's IPC controller, itself fed by the renderer). This keeps the service
decoupled from exactly which wizard step captures the region — not your
concern in this group.

**AWS SDK client construction:** build `STSClient`/`IAMClient` directly
from an explicit `{ accessKeyId, secretAccessKey, region }` (or, for the
final IAM-permission-gate-adjacent calls, whatever the method's own
parameters specify) — never via `fromIni`/`resolveAwsCredentialSource`
(those are for the *established* wizard credential source, not the
bootstrap key this service is intaking). Extract client construction into
`protected` methods (e.g. `createStsClient(creds)`, `createIamClient(creds)`)
per this codebase's existing seam convention, so tests can stub them.

**Template rendering (Task 2.1):** read the template via Group 1's
`resolveCloudFormationTemplatePath()` (import from
`./cloudformationTemplate.js`). If it returns `undefined` (neither packaged
nor dev copy found), fail loudly — return/throw a clear error, don't
silently produce a broken file. Read the file, replace
`__HYVEON_DEPLOY_ALL_POLICY_DOCUMENT__` with `JSON.stringify(generateHyveonDeployAllPolicy())`
and `__HYVEON_SELF_ROTATE_POLICY_DOCUMENT__` with
`JSON.stringify(generateHyveonSelfRotatePolicy())` — **both calls with no
`null, 2` pretty-print argument**, single-line output only (embedding a
pretty-printed multi-line JSON string at that YAML position is invalid
YAML — see the template's own comments from Group 1). Do NOT substitute
`UserName` — it stays a real CloudFormation stack `Parameter` the operator
can override in the console; this service never bakes a concrete user name
into the rendered file. Write the rendered result to a file under the
Electron `userData` directory (e.g. `<userData>/iam-bootstrap-rendered.yaml`),
following `ConfigService.getServerConfigPath()`'s exact resolution pattern
(`app/packages/desktop-main/src/services/ConfigService.ts` lines ~264-304):
packaged → `app.getPath('userData')`-relative; dev/test fallback → a
repo-relative path (your call exactly where, since this is a scratch
render output, not a committed asset — a `.iam-bootstrap-dev` file under
the repo root or similar is fine, just don't write into `resources/`).
Return the written path from the render method.

**Console URL construction (Task 2.2):** ONE function, e.g.
`buildCloudFormationConsoleUrl(region: string): string`, returning the AWS
CloudFormation "Create stack" console page scoped to the given region:
`https://<region>.console.aws.amazon.com/cloudformation/home?region=<region>#/stacks/create`.
There is **no** `templateURL` query parameter — Group 1's design
deliberately rejected a hosted-template quick-create link (see
`design.md` Decision 2); the operator uploads the local file manually via
the console's "Upload a template file" option. Pin this exact shape with a
unit test (per the spec's "constructed in exactly one place" requirement).

**Browser launch (Task 2.3):** use Electron's `shell.openExternal(url)` —
there is no existing precedent for this in the codebase, so follow the
same lazy-require Electron-touching pattern every other main-process
service in this file tree uses (see `SafeStorageService.ts` or
`ConfigService.ts`'s `readIsPackaged()`/`readUserDataPath()`:
`process.versions['electron']` guard, `createRequire(import.meta.url)`,
wrapped in `protected` methods so tests can stub without importing real
`electron`). On failure (throws, or `process.versions['electron']` is
unset), do NOT throw — return a result indicating the browser could not be
opened, carrying the full console URL as plain text so the caller (a later
group's UI) can display it for the operator to open manually, per the
spec's "Browser cannot be opened" scenario.

**Bootstrap key intake (Task 2.4):** validate the operator-submitted
`{ accessKeyId, secretAccessKey }` via `sts:GetCallerIdentity` using the
region parameter the caller supplies. On success, return the resolved
account ID (parse from the identity ARN or `Account` field — `GetCallerIdentityCommand`'s
response has both `Arn` and `Account`; use `Account` directly, it's
simpler than `IamCheckService`'s ARN-parsing need, which existed for a
different reason — `SimulatePrincipalPolicy`'s ARN-only `PolicySourceArn`
parameter, not applicable here). On failure (any AWS error — invalid keys,
network, etc.), return/throw the underlying AWS error message unchanged
(never a generic "invalid credentials"), and do NOT call any storage method
— nothing is persisted until intake succeeds.

**Rotation (Tasks 2.5, 2.6) — exact sequence, in order, load-bearing:**

1. `iam:CreateAccessKey` using an IAM client built from the *validated
   bootstrap key* (from intake) — mints a new key pair for the same IAM
   user.
2. Persist the new key pair to a **staging location**:
   `ElectronStoreService.setPastedCredentials(GUIDED_PROFILE_NAME, { accessKeyId, secretAccessKey, region })`
   — reusing the exact same encrypted storage path `AwsProfileService.savePastedCredentials`
   uses (`creds.aws.<profileName>`), with a new exported constant
   `GUIDED_PROFILE_NAME = 'hyveon-guided'` (distinct from
   `AwsProfileService`'s `DEFAULT_PASTED_PROFILE_NAME = 'hyveon-pasted'` —
   a later group needs to tell guided-sourced credentials apart from
   manually-pasted ones by profile name). This write alone does **not**
   make the key the active credential source — `ElectronStoreService.get('aws')?.profile`
   is untouched at this point. Inject `ElectronStoreService` and
   `SafeStorageService` into `GuidedIamService`'s constructor (the former
   already gates encryption via the latter internally — see
   `AwsProfileService`'s existing constructor for the pattern — you do not
   need to call `SafeStorageService` directly except for the Task 2.7 gate
   check itself, before starting rotation at all).
3. Verify: build an STS client from the **new** key pair, call
   `sts:GetCallerIdentity`.
   - **On failure:** do NOT touch `ElectronStoreService.set('aws', ...)`
     (nothing becomes active), do NOT delete the bootstrap key. Return a
     distinct `verification-failed` outcome carrying the error, so the
     caller can offer a retry (which re-runs from step 1 — idempotent,
     since step 2 just overwrites the same staging entry).
4. **Only on verification success:** `ElectronStoreService.set('aws', { ...current, profile: GUIDED_PROFILE_NAME, region })`
   — this is the moment the new key becomes the active credential source
   (matches `resolveAwsCredentialSource`'s existing resolution logic in
   `app/packages/desktop-main/src/services/awsCredentialSource.ts` — a
   stored `profile` name that resolves via `getPastedCredentials` is
   treated as `kind: 'pasted'` automatically; no other change needed for
   `PulumiCredentialResolver`/`BootstrapService`/`IamCheckService` to pick
   it up).
5. `iam:DeleteAccessKey` on the **bootstrap key**, using an IAM client
   built from the **new, now-active** key pair (both keys belong to the
   same IAM user and `HyveonSelfRotate` is attached to the user, not to a
   specific key, so this is valid; using the new key here is the more
   trustworthy choice since it was just verified).
   - **On failure:** the new key IS already active (step 4 already
     succeeded — app functionality is fine going forward). Return a
     distinct `delete-failed` outcome: "bootstrap key still active — revoke
     it manually", carrying a direct IAM console link (construct simply,
     e.g. `https://console.aws.amazon.com/iam/home#/security_credentials`
     or the user-specific security-credentials page if you can build one
     cheaply — either is acceptable, your call). Do **not** report this as
     overall rotation success.
6. On success, return a `complete` outcome.

Model these outcomes as a discriminated union return type (e.g.
`RotationResult = { status: 'complete' } | { status: 'verification-failed'; error: string } | { status: 'delete-failed'; consoleUrl: string }`)
rather than throwing for the two failure branches — both are expected,
recoverable states the caller needs to render distinctly, not exceptional
control flow.

**Keychain gate (Task 2.7):** before *any* credential storage in this
service (i.e., before step 2 of rotation above — check this at the start
of the rotation method, not buried inside step 2), call
`SafeStorageService.isAvailable()`. If `false`, refuse: return/throw a
clear error directing the operator to the profile-picker or paste paths
instead (mirrors `AwsProfileService.SafeStorageUnavailableError` — you may
reuse that exact error class by importing it, or define an equivalent one
local to this service; reusing is preferred if its message reads sensibly
for this context, otherwise a new class with the same shape is fine).
Never degrade to plaintext storage.

**No secret logging (Task 2.8):** audit every `logger.debug`/`logger.warn`/`logger.error`
call this service adds (see `../logger.js`, already used elsewhere in this
package) and confirm none interpolates `secretAccessKey` or the bootstrap
key's secret. Logging the access key ID (non-secret) or generic
step-progress messages is fine.

**Testing (Task 2.9):** `aws-sdk-client-mock` for `STSClient`/`IAMClient`,
following `BootstrapService.test.ts`'s existing `mockClient(...)` pattern.
Cover: successful intake, invalid-credentials intake, successful rotation
(assert the exact 5-step call order:
CreateAccessKey → setPastedCredentials → GetCallerIdentity(new key) →
`store.set('aws', ...)` → DeleteAccessKey(bootstrap key)),
verification-failure (assert `store.set('aws', ...)` was NOT called and
DeleteAccessKey was NOT called), delete-failure (assert the new key is
still reported active), keychain-unavailable refusal, and a log-message
assertion proving no test ever sees the secret value in a logged string
(e.g. spy on `logger.*` and assert none of its calls' arguments contain
the fixture secret).

**Never** call `AwsProfileService` from this service — Group 3 (a later,
separate PR stacked on top of this one) adds a related-but-distinct
general-purpose rotation method there for a different use case (rotating
an *already-active* stored credential, e.g. from Settings); this group's
one-time bootstrap-key rotation is self-contained and does not depend on
work that doesn't exist yet on this branch.

## Task 1: 2.1 Template rendering

Implement `GuidedIamService.renderTemplate(): { path: string }` (or similar
— exact method name your call) per the Global Constraints' "Template
rendering" section: locate the template via `resolveCloudFormationTemplatePath()`,
substitute both placeholder tokens with single-line `JSON.stringify()`
output from Group 1's two generator functions, write to a `userData`-relative
(or dev-fallback) path following `ConfigService.getServerConfigPath()`'s
resolution pattern, return the written path.

## Task 2: 2.2 Console URL construction

Implement `buildCloudFormationConsoleUrl(region: string): string` exactly
as specified in Global Constraints. Unit test pinning the shape for at
least two different region strings.

## Task 3: 2.3 Browser launch with fallback

Implement a method (e.g. `openConsole(url: string): { opened: boolean }`)
that calls `shell.openExternal(url)` via the lazy-require Electron seam,
returning `{ opened: true }` on success and `{ opened: false }` (never
throwing) on failure — the caller displays the URL as text when `opened`
is `false`.

## Task 4: 2.4 Bootstrap key intake

Implement a method (e.g. `intakeBootstrapKey(input: { accessKeyId: string; secretAccessKey: string; region: string }): Promise<{ accountId: string }>`)
that validates via `sts:GetCallerIdentity` and returns the resolved account
ID on success, or propagates the AWS error unchanged on failure. Persists
nothing.

## Task 5: 2.5 Rotation

Implement the rotation method (e.g. `rotate(input: { bootstrapAccessKeyId: string; bootstrapSecretAccessKey: string; region: string }): Promise<RotationResult>`)
exactly per the Global Constraints' "Rotation" section — the 5-step
sequence, in order, with the discriminated-union result type.

## Task 6: 2.6 Rotation failure modes

Covered by Task 5's implementation (the `verification-failed` and
`delete-failed` branches) — this task is about making sure both are
distinctly modeled and distinctly reported, not a separate code path. If
you implement Task 5 per the Global Constraints already, confirm here (in
your report) that both failure branches are exercised by tests, rather
than writing new production code.

## Task 7: 2.7 Keychain gate

Add the `SafeStorageService.isAvailable()` check at the start of the
rotation method (Task 5), per Global Constraints. If you already built
this into Task 5's implementation, confirm here rather than duplicating
code.

## Task 8: 2.8 No secret logging

Audit (per Global Constraints) — add or fix logging in the methods above so
no secret is ever logged. If nothing needs changing, say so in your report
with evidence (list every log call this service makes and confirm none
carries a secret value).

## Task 9: 2.9 Unit tests

Write the full test suite described in Global Constraints' "Testing"
section, covering all methods from Tasks 1-8 comprehensively — this is the
task where the bulk of test-writing happens; earlier tasks may have
already introduced focused tests for their own method as you built it,
which is fine (don't duplicate), but this task's job is to confirm full
coverage exists across the whole service by the time it's done, including
the cross-cutting log-secret-assertion.
