## Context

`PulumiWorkspaceService` (`app/packages/desktop-main/src/services/PulumiWorkspaceService.ts`)
is the Automation API seam every infrastructure operation goes through. It
uses a self-managed S3 state backend with `secretsProvider: 'passphrase'`
(no Pulumi Cloud). Today the passphrase is a random 32-byte value, generated
once per machine on first stack creation and persisted only in that
machine's OS keychain via `safeStorage`/electron-store
(`this.store.get('pulumi')?.passphrase`).

The passphrase is required by the Pulumi engine to construct the workspace
at all — there is no interactive fallback under the non-interactive mode the
Automation API always uses, so a missing passphrase is a hard failure at
stack creation, not a prompt. `getOrCreateStack` has three paths today:

1. **Passphrase already stored locally** → `resolveStoredPassphrase()`
   decrypts and returns it (fails loudly if the keychain is unavailable or
   decryption fails — `existing-stack-keychain-unavailable`,
   `existing-stack-decrypt-failed`).
2. **No local passphrase, stack doesn't exist remotely** →
   `resolveNewPassphrase()` generates and persists a fresh one.
3. **No local passphrase, stack already exists remotely** (the bug this
   change fixes) → `resolveNewPassphrase()` probes `ws.listStacks()`, finds
   the stack, and throws `PulumiPassphraseUnavailableError` (reason
   `existing-stack-no-local-record`) rather than generating a passphrase
   that could never decrypt the existing state.

Path 3 is exactly what happens when an operator points a second machine's
first-run wizard at the S3 buckets from an existing deployment (typing the
existing bucket names on wizard step 4, per `first-run-wizard.md`). It
blocks every Pulumi operation — refresh, preview, apply — on the new
machine, with no documented recovery.

Critically, the passphrase does not protect anything secret today.
`app/packages/infra/src/program.ts:123` confirms `pulumi.secret()` is never
used anywhere in the infra program. Real secrets (Discord bot token, IAM
access keys) live in AWS Secrets Manager (`app/packages/infra/src/secrets.ts`)
and `SafeStorageService`/electron-store — never in Pulumi stack config or
outputs. So today's passphrase is purely a machine-bound access gate on
state that has nothing sensitive in it, and that machine-binding is the bug.

Confirmed with the user during brainstorming: the goal is *not* encryption
strength or import/reconciliation — it's "move the app to another machine
without rebuilding infrastructure." A fresh-stack-plus-`pulumi import`
approach was considered and rejected as unnecessary and considerably more
expensive (S3 buckets/DynamoDB tables are created by name; a new empty
stack pointed at existing resources would hit "already exists" engine
errors on `pulumi up`, not silently adopt them — real reconciliation would
need per-resource `pulumi import`). Reusing the existing stack via a
portable passphrase avoids that entirely.

## Goals / Non-Goals

**Goals:**
- Any machine with valid AWS credentials for the deployment's AWS account
  can run Pulumi operations against the existing S3-backed stack, without
  first needing local state from a prior machine.
- Existing single-machine installs continue working with zero user action
  and zero risk of stack corruption during the transition.
- Remove the now-dead error-handling machinery this bug produced, rather
  than leaving it as unreachable code.
- Document explicitly that the secrets provider is not, and never was, a
  confidentiality boundary.

**Non-Goals:**
- Not changing where real secrets (Discord bot token, IAM keys) live — they
  already correctly live outside Pulumi state.
- Not building a "detect existing deployment" wizard UX — typing existing
  bucket names on wizard step 4 already routes into the existing-stack path
  and is unaffected by this change; that's a separate, already-identified
  gap.
- Not building a `pulumi import`/reconciliation flow — explicitly rejected
  in favor of reusing the existing stack directly.
- Not adding any new encryption/security boundary — this change is a
  strict simplification of an access mechanism, not a new secrets model.

## Decisions

### D1: Deterministic passphrase derivation, not stored

- **Choice**: `deriveStackPassphrase(accountId, stackName) =
  HMAC-SHA256(accountId + stackName, <fixed app-level salt constant>)`.
  `accountId` comes from STS `GetCallerIdentity` against the credentials the
  wizard/operation is already using. The result is never persisted; it is
  recomputed on every `getOrCreateStack` call.
- **Rationale**: makes the passphrase a pure function of "which AWS account
  and which stack," which is exactly the portability boundary the operator
  wants — any machine authenticated to the same account gets the same
  stack. Confirmed with the user that this is stable across access-key
  rotation, IAM user changes, and credential-mode switches (CLI profile vs.
  pasted keys), since account ID doesn't change with key rotation. Removes
  the entire "local record missing" failure class, because there is no
  local record to miss.
- **Alternatives considered**:
  - *Store the passphrase in the S3 config bucket* alongside
    `deployment-config.json`, readable by any machine with S3 access. Keeps
    a "generate once, persist" shape, but adds a new stored artifact to keep
    in sync, a new failure mode (bucket object missing/corrupted), and does
    not actually improve on deterministic derivation for the stated goal
    ("swap machines easily"). Rejected as unnecessary complexity.
  - *Keep the random per-machine passphrase, add explicit export/import
    UI.* Requires the operator to manually shuttle a secret value between
    machines every time they switch — exactly the friction the user wants
    removed. Rejected.

### D2: `secretsProvider` stays `'passphrase'`, not switched to `'none'`

- **Choice**: keep the Pulumi self-managed backend's `secretsProvider:
  'passphrase'` mechanism; only change how the passphrase value is
  obtained.
- **Rationale**: Pulumi's self-managed (non-Cloud) backend requires *some*
  secrets provider — there is no first-class "none" option — and changing
  the provider type itself is a larger, riskier migration than changing how
  one input value is computed. Since the passphrase already protects
  nothing secret, there's no security loss in continuing to use it; the fix
  only needed to address portability, not the encryption mechanism itself.
- **Alternatives considered**: switching to `secretsProvider: 'none'` or an
  equivalent no-op provider. Rejected — not clearly supported by Pulumi's
  self-managed backend, and provides no benefit over D1 once the passphrase
  is portable; would also be a larger, unnecessary blast radius for this
  change.

### D3: Automatic, silent, one-time migration for existing installs

- **Choice**: in `getOrCreateStack`, if a legacy keychain-stored passphrase
  is present (`store.get('pulumi')?.passphrase !== undefined`), read it,
  re-encrypt the stack's secrets provider to the newly-derived passphrase,
  delete the keychain entry, and log one line (`logger.debug`, per the
  repo's IPC/service logging convention — non-secret identifiers only). No
  wizard step, no settings toggle, no user-facing confirmation.
- **Re-encryption mechanism (implementation note)**: the Automation API's
  public TypeScript SDK (`@pulumi/pulumi@3.255.0`, the pinned version) does
  **not** expose a `changeSecretsProvider` method on `Stack` or
  `LocalWorkspace` — confirmed by reading the shipped `.d.ts` files. The
  CLI-invocation plumbing every `Stack` method uses internally to shell out
  to `pulumi` is declared `private`, so it isn't part of the supported
  public surface either. `Stack.exportStack()`/`importStack()` round-trip
  the checkpoint byte-for-byte, including the `secrets_providers` block, so
  they do not actually re-key anything. The only implementation of this
  rewrite is the `pulumi` CLI's own `stack change-secrets-provider
  <provider>` command. This means re-encryption must invoke the pinned CLI
  binary directly (the same binary `PulumiEngineService` already resolves)
  rather than going through a typed Automation API call. The exact
  non-interactive invocation contract (flags, env vars vs. stdin prompts for
  the new passphrase) is not assumed here — it MUST be confirmed by an
  implementation-time spike against the actual pinned CLI version's
  `--help` output before any migration code is written, since Pulumi's
  non-interactive behavior for this specific command has changed across CLI
  versions historically. See the implementation plan's Task 3, Step 3.0 for
  the spike and its findings.
- **Rationale**: user explicitly chose "universally" over a dual-mode
  system, and confirmed automatic migration (Option A) over an explicit
  user-triggered action. Since there is no real secret content being
  re-encrypted, there's nothing for the user to meaningfully review before
  approving — an explicit step would just be a confirmation dialog with no
  decision behind it.
- **Alternatives considered**: an explicit "Migrate to portable secrets"
  action in settings/wizard. Rejected as needless friction for a change
  with no real content at risk.

### D5: `pulumi.stackInitialized` replaces the passphrase-as-existence check in `PulumiService.ts`

- **Choice**: `PulumiService.ts` uses
  `this.store.get('pulumi')?.passphrase !== undefined` in three places
  (`getStackOutputs`, `destroy`, `clearStaleLock`) purely as a local "has
  this install ever successfully created/selected a stack" signal —
  unrelated to the passphrase's cryptographic role. Once the passphrase is
  derived rather than stored, that signal is permanently absent and those
  three methods would silently misbehave. A plain `pulumi.stackInitialized:
  boolean` flag, written on every successful `getOrCreateStack` call, is a
  like-for-like replacement scoped to exactly this bookkeeping role.
- **Rationale**: not discovered during brainstorming (neither the original
  problem investigation nor `PulumiWorkspaceService.ts` alone surfaced
  these three call sites in a different file); found while writing the
  detailed implementation plan by re-reading `PulumiService.ts` line by
  line. Folding it in here keeps `design.md` accurate rather than letting
  the implementation plan silently diverge from the design it's supposed to
  implement.
- **Alternatives considered**: derive the passphrase once at service
  construction and cache it in memory for the process lifetime, letting
  existing `!== undefined` checks keep working against an in-memory value.
  Rejected — reintroduces a stored/cached passphrase (in memory rather than
  disk) for a purpose (existence-checking) that a plain boolean serves
  without ever holding the passphrase value outside the single call that
  needs it.

### D4: Remove dead error-handling machinery in the same change

- **Choice**: delete `PulumiPassphraseUnavailableError` and its reason enum,
  `generatePassphrase`, `resolveStoredPassphrase`, `resolveNewPassphrase`,
  the `workspace.listStacks()` "no local record" probe and its
  create-vs-select branching in `getOrCreateStack`, the `pulumi.passphrase`
  store field (after the one-time migration read), and wizard-side error
  surfacing tied to those failure reasons.
- **Rationale**: under the derived-passphrase model, none of these failure
  modes can occur — the passphrase is always computable from data the
  caller already has (account ID + stack name), so there is no "keychain
  unavailable for an existing stack" or "no local record" state to detect
  or report. Leaving this code in place would be dead, untestable-by-design
  machinery that misleads future readers about how the system actually
  behaves.
- **Alternatives considered**: leave the old machinery in place, unreachable,
  in case of future rollback. Rejected — the migration plan below gives a
  clean rollback path without keeping dead code live; per repo convention,
  don't design for hypothetical future requirements.

## Risks / Trade-offs

- **[Trade-off]** Any machine that can authenticate to the AWS account can
  now access the Pulumi stack, with no additional per-machine gate. →
  Accepted: this was already true of `deployment-config.json` in S3, of the
  AWS console itself, and of every other AWS resource in the account — AWS
  IAM is the actual access boundary for this deployment, not a Pulumi
  passphrase. This change removes a redundant, inconsistent gate rather
  than a real one.
- **[Risk]** A bug in the HMAC derivation (e.g. an accidental change to the
  salt constant, or a bug in how `accountId`/`stackName` are concatenated)
  would silently produce a different passphrase than previously-migrated
  installs expect, breaking access to already-migrated stacks. → Mitigation:
  cover `deriveStackPassphrase` with unit tests asserting exact output for
  fixed inputs (regression-pins the derivation), and treat the salt
  constant as a frozen value once shipped — changing it later is equivalent
  to a breaking migration and must be treated as one.
- **[Risk]** The CLI-based re-encryption (see D3's implementation note)
  could fail mid-migration (e.g. network interruption, or a CLI
  invocation-contract mismatch not caught by the pre-implementation spike),
  leaving an install in an inconsistent state. → Mitigation: only delete the
  keychain entry after re-encryption succeeds; if it fails, the keychain
  entry remains and the next launch retries the migration using the same
  (still valid) legacy passphrase. Idempotent by construction.
- **[Trade-off]** This change is a breaking change to
  `PulumiWorkspaceService`'s internal contract (passphrase resolution
  logic is fully replaced). → Accepted: no external API changes; fully
  covered by the migration path for existing installs, and new installs
  never see the old path at all.

## Migration Plan

1. Implement `deriveStackPassphrase(accountId, stackName)` and wire it into
   `getOrCreateStack` as the sole passphrase source for new stack
   creation/selection.
2. Spike the CLI's non-interactive `stack change-secrets-provider`
   invocation contract against the pinned engine version (D3's
   implementation note), then implement the one-time migration check: on
   `getOrCreateStack`, if a legacy keychain passphrase exists, re-encrypt
   from the legacy passphrase to the derived one via that CLI invocation,
   then remove the keychain entry only on success. Add
   `pulumi.stackInitialized` (D5) and update `PulumiService.ts`'s three
   existence checks to use it.
3. Remove `PulumiPassphraseUnavailableError`, its reason enum, and the
   generation/resolution helpers listed in D4, along with the
   `listStacks()` create-vs-select probe now made unnecessary (the derived
   passphrase works identically whether the stack is new or existing, so
   `Stack.createOrSelect` can be called directly).
4. Remove wizard-side (`FirstRunWizardService`) error handling tied to the
   removed error reasons; update `reset()` to stop preserving
   `pulumi.passphrase` (the field no longer exists post-migration).
5. Update `docs/docs/components/infra.md` (secrets provider section) and
   `docs/docs/app/first-run-wizard.md` (step 5's multi-machine caveat) to
   reflect the new model, per CLAUDE.md's "docs ship with the behavior
   change" rule.
6. **Rollback**: if a defect is found post-release, the migration is
   inherently one-directional per install (legacy passphrase is deleted
   after successful migration), but rollback of the *code* is safe at any
   point before an install has migrated — an unmigrated install on a
   rolled-back version simply continues using its legacy keychain
   passphrase unaffected. An already-migrated install cannot be rolled back
   to the keychain model without restoring the deleted keychain entry from
   a backup; this matches the existing (already-accepted) risk profile of
   losing the keychain entry today.
- Acceptance criteria: `npm run app:test` and `npm run app:test:integration`
  green, including new tests for `deriveStackPassphrase` (fixed-input
  regression), the migration path (success, and retry-after-failure), and
  removal of all references to the deleted error type across the codebase
  (`npm run app:typecheck` clean confirms this).

## Open Questions

None — the user confirmed all forks during brainstorming (derivation over
storage, universal application, automatic silent migration, cleanup in
scope).
