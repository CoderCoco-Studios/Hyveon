## 1. Application chrome and navigation fixes

- [x] 1.1 Add a Costs entry to the sidebar Monitoring section in `app/packages/web/src/components/app-layout.component.tsx`, with an appropriate icon and the same active-route styling as the existing entries
- [x] 1.2 Remove the three permanently-disabled sidebar entries (Servers, Metrics, Alerts) and the now-unused `disabled`/`aria-disabled` rendering branch from `app-layout.component.tsx`
- [x] 1.3 Remove the non-functional `Search… ⌘K` input from the top bar in `app-layout.component.tsx`, along with any styles that become dead
- [x] 1.4 Update `app-layout.component.test.tsx` to assert the Costs entry is present, no disabled entry renders, and no search input renders
- [x] 1.5 Remove the hardcoded `Players` tile from the stat grid in `app/packages/web/src/components/game-card.component.tsx` and adjust the grid layout for the remaining three stats
- [x] 1.6 Update `game-card.test.tsx` to drop assertions on the Players tile and assert the remaining stats render
- [x] 1.7 Make `app/packages/web/src/pages/logs.page.tsx` read `location.state?.game` on mount and use it as the initial selection when it names a game present in the list, falling back to the first game otherwise
- [x] 1.8 Add unit tests to `logs.page.test.tsx` covering: preselection from `location.state`, fallback when `location.state` is absent, and fallback when it names an unknown game
- [x] 1.9 Update any Playwright page objects and specs under `app/packages/web/e2e/` that reference the removed sidebar entries, the removed search box, or the removed Players stat
- [x] 1.10 Add an e2e assertion that Costs is reachable from the sidebar
- [x] 1.11 Run `npm run app:test` and `npm run app:lint` and confirm both pass

## 2. Screenshot harness

- [x] 2.1 Create `app/packages/web/e2e/screenshots/demo-data.ts` with a typed demo fixture set — a running `minecraft` with hostname, a stopped `valheim`, a running `palworld` — reusing the shared contract types from `@hyveon/shared`
- [x] 2.2 Add `seedDemo(win)` to `demo-data.ts` installing every needed channel via `window.hyveon.__test.mock`: `env.get`, `games.status`, `games.getStatus`, `games.list` (as `GameListEntry[]`), `games.start`, `games.stop`, `costs.estimate`, `costs.actual`, `discord.getConfig`, `config.get`, `drift.get`, `audit.list`, `logs.get`, `logs.stream` (no-op), the `terraform.*` channels, and the `diagnostics.*` channels
- [x] 2.3 Create `app/packages/web/playwright.screenshots.config.ts` with `testDir: './e2e/screenshots'`, no `webServer`, `workers: 1`, and no browser project — each test launches Electron itself
- [x] 2.4 Confirm `npm run app:test:e2e` does not pick up anything under `e2e/screenshots/`
- [x] 2.5 Create `app/packages/web/e2e/screenshots/capture.spec.ts` with a shared setup that launches Electron via the existing `launchElectron()` helper, sets the window content size to 1200×800 through `app.evaluate`, freezes the clock, injects a transitions/animations-off style tag, and calls `seedDemo`
- [x] 2.6 Add capture cases for the dashboard, games list, game detail, costs, logs, discord, audit, and settings screens, navigating with the existing page-object helpers and writing to `docs/static/img/app/<screen>.png` with `animations: 'disabled'`
- [x] 2.7 Add capture cases for the terraform page in its pre-run and awaiting-approval states, plus the run-history list, with a code comment recording why streamed log output cannot be captured through the contextBridge mock seam
- [x] 2.8 Add capture cases for the first-run wizard covering each of the five steps, seeding the wizard channels so the app renders the wizard instead of the router
- [x] 2.9 Add an npm script that runs the harness, and document the `desktop:build` prerequisite
- [x] 2.10 Run the harness end to end and visually inspect every produced PNG for empty states, loading spinners, error banners, and mid-animation frames; fix the seeding until every image shows the intended state
- [x] 2.11 Run the harness a second time with no code change and confirm the images do not change

## 3. Diagram sources

- [x] 3.1 Correct `docs/diagrams/context.d2`: remove the bearer-token arrow and restate the management app as the Electron desktop app driving desktop-main over IPC
- [x] 3.2 Correct `docs/diagrams/game-plane.d2`: remove the ALB + ACM node and its edges, route HTTPS players to the task's own public IP via the Caddy sidecar, remove the bearer-token arrow, and drop the Docker-era "mounted ro" phrasing on the tfstate node
- [x] 3.3 Correct `docs/diagrams/control-loops.d2`: remove the ALB target-group node, the `update_dns -> alb` edge, and both `watchdog -> r53` and `watchdog -> alb` cleanup edges; show the watchdog issuing `StopTask` only, with `update-dns` reacting to the resulting task-state event
- [x] 3.4 Review `docs/diagrams/discord-bot.d2` and `docs/diagrams/server-start.d2` against the current architecture and correct anything stale
- [x] 3.5 Run `bash docs/diagrams/render.sh` and commit the regenerated `docs/static/diagrams/*.svg`
- [x] 3.6 Rewrite `docs/diagrams/README.md`: replace the Jekyll pipeline description with the Docusaurus one, name `.github/workflows/docusaurus-gh-pages.yml`, correct the claim that outputs are gitignored, fix the consuming-page paths to `docs/docs/intro.md` and `docs/docs/architecture.md`, and replace the `bundle exec jekyll serve` preview command with `cd docs && npm start`

## 4. New "Using the app" documentation section

- [x] 4.1 Create `docs/docs/app/_category_.json` with a label and position that places the section after the setup material
- [x] 4.2 Write `docs/docs/app/index.md`: a guided tour from first launch to a running game server, plus a navigation map of every screen linking to its page
- [x] 4.3 Write `docs/docs/app/first-run-wizard.md` covering all five steps in order, the resume-on-relaunch behaviour and its clamp, what blocks Next at each step, and the reconfigure variant launched from Settings
- [x] 4.4 Write `docs/docs/app/dashboard.md` covering the KPI strip, game cards, start/stop with the confirm dialog and undo toast, the file-manager modal, the pending-changes banner, and the loading/empty/filtered-empty states
- [x] 4.5 Write `docs/docs/app/games.md` covering the games table and its in-sync/pending-deploy/undeclared chips, the add-game wizard steps, the game detail screen, edit and remove flows, and the rule that writes only touch `terraform.tfvars`
- [x] 4.6 Write `docs/docs/app/terraform.md` covering plan, the approval gate and its expiry window, apply, destroy with its type-to-confirm phrase, run history with its filters, run detail, and rollback
- [x] 4.7 Write `docs/docs/app/discord.md` covering the readiness badge, the get-started card, and the credentials, guilds, admins, and per-game permissions tabs
- [x] 4.8 Write `docs/docs/app/logs.md` covering game selection, level filtering, search highlighting, autoscroll, pause and resume, the buffer cap, and the error states
- [x] 4.9 Write `docs/docs/app/costs.md` covering the range selector, the trailing-window delta, the stacked daily chart and its uniform-split caveat, the per-game estimate table, and the `Project` cost-allocation-tag prerequisite
- [x] 4.10 Write `docs/docs/app/audit.md` covering the entry table, the expandable config diff, and pagination
- [x] 4.11 Write `docs/docs/app/settings.md` covering the watchdog tunables and the caveat that the Lambda schedule is set at apply time, the cloud-setup row and Reconfigure button, and the diagnostics panel with its log path
- [x] 4.12 Embed the captured screenshots into each page with descriptive alt text, using root-relative `/img/app/…` paths

## 5. Accuracy sweep of existing documentation

- [x] 5.1 `docs/docs/intro.md`: remove the ALB/ACM bullet, restate the management app as a packaged Electron desktop app, correct the Lambda count to five, and rebuild the repo map to include `app/packages/cloud-aws`, `app/packages/desktop-preload`, `app/packages/lambda/efs-seeder`, `scripts/`, `build/`, `openspec/`, `electron.vite.config.ts`, and `electron-builder.yml`, with the repository root identified as the workspaces root
- [x] 5.2 `docs/docs/setup.md`: correct the minimum Node version to match `engines.node` in the root `package.json`, remove the claim that it is enforced at backend boot, and reframe the ALB upgrade warning as historical or delete it
- [x] 5.3 `docs/docs/architecture.md`: remove both ALB references, correct the Lambda count, and confirm the embedded diagram references still resolve after the re-render
- [x] 5.4 `docs/docs/components/index.md`: correct the Lambda count and add a link to `components/integration-tests.md`
- [x] 5.5 `docs/docs/components/lambdas.md`: correct the count to five and add a section for `@hyveon/lambda-efs-seeder` covering what it does and when it runs
- [x] 5.6 `docs/docs/components/terraform.md`: correct the module input count to seventeen, add `aws/audit_store.tf` and `aws/discord-domain.tf` to the file table, correct the Lambda function and execution-role counts, and list the audit and runs tables alongside the Discord table in the state summary
- [x] 5.7 `docs/docs/components/management-app.md`: add `ConfigModule` and `CloudProviderModule` to the module graph with the four injection tokens, correct the `ConfigService` state-resolution order to `TF_STATE_PATH` → packaged resources path → repo-relative dev fallback, expand the environment-variable table with the live seams, correct the terraform channel list, and replace the six-panel dashboard description with the multi-route surface
- [x] 5.8 `docs/docs/components/integration-tests.md`: add front matter with a title and sidebar position to match its sibling pages
- [x] 5.9 `docs/docs/guides/maintainer.md`: delete the `alb.tf` entry from the `terraform/aws/` layout, remove the ALB exception from Invariant 3, add `audit_store.tf` and `runs_store.tf`, correct the repo map and workspaces root, list all seven CI workflows, add the eight missing root npm scripts, correct the Lambda count, correct the `app:dev` delegation description, note the `CLOUD_PROVIDER`/`SECRETS_STORE` token requirement for new cloud calls, and mention the wizard in the everyday loop
- [x] 5.10 `docs/docs/guides/maintainer.md`: add a section documenting how to refresh the documentation screenshots — the build prerequisite, the command, the Linux display requirement, and when a refresh is expected
- [x] 5.11 `docs/docs/guides/user.md`: remove the ALB references, correct the false claim that the watchdog cleans up DNS, reduce the page to Discord slash commands and player-facing behaviour, and link into `docs/docs/app/` for everything about the desktop app
- [x] 5.12 `docs/docs/guides/submodule.md`: resolve the three-files-versus-four-files inconsistency and reword the `setup.sh` references so they do not read as live repository artifacts
- [x] 5.13 Add documentation for the remaining undocumented subsystems in the most appropriate existing component page: the cloud-provider abstraction and `@hyveon/cloud-aws`, the `@hyveon/desktop-preload` package and the `HYVEON_TEST_MODE` seam, `ElectronStoreService` and `SafeStorageService`, `TfvarsModule`, and drift detection
- [x] 5.14 `docs/docusaurus.config.ts`: configure the favicon and navbar logo from the existing `build/` icon assets, and add the new app section to the navbar
- [x] 5.15 Delete `docs/screenshots/issue-70/` and confirm nothing references it

## 7. Fix streamed IPC across the context bridge

Discovered while building the screenshot harness: the preload exposed `async function*` directly
via `contextBridge`, so every streaming channel threw `An object could not be cloned` synchronously
before any IPC was sent. Live log tailing, live Terraform output, and the wizard's `terraform init`
step were all non-functional in the shipped app.

- [x] 7.1 Confirm the bug empirically against a real build with no test mode and no mocks, and
  record the failing output
- [x] 7.2 Keep the `async function*` implementations preload-internal and expose a bridge-safe
  `HyveonStreamHandle<T>` (`{ next, cancel, [Symbol.asyncIterator] }`) whose `next()` return type
  mirrors the real `AsyncIterator` discriminated union so `for await` narrows correctly
- [x] 7.3 Stop passing `AbortSignal` across the bridge — it arrives with its prototype stripped, so
  `addEventListener` throws. Mint the `AbortController` inside the preload and expose `cancel()`
- [x] 7.4 Update the renderer call sites (`logs.page.tsx`, `terraform.page.tsx`,
  `terraform-init-step.component.tsx`, `terraform-run-detail.page.tsx`) to the handle shape and
  cancel on effect cleanup
- [x] 7.5 Replace the bare `catch {}` in the terraform run-log hook that silently swallowed the
  stream failure; surface stream errors in an error banner
- [x] 7.6 Export the bridge types that web code already imported but that were never exported
  (`TerraformInitConfig`, `AwsProfileSummary`, `IamCheckResult`)
- [x] 7.7 Update the preload unit tests for the new shape and fix the pre-existing `tsc -b` failure
  in `preload.test.ts`
- [x] 7.8 Add `app/packages/web/src/test-utils/stream-handle.test-utils.ts` so component tests can
  back streaming channels with a handle-shaped mock, and update the affected component tests
- [x] 7.9 Add an Electron-project regression spec that drives all three streaming channels through
  the real, unmocked preload bridge and asserts chunks arrive, and register it in `ELECTRON_SPECS`
- [x] 7.10 Re-run the empirical repro and confirm all three channels now return a working handle
- [x] 7.11 Correct the screenshot harness comments that asserted streaming could never be captured,
  and reseed the streaming mocks with plain-object async iterables
- [x] 7.12 Re-capture `logs.png`, `terraform-awaiting-approval.png`, and `wizard-terraform-init.png`
  now that they can show working behaviour, and add `terraform-apply.png`
- [x] 7.13 Embed `terraform-apply.png` in `docs/docs/app/terraform.md`

## 8. Defects surfaced while writing the documentation

Each of these was found because writing an honest description of a screen forced a read of the code
behind it.

- [x] 8.1 Fix Discord command registration reporting success on failure — `DiscordCommandRegistrar`
  resolves `{ success: false, message }` rather than throwing, and the page's mutation wrapper only
  reacted to thrown errors, so a rejected registration still fired the success toast and flipped the
  guild badge to `registered`
- [x] 8.2 Surface the real Discord error message on failure, scoped to the failing guild, and leave
  the badge unregistered; keep bulk registration sequential and continuing past a failure
- [x] 8.3 Add tests for the rejected, successful, transport-rejection, and partial-bulk-failure paths
- [x] 8.4 Correct the `costs.actual` doc comment, which claimed the query is grouped by the
  `Project` cost-allocation tag; it filters on the `SERVICE` dimension and returns account-wide
  ECS + Fargate spend
- [x] 8.5 Fix the audit action badge map — `AuditAction` has eight members but the map covered
  three, so `plan`/`approve`/`apply`/`destroy`/`rollback` rows rendered with an undefined variant.
  Root cause was a drifted hand-mirrored copy of the union in `api.service.ts`
- [x] 8.6 Add a regression test asserting each `AuditAction` renders its distinct badge, and update
  `docs/docs/app/audit.md` to describe all eight colours
- [x] 8.7 Add a real typecheck for `@hyveon/web`, which was never type-checked by anything
  (`build` is `vite build`, which strips types without checking them), via a dedicated
  `tsconfig.typecheck.json` that also covers the Playwright configs and e2e specs
- [x] 8.8 Extend the typecheck to the five Lambda packages, also previously unchecked (esbuild
  bundles without type-checking), and wire `app:typecheck` into `.github/workflows/lint.yml`
- [x] 8.9 Fix everything the new typecheck surfaced: three broken `@/api.js` imports left over from
  the `api.ts` → `api.service.ts` rename, a missing `ActionResult` re-export, a games-list typing
  bug in `electron-launch.ts`, and the missing `vite/client` and jest-dom matcher type references

## 6. Verification

- [x] 6.1 Set `onBrokenLinks: 'throw'` in `docs/docusaurus.config.ts`
- [x] 6.2 Run `npm ci` and `npm run build` in `docs/` and fix every link the build rejects until it passes
- [x] 6.3 Grep the whole `docs/` tree for `alb`, `ACM`, `target group`, `bearer`, `api_token`, `docker`, `setup.sh`, and `jekyll` and confirm every remaining hit is deliberately historical
- [x] 6.4 Cross-check every count asserted in the specs — Lambdas, module inputs, CI workflows, Node version — against the codebase one final time
- [x] 6.5 Confirm every route in `app.component.tsx` has a page under `docs/docs/app/` and every page under `docs/docs/app/` has a screenshot that exists in `docs/static/img/app/`
- [x] 6.6 Run `npm run app:test`, `npm run app:lint`, and `npm run app:test:e2e` and confirm all pass
- [x] 6.7 Run `openspec validate --change overhaul-docs-and-app-guide` and confirm it passes
