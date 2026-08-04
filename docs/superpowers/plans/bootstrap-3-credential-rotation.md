# Group 3: Credential rotation in AwsProfileService

## Context

Part of OpenSpec change `add-one-click-aws-bootstrap`
(`openspec/changes/add-one-click-aws-bootstrap/{proposal,design}.md`,
spec `aws-credentials`, "In-app access key rotation" requirement). Group 2
(merged onto this branch's base, PR #379) built `GuidedIamService.rotate()`
— a one-time mint-then-revoke rotation that runs during guided IAM
provisioning to retire the CloudFormation bootstrap key. This group adds a
**different, general-purpose** capability: rotating the key behind an
*already-active* pasted credential source (e.g. from a future Settings
"rotate key" affordance — out of scope here, just the service method).
The two are siblings, not a refactor of one into the other — `GuidedIamService`
establishes a brand-new active source from a bootstrap key with no prior
state; this group's method replaces the key material behind a source that
is already the active one, in place, same profile name.

## Global Constraints

**Only the "pasted" credential-source kind is rotatable.** `AwsProfileService`
persists pasted keys (`creds.aws.<profileName>`, via `SafeStorageService`
encryption) — it does not, and cannot, own or rewrite a `~/.aws/credentials`
file for the "profile" kind (a real AWS CLI profile the operator manages
themselves). Resolve the active source via
`resolveAwsCredentialSource(store)` (`app/packages/desktop-main/src/services/awsCredentialSource.ts`,
already used by `IamCheckService`/`BootstrapService` — read it first). If
`kind !== 'pasted'`, refuse with a clear error (e.g. "Rotation is only
supported for pasted or guided credential sources — pick a profile you
control, or re-run guided provisioning"); do not attempt anything against
a `kind: 'profile'` or `kind: 'none'` source.

**Sequence — mirrors `GuidedIamService.rotate()` from Group 2 exactly,
including the orphan-cleanup lesson learned there (read
`app/packages/desktop-main/src/services/GuidedIamService.ts`'s `rotate()`
method in full before writing this one — same shape, different starting
point):**

1. Resolve the active source (must be `kind: 'pasted'`, per above). Read
   its current `{ accessKeyId, secretAccessKey }` (already-decrypted, from
   `resolveAwsCredentialSource`'s `pasted` variant) and the store's
   `aws.region`.
2. `iam:CreateAccessKey` using an IAM client built from the **current**
   (about-to-be-superseded) key pair.
3. Verify: build an STS client from the **new** key pair, call
   `sts:GetCallerIdentity`.
   - **On failure:** clean up the orphaned new key immediately — call
     `iam:DeleteAccessKey` on it using the **current (still-valid)** key's
     client, exactly like `GuidedIamService.rotate()`'s verification-failure
     branch does (this was a real bug found and fixed in that method during
     Group 2's review — bake the fix in from the start here, don't
     reproduce the bug). If the cleanup delete also fails, swallow it (log
     a non-secret warning) and still report `verification-failed` — do not
     compound failures into a new status. Do NOT overwrite the stored
     pasted credentials — the previously stored key remains active and in
     the keychain, per the spec's "Old key retained on verification
     failure" scenario.
4. **Only on verification success:** overwrite the stored credentials —
   `store.setPastedCredentials(profile, { accessKeyId: <new>, secretAccessKey: <new>, region })`
   — same profile name as before (in-place rotation; `store.aws.profile`
   already points at this profile, so no separate "activate" write is
   needed the way Group 2's method needed one).
5. `iam:DeleteAccessKey` on the **old** (now-superseded) key, using an IAM
   client built from the **new** key pair.
   - **On failure:** the new key is already stored/active (step 4 already
     ran). Return a `delete-failed` outcome carrying enough information for
     a caller to build a "the old key is still active — revoke it
     manually" message (an IAM console link, or just the old key's
     AccessKeyId — your call, but be consistent with what
     `GuidedIamService`'s equivalent branch returns for API-shape
     consistency across the two rotation methods). Never report overall
     success.
6. On success, return `complete`.

Model as a discriminated union, not thrown exceptions, for the two expected
failure branches — same reasoning as `GuidedIamService.rotate()`.

**AWS SDK client construction:** new protected seams on `AwsProfileService`
(it currently has none — this is its first AWS-SDK-calling method), built
directly from explicit credential parameters, following
`GuidedIamService`'s `createStsClient`/`createIamClient` pattern exactly
(same signature shape, same "why" reasoning in the TSDoc — reuse or closely
paraphrase it).

**Never** call `GuidedIamService` from here, and never call this new
method from `GuidedIamService` — the two rotation flows are independent
siblings on this branch's history (Group 2 already shipped and merged
before this group started; refactoring it to share code with this new
method is out of scope and not required by the spec).

**No secret logging** — same discipline as `GuidedIamService.rotate()`:
audit every log call this method adds.

## Task 1: 3.1 Rotation method

Implement the method described in Global Constraints on `AwsProfileService`
(`app/packages/desktop-main/src/services/AwsProfileService.ts`) — e.g.
`rotateActiveCredentials(): Promise<RotationResult>` (name your own
discriminated union type, e.g. `AwsProfileRotationResult`, to avoid
colliding with `GuidedIamService`'s exported `RotationResult` if you import
both in the same file anywhere — check for a naming collision before
picking a name). Full 6-step sequence including the "unsupported source
kind" refusal and the orphan-cleanup-on-verification-failure step.

## Task 2: 3.2 Verification-failure preserves the old key

Covered by Task 1's implementation (the `verification-failed` branch) —
this task is about confirming that branch's behavior is correct and
tested, not a separate code path. If Task 1 already implements this per
Global Constraints, confirm here in your report rather than duplicating
code.

## Task 3: 3.3 Unit tests

Comprehensive `aws-sdk-client-mock`-based tests, mirroring
`GuidedIamService.test.ts`'s rigor for its `rotate()` method: unsupported
source kind (profile / none) refusal, successful rotation with exact call
order (CreateAccessKey → GetCallerIdentity(new) → setPastedCredentials →
DeleteAccessKey(old, new client)), verification-failure (orphaned-key
cleanup called correctly, old credentials NOT overwritten, cleanup-also-fails
sub-case), delete-failure (new credentials already stored, distinct
outcome), no-secret-logging assertion across all three terminal outcomes.
