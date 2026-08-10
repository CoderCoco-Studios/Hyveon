## 1. IAM policy

- [ ] 1.1 Add the `HyveonServiceLinkedRoles` statement to `HYVEON_DEPLOY_ALL_STATEMENTS` in `app/packages/shared/src/iamPolicy.ts` (`iam:CreateServiceLinkedRole`, scoped to the ECS service-linked-role ARN path, conditioned on `iam:AWSServiceName: ecs.amazonaws.com`).
- [ ] 1.2 Update `iamPolicy.test.ts` expectations and run it to confirm the CloudFormation template render and `docs/docs/setup.md` policy JSON block stay in sync with the generator.

## 2. Backend: CloudHealthService

- [ ] 2.1 Define `CloudHealthCheck`, `CloudHealthCheckResult`, and `CloudHealthFixResult` types in `app/packages/desktop-main/src/services/CloudHealthService.ts`.
- [ ] 2.2 Implement `checkEcsServiceLinkedRole()`: `iam.getRole({RoleName: 'AWSServiceRoleForECS'})`, mapping `NoSuchEntityException` to `missing`, success to `ok`, anything else to `error` (logged via `logger.warn`, no raw SDK exception escapes).
- [ ] 2.3 Implement `fixEcsServiceLinkedRole()`: `iam.createServiceLinkedRole({AWSServiceName: 'ecs.amazonaws.com'})`, mapping already-exists `InvalidInputException` to `fixed`, `AccessDeniedException` to `needsPolicyUpdate` (with `iamPolicy.ts`-generated JSON), and any other error to `failed` (logged via `logger.error`).
- [ ] 2.4 Export `CLOUD_HEALTH_CHECKS: CloudHealthCheck[]` containing the one ECS service-linked-role entry, reusing the existing `resolveAwsCredentialSource` credential path (same as `EcsService`).
- [ ] 2.5 Unit tests (Vitest + `aws-sdk-client-mock`): role exists, role missing, fix succeeds, fix finds already-exists, fix denied (asserts `needsPolicyUpdate` JSON content), fix fails unexpectedly.

## 3. Backend: IPC surface

- [ ] 3.1 Add `CloudHealthController` (`app/packages/desktop-main/src/controllers/cloud-health.controller.ts`) with `@MessagePattern('cloudHealth.list')` and `@MessagePattern('cloudHealth.fix')`, each starting with the mandated `logger.debug` entry line per `.claude/rules/logging.md`.
- [ ] 3.2 Register the controller/service in the relevant Nest module.
- [ ] 3.3 Add `cloudHealth.list()` / `cloudHealth.fix(id)` to the preload bridge (`app/packages/desktop-preload/src/preload.ts`, `hyveon-api.ts`), matching the existing `games`/`drift` IPC shape.

## 4. Frontend

- [ ] 4.1 Add `cloudHealth: { list, fix }` passthrough to `app/packages/web/src/api.service.ts`.
- [ ] 4.2 Build `CloudHealthSection` (`app/packages/web/src/components/cloud-health-section.component.tsx`): one row per check, status badge styling reused from `bootstrap-step.component.tsx`, Fix button on `missing`/`error` rows, copyable policy-JSON block on `needsPolicyUpdate` (reusing the wizard's existing block/markup).
- [ ] 4.3 Wire `cloudHealth.list()` on mount and a manual Refresh control into `CloudHealthSection` — no polling.
- [ ] 4.4 Mount `CloudHealthSection` on `app/packages/web/src/pages/settings.page.tsx`, in its own "Cloud Health" section.
- [ ] 4.5 Component tests: `ok` row (no Fix button), `missing` row with Fix button, Fix success re-renders green, Fix `needsPolicyUpdate` renders the policy block, Fix `failed` shows inline error and keeps Fix available.

## 5. Docs

- [ ] 5.1 Update `docs/docs/app/settings.md` with a "Cloud Health" section describing the checklist and fix flow.
- [ ] 5.2 Confirm `docs/docs/setup.md`'s `HyveonDeployAll` JSON block reflects the new statement (should be automatic via the `iamPolicy.ts` single source, verify via `iamPolicy.test.ts`).

## 6. Verification

- [ ] 6.1 `npm run app:lint`
- [ ] 6.2 `npm run app:typecheck`
- [ ] 6.3 `npm run app:test`
