<!--
Raw capture of superpowers:brainstorming output.
-->

# Brainstorm: Pulumi portable passphrase

## Classification

Architectural. Changes the infra bootstrap contract (Pulumi stack lifecycle,
first-run wizard flow, cross-machine semantics) and touches multiple services
(`PulumiWorkspaceService`, `FirstRunWizardService`). Full brainstorming
process, converging to a written spec via `/opsx:propose`.

## Background (established before Q&A)

User already has Hyveon deployed from one machine, with an S3 config bucket
holding `deployment-config.json`. They want to run the app from a second
machine against the same cloud deployment, without rebuilding infrastructure.

Investigation (via Explore subagents) established the mechanics of the
current blocker:

- `PulumiWorkspaceService` generates a random 32-byte secrets passphrase per
  machine on first stack creation, stored only in that machine's OS keychain
  (`safeStorage`/electron-store), used as Pulumi's `secretsProvider:
  'passphrase'` (`PulumiWorkspaceService.ts:434`) for state stored in S3.
- `deployment-config.json` is plain JSON in the S3 *configuration* bucket —
  entirely separate from the Pulumi *state* bucket/passphrase. It's readable
  by any machine with S3 access regardless of the passphrase.
- On a second machine, `getOrCreateStack` → `resolveNewPassphrase` calls
  `ws.listStacks()`, sees the stack already exists remotely with no local
  passphrase record, and throws `PulumiPassphraseUnavailableError` (reason
  `existing-stack-no-local-record`, `PulumiWorkspaceService.ts:591`). This
  hard-blocks ALL Pulumi operations (refresh/preview/apply) before any engine
  call is even attempted — dashboard/config reads still work (they don't go
  through Pulumi), but nothing infra-related does.
- Nothing in the codebase actually uses `pulumi.secret()`/`setConfig` with
  secret values — `app/packages/infra/src/program.ts:123` explicitly notes
  `pulumi.secret` is not used. Real secrets (Discord bot token, IAM keys)
  live in AWS Secrets Manager (`app/packages/infra/src/secrets.ts`) and
  `SafeStorageService`/electron-store, never in Pulumi stack config/outputs.
  So the passphrase-encrypted Pulumi state currently protects **nothing
  secret** — it's an access gate, not a confidentiality boundary, and its
  being machine-bound is the entire bug.
- No recovery path exists today: no env var override, no re-entry UI, no
  export/import of the passphrase. The only "recovery" is the error text
  suggesting a manual backup restore or manual stack secrets reset.

## Decision chain

**Q1 (assistant, reframing):** Given nothing is actually
`pulumi.secret()`-encrypted, do you want (1) graceful degradation + an
explicit "rebuild the plan on import" flow on the second machine
(reconstruct a fresh stack via `pulumi import` against real AWS resource
state), or is a much cheaper fix available — making the passphrase
non-machine-bound so the second machine can just resume the *existing*
stack directly, no rebuild needed at all? Noted that a fresh-stack rebuild
approach would need real `pulumi import` per resource (S3
buckets/DynamoDB tables are created by name — pointing a new empty stack at
existing infra and running `pulumi up` would hit "BucketAlreadyExists"
errors, not silently adopt them).

**A1 (user):** "No all I want is to be able to swap the app from machine to
machine easily without having to rebuild the entire infrastructure."
→ Confirms: no rebuild/import flow. Reuse the existing stack.

**Q2 (assistant):** Where should the passphrase live to make it portable —
(a) derive it deterministically (no storage, computed fresh from something
both machines can access) or (b) store it in the S3 config bucket
alongside `deployment-config.json` (keeps a "generate once, persist" shape,
just relocates the store)?

Proposed derivation for (a): `HMAC(AWS account ID + stack name, app-level
constant)`, using STS `GetCallerIdentity` (account ID is already needed
elsewhere in the AWS bootstrap flow).

**A2 (user, via clarifying question):** "I would be able to change the
Access Key ID / Secret Access Key right and it wouldn't be a problem?"
→ Assistant confirmed: yes — account ID (not the access key) is the
derivation input, and account ID is stable across key rotation, IAM user
changes, and credential-mode switches (CLI profile vs pasted keys), as long
as they're in the same AWS account.
→ Implicitly selects (a), deterministic derivation, over (b) S3-stored.

**Q3 (assistant):** Should deterministic derivation apply to all stacks
going forward, or only as an opt-in migration path, leaving existing
single-machine installs on the keychain model?

**A3 (user):** "universally"
→ One code path. No dual-mode (keychain vs derived) left standing long-term.

**Q4 (assistant):** For existing single-machine installs (already have a
keychain-stored random passphrase), migration should be:
- (A) Automatic and silent on first launch post-upgrade — detect the legacy
  keychain entry, compute the new derived passphrase, run Pulumi's
  `Stack.changeSecretsProvider` to re-encrypt (trivial, no real secret
  content to move), forget the keychain entry, one log line, no user action.
- (B) An explicit wizard/settings action the user triggers manually.

Recommended (A), given "universally" and given there's nothing risky to
review in the re-encryption (no real secrets moving). Also flagged that this
change makes the following dead code, proposed as in-scope cleanup rather
than a separate task:
- `PulumiPassphraseUnavailableError` and its reason enum
- `generatePassphrase`, `resolveStoredPassphrase`, `resolveNewPassphrase`
- The `listStacks()` "no local record" probe and its create-vs-select
  branching in `getOrCreateStack`
- The `pulumi.passphrase` keychain field (after the one-time migration read)
- Wizard-side error surfacing tied to those failure reasons

**A4 (user):** "yeah go with option A" → confirms both (A) and the cleanup
being in scope.

## Converged design (summary)

- **Core mechanism**: `deriveStackPassphrase(accountId, stackName) =
  HMAC-SHA256(accountId + stackName, <fixed app-level salt constant>)`.
  `accountId` from STS `GetCallerIdentity`. Never stored — computed fresh
  every `getOrCreateStack` call. Any machine with valid credentials for the
  same AWS account derives the identical passphrase and can use the
  existing Pulumi state directly — no new stack, no `pulumi import`.
- **Migration**: automatic, silent, one-time per install, on
  `getOrCreateStack` when a legacy keychain passphrase is found.
- **Cleanup in scope**: removal of the passphrase-unavailable error
  machinery, generation/resolution helpers, the listStacks probe, and the
  keychain field, plus related wizard error surfacing.
- **Security note requiring explicit documentation**: the derived
  passphrase is not a confidentiality boundary — it never protected real
  secrets. This is made explicit rather than left as an accidental property.
  If a future need arises to put real secrets in Pulumi config, this scheme
  must be revisited (use Secrets Manager instead, per existing convention).
- **Explicitly out of scope**: no changes to where real secrets live, no
  "detect existing deployment" wizard UX (separate, already-identified
  gap — typing existing bucket names on wizard step 4 already works), no
  `pulumi import`/reconciliation flow.
