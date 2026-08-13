## Why

The Pulumi secrets passphrase is generated per machine and stored only in that
machine's OS keychain, but the S3-backed Pulumi state it protects contains no
actual secrets — nothing in `app/packages/infra` uses `pulumi.secret()`, and
real secrets already live in AWS Secrets Manager and `SafeStorageService`.
Because the passphrase is machine-bound, pointing a second machine at an
existing deployment's S3 buckets hard-fails every Pulumi operation
(`PulumiPassphraseUnavailableError`) even though the operator has full AWS
access to the account. Operators who reasonably expect to run Hyveon from a
different or replacement machine currently cannot, without a manual, mostly
undocumented passphrase-backup workaround.

## What Changes

**Secrets passphrase derivation**
- From: a random 32-byte passphrase generated once per machine and persisted
  only in that machine's OS keychain (`safeStorage`).
- To: a passphrase deterministically derived per-operation as
  `HMAC-SHA256(AWS account ID + stack name, fixed app-level salt)`, using the
  AWS account ID from STS `GetCallerIdentity`. Never stored; computed fresh
  on every `getOrCreateStack` call.
- Reason: makes the passphrase portable across any machine holding valid
  credentials for the same AWS account, without weakening anything (no real
  secret content was ever protected by it).
- Impact: breaking change to `PulumiWorkspaceService`'s internal contract;
  no user-visible API change. Existing installs migrate automatically (see
  below).

**Existing-install migration**
- From: nothing — a second machine encountering an existing remote stack
  with no local passphrase record fails immediately.
- To: on `getOrCreateStack`, a legacy keychain-stored passphrase (if present)
  is read once, used to re-encrypt the stack's secrets provider to the new
  derived passphrase via the `pulumi` CLI's `stack change-secrets-provider`
  command (the Automation API's public TypeScript SDK does not expose this
  as a typed method — the exact non-interactive invocation is confirmed by
  an implementation-time spike, see `design.md` D3), and then the keychain
  entry is deleted. Silent, automatic, one log line, no user action.
- Reason: existing single-machine installs must not break, and the
  passphrase-unavailable error must never be encountered on the machine that
  originally created the stack.
- Impact: non-breaking for existing installs; runs once, transparently, on
  first launch of the upgraded app.

**Dead-code removal**
- From: `PulumiPassphraseUnavailableError` and its reason enum
  (`new-stack-keychain-unavailable`, `existing-stack-keychain-unavailable`,
  `existing-stack-decrypt-failed`, `existing-stack-no-local-record`),
  `generatePassphrase`, `resolveStoredPassphrase`, `resolveNewPassphrase`,
  the `workspace.listStacks()` "no local record" probe and its
  create-vs-select branching, and wizard-side error surfacing tied to those
  failure reasons.
- To: removed. The derived-passphrase path never has a "keychain
  unavailable" or "no local record" failure mode — the passphrase is always
  computable from data the caller already has.
- Reason: this machinery existed only to work around a class of failure that
  no longer exists once the passphrase is portable.
- Impact: non-breaking; internal cleanup only.

## Capabilities

### Modified Capabilities
- `pulumi-engine-runtime`: the "Automation API workspace seam" requirement's
  secrets-passphrase behavior changes from per-machine keychain-generated to
  deterministically derived and portable across machines, with automatic
  one-time migration for existing keychain-stored passphrases.

## Impact

- `app/packages/desktop-main/src/services/PulumiWorkspaceService.ts` —
  passphrase generation/resolution rewritten; `PulumiPassphraseUnavailableError`
  and related helpers removed.
- `app/packages/desktop-main/src/services/FirstRunWizardService.ts` — wizard
  step 5 error surfacing tied to the removed failure reasons goes away;
  `reset()`'s doc comment is updated to describe the still-live
  `pulumi.stackInitialized` flag (see below) rather than the passphrase.
- `app/packages/desktop-main/src/services/PulumiService.ts` — three call
  sites (`getStackOutputs`, `destroy`, `clearStaleLock`) currently use
  `pulumi.passphrase !== undefined` as a local "has a stack ever been
  created" signal, unrelated to the passphrase's cryptographic role; these
  move to a new `pulumi.stackInitialized: boolean` flag.
- Electron-store schema: adds `pulumi.stackInitialized: boolean`, written on
  every successful `getOrCreateStack`, replacing the `pulumi.passphrase !==
  undefined` existence check at the three `PulumiService.ts` call sites
  above. `pulumi.passphrase` is kept in the type permanently (`@deprecated`,
  read-only, write/generation paths removed) as the one-time per-install
  migration's input — it is not scheduled for removal in a later change,
  since an install that has not yet run the migrating code still needs it.
- `docs/docs/components/infra.md` — passphrase/secrets-provider section
  rewritten to describe the derived, portable model and state explicitly
  that it is not a confidentiality boundary.
- `docs/docs/app/first-run-wizard.md` — step 5's passphrase-decrypt-failure
  caveat for multi-machine use is removed (no longer applies).
- No change to where real secrets (Discord bot token, IAM keys) are stored.
- No change to the wizard's "existing bucket names" flow (step 4) — this
  proposal only removes the Pulumi-side blocker that flow currently runs
  into.
