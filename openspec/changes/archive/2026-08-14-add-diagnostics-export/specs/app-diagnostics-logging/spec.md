## ADDED Requirements

### Requirement: Diagnostics bundle export

The Settings → Diagnostics panel SHALL provide an "Export diagnostics
bundle" action that produces a single `.zip` archive on the operator's own
disk, at a location the operator chooses via a native save dialog. No
network upload occurs as part of this action.

The bundle SHALL contain four independently-gathered sections:

1. Recent app log content (the same source the panel's live tail reads),
   passed through a secret-scrubbing pass before inclusion.
2. A deployment-config summary limited to an explicit allowlist of
   non-secret fields — the same redacted-shape discipline already used for
   values like `botTokenSet` elsewhere in the app. Fields not on the
   allowlist MUST NOT appear in the bundle, including any field added to
   `DeploymentConfig`/`GameServerConfig` after this requirement is
   implemented.
3. App/system metadata: app version, Electron and Node runtime versions,
   OS platform and version, and the current auto-update setting.
4. A best-effort AWS resource snapshot, reusing whatever resource-status
   information is already surfaced to the operator elsewhere in the app
   (e.g. Cloud Health). This section MAY be incomplete or absent if AWS
   calls fail or credentials are unavailable.

Each of the four sections SHALL be gathered independently. A failure
gathering any one section MUST NOT prevent the other sections from being
included, and MUST NOT prevent the export from completing. Every failure
SHALL be recorded, by section name and a human-readable message only (never
a raw error object, stack trace, or credential-shaped string), in an
`errors.json` file included in the bundle. A bundle with every section
failing is still a valid export: it contains `errors.json` describing all
four failures and no data.

If the operator cancels the save dialog, no file is written and no error is
surfaced. If writing the completed bundle to disk fails (e.g. disk full,
permission denied), the operator SHALL see an error indication in the
Settings UI.

#### Scenario: Full bundle export succeeds

- **WHEN** the operator clicks "Export diagnostics bundle" and all four
  sections gather successfully, then chooses a save location
- **THEN** a `.zip` file is written to that location containing the log
  content, the config summary, the metadata, and the AWS snapshot, with no
  `errors.json` entries

#### Scenario: One section fails, export still completes

- **WHEN** the operator exports a bundle and the AWS resource snapshot
  section fails (e.g. no AWS credentials configured)
- **THEN** the bundle is still written, containing the other three
  sections plus an `errors.json` entry naming the AWS snapshot section and
  a human-readable failure message

#### Scenario: Config summary excludes non-allowlisted fields

- **WHEN** the bundle's deployment-config summary section is generated
- **THEN** it contains only fields on the explicit safe-field allowlist,
  regardless of what other fields exist on the live `DeploymentConfig`

#### Scenario: Log content is scrubbed before inclusion

- **WHEN** the bundle's log section is generated from log content
  containing a recognizable secret-shaped token
- **THEN** the token does not appear in plain form in the bundled log
  content

#### Scenario: Operator cancels the save dialog

- **WHEN** the operator clicks "Export diagnostics bundle" but cancels the
  native save dialog before choosing a location
- **THEN** no file is written to disk and no error is shown

#### Scenario: Disk write fails

- **WHEN** the operator chooses a save location but the bundle cannot be
  written there (e.g. permission denied)
- **THEN** the Settings UI shows an error indication and no partial file is
  left in a way that could be mistaken for a complete bundle
