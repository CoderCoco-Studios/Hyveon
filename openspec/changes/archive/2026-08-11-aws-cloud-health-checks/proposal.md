## Why

Starting a game server can fail with `InvalidParameterException: Unable to
assume the service linked role` when the AWS account is missing
`AWSServiceRoleForECS`. Today the operator has no way to discover this from
inside the app (only the desktop log file shows it) and no way to fix it
without running an AWS CLI command by hand. The app has no surface at all
that answers "is my AWS account healthy enough to run Hyveon?" outside the
one-time first-run wizard.

## What Changes

**Settings page**
- From: no account-level health surface outside the first-run wizard.
- To: an always-visible "Cloud Health" checklist section, one row per
  prerequisite check, each showing a status badge and a Fix action when
  broken.
- Reason: operators need to discover and self-remediate AWS-account gaps
  without reading log files or running AWS CLI commands from memory.
- Impact: non-breaking, additive UI on `settings.page.tsx`.

**`HyveonDeployAll` IAM policy**
- From: no permission to create the `AWSServiceRoleForECS` service-linked
  role — the deploy user cannot create it even implicitly.
- To: a new statement (`HyveonServiceLinkedRoles`) granting
  `iam:CreateServiceLinkedRole`, scoped to the ECS service-linked-role ARN
  path with an `iam:AWSServiceName` condition.
- Reason: lets the app's Fix action create the missing role directly using
  the operator's existing stored credentials, without a broader IAM grant.
- Impact: non-breaking addition to the policy generator
  (`app/packages/shared/src/iamPolicy.ts`); existing (already-bootstrapped)
  operators need to update their CloudFormation stack to pick up the new
  permission before the in-app Fix action can succeed for them — the Fix
  flow degrades gracefully to showing the updated policy JSON in that case.

**Scope for this change**: exactly one real check (ECS service-linked role
existence). The checklist is built as a small typed list so future checks
can be added later, but no additional checks are implemented now.

## Capabilities

### New Capabilities
- `aws-cloud-health`: an extensible AWS account-prerequisite checklist
  surfaced on the Settings page, with a check/fix cycle per prerequisite.
  Ships with the ECS service-linked-role check as its only concrete check.

### Modified Capabilities
- `cloud-bootstrap`: the `HyveonDeployAll` policy JSON gains a new
  `HyveonServiceLinkedRoles` statement so deploy credentials can create the
  ECS service-linked role.

## Impact

- `app/packages/shared/src/iamPolicy.ts` — new IAM statement (also flows
  into the CloudFormation template and `docs/docs/setup.md`, which are
  generated/test-locked from this source).
- `app/packages/desktop-main/src/services/CloudHealthService.ts` (new).
- `app/packages/desktop-main/src/controllers/cloud-health.controller.ts` (new).
- `app/packages/desktop-preload/src/preload.ts`, `hyveon-api.ts` — new
  `cloudHealth` IPC surface.
- `app/packages/web/src/api.service.ts` — new `cloudHealth` passthrough.
- `app/packages/web/src/components/cloud-health-section.component.tsx` (new),
  wired into `app/packages/web/src/pages/settings.page.tsx`.
- `docs/docs/app/settings.md`, `docs/docs/setup.md` — documentation updates.
- No changes to `EcsService.start`/`stop`, the Pulumi orchestration, or any
  existing wizard step.
