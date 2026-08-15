## Context

`DiagnosticsService`/`DiagnosticsController` already expose the app's local
winston log to the renderer via `diagnostics.tail`/`diagnostics.path`
(read-tail only, no export). `DeploymentConfigService` already produces a
redacted view of `DeploymentConfig` in places like `botTokenSet` — this
change follows that established allowlist pattern rather than inventing a
new redaction style. Cloud Health already makes AWS SDK calls (ECS task
status, stack outputs) from `desktop-main` on the operator's own resolved
AWS credentials; this change reuses those calls rather than adding new ones.
See proposal.md - Why for why this is a local-only export with no upload
path.

## Goals / Non-Goals

**Goals:**
- One-click, best-effort diagnostic bundle the operator can hand to support
  themselves.
- No new secret-leak surface: allowlist-based config redaction, regex
  scrubbing on log text, no raw error objects in `errors.json`.
- No new outbound network dependency.

**Non-Goals:**
- Uploading anywhere. No new backend, no new AWS bucket, no new credential
  or auth story.
- Historical/rotated-log retrieval beyond what's already reachable via the
  existing `DiagnosticsService` log-file access.
- A generic "attach files to bundle" mechanism — the four sections are
  fixed and hardcoded for this change.

## Decisions

**Zip library: `archiver@8.0.0`.** Checked against the npm registry at
implementation time per `.claude/rules/dependencies.md`. Streams to a file
directly (no full-bundle memory buffer), which matters because log content
can be multiple MB. Alternative considered: `adm-zip` (0.6.0) — simpler
synchronous API but builds the whole archive in memory before writing,
which is unnecessary overhead for a feature that already tolerates
partial/best-effort content.

**New service, not extending `DiagnosticsService`.** `DiagnosticsBundleService`
is a new file that *calls into* `DiagnosticsService` (log access) and
`DeploymentConfigService` (config access) rather than growing
`DiagnosticsService` itself. `DiagnosticsService` today is a narrow
tail-reader; bundling, zipping, and cross-service orchestration is a
distinct responsibility with its own test surface.

**Per-section isolation via `Promise.allSettled`.** The four gatherers run
independently (`Promise.allSettled`, not sequential try/catch chaining) so
one slow/failing AWS call doesn't serialize behind or block the cheap
sections (logs, metadata). Each settled result is mapped to either bundle
content or an `errors.json` entry.

**Save-dialog-first, not silent default path.** `dialog.showSaveDialog` is
invoked before writing, rather than writing to a fixed default location
(e.g. `app.getPath('downloads')`) and revealing it after. This gives the
operator explicit control over where a file containing config/log data
lands, consistent with not assuming where it's safe to write on their
machine.

**Config allowlist lives beside the existing redacted-shape helpers.** The
new allowlist (fields like game names, resource sizing, feature-flag
booleans — never `botToken`, `publicKey`, or other credential-shaped
fields) is implemented as an explicit field-by-field mapping function,
matching the existing pattern rather than a generic deep-redact-by-key-name
scrubber. New `DeploymentConfig` fields are excluded by default until
someone deliberately adds them to the allowlist — see the "field not yet
allowlisted" risk below.

**Log scrubbing is regex-based, applied to already-collected log text.**
A small set of patterns (AWS access-key-id shape `AKIA[A-Z0-9]{16}`,
generic long hex/base64 runs following a `token`/`key`/`secret`-ish label)
runs over the log content before it's added to the bundle. This is
explicitly a second layer, not the primary safeguard — the primary
safeguard remains "never log secrets" per `.claude/rules/logging.md`.

## Risks / Trade-offs

- **[Risk] A new `DeploymentConfig` field is added later and forgotten from
  the export allowlist.** → Mitigation: this is the *safe* failure
  direction (the field is silently excluded from the bundle, not leaked).
  No action needed beyond noting it as intentional in the allowlist
  function's inline comment.
- **[Risk] Regex scrubber has false negatives on secret shapes it wasn't
  written for.** → Mitigation: documented as defense-in-depth only, not a
  substitute for not logging secrets in the first place; not a blocking
  risk for this change.
- **[Risk] AWS resource snapshot reuses Cloud Health calls, but those calls
  were written for a UI that renders errors inline, not a batch context.**
  → Mitigation: wrap each reused call in the same `Promise.allSettled`
  isolation as the other sections; no change needed to Cloud Health itself.
- **[Trade-off] `archiver` adds a new runtime dependency to `desktop-main`.**
  Accepted — no existing dependency in the tree provides zip creation, and
  streaming matters for log-size bundles.

## Migration Plan

Additive only — new IPC channel, new service, new UI button. No existing
behavior changes, no data migration, no feature flag needed (the button is
simply absent until this ships, then present).
