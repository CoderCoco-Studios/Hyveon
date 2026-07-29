## ADDED Requirements

### Requirement: Typed model for top-level Terraform variables

`app/packages/shared/src/tfvars.ts` SHALL define a typed model for the top-level variables the app owns — at minimum `project_name`, `aws_region`, `hosted_zone_name`, and the watchdog tuning variables — alongside the existing `GameServer` types. The existing `game_servers` entry model MUST be left unchanged. Both the wizard step and the Settings page MUST drive off this single model so the two surfaces cannot diverge.

#### Scenario: Top-level variables modelled

- **WHEN** a `terraform.tfvars` containing `project_name`, `aws_region`, `hosted_zone_name`, and the watchdog variables is read
- **THEN** each value is exposed through the typed top-level model

#### Scenario: Game server model untouched

- **WHEN** the top-level model is added
- **THEN** the existing `GameServer` types and the `game_servers` read/write path behave exactly as before

#### Scenario: Both surfaces share the model

- **WHEN** the same variable is edited from the wizard step and from the Settings page
- **THEN** both produce the same resulting file content for the same input

### Requirement: Reading top-level variables

`TfvarsService` SHALL expose a top-level variable read alongside the existing `getGameServers()`, reusing the same source resolution — the S3 `RemoteFileStore` when a tfvars bucket is configured, the local file otherwise — and the same cache invalidation. A missing file MUST yield model defaults so a fresh clone can be configured entirely from the app. A file that fails to parse MUST report a parse error naming the file and MUST NOT be silently replaced by defaults.

#### Scenario: S3 mode

- **WHEN** a tfvars bucket is configured and top-level variables are read
- **THEN** the content is fetched through the remote file store, not the local filesystem

#### Scenario: Local mode

- **WHEN** no tfvars bucket is configured
- **THEN** the content is read from the local `terraform/terraform.tfvars`

#### Scenario: Missing file

- **WHEN** the tfvars file does not exist
- **THEN** the read returns model defaults and the UI presents an empty-but-valid form

#### Scenario: Malformed file

- **WHEN** the file exists but is not valid HCL
- **THEN** the read reports a parse error identifying the file, and no defaults are written over it

### Requirement: Byte-preserving top-level variable writes

Writing a top-level variable SHALL locate that attribute's byte range and splice the replacement in place, in the same manner as the existing `game_servers` entry surgery. The file MUST NOT be regenerated from a parsed model. Content outside the edited attribute — including comments, ordering, blank lines, and the entire `game_servers` map — MUST be preserved byte-for-byte. An attribute that is absent MUST be inserted at a deterministic position rather than an arbitrary one. All writes MUST route through the existing single write path so S3 mode inherits its etag optimistic locking unchanged.

#### Scenario: Surrounding content preserved

- **WHEN** `aws_region` is changed in a file containing comments, blank lines, and a populated `game_servers` map
- **THEN** every byte outside the `aws_region` attribute is identical before and after

#### Scenario: Absent attribute inserted

- **WHEN** a top-level variable the model knows about is not present in the file and is set
- **THEN** it is inserted at a deterministic position, and repeating the same operation produces the same file

#### Scenario: Trailing inline comment survives

- **WHEN** the edited attribute has a comment trailing it on the same line
- **THEN** the comment is still present after the write

#### Scenario: Optimistic locking inherited in S3 mode

- **WHEN** a top-level write is attempted in S3 mode against a stale etag
- **THEN** the existing optimistic-lock error is raised and no write occurs

#### Scenario: Rollback on failed splice

- **WHEN** a splice fails partway
- **THEN** the existing raw-content restore path returns the file to its pre-write state

### Requirement: Local-mode write backup

In local-file mode only, `TfvarsService` SHALL copy the existing file to `terraform.tfvars.bak` immediately before splicing, giving local operators the single-step undo that S3 mode already gets from object versioning. S3 mode MUST NOT gain a `.bak` copy, and its locking semantics MUST be unchanged.

#### Scenario: Backup written in local mode

- **WHEN** a write occurs with no tfvars bucket configured
- **THEN** the prior contents are present at `terraform.tfvars.bak`

#### Scenario: No backup in S3 mode

- **WHEN** a write occurs with a tfvars bucket configured
- **THEN** no `.bak` object is created and the existing etag locking path is used

### Requirement: Validation before write

Top-level values SHALL be validated before any splice. `project_name` MUST be non-empty and conform to the naming constraints the Terraform module relies on, `aws_region` MUST be a syntactically valid region identifier, `hosted_zone_name` MUST be a valid DNS name, and watchdog values MUST be within the ranges the module accepts. Validation failures MUST block the write and identify the offending field. `game_servers` validation continues to be handled by the existing validator and is not duplicated here.

#### Scenario: Invalid region rejected

- **WHEN** the operator enters a region that is not a valid region identifier
- **THEN** the write is blocked and the region field is flagged with the reason

#### Scenario: Out-of-range watchdog value rejected

- **WHEN** a watchdog value falls outside the range the Terraform module accepts
- **THEN** the write is blocked and that field is identified

#### Scenario: Existing game validation not duplicated

- **WHEN** top-level validation runs
- **THEN** it does not re-implement or override the existing game-server validation rules

### Requirement: Settings page ownership of top-level variables

The Settings page SHALL expose the same top-level variable surface as the wizard step, so an operator can change any app-owned top-level variable after first run without editing a file. Changes made there MUST go through the same validation and write path as the wizard.

#### Scenario: Post-setup edit

- **WHEN** an operator changes the watchdog interval from the Settings page
- **THEN** the change is validated and written through the same service path as a wizard-driven change

#### Scenario: Game editing unchanged

- **WHEN** an operator edits a game after this change ships
- **THEN** they use the existing game UI and its behaviour is unaffected
