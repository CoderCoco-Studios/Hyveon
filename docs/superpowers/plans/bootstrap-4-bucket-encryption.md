# Group 4: Configuration-bucket encryption

## Context

Part of OpenSpec change `add-one-click-aws-bootstrap`
(`openspec/changes/add-one-click-aws-bootstrap/proposal.md` "State-bucket
hardening (one remaining gap)"; spec `cloud-bootstrap`, "Default encryption
on the configuration bucket" requirement). Small, self-contained group,
independent of Groups 1-3 — stacked here purely to keep the PR sequence
linear, not because it depends on them. `BootstrapService.ensureStateBucket()`
already applies `PutBucketEncryption` (AES256); `ensureConfigurationBucket()`
does not, despite holding the same class of configuration data (the
versioned `deployment-config.json` object). This group closes that one
asymmetry.

## Global Constraints

**File:** `app/packages/desktop-main/src/services/BootstrapService.ts`.
Read `ensureStateBucket()` (lines ~111-141) in full first — it is the exact
pattern to copy into `ensureConfigurationBucket()` (lines ~163-202): the
same `PutBucketEncryptionCommand` call, with the same
`ServerSideEncryptionConfiguration: { Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }] }`
shape, inside the same `try`/`catch` block that already wraps
`PutBucketVersioningCommand` and `ensurePublicAccessBlock()` — so a
`PutBucketEncryption` failure falls through to the same
`{ status: 'failed', message: this.describeError(err) }` return the other
two calls in that block already produce. Do not introduce a new error type
or a separate status field — match the existing block's error handling
exactly, per the spec's explicit requirement that this "must surface as a
bootstrap failure rather than being silently ignored," which the existing
`try`/`catch` shape already guarantees for its sibling calls.

**Ordering within the block does not matter functionally** (versioning,
encryption, and public-access-block are three independent bucket
configuration calls), but for readability, mirror `ensureStateBucket()`'s
order: versioning → encryption → public-access-block.

**Runs on both the `created` and `exists` paths** — `ensureConfigurationBucket()`
already calls its `try` block unconditionally after `createBucket()`
resolves (on both paths), exactly like `ensureStateBucket()` does — so
simply adding the `PutBucketEncryptionCommand` call inside that existing
block automatically satisfies "applied on the `exists` path as well as
`created`," per the spec's "pre-existing bucket brought into line" scenario.
No conditional logic needed; this is a one-call addition to code that
already runs on both paths.

**Public-access-block is NOT part of this group's scope** — already applied
to both buckets (confirmed in `proposal.md` and `design.md` as prior,
unrelated work from `migrate-iac-to-pulumi`). Do not touch
`ensurePublicAccessBlock()`.

## Task 1: 4.1 Add the `PutBucketEncryption` call

Add the same `PutBucketEncryptionCommand` call `ensureStateBucket()` makes
to `ensureConfigurationBucket()`, inside its existing `try` block, per
Global Constraints.

## Task 2: 4.2 Applies on `exists` as well as `created`

Covered by Task 1's implementation (the call already runs unconditionally
after `createBucket()` on this codebase's existing pattern) — confirm this
in your report with a test proving a pre-existing bucket (an
already-mocked `createBucket` "already exists" path) still gets the
encryption call and still reports `status: 'exists'` (not `'created'`).

## Task 3: 4.3 Failure surfaces as `status: 'failed'`

Covered by Task 1's implementation (the shared `try`/`catch`) — confirm
with a test: `PutBucketEncryptionCommand` rejects → `ensureConfigurationBucket()`
returns `{ status: 'failed', message: <error> }`, never `'created'`/`'exists'`.

## Task 4: 4.4 Unit tests

Write the three tests Global Constraints and Tasks 2-3 describe, in
`app/packages/desktop-main/src/services/BootstrapService.test.ts` (read the
existing tests for `ensureStateBucket`'s `PutBucketEncryption` assertion
first, and mirror that exact `aws-sdk-client-mock` pattern for
`ensureConfigurationBucket`):
1. New configuration bucket → `PutBucketEncryptionCommand` called with
   AES256, alongside the existing versioning/lifecycle/public-access-block
   assertions.
2. Pre-existing configuration bucket (the `exists` path) → encryption call
   still made, `status` still reports `'exists'`.
3. `PutBucketEncryptionCommand` rejects → `status: 'failed'` with the
   underlying error message, not a silent success.
