# Brainstorm: AWS Cloud Health Checks

## Background

Triggering incident: an operator hit `InvalidParameterException: Unable to
assume the service linked role. Please verify that the ECS service linked
role exists.` when starting a game server (ECS `RunTask`). Root cause: the
AWS account is missing the `AWSServiceRoleForECS` service-linked role
(normally auto-created on first ECS use, but absent on fresh accounts or
accounts bootstrapped before this permission existed). The only fix today is
running `aws iam create-service-linked-role --aws-service-name
ecs.amazonaws.com` by hand — there's no way to discover or fix this from
inside the app. This was raised right after fixing a related bug (PR #468:
the Start/Stop buttons were showing a false success toast even when the
backend failed — see that PR for the unrelated but adjacent fix).

Research (dispatched before brainstorming) established:

1. **Bootstrap flow shape**: `GuidedIamService` is a flat IPC-method service;
   actual IAM *creation* happens via a CloudFormation template the operator
   uploads by hand (`app/packages/desktop-main/resources/cloudformation/iam-bootstrap.yaml`).
   `BootstrapService.ts:69-104` has the relevant precedent: idempotent
   `ensureX()` methods returning `{status: 'created'|'exists'|'failed'}`,
   each its own wizard step.
2. **`HyveonDeployAll` policy** (`app/packages/shared/src/iamPolicy.ts:74-145`,
   mirrored in `docs/docs/setup.md`, test-locked by `iamPolicy.test.ts`) does
   **not** permit `iam:CreateServiceLinkedRole` for the ECS service-linked
   role's ARN path — the deploy user can't create it even implicitly today.
3. **Only one service-linked role is needed** by this app: `AWSServiceRoleForECS`
   (`ecs.amazonaws.com`). Confirmed no other in-use AWS service (Application
   Auto Scaling, ECS Exec, Spot, Global Accelerator) requires one.
4. **`IamCheckService.ts:95-156`** already does a `iam:SimulatePrincipalPolicy`
   preflight, wizard-only, rendering a copyable policy-JSON block when a
   permission is `missing` (`bootstrap-step.component.tsx` ~120-190) — this
   is the reusable pattern for a "here's the policy update you need" fallback.
5. **`PulumiService`** has no IAM/hosted-zone preflight at all — no existing
   deploy-path guard to hook into.
6. **`iam:CreateServiceLinkedRole` is safely scopable**: by resource ARN path
   and by the `iam:AWSServiceName` condition key. AWS fixes the created
   role's trust policy — no privilege-escalation surface. Narrower than the
   `iam:*` (on `hyveon-*` resources) already granted in `HyveonDeployAll`.
7. **UI precedent survey**: Settings page (`settings.page.tsx:96-119`) has a
   thin "Cloud Setup" row (Pulumi engine version + Reconfigure button) but no
   account-health surface. `IamCheckService` results are wizard-only —
   nothing renders them elsewhere. `DriftController`/`DriftService` exist but
   have no dedicated page — only a banner (`pending-changes-banner.component.tsx`)
   and per-game badges, no per-item fix action. The closest precedent for
   "list of checks, each with a status badge and a fix action" is the wizard's
   `bootstrap-step.component.tsx` (resource rows + one "Bootstrap AWS
   resources" button that fires per-resource IPC calls and updates each row).

## Decision chain

**Q1 — Where should the role-creation logic live?**
Options offered: (a) wizard step only, (b) wizard step + self-heal on
`EcsService.start()`.
**Answer**: user redirected the framing entirely — rather than silently
auto-fixing on start, they want visibility: "direct someone to the settings
page when we detect bad health... a quick overall health dashboard of the
cloud and action steps needed to fix things." This ruled out silent
self-healing in favor of a visible, operator-driven health surface.

**Q2 — Scope: extensible framework vs. one-off ECS check?**
User's answer folded into the above: they specifically want it **visible on
the Settings page** (having noticed Settings already has a way to reopen the
wizard) — "a quick overall health dashboard... perhaps mock that up?" This
implied wanting to *see* the layout before deciding further, so the
conversation moved to a visual mockup rather than resolving extensibility in
text first.

**Visual mockup (superpowers brainstorming visual companion)**
Two layout options were mocked up and shown in the browser companion:
- **Option A** — collapsed summary card ("Cloud health: 1 issue found",
  expands on click), quiet when healthy, matching the low-noise style of the
  existing Cloud Setup row.
- **Option B** — always-visible checklist, one row per prerequisite check
  (✓/⚠ + status), each broken row showing a "Fix in wizard →" action.

**User's choice**: **Option B, always-visible checklist.**

This resolved the extensibility question implicitly: a checklist UI only
makes sense backed by a list of typed checks, so the architecture became "an
extensible `CloudHealthCheck[]` list, seeded with exactly one real check
(ECS service-linked role) for now" — extensible shape, YAGNI content.

**Q3 — Fix button mechanics**
A wrinkle surfaced during research: `HyveonDeployAll` is a CloudFormation-
managed resource created once at bootstrap. Adding the new permission to
`iamPolicy.ts` doesn't retroactively grant it to an operator's
already-deployed policy — so a "Fix" click could itself fail with
AccessDenied on existing installs (including the one that hit the original
bug).
Options offered: (a) try the fix inline with stored credentials, fall back to
showing the updated policy JSON on AccessDenied (reusing the existing
copyable-JSON pattern from the wizard's IAM check); (b) never call AWS
directly from Settings, always show instructions.
**Answer**: **(a) — try inline, fall back to instructions.**

## Approved design (full text — see design.md for the reorganized version)

A "Cloud Health" checklist section, always visible on the Settings page, one
row per account-level prerequisite:

- Ships with exactly one real check: does `AWSServiceRoleForECS` exist.
- Each row: label + status badge (ok/missing/error) + a Fix action when
  broken.
- Fix tries `iam.createServiceLinkedRole` directly with stored credentials.
  Success → row goes green. Already-exists → treated as success
  (idempotent). AccessDenied (old policy) → row expands to show the updated
  `HyveonDeployAll` policy JSON (same copyable-block pattern as the wizard's
  `IamCheckService` "missing" state) so the operator can apply it via their
  CloudFormation stack, then retry.
- Checks run on Settings mount + manual Refresh — no polling (SLR existence
  essentially never changes on its own).
- Architecture: `CloudHealthCheck[]` array (id, label, `check()`, `fix()`) —
  new checks are future entries, not new UI. Backend follows
  `BootstrapService`'s `ensureX()`/result-union shape. UI follows
  `bootstrap-step.component.tsx`'s row styling.
- `iamPolicy.ts` gains one new statement (`HyveonServiceLinkedRoles`):
  `iam:CreateServiceLinkedRole`, scoped to the ECS SLR ARN path with an
  `iam:AWSServiceName` condition — confirmed safe/narrow, no
  privilege-escalation surface.
- Non-goals: no polling, no folding `IamCheckService`'s full permission
  simulator into this list, no auto-editing the operator's CloudFormation
  stack, no change to `EcsService.start`/`stop` beyond what PR #468 already
  shipped (this is a separate proactive surface, not wired into the RunTask
  failure path).
- Single-PR scope (not a stack) — one cohesive feature across `iamPolicy.ts`,
  one new service, one new controller, preload/api plumbing, one new web
  component, and two docs pages.

User approved this design as presented ("looks right to me") before
promotion to OpenSpec.
