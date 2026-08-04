# Group 5: IAM permission gate

## Context

Part of OpenSpec change `add-one-click-aws-bootstrap`
(`openspec/changes/add-one-click-aws-bootstrap/design.md` Decision 4;
spec `cloud-bootstrap`, "IAM permission simulation" MODIFIED requirement).
Today `IamCheckService.checkPermissions()` is purely advisory — every
result (`passed`/`missing`/`warning`) is non-blocking on every path. After
guided IAM provisioning (Groups 1-3, already merged onto this branch's
base) the permission set is known by construction, so a `missing` result
there indicates a real fault (wrong account, partially-failed
CloudFormation stack, a denying SCP) — this group makes `missing` block
progression on the guided path specifically, while staying advisory
everywhere else. This group changes `IamCheckService`'s **result shape and
gating logic only** — no controller, no UI. A later group (stacked next)
wires the actual "don't let the wizard advance" enforcement into the UI.

## Global Constraints

**File:** `app/packages/desktop-main/src/services/IamCheckService.ts`. Read
it in full first — you're extending `checkPermissions()`'s return shape
and adding one new piece of logic (origin resolution), not rewriting the
simulation itself (the batched `SimulatePrincipalPolicy` calls, the
`describeError`/`chunk` helpers, `resolveClientConfig()` — all untouched).

**Origin resolution — the load-bearing new logic.** `IamCheckResult` gains
an `origin` field, one of `'guided' | 'pasted' | 'profile' | 'none'`.
Resolve it via `resolveAwsCredentialSource(this.store)` (already imported
and used by this file's `resolveClientConfig()` — reuse the same call, add
one more branch of interpretation):

- `kind: 'none'` → `origin: 'none'`
- `kind: 'profile'` → `origin: 'profile'`
- `kind: 'pasted'` → `origin: 'guided'` when `source.profile === GUIDED_PROFILE_NAME`
  (import from `./GuidedIamService.js` — this constant is exactly why
  Group 2 gave the guided path a distinct profile name from
  `AwsProfileService`'s `DEFAULT_PASTED_PROFILE_NAME`), otherwise
  `origin: 'pasted'` (a manually-pasted key, not guided-provisioned).

**Blocking computation.** Add a `blocking: boolean` field to
`IamCheckResult`, computed as `status === 'missing' && origin === 'guided'`
— `true` only in that exact combination. `warning` NEVER blocks regardless
of origin (per the spec: "Simulation failure... MUST degrade to a warning
... it never blocks"). `missing` on `profile`/`pasted`/`none` origins is
advisory (`blocking: false`) — an operator may deliberately run a narrower
policy on those paths. `passed` is never blocking. This one boolean is
what a later group's wizard UI reads to decide whether to let the operator
continue — do not also expose a separate "should the UI block" decision
anywhere else; this field is the single source of truth for that
decision, per Task 5.1's "so callers can decide gating."

**Task 5.4 scoping — read carefully, this determines what NOT to build.**
The spec's "Gate runs after rotation" scenario ("the simulation runs
against the rotated key that the app retains, not against the bootstrap
key issued by the stack") is satisfied **automatically, with zero new
code**, by how credential resolution already works: `GuidedIamService.rotate()`
(Group 2) writes the rotated key as the active source
(`store.set('aws', { profile: GUIDED_PROFILE_NAME, region })`) *before*
returning `complete`, and `IamCheckService.resolveClientConfig()` already
reads that same active source on every call — so a caller invoking
`checkPermissions()` any time after `rotate()` resolves is, by
construction, checking the rotated key, not the bootstrap key. **Do not
add a new method, a new parameter, or any explicit "run after rotation"
orchestration code** — that would be new plumbing solving an already-solved
problem. This task's job is narrower and concrete: write a test that
*proves* the zero-new-code claim (simulate a full rotate-then-check
sequence and assert the IAM/STS clients `checkPermissions()` builds are
constructed from the ROTATED credentials, not the bootstrap ones) — a
regression test for an invariant, not new production code. The actual
"call `checkPermissions()` right after `rotate()`" *orchestration* — i.e.,
which controller or UI step triggers that call — is a separate, later
group's wiring job (the IPC surface / wizard UI groups stacked next); this
group only guarantees the result would be correct *if* something calls it
there.

**Never** change `checkPermissions()`'s existing batching/simulation logic,
`buildPolicyJson()`, or `resolveClientConfig()`'s credential-resolution
mechanics — this group only adds the origin/blocking computation around
the existing result.

## Task 1: 5.1-5.3 Origin and blocking fields

Extend `IamCheckResult` with `origin: IamCheckOrigin` and `blocking: boolean`
per Global Constraints. Add the `resolveOrigin()` private method (or
equivalent). Populate both fields on every `checkPermissions()` return path
(`passed`, `missing`, `warning` — all three currently have multiple return
statements in the method; every one needs both new fields, not just the
`missing` one). This single task covers 5.1 (the field addition), 5.2 (the
guided+missing→blocking case), and 5.3 (every other combination stays
non-blocking) — they're one continuous piece of logic, not separable
code paths.

## Task 2: 5.4 Rotation-integration regression test

Per Global Constraints' "Task 5.4 scoping" section: write ONE test proving
`checkPermissions()`, called after `GuidedIamService.rotate()` completes,
resolves against the rotated credentials — not the bootstrap key, not a
stale cached client. No new production code for this task unless your
test reveals the zero-new-code claim is actually false (in which case,
stop and report BLOCKED with what you found rather than guessing a fix —
that would mean Global Constraints' scoping assumption is wrong and needs
a controller-level decision, not a quiet workaround here).

## Task 3: 5.5 Full combination test coverage

Comprehensive tests covering all four combinations of (guided origin,
manual origin — test both `profile` and `pasted` sub-cases for "manual")
× (`missing`, `warning`) results, confirming `blocking` computes correctly
in every cell, plus the trivial `passed`/`none` cases. If Tasks 1-2 already
wrote focused tests covering some of this (likely, since Task 1's
implementation naturally needs tests to verify itself), do NOT duplicate
— this task's job is to confirm full coverage exists and fill any genuine
gap, same pattern as Groups 2/3's final testing tasks.
