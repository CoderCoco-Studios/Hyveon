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
├── app/                                 # npm-workspaces monorepo
│   ├── package.json                     # workspaces root; `npm run` scripts fan out
│   ├── eslint.config.js                 # flat config; recommended TS + React presets
│   ├── tsconfig.base.json               # shared TS config
│   ├── vitest.config.ts
│   └── packages/
│       ├── shared/                      # @hyveon/shared — pure TS + DDB/Secrets helpers
│       ├── desktop-main/                # @hyveon/desktop-main — Nest.js API
│       ├── web/                         # @hyveon/web   — React + Vite dashboard
│       └── lambda/
│           ├── interactions/            # esbuild → dist/handler.cjs
│           ├── followup/
│           ├── update-dns/
│           └── watchdog/
├── terraform/                           # root composer: backend/providers + module "cloud"
│   ├── main.tf variables.tf outputs.tf moved.tf
│   ├── terraform.tfvars.example
│   └── aws/                             # all AWS infra (the "cloud" module)
│       ├── main.tf alb.tf route53.tf watchdog.tf interactions.tf followup.tf
│       ├── discord_store.tf variables.tf outputs.tf versions.tf
│       └── discord-domain.tf efs-seeder.tf
├── docs/                                # this site
└── .github/workflows/                   # lint.yml, test.yml, docusaurus-gh-pages.yml
```

`app/` is a single npm workspace. One `npm install` at the root installs
everything. Lambdas are built via esbuild to single-file CJS bundles at
`app/packages/lambda/*/dist/handler.cjs`; Terraform's `archive_file`
zips them at apply time, so CI and local dev must build them before any
terraform operation.

## Everyday loop

```bash
# One-time (from the repo root — a single npm-workspaces tree)
npm install
cd terraform && terraform init && cd ..

# Electron desktop app in dev mode — HMR on renderer saves, auto-restarts main+preload
npm run app:dev

# Before pushing
npm run app:lint && npm run app:test && npm run app:build
cd terraform && terraform fmt -check -recursive && terraform validate && tflint
```

### Useful scripts (from the repo root)

| Command | What it does |
|---|---|
| `npm run app:dev` | Launches the Electron app in dev mode (delegates to `desktop:dev`). |
| `npm run app:build` | Compiles shared → desktop-main → web TypeScript. |
| `npm run desktop:build` | electron-vite build — produces `out/main`, `out/preload`, `out/renderer`. |
| `npm run app:build:lambdas` | esbuild every Lambda to `dist/handler.cjs`. Required before `terraform apply`. |
| `npm run app:start` | Runs the built Electron app (requires `desktop:build` first). |
| `npm run app:test` | `vitest run` across every workspace. |
| `npm run app:test:watch` | Same but watch mode. |
| `npm run app:lint` / `app:lint:fix` | ESLint flat config over all packages. |

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

Three workflows live in `.github/workflows/`:

- **`lint.yml`** — ESLint + `tflint` + `terraform fmt -check -recursive` +
  `terraform validate`. Runs on every push/PR.
- **`test.yml`** — `vitest run` across all workspaces.
- **`docusaurus-gh-pages.yml`** — publishes this site. Only triggers on
  `docs/**` and the workflow itself on `main`, plus `workflow_dispatch`.
  To preview doc changes locally, run `cd docs && npm install && npm start`.

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
group, security-group rules, the `GAME_NAMES` env var on three Lambdas — is
driven by `for_each` over `var.game_servers`. Do not hand-write new
per-game resources. To add a game, a user edits `terraform.tfvars` and
that's it.

### 3. DNS is Lambda-managed, not Terraform-managed

`route53.tf` has a `data "aws_route53_zone"` and the updater Lambda, but no
`aws_route53_record` resources for the game hostnames. The update-dns
Lambda creates and deletes them on ECS task state changes.

Exception: for HTTPS games, Route 53 ALIAS records pointing to the ALB *are*
Terraform-managed (in `alb.tf`); the Lambda only manages ALB target
membership for those.

### 4. Watchdog state lives in ECS task tags

The `idle_checks` counter per task is an ECS tag. No DynamoDB, no SSM. The
tag disappears with the task, which is the whole point. Do not move it to
persistent storage.

### 5. `AWS_REGION_` has a trailing underscore

Lambda reserves `AWS_REGION`. All four Lambdas read `process.env.AWS_REGION_`
instead. Check every Terraform file that sets Lambda env vars and every
Lambda handler. The shared `ddb/client.ts` has a fallback chain
(`AWS_REGION_` → `AWS_REGION` → `AWS_DEFAULT_REGION` → `us-east-1`) so
shared code works in both the server and the Lambdas.

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

1. `cd app && npm run build:lambdas` — esbuild emits
   `app/packages/lambda/*/dist/handler.cjs`.
2. `cd terraform && terraform apply` — `data "archive_file"` reads the CJS
   bundle, zips it, and uploads it to each `aws_lambda_function`. The
   function URL, IAM role, env vars, and EventBridge rule are all in the
   matching `.tf` file.

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
