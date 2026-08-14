## Context

`enableAutoUpdate` is an `ElectronStoreService`-backed local flag (electron-store), distinct from `DeploymentConfigService`'s S3-backed `DeploymentConfig` that `IacSettingsController.get`/`update` already expose. `IacSettingsController` is nonetheless documented as the general home for Settings-page IPC handlers regardless of backing store — its `engineVersion` handler already lives there for the same reason ("Settings-page-flavored... exactly like every other handler on this controller"), reading from `PulumiEngineService` rather than `DeploymentConfigService`. See proposal.md - Why.

## Goals / Non-Goals

**Goals:**
- Let the Settings page read and write `enableAutoUpdate` without touching electron-store directly.
- Keep the new channels consistent with existing `IacSettingsController` handler conventions (logging, error shape, IPC-only).

**Non-Goals:**
- Triggering a live update check when the flag flips mid-session (see spec's "Toggling the flag does not affect the running session" scenario).
- Any change to `updater.ts`'s own logic, the release/blockmap pipeline, or non-Windows platforms.
- A generic "app settings" controller/namespace — scope is exactly this one flag.

## Decisions

**New handlers on `IacSettingsController`, not a new controller.** `IacSettingsController` already documents itself as the Settings-page IPC home independent of backing store (see Context). A new controller for a single boolean would be pure ceremony, and `app.module.ts` already wires this controller into the DI graph.

**Constructor takes `ElectronStoreService` as a new dependency.** Mirrors the existing `engine?: PulumiEngineService` pattern: typed optional (`?`) so existing direct-construction test call sites (`new IacSettingsController(deploymentConfig)`) keep compiling. A missing store at runtime never happens through real `AppModule` bootstrap — only in tests that don't need it.

**Two channels, not folded into the existing `get`/`update` pair.** `iac.settings.get`/`update` operate on `DeploymentSettingsGetResult`/`UpdateDeploymentSettingsPayload` — types owned by `@hyveon/shared` and shaped around `DeploymentConfig`'s optimistic-locking (etag) flow. `enableAutoUpdate` has no etag, no S3 round trip, and no validation beyond "is it a boolean" — folding it in would force every `DeploymentConfig` consumer to reason about an unrelated field. New result/payload types (`AutoUpdateSettingGetResult`, `AutoUpdateSettingUpdatePayload`) go in `@hyveon/shared` alongside the existing settings types.

**Channel names:** `iac.settings.autoUpdate.get` / `iac.settings.autoUpdate.update`, dot-namespaced under the existing `iac.settings.*` prefix per the repo's existing channel-naming convention.

**UI placement:** a new "Updates" row in the Settings page, styled like the existing Cloud Setup / Pulumi Engine row (label + description + control), rather than folding into `DeploymentSettingsForm` (that form round-trips the whole `DeploymentConfig` patch and doesn't fit a single independent local flag well).

## Risks / Trade-offs

- **[Risk]** Toggling the flag has no visible effect until restart, which may read as broken to an operator. → **Mitigation:** the toggle's description text states this explicitly (e.g. "Applies on next app start"), per the new spec scenario.
- **[Risk]** A missing `ElectronStoreService` at runtime (shouldn't happen via `AppModule`, but the constructor param is optional for test-compat) would make the new handlers no-op/error. → **Mitigation:** same defensive pattern as `engine?.getResolvedVersion() ?? null` — treat an absent store as `enableAutoUpdate: false` on read, and return a `{ ok: false, code: 'error' }` on write, never throw uncaught.
