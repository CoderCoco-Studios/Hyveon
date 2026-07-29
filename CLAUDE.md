# CLAUDE.md

This file holds **workflow rules and invariants only**. It deliberately does not
describe how the system works — that lives in OpenSpec and in `docs/`, which are
kept current and are the source of truth. Read the relevant spec/doc before
working in an area rather than relying on a summary here.

## Where to look before starting work

| You need | Read |
|----------|------|
| What a capability must do (requirements, scenarios) | `openspec/specs/<capability>/spec.md` |
| Work already proposed or in flight | `openspec/changes/<change>/` (`proposal.md`, `design.md`, `tasks.md`) |
| Big picture + invariants | `docs/docs/architecture.md` |
| Terraform files, variables, outputs, gotchas | `docs/docs/components/terraform.md` |
| The five Lambdas and the `/server-start` critical path | `docs/docs/components/lambdas.md` |
| Nest modules, IPC channels, services, renderer layout | `docs/docs/components/management-app.md` |
| The operator UI, page by page (dashboard, games, terraform, discord, logs, settings, costs, audit, first-run wizard) | `docs/docs/app/` |
| Installing / distributing the packaged app | `docs/docs/install.md` |
| Test harnesses, mock seams, fixtures, and the jsdom component/routed-page conventions | `docs/docs/components/integration-tests.md` |
| Writing or updating anything under `docs/docs/**` | the `write-docs` skill (`.claude/skills/write-docs/`), which drafts through `docs-writer` and reviews through the three `docs-*` evaluator agents |
| AWS IAM deploy policy (`HyveonDeployAll`) — single source of truth | `docs/docs/setup.md` |
| Setup walkthrough / operator guides | `docs/docs/setup.md`, `docs/docs/guides/` |
| Copilot review tuning | `.github/copilot-instructions.md` |
| PR creation command | `.claude/commands/pr.md` |

OpenSpec workflow skills: `/opsx:propose` (new change), `/opsx:apply`
(implement), `/opsx:sync` (fold delta specs into main specs), `/opsx:archive`
(close out a shipped change). Anything that changes required behaviour goes
through a change, not straight into `openspec/specs/`.

## Commands

Single **npm-workspaces** tree rooted at the repo root. Workspaces: `@hyveon/shared`,
`@hyveon/cloud-aws`, `@hyveon/desktop-main`, `@hyveon/desktop-preload`, `@hyveon/web`,
five Lambda packages under `app/packages/lambda/*`, and `@hyveon/scripts`.

```bash
npm install                    # install every workspace (run from repo root)

npm run desktop:dev            # Electron dev mode: renderer HMR, auto-restart main+preload
npm run app:build              # compile shared → cloud-aws → desktop-main → preload → web
npm run desktop:build          # electron-vite build → out/main, out/preload, out/renderer
npm run app:start              # launch the built app (requires desktop:build first)
npm run desktop:package        # electron-builder installers → release/ (Win NSIS, macOS DMG, Linux AppImage)

npm run app:build:lambdas      # bundle all five Lambdas (REQUIRED before `terraform apply`)
npm run icons:generate         # regenerate app icons + favicons from build/icon*.svg (outputs are committed)
npm run scripts:init-parent    # parent-repo scaffolder
npm run scripts:tfvars-sync    # sync tfvars to/from the S3 tfvars bucket

npm run app:lint               # eslint (flat config at app/eslint.config.js)
npm run app:lint:fix
npm run app:typecheck          # full cross-workspace tsc pass
npm run app:test               # vitest, all workspaces
npm run app:test:watch
npm run app:test:coverage
npm run app:test:e2e           # Playwright tier 1 (chromium + electron projects)
npm run app:test:integration   # Playwright tier 2 (in-process Nest DI container)

cd terraform && terraform init && terraform plan && terraform apply
tflint                         # run `tflint --init` once first; config in terraform/.tflint.hcl
```

All AWS resources are tagged `Project=hyveon`; activate the `Project` tag in AWS
Billing → Cost allocation tags for Cost Explorer breakdowns.

## Invariants that hurt to break

Full explanations in `docs/docs/architecture.md`; the short list is here because
these are easy to violate while making an otherwise reasonable change.

- **No persistent ECS Service.** Tasks are started on demand via `RunTask`/`StopTask`
  against `{game}-server` task definitions. A long-running Service destroys the
  core cost model.
- **`terraform/aws/variables.tf:game_servers` is the single source of truth.** Adding a
  game means editing `terraform.tfvars` only — every resource fans out via `for_each`.
- **DNS records are Lambda-managed, never Terraform-managed.** `@hyveon/lambda-update-dns`
  UPSERTs on `RUNNING` and DELETEs on `STOPPED`; Terraform-owned records would fight it.
- **TLS terminates in-task via a Caddy sidecar.** There is no ALB, target group, or ACM
  certificate anywhere in the stack (`openspec/specs/in-task-tls-termination`).
- **Watchdog state lives in ECS task tags**, not DynamoDB or SSM.
- **Lambda env vars use `AWS_REGION_`** (trailing underscore) — `AWS_REGION` is reserved
  by the Lambda runtime.
- **Discord is fully serverless**: no discord.js, no gateway connection, no bot process.
  Register commands **per guild only** — global registration leaks to every guild.
- **`canRun()` lives in `@hyveon/shared`** and is imported verbatim by both the desktop app
  and the Lambdas. Exactly one copy; never fork the permission logic.
- **Secrets never reach the renderer.** Redacted shapes expose `botTokenSet` / `publicKeySet`
  booleans, never values.
- **The desktop app has no HTTP transport.** `desktop-main` is an Electron IPC microservice;
  there is no bearer token and no API server (`openspec/specs/desktop-only-operator-surface`).

## Code & test conventions

- **Test names** read as sentences starting with "should" — `it('should return null when
  state file is missing')`, not `it('returns null…')`.
- **TSDoc** on non-trivial functions, helpers, and notable constants — including test-file
  helpers (stub factories, fixtures).
- **No `as unknown as T` casts in tests.** Prefer `vi.mocked(fn)` for mocked modules and
  `Partial<T>` + a single `as T` for service-shaped stubs.
- **No raw `process.env` in business logic.** Wrap env access behind a service method so
  tests stub it with `vi.spyOn` instead of mutating `process.env`.

Three complementary test tiers:

| Tier | Command | What runs |
|------|---------|-----------|
| Unit / component | `npm run app:test` | Vitest, split into a `node` project and a jsdom `web` project. Server logic runs under `node`; `@hyveon/web` component and routed-page specs run under `jsdom`, co-located with the component and mounted through `renderPage()`. AWS SDK mocked via `aws-sdk-client-mock`. |
| E2E (tier 1) | `npm run app:test:e2e` | Playwright, two projects: `electron` launches the packaged app via `_electron.launch()` with `HYVEON_TEST_MODE=1`; `chromium` runs the remaining stub-based specs against `vite build` + `vite preview`. Migration to `electron` is in progress. |
| Integration (tier 2) | `npm run app:test:integration` | Playwright dispatching into the real `AppModule` DI container built in-process — no HTTP server, no Vite, no `BrowserWindow`. |

Playwright conventions:

- Specs in `app/packages/web/e2e/specs/`, fixtures in `e2e/fixtures/`, page objects in
  `e2e/pages/`. Import `test`, `expect`, and page-object fixtures from `../fixtures/index.js`.
- **Specs must reach elements through a page object** (`logs.pauseButton()`,
  `dashboard.gameCardHeading('minecraft')`), never `page.getByX(...)` directly. Add a page
  object whenever a spec needs a locator that isn't wrapped yet.
- Tier-2 specs live in `e2e/integration-specs/` and import `{ test, expect }` from
  `./index.js` (not `@playwright/test`) so they get the `ipc` and `serverMocks` fixtures.
- The `window.hyveon.__test.mock()` seam and the two mock surfaces are documented in
  `docs/docs/components/integration-tests.md`.

jsdom component and routed-page conventions — the two Vitest projects, `renderPage()`,
`toStreamHandleMock()`, and which API methods a page spec must stub or it hangs — are on
the same page. Read it before adding a `@hyveon/web` spec.

## Before opening a PR

Run these locally — do not rely on CI to find it first, and do not claim a change works
without having run the relevant command and seen it pass:

1. `npm run app:lint` — clean.
2. `npm run app:typecheck` — clean.
3. `npm run app:test` — full unit suite green.
4. `npm run app:test:integration` when controllers, services, or Terraform orchestration changed.
5. `npm run app:test:e2e` when the renderer, preload bridge, or IPC surface changed.

Then confirm documentation is current **in the same PR**:

- **`docs/`** — update every page the change touches (`docs/docs/architecture.md`,
  `docs/docs/components/*`, `docs/docs/app/*`, `docs/docs/setup.md`, `docs/docs/guides/*`).
  A behaviour change with no docs update is an incomplete PR. Use the `write-docs` skill —
  it maps the diff to the pages that own it and reviews the result through the `docs-*`
  evaluator agents, which is more reliable than hand-picking pages from memory.
- **OpenSpec** — if required behaviour changed, the change's delta specs must be synced
  (`/opsx:sync`) or the change archived (`/opsx:archive`) so `openspec/specs/` matches reality.
- **Terraform variables** — adding or removing one means touching all five in the same commit:
  1. `terraform/variables.tf` **and** `terraform/aws/variables.tf` (except `tags`, root-only).
  2. `terraform/main.tf` — pass it through the `module "cloud"` block.
  3. `terraform/terraform.tfvars.example` — commented example entry.
  4. `docs/docs/components/terraform.md` — Variables table row.
  5. `docs/docs/setup.md` — any affected setup step.

## Git & PR workflow

`main` is protected — direct pushes are blocked. Every change goes through a PR, including
trivial chores. Work in a worktree:

```bash
git worktree add .worktrees/<branch> -b <branch>
```

- **Always use `/pr`** to open pull requests — it validates the title before calling the API.
- **PR titles MUST be Conventional Commits.** We squash-merge, so the title becomes the commit
  subject on `main` verbatim. Format `<type>(<scope>): <imperative summary>` where `<type>` is
  one of `feat|fix|refactor|docs|test|chore|perf|build|ci|style`; keep it under ~70 chars.
  Pre-flight regex: `^(feat|fix|refactor|docs|test|chore|perf|build|ci|style)(\([^)]+\))?: .+$`.
- **Put `Closes #N` as the first line of the PR body** when the PR resolves an issue.

The **`issue-flow`** plugin (`CoderCoco/claude-plugin-marketplace`) drives the issue → PR loop:
`work-on` starts an issue (branch + worktree + checklist), `open-pr` finishes it (verifies the
checklist, applies these conventions, moves the project card). If the plugin isn't loaded,
fetch the skill body from the marketplace repo and follow it manually.

## PR review workflow

Judge each suggestion on its merits.

- **Fix** if genuinely buggy, insecure, crashing, or logically wrong.
- **Decline** if stylistic, naming, "consider…", or a minor nit — reply with a concrete reason,
  then resolve.
- **Ask** (`AskUserQuestion`) if ambiguous or architecturally significant. Never silently dismiss.
- **Stop pushing** once a round is all nitpicks — reply, resolve, and move on.

Every thread ends in an explicit Fix or Decline with a reply (fix + SHA, or the reason) and is
resolved via `mcp__github__resolve_review_thread`. Never leave a noncommittal "tracking this".
