## 1. Passphrase derivation

- [x] 1.1 Add `deriveStackPassphrase(accountId: string, stackName: string): string` to `PulumiWorkspaceService.ts` — `HMAC-SHA256(accountId + stackName, <fixed app-level salt constant>)`, hex-encoded output. TSDoc explains it is not a confidentiality boundary and why (per `docs/docs/components/infra.md` D2/D1 rationale).
- [x] 1.2 Add a way to resolve the AWS account ID from the credentials already in use for the operation, via `sts:GetCallerIdentity` against credentials from `resolveAwsClientCredentials` (`awsCredentialSource.ts`) — the shared credential-resolution seam, not `AwsProfileService`'s pasted-keys-only STS client builder.
- [x] 1.3 Unit tests for `deriveStackPassphrase`: fixed-input regression (exact expected output for known `accountId`/`stackName` pairs, pinning the salt constant), and that different `accountId` or `stackName` inputs produce different outputs.

## 2. Rewire `getOrCreateStack`

- [x] 2.1 Replace the three-path passphrase resolution in `getOrCreateStack` (stored / generate-new / existing-stack-no-record) with: resolve account ID → derive passphrase → set `PULUMI_CONFIG_PASSPHRASE` → call `Stack.createOrSelect` directly (no more `listStacks()` probe to decide create-vs-select).
- [x] 2.2 Add `pulumi.stackInitialized: boolean` to the electron-store schema, written on every successful `getOrCreateStack` call — replaces the `pulumi.passphrase !== undefined` existence check `PulumiService.ts` currently relies on in three places (see 4.2), since that check becomes permanently false once the passphrase stops being stored.
- [x] 2.3 Update/replace the `getOrCreateStack` tests in `PulumiWorkspaceService.test.ts` covering: first-ever stack creation, selecting an already-existing stack (same machine), and selecting an already-existing stack with no local passphrase record (the previously-broken second-machine case) — assert all three now succeed via the same derived value.

## 3. Legacy migration

- [x] 3.0 Spike: determine the `pulumi` CLI's non-interactive `stack change-secrets-provider` invocation contract against the pinned engine version (`--help` output, env vars vs. stdin prompts for the new passphrase) — the Automation API's public TypeScript SDK does not expose this as a typed method (confirmed: no `changeSecretsProvider` on `Stack`/`LocalWorkspace` in `@pulumi/pulumi@3.255.0`'s `.d.ts`), so this must invoke the pinned CLI binary directly. Write the finding into the migration function's doc comment before writing any migration code against it.
- [x] 3.1 Add a migration step at the start of `getOrCreateStack`: if `store.get('pulumi')?.passphrase` is set, read it, re-encrypt via the CLI invocation determined in 3.0 from the legacy value to the newly-derived one, and only remove the `pulumi.passphrase` store entry after that call succeeds.
- [x] 3.2 Unit tests: successful migration (keychain entry removed, subsequent operation uses derived passphrase), and failed re-encryption (keychain entry retained, next call retries migration using the same legacy value — no double-migration bug, no data loss).
- [x] 3.3 Add one `logger.debug` line on successful migration, non-secret identifiers only (stack name), per `.claude/rules/logging.md`.

## 4. Remove dead code

- [x] 4.1 Delete `PulumiPassphraseUnavailableError`, its reason enum, `generatePassphrase`, `resolveStoredPassphrase`, `resolveNewPassphrase`, and the `listStacks()` create-vs-select probe from `PulumiWorkspaceService.ts`.
- [x] 4.2 In `PulumiService.ts`, replace all three `pulumi.passphrase !== undefined` existence checks (`getStackOutputs`, `destroy`, `clearStaleLock`) with `pulumi.stackInitialized === true` (added in 2.2); update the error-message text in `destroy`/`clearStaleLock` that currently implies a passphrase check. Update `classifyGetOrCreateStackFailure`'s doc comment and the now-unused `PulumiPassphraseUnavailableError` import/branch.
- [x] 4.3 Remove the `pulumi.passphrase` field's write/generate paths from the electron-store schema. Keep the field in the type permanently, marked `@deprecated` and read-only — it is the one-time per-install migration's input, and there is no way to know in advance that every possible install has already migrated, so it is not removed in a future change.
- [x] 4.4 Search the codebase (`grep -rn PulumiPassphraseUnavailableError`) for any remaining references (wizard controllers, IPC error mapping, tests) and remove them.
- [x] 4.5 Confirm whether `FirstRunWizardService.ts`'s `reset()` needs a behavior change — it may already correctly omit `pulumi.*` from what it clears (verify against the current file rather than assuming); if so, only its doc comment needs updating to describe `pulumi.stackInitialized` instead of the passphrase.
- [x] 4.6 `npm run app:typecheck` clean — confirms no dangling references to the removed error type or helpers anywhere in the workspace.

## 5. Docs

- [x] 5.1 Rewrite the secrets-provider/passphrase section of `docs/docs/components/infra.md` to describe the derived, portable model, and state explicitly that it is not a confidentiality boundary.
- [x] 5.2 Update `docs/docs/app/first-run-wizard.md`'s passphrase-related prose (verify against the current file rather than assuming a specific caveat exists) so it reflects that the passphrase is derived, not stored — no locally-stored-record limitation remains for pointing the wizard at an existing deployment's bucket names on step 4.
- [x] 5.3 Run the `write-docs` skill's evaluator agents (accuracy, coverage, style) over the updated pages before opening the PR, per CLAUDE.md.

## 6. Verification

- [ ] 6.1 `npm run app:lint` clean.
- [ ] 6.2 `npm run app:typecheck` clean.
- [ ] 6.3 `npm run app:test` full unit suite green.
- [ ] 6.4 `npm run app:test:integration` green (Pulumi orchestration changed).
- [ ] 6.5 Manually verify end-to-end on a real AWS test account if feasible: bootstrap from one credential set, then run a Pulumi operation using a second, independently-created credential set (e.g. a different IAM user) in the same account, confirming no `PulumiPassphraseUnavailableError`-equivalent failure occurs.
