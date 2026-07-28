---
title: Maintainer guide
sidebar_position: 3
---

# Maintainer guide

You're here to change the code. This page is the shortest path from "clean
clone" to "PR merged" plus the invariants that are load-bearing enough that
CI can't always catch you breaking them.

Read [`CLAUDE.md`](https://github.com/CoderCoco/Hyveon/blob/main/CLAUDE.md)
and [`CONTRIBUTING.md`](https://github.com/CoderCoco/Hyveon/blob/main/CONTRIBUTING.md)
first. They are the source of truth for test/lint conventions and PR titles.
This page is documentation over the top of them, not a replacement.

## Repository layout

```text
Hyveon/
├── package.json                         # npm-workspaces ROOT — `npm run` scripts fan out from here
├── tsconfig.base.json                   # shared TS config
├── scripts/                             # @hyveon/scripts — init-parent.ts submodule scaffolder
├── build/                               # icon source art (icon.svg, icon-small.svg) + generate-icons.mjs
├── electron.vite.config.ts              # electron-vite build config (main/preload/renderer pipelines)
├── electron-builder.yml                 # packaged-installer config (NSIS/DMG/AppImage)
├── openspec/                            # OpenSpec change proposals/specs for this repo
├── app/                                 # @hyveon/app — Electron desktop app workspace
│   ├── eslint.config.js                 # flat config; recommended TS + React presets
│   ├── vitest.config.ts
│   └── packages/
│       ├── shared/                      # @hyveon/shared — pure TS + DDB/Secrets helpers
│       ├── cloud-aws/                   # @hyveon/cloud-aws — AWS impl of the cloud-agnostic contracts
│       ├── desktop-main/                # @hyveon/desktop-main — Nest.js IPC microservice
│       ├── desktop-preload/             # @hyveon/desktop-preload — contextBridge preload script
│       ├── web/                         # @hyveon/web   — React + Vite dashboard renderer
│       └── lambda/
│           ├── interactions/            # esbuild → dist/handler.cjs
│           ├── followup/
│           ├── update-dns/
│           ├── watchdog/
│           └── efs-seeder/              # conditional, one function per game with file_seeds
├── terraform/                           # root composer: backend/providers + module "cloud"
│   ├── main.tf variables.tf outputs.tf moved.tf
│   ├── terraform.tfvars.example
│   └── aws/                             # all AWS infra (the "cloud" module)
│       ├── main.tf route53.tf watchdog.tf interactions.tf followup.tf
│       ├── discord_store.tf discord-domain.tf variables.tf outputs.tf versions.tf
│       ├── audit_store.tf runs_store.tf
│       └── efs-seeder.tf
├── docs/                                # this site
└── .github/workflows/                   # lint.yml, test.yml, e2e.yml, integration.yml,
                                          # package.yml, docs-build.yml, docusaurus-gh-pages.yml
```

The repository **root** `package.json` is the npm-workspaces root — its
`workspaces` array lists `app`, `app/packages/*`, `app/packages/lambda/*`,
and `scripts`. One `npm install` at the root installs everything; `app/`
itself is just one workspace (`@hyveon/app`) among several, not a nested
workspaces root. Lambdas are built via esbuild to single-file CJS bundles at
`app/packages/lambda/*/dist/handler.cjs`; Terraform's `archive_file`
zips them at apply time, so CI and local dev must build them before any
terraform operation.

## Everyday loop

```bash
# One-time (from the repo root — a single npm-workspaces tree)
npm install
cd terraform && terraform init && cd ..
# ^ Manual first init. In practice most people never run this by hand — the
#   in-app first-run wizard (see the setup guide) bootstraps the S3 state
#   backend and runs `terraform init` for you the first time you launch the
#   app. Use the command above only if you're skipping the wizard.

# Electron desktop app in dev mode — HMR on renderer saves, auto-restarts main+preload
npm run app:dev

# Before pushing
npm run app:lint && npm run app:test && npm run app:build
cd terraform && terraform fmt -check -recursive && terraform validate && tflint
```

### Useful scripts (from the repo root)

| Command | What it does |
|---|---|
| `npm run app:dev` | Launches the Electron app in dev mode. Runs the `dev` script in the `@hyveon/app` workspace (`electron-vite dev --config ../electron.vite.config.ts`) — it does **not** literally delegate to the root `desktop:dev` script, though both ultimately invoke `electron-vite dev` against the same config, so behaviour is equivalent. |
| `npm run app:build` | Compiles shared → cloud-aws → desktop-main → web TypeScript. |
| `npm run desktop:dev` | `electron-vite dev` run directly from the repo root — HMR on renderer saves, auto-restarts main+preload. |
| `npm run desktop:build` | electron-vite build — produces `out/main`, `out/preload`, `out/renderer`. |
| `npm run desktop:package` | Runs `desktop:build` then `electron-builder` to produce a platform installer under `release/`. |
| `npm run app:build:lambdas` | esbuild every Lambda (including `efs-seeder`) to `dist/handler.cjs`. Required before `terraform apply`. |
| `npm run app:start` | Runs the built Electron app (requires `desktop:build` first). |
| `npm run app:test` | `vitest run` across every workspace. |
| `npm run app:test:watch` | Same but watch mode. |
| `npm run app:test:coverage` | `vitest run --coverage` in the `@hyveon/app` workspace. |
| `npm run app:test:e2e` | Builds `shared` + `cloud-aws`, then runs the Playwright e2e suite (`chromium` + `electron` projects) in `@hyveon/web`. |
| `npm run app:test:integration` | Builds `desktop-main`, then runs the tier-2 Playwright integration suite in `@hyveon/web`. |
| `npm run app:lint` / `app:lint:fix` | ESLint flat config over all packages. |
| `npm run scripts:init-parent` | Runs the interactive submodule-parent-repo scaffolder — see the [submodule guide](/guides/submodule). |
| `npm run scripts:tfvars-sync` | The `tfvars-sync` CLI (`pull`/`push`/`diff`/`check`/`migrate`) for the optional S3 tfvars backend — see the [S3 tfvars storage guide](/guides/s3-tfvars). |
| `npm run icons:generate` | Regenerates `build/icon.png`/`.ico`/`.icns` and the web favicons from `build/icon.svg` + `build/icon-small.svg`. |

## Test + naming conventions (short form)

From `CLAUDE.md`, paraphrased. CI will fail you on the first two even though
ESLint won't always catch them.

- **Test names** start with "should" and read like a natural sentence —
  `it('should return null when the state file is missing')`, not
  `it('returns null...')`.
- **TSDoc** on non-trivial functions, helpers, and notable constants. Also
  on test-file factories/fixtures.
- **Don't cast with `as unknown as T`** — prefer `vi.mocked(fn)` for module
  mocks, and `Partial<T>` + a single `as T` for service-shaped stubs.
- **No raw `process.env` in business logic** — wrap behind a service method
  so tests can `vi.spyOn` rather than mutating `process.env`.

## PR conventions (short form)

See `CONTRIBUTING.md` for the full list. Two things that bite people:

- **We squash-merge**, so the PR title becomes the commit subject on `main`
  verbatim. It MUST be Conventional Commits:
  `<type>(<optional-scope>): <imperative summary>`, under ~70 chars.
- **Copilot comments**: decline most. The bar is genuine bug, security
  issue, or broken behaviour. Style, naming, "consider", "might want" —
  decline on the thread with a one-line reason, don't enter a fix-and-repush
  loop.

## CI

Seven workflows live in `.github/workflows/`:

- **`lint.yml`** — ESLint + `tflint` + `terraform fmt -check -recursive` +
  `terraform validate`. Runs on every push/PR. Node 24.
- **`test.yml`** — `vitest run` across all workspaces. Node 24.
- **`e2e.yml`** — the Playwright e2e suite (`chromium` + `electron`
  projects) against a built app. Node 24.
- **`integration.yml`** — the tier-2 Playwright integration suite dispatching
  directly into the Nest.js DI container. Node 24.
- **`package.yml`** — builds the packaged Electron installer on a
  Linux/macOS/Windows matrix; runs on every PR and on `v*` tags. Node 24.
- **`docs-build.yml`** — a docs-only build check (`docs/**` paths); catches
  broken Docusaurus builds on a PR before merge. Node 24.
- **`docusaurus-gh-pages.yml`** — publishes this site. Only triggers on
  `docs/**` and the workflow itself on `main`, plus `workflow_dispatch`.
  Node 24. To preview doc changes locally, run `cd docs && npm install && npm start`.

There is also CodeQL security analysis configured at the org level (see
`CONTRIBUTING.md`).

## Invariants that hurt to break

These are load-bearing design choices. Reviews will push back hard if a PR
appears to touch one without calling it out.

### 1. Don't introduce a long-running ECS service

The whole cost-saving argument is that game tasks run via `RunTask` and stop
with `StopTask`. Adding `aws_ecs_service` anywhere means you pay for a task
24/7 and defeat the watchdog.

### 2. `game_servers` is the single source of truth

Every per-game resource — task definition, EFS access point, CloudWatch log
group, security-group rules, the `GAME_NAMES` env var on four Lambdas
(interactions, followup, update-dns, watchdog) — is driven by `for_each`
over `var.game_servers`. Do not hand-write new per-game resources. To add a
game, a user edits `terraform.tfvars` and that's it.

### 3. DNS is Lambda-managed, not Terraform-managed

`route53.tf` has a `data "aws_route53_zone"` and the updater Lambda, but no
`aws_route53_record` resources for the game hostnames. The update-dns
Lambda creates and deletes them on ECS task state changes, uniformly for
every game — including `https = true` ones, which terminate TLS in-task via
a Caddy sidecar and share the task's public IP. There is no ALB anywhere in
this stack and no exception to this rule: **no** Route 53 record for **any**
game is Terraform-managed. (The one Terraform-managed Route 53 record in the
whole repo, `aws/discord-domain.tf`'s CloudFront ALIAS, fronts the Discord
bot endpoint — an unrelated, fixed, non-per-game resource — not a game.)

### 4. Watchdog state lives in ECS task tags

The `idle_checks` counter per task is an ECS tag. No DynamoDB, no SSM. The
tag disappears with the task, which is the whole point. Do not move it to
persistent storage.

### 5. `AWS_REGION_` has a trailing underscore

Lambda reserves `AWS_REGION`. Terraform sets `AWS_REGION_` on all five
Lambda functions' env vars; the four core Lambdas (interactions, followup,
update-dns, watchdog) read `process.env.AWS_REGION_`. `efs-seeder` has the
same env var set for consistency but never reads it — it makes no AWS SDK
calls at all (see [Lambdas](/components/lambdas#efs-seeder)). Check every
Terraform file that sets Lambda env vars and every Lambda handler. The
shared `ddb/client.ts` has a fallback chain (`AWS_REGION_` → `AWS_REGION` →
`AWS_DEFAULT_REGION` → `us-east-1`) so shared code works in both the server
and the Lambdas.

### 6. Secrets never leave AWS

The bot token and Discord public key live in Secrets Manager.
`DiscordConfigService.getRedacted()` returns `botTokenSet` and
`publicKeySet` booleans; `getEffectiveToken()` is the single escape hatch,
used only by `DiscordCommandRegistrar`. Do not add an endpoint that returns
the raw values.

### 7. Per-guild command registration only

`DiscordCommandRegistrar.registerForGuild` PUTs to
`applications/{client_id}/guilds/{guild_id}/commands`. Do not register global
commands — they would leak to every guild the bot is invited to. The
dashboard button is labelled "Register commands" for exactly this reason —
it's one guild at a time.

### 8. `canRun()` ordering

`guild allowlist → admin → per-game user/role + action`. The function is in
`@hyveon/shared` and imported verbatim by the server and both Discord Lambdas.
Do not duplicate the logic — one copy, tested once.

### 9. Slash commands are JSON descriptors, not classes

`COMMAND_DESCRIPTORS` in `@hyveon/shared/commands.ts` is the only source of
truth for the four slash commands. The interactions Lambda dispatches with
a ~40-line switch. To add a new command:

1. Append a descriptor in `commands.ts`.
2. Add a case to the switch in `app/packages/lambda/interactions/src/handler.ts`
   and to the followup handler's `event.kind` switch.
3. Update `actionForCommand()` so `canRun()` gets the right bucket.
4. Rebuild Lambdas, `terraform apply`, click **Register commands** per guild.

### 10. There is no HTTP surface or bearer token to reintroduce

`desktop-main` runs as an Electron IPC microservice — every controller is
IPC-only (`@MessagePattern()`, no HTTP routes), and the renderer's only path
to it is `window.hyveon` over `contextBridge`. There is no `ApiTokenGuard`,
`API_TOKEN`, or `/api/*` surface left in this app. Don't add an HTTP
listener or a bearer-token guard back in without a documented reason — it
would reopen a network attack surface a purely local IPC transport doesn't
have.

### 11. Events IAM

AWS tags EventBridge rules on creation; `events:TagResource` /
`UntagResource` / `ListTagsForResource` are required and not in any managed
policy. The setup guide's inline policy grants `events:*` which covers this.
If you tighten the policy later, keep those three actions.

## How the Lambdas get deployed

Every time:

1. `npm run app:build:lambdas` (from the repo root) — esbuild emits
   `app/packages/lambda/*/dist/handler.cjs` for all five Lambda packages.
2. `cd terraform && terraform apply` — `data "archive_file"` reads each CJS
   bundle, zips it, and uploads it to the matching `aws_lambda_function`
   (or, for `efs-seeder`, one per game with `file_seeds`). The function URL
   (where applicable), IAM role, env vars, and EventBridge rule are all in
   the matching `.tf` file.

Because the zip hash is derived from the file content, `terraform plan`
will only report a Lambda change when the bundle bytes actually change.
You can rebuild freely without generating spurious diffs.

There is no separate CI pipeline for Lambdas — deploys happen from your
laptop or wherever you run `terraform apply`.

## When you touch Terraform

Minimum you owe the reviewer:

- `terraform fmt -recursive` (or `terraform fmt -check -recursive` to
  verify).
- `terraform validate`.
- `tflint` with the AWS ruleset.
- Run `terraform plan` against a real account and paste the relevant
  resource changes into the PR description. Seeing new/destroyed
  resources in the plan output is what actually catches mistakes.

For anything that touches Lambda IAM, list the exact actions added/removed
in the PR body — least-privilege roles are easy to silently widen.

## When you touch the Nest server

- New endpoint → add it to the matching controller under
  `app/packages/desktop-main/src/controllers/`, not a new folder layer.
- New AWS call → add a method to the appropriate service under
  `services/`. Services are `@Injectable()` and wired through `AwsModule` /
  `DiscordModule`.
- New **cloud-facing** call (anything that would otherwise mean
  instantiating an `@aws-sdk/*` client directly) → prefer routing it through
  one of the six `CloudProviderModule` injection tokens (`CLOUD_PROVIDER`,
  `SECRETS_STORE`, `REMOTE_FILE_STORE`, `DISCORD_RECEIVER`,
  `AUDIT_LOG_STORE`, `RUN_RECORD_STORE`) and depend only on the
  `@hyveon/shared` interface it's typed against, not the concrete
  `@hyveon/cloud-aws` class. This is what keeps a future non-AWS cloud
  provider a one-module change instead of a call-site hunt — see
  [Management app](/components/management-app) for the module graph.
- Use Winston (`logger` from `logger.ts`) for structured logs. No
  `console.log` in production paths.
- Wrap environment access behind a service method — don't reach for
  `process.env` directly in request handlers.
- Add a matching `.test.ts` file next to the service/controller. Mock the
  AWS SDK v3 clients with `aws-sdk-client-mock`.

## When you touch the web client

- API calls go through `packages/web/src/api.service.ts`, which delegates
  every method straight to `window.hyveon.*` (the Electron preload bridge).
  There is no `fetch`, no bearer token, and no 401/re-auth flow to bypass.
- New IPC-channel wrappers keep the same shape as existing ones (one method
  per channel, return a typed promise).

## Refreshing the documentation screenshots

The screenshots embedded under [Using the app](/app) live in
`docs/static/img/app/` and are captured by a dedicated Playwright harness at
`app/packages/web/e2e/screenshots/` that drives the real packaged Electron
app (not a browser tab) via `_electron.launch()`, seeding every screen with
deterministic demo data through the `window.hyveon.__test.mock()` seam.

Prerequisite — build the Electron app first:

```bash
npm run desktop:build
```

Then capture:

```bash
npm run docs:screenshots
```

On Linux this needs a display: WSLg (WSL2 with GUI support) works out of the
box; on a headless Linux box or CI runner, wrap the command with `xvfb-run`:

```bash
xvfb-run -a npm run docs:screenshots
```

Refresh screenshots whenever a documented screen's visual layout changes —
a new panel, a moved control, a restyled state — not for every unrelated
code change. The harness is isolated from the regular e2e run (its own
Playwright config, its own test directory), so `npm run app:test:e2e` never
executes it and CI's e2e job never writes to `docs/static/img/app/`.

## Release / deploy

There is no versioned release. "Deploying" = running `npm run app:build:lambdas`
then `terraform apply`, and then packaging/running the Electron app
(`npm run desktop:package`, or `npm run app:build && npm run app:start`)
from whatever machine holds the AWS credentials.

If you're wrapping this repo as a submodule inside a private parent repo
that holds `terraform.tfvars` and state — which is the
pattern we recommend for anyone running this for real — see the
[submodule guide](/guides/submodule) for that layout.

## Useful references

- [`CLAUDE.md`](https://github.com/CoderCoco/Hyveon/blob/main/CLAUDE.md) —
  project instructions in full, including the "why" for every invariant.
- [`CONTRIBUTING.md`](https://github.com/CoderCoco/Hyveon/blob/main/CONTRIBUTING.md) —
  PR rules, review policy, local-check commands.
- [Architecture](/architecture) —
  component and sequence diagrams.
- [Component docs](/#component-reference) —
  deep-dives on terraform, the management app, and the Lambdas.
