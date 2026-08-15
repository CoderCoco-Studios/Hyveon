## Why

Operators currently have no way to hand support (project maintainers) enough
information to diagnose a problem beyond copy-pasting whatever they can see
in the Settings → Diagnostics panel's live tail. There is no crash reporter
or telemetry integration in this app (by design — it is a self-hosted,
bring-your-own-AWS app with no Hyveon-owned backend), so the only viable path
is a locally generated bundle the operator can attach to a GitHub issue,
email, or Discord message themselves.

## What Changes

- Add an "Export diagnostics bundle" action to the existing Settings →
  Diagnostics panel (`DiagnosticsPanel.tsx`) that produces a single `.zip`
  file on disk, saved via a native save dialog the operator controls.
- The bundle contains four independently-gathered sections: recent app
  winston logs, a deployment-config summary built from an explicit
  safe-field allowlist, app/system metadata (app version, Electron/Node
  version, OS platform+version, current auto-update setting), and a
  best-effort AWS resource snapshot reused from the existing Cloud Health
  service calls.
- Gathering is best-effort per section: a failure in any one section (e.g.
  an AWS call) is caught, recorded (message only) in an `errors.json`
  manifest inside the bundle, and does not prevent the other sections from
  being included or the export from completing.
- Log content passes through a regex-based secret scrubber as a
  defense-in-depth layer on top of the existing "never log secrets"
  discipline (`.claude/rules/logging.md`).
- New IPC channel `diagnostics.exportBundle`, backed by a new
  `DiagnosticsBundleService` in `desktop-main`.
- This is a purely local export. No new outbound network calls, no upload,
  no new backend — the app has no Hyveon-owned server to upload to, and
  building one is explicitly out of scope for this change.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `app-diagnostics-logging`: adds a new requirement for a bundled,
  redacted, best-effort diagnostic export triggered from the existing
  Settings → Diagnostics panel, alongside the panel's existing live-tail
  requirements.

## Impact

- **Affected code**: `app/packages/desktop-main/src/controllers/diagnostics.controller.ts`
  (new IPC channel), a new `DiagnosticsBundleService` (new file, desktop-main),
  `app/packages/web/.../DiagnosticsPanel.tsx` (new button + states), preload
  bridge (`desktop-preload`) to expose `diagnostics.exportBundle`.
- **Reused, not duplicated**: `DiagnosticsService` (log file access),
  `DeploymentConfigService` (config summary source), existing Cloud Health
  AWS SDK calls (resource snapshot source).
- **New dependency**: a zip-creation library for `desktop-main` (exact
  package/version to be confirmed against the npm registry at
  implementation time, per `.claude/rules/dependencies.md`).
- **Docs**: `docs/docs/components/management-app.md` (new IPC channel),
  the Settings/Diagnostics page under `docs/docs/app/`.
- **No changes** to AWS infra, IAM policy, or any outbound network surface.
