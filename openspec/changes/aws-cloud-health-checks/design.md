## Context

Starting a game server (ECS `RunTask`) can fail with
`InvalidParameterException: Unable to assume the service linked role` when
the AWS account is missing the `AWSServiceRoleForECS` service-linked role
(SLR). This role is normally auto-created on first ECS API use, but is
absent on fresh accounts, on accounts where it was deleted, or on accounts
bootstrapped before the deploy IAM policy allowed creating it. Today the
only trace of the failure is the desktop app's log file
(`EcsService.ts:295`), and the only fix is running
`aws iam create-service-linked-role --aws-service-name ecs.amazonaws.com` by
hand. More broadly, the app has no surface that answers "is my AWS account
healthy enough to run Hyveon?" outside the one-time first-run wizard.

Prior art surveyed during brainstorming (see `brainstorm.md`):
`BootstrapService`'s idempotent `ensureX()` pattern, the wizard's
`bootstrap-step.component.tsx` row layout, and `IamCheckService`'s
copyable-policy-JSON fallback for missing permissions. This design builds on
all three rather than inventing new patterns.

## Goals / Non-Goals

**Goals:**
- An always-visible "Cloud Health" checklist on the Settings page, one row
  per account-level prerequisite (user-approved via mockup: Option B,
  always-visible checklist, over a collapsed-summary alternative).
- Ship exactly one real check: does `AWSServiceRoleForECS` exist.
- Each row shows a status badge and, when broken, a Fix action that tries
  the real remediation with the operator's stored credentials, falling back
  to instructions (the updated policy JSON) if the account's deploy policy
  predates this permission.
- A typed, extensible check list (`CloudHealthCheck[]`) so a future check is
  one new array entry, not new UI.

**Non-Goals:**
- No background polling — checks run on Settings mount and on a manual
  Refresh button. SLR existence essentially never changes on its own once
  fixed.
- No folding of `IamCheckService`'s full permission-simulation flow into
  this list — that remains wizard-only, answering a different question.
- No auto-editing of the operator's CloudFormation stack — if the deploy
  policy itself needs updating, the operator applies that via their own CFN
  update, same trust boundary as every other IAM change in this app.
- No change to `EcsService.start`/`stop` beyond what PR #468 already
  shipped. Cloud Health is a separate, proactively-checked surface; it is
  not wired into the `RunTask` failure path in this change.
- No additional prerequisite checks beyond the ECS service-linked role in
  this change.

## Decisions

### D1: Surface as an always-visible Settings checklist, not a wizard self-heal

- **Choice**: A new "Cloud Health" section on the Settings page, always
  rendered, with one row per check.
- **Rationale**: the operator explicitly wants visibility and control — "I
  shouldn't have to manage this... direct someone to the settings page when
  we detect bad health" — rather than the app silently auto-fixing things on
  `start()`. A dedicated, always-visible location also generalizes to future
  checks without inventing a new UI each time.
- **Alternatives considered**: (a) silent self-heal inside
  `EcsService.start()` — rejected, hides account-level problems from the
  operator and couples an account-config concern to a per-action code path;
  (b) collapsed summary card that expands only when something's wrong —
  presented as a mockup alongside the checklist, operator chose the
  always-visible checklist instead.

### D2: Extensible typed check list, seeded with one check

- **Choice**: `CLOUD_HEALTH_CHECKS: CloudHealthCheck[]` — each entry `{id,
  label, check(), fix()}`. Ships with exactly one entry (ECS
  service-linked-role).
- **Rationale**: the always-visible checklist UI only makes sense backed by
  a list; building the list as a typed array costs nothing extra now and
  means a future check (e.g. another SLR, a hosted-zone gap) is one new
  entry rather than new plumbing. YAGNI on the content — no other check is
  implemented in this change.
- **Alternatives considered**: hardcoding a single non-list check directly
  in the controller — rejected, would need a rewrite the moment a second
  check is needed, for no savings today (the list wrapper is trivial).

### D3: Fix tries inline remediation, falls back to policy-JSON instructions

- **Choice**: the Fix action calls `iam.createServiceLinkedRole` directly
  with the operator's already-stored credentials. Success or "already
  exists" → row goes green. `AccessDeniedException` → the row expands to
  show the updated `HyveonDeployAll` policy JSON (reusing the exact
  copyable-`<pre>`-block pattern the wizard's `IamCheckService` "missing"
  state already renders), with an explanation that the operator's deploy
  policy predates this permission and needs a CloudFormation stack update.
- **Rationale**: one AWS account (the one that hit this exact bug) will have
  an out-of-date `HyveonDeployAll` policy that doesn't yet grant
  `iam:CreateServiceLinkedRole` — a CloudFormation-managed resource that
  code changes to `iamPolicy.ts` don't retroactively update. The Fix action
  needs to succeed for new/updated accounts in one click, while degrading
  gracefully (not silently failing) for accounts that haven't updated their
  stack yet.
- **Alternatives considered**: always show instructions, never call AWS
  directly — rejected, makes every operator do manual work even when a
  single click could have fixed it; the inline-attempt approach only adds
  work for the subset of operators whose policy is genuinely out of date.

### D4: New `iamPolicy.ts` statement scoped to the ECS SLR path

- **Choice**: add `HyveonServiceLinkedRoles` — `iam:CreateServiceLinkedRole`
  on `arn:aws:iam::*:role/aws-service-role/ecs.amazonaws.com/AWSServiceRoleForECS*`,
  conditioned on `iam:AWSServiceName: ecs.amazonaws.com`.
- **Rationale**: confirmed safe during research — this action is scopable by
  both resource path and the `iam:AWSServiceName` condition key, and AWS
  (not the caller) fixes the created role's trust policy and attached
  managed policy, so there's no privilege-escalation surface. It's strictly
  narrower than the `iam:*` (on `hyveon-*` resources) already granted by the
  existing `HyveonIAM` statement.
- **Alternatives considered**: granting broader `iam:CreateServiceLinkedRole`
  with no resource/condition scoping — rejected as unnecessarily broad given
  the scoped form is just as effective and costs nothing extra to write.

## Risks / Trade-offs

- [Risk] Existing (already-bootstrapped) operators' CloudFormation stacks
  won't have the new IAM statement until they update their stack, so the
  in-app Fix click will fail with AccessDenied for them on first try. →
  Mitigation: D3's fallback path shows the exact policy JSON needed and how
  to apply it (via CFN), so the operator isn't left with an opaque failure —
  this is the expected path for every pre-existing install, not an edge
  case.
- [Trade-off] No polling means a fixed-by-console-workaround state won't
  reflect until the operator revisits Settings or clicks Refresh. → Accepted:
  SLR existence changes are rare and operator-initiated (via this same UI),
  so staleness is self-correcting the moment they interact with the page.
- [Trade-off] Shipping only one check now means the "framework" is unproven
  against a second real check. → Accepted: the check-list shape mirrors
  `BootstrapService`'s already-proven `ensureX()` pattern, so the risk of
  the abstraction being wrong is low; deferred until a second check is
  actually needed (YAGNI).

## Migration Plan

N/A — this change involves no data migration. Deployment sequence:

1. Ship `iamPolicy.ts` statement + `CloudHealthService`/`CloudHealthController`
   + web UI in one PR (per `.claude/rules/pr-stacking.md`, this is a single
   cohesive feature, not a stack candidate).
2. `iamPolicy.test.ts`'s existing lock ensures the CloudFormation template
   and `docs/docs/setup.md` stay in sync with the new statement automatically.
3. No rollback concerns beyond a normal revert — the new IAM statement is
   additive (widens what the deploy policy permits, not what it requires),
   and the new UI/service code has no effect on existing flows if reverted.
4. Operators with an out-of-date deploy policy self-discover the need to
   update their CloudFormation stack via the Fix flow's fallback message —
   no forced-migration prompt is needed.

## Open Questions

None outstanding — all forks raised during brainstorming were resolved and
approved before promotion to OpenSpec (see `brainstorm.md`'s decision chain).
