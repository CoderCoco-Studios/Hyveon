# Verification Report

> This file is produced by the `openspec-verify-change` skill after apply
> completes, to confirm the implementation is consistent with specs / design /
> tasks. A failed check must go back to the relevant artifact for a fix, then
> verify re-runs.

**Change**: `pulumi-portable-passphrase`
**Verified at**: `2026-08-13 18:55`
**Verifier**: Claude Sonnet 5 (subagent-driven-development executor, this session)

---

## 1. Structural Validation (`openspec validate --all --json`)

- [x] All items `"valid": true`

**Result**:

```text
33 items checked (specs + changes across the repo), 0 invalid.
This change's own items:
  - pulumi-portable-passphrase (change): valid: true, 0 issues
  - pulumi-engine-runtime delta spec (specs/pulumi-engine-runtime/spec.md): valid: true
```

No failing items.

---

## 2. Task Completion (`tasks.md`)

- [ ] All `- [ ]` have become `- [x]` — 23/24, one intentionally deferred

**Incomplete tasks**:

| Task | Reason incomplete | Blocks archive? |
|---|---|---|
| 6.5 — manual real-AWS end-to-end verification with a second, independently-created credential set | Requires a real AWS test account; `plan.md`'s own Task 6 text states this is "out of scope for an automated plan step" and must be flagged to the operator, not scripted, in this implementation session | No — explicitly scoped out by the plan itself; flagged in the PR description for the operator to perform post-merge |

---

## 3. Delta Spec Sync State

| Capability | Sync status | Notes |
|---|---|---|
| pulumi-engine-runtime | ✗ needs sync | `openspec/specs/pulumi-engine-runtime/spec.md:77` still states the old model verbatim ("MUST therefore generate the passphrase, persist it through the OS-level encrypted store... MUST fail loudly rather than silently generating a second passphrase") plus a stale `Scenario: Missing passphrase for an existing stack fails loudly`. The delta at `openspec/changes/pulumi-portable-passphrase/specs/pulumi-engine-runtime/spec.md` is correct and complete (derivation, non-confidentiality-boundary, migration, retry, `stackInitialized` marker, second-machine scenario). Sync happens at the archive step (`openspec archive`), per this schema's own instruction sequence — not a defect in this verify pass, just not yet performed. |

---

## 4. Design / Specs Coherence Spot Check

| Sample item | design description | specs mapping | Gap |
|---|---|---|---|
| D1: HMAC-SHA256, not a general KDF | `design.md` states this is deliberate — the input space (accountId + stackName) isn't attacker-guessable low-entropy secret material, so a KDF's slow-hash property buys nothing | Delta spec: "using a fixed app-level derivation constant" (no KDF requirement) | None |
| D2: not a confidentiality boundary | `design.md` cites the infra program never calling `pulumi.secret(...)` | Delta spec: "MUST NOT be treated as a confidentiality boundary... gates access to non-sensitive state only" | None — independently re-confirmed by the final whole-branch review against `app/packages/infra/src/program.ts` |
| D3: automatic, silent, one-time migration | `design.md`'s migration plan (re-encrypt via CLI, remove legacy entry only after success, retry on failure) | Delta spec: "A legacy per-machine passphrase is migrated automatically" + "Legacy migration is retried after a failed re-encryption" scenarios | None |
| D4: `stackInitialized` as like-for-like replacement for the old existence check | `design.md`/`plan.md` Overview note the `PulumiService.ts` gap found during planning (three `pulumi.passphrase !== undefined` checks) | Delta spec: "Local initialization marker is set/not set" scenarios | None |

**Drift warning** (non-blocking): None.

---

## 5. Implementation Signal

- [x] No unstaged files in the worktree (only this new `verify.md` itself is untracked, pending commit)
- [x] All relevant implementation commits exist in local history

**Commit range**: `c8c6d027..d7ea6c6d` (10 commits)

```
c2266122 wip(infra): add deriveStackPassphrase and resolveAwsAccountId (Task 1/6)
d88d980c fix(infra): remove unnecessary type cast from STS client test stubs (Task 1 fix round 1)
ff4df306 fix(infra): use aws-sdk-client-mock for STS mocking in resolveAwsAccountId tests (Task 1 fix round 2)
964c26a6 feat(infra): derive the Pulumi secrets passphrase from the AWS account instead of storing it
5067f0e3 fix(infra): catch/normalize STS failures and fix test-only type issues (Task 2 fix round 1)
291abdf6 feat(infra): migrate installs with a legacy stored Pulumi passphrase to the derived one automatically
98e5e308 refactor(infra): remove the dead passphrase-unavailable error machinery replaced by derivation
9ef189ad docs(infra): document the derived, portable Pulumi secrets passphrase
12220b0e chore(infra): mark Task 6 verification gate complete in tasks.md
d7ea6c6d fix(infra): fail clearly when the keychain is unavailable during legacy passphrase migration
```

---

## 6. Front-Door Routing Leak Detector

Detection:

```bash
ls docs/superpowers/specs/*.md 2>/dev/null
```

- [x] No files, or any existing files are legitimate leftovers from before the schema was installed

**Leak list**:

| File | Produced this cycle? | Content already captured in the change? | Suggested action |
|---|---|---|---|
| `docs/superpowers/specs/2026-05-10-electron-desktop-pivot-design.md` | No — filename-dated 2026-05-10, more than three months before this cycle's commit range (2026-08-13) | N/A, unrelated content (Electron desktop pivot, not this change) | None — pre-existing, non-blocking |

---

## 7. Deferred Manual Dogfood vs Automated Test Equivalence

`plan.md` has zero `[~]`-marked deferred rows (confirmed: `grep -c '\[~\]' plan.md` → 0). This section is left blank per the template's own rule ("when plan.md has no rows marked `[~]` at all, this section doesn't need to be filled in").

Note: `tasks.md` §6.5 (the manual real-AWS check) is a `tasks.md`-level deferral, not a `plan.md` `[~]`-marked one — it's tracked in §2 above instead, per this template's distinction between the two artifacts.

---

## Overall Decision

- [x] ✅ PASS — may proceed to finishing-a-development-branch and archive
- [ ] ⚠️ PASS WITH WARNINGS — may proceed but note: `<explanation>`
- [ ] ❌ FAIL — go back to the failing artifact, fix it, then re-run verify

**Next step**: Produce `retrospective.md`, then run `openspec archive` (syncs the delta spec into `openspec/specs/pulumi-engine-runtime/spec.md` and moves the change folder to `openspec/changes/archive/`), then use `superpowers:finishing-a-development-branch` to open the PR. Note in the PR description: task 6.5 (real-AWS second-credential-set verification) is deferred to the operator post-merge.
