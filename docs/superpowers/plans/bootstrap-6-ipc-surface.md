# Group 6: IPC surface

## Context

Part of OpenSpec change `add-one-click-aws-bootstrap`
(`openspec/changes/add-one-click-aws-bootstrap/design.md`; specs
`guided-iam-provisioning`, `aws-credentials`). Groups 1-5 (merged onto this
branch's base) built `GuidedIamService` (main-process logic) and
`IamCheckService`'s gating extension — both fully unit-tested, neither
wired to anything. This group is the wiring: register `GuidedIamService`
in its NestJS module, add one new small method it's still missing (a
standalone bootstrap-key revoke, for the `delete-failed` manual-retry
path), add five `wizard.guidedIam.*` IPC channels to `WizardController`,
and expose them through the preload bridge. **No wizard UI** — that's the
next group, stacked on this one.

## Global Constraints

**Module registration (prerequisite for everything else):**
`app/packages/desktop-main/src/modules/wizard.module.ts` currently lists
`AwsProfileService, BootstrapService, IamCheckService, FirstRunWizardService`
in both `providers` and `exports` — add `GuidedIamService` to both arrays,
following the exact same pattern (it already imports `ElectronStoreModule`,
which is all `GuidedIamService`'s constructor needs).

**New service method — `revokeBootstrapKey` (not built in Group 2,
needed for `wizard.guidedIam.revokeBootstrapKey`):** per
`design.md`'s rotation risk section, the wizard step needs an explicit
"revoke bootstrap key" action distinct from `rotate()`'s automatic delete
step — used when `rotate()` already returned `delete-failed` (the new key
is already active; only the old bootstrap key still needs revoking) and
the operator retries just that piece, without re-running the whole
mint/verify sequence. Add to `GuidedIamService.ts`:

```typescript
async revokeBootstrapKey(input: { bootstrapAccessKeyId: string; region: string }): Promise<{ revoked: boolean; message?: string }>
```

Unlike every other method on this service, this one legitimately reads the
**already-active** credential source — by the time it's called, rotation
has already succeeded and the rotated key IS the active source; there is
no other key material to pass in (the operator has nothing left to paste).
Resolve it via `resolveAwsCredentialSource(this.store)` (same helper
`IamCheckService` uses) — if it doesn't resolve to a usable pasted/profile
source, return `{ revoked: false, message: '<clear explanation>' }` rather
than throwing (this is a manual-retry UI action; it should never crash the
wizard). Build an IAM client from that active source's credentials
(reusing `createIamClient`'s existing seam) and call `iam:DeleteAccessKey`
on `input.bootstrapAccessKeyId`. Return `{ revoked: true }` on success,
`{ revoked: false, message: <AWS error> }` on failure. Document in TSDoc
*why* this method breaks the "never read the store for credentials"
pattern every other method on this service follows — this is the one
deliberate, justified exception, not an oversight.

**IPC channels — `WizardController`** (`app/packages/desktop-main/src/controllers/wizard.controller.ts`,
read it in full first for the existing `@MessagePattern` conventions —
plain request/response, no streaming, payload types as named interfaces
exported alongside the controller, matching `BootstrapStateBucketInput`
etc.):

| Channel | Calls | Payload | Returns |
|---|---|---|---|
| `wizard.guidedIam.prepareTemplate` | `GuidedIamService.renderTemplate()` | none | `RenderedTemplateResult` |
| `wizard.guidedIam.openConsole` | `GuidedIamService.buildCloudFormationConsoleUrl(region)` then `.openConsole(url)` | `{ region: string }` | `OpenConsoleResult` |
| `wizard.guidedIam.submitBootstrapKey` | `GuidedIamService.intakeBootstrapKey(input)` | `BootstrapKeyIntakeInput` | `BootstrapKeyIntakeResult` |
| `wizard.guidedIam.rotate` | `GuidedIamService.rotate(input)` | `RotationInput` | `RotationResult` |
| `wizard.guidedIam.revokeBootstrapKey` | `GuidedIamService.revokeBootstrapKey(input)` | `{ bootstrapAccessKeyId: string; region: string }` | `{ revoked: boolean; message?: string }` |

`openConsole`'s controller handler is the one channel that orchestrates
two service calls (build the URL, then open it) — this orchestration
belongs in the controller, not a new service method; `GuidedIamService`
already exposes both pieces separately by design (Group 2 kept them
independently testable). Import all payload/result types directly from
`GuidedIamService.ts` (`RenderedTemplateResult`, `OpenConsoleResult`,
`BootstrapKeyIntakeInput`, `BootstrapKeyIntakeResult`, `RotationInput`,
`RotationResult`) rather than re-declaring them — this controller file
already does this for `BootstrapResult`/`IamCheckResult` from their
respective services.

**No secret ever crosses the renderer boundary except as
operator-submitted input.** Audit every one of the five channels: an
access-key-ID is fine to echo back (non-secret), but no channel may EVER
return a `secretAccessKey` value. Read each of `GuidedIamService`'s five
method result types — none of them currently include a `secretAccessKey`
field (confirmed: `RenderedTemplateResult` is a path, `OpenConsoleResult`
is opened/url, `BootstrapKeyIntakeResult` is an account ID,
`RotationResult`'s three variants are `complete`/error-message/console-URL,
your new `revokeBootstrapKey` result is `revoked`/message) — this
constraint is already satisfied by construction; your job is to confirm
it stays that way as you wire the controller, not to change any shape.
`submitBootstrapKey` and `rotate` both accept secrets as INPUT (renderer→main)
— that direction is fine and expected (the operator is pasting/the app is
using them), never the reverse.

**Preload bridge** (`app/packages/desktop-preload/src/hyveon-api.ts` and
`preload.ts` — read both in full for the existing `wizard.*` namespace
pattern, e.g. `simulateIamPermissions`/`bootstrapStateBucket`): add a
`guidedIam` sub-namespace to `HyveonWizardApi` (or five flat methods
matching the controller's channel names — check which convention
`hyveon-api.ts` already uses for grouping vs. flat naming within
`HyveonWizardApi` and follow it) mirroring the five channels exactly,
with the same result/payload types re-declared or imported per this file's
existing convention (check whether `hyveon-api.ts` imports types from
`desktop-main` or hand-mirrors them — Group 5's final review found
hand-mirroring is this file's actual convention, so hand-mirror these too,
keeping the TSDoc note "mirrors X in Y — keep in sync" style Group 5's
fix used). Wire all five into `preload.ts`'s `invoke<T>(...)` pattern.

**Never** build wizard UI, wizard-step wiring, or `RECONFIGURE_PRE_COMPLETED_STEPS`
changes in this group — that's the next group, stacked on this one.

## Task 1: 6.1 Module registration, revokeBootstrapKey, and the five channels

Register `GuidedIamService` in `wizard.module.ts`. Add `revokeBootstrapKey()`
to `GuidedIamService.ts` per Global Constraints. Add all five
`wizard.guidedIam.*` `@MessagePattern` handlers to `WizardController`,
injecting `GuidedIamService` into its constructor alongside the existing
four services. Unit/controller-level tests for the new
`revokeBootstrapKey()` method (aws-sdk-client-mock, mirroring
`GuidedIamService.test.ts`'s existing patterns — active-source-unusable
refusal, success, AWS delete failure) — controller-level `@MessagePattern`
wiring itself is proven by Task 3's tier-2 integration specs, not unit
tests here.

## Task 2: 6.2 Preload bridge

Add the `guidedIam` surface to `hyveon-api.ts`'s `HyveonWizardApi` and wire
it into `preload.ts`, per Global Constraints. No new tests required beyond
a typecheck pass proving the preload types match the controller's actual
channel payloads/returns — this file has no dedicated unit-test suite of
its own for the `wizard.*` namespace today (confirm this is true before
assuming it; if a `preload.test.ts` or similar DOES test the wizard
namespace, add matching cases there instead of skipping tests entirely).

## Task 3: 6.3 + 6.4 Secret audit and integration specs

**6.3:** Confirm in your report (not new code, unless you find a real gap)
that none of the five channels' result types can carry a secret to the
renderer — walk through each one explicitly.

**6.4:** Add tier-2 integration specs (`app/packages/web/e2e/integration-specs/`,
importing `{ test, expect }` from `./index.js` per this repo's convention —
read an existing spec like `stack-outputs.spec.ts` or `start-stop.spec.ts`
first for the exact fixture/dispatch pattern) exercising the five new
channels through the real `AppModule` DI container: prepare-template
succeeds and returns a real path; open-console with browser-launch-failure
returns the URL as text; submit-bootstrap-key with valid/invalid
credentials; rotate reaching `complete`; revoke-bootstrap-key success and
failure. These are dispatched through Nest's real DI, not
`aws-sdk-client-mock` — check how `IamCheckService`/`BootstrapService`'s
existing integration specs (if any) fake AWS at this tier (likely a
DI-substituted stub service, matching this repo's `pulumi-di-seam.spec.ts`
pattern) and follow the same substitution mechanism rather than hitting
real AWS.
