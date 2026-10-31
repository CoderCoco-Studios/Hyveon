# Sweep 9 — web e2e + package root, app root, repo root, .github, .claude

Scope: `app/packages/web/**` minus `src/`; `app/**` minus `app/packages/`; repo-root tracked files; `.github/**`; `.claude/**`. Binary images (`app/packages/web/public/*.png`) and `graphify-out/` skipped per instructions.

## (repo root)

```yaml
- path: package.json
  purpose: npm-workspaces root manifest ("hyveon" 0.9.1); defines all top-level app:/desktop:/docs: scripts and the runtime deps electron-builder ships.
  exports: scripts app:build, app:start, app:build:lambdas, app:test(+:coverage/:watch), app:lint(+:fix), app:typecheck, app:test:e2e, app:test:integration, desktop:dev/build/run/package, icons:generate, aws-regions:generate, docs:screenshots; postinstall=patch-package
  dependencies: "@pulumi/aws" 7.39.0, "@pulumi/pulumi" 3.255.0 (exact pins), class-transformer, class-validator, electron-updater; dev: claude-agent-sdk, @swc/core, electron-builder, electron-vite, patch-package, png2icons, sharp
  data_shapes: npm manifest; "main": out/main/index.js; engines node>=24
  side_effects: postinstall runs patch-package (applies patches/ dir, outside scope)
  role: config (workspace root)
  observations:
    - workspaces lists "app/packages/desktop-preload" (package.json:10) redundantly — already matched by "app/packages/*" (package.json:9).
    - allowScripts pins "@swc/core@1.15.43" (package.json:54) while devDependency is "^1.15.46" (package.json:25) — exact-version key appears stale.
    - app:typecheck builds shared → cloud-aws → infra (package.json:38) while app/package.json "build" orders shared → infra → cloud-aws (app/package.json:7); CLAUDE.md documents the latter.
    - desktop:build chains build/verify-main-bundle-externals.mjs (package.json:46) — the bundle-externals guard referenced in electron.vite.config.ts:70-73.
    - docs:screenshots runs Playwright from repo root with app/packages/web/playwright.screenshots.config.ts (package.json:51).
    - overrides force typescript-eslint packages onto the workspace's TypeScript (package.json:56-75) — needed for TS 7 (see app/eslint.config.js:24-38).
    - @anthropic-ai/claude-agent-sdk is a root devDependency (package.json:24) — presumably for .claude/workflows or scripts; no consumer in this scope imports it directly.

- path: tsconfig.base.json
  purpose: root TS base (ES2022, ESNext modules, Bundler resolution, strict, noEmit).
  exports: none
  dependencies: extended by app/tsconfig.base.json
  data_shapes: tsconfig
  side_effects: none
  role: config
  observations: noEmit:true here is overridden to false in app/tsconfig.base.json:24.

- path: .gitignore
  purpose: ignore build outputs, node_modules, local Claude settings, worktrees, Playwright artifacts, coverage, legacy .gsd dir.
  exports: n/a
  dependencies: n/a
  data_shapes: n/a
  side_effects: none
  role: config
  observations:
    - ".gsd/" ignored as "legacy pre-rename marker dir — .gsd -> .hyveon compat window" (.gitignore:46-47) — rename residue.
    - "app/server_config.json" and "app/.iam-bootstrap-dev" ignored (.gitignore:2-3) — appear to be runtime artifacts of older/dev flows.
    - Both ".claude/worktrees/", ".worktrees/" and "worktrees/" ignored (.gitignore:23-24,54) — three worktree locations.

- path: .gitattributes
  purpose: registers a custom `graphify` merge driver for graphify-out/graph.json.
  exports: n/a
  dependencies: graphify merge driver must be configured in local git config
  data_shapes: n/a
  side_effects: none
  role: config
  observations: single line (.gitattributes:1).

- path: .mcp.json
  purpose: project MCP server config — context7 via `npx -y @upstash/context7-mcp`.
  exports: n/a
  dependencies: @upstash/context7-mcp (unpinned, fetched at runtime)
  data_shapes: mcpServers map
  side_effects: spawns npx process when Claude Code loads the project
  role: config
  observations: unpinned package version (.mcp.json:5).

- path: .coderabbit.yaml
  purpose: CodeRabbit config — inherit org config, exclude graphify-out/** from reviews.
  exports: n/a
  dependencies: n/a
  data_shapes: n/a
  side_effects: none
  role: config
  observations: none.

- path: cliff.toml
  purpose: git-cliff changelog/bump config for release workflow; groups Conventional Commit types in fixed order.
  exports: n/a
  dependencies: invoked as `npx git-cliff@2.13.1` from .github/workflows/release.yml (cliff.toml:2-3)
  data_shapes: changelog Tera template; commit_parsers; bump rules
  side_effects: none
  role: config (release automation)
  observations:
    - chore(release): commits are skipped (cliff.toml:59).
    - initial_tag "v0.1.0" works around zero-tag bump behaviour (cliff.toml:72-76).
    - features always bump minor, breaking bumps major (cliff.toml:70-71).

- path: electron.vite.config.ts
  purpose: electron-vite build config for main (SWC, ESM), preload (CJS), and renderer (React + Tailwind, rooted at app/packages/web).
  exports: default defineConfig
  dependencies: electron-vite (defineConfig, swcPlugin), @vitejs/plugin-react, @tailwindcss/vite; entries app/packages/desktop-main/src/electron-entry.ts, app/packages/desktop-preload/src/preload.ts, app/packages/web/index.html
  data_shapes: main → out/main/index.js (es); preload → preload.cjs (cjs); sourcemaps all three
  side_effects: none (build config)
  role: config (build)
  observations:
    - swcPlugin() on main only, because esbuild doesn't emit emitDecoratorMetadata needed by Nest DI (electron.vite.config.ts:19-30).
    - @grpc/proto-loader must remain a desktop-main dependency because @nestjs/microservices statically imports it (electron.vite.config.ts:11-17).
    - external: regex-matched @pulumi/pulumi and @pulumi/aws (incl. subpaths), semver, class-validator, class-transformer, electron-updater (electron.vite.config.ts:104-111). A previous exact-string external let `@pulumi/pulumi/automation` bundle into a 15 MB chunk (:47-52).
    - semver externalized to avoid dual-class instanceof failure in PulumiCommand.install() (:75-86).
    - electron-updater is in the external list (:110) with no inline rationale in this file (its rationale lives in electron-builder.yml:48-61).
    - preload pinned to CJS because sandboxed preload only supports CommonJS and root package.json is "type":"module" (:129-137).

- path: electron-builder.yml
  purpose: electron-builder packaging config (appId dev.hyveon.desktop): asar, files whitelist of the externalized-package runtime closure, extraResources (icon, six lambda dists, IAM bootstrap CFN template), per-OS targets.
  exports: n/a
  dependencies: out/**, node_modules closure, app/packages/lambda/*/dist, app/packages/desktop-main/resources/cloudformation/iam-bootstrap.yaml, build/icon.*
  data_shapes: YAML config
  side_effects: none (consumed by electron-builder)
  role: config (packaging)
  observations:
    - publish provider github CoderCoco-Studios/Hyveon only embeds app-update.yml; actual publishing is release.yml (electron-builder.yml:10-18).
    - Hand-maintained ~150-entry node_modules closure for @pulumi/* etc. that "will not be picked up automatically" when pins change (electron-builder.yml:45-47, 62-216) — manual sync hazard.
    - Comment states class-validator/class-transformer/electron-updater must also be in root package.json dependencies (electron-builder.yml:48-61) — matches package.json:19-21 and is guarded by app/test/packaging-manifest-pins.test.ts.
    - extraResources lambda list "must stay in sync with the six @hyveon/lambda-* packages" (electron-builder.yml:224-237) — consumed by PulumiService.getLambdaBundlesDir().
    - Comment "A later group's GuidedIamService calls it" (electron-builder.yml:239-240) — task/group-history narrative in a comment.
    - mac builds both dmg and zip; zip is required for MacUpdater (electron-builder.yml:253-263). hardenedRuntime:false (:255), no signing config.
    - npmRebuild:false (:4).

- path: README.md
  purpose: Project overview, docs-site links, quick start (`npm run desktop:run`), sample deployment-config.json, cost ballpark, repo tree, teardown.
  exports: n/a
  dependencies: links to codercoco-studios.github.io/Hyveon
  data_shapes: example DeploymentConfig JSON with ports incl. {container:8, protocol:"icmp"} (README.md:79-103)
  side_effects: none
  role: docs
  observations:
    - Lambdas link lists only "interactions, followup, update-dns, watchdog" (README.md:50) — omits efs-seeder and health-check.
    - Repo tree lists efs-seeder but not health-check (README.md:123-128).
    - Describes management app as "Nest.js API" (README.md:49) — stale vs desktop-only IPC invariant.
    - Example uses snake_case `container_path` in volumes (README.md:98).
    - Discord secrets use zero-day recovery window (README.md:142-143).

- path: CLAUDE.md
  purpose: Workflow rules and invariants for Claude: where-to-look table, commands, invariants, markdown rules, pre-PR gate, git/PR workflow, review workflow, graphify usage.
  exports: n/a
  dependencies: references docs/docs/**, openspec/**, .claude/rules/*, .claude/commands/pr.md
  data_shapes: n/a
  side_effects: none
  role: docs (agent instructions)
  observations:
    - Says "six Lambda packages (four always-on, two conditional)" (CLAUDE.md routing table) — consistent with electron-builder extraResources.
    - Build-order description "shared → infra → cloud-aws → desktop-main → desktop-preload → web" matches app/package.json:7 but not root app:typecheck order (package.json:38).
    - Invariants listed (no ECS Service, DNS Lambda-managed, Caddy sidecar TLS, watchdog in task tags, AWS_REGION_, per-guild Discord commands, single canRun(), no secrets to renderer, no HTTP transport, shared barrel AWS-SDK-free).

- path: CONTRIBUTING.md
  purpose: Contributor rules: Conventional Commit PR titles, local checks, what CI checks, pointer to CLAUDE.md conventions, review policy.
  exports: n/a
  dependencies: .github/workflows/lint.yml, test.yml
  data_shapes: n/a
  side_effects: none
  role: docs
  observations:
    - References a "scripts workspace" excluded from lint/test (CONTRIBUTING.md:54,56,74-75) — no app/packages/scripts or scripts workspace exists in package.json workspaces; stale.
    - Links `CLAUDE.md#code--test-conventions` (CONTRIBUTING.md:87) — CLAUDE.md has no such heading (conventions moved to .claude/rules/typescript-conventions.md / testing-conventions.md).
    - Example `feat(server): add /api/games endpoint` (CONTRIBUTING.md:26) reflects the retired HTTP server.
    - Says CodeQL runs via GitHub default setup, not a checked-in workflow (CONTRIBUTING.md:76-77).

- path: LICENSE
  purpose: MIT license, copyright 2026 CoderCoco.
  exports: n/a
  dependencies: n/a
  data_shapes: n/a
  side_effects: none
  role: docs (legal)
  observations: none.

- path: package-lock.json
  purpose: npm lockfile for the whole workspaces tree (~20.9k lines).
  exports: n/a
  dependencies: all workspaces
  data_shapes: lockfileVersion 3 package map
  side_effects: none
  role: config (lockfile)
  observations: skimmed only (header, workspace entries, targeted package lookups); not read line-by-line given size (~1417 node_modules entries). Locks @swc/core 1.15.46 (package-lock.json:6745) — root allowScripts names 1.15.43 (package.json:54). Locks @tailwindcss/oxide 4.3.3 (package-lock.json:7054) — CI reinstalls 4.3.0 (.github/actions/build-package/action.yml:18).
```

## app (root files)

```yaml
- path: app/package.json
  purpose: "@hyveon/app" workspace — hosts the cross-workspace build/test/lint scripts and shared dev tooling (eslint, vitest, typescript 7).
  exports: scripts build, build:lambdas, start (electron ../out/main/index.js), test, test:coverage, test:watch, lint, lint:fix
  dependencies: dev: @eslint/js, @types/node, @vitest/coverage-v8, aws-sdk-client-mock, concurrently, esbuild, eslint + jsdoc/react/react-hooks/tsdoc plugins, globals, typescript ^7.0.2, typescript-eslint, vitest ^4
  data_shapes: npm manifest
  side_effects: none
  role: config (workspace)
  observations:
    - build order shared → infra → cloud-aws → desktop-main → desktop-preload → web (app/package.json:7).
    - build:lambdas builds shared then six lambda workspaces (app/package.json:8).
    - `concurrently` devDependency (app/package.json:21) not referenced by any script in this manifest.

- path: app/eslint.config.js
  purpose: ESLint flat config for app/**: js+typescript-eslint recommended (syntactic only), jsdoc require-jsdoc on public symbols, tsdoc/syntax error, React rules for web src, and an @aws-sdk import ban outside cloud-aws/lambda with an exceptions list.
  exports: default tseslint.config(...)
  dependencies: @eslint/js, typescript-eslint, eslint-plugin-react, eslint-plugin-react-hooks, eslint-plugin-jsdoc, eslint-plugin-tsdoc, globals
  data_shapes: flat config array
  side_effects: none
  role: config (lint)
  observations:
    - Deliberately `recommended` not `recommendedTypeChecked` because TS 7 is outside typescript-eslint's peer range (app/eslint.config.js:22-39).
    - ignores packages/web/vite.config.ts (:16) but not the playwright configs.
    - React presets skip packages/web/e2e/** (:77,91,96,102).
    - @aws-sdk ban exceptions list of "legacy call sites" with "Do not add new entries" (:122-124) yet the list has since grown (SchedulerService, BootstrapService, IamCheckService, GuidedIamService, awsCredentialSource, AwsProfileService, CloudHealthService, PulumiWorkspaceService, web e2e guided-iam.spec.ts) (:125-191).
    - Comments reference epic/group numbers ("epic #139", "add-one-click-aws-bootstrap Group 3/6") (:146,168,175) — history narrative in comments.
    - The ban message points to `@hyveon/shared/cloud.js` interfaces (:197).

- path: app/tsconfig.base.json
  purpose: Base TS config for all app workspaces: types ["node"], decorators + emitDecoratorMetadata, composite/declaration/sourceMap, emit enabled.
  exports: n/a
  dependencies: extends ../tsconfig.base.json
  data_shapes: tsconfig
  side_effects: none
  role: config
  observations: Explicit types:["node"] required because TS 7 stopped auto-discovering ancestor @types across workspaces (app/tsconfig.base.json:4-12).

- path: app/tsconfig.json
  purpose: Solution-style project references for app workspaces.
  exports: n/a
  dependencies: packages shared, cloud-aws, infra, desktop-main, desktop-preload, web, lambda/{interactions,followup,update-dns,watchdog}
  data_shapes: references array
  side_effects: none
  role: config
  observations: Omits lambda/efs-seeder and lambda/health-check (app/tsconfig.json:10-13) — the two conditional lambdas are not in the reference graph.

- path: app/vitest.config.ts
  purpose: Vitest 4 config: source aliases for @hyveon/* and `@`, forks pool capped at 4 workers, two projects (node / web-jsdom), v8 coverage at 80% thresholds.
  exports: default defineConfig
  dependencies: vitest/config; aliases to packages/shared/src (folderUpload, gameServerValidator, envTokens, secrets/secretsStore, index), cloud-aws, infra, desktop-preload, web/src
  data_shapes: config
  side_effects: writes ./coverage (text, lcov, cobertura)
  role: config (test)
  observations:
    - maxWorkers 4 to avoid OOM on high-core boxes (app/vitest.config.ts:34-46).
    - Subpath aliases must precede bare '@hyveon/shared' (:14-22).
    - node project includes test/**/*.test.* for app/test (:63-64); web project = packages/web/**/*.test.* under jsdom (:72-80).
    - Coverage excludes main.ts, test-main.ts, app.module.ts, modules/**, test-mocks/**, shared types.ts, generated/** (:97-114).
    - Comment says lcov "available for future Codecov integration" (:116).

- path: app/vitest.setup.ts
  purpose: Registers jest-dom matchers and RTL cleanup afterEach (needed because globals:false).
  exports: none
  dependencies: vitest, @testing-library/react, @testing-library/jest-dom/vitest
  data_shapes: none
  side_effects: DOM cleanup after each test
  role: test setup
  observations: Runs for node project too; comment says it's a no-op there (app/vitest.setup.ts:6-8).
```

## app/test

```yaml
- path: app/test/packaging-manifest-pins.test.ts
  purpose: Guards that root package.json runtime deps are pinned identically in desktop-main (all) and infra (@pulumi/*), that root has ≥1 dependency, and that PULUMI_ENGINE_VERSION equals the root @pulumi/pulumi pin.
  exports: none (test)
  dependencies: @hyveon/shared PULUMI_ENGINE_VERSION; reads package.json, app/packages/desktop-main/package.json, app/packages/infra/package.json
  data_shapes: Manifest {dependencies?}; drift entries {package, root, dependent}
  side_effects: reads files
  role: test
  observations: Pins the electron-builder "app manifest = root" invariant (app/test/packaging-manifest-pins.test.ts:6-31); engine-version check (:92-99) ties PulumiEngineService install version to SDK pin.
```

## app/packages/web (package root)

```yaml
- path: app/packages/web/DESIGN.md
  purpose: Design-token reference for the renderer (dark "ops" palette, Outfit/DM Mono fonts, radii, shadcn primitives, button variants).
  exports: n/a
  dependencies: refers to src/index.css @theme tokens, src/components/ui/*
  data_shapes: token tables
  side_effects: none
  role: docs
  observations: Lists 13 shadcn primitives (DESIGN.md:81-95) and custom button variants `start`/`stop` (DESIGN.md:110-111); not cross-checked against src (out of scope).

- path: app/packages/web/components.json
  purpose: shadcn/ui CLI config (tsx, no RSC, Tailwind CSS at src/index.css, slate base, aliases).
  exports: n/a
  dependencies: shadcn CLI
  data_shapes: JSON
  side_effects: none
  role: config
  observations: utils alias is "@/lib/utils.utils" (components.json:15) — follows the repo's `<name>.<kind>.ts` suffix convention rather than shadcn's default "@/lib/utils".

- path: app/packages/web/index.html
  purpose: Renderer HTML shell: favicons, Google Fonts (DM Mono, Outfit), #root, loads /src/main.tsx.
  exports: n/a
  dependencies: public/favicon.svg, favicon-32.png, apple-touch-icon.png; fonts.googleapis.com
  data_shapes: HTML
  side_effects: network fetch of Google Fonts at runtime (index.html:11-13)
  role: config (entry HTML)
  observations: Packaged desktop app loads fonts from the network (index.html:13) — no offline fallback in this file.

- path: app/packages/web/package.json
  purpose: "@hyveon/web" manifest — React 19 + Vite 7 + Tailwind 4 + Radix renderer; Playwright e2e/integration scripts.
  exports: scripts dev, typecheck, build (typecheck && vite build), preview, test:e2e (runs root desktop:build then playwright), test:integration, typecheck:full
  dependencies: @hyveon/shared, radix-ui, cva, clsx, lucide-react, react/react-dom 19, react-router-dom 7, rxjs, sonner, tailwind-merge, tailwindcss, tw-animate-css; dev: @aws-sdk/client-iam/sts (for integration spec), @hyveon/desktop-main, @hyveon/desktop-preload, @nestjs/testing, @playwright/test, testing-library, jsdom, unzipper, vite
  data_shapes: npm manifest
  side_effects: none
  role: config (workspace)
  observations:
    - test:e2e shells to `npm run desktop:build --prefix ../../../` (package.json:11) — web package depends on repo-root scripts.
    - @hyveon/desktop-main is a devDependency (package.json:40) so integration specs can import its dist.
    - unzipper/@types/unzipper dev deps (package.json:50,54) — used by diagnostics-export integration spec.

- path: app/packages/web/playwright.config.ts
  purpose: Tier-1 e2e Playwright config: `chromium` project (vite preview at :4173) and `electron` project (explicit ELECTRON_SPECS list); exports repoRoot/electronMain/electronEnv for fixtures.
  exports: repoRoot, electronMain (out/main/index.js), electronEnv (env + HYVEON_TEST_MODE=1, minus ELECTRON_RENDERER_URL), default config
  dependencies: @playwright/test
  data_shapes: config
  side_effects: webServer runs `npm run build && npm run preview` unless PLAYWRIGHT_PROJECT=electron
  role: config (test)
  observations:
    - ELECTRON_SPECS is a hand-maintained list of 11 spec globs (playwright.config.ts:40-52); anything not listed runs under chromium.
    - ELECTRON_RENDERER_URL stripped so main uses loadFile() (:11-19).
    - CI: retries 2, workers 1, video off because ffmpeg hangs on install (:57-66); chromium uses system Chrome channel in CI (:75-76).
    - Comment says chromium specs stub "/api/*" via page.route() (:34-38) — HTTP-shaped stubs persist in the test tier only.

- path: app/packages/web/playwright.integration.config.ts
  purpose: Tier-2 integration config: testDir e2e/integration-specs, serial (workers 1), no browser/webServer.
  exports: default config
  dependencies: @playwright/test
  data_shapes: config
  side_effects: none
  role: config (test)
  observations: Serial to prevent MockStore races (:5-7).

- path: app/packages/web/playwright.screenshots.config.ts
  purpose: Docs-screenshot harness config: testDir e2e/screenshots, 1 worker, 120s timeout.
  exports: default config
  dependencies: @playwright/test
  data_shapes: config
  side_effects: none (spec writes docs/static/img/app/*.png)
  role: config (docs tooling)
  observations: Outputs fixed paths, hence serial (:17-21).

- path: app/packages/web/tsconfig.json
  purpose: Renderer typecheck config (DOM libs, react-jsx, noEmit) with source `paths` for @/, @hyveon/desktop-preload, @hyveon/shared subpaths.
  exports: n/a
  dependencies: extends ../../tsconfig.base.json (app/tsconfig.base.json)
  data_shapes: tsconfig
  side_effects: none
  role: config
  observations:
    - No rootDir/outDir deliberately (tsconfig.json:4-7).
    - paths covers shared/folderUpload, gameServerValidator, secrets/secretsStore and bare shared (:35-38) but NOT `@hyveon/shared/envTokens`, which vite.config.ts:28-31 and app/vitest.config.ts:20 both alias — three alias lists maintained by hand and already diverged.
    - Comment says "Mirrors the source aliases vitest.config.ts already uses" (:23-24) — a "mirrors X" comment (duplication rule).

- path: app/packages/web/tsconfig.typecheck.json
  purpose: Wider typecheck program including configs and e2e/** (typecheck:full); requires sibling packages built because e2e fixtures deep-import @hyveon/desktop-main/dist.
  exports: n/a
  dependencies: extends ./tsconfig.json
  data_shapes: tsconfig
  side_effects: none
  role: config
  observations: Split exists because chromium webServer runs `npm run build` from clean checkout (tsconfig.typecheck.json:8-14).

- path: app/packages/web/vite.config.ts
  purpose: Standalone Vite config for the renderer (used by `vite build`/`preview` in the chromium e2e tier): aliases, dev proxy, manual vendor chunks.
  exports: default defineConfig
  dependencies: vite, @vitejs/plugin-react, @tailwindcss/vite
  data_shapes: config
  side_effects: dev server on :5173
  role: config (build)
  observations:
    - Dev server proxies `/api` → http://localhost:3001 (vite.config.ts:49-56) — residue of the retired HTTP API server (desktop app has no HTTP transport).
    - Alias list duplicated with tsconfig.json paths and app/vitest.config.ts (vite.config.ts:9-47); also with electron.vite.config.ts renderer which only aliases `@` (electron.vite.config.ts:145-149).
    - chunkSizeWarningLimit 600 (:66); manualChunks react + radix-ui (:69-81).
    - Ignored by eslint (app/eslint.config.js:16).

- path: app/packages/web/public/favicon.svg
  purpose: Small-size app icon SVG (single hex wall + core), generated companion of build/icon-small.svg.
  exports: n/a
  dependencies: regenerated by `npm run icons:generate`
  data_shapes: SVG
  side_effects: none
  role: asset
  observations: Header kept short because libvips sniffs first 1000 bytes (favicon.svg:2-3).
```

## app/packages/web/e2e/fixtures

```yaml
- path: app/packages/web/e2e/fixtures/electron-launch.ts
  purpose: Electron-tier helpers — launchElectron() launches out/main/index.js with HYVEON_TEST_MODE=1; applyHyveonMocks() seeds window.hyveon.__test.mock() for the dashboard's startup channels.
  exports: ElectronHandle, launchElectron(), applyHyveonMocks(win, opts)
  dependencies: @playwright/test _electron; ../../playwright.config.js (electronMain, electronEnv); ./game-data.js; StubOptions from ./index.js
  data_shapes: StubOptions; mocks env.get, games.status, games.list ({games: string[]}), costs.estimate, games.start/stop (ActionResult), discord.getConfig
  side_effects: launches Electron process; mutates renderer mock registry
  role: test fixture
  observations:
    - Must be called before navigation because preload consults mock registry per invoke() (electron-launch.ts:68-70).
    - Default start/stop messages mirror EcsService wording ("is starting. It may take 2–5 minutes.") (electron-launch.ts:117-127), while chromium-tier stubApis defaults to 'Started'/'Stopped' (index.ts:131,184) — the two tiers' defaults diverge despite "mirrors stubApis" claim (electron-launch.ts:66-67).
    - games.list mocked as `{ games: string[] }` (electron-launch.ts:115) whereas chromium `/api/games` returns GameListEntry objects (index.ts:158-163).

- path: app/packages/web/e2e/fixtures/electron-mock.ts
  purpose: seedDiscordMocks() registers canned responses for every discord.* IPC channel; clearElectronMocks() clears the registry.
  exports: seedDiscordMocks(win, config), clearElectronMocks(win)
  dependencies: DiscordConfigRedacted from @/api.service.js
  data_shapes: discord.getConfig/putConfig/listGuilds({guilds, baseGuilds})/addGuild/removeGuild/registerCommands/getAdmins/putAdmins/getPermissions/putPermission/deletePermission
  side_effects: mutates window.hyveon.__test registry
  role: test fixture
  observations: Mutations return seed data unchanged so optimistic UI doesn't visually change (electron-mock.ts:60-61).

- path: app/packages/web/e2e/fixtures/game-data.ts
  purpose: Shared fixture constants for both tiers (env, game statuses, cost estimates, Discord configs, snowflakes, sample log lines).
  exports: ENV_DATA, STOPPED_GAME, RUNNING_GAME, MULTI_GAME_STATUSES, ERROR_GAME, COST_DATA, MULTI_GAME_COST_DATA, VALID_GUILD_ID(_2), VALID_USER_ID, FIRST_RUN_DISCORD_CONFIG, CONFIGURED_DISCORD_CONFIG, SAMPLE_LOG_LINES
  dependencies: types from @/api.service.js
  data_shapes: GameStatus, CostEstimates, EnvInfo, DiscordConfigRedacted (botTokenSet/publicKeySet booleans)
  side_effects: none
  role: test fixture (data)
  observations: Doc comments still name HTTP endpoints ("Stub response for `GET /api/env`") (game-data.ts:8,44).

- path: app/packages/web/e2e/fixtures/hyveon-http-bridge.ts
  purpose: Chromium-tier init script that installs a `window.hyveon` forwarding IPC-shaped calls to `/api/*` fetches (answered by page.route stubs), plus in-page fakes for IPC-only namespaces.
  exports: installHyveonHttpBridge()
  dependencies: none (self-contained; serialized by Playwright)
  data_shapes: window.hyveon {env, games, costs, files, folderUpload, discord, drift, audit, diagnostics, logs, iac.settings}; folderUpload fake emits phases starting-helper → uploading → verifying → done, or awaiting-confirmation with overwrite summary when window.__e2eFolderConflicts is set
  side_effects: fetch() to /api/*; timers emitting progress
  role: test fixture (shim)
  observations:
    - Maintains a hand-written HTTP route map that no production code serves (hyveon-http-bridge.ts:42-157) — fictional REST contract kept alive only for the chromium tier.
    - diagnostics.exportBundle/showInFolder and iac.settings.update throw synchronously (:177-182, :214-216); engineVersion/autoUpdateGet resolve to avoid mount-time TypeErrors (:217-234).
    - "Task 10.4's `iac.settings.engineVersion`" (:217) — task number in comment.
    - autoUpdateDownload returns a handle whose next() rejects so an empty generator can't look like success (:248-256).
    - Must track every new window.hyveon namespace the renderer calls on mount, or /settings etc. crash under chromium — coupling to preload surface.

- path: app/packages/web/e2e/fixtures/index.ts
  purpose: Chromium-tier entrypoint: StubOptions, stubApis(page, opts) route stubs + bridge + logs stub, extended `test` with page-object fixtures, and re-exports of Electron helpers.
  exports: test (with dashboard, costs, logs, infraLogs, settings, games, audit, layout fixtures), stubApis, StubOptions, expect, _electron, Page, ElectronApplication, launchElectron, applyHyveonMocks, ElectronHandle, seedDiscordMocks, clearElectronMocks, fixture constants, page objects, api types
  dependencies: @playwright/test, ./game-data, ../pages/index, ./hyveon-http-bridge, ./electron-launch, ./electron-mock
  data_shapes: StubOptions {statuses, costs, env, startResult, discord, games, drift, logLines, lambdaLogLines, audit}; LogEventLine {message, timestamp, eventId}
  side_effects: page.route intercepts; addInitScript
  role: test fixture
  observations:
    - Catch-all `**/api/**` 404 registered first because Playwright matches routes last-registered-first (index.ts:121-126,144-146).
    - Logs stub returns a HyveonStreamHandle-shaped object (next/cancel/asyncIterator), not a bare async generator, because useLogTail calls cancel() and a TypeError would be swallowed by ErrorBoundary (index.ts:224-234).
    - Default games list wrapped as {declared:true, deployed:true} (index.ts:158-163).
    - DiscordPage and GuidedIamWizardPage re-exported (index.ts:46) but no fixture provided for them.

- path: app/packages/web/e2e/fixtures/ipc-harness.ts
  purpose: Tier-2 in-process harness — compiles real AppModule via @nestjs/testing with PulumiService overridden by PulumiServiceStub; installs ECS, run-record DynamoDB, and remote-file-store S3 mocks; dispatches controller methods directly.
  exports: IpcHarness {dispatch, get, mocks{pushListTasks, pushDescribeTasks, pushRunTask, pushStopTask, reset, pulumi}, close}, createIpcHarness()
  dependencies: reflect-metadata, @nestjs/testing; deep imports @hyveon/desktop-main/dist/{app.module, services/PulumiService, test-mocks/ecs-mock, mock-store, pulumi-mock, run-record-mock, remote-file-store-mock}
  data_shapes: HandlerArgs/HandlerResult conditional types; MockResponse
  side_effects: patches AWS SDK clients process-wide via mock installers; builds Nest context with logger disabled
  role: test harness
  observations:
    - Requires desktop-main dist built first; package has no exports map (ipc-harness.ts:4-6).
    - Doc refers to "the HTTP-tier's `/api/test/mocks/*` control surface" (ipc-harness.ts:80) — residue of retired HTTP test seam.
    - mocks.push* wrappers duplicate ServerMocks methods (ipc-harness.ts:155-159 vs server-mocks.ts:21-33).

- path: app/packages/web/e2e/fixtures/server-mocks.ts
  purpose: Integration `test` with `ipc` (fresh harness per test) and `serverMocks` (resets shared mockStore before/after each test) fixtures.
  exports: test, ServerMocks, MockResponse
  dependencies: @hyveon/desktop-main/dist/test-mocks/mock-store.js, ./ipc-harness
  data_shapes: MockResponse
  side_effects: mutates process-wide mockStore singleton
  role: test fixture
  observations: Specs request `serverMocks: _reset` purely for its reset side effect (pattern across integration specs).

- path: app/packages/web/e2e/fixtures/stack-outputs.fixture.ts
  purpose: DEFAULT_STACK_OUTPUTS — synthetic fully-deployed StackOutputs (us-east-1, minecraft+valheim, table names, secret ARNs, filebrowser role/secret).
  exports: DEFAULT_STACK_OUTPUTS
  dependencies: StackOutputs type from @hyveon/shared
  data_shapes: StackOutputs (awsRegion, ecsCluster*, subnetIds[], securityGroupId, fileManagerSecurityGroupId, efs*, domainName, gameNames, discord/audit/runs table names, secret ARNs, fileBrowserSchedulerRoleArn, interactionsInvokeUrl, discordInteractionsUrl, appliedGameServers)
  side_effects: none
  role: test fixture (data)
  observations: Doc narrates replacement of deleted tfstate.fixture.json and points to "ipc-harness.ts's doc comment" for the removed env-var mechanism (stack-outputs.fixture.ts:7-13) — that doc comment no longer describes it; history narrative.
```

## app/packages/web/e2e/integration-specs

```yaml
- path: app/packages/web/e2e/integration-specs/index.ts
  purpose: Re-export barrel for integration specs (test, MockResponse, ServerMocks, IpcHarness, DEFAULT_STACK_OUTPUTS, expect).
  exports: as listed
  dependencies: ../fixtures/*
  data_shapes: n/a
  side_effects: none
  role: test barrel
  observations: none.

- path: app/packages/web/e2e/integration-specs/tsconfig.json
  purpose: Overrides `paths` to {} so integration specs resolve @hyveon/shared via dist (same module instance desktop-main dist uses).
  exports: n/a
  dependencies: extends ../../tsconfig.json
  data_shapes: tsconfig
  side_effects: none
  role: config
  observations: Prevents dual-module instanceof failures (e.g. RunLockHeldError) (tsconfig.json:14-21).

- path: app/packages/web/e2e/integration-specs/support/iac-ctx.ts
  purpose: Fake IpcMainInvokeEvent ctx with recording sender for IacController.plan/apply/destroy, plus waitForIacMessage poller.
  exports: FakeIacSenderCall, FakeIacCtx, makeFakeIacCtx(), waitForIacMessage(fakeCtx, channel, timeoutMs=5000)
  dependencies: electron types
  data_shapes: {channel, message}[]
  side_effects: none (timers)
  role: test helper
  observations: "Ported from iac.controller.test.ts's vitest-only makeCtx()" (iac-ctx.ts:28-38) — second copy of the same fake; uses `as unknown as` cast (:57). Polls every 5ms (:89).

- path: app/packages/web/e2e/integration-specs/can-run.spec.ts
  purpose: Pins canRun() guild allowlist, admin bypass (user and role), per-game role/user grants and action restriction against config written via DiscordController.
  exports: none
  dependencies: canRun from @hyveon/shared; DiscordController dist
  data_shapes: DiscordConfig
  side_effects: none
  role: test
  observations: Admits there is no DynamoDB mock for the Discord table — getConfig() is served from DiscordConfigService in-memory cache (can-run.spec.ts:17-20); BASE#discord merge not exercised (:11-15).

- path: app/packages/web/e2e/integration-specs/config-service.spec.ts
  purpose: Pins EnvController.getEnv (region, domain, environment 'PROD' when domain non-empty) and GamesController listGames (deployed-only entries) / listStatus (stopped) from scripted stack outputs.
  exports: none
  dependencies: EnvController, GamesController dist
  data_shapes: EnvInfo, GameListEntry
  side_effects: none
  role: test
  observations: listGames+listStatus assertions duplicate start-stop.spec.ts:16-34 (config-service.spec.ts:23-43). Test title says "aws_region" (snake_case legacy) (:13).

- path: app/packages/web/e2e/integration-specs/diagnostics-export.spec.ts
  purpose: Pins DiagnosticsController.exportBundle writes a real zip with logs.txt/config-summary.json/metadata.json/aws-snapshot.json/errors.json; omits config-summary when no config bucket; cancelled dialog writes nothing.
  exports: none
  dependencies: unzipper, DiagnosticsController dist
  data_shapes: {status:'written', path} | {status:'cancelled'}
  side_effects: writes temp zip files; mutates process.env.HYVEON_CONFIG_BUCKET
  role: test
  observations: Monkey-patches protected showSaveDialog on the instance (diagnostics-export.spec.ts:35-38); HYVEON_CONFIG_BUCKET is a dev/CI override for ConfigService.getConfigurationBucket (:46-55).

- path: app/packages/web/e2e/integration-specs/discord-config.spec.ts
  purpose: Pins secret redaction — getConfig returns botTokenSet/publicKeySet booleans, never botToken/publicKey.
  exports: none
  dependencies: DiscordController dist
  data_shapes: DiscordConfigRedacted
  side_effects: none
  role: test
  observations: DDB/Secrets calls fail "gracefully" without creds and return empty config (discord-config.spec.ts:17-21).

- path: app/packages/web/e2e/integration-specs/error-propagation.spec.ts
  purpose: Pins RunTask AccessDeniedException → GamesController.start returns {success:false, message containing code}.
  exports: none
  dependencies: GamesController dist
  data_shapes: ActionResult
  side_effects: none
  role: test
  observations: Unscripted stub stack outputs → start() refuses as "not deployed yet" before RunTask (error-propagation.spec.ts:18-21).

- path: app/packages/web/e2e/integration-specs/guided-iam.spec.ts
  purpose: Pins the five wizard.guidedIam.* channels via WizardController: template render with placeholders substituted, openConsole fallback URL when not Electron, bootstrap key → accountId, raw AWS error propagation, rotate complete (Create→GetCallerIdentity→Delete bootstrap), revoke refusal without creds and manual-retry after delete-failed.
  exports: none
  dependencies: aws-sdk-client-mock, @aws-sdk/client-sts, @aws-sdk/client-iam, WizardController, SafeStorageService dist
  data_shapes: {path}, {opened,url}, {accountId}, {status:'complete'|'delete-failed'}, {revoked, message}
  side_effects: patches STS/IAM client prototypes process-wide; writes rendered template file
  role: test
  observations:
    - Is on the eslint @aws-sdk ban exception list (app/eslint.config.js:179).
    - forceKeychainAvailable overrides isAvailable/encrypt/decrypt on the DI singleton (guided-iam.spec.ts:60-64).
    - Placeholders __HYVEON_DEPLOY_ALL_POLICY_DOCUMENT__ / __HYVEON_SELF_ROTATE_POLICY_DOCUMENT__ (:78-79).
    - Comments reference "Group 6" and "Task 1's unit tests" (:10,25).

- path: app/packages/web/e2e/integration-specs/iac-apply-gates.spec.ts
  purpose: Pins IacController.apply ack-shaping for each scripted gate error (not approved, approval expired, hash mismatch, engine-version mismatch (error contains version), run not found, artifact stale, StalePlanError, RunLockHeldError → conflict 'up') and success path end message.
  exports: none
  dependencies: IacController, PulumiService error classes dist, RunLockHeldError from @hyveon/shared
  data_shapes: apply ack {started, runId?, error?, conflict?, staleLock?}; iac.apply.chunk / iac.apply.end messages
  side_effects: none
  role: test
  observations: Gate logic itself lives in real PulumiService and is not exercised (stub replaces it) (iac-apply-gates.spec.ts:33-41); "15-minute approval window" is only in the test title (:60).

- path: app/packages/web/e2e/integration-specs/iac-destroy-token.spec.ts
  purpose: Pins IacController.destroy maps DestroyNotConfirmedError to {started:false, error} with no chunks, and success path emits iac.destroy.end with result.
  exports: none
  dependencies: IacController, DestroyNotConfirmedError dist
  data_shapes: destroy ack; iac.destroy.* messages
  side_effects: none
  role: test
  observations: Five rejection tests ("already consumed", "different stack", "expired/superseded", "concurrent") all script the identical failure and differ only by token string (iac-destroy-token.spec.ts:26-119) — titles overstate coverage, as the comments admit (:41-43, :110-114).

- path: app/packages/web/e2e/integration-specs/iac-plan.spec.ts
  purpose: Pins IacController.plan streams stub preview to iac.plan.end with planHash/artifactPath/changeSummary; failure gives exitCode null, error, no result.
  exports: none
  dependencies: IacController, PulumiPreviewResult dist
  data_shapes: PulumiPreviewResult {runId, artifactPath, changeSummary, planHash, engineVersion}
  side_effects: writes temp artifact file
  role: test
  observations: Test writes the artifact itself since stub has no FS surface (iac-plan.spec.ts:23-29).

- path: app/packages/web/e2e/integration-specs/iac-run-records.spec.ts
  purpose: Pins RunRecordService.persist status success/failed, planHash presence, inline log under 350KB (no logS3Key), and IacRunsController.list limit/status filters.
  exports: none
  dependencies: IacRunsController, RunRecordService dist
  data_shapes: PersistRunRecordParams; run record {kind, status, planHash, logInline, logS3Key}
  side_effects: temp log files; mocked DynamoDB
  role: test
  observations: Calls RunRecordService directly because persist lives inside real PulumiService (iac-run-records.spec.ts:17-27).

- path: app/packages/web/e2e/integration-specs/iac-streaming-ansi.spec.ts
  purpose: Pins ANSI escape bytes preserved in iac.plan.chunk messages with stream attribution and in persisted inline run log.
  exports: none
  dependencies: IacController, IacRunsController, RunRecordService, PulumiRunChunk dist
  data_shapes: PulumiRunChunk {stream, line}
  side_effects: temp files
  role: test
  observations: ConfigService.getStackOutputs() caches first result — must script outputs before first call (iac-streaming-ansi.spec.ts:32-37). ANSI constants contain literal ESC bytes (:13-14).

- path: app/packages/web/e2e/integration-specs/pulumi-di-seam.spec.ts
  purpose: Pins that PulumiService DI token resolves to the harness stub (reference equality) and mintDestroyToken returns the scripted token.
  exports: none
  dependencies: IacController, PulumiService dist
  data_shapes: {token}
  side_effects: none
  role: test
  observations: none.

- path: app/packages/web/e2e/integration-specs/stack-outputs.spec.ts
  purpose: Pins iac.output (IacController.output) returns scripted outputs verbatim and null for never-deployed stack.
  exports: none
  dependencies: IacController dist
  data_shapes: StackOutputs | null
  side_effects: none
  role: test
  observations: none.

- path: app/packages/web/e2e/integration-specs/start-stop.spec.ts
  purpose: Pins listGames/listStatus initial stopped state and getStatus→running then stop() success with queued ListTasks/DescribeTasks pairs.
  exports: none
  dependencies: GamesController dist
  data_shapes: GameStatus, ActionResult
  side_effects: none
  role: test
  observations: stop() performs its own findRunningTask lookup, needing a second mock pair (start-stop.spec.ts:59-68).

- path: app/packages/web/e2e/integration-specs/status-polling.spec.ts
  purpose: Intends to pin that listStatus reflects state changes without caching.
  exports: none
  dependencies: GamesController dist
  data_shapes: GameStatus[]
  side_effects: none
  role: test
  observations: Does not call scriptStackOutputs, unlike every sibling spec — with the stub defaulting to null outputs the game list appears to be empty, making both `forEach` assertions vacuous (status-polling.spec.ts:17-18,32-33). Comment still references "re-hitting `/api/status`" (:9).
```

## app/packages/web/e2e/pages

```yaml
- path: app/packages/web/e2e/pages/index.ts
  purpose: Barrel for page objects; doc explains two-step `location.hash` navigation needed under HashRouter + file:// origin.
  exports: AppLayout, gotoHashRoute, DashboardPage, ServerStateLabel, CostsPage, DiscordPage, GuidedIamWizardPage, LogsPage, InfrastructureLogsPage, IacPage, IacHistoryPage, SettingsPage, GamesPage, DriftLabel, AuditPage
  dependencies: sibling page files
  data_shapes: n/a
  side_effects: none
  role: test page-object barrel
  observations: Two-step hash reset rationale (index.ts:1-15) is re-implemented inline in CostsPage.gotoElectron (CostsPage.ts:25-33) and DiscordPage.goto (DiscordPage.ts:16-25), and in several specs — no shared helper (hashRoute.ts only covers the page.goto variant).

- path: app/packages/web/e2e/pages/hashRoute.ts
  purpose: gotoHashRoute(page, path) → page.goto(`/#${path}`) for the chromium tier.
  exports: gotoHashRoute
  dependencies: @playwright/test types
  data_shapes: n/a
  side_effects: navigation
  role: test helper
  observations: Refers to `app.component.tsx`'s doc comment for HashRouter rationale (hashRoute.ts:5-6).

- path: app/packages/web/e2e/pages/AppLayout.ts
  purpose: Page object for the nav shell: brand heading, banner/title bar, Linux window-control buttons, sidebar links/navigation, logs heading, Sonner toast + Undo button.
  exports: AppLayout
  dependencies: @playwright/test
  data_shapes: n/a
  side_effects: navigation clicks
  role: test page object
  observations: Doc refers to "`AppLayout.tsx`" (AppLayout.ts:4) while the component file is app-layout.component.tsx (named correctly in IacPage.ts:20). navigateTo matches url.hash because BrowserRouter breaks under file:// on Windows (AppLayout.ts:39-47). Uses inline `import('@playwright/test').Locator` types despite importing Locator (:59,64).

- path: app/packages/web/e2e/pages/AuditPage.ts
  purpose: Page object for /audit: heading, empty state, summary rows (tr with aria-expanded button), expand toggle, detail sibling row, Load more.
  exports: AuditPage
  dependencies: ./hashRoute
  data_shapes: n/a
  side_effects: navigation
  role: test page object
  observations: detailRow uses xpath following-sibling (AuditPage.ts:55-57).

- path: app/packages/web/e2e/pages/CostsPage.ts
  purpose: Page object for /costs: heading "Cost Analysis", Cost Explorer link, table rows/cells, sort headers, filter input, no-match message; chromium goto + Electron two-step hash goto.
  exports: CostsPage
  dependencies: ./hashRoute
  data_shapes: n/a
  side_effects: navigation
  role: test page object
  observations: "TODO(#190): replace with a sidebar navigation click once the Costs link is wired into the sidebar" and "route isn't yet linked from the sidebar" (CostsPage.ts:12,22-23) — open TODO.

- path: app/packages/web/e2e/pages/DashboardPage.ts
  purpose: Page object for / : game card headings, status badges (RUNNING/STARTING/STOPPED/NOT DEPLOYED/ERROR), error message testid, empty states/CTAs, Start/Stop/confirm buttons, filter, pending-changes banner, KPI tiles.
  exports: DashboardPage, ServerStateLabel
  dependencies: @playwright/test
  data_shapes: ServerStateLabel union
  side_effects: navigation, clicks
  role: test page object
  observations: gotoElectron waits for "Refresh all" aria-busy=false because the registry's inFlight guard silently drops refreshAll() during an in-flight poll (DashboardPage.ts:38-47). Pending banner is role=status with "Configuration changed" (:134-136).

- path: app/packages/web/e2e/pages/DiscordPage.ts
  purpose: Page object for /discord: headings (Discord / Get started wizard), developer portal link, credentials tab fields + Already-set badges + show/hide secret, guilds tab (add, snowflake validation, registered badges, Register), per-game permissions (rows, Clear).
  exports: DiscordPage
  dependencies: @playwright/test
  data_shapes: n/a
  side_effects: navigation
  role: test page object
  observations: goto() is Electron-only two-step hash (DiscordPage.ts:16-25); exported but not provided as a chromium fixture (fixtures/index.ts:270-287).

- path: app/packages/web/e2e/pages/GamesPage.ts
  purpose: Page object for /games list (drift chips In sync/Pending deploy/Undeclared) and /games/:name detail (panels, web port, file seeds, connect message, folder-seed upload controls, overwrite alertdialog, progress bar, verified message).
  exports: GamesPage, DriftLabel
  dependencies: ./hashRoute
  data_shapes: DriftLabel
  side_effects: navigation
  role: test page object
  observations: HashRouter/Windows rationale duplicated verbatim with AppLayout.navigateTo (GamesPage.ts:46-51 vs AppLayout.ts:39-47). seedSummary uses testid game-folder-seed-summary (:136).

- path: app/packages/web/e2e/pages/GuidedIamWizardPage.ts
  purpose: Page object for the first-run wizard's guided-IAM step: step progress text, pick-cloud AWS radio, Next, region select, guided vs already-have-credentials, template path/copy/open console/fallback URL, key intake, rotating indicator, retry rotation, delete-failed warning/revoke link/Revoke now, error alert.
  exports: GuidedIamWizardPage
  dependencies: @playwright/test
  data_shapes: n/a
  side_effects: none
  role: test page object
  observations: Wizard renders in place of the whole app when wizard.state.get reports wizardCompleted:false (GuidedIamWizardPage.ts:6-9). References docs/superpowers/plans/bootstrap-8-e2e-coverage.md (:19) — file exists, but repo rules forbid writing to docs/superpowers/plans/ (.claude/rules/spec-driven-development.md).

- path: app/packages/web/e2e/pages/IacHistoryPage.ts
  purpose: Page object for /iac/history list (Kind/Status filters, rows, row link `#/iac/history/:runId`, Load more, empty state) and /iac/history/:runId detail.
  exports: IacHistoryPage (incl. static historyLinkOn)
  dependencies: ./hashRoute
  data_shapes: n/a
  side_effects: navigation
  role: test page object
  observations: HashRouter createHref prefixes `#` (IacHistoryPage.ts:51-59).

- path: app/packages/web/e2e/pages/IacPage.ts
  purpose: Page object for /iac: heading, Run plan, alerts, change-summary badges, partial-apply and stale-lock banners, clear-run-lock flow, approve/re-approve/approved text/expired hint, Apply, Apply complete, View dashboard, Start over.
  exports: IacPage
  dependencies: ./hashRoute
  data_shapes: n/a
  side_effects: navigation
  role: test page object
  observations: Sidebar link must be scoped to nav "Main navigation" because NoGamesCard also renders an "Infrastructure" link; mobile drawer nav is hidden (IacPage.ts:17-40). Durable run lock is acquired only by apply/destroy, never plan (:80-86).

- path: app/packages/web/e2e/pages/InfrastructureLogsPage.ts
  purpose: Page object for /logs/infrastructure: heading, function picker buttons by LambdaFunctionKey.
  exports: InfrastructureLogsPage
  dependencies: ./hashRoute
  data_shapes: n/a
  side_effects: navigation
  role: test page object
  observations: none.

- path: app/packages/web/e2e/pages/LogsPage.ts
  purpose: Page object for /logs: heading "Server Logs", Live/Paused pill, game combobox (search + option), buffer search, Autoscroll, Pause/Resume, <mark> highlights, footer line count.
  exports: LogsPage
  dependencies: ./hashRoute
  data_shapes: n/a
  side_effects: navigation
  role: test page object
  observations: footer regex `^N lines? · oldest ` (LogsPage.ts:130-132).

- path: app/packages/web/e2e/pages/SettingsPage.ts
  purpose: Page object for /settings — only the read-only Watchdog panel's pointer text.
  exports: SettingsPage
  dependencies: ./hashRoute
  data_shapes: n/a
  side_effects: navigation
  role: test page object
  observations: Very thin (one locator) (SettingsPage.ts:20-22); doc says "any other controls on the page" (:5-6).
```

## app/packages/web/e2e/specs

```yaml
- path: app/packages/web/e2e/specs/audit.spec.ts
  purpose: (chromium) Pins /audit: heading + empty state; rows show actor/action/game/versionId; expand reveals before/after JSON; no Load more without nextBefore; Load more appends page fetched with `before` cursor.
  exports: none
  dependencies: fixtures stubApis, AuditPage
  data_shapes: AuditPageResult {entries[{sk, timestamp, actor, action, game, before, after, versionId?}], nextBefore?}
  side_effects: none
  role: test (e2e)
  observations: Audit entries record `game_servers` mutations (audit.spec.ts:5-7).

- path: app/packages/web/e2e/specs/costs.spec.ts
  purpose: (electron) Pins /costs heading, Cost Explorer link href, default sort $/hour desc, Game-header sort asc, filter, no-matches message.
  exports: none
  dependencies: launchElectron, applyHyveonMocks, CostsPage
  data_shapes: CostEstimates
  side_effects: launches Electron per test
  role: test (e2e)
  observations: No `costs.actual` channel; app makes no Cost Explorer API calls (costs.spec.ts:17-18). Cost Explorer URL https://console.aws.amazon.com/cost-management/home#/cost-explorer (:50-53).

- path: app/packages/web/e2e/specs/dashboard.spec.ts
  purpose: (electron, shared app) Pins dashboard cards for stopped/running/multi/error states, empty state + CTAs, games.start invocation, Start hidden while running, error reason + enabled Start, name filter, no-match state, 4 KPI tiles + "1/2", sidebar nav to Logs/Discord/Settings, start toast, stop confirm + Undo toast.
  exports: none
  dependencies: launchElectron, applyHyveonMocks, DashboardPage, AppLayout
  data_shapes: GameStatus
  side_effects: one Electron app for the describe block
  role: test (e2e)
  observations: afterEach inlines clearMocks instead of using clearElectronMocks helper (dashboard.spec.ts:40-48 vs fixtures/electron-mock.ts:113-120); `__calledChannels` recording block duplicated twice (:94-105, :215-226) and again in iac.spec.ts:357-363.

- path: app/packages/web/e2e/specs/discord.spec.ts
  purpose: (electron, shared app) Pins /discord wizard visibility rules (no guilds → wizard even with creds), struck-through completed steps, credentials tab default, Already-set badge, token show/hide, snowflake validation, addGuild payload, duplicate guild rejection, register badge flip and failure keeps not-registered, per-game rows, Clear resets chips, getConfig rejection → not-deployed state, Credentials saved toast.
  exports: none (augments global Window with __discordAddGuildCalled/Arg/__discordRegisterCalled)
  dependencies: launchElectron, seedDiscordMocks, clearElectronMocks, DiscordPage, AppLayout
  data_shapes: DiscordConfigRedacted
  side_effects: one Electron app per file
  role: test (e2e)
  observations: seedBaseMocks (discord.spec.ts:59-84) reimplements applyHyveonMocks' base channels with different defaults. Removed "never echo secrets" test explained in comment (:171-179) — covered by integration-specs/discord-config.spec.ts. "re-key fix" for PermissionRow referenced (:398-399).

- path: app/packages/web/e2e/specs/electron-clean-quit.spec.ts
  purpose: (electron, serial) Pins app.close() < 15s, main pid + child pids reaped within 5s, no surviving `pulumi` processes — both idle and after loading @pulumi/pulumi/automation in main via createRequire.
  exports: none
  dependencies: launchElectron, repoRoot; node child_process pgrep
  data_shapes: n/a
  side_effects: spawns pgrep; launches Electron
  role: test (e2e regression)
  observations: Doc still says `@cdktf/hcl2json` and @pulumi/pulumi "are marked external" (electron-clean-quit.spec.ts:11-14) — hcl2json was removed (electron.vite.config.ts:42-44). Child/pulumi checks are no-ops on win32 (:65,86). Uses process.getBuiltinModule('module') to get require inside app.evaluate (:150-157).

- path: app/packages/web/e2e/specs/electron-ipc-roundtrip.spec.ts
  purpose: (electron, unmocked) Pins env.get resolves through real ipcMain bridge (registerIpcMainBridges), returning {region, domain, environment} strings.
  exports: none
  dependencies: launchElectron
  data_shapes: EnvInfo
  side_effects: real main-process IPC
  role: test (e2e regression)
  observations: Documents that ElectronIPCTransport.listen() never calls ipcMain.handle itself (electron-ipc-roundtrip.spec.ts:6-12).

- path: app/packages/web/e2e/specs/electron-smoke.spec.ts
  purpose: (electron) Pins BrowserWindow opens, window.hyveon exists, header has -webkit-app-region: drag, and on Linux Minimize/Maximize/Restore/Close buttons render and maximize↔restore round-trips through WindowController.
  exports: none
  dependencies: launchElectron, AppLayout
  data_shapes: window.hyveon.window.platform
  side_effects: maximizes/restores window
  role: test (e2e)
  observations: Linux-only app-drawn controls; macOS/Windows use native chrome via platformWindowChromeOptions() in electron-entry.ts (electron-smoke.spec.ts:43-50).

- path: app/packages/web/e2e/specs/games.spec.ts
  purpose: (chromium) Pins /games list (empty state, In sync/Pending deploy/Undeclared chips, "30000 (web), 25565/tcp" ports cell, em-dash ghost columns, row navigation, sidebar link) and detail (all panels incl. Web port separate from Additional ports, file seeds, connect message, back link, ghost message, not-found), plus folder-seed flow (pick, deselect, upload to verified; overwrite warning confirm/cancel; destination outside volumes disables Upload; not-deployed explanation).
  exports: none
  dependencies: stubApis, GamesPage, hyveon-http-bridge folderUpload fake
  data_shapes: GameListEntry {name, declared, deployed, config?: {image, cpu, memory, https, webPort, ports, volumes(container_path), environment, connect_message, file_seeds}}
  side_effects: none
  role: test (e2e)
  observations: Mixed snake_case (container_path, connect_message, file_seeds) and camelCase (webPort) in GameServerConfig fixture (games.spec.ts:22-28). Folder conflicts toggled via window.__e2eFolderConflicts (:202-204).

- path: app/packages/web/e2e/specs/guided-iam-wizard.spec.ts
  purpose: (electron, fresh app per test) Pins guided-IAM happy path (region select → template path → open console → key intake → rotate → credentials step "satisfied by guided provisioning") and rotation-pending resume landing directly on key intake.
  exports: none
  dependencies: GUIDED_PROFILE_NAME from @hyveon/desktop-preload, launchElectron, GuidedIamWizardPage
  data_shapes: wizard.state.get {wizardCompleted, activeCloud, aws{profile, region}, bootstrap}; wizard.progress.get {step, guidedIam?{subState, hasBootstrapKey}}
  side_effects: Electron launch per test
  role: test (e2e)
  observations: The two seed helpers are near-duplicates differing in progress.get and prepareTemplate/openConsole (guided-iam-wizard.spec.ts:81-119 vs 152-192). Comments cite "Tasks 8.2 and 8.3 of docs/superpowers/plans/bootstrap-8-e2e-coverage.md" and "Group 7's fix round" (:2-4, :247). Relies on seeding via evaluate after firstWindow but before mount effect (:17-21) — capture.spec/demo-data instead use addInitScript + reload because of exactly this race (demo-data.ts seedDemo TSDoc).

- path: app/packages/web/e2e/specs/iac.spec.ts
  purpose: (electron, shared app) Pins /iac plan → awaiting_approval Approve enabled; conflict 'up' BUSY banner text; approve → apply → "Apply complete."; expired approval (>15 min) disables Apply + Re-approve; change-summary badges from runs.get changeSummary; partialApply banner replaces generic failure; StaleLockBanner shows stack/holder/pid; run-lock clear flow (mintToken → clear with that token → manual resubmit).
  exports: none
  dependencies: launchElectron, applyHyveonMocks, IacPage; types ChangeSummary, RunLock (@hyveon/shared), IacStaleLockInfo (@hyveon/desktop-preload)
  data_shapes: IacMockOptions; iac.runs.get {found, status, record{runId, kind, startedAt, completedAt, exitCode, planHash, changeSummary, partialApply}}
  side_effects: one Electron app; navigates to Dashboard before each test to force /iac remount
  role: test (e2e)
  observations: `iac.runs.logs` mocked as a real `async function*` (iac.spec.ts:137-143) and the doc admits chunks never reach the page (:49-62); the plain-object iterable workaround used by demo-data.ts/streaming-handle-roundtrip.spec.ts is not applied here, so planLines/applyLines options are effectively dead.

- path: app/packages/web/e2e/specs/infrastructure-logs.spec.ts
  purpose: (chromium) Pins nested Logs sidebar group with "Game Logs"/"Infra Logs" links, /logs/infrastructure heading + seeded watchdog lines, switching function resets buffer.
  exports: none
  dependencies: stubApis (lambdaLogLines), InfrastructureLogsPage, AppLayout
  data_shapes: LambdaFunctionKey → lines
  side_effects: none
  role: test (e2e)
  observations: Link labels chosen to avoid collision with top-level Games/Infrastructure (infrastructure-logs.spec.ts:10-14, citing openspec/changes/add-infra-log-viewer/design.md D3).

- path: app/packages/web/e2e/specs/ipc-mock.spec.ts
  purpose: (electron) Pins window.hyveon.__test exists in test mode, a mock overrides games.status, and a second registration replaces the first.
  exports: none
  dependencies: launchElectron
  data_shapes: GameStatus
  side_effects: Electron launch per test
  role: test (e2e)
  observations: Uses `as unknown as Record<string, unknown>` casts (ipc-mock.spec.ts:21-22,41,50) while discord/guided-iam specs use the typed `window.hyveon` global — inconsistent within the suite.

- path: app/packages/web/e2e/specs/logs.spec.ts
  purpose: (electron, fresh app per test) Pins /logs Live badge + seeded lines, Pause/Resume, search highlights via <mark> without filtering, game switch resets buffer, footer "5 lines · oldest".
  exports: none
  dependencies: launchElectron, LogsPage, SAMPLE_LOG_LINES
  data_shapes: logs.get {game, lines: LogEventLine[]}
  side_effects: Electron per test
  role: test (e2e)
  observations: logs.stream mocked as bare `async function*` (logs.spec.ts:67) — the shape fixtures/index.ts:224-234 warns lacks `.cancel()` and streaming-handle-roundtrip.spec.ts:25-28 says cannot cross the bridge; the game-switch test (:122-141) still passes apparently because the preload's handle wraps it.

- path: app/packages/web/e2e/specs/pending-changes-banner.spec.ts
  purpose: (chromium) Pins PendingChangesBanner shows "1 change pending" for drift, hidden for none, View pending → #/games, dismiss hides it.
  exports: none
  dependencies: stubApis (drift)
  data_shapes: DriftReport {entries[{game, kind:'pending_create'}]}
  side_effects: none
  role: test (e2e)
  observations: Mentions "the (now-removed) Electron variant" (pending-changes-banner.spec.ts:9).

- path: app/packages/web/e2e/specs/polling.spec.ts
  purpose: (chromium) Pins "Updated … ago" indicator persists across /, /logs, /discord, /settings; sidebar Costs link reaches Cost Analysis; Refresh all triggers another status GET.
  exports: none
  dependencies: stubApis, DashboardPage, AppLayout
  data_shapes: GameStatus
  side_effects: none
  role: test (e2e)
  observations: Navigates to /costs via the sidebar "Costs" link (polling.spec.ts:45-51), contradicting CostsPage's "route isn't yet linked from the sidebar" + TODO(#190) (CostsPage.ts:12,22-23) — that TODO appears stale.

- path: app/packages/web/e2e/specs/settings.spec.ts
  purpose: (chromium) Pins Settings' read-only Watchdog panel points to General section and has no exact "Save" button.
  exports: none
  dependencies: stubApis, SettingsPage
  data_shapes: n/a
  side_effects: none
  role: test (e2e)
  observations: Only one test (settings.spec.ts:4-14).

- path: app/packages/web/e2e/specs/streaming-handle-roundtrip.spec.ts
  purpose: (electron) Pins that logs.stream, iac.stack.initialize, iac.runs.streamLogs return a HyveonStreamHandle (next/cancel/asyncIterator) that survives contextBridge cloning and yields mocked chunks; cancel() callable and non-poisoning.
  exports: none
  dependencies: launchElectron
  data_shapes: HyveonStreamHandle; chunk shapes {stream,line}, {phase,status}
  side_effects: Electron per test
  role: test (e2e regression)
  observations: Mocks must be plain-object async iterables, not `async function*` (streaming-handle-roundtrip.spec.ts:25-28); AbortSignal to __test.mock handler doesn't survive crossing (:172-175). Channel for streamLogs mock is `iac.runs.logs` (:137).
```

## app/packages/web/e2e/screenshots

```yaml
- path: app/packages/web/e2e/screenshots/capture.spec.ts
  purpose: Docs screenshot harness — launches real packaged Electron per shot at 1200×800 with frozen clock, seeds demo mocks via addInitScript + same-URL goto, navigates by location.hash, disables motion, writes PNGs to docs/static/img/app/.
  exports: none (Playwright tests named after output files: dashboard, games, games-detail, games-add-wizard, discord, logs, logs-infrastructure, costs, audit, settings, iac, iac-awaiting-approval, iac-apply, iac-history, iac-history-detail, wizard-pick-cloud, wizard-guided-iam, wizard-credentials, wizard-bootstrap, wizard-stack-init)
  dependencies: launchElectron, page objects (GamesPage, GuidedIamWizardPage, IacHistoryPage, IacPage, InfrastructureLogsPage), ./demo-data
  data_shapes: n/a
  side_effects: writes docs/static/img/app/*.png; resizes BrowserWindow via app.evaluate
  role: script (docs tooling, Playwright)
  observations:
    - Filenames are a "contract with the docs site; do not rename" (capture.spec.ts:29).
    - win.reload() throws on file:// so a same-URL goto is used (:47-49,59).
    - Sidebar clicks avoided due to GameCard link name substring collisions (:63-72).
    - Stack-init can only be reached via Next from bootstrap because resume clamps at bootstrap (:437-441).
    - Imports `test` from @playwright/test directly rather than fixtures (:20).
    - Fast-forwards frozen clock 5s to dismiss a Sonner toast (:320-326).

- path: app/packages/web/e2e/screenshots/demo-data.ts
  purpose: "Showroom" fixture set (minecraft/valheim/palworld fleet, costs, Discord config, drift, audit, log lines, lambda logs, diagnostics tail, IaC history, plan/apply chunks, stack-init events) plus seedDemo()/seedWizard() that register every IPC mock via addInitScript.
  exports: AwsProfileSummary, BootstrapResourceStatus, BootstrapResult, IamCheckStatus, IamCheckOrigin, IamCheckResult, WizardProgress, GameLogs, DEMO_NOW, DEMO_GAMES, DEMO_STATUSES, DEMO_ENV, DEMO_COST_ESTIMATES, DEMO_DISCORD_CONFIG, DEMO_DRIFT_REPORT, DEMO_AUDIT, DEMO_LOG_LINES, DEMO_LOG_STREAM_LINES, DEMO_LAMBDA_LOG_LINES, DEMO_DIAGNOSTICS_TAIL, DEMO_IAC_HISTORY, DEMO_IAC_PLAN_CHUNKS, DEMO_IAC_APPLY_CHUNKS, DEMO_STACK_INIT_EVENTS, DemoOverrides, seedDemo, seedWizard, re-exported Iac* types
  dependencies: types from @hyveon/shared, @hyveon/desktop-preload, ../../src/api.service.js
  data_shapes: channel map covering env/games/costs/discord/drift/audit/logs(+lambda)/diagnostics/iac.*/wizard.* (wizard.bootstrap.stateBucket/configurationBucket/runsTable/deploymentConfig, wizard.iam.simulate, wizard.guidedIam.prepareTemplate, iac.stack.initialize)
  side_effects: registers init scripts on the page
  role: test fixture (docs tooling)
  observations:
    - Locally re-declares AwsProfileSummary, BootstrapResult, IamCheckResult, WizardProgress, GameLogs etc. with "Mirrors X in hyveon-api.ts — keep in sync" comments (demo-data.ts:61-110) — the exact pattern .claude/rules/duplication.md calls a bug report.
    - toIterable helper duplicated inside seedDemo and seedWizard because each init script serializes independently (demo-data.ts:558, 733).
    - Section comment says values are passed "to `win.evaluate`" (demo-data.ts:483-488) while the functions use addInitScript.
    - "per the task spec" in a doc comment (demo-data.ts:186).
    - seedDemo mocks wizard.state.get {wizardCompleted:true} so the routed app renders instead of the wizard.
    - Must not be reused from e2e/specs (demo-data.ts:8-10).
```

## .github

```yaml
- path: .github/copilot-instructions.md
  purpose: Copilot review policy (default approve; only bugs/security/crash/prod-misconfig/contract/data-loss/PR-title), repo context, commit format.
  exports: n/a
  dependencies: n/a
  data_shapes: n/a
  side_effects: none
  role: docs (bot instructions)
  observations:
    - "Framework: Nest.js (on `@nestjs/platform-express`)" (copilot-instructions.md:71) and the `/api`/SPA example (:64) describe the retired HTTP server — stale vs the desktop-only IPC invariant.
    - "we just migrated off tsyringe" (:72) — time-relative history.
    - "No `as unknown as T` casts in tests" (:75) — e2e suite uses many (e.g. specs/ipc-mock.spec.ts, fixtures/electron-mock.ts).
    - "Commit Structure" section's code fence opens with the triple-backtick and `<type>(<scope>): <subject>` on the same line, making the template its info string (:91) — malformed fence.
```

## .github/actions

```yaml
- path: .github/actions/setup-app/action.yml
  purpose: Composite: setup-node@v5 Node 24 with npm cache, then `npm ci`.
  exports: composite action
  dependencies: actions/setup-node@v5
  data_shapes: n/a
  side_effects: installs dependencies (runs postinstall patch-package)
  role: CI action
  observations: none.

- path: .github/actions/build-package/action.yml
  purpose: Composite: reinstall @tailwindcss/oxide native binding, `npm run app:build`, `npm run desktop:package`, upload artifact.
  exports: inputs artifact_name, artifact_glob
  dependencies: actions/upload-artifact@v7
  data_shapes: n/a
  side_effects: builds installers into release/; uploads artifact
  role: CI action
  observations:
    - Pins `@tailwindcss/oxide@4.3.0` (build-package/action.yml:18) while @hyveon/web depends on tailwindcss ^4.3.3 (app/packages/web/package.json:34) — hard-coded native binding version can drift from the lockfile.
    - Runs app:build then desktop:package, which itself runs app:build:lambdas + desktop:build (package.json:48) — lambdas not prebuilt by app:build.

- path: .github/actions/publish-release/action.yml
  purpose: Composite: download pkg-* and release-notes artifacts, create draft GitHub Release (softprops/action-gh-release@v3), verify latest*.yml feeds and exe/dmg/zip/AppImage assets exist.
  exports: input tag
  dependencies: actions/download-artifact@v8, softprops/action-gh-release@v3, gh api
  data_shapes: release assets list
  side_effects: creates draft GitHub release
  role: CI action
  observations: Verification looks up by release id because `gh release view` can't resolve drafts (publish-release/action.yml:36); missing assets fail run leaving draft (:34-60).
```

## .github/workflows

```yaml
- path: .github/workflows/lint.yml
  purpose: CI eslint (`app:lint`) and typecheck (`app:typecheck`) on PR/push main/merge_group, skipped for markdown-only changes via dorny/paths-filter.
  exports: jobs changes, eslint, typecheck
  dependencies: setup-app action, dorny/paths-filter@v4.0.3
  data_shapes: n/a
  side_effects: none
  role: CI workflow
  observations: Comment says typecheck covers "all five Lambda packages, and scripts" (lint.yml:49-52) — there are six lambdas (package.json:38) and no scripts workspace. Typecheck checkout uses persist-credentials:false (:59-63).

- path: .github/workflows/test.yml
  purpose: CI `app:test:coverage`, uploads cobertura coverage and pushes it via actions/upload-code-coverage@v1 (non-fork only).
  exports: jobs changes, test, upload-coverage-typescript
  dependencies: setup-app, upload/download-artifact, actions/upload-code-coverage@v1
  data_shapes: app/coverage/cobertura-coverage.xml
  side_effects: uploads coverage
  role: CI workflow
  observations: `code-quality: write` permission (test.yml:57).

- path: .github/workflows/integration.yml
  purpose: CI `app:test:integration` (tier-2 Playwright in-process harness), 25 min timeout, uploads report on failure.
  exports: jobs changes, integration
  dependencies: setup-app
  data_shapes: n/a
  side_effects: none
  role: CI workflow
  observations: The `changes` paths-filter job is copy-pasted identically across lint.yml, test.yml, integration.yml, e2e.yml, package.yml (e.g. integration.yml:16-31) — 5 copies, no reusable workflow.

- path: .github/workflows/e2e.yml
  purpose: CI `app:test:e2e` under xvfb with fluxbox WM; works around Electron binary extraction race; resilient apt install of Playwright deps.
  exports: jobs changes, e2e
  dependencies: setup-app, npx playwright install-deps, xvfb, fluxbox, x11-utils
  data_shapes: n/a
  side_effects: modifies runner apt config; installs packages
  role: CI workflow
  observations:
    - Manually extracts cached electron zip because install.js's async extraction races process exit (e2e.yml:43-64).
    - fluxbox needed because bare Xvfb ignores maximize requests (smoke spec's maximize/restore) (:110-130); readiness via _NET_SUPPORTING_WM_CHECK poll (:138-147).
    - Comment says the Chromium project runs in same invocation (:110-112); test:e2e itself runs desktop:build (:66-69).

- path: .github/workflows/package.yml
  purpose: PR/merge_group packaging matrix (ubuntu AppImage, macOS dmg+zip, Windows NSIS) uploading installers + electron-updater feeds/blockmaps.
  exports: jobs changes, package
  dependencies: setup-app, build-package actions
  data_shapes: artifact names pkg-linux-AppImage, pkg-mac-dmg, pkg-win-nsis
  side_effects: uploads artifacts
  role: CI workflow
  observations: Not triggered on push to main (package.yml:3-6). Matrix duplicated verbatim in release.yml:325-354.

- path: .github/workflows/release.yml
  purpose: Manual release: mint GitHub App token, resolve changelog range, git-cliff changelog + bump, Claude-generated "what's new" summary (continue-on-error), bump root package.json, commit/tag/push as bot, then package matrix on the tag and publish draft release; replay mode (skip_bump) only rewrites existing release notes.
  exports: workflow_dispatch inputs from, to, bump (auto|major|minor|patch), skip_bump, tag; jobs release, package, publish
  dependencies: actions/create-github-app-token@v3.2.0, git-cliff@2.13.1 via npx, anthropics/claude-code-action@v1 (model claude-sonnet-5-5), cliff.toml, build-package/publish-release actions
  data_shapes: raw-changelog.md, cliff-context.json, release-notes.md
  side_effects: pushes commit and tag to main; creates/updates GitHub release
  role: CI workflow (release)
  observations:
    - Bump mode refuses unless `to` resolves to main's tip (release.yml:101-107).
    - persist-credentials:false so the AI step (Read/Write tools, repo-wide) never sees the App token; push uses request-scoped extraheader (:253-259,275,282).
    - `npm version ... --workspaces=false` bumps only the root manifest (:272) — app/package.json and workspace packages stay at 1.0.0.
    - Tolerates no-op bump reruns (:263-270) and existing tags (:278-283).
    - "Keep this matrix in sync with package.yml's" (:319-321) — a sync-comment duplication.

- path: .github/workflows/docs-build.yml
  purpose: PR check building the Docusaurus site under docs/ after installing D2 and rendering diagrams.
  exports: job build
  dependencies: actions/checkout@v4, setup-node@v4, d2 install script, docs/diagrams/render.sh
  data_shapes: n/a
  side_effects: none
  role: CI workflow
  observations: Uses checkout@v4/setup-node@v4 while other workflows use v5 (docs-build.yml:17,20); D2 installed via unpinned `curl | sh` (:28). Steps duplicated with docusaurus-gh-pages.yml:25-49.

- path: .github/workflows/docusaurus-gh-pages.yml
  purpose: On push to main touching docs/**, build Docusaurus and deploy to GitHub Pages.
  exports: jobs build, deploy
  dependencies: checkout@v4, setup-node@v4, configure-pages@v5, upload-pages-artifact@v3, deploy-pages@v5
  data_shapes: docs/build
  side_effects: deploys GitHub Pages
  role: CI workflow
  observations: Same D2/curl install as docs-build.yml (docusaurus-gh-pages.yml:35-38).
```

## .github/prompts

All 12 files are OpenSpec-generated GitHub Copilot prompt variants of `.claude/commands/opsx/*.md`. Verified via `diff`: each differs from its Claude command only by (a) frontmatter (no `name`, `allowed-tools`, `category`, `tags`) and (b) `/opsx-<x>` instead of `/opsx:<x>` command spellings.

```yaml
- path: .github/prompts/opsx-apply.prompt.md
  purpose: Copilot prompt — implement tasks from an OpenSpec change (select change, status, apply instructions, read context, loop tasks, report).
  exports: n/a
  dependencies: openspec CLI
  data_shapes: n/a
  side_effects: none (instructions)
  role: agent prompt (generated)
  observations: duplicate of .claude/commands/opsx/apply.md modulo spelling.
- path: .github/prompts/opsx-archive.prompt.md
  purpose: Copilot prompt — archive a completed change (artifact/task completion checks, delta-spec sync assessment, move to archive).
  role: agent prompt (generated)
  observations: duplicate of .claude/commands/opsx/archive.md.
- path: .github/prompts/opsx-bulk-archive.prompt.md
  purpose: Copilot prompt — archive multiple changes, detect/resolve spec conflicts, run sync inline for included deltas.
  role: agent prompt (generated)
  observations: duplicate of .claude/commands/opsx/bulk-archive.md.
- path: .github/prompts/opsx-continue.prompt.md
  purpose: Copilot prompt — create the next artifact for a change.
  role: agent prompt (generated)
  observations: duplicate.
- path: .github/prompts/opsx-explore.prompt.md
  purpose: Copilot prompt — thinking-partner explore mode; offers but never auto-captures decisions into artifacts.
  role: agent prompt (generated)
  observations: duplicate.
- path: .github/prompts/opsx-ff.prompt.md
  purpose: Copilot prompt — fast-forward create all artifacts in build order.
  role: agent prompt (generated)
  observations: duplicate.
- path: .github/prompts/opsx-new.prompt.md
  purpose: Copilot prompt — scaffold a new change, show status, stop for direction.
  role: agent prompt (generated)
  observations: Says omit `--schema` unless user asks (mirrors .claude/commands/opsx/new.md:28-40), contradicting .claude/rules/spec-driven-development.md's instruction to always pass `--schema superpowers-bridge`.
- path: .github/prompts/opsx-onboard.prompt.md
  purpose: Copilot prompt — guided OpenSpec onboarding through a real small task.
  role: agent prompt (generated)
  observations: duplicate.
- path: .github/prompts/opsx-propose.prompt.md
  purpose: Copilot prompt — create change + all artifacts in one step.
  role: agent prompt (generated)
  observations: duplicate.
- path: .github/prompts/opsx-sync.prompt.md
  purpose: Copilot prompt — merge delta specs (ADDED/MODIFIED/REMOVED/RENAMED) into main specs.
  role: agent prompt (generated)
  observations: duplicate.
- path: .github/prompts/opsx-update.prompt.md
  purpose: Copilot prompt — revise existing planning artifacts coherently; never edits code or creates new artifacts.
  role: agent prompt (generated)
  observations: duplicate.
- path: .github/prompts/opsx-verify.prompt.md
  purpose: Copilot prompt — verify implementation completeness/correctness/coherence vs change artifacts; produce report.
  role: agent prompt (generated)
  observations: duplicate.
```
(For prompt entries above, unlisted fields are: exports n/a, dependencies openspec CLI, data_shapes n/a, side_effects none.)

## .github/skills

Twelve `openspec-*/SKILL.md` files, generatedBy OpenSpec 1.7.0. Verified via `diff` against `.claude/skills/openspec-*/SKILL.md`: `bulk-archive-change` and `new-change` are byte-identical; the other ten differ only in `/opsx-x` vs `/opsx:x` spellings.

```yaml
- path: .github/skills/openspec-apply-change/SKILL.md
  purpose: Copilot skill — implement tasks from an OpenSpec change. Workflow: select change → status → apply instructions → read context → implement task loop → report.
- path: .github/skills/openspec-archive-change/SKILL.md
  purpose: Copilot skill — archive a completed change. Workflow: completion checks → delta-sync assessment → archive → summary.
- path: .github/skills/openspec-bulk-archive-change/SKILL.md
  purpose: Copilot skill — archive many changes. Workflow: select → batch validate → detect/resolve spec conflicts → confirm → archive each → summary.
- path: .github/skills/openspec-continue-change/SKILL.md
  purpose: Copilot skill — create next artifact. Workflow: select → status → create next ready artifact → show progress.
- path: .github/skills/openspec-explore/SKILL.md
  purpose: Copilot skill — explore/thinking-partner stance. Workflow: open-ended investigation; offer (never auto) capture into artifacts.
- path: .github/skills/openspec-ff-change/SKILL.md
  purpose: Copilot skill — fast-forward. Workflow: create change dir → build order → create all required artifacts → status.
- path: .github/skills/openspec-new-change/SKILL.md
  purpose: Copilot skill — new change scaffold. Workflow: pick schema (default unless asked) → create → show first artifact instructions → stop.
- path: .github/skills/openspec-onboard/SKILL.md
  purpose: Copilot skill — onboarding tutorial. Workflow: preflight → codebase scan for small task (TODOs, missing tests…) → full change cycle with narration.
- path: .github/skills/openspec-propose/SKILL.md
  purpose: Copilot skill — propose in one step. Workflow: create change → build order → all artifacts → status.
- path: .github/skills/openspec-sync-specs/SKILL.md
  purpose: Copilot skill — sync delta specs to main. Workflow: select → find deltas → apply ADDED/MODIFIED/REMOVED/RENAMED → summary.
- path: .github/skills/openspec-update-change/SKILL.md
  purpose: Copilot skill — revise planning artifacts. Workflow: select → read artifacts → reconcile → confirm/apply per artifact → point to next step (never act).
- path: .github/skills/openspec-verify-change/SKILL.md
  purpose: Copilot skill — verify implementation. Workflow: select → load artifacts → completeness/correctness/coherence checks → report.
```
(role: agent skill (generated); side_effects none; dependencies openspec CLI.)

## .claude (root files)

```yaml
- path: .claude/CLAUDE.md
  purpose: Project-scoped Claude instruction stanza registering the graphify skill and `/graphify` trigger.
  exports: n/a
  dependencies: .claude/skills/graphify/SKILL.md
  data_shapes: n/a
  side_effects: none
  role: docs (agent instructions)
  observations: Text is a near-copy of the user-global ~/.claude/CLAUDE.md graphify stanza, and root CLAUDE.md has its own "## graphify" section — graphify guidance appears in three places.

- path: .claude/settings.json
  purpose: Shared Claude Code settings — deny Edit(.env*), PreToolUse hooks (superpowers-path guard, main-checkout guard, redirect-to-pane, push-sync guard, graphify hook-guard search/read), SessionStart+Stop drift notifier, enabled plugins.
  exports: n/a
  dependencies: bun, .claude/hooks/*.ts, optional graphify CLI
  data_shapes: settings JSON
  side_effects: configures hooks that run on every tool call
  role: config (agent harness)
  observations:
    - Working tree has uncommitted changes (git status M): enabledPlugins block moved to the end and adds linked-intent-dev@jszmajda-lid and arrow-maintenance@jszmajda-lid (settings.json:92-99 vs HEAD).
    - graphify hook-guard runs on every Bash|Grep and Read|Glob call and silently no-ops if graphify is absent (settings.json:50-67).
    - Only .env edits are denied; no allow list (settings.json:2-7).
```

## .claude/agents

```yaml
- path: .claude/agents/deployment-config-field-auditor.md
  purpose: Read-only subagent that diffs DeploymentConfig/GameServerConfig and checks each added/removed field hit infra defineX(), web wizard (if operator-editable), and docs/docs/components/infra.md.
  exports: agent `deployment-config-field-auditor` (tools Bash, Read, Grep, Glob)
  dependencies: app/packages/shared/src/deploymentConfig.ts, gameServerConfig.ts; CLAUDE.md checklist
  data_shapes: punch list ✅/❌/➖
  side_effects: none
  role: agent definition
  observations: Default base origin/main...HEAD, fallback HEAD~1 (deployment-config-field-auditor.md:20).

- path: .claude/agents/discord-iam-reviewer.md
  purpose: Read-only security reviewer for the Discord trust boundary (signature verify, allowlist, canRun buckets, per-guild registration, redaction, IAM scope, AWS_REGION_, PENDING TTL ~15 min).
  exports: agent `discord-iam-reviewer`
  dependencies: app/packages/infra/src/lambdas.ts, iam.ts, lambda-interactions/followup, canRun.ts, commands.ts, docs/docs/setup.md
  data_shapes: Critical/Important/Note findings + verdict
  side_effects: none
  role: agent definition
  observations: Refers to `@hyveon/shared/canRun` (discord-iam-reviewer.md:11) — actual file is app/packages/shared/src/canRun.ts and the invariant says it's imported from the barrel. "raw values never appear in HTTP responses" (:29) — HTTP framing is stale. Hard-wrapped prose (:16-19) contrary to CLAUDE.md "No hard line wrap".

- path: .claude/agents/docs-accuracy-auditor.md
  purpose: Read-only (opus) agent verifying every factual claim in changed docs/docs/** against code/specs; returns VERDICT/WRONG/UNVERIFIABLE.
  exports: agent `docs-accuracy-auditor`
  dependencies: git diff of docs/docs/
  data_shapes: report template
  side_effects: none
  role: agent definition
  observations: Must state base ref used; empty diff → stop (docs-accuracy-auditor.md:18-24). Hard-wrapped prose throughout.

- path: .claude/agents/docs-coverage-auditor.md
  purpose: Read-only (opus) agent checking that a change updated every obliged doc page, index, CLAUDE.md routing table, OpenSpec sync, and deployment-config touchpoints.
  exports: agent `docs-coverage-auditor`
  dependencies: changed→owner page table
  data_shapes: VERDICT/MISSING/LIKELY N/A
  side_effects: none
  role: agent definition
  observations: Owner-page table (docs-coverage-auditor.md:26-36) duplicates write-docs/SKILL.md:38-48 almost verbatim — two copies to keep in sync.

- path: .claude/agents/docs-style-reviewer.md
  purpose: Read-only (sonnet) agent checking docs buildability (links, MDX hazards, frontmatter, _category_.json, fences) then advisory house style; runs `npm --prefix docs ci` + build.
  exports: agent `docs-style-reviewer`
  dependencies: docs/docusaurus.config.ts (onBrokenLinks throw)
  data_shapes: BUILD RISKS / STYLE / VERDICT
  side_effects: runs npm ci/build in docs/
  role: agent definition
  observations: Known false-signal "Cannot read properties of undefined (reading 'id')" from stale docs/node_modules (docs-style-reviewer.md:35-41), also in write-docs/SKILL.md:111-115.

- path: .claude/agents/docs-writer.md
  purpose: (sonnet) agent that drafts/edits one docs/docs/** page after verifying claims; returns change summary + sources, not prose.
  exports: agent `docs-writer` (tools incl. Edit, Write)
  dependencies: docs conventions
  data_shapes: Page / What changed / Sources verified / Unverified
  side_effects: edits docs files
  role: agent definition
  observations: Forbids hand-placing files in docs/static/img/app/ (generated by docs:screenshots) (docs-writer.md:56-57).
```

## .claude/commands

```yaml
- path: .claude/commands/pr.md
  purpose: /pr command — gather branch context, detect linked issue, derive+validate Conventional Commit title (regex, <70 chars), confirm, choose base (stack-aware), create PR via GitHub MCP, start watch-pr.ts under Monitor.
  exports: slash command /pr
  dependencies: mcp__plugin_github_github__create_pull_request, gh stack, .claude/scripts/watch-pr.ts
  data_shapes: PR title/body
  side_effects: creates GitHub PR; starts long-running watcher
  role: command definition
  observations: Watcher output is to be treated as untrusted (pr.md:41). Uses `git log main..HEAD` even for stacked branches (pr.md:6-7).

- path: .claude/commands/openspec-review-implementation.md
  purpose: Command wrapping .claude/workflows/openspec-review-implementation.js — parses level/--fix/--comment/target, resolves PR/branch/base/change dir, runs Workflow, optionally applies CONFIRMED fixes locally, drafts/posts PR comment.
  exports: slash command /openspec-review-implementation
  dependencies: gh, Workflow tool, openspec/changes/*/tasks.md
  data_shapes: Workflow args {changeDir, prNumber, headRefOid, baseRefName, effort}
  side_effects: may edit files (--fix), post PR comment (--comment)
  role: command definition
  observations: --fix says "create one from origin/<branch>" worktree (openspec-review-implementation.md:35) — conflicts with guard-redirect-to-pane.ts, which denies raw `git worktree add`. `ultra` maps to per-agent max (:32).

- path: .claude/commands/openspec-review-proposal.md
  purpose: Command wrapping .claude/workflows/openspec-review-proposal.js for proposal-only PRs; bails on any app/** or non-openspec/changes path; per change dir Workflow call; formats findings with full-SHA blob links.
  exports: slash command /openspec-review-proposal
  dependencies: gh, Workflow tool
  data_shapes: Workflow args {prNumber, headRefOid, changeDir, effort}
  side_effects: may edit openspec/changes files, post PR comment
  role: command definition
  observations: Same worktree-creation conflict as the implementation command (openspec-review-proposal.md:36). Step-1 argument-parsing paragraph is duplicated verbatim with the implementation command (both files :22-23).
```

## .claude/commands/opsx

Twelve OpenSpec-generated Claude slash commands (`/opsx:apply|archive|bulk-archive|continue|explore|ff|new|onboard|propose|sync|update|verify`). Each has frontmatter `name: "OPSX: <X>"`, `allowed-tools: Bash(openspec:*)`, `category: "Workflow"`, tags; bodies are the same workflows as the matching `.claude/skills/openspec-*/SKILL.md` and `.github/prompts/opsx-*.prompt.md` (diff-verified; only frontmatter and `/opsx:` vs `/opsx-` spelling differ from the prompts).

```yaml
- path: .claude/commands/opsx/apply.md
  purpose: /opsx:apply — implement tasks from a change (select, status, apply instructions, read context, task loop, report).
- path: .claude/commands/opsx/archive.md
  purpose: /opsx:archive — completion checks, delta-sync assessment, archive, summary.
- path: .claude/commands/opsx/bulk-archive.md
  purpose: /opsx:bulk-archive — multi-change archive with conflict detection/resolution and inline /opsx:sync for included deltas.
- path: .claude/commands/opsx/continue.md
  purpose: /opsx:continue — create next ready artifact.
- path: .claude/commands/opsx/explore.md
  purpose: /opsx:explore — thinking-partner mode; never auto-captures.
- path: .claude/commands/opsx/ff.md
  purpose: /opsx:ff — create all artifacts in build order.
- path: .claude/commands/opsx/new.md
  purpose: /opsx:new — scaffold change; default schema unless user requests one (new.md:28-40).
  observations: Contradicts .claude/rules/spec-driven-development.md ("Pass `--schema superpowers-bridge` explicitly"); openspec/config.yaml:1 sets `schema: spec-driven` as default.
- path: .claude/commands/opsx/onboard.md
  purpose: /opsx:onboard — guided tutorial cycle on a small real task.
- path: .claude/commands/opsx/propose.md
  purpose: /opsx:propose — create change + all artifacts.
- path: .claude/commands/opsx/sync.md
  purpose: /opsx:sync — merge delta specs into main specs.
- path: .claude/commands/opsx/update.md
  purpose: /opsx:update — revise existing artifacts coherently; never code.
- path: .claude/commands/opsx/verify.md
  purpose: /opsx:verify — completeness/correctness/coherence report.
```
(All: role command definition (generated); dependencies openspec CLI; side_effects via openspec CLI writes under openspec/; exports one slash command each.)

## .claude/hooks

```yaml
- path: .claude/hooks/.gitignore
  purpose: Bun-init default ignores (node_modules, out, dist, coverage, logs, .env*, caches).
  exports: n/a
  dependencies: n/a
  data_shapes: n/a
  side_effects: none
  role: config
  observations: Malformed default patterns `_.log` and `report.[0-9]_.[0-9]_...json` (.gitignore:15-16) — bun-init template artefacts (likely meant `*`).

- path: .claude/hooks/CLAUDE.md
  purpose: Bun-init boilerplate ("use Bun instead of Node", Bun.serve/HTML imports/frontend examples) plus a short list of the hooks.
  exports: n/a
  dependencies: n/a
  data_shapes: n/a
  side_effects: none
  role: docs (agent instructions)
  observations: Lines 1-106 are generic Bun template advice unrelated to these hooks (e.g. "Don't use vite", Bun.serve routes) and would be loaded as instructions for anything under .claude/hooks; only :108-113 are project-specific.

- path: .claude/hooks/README.md
  purpose: Bun-init README + table of hooks (event, purpose); helpers in lib/.
  exports: n/a
  dependencies: n/a
  data_shapes: n/a
  side_effects: none
  role: docs
  observations: Template `bun run ` with no target (README.md:12).

- path: .claude/hooks/bun.lock
  purpose: Bun lockfile for the hooks package (claude-agent-sdk 0.3.258 + transitive @anthropic-ai/sdk, @modelcontextprotocol/sdk, hono, express…; @types/bun 1.4.0).
  exports: n/a
  dependencies: n/a
  data_shapes: bun lockfile v1
  side_effects: none
  role: config (lockfile)
  observations: Separate from root npm lockfile; root package.json pins claude-agent-sdk ^0.3.228 (package.json:24) while hooks pin ^0.3.258 (package.json:11 here).

- path: .claude/hooks/package.json
  purpose: "hooks" Bun package — dep @anthropic-ai/claude-agent-sdk ^0.3.258 (types only), dev @types/bun "latest", peer typescript ^5.
  exports: n/a
  dependencies: as listed
  data_shapes: manifest
  side_effects: none
  role: config
  observations: `@types/bun: "latest"` unpinned (package.json:5); peer typescript ^5 while repo uses TypeScript ^7 (app/package.json:29). SDK used only for type imports (lib/hook-io.ts:7, notify-branch-sync-drift.ts:15).

- path: .claude/hooks/tsconfig.json
  purpose: Bun-init strict ESNext/bundler tsconfig (noEmit, noUncheckedIndexedAccess).
  exports: n/a
  dependencies: n/a
  data_shapes: n/a
  side_effects: none
  role: config
  observations: Not part of app:typecheck; hooks are never typechecked in CI (no workflow references .claude/hooks).

- path: .claude/hooks/guard-git-push-sync.ts
  purpose: PreToolUse(Bash) — denies `git push` when branch is behind its PR base (origin/<base>) or behind its own upstream.
  exports: none (script)
  dependencies: lib/hook-io (deny, allow, getInput, isRecord), lib/git-sync (checkBranchSync, describeDrift)
  data_shapes: hook JSON in/out
  side_effects: runs git fetch and `gh pr view` (network) on every matching push
  role: Claude Code hook
  observations: Imports `readStdin` but never uses it (guard-git-push-sync.ts:13). Regex only catches `git push` at segment start (:16). Fails open when no PR exists (git-sync.ts getBaseBranch returns null).

- path: .claude/hooks/guard-main-checkout.ts
  purpose: PreToolUse(Edit/Write/NotebookEdit/Bash) — denies edits whose target resolves into a main checkout and `git add|commit|merge|rebase|reset` whose effective dir (cwd, cd/pushd, -C) is a main checkout; bypassed in CI.
  exports: none (script)
  dependencies: lib/hook-io, lib/git-context.isMainCheckout, lib/pane-guidance
  data_shapes: hook JSON
  side_effects: spawns git rev-parse
  role: Claude Code hook
  observations: Fails closed on unknowable dirs (variables, `cd -`, popd) and git errors (guard-main-checkout.ts:43-57,68) but fails open on empty/unparseable stdin via getInput (lib/hook-io.ts:42-67). Does not catch other Bash writes (sed -i, redirects) — acknowledged in hooks/CLAUDE.md:110. CI env bypass (:26).

- path: .claude/hooks/guard-redirect-to-pane.ts
  purpose: PreToolUse(EnterWorktree, Bash) — denies EnterWorktree and `git … worktree add` with PANE_GUIDANCE.
  exports: none
  dependencies: lib/hook-io, lib/pane-guidance
  data_shapes: hook JSON
  side_effects: none
  role: Claude Code hook
  observations: Only intercepts the EnterWorktree tool and Bash text; harness-managed `Agent({isolation:"worktree"})` worktrees are unaffected (.claude/rules/worktree.md:14). Regex matches `git … worktree add` within a segment (guard-redirect-to-pane.ts:11).

- path: .claude/hooks/guard-superpowers-paths.ts
  purpose: PreToolUse(Write|Edit) — denies writes to docs/superpowers/specs/** or plans/**.
  exports: none
  dependencies: lib/hook-io (readStdin, deny, allow, isRecord)
  data_shapes: hook JSON
  side_effects: none
  role: Claude Code hook
  observations:
    - Parses stdin by hand instead of using getInput like the other guards (guard-superpowers-paths.ts:28-38) — inconsistent helper use.
    - Existing tracked files under docs/superpowers/plans/ (e.g. bootstrap-8-e2e-coverage.md referenced from e2e/pages/GuidedIamWizardPage.ts:19) can no longer be edited by agents.
    - References openspec/schemas/superpowers-bridge/README.md (:13) — exists.

- path: .claude/hooks/notify-branch-sync-drift.ts
  purpose: SessionStart + Stop hook emitting additionalContext describing branch drift vs PR base/upstream; skips when stop_hook_active.
  exports: none
  dependencies: SyncHookJSONOutput type, lib/git-sync, lib/hook-io
  data_shapes: hookSpecificOutput {hookEventName, additionalContext}
  side_effects: git fetch + gh pr view on every session start and stop
  role: Claude Code hook
  observations: Network-heavy check on every Stop (notify-branch-sync-drift.ts:28-30 comment).

- path: .claude/hooks/guards.test.ts
  purpose: bun:test suite pinning isMainCheckout (main/worktree/non-repo/missing-file/broken git config throws) and guard-main-checkout + guard-redirect-to-pane decisions across edit/bash/-C/cd/pushd/quoted paths/CI bypass.
  exports: none
  dependencies: bun:test, git CLI, temp repos
  data_shapes: n/a
  side_effects: creates temp git repos
  role: test
  observations: No tests for guard-git-push-sync, guard-superpowers-paths, notify-branch-sync-drift, or lib/git-sync; not run by any CI workflow.

- path: .claude/hooks/lib/cmd.ts
  purpose: execFileSync wrappers cmd/runCmd/tryCmd with cwd + 5s default timeout.
  exports: CmdOptions, cmd, CmdResult, runCmd, tryCmd
  dependencies: node:child_process
  data_shapes: CmdResult {ok, stdout|stderr}
  side_effects: spawns subprocesses
  role: library
  observations: TSDoc for CmdResult says "Result of {@link runCmd}" (cmd.ts:26) fine.

- path: .claude/hooks/lib/git-context.ts
  purpose: isMainCheckout(target) — compares --git-dir with --git-common-dir from nearest existing ancestor dir; throws on non-"not a git repository" failures.
  exports: isMainCheckout
  dependencies: lib/cmd.runCmd
  data_shapes: boolean
  side_effects: spawns git
  role: library
  observations: none.

- path: .claude/hooks/lib/git-sync.ts
  purpose: Branch drift helpers: current branch, PR base via `gh pr view`, upstream, fetch, behind/ahead counts, human-readable describeDrift recommending rebase.
  exports: getCurrentBranch, getDefaultBranch, getBaseBranch, getUpstream, BranchSyncStatus, checkBranchSync, describeDrift
  dependencies: lib/cmd.tryCmd, git, gh
  data_shapes: BranchSyncStatus {branch, base, behindBase, upstream, behindRemote, aheadRemote}
  side_effects: git fetch (network), gh API
  role: library
  observations: getDefaultBranch is exported but unused anywhere in hooks (git-sync.ts:27). Returns null (no check) when branch has no PR (:33-44), so pre-PR pushes are never guarded.

- path: .claude/hooks/lib/hook-io.ts
  purpose: stdin reader, isRecord guard, getInput(check) parser, deny/ask/allow responders writing PreToolUse hookSpecificOutput JSON.
  exports: PreToolUseHookInput (type), isRecord, readStdin, getInput, deny, ask, allow
  dependencies: @anthropic-ai/claude-agent-sdk types
  data_shapes: SyncHookJSONOutput
  side_effects: writes stdout, process.exit
  role: library
  observations:
    - `ask` exported but never used by any hook (hook-io.ts:96).
    - respond() exits 2 when continue is false (hook-io.ts:108-116), but allow() always sets continue:true — the exit-2 path is unreachable.
    - getInput lacks TSDoc, uses `catch (e: any)` and omits semicolons, unlike the rest of the file (:29-70).
    - getInput fails open (allow) on empty, malformed, or wrong-shape input (:42-67).

- path: .claude/hooks/lib/pane-guidance.ts
  purpose: PANE_GUIDANCE string telling agents to reuse/create Panes (panes_list → panels_create, or agents_start) instead of EnterWorktree/git worktree add.
  exports: PANE_GUIDANCE
  dependencies: none
  data_shapes: string
  side_effects: none
  role: library (constant)
  observations: none.
```

## .claude/rules

```yaml
- path: .claude/rules/comment-conciseness.md
  purpose: Path-scoped (**/*.{ts,tsx}) rule — default no comment; explanations go in TSDoc; inline comments single-line; wrap ~120; scale TSDoc to complexity.
  exports: n/a
  dependencies: tsdoc-tags.md
  data_shapes: n/a
  side_effects: none
  role: rule (agent instructions)
  observations: Cites `feedback-comment-verbosity.md` (comment-conciseness.md:41) — a user memory file outside the repo. The configs/e2e files in this sweep carry many multi-line inline comment blocks (e.g. electron.vite.config.ts:35-103, fixtures/hyveon-http-bridge.ts:196-247) contrary to rule 3.

- path: .claude/rules/duplication.md
  purpose: Rule — extract at ≥3 occurrences or ≥2 non-trivial; extract at every layer; "mirrors X / keep in sync" comments are bug reports.
  role: rule
  observations: Violated in-scope by demo-data.ts:61-110 "Mirrors … keep in sync", release.yml:319-321 "Keep this matrix in sync", tsconfig.json:23-24 "Mirrors the source aliases".

- path: .claude/rules/logging.md
  purpose: Rule — every @MessagePattern handler logs debug on entry; AWS-calling service methods catch/normalize/log; never log secrets.
  role: rule
  observations: Out-of-scope code it governs (desktop-main controllers).

- path: .claude/rules/pr-stacking.md
  purpose: Rule — split large changes into gh-stack PR stacks; each PR passes full gate with exit 0; skip/fixme with named fixing PR.
  role: rule
  observations: Cites PR #430 incident (pr-stacking.md:15).

- path: .claude/rules/spec-driven-development.md
  purpose: Routing between superpowers brainstorming and OpenSpec; when to use opsx vs direct PR; 5 promotion criteria; anti-patterns.
  role: rule
  observations: Requires `--schema superpowers-bridge` for /opsx:new|ff|propose (spec-driven-development.md:13) while generated skills/commands say omit `--schema` by default.

- path: .claude/rules/testing-conventions.md
  purpose: Path-scoped test rules — "should" names, no `as unknown as T`, TSDoc on helpers, three test tiers, Playwright page-object-only access, jsdom conventions, fixtures over scaffolding, renderPage only for routed pages.
  role: rule
  observations:
    - "Specs must reach elements through a page object … never page.getByX(...) directly" (testing-conventions.md:43-46) is broken across this sweep: games.spec.ts:122-141, logs.spec.ts:95,119,133,137, iac.spec.ts:189, polling.spec.ts:15,50,72, capture.spec.ts:103-460.
    - "No `as unknown as T`" (:18) broken by electron-mock.ts:42, ipc-mock.spec.ts:21, dashboard.spec.ts:43, iac.spec.ts:97, iac-ctx.ts:57 etc.
    - "Migration to `electron` is in progress" (:35).

- path: .claude/rules/tsdoc-tags.md
  purpose: TSDoc tag order/allowed tags/@packageDocumentation/{@link}/@param hyphen rules; lint enforces syntax only.
  role: rule
  observations: none.

- path: .claude/rules/typescript-conventions.md
  purpose: TSDoc required; no raw process.env in business logic; component size limits; reuse primitives; check for existing helpers; mountedRef must re-arm under StrictMode.
  role: rule
  observations: Cites concrete file:line anchors (main.tsx:18, use-guided-iam.hook.ts:169-174, render-page.utils.tsx:27 via testing-conventions) that can rot.

- path: .claude/rules/worktree.md
  purpose: Worktrees only via Pane; hooks listed; reuse before create; npm ci if stale; isolation:"worktree" for subagents; stack base chaining.
  role: rule
  observations: none.
```
(rules: exports/dependencies/data_shapes n/a, side_effects none unless noted.)

## .claude/scripts

```yaml
- path: .claude/scripts/watch-pr.ts
  purpose: Bun script polling `gh pr view` + inline comments API every 60s, printing one sanitized line per new comment/review/inline comment, concluded check, or merge/close; exponential backoff on failures, exits after 10 consecutive failures or when PR merged/closed.
  exports: Snapshot, snippet, InlineComment, buildSnapshot, diffSnapshots, WARN_AFTER, GIVE_UP_AFTER, failureAction, isDone
  dependencies: Bun.spawn, Bun.sleep, gh CLI
  data_shapes: Snapshot {state, mergedAt, checks, checkLabels, items}
  side_effects: network via gh; stdout
  role: script (Monitor watcher)
  observations: Requests `reviewDecision` but never uses it (watch-pr.ts:104). Items with missing id collapse onto key `c:undefined`/`i:undefined` (:54-61). Snippets cap 120 chars and strip control chars to blunt prompt injection (:19-28).

- path: .claude/scripts/watch-pr.test.ts
  purpose: bun:test pinning snippet sanitization/cap, diff reporting new items + concluded checks + merge, same-named checks across workflows keyed separately, failureAction warn at 1/5 and exit at 10.
  exports: none
  dependencies: ./watch-pr.ts
  data_shapes: n/a
  side_effects: none
  role: test
  observations: Not run in CI.
```

## .claude/workflows

```yaml
- path: .claude/workflows/openspec-review-proposal.js
  purpose: Workflow script — Scope agent reads change dir (optionally pinned to headRefOid via git show); 5 finder agents (scenarios, coherence, delta-correctness, conflicts, conventions), cap 6 each; per-location verifier (CONFIRMED/PLAUSIBLE/REFUTED); synthesis agent merges/ranks, max 8 findings.
  exports: meta; returns {changeDir, summary, findings[]} or {error}
  dependencies: Workflow runtime globals (args, agent, parallel, phase, log)
  data_shapes: CANDIDATES_SCHEMA, GROUP_VERDICT_SCHEMA, REPORT_SCHEMA, SCOPE_SCHEMA
  side_effects: spawns subagents (read-only instructions)
  role: workflow script
  observations:
    - changeDir validated against kebab-case regex (openspec-review-proposal.js:19-23); effort 'ultra' mapped to 'max' (:32).
    - Verifier failure/omission defaults to PLAUSIBLE so nothing is dropped (:199-204).
    - ARGS parsing, effort validation, three schemas, loc/inBounds, verify loop and synthesis/claim loop are duplicated nearly verbatim with openspec-review-implementation.js (:12-33, :71-106, :160-161, :182-243 vs impl :13-32, :57-92, :167-168, :236-310).

- path: .claude/workflows/openspec-review-implementation.js
  purpose: Workflow script — Scope agent pins diff (origin/<base>...<head> or @{upstream}...HEAD), lists changed files, CLAUDE.md files, tasks.md flips, delta specs; finders: 5 correctness angles (cap 6), cleanup (reuse/simplification/efficiency/altitude/CLAUDE.md conventions, cap 20), plus tasks-fidelity and spec-conformance when a change dir is resolved; verify; synthesize (max 12) ranking correctness < openspec < cleanup; suggests /opsx:sync|archive when all tasks checked.
  exports: meta; returns {summary, findings[{file, line, summary, failure_scenario, category, verdict}]} or {error}
  dependencies: Workflow runtime globals
  data_shapes: SCOPE_SCHEMA incl. taskItems, tasksAllChecked, changeDirValid, specFiles
  side_effects: spawns subagents; agents run git fetch/diff
  role: workflow script
  observations:
    - canonFile only accepts paths in scope.files (the diff) (openspec-review-implementation.js:160-166), so spec-conformance/tasks-fidelity candidates citing an unchanged delta spec or tasks.md line appear to be silently filtered out (:222, :229).
    - Shell-quotes refs for agent-run commands (:12, :33-34).
    - Hard error when change dir lacks tasks.md rather than skipping (:129-131).
```

## .claude/skills

```yaml
- path: .claude/skills/graphify/SKILL.md
  purpose: graphify skill (v0.9.42) — build/query a knowledge graph of a corpus. Workflow: install/detect interpreter → detect files → AST + parallel semantic extraction → build/cluster/analyze with shrink-guard → label communities → HTML/exports → manifest + report; query/path/explain/update subflows in references/.
- path: .claude/skills/graphify/.graphify_version
  purpose: Version stamp "0.9.42" (no trailing newline).
  role: config
- path: .claude/skills/graphify/references/add-watch.md
  purpose: Sub-runbook for `/graphify add <url>` (graphify.ingest) and `--watch` folder watching.
  role: skill reference
- path: .claude/skills/graphify/references/exports.md
  purpose: Sub-runbook for --wiki, --neo4j(-push), --falkordb(-push), --svg, --graphml, --mcp, and token-reduction benchmark (>5000 words).
  role: skill reference
- path: .claude/skills/graphify/references/extraction-spec.md
  purpose: Verbatim prompt + JSON schema for semantic extraction subagents (Step 3 Part B).
  role: skill reference
- path: .claude/skills/graphify/references/github-and-merge.md
  purpose: Sub-runbook for cloning GitHub repos and merging multiple graphs.
  role: skill reference
- path: .claude/skills/graphify/references/hooks.md
  purpose: Sub-runbook for `graphify hook install|uninstall|status` post-commit hook and native CLAUDE.md integration.
  role: skill reference
- path: .claude/skills/graphify/references/query.md
  purpose: Sub-runbook for query (BFS/DFS, constrained query expansion, token-budgeted output), path, explain — CLI with NetworkX fallback.
  role: skill reference
- path: .claude/skills/graphify/references/transcribe.md
  purpose: Sub-runbook for Whisper transcription of video/audio with a domain-hint prompt.
  role: skill reference
- path: .claude/skills/graphify/references/update.md
  purpose: Sub-runbook for --update (detect_incremental, build_merge with prune of deleted files only) and --cluster-only.
  role: skill reference
  observations: Comments reference upstream graphify issue numbers (#1344, #1361, #801) (update.md:96-109) — vendored third-party content.
- path: .claude/skills/openspec-apply-change/SKILL.md
  purpose: OpenSpec 1.7.0 generated skill — implement tasks. Workflow: select change → status → apply instructions → read context → task loop → report.
- path: .claude/skills/openspec-archive-change/SKILL.md
  purpose: Generated — archive change. Workflow: completion checks → delta-sync assessment → archive → summary.
- path: .claude/skills/openspec-bulk-archive-change/SKILL.md
  purpose: Generated — bulk archive. Workflow: select → validate → conflicts → confirm → archive each → summary.
- path: .claude/skills/openspec-continue-change/SKILL.md
  purpose: Generated — continue. Workflow: select → status → create next artifact → progress.
- path: .claude/skills/openspec-explore/SKILL.md
  purpose: Generated — explore stance. Workflow: open-ended investigation; offer, never auto-capture.
- path: .claude/skills/openspec-ff-change/SKILL.md
  purpose: Generated — fast-forward. Workflow: create change → build order → all artifacts → status.
- path: .claude/skills/openspec-new-change/SKILL.md
  purpose: Generated — new change. Workflow: choose schema (default unless asked) → create → first artifact instructions → stop.
  observations: Default-schema guidance (SKILL.md:32-44) conflicts with spec-driven-development.md's explicit superpowers-bridge requirement.
- path: .claude/skills/openspec-onboard/SKILL.md
  purpose: Generated — onboarding. Workflow: preflight → scan for a small task → full cycle with narration.
- path: .claude/skills/openspec-propose/SKILL.md
  purpose: Generated — propose. Workflow: create change → build order → all artifacts → status.
- path: .claude/skills/openspec-sync-specs/SKILL.md
  purpose: Generated — sync specs. Workflow: select → find deltas → apply ADDED/MODIFIED/REMOVED/RENAMED → summary.
- path: .claude/skills/openspec-update-change/SKILL.md
  purpose: Generated — update change. Workflow: select → read → reconcile → apply per artifact → point to next step.
- path: .claude/skills/openspec-verify-change/SKILL.md
  purpose: Generated — verify. Workflow: select → load artifacts → completeness/correctness/coherence → report.
- path: .claude/skills/scan-vocabulary/SKILL.md
  purpose: Skill (disable-model-invocation) documenting the deterministic leftover-term scanner. Workflow: run with --json → classify every match → fix real gaps → re-run until only legitimate matches remain.
- path: .claude/skills/scan-vocabulary/scan-vocabulary.mjs
  purpose: Dependency-free Node worker_threads scanner: walks root (excluding build dirs, worktrees, lockfiles, worktree .git pointer, binary extensions), matches case-insensitive substring or boundary + PascalCase-segment patterns, sorts results file/line/column, prints report or JSON.
  exports: none (CLI); internal buildPatterns, walk, scanFile, parseArgs, main
  dependencies: node:worker_threads, fs, path, os, url
  data_shapes: match {file, line, column, pattern, match, text}
  side_effects: reads files; spawns up to cpus() workers
  role: script (CLI tool)
  observations:
    - `.svg` treated as binary (scan-vocabulary.mjs:86) though it is text — terms inside SVGs are never found.
    - parseArgs splits on the first `=` only via destructuring (`[key, value] = split('=')`), so values containing `=` are truncated (:212).
    - Exit code is 0 regardless of match count (:281-300) — cannot be a CI gate without wrapping.
    - Boundary names not present in --terms are ignored silently (:104-108).
- path: .claude/skills/write-docs/SKILL.md
  purpose: Skill for docs/docs/** changes. Workflow: map diff → owner pages → dispatch docs-writer per page → three evaluators in parallel with explicit base ref → apply (fix all accuracy, justify coverage, judge style) → `npm --prefix docs ci && run build`.
  observations: Owner-page table (write-docs/SKILL.md:38-48) duplicated in agents/docs-coverage-auditor.md:26-36.
```
(Skill entries: role agent skill; side_effects none beyond what their workflows instruct; exports one skill each.)

## Observed behaviours

- The packaged app manifest for electron-builder is the root package.json (`directories.app: "."`), so every externalized runtime package must be a root `dependency` — electron-builder.yml:8,48-61; guarded by app/test/packaging-manifest-pins.test.ts:66-90.
- `@pulumi/pulumi`/`@pulumi/aws` (incl. subpaths, via regex), `semver`, `class-validator`, `class-transformer`, `electron-updater` are external to the main bundle — electron.vite.config.ts:104-111; build/verify-main-bundle-externals.mjs runs after every desktop:build — package.json:46.
- `PULUMI_ENGINE_VERSION` must equal the root `@pulumi/pulumi` pin — app/test/packaging-manifest-pins.test.ts:92-99.
- Main process is built with SWC for decorator metadata; preload is CJS `preload.cjs`; renderer rooted at app/packages/web — electron.vite.config.ts:30,135-136,143.
- Six lambda dists plus `iam-bootstrap.yaml` are shipped as extraResources under `<resourcesPath>/lambda` and `<resourcesPath>/cloudformation` — electron-builder.yml:224-242.
- macOS auto-update requires the zip target alongside dmg — electron-builder.yml:258-263; release verifies latest.yml/latest-mac.yml/latest-linux.yml and exe/dmg/zip/AppImage assets before leaving draft — .github/actions/publish-release/action.yml:49-60.
- electron-builder never publishes (`--publish never`); the release workflow's publish job creates the draft release only after all three platform builds succeed — package.json:48; .github/workflows/release.yml:372-386.
- Release bump commits are made by a GitHub App bot, only when `to` equals main's tip, and push via a request-scoped auth header with persist-credentials disabled — .github/workflows/release.yml:59-72,101-107,253-283.
- Release notes are AI-generated by claude-code-action (continue-on-error) with the raw git-cliff changelog appended in a `<details>` block; `chore(release):` commits are excluded — release.yml:175-226; cliff.toml:59.
- All CI test/lint/package workflows skip (but still report success) on markdown-only changes via a `changes` paths-filter job — .github/workflows/lint.yml:14-33 (and test/integration/e2e/package).
- E2E CI runs under xvfb with fluxbox so Electron maximize/restore works, and manually extracts the Electron zip to dodge an install race — .github/workflows/e2e.yml:43-64,131-150.
- Tier-1 e2e: `electron` project is a fixed list of 11 spec globs; everything else runs under `chromium` against `vite preview` on :4173 — app/packages/web/playwright.config.ts:40-83.
- Electron e2e launches set `HYVEON_TEST_MODE=1` and strip `ELECTRON_RENDERER_URL` so the main process uses `loadFile()` — playwright.config.ts:11-31.
- `window.hyveon.__test.mock(channel, handler)` overrides the real IPC invoke path; the last registration on a channel wins; `clearMocks()` resets — e2e/specs/ipc-mock.spec.ts:30-93; fixtures/electron-mock.ts:113-120.
- Unmocked renderer→main IPC round-trips work through `registerIpcMainBridges` (ElectronIPCTransport.listen() alone never calls ipcMain.handle) — e2e/specs/electron-ipc-roundtrip.spec.ts:6-18.
- Streaming channels (`logs.stream`, `iac.stack.initialize`, `iac.runs.streamLogs`) return a `HyveonStreamHandle` (next/cancel/asyncIterator) because raw AsyncGenerators can't cross contextBridge; mocks must be plain-object iterables — e2e/specs/streaming-handle-roundtrip.spec.ts:3-28.
- The chromium tier fakes `window.hyveon` by forwarding to a fictional `/api/*` REST surface answered by `page.route` stubs, with a catch-all 404 registered first — e2e/fixtures/hyveon-http-bridge.ts:27-157; fixtures/index.ts:144-146.
- The app routes with `HashRouter` (BrowserRouter breaks under file:// on Windows); same-value `location.hash` sets don't fire hashchange, so Electron navigation resets to `/` first — e2e/pages/index.ts:1-15; e2e/pages/AppLayout.ts:39-47.
- The app-level status poller's `inFlight` guard silently drops `refreshAll()` while a poll is running; the Refresh button exposes this via `aria-busy` — e2e/pages/DashboardPage.ts:38-47.
- The first-run wizard renders in place of the whole router when `wizard.state.get` reports `wizardCompleted:false`; wizard resume via `wizard.progress.get` clamps at `bootstrap` (stack-init only reachable by Next) — e2e/pages/GuidedIamWizardPage.ts:6-9; e2e/screenshots/capture.spec.ts:437-441.
- Guided IAM rotation: CreateAccessKey → GetCallerIdentity → DeleteAccessKey(bootstrap key); delete failure yields `delete-failed` and `revokeBootstrapKey` is the manual retry — e2e/integration-specs/guided-iam.spec.ts:145-226.
- `openConsole` outside Electron returns `{opened:false, url}` with the CloudFormation create-stack console URL — guided-iam.spec.ts:84-99.
- Bootstrap-key validation errors from STS propagate unchanged (not wrapped) through IPC dispatch — guided-iam.spec.ts:119-141.
- Rendered iam-bootstrap.yaml substitutes `__HYVEON_DEPLOY_ALL_POLICY_DOCUMENT__` and `__HYVEON_SELF_ROTATE_POLICY_DOCUMENT__` — guided-iam.spec.ts:73-80.
- Tier-2 harness compiles the real AppModule with `PulumiService` replaced by `PulumiServiceStub` (reference-equal), ECS/run-record DynamoDB/S3 SDK mocks installed, logger disabled — e2e/fixtures/ipc-harness.ts:121-134; integration-specs/pulumi-di-seam.spec.ts:28-40.
- `IacController.apply` maps every PulumiService gate error to `{started:false, error}`, and `RunLockHeldError` to `conflict:'up'`; no chunk is streamed on rejection — integration-specs/iac-apply-gates.spec.ts:43-179.
- IaC plan/apply/destroy ack before streaming; terminal result arrives on `iac.<op>.end` with `exitCode` (null + error on failure) — integration-specs/support/iac-ctx.ts:66-75; iac-plan.spec.ts:76-91.
- Streamed IaC chunks and persisted inline run logs preserve ANSI escapes byte-for-byte with stream attribution — integration-specs/iac-streaming-ansi.spec.ts:27-86.
- Run records: exitCode 0 → status success, else failed; logs under 350KB stored inline with no S3 key; list supports limit and status filter — integration-specs/iac-run-records.spec.ts:28-113.
- `ConfigService.getStackOutputs()` caches its first result — integration-specs/iac-streaming-ansi.spec.ts:32-37.
- `iac.output` returns stack outputs verbatim or `null` for a never-deployed stack (no throw) — integration-specs/stack-outputs.spec.ts:12-30.
- `EnvController.getEnv` reports environment `PROD` when domain is non-empty — integration-specs/config-service.spec.ts:13-21.
- With stack outputs but no deployment-config object, `listGames` returns deployed-only entries (`declared:false, deployed:true`) — config-service.spec.ts:23-34.
- `EcsService.start` refuses before RunTask when stack outputs are null; RunTask SDK errors become `{success:false, message: "<name>: <message>"}` — integration-specs/error-propagation.spec.ts:4-41.
- `stop()` performs its own ListTasks/DescribeTasks lookup before StopTask — integration-specs/start-stop.spec.ts:59-71.
- Discord `getConfig` never returns `botToken`/`publicKey`, only `botTokenSet`/`publicKeySet` booleans — integration-specs/discord-config.spec.ts:24-41.
- `canRun()` order: guild allowlist → admin (user or role) bypass → per-game user/role grant with action filter — integration-specs/can-run.spec.ts:43-75.
- Diagnostics bundle zip contains logs.txt, config-summary.json, metadata.json, aws-snapshot.json, errors.json; config-summary is omitted (error recorded) when no config bucket; `HYVEON_CONFIG_BUCKET` overrides — integration-specs/diagnostics-export.spec.ts:46-88.
- Approval older than the window (15 min per test title; 20-minute-old fixture) disables Apply and shows Re-approve — e2e/specs/iac.spec.ts:241-256; integration-specs/iac-apply-gates.spec.ts:60.
- Clearing a stuck run lock requires minting a token (`iac.runs.lock.clear.mintToken`) and passing it to `iac.runs.lock.clear`; clearing never auto-resubmits — e2e/specs/iac.spec.ts:315-408.
- Durable run lock is acquired only by apply/destroy, never plan — e2e/pages/IacPage.ts:80-86; iac.spec.ts:336-338.
- Discord wizard shows whenever `allowedGuilds` is empty, even with credentials set; client-side rejects malformed snowflakes and duplicate guilds without calling IPC — e2e/specs/discord.spec.ts:109-116,191-219,279-310.
- Folder-seed upload phases: starting-helper → uploading → verifying → done, or awaiting-confirmation with overwrite counts/samples; destination outside every volume or undeployed game disables Upload — e2e/fixtures/hyveon-http-bridge.ts:104-130; e2e/specs/games.spec.ts:182-250.
- Games list ports cell renders https web port first as "30000 (web)" then additional ports; detail shows "Web port" separately from "Additional ports" — e2e/specs/games.spec.ts:70,127-134.
- Costs page default sort is $/hour descending; app makes no Cost Explorer API calls — e2e/specs/costs.spec.ts:17-18,59-77.
- Linux uses app-drawn window controls (Minimize/Maximize/Restore/Close); macOS/Windows use native chrome; header is `-webkit-app-region: drag` — e2e/specs/electron-smoke.spec.ts:43-84.
- `app.close()` must finish within 15s with main/child pids reaped and no surviving `pulumi` engine process, even after loading the Automation API — e2e/specs/electron-clean-quit.spec.ts:28-188.
- Docs screenshots are produced by a dedicated Playwright config into docs/static/img/app/*.png with a frozen clock (DEMO_NOW 2026-07-26T12:00:00Z) — playwright.screenshots.config.ts:26-34; e2e/screenshots/capture.spec.ts:29-36; demo-data.ts:113.
- Vitest runs two projects (node, jsdom `web`), forks pool capped at 4 workers, 80% coverage thresholds on all four metrics — app/vitest.config.ts:45-81,119-124.
- ESLint bans `@aws-sdk/*` imports outside cloud-aws, lambda and an explicit exception list — app/eslint.config.js:113-200.
- Guard hooks: edits and `git add|commit|merge|rebase|reset` targeting a main checkout are denied (fail-closed on unknowable dirs), bypassed when CI/GITHUB_ACTIONS=true — .claude/hooks/guard-main-checkout.ts:25-78.
- `EnterWorktree` and `git worktree add` are denied with Pane guidance — .claude/hooks/guard-redirect-to-pane.ts:11-22.
- `git push` is denied when HEAD is behind its PR base or its own upstream (only when a PR exists) — .claude/hooks/guard-git-push-sync.ts:16-32; lib/git-sync.ts:82-108.
- Writes to docs/superpowers/specs/** or plans/** are denied — .claude/hooks/guard-superpowers-paths.ts:18-47.
- Branch drift is injected as additionalContext at SessionStart and Stop (once per Stop cycle) — .claude/hooks/notify-branch-sync-drift.ts:19-51.
- Hook input parse failures allow the tool call (fail-open) — .claude/hooks/lib/hook-io.ts:42-67.
- PR watcher polls every 60s, backs off exponentially to 5 min, exits on merge/close or after 10 consecutive failures, sanitizes untrusted comment text to 120 chars — .claude/scripts/watch-pr.ts:19-28,82-140.
- OpenSpec review workflows default unverified/omitted verdicts to PLAUSIBLE (never silently drop) and cap reports at 8 (proposal) / 12 (implementation) findings — .claude/workflows/openspec-review-proposal.js:199-204,214; openspec-review-implementation.js:254-259,273.

## Cross-scope references

- **@hyveon/desktop-main (dist)** — e2e/fixtures/ipc-harness.ts and every integration spec deep-import `dist/app.module.js`, `dist/controllers/{games,env,discord,diagnostics,wizard,iac,iac-runs}.controller.js`, `dist/services/{PulumiService,RunRecordService,SafeStorageService}.js`, and `dist/test-mocks/{ecs-mock,mock-store,pulumi-mock,run-record-mock,remote-file-store-mock}.js`. Error classes consumed: PulumiPlanNotApprovedError, PulumiApprovalExpiredError, PulumiPlanHashMismatchError, PulumiEngineVersionMismatchError, PulumiPlanRunNotFoundError, PulumiPlanArtifactStaleError, StalePlanError, DestroyNotConfirmedError. Also `electron-entry.ts` (main entry, platformWindowChromeOptions, default window size), `WindowController/WindowService`, `registerIpcMainBridges`, `ElectronIPCTransport`, `GuidedIamService`, `EcsService` message wording, `PulumiService.getLambdaBundlesDir()`, `cloudformationTemplate.ts` `resolveCloudFormationTemplatePath()`, `resources/cloudformation/iam-bootstrap.yaml`.
- **@hyveon/desktop-preload** — `src/preload.ts` (preload entry, HyveonStreamHandle, `__test.mock` registry, streamIacRunLogs), `src/index.ts` (`GUIDED_PROFILE_NAME`, `IacStaleLockInfo`, `HyveonApi` global), `hyveon-api.ts` types mirrored by demo-data.ts (AwsProfileSummary, BootstrapResult, IamCheckResult, WizardProgress, GameLogs, LogEventLine, RunHistoryRecord, IacPlanAck, etc.).
- **@hyveon/shared** — `canRun`, `RunLockHeldError`, `RunLock`, `ChangeSummary`, `StackOutputs`, `DiscordConfig`, `PULUMI_ENGINE_VERSION`, `WizardStep`, `LambdaFunctionKey`, `GameStatus`, `GameListEntry`, `DriftReport`, `AuditPageResult`, `RedactedGameServer`; subpath modules `folderUpload`, `gameServerValidator`, `envTokens`, `secrets/secretsStore` aliased in app/vitest.config.ts, web/vite.config.ts, web/tsconfig.json.
- **@hyveon/web src** — e2e imports types from `src/api.service.ts` (GameStatus, CostEstimates, EnvInfo, ActionResult, DiscordConfigRedacted, GameListEntry, DriftReport, AuditPageResult, GameEstimate); index.html loads `src/main.tsx`; page objects target components `app-layout.component.tsx`, `GameCard`, `PendingChangesBanner`, `AuditEntryRow`, `ChangeSummaryStatus`, `DiagnosticsPanel`, `DeploymentSettingsForm`, `useLogTail`, `useIacRunLog`, `ErrorBoundary`, `first-run-wizard.component.tsx`, `guided-iam-step.component.tsx`, `iac.page.tsx`, `dashboard.page.tsx` NoGamesCard, `app.component.tsx` (HashRouter); DESIGN.md/components.json describe `src/index.css` tokens and `src/components/ui/*`.
- **@hyveon/infra / cloud-aws / lambda packages** — built by root scripts and app/package.json; `@pulumi/*` pins must match `app/packages/infra/package.json` and `app/packages/desktop-main/package.json`; lambda `dist/` shipped by electron-builder; eslint exceptions name many desktop-main and shared files (LogsService, Ec2Service, FileManagerService, EcsService, SchedulerService, BootstrapService, IamCheckService, GuidedIamService, awsCredentialSource, AwsProfileService, CloudHealthService, PulumiWorkspaceService, shared ddb/configStore, pendingStore, secrets/secretsStore).
- **build/** (out of scope) — `verify-main-bundle-externals.mjs`, `generate-icons.mjs`, `generate-aws-regions.mjs`, `icon.*` referenced by package.json and electron-builder.yml.
- **patches/** — applied by root postinstall `patch-package`.
- **docs/** — Docusaurus site built/deployed by docs-build.yml and docusaurus-gh-pages.yml (`docs/diagrams/render.sh`, `docs/package-lock.json`); screenshots written to `docs/static/img/app/`; agents/skills reference `docs/docs/{architecture,setup,install,components/*,app/*,guides/*}.md` and `docs/docusaurus.config.ts`; e2e page object cites `docs/superpowers/plans/bootstrap-8-e2e-coverage.md`.
- **openspec/** — commands/skills/prompts/workflows operate on `openspec/changes/*` and `openspec/specs/*`; `openspec/config.yaml` (default schema spec-driven); `openspec/schemas/superpowers-bridge/README.md` cited by guard-superpowers-paths.ts; e2e specs cite `openspec/changes/remove-cost-explorer-calls`, `add-infra-log-viewer/design.md`, `add-first-run-wizard/design.md`.
- **External services/tools** — GitHub API via `gh` (hooks, watch-pr, release), GitHub App token, Anthropic claude-code-action, git-cliff via npx, D2 install script, Google Fonts (index.html), context7 MCP via npx, graphify CLI (settings hook-guard, skill), Pane MCP tools (pane-guidance), Bun runtime for hooks/scripts.
