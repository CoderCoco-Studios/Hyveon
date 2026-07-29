## MODIFIED Requirements

### Requirement: Documented counts and paths match the codebase

Documentation SHALL NOT state counts, file lists, or repository paths that contradict the
codebase. This covers the Lambda count, the `module "cloud"` input count, the CI workflow list,
the minimum Node version, the npm workspaces root, the `app/packages/infra` Pulumi program's file
table, the repository maps, and the root npm script table.

#### Scenario: Lambda count is correct

- **WHEN** `docs/docs/intro.md`, `architecture.md`, `components/index.md`, `components/lambdas.md`,
  `components/terraform.md`, and `guides/maintainer.md` describe the Lambda packages
- **THEN** they state five packages — four always-on Lambdas plus an optional, per-game
  `@hyveon/lambda-efs-seeder` — rather than implying five functions are always deployed, and
  `components/lambdas.md` documents `@hyveon/lambda-efs-seeder` alongside the other four

#### Scenario: Repo maps are complete

- **WHEN** the repository maps in `docs/docs/intro.md` and `docs/docs/guides/maintainer.md` are
  compared with the workspace list in the root `package.json`
- **THEN** every workspace appears, including `app/packages/cloud-aws`,
  `app/packages/desktop-preload`, `app/packages/infra`, and `app/packages/lambda/efs-seeder`, and
  the maps identify the repository root — not `app/` — as the npm workspaces root

#### Scenario: Infra program file table matches the codebase

- **WHEN** `docs/docs/components/terraform.md`'s file/resource table is compared with the actual
  contents of `app/packages/infra`
- **THEN** every file and resource the table lists exists, and no file or resource in
  `app/packages/infra` that documentation depends on is missing from the table

#### Scenario: Root npm script table matches package.json

- **WHEN** the root npm script table in the documentation is compared with the `scripts` field of
  the root `package.json`
- **THEN** every documented script name and description matches an entry in `package.json`, and no
  script in `package.json` that operators or maintainers are expected to run is missing from the
  table

#### Scenario: Prerequisites match enforcement

- **WHEN** `docs/docs/setup.md` states the minimum Node version
- **THEN** it matches the `engines.node` constraint in the root `package.json`

#### Scenario: Maintainer invariants are true

- **WHEN** the invariants in `docs/docs/guides/maintainer.md` are read
- **THEN** no invariant claims that any Route 53 record is managed by the infrastructure program,
  and the `app/packages/infra` program's resource table lists only resources that exist

### Requirement: Previously undocumented subsystems are documented

Documentation SHALL cover the operator-facing and maintainer-facing subsystems that shipped
without documentation: the first-run setup wizard, the in-app plan/apply/destroy pipeline with
run history and rollback, game create/edit/delete from the UI, drift detection, the audit log,
the cloud-provider abstraction, the `@hyveon/desktop-preload` package, the `efs-seeder` Lambda,
credential storage via ElectronStore/SafeStorage, the JSON configuration store (`TfvarsService`),
and the full set of CI workflows.

#### Scenario: Game CRUD reflects the JSON configuration store

- **WHEN** `docs/docs/guides/user.md` and `docs/docs/guides/maintainer.md` describe adding a game
- **THEN** they direct the operator to the in-app Games screen and state that the write updates
  the versioned JSON configuration object and still requires a separate plan/apply run to deploy,
  rather than instructing the operator to hand-edit any configuration file

#### Scenario: Cloud-provider abstraction is documented

- **WHEN** `docs/docs/components/management-app.md` describes the backend module graph
- **THEN** it includes `ConfigModule` and `CloudProviderModule`, names the `CLOUD_PROVIDER`,
  `SECRETS_STORE`, `REMOTE_FILE_STORE`, and `DISCORD_RECEIVER` injection tokens, and states that
  new cloud calls are made through a token rather than a concrete AWS class

#### Scenario: CI workflows are listed in full

- **WHEN** `docs/docs/guides/maintainer.md` lists the CI workflows
- **THEN** every file in `.github/workflows/` appears with a one-line description
