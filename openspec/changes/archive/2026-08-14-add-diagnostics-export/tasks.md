## 1. Dependency

- [x] 1.1 Add `archiver@8.0.0` (verify current version on the npm registry
      before installing, per `.claude/rules/dependencies.md`) to
      `desktop-main`'s `package.json`; add `@types/archiver` if not bundled.

## 2. Config allowlist and log scrubber

- [x] 2.1 Add an explicit safe-field allowlist mapping function for
      `DeploymentConfig`/`GameServerConfig` → diagnostic summary shape
      (booleans/enums/non-secret fields only), beside the existing
      redacted-shape helpers.
- [x] 2.2 Add a regex-based secret scrubber utility for log text (AWS
      access-key-id shape, generic long hex/base64 following a
      token/key/secret-ish label).
- [x] 2.3 Unit tests: allowlist excludes non-listed fields (including a
      hypothetical new field not on the allowlist); scrubber redacts known
      secret shapes and leaves normal log lines untouched.

## 3. DiagnosticsBundleService

- [x] 3.1 Create `DiagnosticsBundleService` in `desktop-main`: gathers the
      four sections (logs via `DiagnosticsService`, config summary via the
      2.1 allowlist, app/system metadata, AWS snapshot via existing Cloud
      Health calls) using `Promise.allSettled` for per-section isolation.
- [x] 3.2 Map settled results to bundle content; failures become
      `errors.json` entries with `{ section, message }` only (no raw error
      objects), per `.claude/rules/logging.md`.
- [x] 3.3 Stream the four sections plus `errors.json` into a `.zip` via
      `archiver`, written to a caller-supplied destination path.
- [x] 3.4 Log entry/failure per `.claude/rules/logging.md` conventions
      (method name only on entry, warn/error on failure, no raw SDK errors
      escaping).
- [x] 3.5 Unit tests: full success (all four sections present, empty
      `errors.json`), one-section failure (bundle still written, correct
      `errors.json` entry), all-sections-fail (bundle still written,
      contains only `errors.json`). Mock AWS SDK via `aws-sdk-client-mock`.

## 4. IPC channel

- [x] 4.1 Add `diagnostics.exportBundle` `@MessagePattern` handler to
      `DiagnosticsController`: logs invocation per `.claude/rules/logging.md`,
      opens `dialog.showSaveDialog`, on a chosen path calls
      `DiagnosticsBundleService`, returns success/path or a cancelled
      result.
- [x] 4.2 Expose `diagnostics.exportBundle` on the `desktop-preload` bridge
      (`window.hyveon.diagnostics.exportBundle`), following the naming
      convention in `openspec/specs/preload-bridge-naming/spec.md`.
- [x] 4.3 Integration test: IPC round-trip through the real DI container
      (dialog mocked to return a temp path), asserting a real `.zip` lands
      on disk with expected entries.

## 5. Settings UI

- [x] 5.1 Add an "Export diagnostics bundle" button to
      `DiagnosticsPanel.tsx` with loading/success/error states, calling
      `window.hyveon.diagnostics.exportBundle`.
- [x] 5.2 On success, show a toast (matching the existing `ActionResult`
      pattern) with a "Show in folder" action wired to
      `shell.showItemInFolder` via a small IPC round-trip or a path
      returned from 4.1.
- [x] 5.3 On dialog-cancel, no toast (silent no-op per spec). On write
      failure, show an error toast.
- [x] 5.4 Component test: button states (idle/loading/success/error),
      cancel is a no-op, "Show in folder" action present on success.

## 6. E2E coverage

- [x] 6.1 Stub `diagnostics.exportBundle` in the Playwright chromium
      bridge, matching the pattern used for the recently-shipped
      auto-update toggle (`iac.settings.autoUpdateGet`/`.autoUpdateUpdate`
      stubs).

## 7. Docs

- [x] 7.1 Update `docs/docs/components/management-app.md` with the new
      `diagnostics.exportBundle` IPC channel.
- [x] 7.2 Update the relevant `docs/docs/app/` page (Settings/Diagnostics)
      describing the export button, bundle contents, and the
      local-only/no-upload behavior.

## 8. Verification

- [x] 8.1 `npm run app:lint` clean.
- [x] 8.2 `npm run app:typecheck` clean.
- [x] 8.3 `npm run app:test` full unit suite green.
- [x] 8.4 `npm run app:test:integration` green (IPC/controller changes).
- [x] 8.5 `npm run app:test:e2e` green (renderer/preload/IPC surface
      changed).
