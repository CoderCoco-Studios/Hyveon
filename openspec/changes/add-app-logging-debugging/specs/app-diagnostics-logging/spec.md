## ADDED Requirements

### Requirement: Renderer console forwarding to the main-process log

The renderer SHALL forward `console.log`, `console.info`, `console.warn`,
and `console.error` calls to the main-process winston log file, in addition
to the existing uncaught-error/unhandled-rejection/error-boundary reporting.
Forwarding MUST NOT replace or suppress the original `console.*` output in
DevTools. Forwarded entries MUST be batched and rate-limited so that console
call volume cannot flood the winston log file or the IPC channel; when the
batch cap is exceeded, the app MUST emit an explicit "N entries dropped"
marker rather than silently discarding entries. This mechanism MUST NOT
apply special handling to log secret values differently from what
`.claude/rules/logging.md` already requires of any other logged content —
callers remain responsible for not logging secrets.

#### Scenario: A console.log call reaches the app log

- **WHEN** app code calls `console.log('some diagnostic message')` in the
  renderer
- **THEN** the message appears in `main-*.log`, tagged with its originating
  level and a renderer source, within the batching window

#### Scenario: DevTools output is unaffected

- **WHEN** console forwarding is active
- **THEN** the same message still appears in the browser/Electron DevTools
  console exactly as it would without forwarding installed

#### Scenario: High-volume console output is capped, not unbounded

- **WHEN** app code logs far more entries within one batching window than
  the configured per-flush cap
- **THEN** only up to the cap is forwarded, and the log file shows an
  explicit marker indicating how many entries were dropped from that flush

#### Scenario: No bridge available

- **WHEN** the renderer runs outside Electron (no `window.hyveon` bridge,
  e.g. the Playwright `chromium` E2E project)
- **THEN** console forwarding is a silent no-op and does not throw or break
  the surrounding code

### Requirement: Service-layer diagnostic logging coverage

Every method in `app/packages/desktop-main/src/services/*.ts` that invokes
an AWS SDK operation or the Pulumi engine SHALL log entry via
`logger.debug` (method name only, never payload contents) and SHALL log any
failure via `logger.warn` or `logger.error` before returning a modeled
result or rethrowing a plain `Error`, matching the pattern already
established by `GuidedIamService`/`AwsProfileService`/`IamCheckService` and
required of IPC handlers by `.claude/rules/logging.md`. No raw AWS SDK or
Node error object may propagate out of a service method uncaught. Pure
helper functions with no external call and no possible failure mode (e.g.
`sleep.ts`, `mergeGameLists.ts`) are exempt.

#### Scenario: A service method's external call fails

- **WHEN** a service method's AWS SDK or Pulumi call throws
- **THEN** the failure is logged via `logger.warn` or `logger.error` with
  the underlying error message before the method returns a modeled failure
  result or rethrows a plain `Error`

#### Scenario: A service method's external call succeeds

- **WHEN** a service method that calls an AWS SDK operation or the Pulumi
  engine is invoked
- **THEN** a `logger.debug` entry line is written identifying the method,
  without logging its payload or arguments

### Requirement: Diagnostics panel pause, level filter, and search

The Settings → Diagnostics panel (`DiagnosticsPanel.tsx`) SHALL support
pausing the displayed log view while polling continues in the background,
filtering displayed lines by level (INFO/WARN/ERROR/DEBUG), and searching
displayed lines by substring with match highlighting — matching the
interaction patterns already available on the `/logs` page's
`ansi-log-viewer.component.tsx`. Pausing MUST NOT stop the underlying poll;
new lines fetched while paused MUST be buffered and applied on resume
rather than discarded.

#### Scenario: Pausing freezes the view

- **WHEN** the operator pauses the Diagnostics panel while new log lines
  are being written
- **THEN** the displayed lines do not change until the operator resumes,
  even though polling continues in the background

#### Scenario: Resuming applies buffered lines

- **WHEN** the operator resumes after pausing
- **THEN** all lines received while paused are appended to the view in
  order

#### Scenario: Filtering by level

- **WHEN** the operator enables the ERROR-only filter
- **THEN** only lines classified as ERROR are shown, using the same
  classification logic `/logs` already applies

#### Scenario: Searching highlights matches

- **WHEN** the operator types a search term
- **THEN** matching substrings are highlighted in the visible lines,
  without removing non-matching lines from view
