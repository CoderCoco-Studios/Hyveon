# Sweep 10 — docs/ and openspec/

Brownfield LID mapping, Phase 1. Scope: tracked `docs/**` except `docs/static/` and `docs/arrows/`; `openspec/config.yaml`, `openspec/schemas/**`, `openspec/specs/**` (36 capabilities), the 11 active changes under `openspec/changes/`, and a title-only sweep of `openspec/changes/archive/` (34 changes).

Adapted field set for docs/spec files: `exports`/`dependencies`/`side_effects` are replaced by `covers:` (code areas / behaviours the doc describes) and `claims:` (key requirements, invariants or factual assertions, with file:line). Line refs are relative to the file named in each entry's `path`.

Method: 8 parallel read workers each read their slice in full. Mechanical inventories (requirement headings + scenario counts, task counts, delta headings, archive titles) were script-extracted for accuracy. Exceptions to "read fully": `docs/package-lock.json` (head + top-level versions only), `embed-file-browser/plan.md` and `add-healthcheck-auth-type/plan.md` (headings + first paragraph per section), archive (title sweep).

## Headline findings

- **Active-change state** (11 changes): only 2 are genuinely unstarted (`add-scripted-health-checks` 0/28, `add-vpc-flow-logs` 0/22). `embed-file-browser` is implemented on an unmerged 6-branch PR stack (HEAD tasks.md shows 3/44). The other 8 have shipped and are unarchived. Of those, 6 are synced into `openspec/specs/`: healthcheck-auth-type, pluggable-health-checks, icmp-ingress, release-automation, update-feed-fallback, and https-explicit-web-port (synced, but main is missing constraint 5). 2 are not synced: `add-pinned-hostname` (no `game-hostname-pinning` main spec) and `add-user-initiated-update-install`.
- **Re-applying deltas would regress main** for add-pluggable-health-checks (superseded by auth-type), add-release-automation (main rewritten by #664/#665), and icmp/https on game-port-visibility (main is a hand-merge). These should be archived without re-applying their specs.
- **Spec hygiene**: 4 specs still have a TBD Purpose (aws-cloud-health, custom-title-bar, env-token-interpolation, infra-log-viewer). Several specs still name Terraform-era terms (pulumi-infra-program parity requirement, iac-plan-apply-page `terraform apply` copy, snake_case `game_servers`), and two refer to an "IPC/HTTP" surface even though desktop-only-operator-surface rules HTTP out. node-toolchain-version references a non-existent `scripts/package.json`.
- **Spec contradictions**: Pulumi passphrase (machine-bound in pulumi-infra-program vs portable in pulumi-engine-runtime); efs-seeder always-on (lambda-runtime-currency) vs conditional (operator-documentation, CLAUDE.md); wizard state file name; wizard step order; auto-update `enableAutoUpdate` gate vs manual check/fallback.
- **Doc drift**: five vs six Lambdas in several pages; settings.md attributes DNS writes to the watchdog; the integration-tests.md "Pulumi spike" gate does not exist; stale `openspec/changes/remove-cost-explorer-calls` path (archived); `-tfstate` bucket name; ACM/CloudFront for the Discord domain vs the "no ACM anywhere" invariant (CLAUDE.md overstates it); docs/superpowers pivot design is still "Draft" and gsd/Terraform-era.
- **Process config**: `openspec/config.yaml` default schema is `spec-driven`, yet most recent changes use `superpowers-bridge`. The vendored bridge schema's apply step requires `superpowers:using-git-worktrees`, which conflicts with the Pane-only worktree rule.


## docs/docs (top-level pages: setup, intro, install, code-signing-roadmap)

```yaml
- path: docs/docs/setup.md
  purpose: End-to-end operator walkthrough from blank AWS account to running Fargate task + optional Discord bot; also hosts the canonical HyveonDeployAll IAM policy JSON.
  covers:
    - Prereqs (Node 24+, npm 10+, existing Route 53 hosted zone)
    - Guided IAM (CloudFormation iam-bootstrap.yaml, mint-then-revoke key rotation) + manual IAM fallback
    - HyveonDeployAll policy (generated from HYVEON_DEPLOY_ALL_ACTIONS in app/packages/shared/src/iamPolicy.ts; test-locked by app/packages/shared/src/iamPolicy.test.ts)
    - HyveonSelfRotate managed policy; AwsProfileService.rotateActiveCredentials(); IamCheckService (SimulatePrincipalPolicy)
    - npm scripts desktop:run / app:build / app:build:lambdas / desktop:build / app:start / desktop:dev / desktop:package / icons:generate
    - 5-step first-run wizard (cloud choice, guided IAM, credentials, bootstrap buckets+run-history table+seed config, Pulumi engine/plugin/stack init)
    - Add-game wizard fields (image, cpu/memory, ports incl. icmp, volumes, file_seeds, https+webPort, pin hostname)
    - Infrastructure plan/approve/apply; resource inventory of first apply
    - Packaging (electron-builder.yml, release/ outputs, extraResources Lambda bundles, macOS zip for MacUpdater), app icon pipeline (build/icon*.svg, build/generate-icons.mjs, sharp, png2icons)
    - Discord bot wiring (Application ID/Bot Token/Public Key, per-guild Register commands, Admins, Per-Game Permissions)
    - Smoke test, teardown (Destroy panel, secret recovery windows), troubleshooting table
  data_shapes:
    - IAM policy JSON (7 statements, see claims)
    - Add-game example (image/cpu/memory/ports/env/EFS volume) setup.md:370-376
    - Secrets names ${project_name}/discord/bot-token, ${project_name}/discord/public-key (setup.md:589-590); health-check secret hyveon-{game}-healthcheck-auth (setup.md:659)
  claims:
    - "HyveonDeployAll statements (setup.md:70-165):"
    - "  HyveonDeploy — Allow ecs:*, elasticfilesystem:*, ec2:*, lambda:*, logs:*, cloudwatch:*, events:*, scheduler:*, route53:*, dynamodb:*, secretsmanager:*, s3:*, cloudfront:*, acm:* on Resource * (74-94)"
    - "  HyveonIAM — iam:* on arn:aws:iam::*:role/hyveon-* and policy/hyveon-* (95-103)"
    - "  HyveonIAMSimulate — iam:SimulatePrincipalPolicy on user/${aws:username} (104-109)"
    - "  HyveonConfigurationBucket — 11 s3 object/bucket-config actions on ${project_name}-config[/*] (110-130)"
    - "  HyveonStateBucket — 7 s3 actions on ${project_name}-tfstate[/*] (131-147)"
    - "  HyveonServiceLinkedRoles — iam:CreateServiceLinkedRole on AWSServiceRoleForECS*, conditioned iam:AWSServiceName=ecs.amazonaws.com (148-156)"
    - "  HyveonServiceLinkedRoleRead — iam:GetRole on AWSServiceRoleForECS* (157-162)"
    - "HYVEON_DEPLOY_ALL_ACTIONS is the single source of truth; JSON block generated from it and test-locked; wizard IAM check and guided CFN template both derive from it (setup.md:225-238)"
    - "HyveonSelfRotate grants iam:CreateAccessKey/DeleteAccessKey/ListAccessKeys scoped via Fn::Sub to the created user's own ARN (setup.md:240-257)"
    - "Guided setup mints app's own key then revokes bootstrap key; Retry rotation on verification failure; checkpointed sub-stages (setup.md:42-48, 295-309)"
    - "Pasted keys encrypted with OS keychain; profile vs pasted keys are mutually exclusive for Pulumi ops; app refuses infra ops if neither configured (setup.md:316-323)"
    - "Bootstrap creates state bucket (hyveon-tfstate, versioned, AES-256), config bucket (hyveon-config, versioned, 90-day noncurrent expiry), run-history table (hyveon-runs, name fixed) via SDK, none Pulumi-managed; seeds empty config gameServers:{} (setup.md:324-342)"
    - "Pulumi self-managed S3 backend; no DynamoDB lock table (setup.md:199-206)"
    - "IAM check is advisory, never blocks (setup.md:343-346)"
    - "Wizard step 5 resolves/installs pinned Pulumi engine + AWS provider plugin, inits stack (setup.md:347-350)"
    - "Add-game wizard is six steps; submit writes only deployment-config.json, no AWS resource (setup.md:365, 380-384)"
    - "ICMP entry container:8 protocol:icmp shapes SG only, excluded from ECS portMappings (setup.md:378)"
    - "EFS access point per volume rooted /${game}/${name}, UID/GID 1000 (setup.md:388-391)"
    - "file_seeds: content or content_base64, run once per unique content, removals not deleted, no secrets (setup.md:392-398)"
    - "https=true adds Caddy sidecar, opens 443/80 public; webPort required, 1-65535, not 80/443, never public; ports = extras only; webPort forbidden when https=false; legacy ports[0] read as webPort (setup.md:399-418)"
    - "No per-game DNS from the app; update-dns Lambda owns it (setup.md:422-423)"
    - "First apply resources: VPC, 2 public subnets, ECS cluster, per-game task def + EFS AP + log group, 4 always-on + 2 conditional Lambdas, 3 DynamoDB tables, 2 secrets, EventBridge rule + schedule, Discord custom domain (us-east-1 ACM, CloudFront, A/AAAA ALIAS discord.{hostedZoneName}) (setup.md:432-445)"
    - "No HTTP server or bearer token (setup.md:456-457)"
    - "desktop:package = app:build:lambdas -> desktop:build -> electron-builder; Lambda bundles shipped as extraResources (setup.md:500-522)"
    - "No Privileged Gateway Intents needed (setup.md:592-593); commands always per guild, no global (setup.md:619-621)"
    - "Discord secrets zero-day recovery window; health-check secrets app-owned, default recovery window, not touched by Destroy (setup.md:656-665)"
    - "Audit log table records only game-config add/edit/remove from UI; not Discord actions, start/stop, credential edits (setup.md:570-576)"
  role: docs (operator guide; IAM policy SoT mirror)
  observations:
    - "setup.md:217 says 'Two permission areas are not covered' but lists four bullets (220-223)"
    - "setup.md:144-145,327 state bucket named ${project_name}-tfstate / hyveon-tfstate — Terraform-era name retained under Pulumi"
    - "setup.md:229 'do not create separate inline policies or update the README independently' — README reference appears legacy"
    - "setup.md:222 says Discord interactions endpoint fronted by CloudFront, while 450-452 and 675 talk about the interactions Lambda Function URL output; intro.md:21-23 reconciles (CloudFront fronts Function URL)"
    - "setup.md:482 'desktop:dev ... rebuilds Lambda bundles automatically' — root package.json desktop:dev runs app:build && app:build:lambdas once at start, not on save"
    - "setup.md:221 introduces EventBridge Scheduler (scheduler:*) for the FileBrowser helper auto-stop — ties to embed-file-browser work"
    - "setup.md:41 links 'step 2 of 5' (wizard) from section 1; section numbering (1-8 guide steps) vs wizard steps (1-5) easily confused"
    - "setup.md:381-382 says config bucket is from 'step 2' but bucket is created in wizard step 4 (within guide step 2)"
    - "setup.md:681 Watchdog tuning 'three knobs' via Settings → General, requires re-apply"
    - "setup.md:262 clone URL github.com/CoderCoco-Studios/Hyveon"

- path: docs/docs/intro.md
  purpose: Site home (slug /): product pitch, feature list, role routing, component links, high-level diagram, repo map.
  covers: Fargate on-demand tasks, EFS per-game APs, update-dns, Caddy TLS, watchdog, Electron app (Nest + React, IPC), serverless Discord bot, six Lambda packages; repo tree of app/packages/*, build/, docs/, openspec/, electron.vite.config.ts, electron-builder.yml
  claims:
    - "No persistent ECS service, no idle cost (intro.md:16)"
    - "update-dns UPSERTs {game}.{domain} on start, DELETEs on stop; Caddy sidecar proxies 443 to declared web port; no LB/ACM for game traffic; Discord custom domain uses CloudFront + ACM over a Function URL (intro.md:18-23)"
    - "Renderer talks to backend over Electron IPC, no HTTP server (intro.md:25-27)"
    - "Six Lambda packages; four always deployed; health-check once shared when any game has healthCheck; efs-seeder once per game with file_seeds (intro.md:30-35, 65-67)"
    - "Preload exposes window.hyveon (intro.md:95)"
  role: docs (landing)
  observations:
    - "intro.md:39 'organised around three roles' but four links follow (Setup, Install, User, Maintainer)"
    - "intro.md:63-64 describes management app as 'the Nest.js API' — HTTP-era wording vs IPC-only invariant"
    - "intro.md:71 embeds /diagrams/context.svg (docs/static/diagrams/context.svg exists, committed)"
    - "intro.md:88-111 repo map omits scripts/ (setup.md:22 references scripts/package.json), .github/, cliff.toml, tsconfig.base.json"

- path: docs/docs/install.md
  purpose: Per-OS install of packaged unsigned builds from GitHub Releases.
  covers: release artifacts (Hyveon Setup *.exe, Hyveon-*.dmg, Hyveon-*.zip, Hyveon-*.AppImage); Gatekeeper, SmartScreen, chmod +x
  claims:
    - "v1 builds not code-signed (install.md:20-26)"
    - "macOS Sequoia 15+ requires System Settings → Privacy & Security → Open Anyway; right-click Open works only on macOS 14 and earlier (install.md:30-42)"
    - ".zip on macOS is the auto-update feed asset, not an installer (install.md:15)"
  role: docs (end-user install)
  observations:
    - "install.md:65 says 'see step 5 of the setup guide if you'd rather run from source in dev mode' — step 5 covers desktop:run/desktop:dev"
    - "sidebar_position 6 (install.md:3) while code-signing-roadmap is 7, setup 3"

- path: docs/docs/code-signing-roadmap.md
  purpose: Roadmap/cost/config path to signed macOS and Windows builds and enabling auto-update.
  covers: electron-builder.yml mac.hardenedRuntime, mac.notarize, win.azureSignOptions, CSC_LINK/CSC_KEY_PASSWORD; electron-updater; enableAutoUpdate electron-store flag; auto-update-scaffold capability; .github/actions/build-package latest*.yml
  claims:
    - "mac.hardenedRuntime: false is intentional until a real signing identity exists (code-signing-roadmap.md:36-45)"
    - "Apple ~$99/yr; Azure Trusted Signing ~$10/mo (22, 49)"
    - "enableAutoUpdate defaults false because unsigned updater fails Gatekeeper; Settings 'Automatic Updates' toggle already ships (71-88)"
    - "build-package uploads latest.yml/latest-mac.yml/latest-linux.yml; mac zip target needed for MacUpdater (77-84)"
    - "'first launch, flag off, zero network calls' behaviour must hold (92-93)"
    - "Blocked on ownership decision, no Apple/Azure accounts (95-102)"
  role: docs (roadmap)
  observations:
    - "code-signing-roadmap.md:26-27 refers to 'the current right-click workaround' — contradicts install.md:30-36 (Sequoia removed right-click bypass)"
    - "code-signing-roadmap.md:71 references `auto-update-scaffold` capability — openspec/specs/auto-update-scaffold presumably; not verified in this part"
```

## docs/docs/guides

```yaml
- path: docs/docs/guides/_category_.json
  purpose: Docusaurus sidebar category "Guides" (position 4) linking to guides/index.
  covers: sidebar structure
  claims: []
  role: config (docs sidebar)
  observations: none

- path: docs/docs/guides/index.md
  purpose: Guides landing page listing Setup, User, Maintainer guides; links to /app and /install.
  covers: navigation only
  claims: []
  role: docs (index)
  observations:
    - "guides/index.md:10 links Setup guide (/setup) which lives outside guides/ dir"

- path: docs/docs/guides/user.md
  purpose: Player-facing guide — Discord slash commands, connecting to servers, watchdog behaviour.
  covers: /server-start, /server-stop, /server-status, /server-list; interactions/followup/update-dns Lambdas; watchdog Lambda; DNS TTL; HTTPS games via Caddy
  claims:
    - "All replies ephemeral (user.md:55, 62-63)"
    - "/server-start: deferred ack within 3s, followup RunTask writes 15-minute PENDING#{taskArn} row; update-dns upserts A and PATCHes original message on RUNNING (user.md:67-76)"
    - "/server-stop: ecs.stopTask; update-dns deletes record on STOPPED for every game incl. HTTPS (user.md:80-82)"
    - "/server-status uses ListTasks + DescribeTasks, resolves ENI public IP (user.md:86-88); /server-list == status with no arg (92-93)"
    - "DNS TTL dnsTtl default 30s (user.md:99-100)"
    - "HTTPS games: Caddy sidecar, Let's Encrypt, proxies to webPort (never directly reachable), no LB; extra ports per visibility; Discord connect message shows https:// URL (user.md:102-110)"
    - "Watchdog: EventBridge schedule default 15 min; reads NetworkPacketsIn; below watchdogMinPackets increments idle_checks tag; at watchdogIdleChecks StopTask reason 'Watchdog: idle for N minutes'; never touches DNS; activity resets to 0; default 60 min (user.md:117-132)"
  role: docs (user guide)
  observations:
    - "user.md:117-132 defaults (15 min interval, 60 min total => 4 idle checks) are stated here; should be cross-checked against shared DeploymentConfig defaults"
    - "user.md:125 mentions 'any load balancer' though no LB exists in stack — defensive wording"

- path: docs/docs/guides/maintainer.md
  purpose: Contributor guide — repo layout, infra file map, scripts, conventions, CI workflows, invariants, Lambda deploy, server/web touch rules, screenshot harness, release process.
  covers:
    - Root npm workspaces (app, app/packages/*, app/packages/desktop-preload, app/packages/lambda/*)
    - app/packages/infra files network.ts, securityGroups.ts, efs.ts, ecs.ts, iam.ts, lambdas.ts, dynamodb.ts, secrets.ts, route53.ts, escapes.ts, discordDomain.ts, program.ts (defineAll())
    - Scripts incl. aws-regions:generate (build/generate-aws-regions.mjs -> app/packages/shared/src/awsRegions.ts), docs:screenshots
    - CI: lint.yml, test.yml, e2e.yml, integration.yml, package.yml, release.yml, docs-build.yml, docusaurus-gh-pages.yml; actions setup-app, build-package, publish-release
    - DeploymentConfigService (REMOTE_FILE_STORE), DiscordConfigService.getRedacted()/getEffectiveToken(), DiscordCommandRegistrar.registerForGuild, canRun(), COMMAND_DESCRIPTORS (@hyveon/shared/commands.ts), actionForCommand(), ddb/client.ts region fallback
    - CloudProviderModule tokens CLOUD_PROVIDER, SECRETS_STORE, REMOTE_FILE_STORE, DISCORD_RECEIVER, AUDIT_LOG_STORE, RUN_RECORD_STORE
    - installPulumiMocks() (testing/pulumiMocks.ts), aws-sdk-client-mock, Winston logger.ts
    - packages/web/src/api.service.ts -> window.hyveon.*; screenshot harness app/packages/web/e2e/screenshots, window.hyveon.__test.mock(), docs/static/img/app/
    - release.yml: git-cliff (cliff.toml), GitHub App token (RELEASE_APP_ID/RELEASE_APP_PRIVATE_KEY), anthropics/claude-code-action w/ CLAUDE_CODE_OAUTH_TOKEN, enforce-main-branch-protection ruleset
  claims:
    - "Lambdas esbuild to app/packages/lambda/*/dist/handler.cjs; lambdas.ts reads them as pulumi.asset.FileAsset at apply (maintainer.md:57-60, 306-313)"
    - "ecs.ts never declares a Service (maintainer.md:75, 197-201)"
    - "route53.ts declares zero resources, hosted-zone lookup only; the 3 infra-managed Route 53 records are in discordDomain.ts (maintainer.md:80-82, 219-230)"
    - "Per-game resources fan out from DeploymentConfig.gameServers; each define function loops itself; GAME_NAMES env on four Lambdas; Games-page write never changes AWS without a plan/apply (maintainer.md:203-217)"
    - "Watchdog idle_checks is an ECS tag, no DDB/SSM (maintainer.md:232-236)"
    - "AWS_REGION_ set on all six Lambdas; read by five; efs-seeder sets but never reads and makes no AWS SDK calls; ddb/client.ts fallback AWS_REGION_ -> AWS_REGION -> AWS_DEFAULT_REGION -> us-east-1 (maintainer.md:238-249)"
    - "getEffectiveToken() only used by DiscordCommandRegistrar (maintainer.md:253-257)"
    - "Per-guild PUT applications/{client_id}/guilds/{guild_id}/commands only (maintainer.md:259-265)"
    - "canRun ordering guild allowlist -> admin -> per-game user/role + action; one copy in @hyveon/shared (maintainer.md:267-271)"
    - "Adding a slash command: descriptor, interactions switch, followup event.kind switch, actionForCommand(), rebuild/apply/register (maintainer.md:273-283)"
    - "No ApiTokenGuard, API_TOKEN, /api/*; controllers IPC-only @MessagePattern (maintainer.md:285-293)"
    - "Lambda asset hash content-derived => no spurious diffs; no Lambda CI deploy pipeline (maintainer.md:315-320)"
    - "@MessagePattern handlers and AWS/Pulumi service methods start with logger.debug; catch + warn/error; never leak raw SDK errors (maintainer.md:362-368)"
    - "Screenshot harness isolated from e2e (own Playwright config) (maintainer.md:409-413)"
    - "Release: workflow_dispatch; inputs from/to/bump/skip_bump/tag (replay mode); bumps root package.json only; publish job only after all builds; asset check fails if latest*.yml or any of .exe/.dmg/.zip/.AppImage missing; AI summary fallback to raw changelog; always draft (maintainer.md:423-463)"
  role: docs (maintainer guide)
  observations:
    - "maintainer.md:133 'From CLAUDE.md, paraphrased' — CLAUDE.md now delegates test/TS conventions to .claude/rules/testing-conventions.md and typescript-conventions.md"
    - "maintainer.md:127 typecheck order shared → cloud-aws → infra → desktop-preload → desktop-main → web matches root package.json:38; differs from app:build order (maintainer.md:114: shared → infra → cloud-aws → ...) — both may be correct, but readers may confuse"
    - "maintainer.md:256, 346 use 'endpoint' wording ('Do not add an endpoint', 'New endpoint → controller') — HTTP-era vocabulary vs IPC-only invariant #10"
    - "maintainer.md:270 'imported verbatim by the server and both Discord Lambdas' — 'server' leftover wording for desktop-main"
    - "maintainer.md:350 services wired through AwsModule / DiscordModule — module names not verified in this part"
    - "maintainer.md:353 says 'six CloudProviderModule injection tokens' — list matches six names"
    - "maintainer.md:107 pre-push suggests lint+test+build but omits app:typecheck which line 127 and CLAUDE.md call required"
    - "maintainer.md:226 'There is no ALB anywhere' — confirms ALB removed; no Terraform mentions remain besides tfstate naming elsewhere"
    - "maintainer.md:376 path 'packages/web/src/api.service.ts' is relative to app/ (file exists at app/packages/web/src/api.service.ts)"
    - "maintainer.md:116 desktop:dev must run with cwd repo root due to main field check"
    - "Invariant list (maintainer.md:192-300) numbers 11 items; overlaps CLAUDE.md invariants but adds #9 (JSON descriptors) and #11 (Events IAM); CLAUDE.md adds shared-barrel AWS SDK rule and in-task TLS not numbered here — partial duplication between docs"
```

## docs/diagrams

```yaml
- path: docs/diagrams/.gitignore
  purpose: Ignore *.svg in the diagrams source dir.
  covers: build hygiene
  claims: []
  role: config
  observations: none

- path: docs/diagrams/README.md
  purpose: Explains D2 diagram sources, render pipeline, embed locations, why D2 over Mermaid.
  covers: render.sh -> docs/static/diagrams/*.svg; docusaurus-gh-pages.yml CI; embed table (context -> intro.md; discord-bot, game-plane, control-loops, server-start -> architecture.md)
  claims:
    - "Rendered SVGs are committed to docs/static/diagrams/ (README.md:10-15) — confirmed by git ls-files (5 SVGs)"
    - "CI (docusaurus-gh-pages.yml) runs render.sh then npm run build on push to main touching docs/** (README.md:4-8)"
  role: docs (tooling readme)
  observations:
    - "README.md:4-8 names only docusaurus-gh-pages.yml; maintainer.md:179-181 says docs-build.yml also renders D2 on PRs"
    - "README.md:13-15 says stale image ships 'until the next main build' — contradicts itself somewhat: if CI re-renders, committed SVGs are overwritten at build; committing is still required for local preview"
    - "README.md:40-47 rationale vs docusaurus.config.ts:19-23 still enabling Mermaid theme — Mermaid may still be used elsewhere in docs"

- path: docs/diagrams/render.sh
  purpose: Bash script rendering every *.d2 in its dir to ../static/diagrams/<name>.svg with d2 CLI.
  covers: docs/static/diagrams output
  claims:
    - "set -euo pipefail; nullglob; one d2 call per file (render.sh:6-16)"
  role: script
  observations:
    - "render.sh:4 comment names only docusaurus-gh-pages.yml as CI caller"
    - "Requires external d2 binary; no version pin (README.md:31 installs latest via curl | sh)"

- path: docs/diagrams/context.d2
  purpose: High-level context diagram (operator app, Discord, player, AWS: ECS, bot, loops, Route 53).
  covers: renderer -> desktop-main over IPC (window.hyveon); bot RunTask/StopTask; loops UPSERT/DELETE A; player UDP/TCP/HTTPS
  claims: ["desktop-main writes config to bot and Start/Stop/Describe ECS (context.d2:32-33)"]
  role: docs (diagram source)
  observations:
    - "context.d2 omits S3 config bucket, Pulumi, CloudFront/Discord custom domain, health-check/efs-seeder Lambdas"

- path: docs/diagrams/control-loops.d2
  purpose: update-dns and watchdog control loops.
  covers: EventBridge Task State Change -> update-dns (RUNNING/STOPPED); rate(N min) -> watchdog; DDB PENDING#arn get+delete; Discord PATCH; CloudWatch NetworkPacketsIn GetMetricStatistics; StopTask + idle_checks tag
  claims: ["watchdog writes idle_checks tag and StopTask when >= threshold (control-loops.d2:30-31)"]
  role: docs (diagram source)
  observations:
    - "Labels the watchdog trigger 'eb -> watchdog: rate(N min)' — user.md:117 calls it an EventBridge schedule; setup.md:441 'EventBridge rule + schedule'"

- path: docs/diagrams/discord-bot.d2
  purpose: Serverless Discord bot internals.
  covers: interactions Lambda (Function URL) -> Secrets (public key), DDB CONFIG read, async invoke followup; followup put PENDING#arn, RunTask/StopTask, PATCH @original; type:5 deferred ack
  claims: []
  role: docs (diagram source)
  observations:
    - "Shows Discord -> interactions Lambda directly; CloudFront custom domain (discordDomain.ts) not depicted"

- path: docs/diagrams/game-plane.d2
  purpose: Operator + ECS + EFS game plane.
  covers: deployment-config.json in S3 read via RemoteFileStore; desktop-main RunTask/StopTask/DescribeTasks, put CONFIG#discord, put secrets, tail logs; Caddy sidecar for HTTPS games; ECS -> EFS nfs
  claims: []
  role: docs (diagram source)
  observations: none

- path: docs/diagrams/server-start.d2
  purpose: /server-start sequence diagram.
  covers: Ed25519 verify + canRun() in interactions; type:5 ack < 3s; async invoke FollowupPayload; RunTask palworld-server; put PENDING#taskArn TTL 15m; EventBridge RUNNING -> update-dns DescribeTasks -> ENI -> IP, UPSERT A, get+delete PENDING, PATCH 'running'
  claims: ["PENDING row TTL 15m (server-start.d2:20) consistent with user.md:73-74"]
  role: docs (diagram source)
  observations: none
```

## docs/src

```yaml
- path: docs/src/css/custom.css
  purpose: Infima colour variables (light/dark) and scoped SVG diagram sizing/dark-mode invert.
  covers: diagram rendering in .markdown
  claims:
    - "SVG rule scoped to .markdown to avoid breaking navbar logo.svg sizing and colours (custom.css:34-48)"
  role: config (styles)
  observations: none
```

## docs (root config)

```yaml
- path: docs/docusaurus.config.ts
  purpose: Docusaurus site config.
  covers: url https://codercoco-studios.github.io, baseUrl /Hyveon/, org CoderCoco-Studios; docs at routeBasePath '/', editUrl main/docs/; blog off; mermaid enabled; navbar (Docs sidebar, Using the App -> /app, GitHub); footer links /setup, /architecture, /guides/user, /guides/maintainer; prism github/dracula + bash/hcl/json
  claims:
    - "onBrokenLinks and onBrokenMarkdownLinks: 'throw' (docusaurus.config.ts:16-17)"
  role: config
  observations:
    - "docusaurus.config.ts:107 additionalLanguages includes 'hcl' — Terraform-era leftover now that IaC is Pulumi TS"
    - "docusaurus.config.ts:19-23 mermaid enabled though diagrams moved to D2 (diagrams/README.md:40-47); may still be used by other pages"
    - "docusaurus.config.ts:17 onBrokenMarkdownLinks at top level is deprecated in recent Docusaurus 3.x (moved under markdown.hooks) — may warn"

- path: docs/sidebars.ts
  purpose: Single autogenerated sidebar docsSidebar over the docs dir.
  covers: sidebar
  claims: []
  role: config
  observations: none

- path: docs/package.json
  purpose: hyveon-docs package manifest (Docusaurus scripts and deps).
  covers: docusaurus start/build/deploy/serve etc.
  data_shapes: deps @docusaurus/core|preset-classic|theme-mermaid 3.10.2, @mdx-js/react ^3, clsx ^2, prism-react-renderer ^2.3, react/react-dom ^18; dev @docusaurus/module-type-aliases|tsconfig|types 3.10.2, typescript ~5.5.0, webpack ^5.95.0; engines node >=24
  claims: ["engines.node >=24.0.0 (package.json:33-35), matches setup.md:22"]
  role: config
  observations:
    - "docs is not a root npm workspace (separate install: maintainer.md:185 'cd docs && npm install')"
    - "typescript pinned ~5.5.0 — likely older than root workspace TS; not verified"

- path: docs/package-lock.json
  purpose: npm lockfile for docs site.
  covers: dependency resolution
  data_shapes: "lockfileVersion 3; 1411 package entries. Sample entry (from head -40): node_modules/@11ty/gray-matter 1.0.0 (MIT; deps js-yaml ^4.1.0, kind-of ^6.0.3, section-matter ^1.0.0, strip-bom-string ^1.0.0). Top-level resolved: @docusaurus/core 3.10.2, preset-classic 3.10.2, theme-mermaid 3.10.2, react 18.3.1, react-dom 18.3.1, typescript 5.5.4, webpack 5.95.0, prism-react-renderer 2.4.1, @mdx-js/react 3.1.1, clsx 2.1.1"
  claims: []
  role: config (lockfile)
  observations:
    - "NOT read fully per brief (737KB): only head -40, lockfileVersion, and top-level versions via JSON parse"

- path: docs/tsconfig.json
  purpose: Extends @docusaurus/tsconfig with baseUrl '.'.
  covers: editor/type support for docs config
  claims: []
  role: config
  observations: none

- path: docs/.gitignore
  purpose: Ignores .docusaurus/, build/, node_modules/.
  covers: build outputs
  claims: []
  role: config
  observations: none
```

> Worker notes (docs/docs/components + architecture):

Line numbers are file-relative. Spot-checks against code were done for claims that looked drift-prone; results are recorded under `observations`.

## docs/docs (architecture.md)

```yaml
- path: docs/docs/architecture.md
  purpose: Big-picture overview of Hyveon — three pieces (infra program, Electron management app, six Lambdas), why Pulumi, three component diagrams, the /server-start path, and eight numbered invariants.
  covers:
    - app/packages/infra (Pulumi Automation API program), its boundary vs the IAM bootstrap CloudFormation template and BootstrapService SDK calls
    - management app (Electron, desktop-main Nest backend over IPC, PulumiService.getStackOutputs(), CloudProvider/@hyveon/cloud-aws, SecretsStore, direct DynamoDB SDK use)
    - six Lambda packages (interactions, followup, update-dns, watchdog, health-check, efs-seeder)
    - control loops (EventBridge → update-dns; scheduled watchdog; health-check delegation)
    - invariants: DeploymentConfig.gameServers SoT, Lambda-managed DNS (route53.ts), AWS_REGION_, secrets never leave AWS, per-guild command registration (DiscordCommandRegistrar.registerForGuild), canRun() in @hyveon/shared, watchdog state in ECS tags, file-manager SG has no default ingress (securityGroups.ts)
    - diagrams /diagrams/game-plane.svg, discord-bot.svg, control-loops.svg, server-start.svg
  claims:
    - "Infra program is not the only AWS provisioner: IAM bootstrap CFN template + BootstrapService SDK calls exist outside it (11-16)"
    - "Renderer talks to desktop-main over Electron IPC, not HTTP; backend reads stack outputs from the S3 state backend, no local state file (17-23)"
    - "Six Lambdas: four always-on + shared health-check (when any game has healthCheck) + per-game efs-seeder (per game with file_seeds) (24-29)"
    - "Pulumi chosen for multi-cloud optionality, no HCL round-trip, no operator-installed CLI (PulumiEngineService provisions engine) (31-45)"
    - "No persistent ECS service; start=ecs.runTask, stop=ecs.stopTask, watchdog stops idle tasks (47-49)"
    - "ECS start/stop/status/logs/cost via CloudProvider; secrets via SecretsStore; DynamoDB via raw SDK v3, no abstraction (64-68)"
    - "HTTPS games terminate TLS in-task via Caddy sidecar proxying to explicit webPort, never exposed directly; no load balancer anywhere (69-72)"
    - "interactions verifies Ed25519, deferred ack within 3s, async-invokes followup (78-82)"
    - "update-dns UPSERTs A on RUNNING, deletes on STOPPED; reconciles pending row only on RUNNING (88-93)"
    - "watchdog only issues StopTask, never touches Route 53; idle = NetworkPacketsIn threshold unless game declares healthCheck, then delegates to health-check Lambda via IAM identity-policy grant (93-100)"
    - "Idle auto-stop after four consecutive 15-minute windows; `NetworkPacketsIn < min_packets` (113-117)"
    - "Inv 1: gameServers persisted as deployment-config.json in S3 config bucket; GAME_NAMES env on four Lambdas; each defineX loops internally (126-133)"
    - "Inv 2: route53.ts declares zero resources, only hosted-zone lookup (135-139)"
    - "Inv 3: AWS_REGION_ set on every Lambda; efs-seeder never reads it (141-146)"
    - "Inv 4: bot token/public key in Secrets Manager; app writes them and calls getEffectiveToken() once; API returns botTokenSet/publicKeySet only (148-152)"
    - "Inv 5: PUT applications/{client_id}/guilds/{guild_id}/commands; never global (154-157)"
    - "Inv 6: canRun() order guild allowlist → admin → per-game; shared by server + both Discord Lambdas (159-161)"
    - "Inv 7: idle counter is `idle_checks` ECS task tag; no DynamoDB/SSM (163-165)"
    - "Inv 8: file-manager SG empty ingress; app authorizes <ip>/32:8080 on helper launch and revokes on stop; upload helpers HTTPS w/ pinned self-signed cert SHA-256; interactive Files sessions plain http; stray seed-upload helpers >15min swept at startup; EventBridge Scheduler auto-stop at 2h (167-172)"
  data_shapes: DeploymentConfig.gameServers, StackOutputs (implicit), idle_checks tag
  role: docs (architecture overview / invariants)
  observations:
    - "Invariant list (119-172) omits two CLAUDE.md invariants: TLS-in-task/no-ALB and no-HTTP-transport/desktop-only — they appear only in prose (17-23, 69-72)."
    - "Invariant 4 wording 'never sent to the browser — the API only returns' (151-152) is HTTP-era phrasing; elsewhere doc insists no HTTP API exists."
    - "'four consecutive 15-minute windows' (114) hard-codes defaults (watchdogIntervalMinutes=15 at app/packages/shared/src/deploymentConfig.ts:240; idle checks configurable) — these are operator-configurable, not fixed."
    - "`min_packets` (115) is snake_case Terraform-variable leftover; the config field is camelCase (watchdog* fields in deploymentConfig.ts)."
    - "'Why Pulumi' (33-36) references the earlier HCL-based tool / migrate-iac-to-pulumi change — historical narrative."
    - "Diagram SVGs referenced (74, 84, 102, 110) exist under docs/static/diagrams/; context.svg in that directory is not referenced here."
    - "Invariants preamble says they are spelled out 'in CLAUDE.md, the maintainer guide, and inline in a few app/packages/infra source files' (121-124) — three-way duplication of invariant text."
```

## docs/docs/components

```yaml
- path: docs/docs/components/_category_.json
  purpose: Docusaurus sidebar category for Components (label, position 5, links to components/index).
  covers: docs site navigation
  claims: []
  role: config (docs sidebar)
  observations: none

- path: docs/docs/components/index.md
  purpose: Landing page linking to the four component deep-dives.
  covers: links to /components/infra, /components/management-app, /components/lambdas, /components/integration-tests, /architecture
  claims:
    - "Management app page covers 'the Nest.js API, React dashboard, and @hyveon/shared' (13-14)"
    - "Six Lambdas: four always-on + conditional health-check (shared) and efs-seeder (per game) (15-18)"
    - "Integration tests = tier-2 Playwright suite dispatching into the Nest DI container (19-21)"
  role: docs (index)
  observations:
    - "'the Nest.js API' (14) is HTTP-era wording; the backend is an IPC microservice."
    - "Does not mention @hyveon/cloud-aws or @hyveon/desktop-preload, which management-app.md does cover."

- path: docs/docs/components/infra.md
  purpose: Deep-dive on app/packages/infra — invocation via Automation API, S3 DIY state backend + derived passphrase, configuration input, per-file resource table, tagging, DNS/runs-table invariants, port visibility, ICMP, webPort normaliser, env-token interpolation, pinned-hostname shim, dependencies.
  covers:
    - app/packages/desktop-main/src/services/PulumiService.ts, PulumiWorkspaceService.getOrCreateStack/migrateLegacyPassphrase, PulumiEngineService, PULUMI_ENGINE_VERSION
    - app/packages/infra/src/{network,securityGroups,efs,ecs,hostnameShim,envTokenWrapper,iam,lambdas,dynamodb,secrets,route53,escapes,discordDomain,program,index}.ts, testing/{fixtures,pulumiMocks}.ts
    - @hyveon/shared ingressPorts/normalizeGameServer/normalizeDeploymentConfigGames (gameServerPorts.ts), checkPortCollisions/checkReservedHttpsPortsAcrossDeployment (gameServerValidator.ts), envTokens.ts, resolveRunsTableName
    - BootstrapService.ensureRunsTable, RunRecordService, RunService apply lock, FileManagerService, AwsCloudProvider.startWorkload, followup runStart
  claims:
    - "No host pulumi binary; inline program createInfraProgram(deploymentConfig,{lambdaBundlesDir}) via LocalWorkspace.create + Stack.createOrSelect; destroy uses a no-op program (19-34)"
    - "PulumiEngineService downloads/verifies pinned engine into Electron userData, never ~/.pulumi or PATH; passed via LocalWorkspaceOptions.pulumiCommand (35-43)"
    - "@pulumi/pulumi and @pulumi/aws exact-pinned identically in infra and desktop-main (44-48, 451-454: 3.255.0 / 7.39.0)"
    - "State backend PULUMI_BACKEND_URL=s3://<stateBucket>?region=; secretsProvider passphrase; no Pulumi Cloud (56-60)"
    - "Passphrase derived HMAC-SHA256(PULUMI_PASSPHRASE_DERIVATION_SALT, accountId+PULUMI_STACK_NAME), never stored; salt frozen (61-75)"
    - "Passphrase is not a confidentiality boundary — program never calls pulumi.secret (76-82)"
    - "Legacy stored pulumi.passphrase migrates silently on first run; deleted only after re-encrypt succeeds (83-100)"
    - "Backend lock is an S3 lock object; PulumiService.clearStaleLock() after orphan check; distinct from RunService DynamoDB apply lock (101-110)"
    - "Single DeploymentConfig input, no variables file; defineAll() calls each defineX in fixed order, each loops gameServers (112-130)"
    - "Game environment values echoed into stack outputs (appliedGameServers); PulumiService redacts values ≥4 chars from preview/apply streams and pulumi.log (132-139)"
    - "Files table: per-file resource counts, e.g. 2 fixed subnets, 3 fixed + 2 conditional SGs, file-manager SG empty ingress, internal-visibility ingress from VPC CIDR, ICMP rule shape, no aws.ecs.Service, two log groups per game, 6 fixed IAM roles + per-seeder + shared health-check, 4 fixed Lambdas + per-seeder + conditional health-check, 4 lambda Permissions, 2 EventRules, 2 DynamoDB tables, 3 secrets with ignoreChanges, route53.ts zero resources, discordDomain.ts ACM+CloudFront+3 records, 2 aws.Providers (141-164)"
    - "Project=hyveon via defaultTags on both providers; Game=<game> on per-game task defs, log groups, seeder Lambda; propagateTags TASK_DEFINITION at both RunTask sites (166-190)"
    - "Cost-allocation tag activation is a manual console step (192-211)"
    - "Only aws.route53.Record resources are the three in discordDomain.ts; negative test asserts route53.ts has none (213-225)"
    - "Health-check SG egress confines by port, not game — accepted risk (227-240)"
    - "visibility 'public'|'internal'; undefined ≡ public; internal = VPC CIDR; webPort never ingressed except health-check SG-sourced rule (242-289)"
    - "Legacy https configs: ports[1..] become publicly ingressed after normalisation — behaviour change (260-266)"
    - "Hand-edited deployment-config.json is not re-validated on read (286-289)"
    - "ICMP ports: container=type, toPort -1; excluded from portMappings and GAME_PORTS; cross-game icmp repeats allowed with same visibility; unmanaged manual ICMP SG rules get removed on next up (291-302)"
    - "webPort required iff https, 1–65535, not 80/443; normalizeGameServer deprecated, idempotent, applied in DeploymentConfigService reads and PulumiService raw read (304-323)"
    - "443/80 tcp reserved deployment-wide whenever any game is https (325-332)"
    - "${hyveon.network.public-address} resolved at build time to <game>.<zone>; ${hyveon.network.public-ipv4} resolved at boot by wrapper polling checkip.amazonaws.com 30×2s, exec's command, exits non-zero on failure; command required when ipv4 token used; shellSingleQuote injection safety (334-386)"
    - "pinnedHostname: hostname-shim init container (busybox:1.38.0), ephemeral volume, dependsOn SUCCESS, NODE_OPTIONS --require prepended; Node-only; validator reserves /hyveon/hostname-shim and name hostname-shim (388-419)"
    - "Runs table is bootstrap-managed via BootstrapService.ensureRunsTable, not Pulumi; resolveRunsTableName called from 3 places (421-447)"
  data_shapes: DeploymentConfig, GameServerConfig, GameServerPort{visibility,protocol,container}, StackOutputs.runsTableName/appliedGameServers, GAME_PORTS map (number|'https')
  role: docs (component deep-dive)
  observations:
    - "Files table (147-164) claims to list 'Every source file under app/packages/infra/src/' (143) but omits hostedZoneName.ts (stripTrailingDots) and logGroups.ts (LOG_RETENTION_DAYS=7, shared Lambda log-group helper) — both exist (app/packages/infra/src/hostedZoneName.ts, logGroups.ts). index.ts row (163) mentions stripTrailingDots as 'internal to its own file' without naming the file."
    - "Version pins (453-454) verified matching: infra/package.json:17-18, desktop-main/package.json:31-32, shared/src/pulumiVersion.ts:21."
    - "Very long single table cells (150, 152, 155, 156) embed whole design narratives — hard to keep accurate; e.g. ecs.ts row includes a migration instruction about pre-existing log groups (152)."
    - "Historical narrative: 'This fixes a real gap… previously' (69-73), 'before the explicit webPort field' (260), 'before this feature existed' (302, 385), 'a plain config echo now' (443)."
    - "References `game-health-checks` OpenSpec capability Risks section (235) — openspec/specs/game-health-checks exists."
    - "Mentions `pulumi up` (302) as operator-facing term although there is no CLI step for operators."
    - "dynamodb.ts row says 2 tables (157); runs table is third DynamoDB table outside Pulumi (421+)."

- path: docs/docs/components/lambdas.md
  purpose: Per-Lambda reference (package, trigger, Pulumi resource names, IAM, env vars, behaviour, failure modes) for all six Lambdas, plus the assembled /server-start path and Infra Logs page pointer.
  covers:
    - app/packages/lambda/{interactions,followup,update-dns,watchdog,efs-seeder,health-check}; esbuild → dist/handler.cjs; infra lambdas.ts lambdaCode()/defineLambdas; escapes.ts defineEfsSeederInvocations/fileSeedsHash; iam.ts gamesWithHealthChecks; health-check src/engine.ts
    - @hyveon/shared/secrets cache, canRun(), putPending/PENDING#{taskArn}, FollowupPayload
  claims:
    - "Each package builds to single CJS dist/handler.cjs, wrapped by lambdaCode() AssetArchive/FileAsset (8-17)"
    - "AWS_REGION_ set on every function incl. efs-seeder/health-check; efs-seeder never reads it (23-29)"
    - "interactions: Function URL auth NONE, CORS https://discord.com; IAM ddb GetItem, secret GetSecretValue, lambda Invoke followup; env AWS_REGION_, TABLE_NAME, DISCORD_PUBLIC_KEY_SECRET_ARN, FOLLOWUP_LAMBDA_NAME, GAME_NAMES, HOSTED_ZONE_NAME (31-39)"
    - "interactions behaviour: Ed25519 verify via @noble/ed25519 over timestamp+rawBody, 401 on mismatch; PING→PONG; autocomplete filtered by canRun with no ECS calls; command: allowlist, canRun, deferred ack type 5 flag 64, async Invoke followup (41-59)"
    - "Failures yield no reply by design (61-64)"
    - "followup: kinds start/stop/status/list; re-fetch config defensively; start runs RunTask then putPending (15-min TTL) then PATCH @original; webhook valid 15 min (66-121)"
    - "followup env includes CONNECT_MESSAGES and GAME_PORTS (number | 'https') (74)"
    - "update-dns: EventBridge ECS Task State Change RUNNING/STOPPED; FAMILY_TO_GAME; resolvePublicIp 5×3s; UPSERT on RUNNING; STOPPED verifies IP before deleteDns; notifyDiscordIfPending on RUNNING; no retry/backstop on failure; returns {status:'error',reason:'no_ip'} (123-173)"
    - "watchdog: schedule; ListTasks paginated, DescribeTasks; verdict from exactly one source — CloudWatch NetworkPacketsIn (fail-active) or synchronous health-check invoke (fail-active); idle_checks tag increment, StopTask at IDLE_CHECKS with reason 'Watchdog: idle for {N} minutes', never touches DNS; reset counter on active (175-232)"
    - "efs-seeder: aws.lambda.Invocation in escapes.ts during stack.up(); one function per file_seeds game; mounts first volume's access point at /mnt/efs; path-traversal guard; exactly one of content/content_base64; mode 3–4 digit octal default 0644; throws to fail apply (PulumiUpError/PulumiPartialApplyError); triggers keyed on SHA-256 seedsHash; removed seeds not deleted (234-288)"
    - "health-check: sync invoke only from watchdog, no Function URL/Permission; single shared function; IAM ecs:DescribeTasks + scoped GetSecretValue; destination host only from ECS private IPv4 (SSRF closed by construction); auth types raw/basic/bearer, fixed Authorization header overriding operator header; no redirects; engine.ts JSONPath subset; fail-active at every failure; reason never contains response value; warn on failure-derived verdicts (290-371)"
    - "Infra Logs page live-tails 5 of 6 Lambdas; efs-seeder excluded (391-398)"
  data_shapes: FollowupPayload {kind, applicationId, interactionToken, userId, guildId, roleIds, game?}; ECS task-state event; health-check payload {game, taskArn, healthCheck: GameServerHealthCheck}; verdict {active, reason, failureDerived}; efs-seeder payload {game, seeds, container_path}
  role: docs (component deep-dive)
  observations:
    - "Terraform/HCL leftovers: 'directory-archiving data source other IaC tools provide' (11-13); `auth_type = NONE` (36) vs code functionUrlAuthType: 'NONE' (app/packages/infra/src/lambdas.ts:500); `https = true` HCL syntax (74, 131, 150); `rate(${watchdog_interval_minutes} minute(s))` snake_case var (180) vs watchdogIntervalMinutes (lambdas.ts:138); `file_system_config` (247) is Terraform attribute naming."
    - "'Unlike the other four Lambdas, this handler imports no @aws-sdk/*' (269) — there are five other Lambdas."
    - "'CloudWatch ENI lag' (115) — ENI lag is an EC2/ECS concern, not CloudWatch; likely wording slip."
    - "followup IAM: 'secretsmanager:GetSecretValue on the public key (only read for downstream calls in some paths)' (73) is vague — candidate for accuracy check against iam.ts."
    - "/server-start ASCII flow (375-384) uses an emoji '🟢 running' string — matches formatGameStatus emoji claim in management-app.md:44 (not verified)."
    - "Logs page Lambda list (393-394) matches LambdaFunctionKey union (app/packages/shared/src/lambdaFunctionKey.ts:9-13: watchdog, health-check, dns-updater, interactions, followup)."

- path: docs/docs/components/management-app.md
  purpose: Wiring-level reference for the Electron app's non-Lambda packages — @hyveon/shared modules, desktop-main boot/module graph/controllers+IPC channels/services/logging/env vars/credential storage/AWS credential precedence/DeploymentConfigService/drift, cloud-aws, desktop-preload (+ test seam), web (entry, routes, API layer, vite, e2e).
  covers:
    - app/packages/shared/src/{types,canRun,commands,sanitize,gameServerPorts,formatStatus,ddb/client,ddb/configStore,ddb/pendingStore,secrets/secretsStore,deploymentConfig,gameServerConfig,gameServerValidator,cloud,iamPolicy,stackOutputs,pulumiVersion,folderUpload/}.ts
    - app/packages/desktop-main/src/{main.ts,electron-entry.ts,rpc-error-message.filter.ts,ipc-main-bridge.ts,logger.ts,updater.ts,updater-fallback.ts,cloud-provider.module.ts,cloud-provider.tokens.ts}, controllers/*, services/* (ConfigService, DiscordConfigService, DiscordCommandRegistrar, EcsService, Ec2Service, LogsService, SchedulerService, CostService, FileManagerService, FolderScanService, FolderUploadService, services/folderUpload/*, PublicIpService, DriftService/computeDrift, DeploymentConfigService, GamesWriteService, GameWizardDraftService, PulumiCredentialResolver, awsCredentialSource, SafeStorageService, ElectronStoreService, GuidedIamService, CloudHealthService, BootstrapService, ...)
    - app/packages/cloud-aws (seven contract implementations)
    - app/packages/desktop-preload/src/preload.ts (window.hyveon, __test seam), test-mock-registry.ts
    - app/packages/web/src/{main.tsx,app.component.tsx,api.service.ts,lib/report-renderer-error.utils.ts}, vite.config.ts, electron.vite.config.ts, e2e/specs, e2e/fixtures, .github/workflows/e2e.yml
  claims:
    - "No HTTP server/bearer token; renderer ↔ backend exclusively via Electron IPC window.hyveon (15-17, 101-104, 307-313)"
    - "canRun order guild allowlist → admin → per-game; imported verbatim by Nest server and both Discord Lambdas (40)"
    - "Four slash commands as JSON descriptors; actionForCommand maps to start/stop/status (41, 58-60)"
    - "sanitize.ts blocks __proto__/constructor/prototype (42)"
    - "ddb/client region fallback AWS_REGION_ → AWS_REGION → AWS_DEFAULT_REGION → us-east-1 (45)"
    - "putPending sets expiresAt = now + 15 min (47)"
    - "secretsStore: 5-min cache; 'placeholder' = not configured; health-check secret hyveon-{gameId}-healthcheck-auth, upsert Put→Create on ResourceNotFound, RestoreSecret on pending deletion (48)"
    - "normalizeGameServer applied in DeploymentConfigService, PulumiService raw reads (preview/apply/rollback-diff), GameWizardDraftService backfill, DriftService (43)"
    - "Boot: guard process.versions.electron; createMicroservice with BridgedElectronIPCTransport; useGlobalFilters(RpcErrorMessageFilter) before listen(); registerIpcMainBridges (64-80)"
    - "RpcErrorMessageFilter preserves real .message; ipc-main-bridge turns rejection into plain Error to survive structured clone (82-99)"
    - "AppModule imports nine modules (108-118)"
    - "CloudProviderModule binds seven tokens CLOUD_PROVIDER, SECRETS_STORE, REMOTE_FILE_STORE, DISCORD_RECEIVER, AUDIT_LOG_STORE, DISCORD_CONFIG_STORE, RUN_RECORD_STORE via CLOUD_BINDINGS keyed off ConfigService.getActiveCloud() (123-135)"
    - "DISCORD_CONFIG_STORE exists to give DiscordConfigService credentialed DDB access (avoid ambient-credential CredentialsProviderError) (152-159)"
    - "PulumiServiceModule avoids importing RunRecord/CloudProvider/DeploymentConfig modules to break an ESM cycle; resolves via ModuleRef.get(strict:false) (181-189)"
    - "Controller/channel table for Games, Costs, Logs, CloudHealth, Files, FolderUpload, Discord, Env/Diagnostics/Drift/Audit, Iac, IacRuns, IacSettings, Wizard, Window (221-235)"
    - "files.start: bcrypt password, one-time plaintext, 2h EventBridge Scheduler auto-stop (227)"
    - "iac.destroy and iac.lock.clear gated behind mint-then-confirm tokens; iac.runs.lock.clear similarly for RunService lock (231-232)"
    - "IacSettings update validates via validateDeploymentSettingsPatch, stale expectedVersionId → {code:'conflict'}; autoUpdate.check never downloads; download/install only on explicit click (233)"
    - "ConfigService.getStackOutputs memoised; null cached 20s; value cached until invalidateCache() (239-254)"
    - "DiscordCommandRegistrar validates guildId as 17–20 digit snowflake (261-264)"
    - "EcsService via CLOUD_PROVIDER; Ec2/Logs/Scheduler use SDK directly; CostService pure arithmetic, no Cost Explorer (265-288)"
    - "FolderUploadService: overwrite confirmation (10-min timeout), stray-helper sweep >15 min on init; uploadEngine 4 in flight, 3 attempts, resume by remote size; FileBrowserClient pins cert fingerprint; PublicIpService 5s timeout (289-294)"
    - "GamesWriteService validates before touching Secrets Manager; auth:null clears; deletion failures swallowed, creation failures surfaced (297)"
    - "Logging conventions: debug on entry for every @MessagePattern and fallible service method; normalize errors; never log payloads (315-340)"
    - "Env vars: AWS_DEFAULT_REGION, CONFIG_CACHE_TTL_MS=30000, RUNS_DIR_PATH, HYVEON_CONFIG_BUCKET, NODE_ENV, DIAGNOSTICS_LOG_DIR, HYVEON_TEST_MODE (342-352)"
    - "SafeStorageService passthrough outside Electron; ElectronStoreService in-memory Map fallback; AppStoreSchema fields; secrets encrypted; addGameWizardDraft not encrypted but value fields blanked before IPC (354-409)"
    - "Credential precedence: selected source sets its vars and explicitly clears the other's to ''; pasted keys also clear AWS_SESSION_TOKEN; no source → PulumiCredentialsNotConfiguredError (411-451)"
    - "DeploymentConfigService: S3 only, no local-file fallback; HYVEON_CONFIG_BUCKET override then bootstrap.configurationBucket; getGameServers → [] when unconfigured; writes throw ConfigurationNotConfiguredError; updateTopLevelSettings never takes gameServers from patch (453-484)"
    - "Drift: pending_create/pending_delete/config_drift over image/cpu/memory/ports/volumes, order-insensitive, both sides normalised (486-512)"
    - "cloud-aws only imported by CloudProviderModule (514-526)"
    - "HYVEON_TEST_MODE=1 exposes window.hyveon.__test.mock/clearMocks; gated off in production (537-561)"
    - "Renderer uses HashRouter because loadFile file:// breaks BrowserRouter; route table (583-605)"
    - "api.service.ts delegates every call to window.hyveon, no fetch (611-615)"
  data_shapes: FolderUploadProgress/OverwriteSummary, ManualUpdateCheckResult, AppStoreSchema, drift report entries, StackOutputs
  role: docs (component deep-dive)
  observations:
    - "Package-count contradiction: 'plus the five Lambda packages' (14) vs six elsewhere (lambdas.md:8, architecture.md:24, app/packages/lambda has six dirs)."
    - "'zero-runtime-dependency TypeScript' (32) is false — app/packages/shared/package.json dependencies include @aws-sdk/client-dynamodb, @aws-sdk/client-secrets-manager, @aws-sdk/lib-dynamodb, ulid, zod; CLAUDE.md itself notes the barrel pulls AWS SDK."
    - "'consumed by … the four core Lambdas … efs-seeder has no dependency' (33-34) omits health-check, which does depend on @hyveon/shared (app/packages/lambda/health-check/package.json)."
    - "AppModule 'nine imports' (108-114) is stale — app/packages/desktop-main/src/app.module.ts:65-76 lists ten, incl. FolderUploadModule (which the doc describes separately at 289)."
    - "Stale path: 'see openspec/changes/remove-cost-explorer-calls' (276) — change is archived at openspec/changes/archive/2026-08-06-remove-cost-explorer-calls (same stale reference also in several source files and docs/docs/app/costs.md:24)."
    - "Task-number history in docs: 'PrerequisiteService was deleted (migrate-iac-to-pulumi change, tasks 10.1/10.2)' (204-205); 'no longer provides ConfigService directly' / 'before this token existed' narratives (145-159); 'The old local-file-parsing path was removed as dead code' (250-252); 'no equivalent of the old ApiTokenGuard' (312-313)."
    - "shared module table (37-56) omits many existing modules (aws/ecsTask.ts, audit.ts, changeSummary.ts, drift.ts, envTokens.ts, errors.ts, lambdaFunctionKey.ts, runs.ts, deploymentSettingsWrite.ts, gamesWrite.ts, discord/*, wizardSteps.ts, etc.)."
    - "Controller table has no row for validation.ts (helper, fine) and WizardController channels are not enumerated (234)."
    - "IacSettingsController row (233) mentions constructor-param optionality for tests — implementation detail in docs."
    - "Window controls: Linux uses app-drawn buttons (235) — memory notes a planned migration to native titleBarOverlay (PR #531 TODO)."
    - "e2e section says chromium project runs against production build via vite preview (626) while integration-tests.md:207 says 'against the Vite dev/preview server' — minor inconsistency."
    - "`/costs` route described as having 'AWS Cost Explorer link-out' (602) while app makes no Cost Explorer API calls — consistent (link-out only)."

- path: docs/docs/components/integration-tests.md
  purpose: Documents the tier-2 Playwright integration suite (in-process AppModule DI container, mocked AWS SDK, PulumiService stub), its mocks, spec inventory, design constraints, the three Playwright configs, the tier-1 Electron IPC mock seam, and jsdom unit-tier conventions.
  covers:
    - app/packages/desktop-main/src/test-mocks/{mock-store,ecs-mock,run-record-mock,remote-file-store-mock,pulumi-mock}.ts
    - app/packages/desktop-main/src/testing/{fake-filebrowser-server,fake-filebrowser-client}.ts, services/FolderUpload.integration.test.ts
    - app/packages/web/e2e/fixtures/{ipc-harness,server-mocks,stack-outputs.fixture,hyveon-http-bridge}.ts, e2e/integration-specs/*, playwright.{integration,,screenshots}.config.ts
    - desktop-preload/src/{preload.ts,test-mock-registry.ts}; desktop-main/src/electron-entry.ts
    - app/vitest.config.ts, app/vitest.setup.ts, web src/test-utils/{render-page.utils.tsx,stream-handle.test-utils.ts}, src/polling/game-status-provider.component.tsx, hooks/use-log-tail.hook.test.ts
  claims:
    - "Harness = Test.createTestingModule({imports:[AppModule]}).overrideProvider(PulumiService).useValue(stub); no HTTP, Vite, BrowserWindow (8, 25-37)"
    - "npm run app:test:integration builds desktop-main via tsc then runs playwright with integration config (12-19)"
    - "Integration config: testDir e2e/integration-specs, workers 1, no webServer/projects (21, 55)"
    - "MockStore FIFO queues for ListTasks/DescribeTasks/RunTask/StopTask with safe defaults (58-67)"
    - "Spec inventory of 15 specs + support/iac-ctx.ts (94-115)"
    - "PulumiServiceStub script* setters; scripts are sticky, not FIFO; rollback/initializeStack/clearStaleLock unscripted (117-145)"
    - "Fresh stub per harness; ECS/DDB/S3 mock stores are process-wide singletons reset per harness (147)"
    - "Run-record mock is stateful, reproduces conditional-put lock semantics → ConditionalCheckFailedException → RunLockHeldError; patchApprovedAt helper (151-160)"
    - "S3 mock: single versioned object keyed CONFIGURATION_OBJECT_KEY; only diagnostics-export.spec.ts sets HYVEON_CONFIG_BUCKET and exercises it (162-170)"
    - "guided-iam.spec.ts mocks STS/IAM inline and forces SafeStorage available (172-190)"
    - "Constraints: workers 1, fullyParallel false; no real Pulumi engine structurally (192-197)"
    - "Three Playwright configs; ELECTRON_SPECS list; app:test:e2e builds shared/cloud-aws/infra/desktop-preload then desktop:build (199-208)"
    - "HYVEON_TEST_MODE gates main-process log + Pulumi spike, and preload __test namespace (217-243)"
    - "Production gating guarantee; two mock surfaces (__test.mock vs test-mock-registry register()) (245-261)"
    - "Fresh ElectronApplication per test pattern for once-mounted components (263-283)"
    - "contextBridge cannot carry async generators (285-288)"
    - "Vitest two projects node/web, globals false, setup registers jest-dom + cleanup (296-307)"
    - "Routed-page specs use renderPage() with PollingProvider → GameStatusProvider → MemoryRouter; must stub api.status and api.costsEstimate (338-362)"
  role: docs (test-harness reference)
  observations:
    - "STALE: claims electron-entry.ts gates a 'Pulumi spike' via `if (isPulumiSpikeEnabled() && !isTestMode())` ~line 239 and that electronEnv strips HYVEON_PULUMI_SPIKE* (223-229). No PULUMI_SPIKE/isPulumiSpikeEnabled exists in desktop-main/src, web/playwright.config.ts or web/e2e/fixtures; electron-entry.ts:211-212 only logs the test-mode banner."
    - "ELECTRON_SPECS cited at '~line 50' (207); actually app/packages/web/playwright.config.ts:40. Spec list itself matches (40-52)."
    - "Spec inventory (98-115) matches the files in app/packages/web/e2e/integration-specs (15 specs + support/iac-ctx.ts); index.ts and tsconfig.json not listed (index.ts mentioned at 56)."
    - "Key-files table (41-56) omits other existing fixtures: web/e2e/fixtures/{electron-launch,electron-mock,game-data,index}.ts and desktop-main/src/testing/{config-service.fixture,deployment-config.fixture,stack-outputs.fixture,message-pattern.test-utils}.ts."
    - "Historical/task narrative: 'once tracked as follow-up under task 7.11 … Task 7.11 is closed' (145); 'previous provisioning service … PATH-shimmed stub script' (119); 'Replaces the deleted tfstate.fixture.json' (50) — Terraform leftover reference; 'see the migrate-iac-to-pulumi change's Phase 6' (164)."
    - "The page mixes three tiers (tier-2, tier-1 seam, jsdom unit) despite title 'Integration Test Suite (Tier 2)'; overlaps with .claude/rules/testing-conventions.md and management-app.md:537-561 (__test seam described twice)."
    - "'chromium against the Vite dev/preview server' (207) vs management-app.md:626 'production build (vite build + vite preview)'."
    - "remoteFileStoreMockStore.seed described as for 'future DeploymentConfigService/rollback specs' (168) — forward-looking."
```

## docs/docs/app

```yaml
- path: docs/docs/app/_category_.json
  purpose: Docusaurus sidebar category for the "Using the app" section.
  covers: docs sidebar only; label "Using the app", position 3.5, links to doc id app/index.
  claims:
    - Category landing page is app/index (_category_.json:4-7)
  data_shapes: Docusaurus category JSON {label, position, link{type,id}}
  role: config (docs site)
  observations:
    - none

- path: docs/docs/app/index.md
  purpose: Section landing page — 8-step guided tour from install to running server, navigation map, core "edit ≠ deploy" rule.
  covers: whole @hyveon/web renderer route map; first-run wizard gate; Pulumi apply flow; ECS RunTask start/stop; update-dns Lambda; watchdog Lambda; Costs estimate.
  claims:
    - First launch replaces entire window with first-run wizard, no skip, until Pulumi has a state backend (index.md:26-31)
    - Wizard is five steps; bootstrap creates S3 state bucket, S3 configuration bucket, DynamoDB run-history table (index.md:33-40)
    - Wizard progress saved on every step change (index.md:42)
    - Wizard only creates the backend; ECS cluster, EFS, Lambdas, DynamoDB, Route 53 created by plan/approve/apply (index.md:45-52)
    - Add-game is a six-step wizard writing only to deployment-config.json in S3; game shows "Pending deploy" (index.md:54-66)
    - Start calls ECS RunTask against `{game}-server` task definition; no always-on service (index.md:68-72)
    - Badge STOPPED→STARTING→RUNNING; a Lambda publishes Route 53 record on RUNNING (index.md:74-76)
    - Costs makes no AWS Cost Explorer API calls ever (index.md:87-90)
    - Stop has confirmation (session-suppressible) + Undo toast; stopping deletes DNS record (index.md:92-97)
    - Watchdog Lambda stops task after configurable consecutive idle checks (index.md:99-101)
    - Route table: / , /logs, /logs/infrastructure, /costs, /games, /discord, /iac, /audit, /settings; hidden routes /games/:name, /iac/history, /iac/history/:runId (index.md:108-125)
    - Infra Logs tails "one of the app's 5 Lambda functions" (index.md:111)
    - "Editing a game never changes AWS"; start/stop is not an infrastructure operation (index.md:127-141)
  role: docs
  observations:
    - "5 Lambda functions" (index.md:111) vs repo having six Lambda packages (app/packages/lambda/{efs-seeder,followup,health-check,interactions,update-dns,watchdog}); efs-seeder not tailable — consistent with logs.md:481 but differs from CLAUDE.md "six Lambda packages (four always-on, two conditional)"
    - Step 4 says "six-step wizard" but lists five things collected (index.md:56-59) — Review is the 6th; fine but implicit
    - Related reading links /setup, /architecture, /components/infra, /guides/user, /components/management-app (index.md:145-149)

- path: docs/docs/app/dashboard.md
  purpose: Dashboard (route /) — KPI tiles, game cards, start/stop, stop confirmation, undo, file-manager modal, pending-changes banner, filtering, polling.
  covers: dashboard page + game cards in @hyveon/web; `costs.estimate` IPC channel; ECS start/stop; FileBrowser helper (filemgr-*) Fargate task; EventBridge Scheduler auto-stop; drift report; app-wide status pollers; custom title bar.
  data_shapes: drift report (games, change kinds, fields) signature in sessionStorage; counts "N to create / delete / update"
  claims:
    - KPI tiles: Servers running (running/total), Current run rate (sum $/hour of running games), Est. month cap (totalPerHourIfAllOn × 24 × days in month), Active alerts (count of error-state games) (dashboard.md:19-24)
    - Cost tiles computed only from `costs.estimate` + run state; no Cost Explorer calls; default $0.00 (dashboard.md:26-32)
    - Servers running shows em-dash when no games declared (dashboard.md:34)
    - Status badges RUNNING/STARTING/STOPPED/NOT DEPLOYED/ERROR; NOT DEPLOYED = stack has no outputs (dashboard.md:47-53)
    - State changes announced to screen readers (dashboard.md:55-56)
    - ERROR card shows backend-supplied reason (dashboard.md:58-61)
    - Connect string: hostname, else public IP, else "no hostname"; copy button copies hostname (or IP), no confirmation (dashboard.md:63-73)
    - Stat tiles Last run (state not timestamp), $ per hour, Task (first 8 chars of task ID) (dashboard.md:77-83)
    - ERROR state shows Start to allow retry (dashboard.md:93)
    - Card locks 3 seconds after Start/Stop then re-fetches that game's status, even on failure (dashboard.md:95-97)
    - Stop confirmation "Don't ask again for this session" is global, in-memory, recorded only on confirm (dashboard.md:107-128)
    - Undo toast 5 seconds; Undo issues start + status refresh (dashboard.md:130-135)
    - File manager launches on-demand FileBrowser Fargate container mounting the game's EFS access point read-write; http://<ip>:8080 link (dashboard.md:137-161)
    - Per-launch random password, bcrypt-hashed, no --noauth; username admin; plaintext shown once (dashboard.md:163-169)
    - One helper per game; auto-stop after 2 hours via EventBridge Scheduler one-time schedule calling ecs:StopTask; Stop cancels the schedule; watchdog ignores filemgr-* tasks (dashboard.md:173-180)
    - File manager SG declares no ingress; app opens 8080 at runtime for operator <ip>/32 (dashboard.md:181)
    - Interactive Files sessions plain http (cleartext password); folder-upload helpers use HTTPS with pinned per-launch cert (dashboard.md:182-186)
    - Modal polls every 5s while transitioning (dashboard.md:187-188)
    - Pending-changes banner checked every 30s; dismissal keyed to drift signature in session storage; cleared when apply clears drift (dashboard.md:195-224)
    - Filter matches name or hostname/IP case-insensitive substring (dashboard.md:226-231)
    - First-poll failure shows "Couldn't load game status" + Retry (dashboard.md:241-245)
    - Status polled every 20s app-wide; stale pill after two missed intervals; Refresh forces all pollers; LIVE pill (dashboard.md:247-258)
    - Top bar is window title bar; Linux shows in-app min/max/close since OS title bar hidden (dashboard.md:260)
    - costs.estimate fetched once on mount (dashboard.md:262-268)
  role: docs
  observations:
    - Linux in-app window buttons (dashboard.md:260) — user memory notes a pending migration to native titleBarOverlay (PR #531 TODO); doc will go stale when that lands
    - Lines 70 and 72 are unwrapped long lines inside otherwise hard-wrapped prose (mixed wrap style; CLAUDE.md says no hard wrap)
    - Copy-button text at dashboard.md:72-73 says "the button still copies the hostname" — consistent with line 70
    - FileBrowser HTTP-cleartext caveat (dashboard.md:182-186) relevant to embed-file-browser openspec change in flight (openspec/changes/embed-file-browser)

- path: docs/docs/app/games.md
  purpose: Games screen (/games) — games table with status chips, six-step Add-game wizard (Identity/Resources/Networking/Storage/Environment/Review), draft autosave, detail page, folder seeding upload, edit, remove, concurrency caveat.
  covers: games page, add-game wizard, game-detail page in @hyveon/web; GameServerConfig fields (name, image, connectMessage, cpu, memory, ports{container,protocol,visibility}, https, webPort, healthCheck{scheme,port,method,timeout,path,jsonPath,operator,value,credential}, volumes, fileSeeds{path,content,contentBase64,mode}, environment, command, pinned hostname); deployment-config.json in S3; draft store in Electron main (electron-store); folder-seed upload via file-manager helper; Secrets Manager app-owned secrets.
  data_shapes: GameServerConfig (above); port entry `{ "container": 8, "protocol": "icmp" }` (games.md:150); Basic credential secret JSON {"username","password"} (games.md:220); folder selection (path, includes, destination) per game local
  claims:
    - Create/edit/remove only updates deployment-config.json; removal leaves task def, EFS AP, SG rules live (games.md:13-24)
    - Table lists declared then deployed-but-undeclared; no sort/filter; fetched once on open (games.md:28-46)
    - Ports column formats, ICMP `8/icmp`, HTTPS leads with web port `30000 (web)` (games.md:39)
    - Status chips In sync / Config drift / Pending deploy / Undeclared; drift compares declared vs last-applied stack outputs on image, CPU, memory, ports, volumes — never live AWS (games.md:56-83)
    - Wizard "Add a game server", Step N of 6 (games.md:88-91)
    - Name: lowercase DNS-safe label 1-32 chars, unique; becomes map key, `{name}-server` family, `/ecs/{name}-server` log group, DNS label; immutable (games.md:99,105-108)
    - Connect message placeholders only {host},{ip},{port},{game}; HTTPS renders `https://{host}` and {port}=443 (games.md:101-103)
    - Fargate CPU/memory tier table 256…16384 units (games.md:118-126); live hourly cost estimate in step (games.md:129-132)
    - Ports: protocol TCP/UDP/ICMP, visibility Public/VPC-only; VPC-only is VPC-wide reachability (games.md:138-146)
    - ICMP rows: type 0-255, default 8, never an ECS port mapping, only SG ingress; Palworld reference case (games.md:148-150)
    - ICMP incompatible with https: true (games.md:152, 169)
    - Same-game and cross-game port collision checks are hard blocks; cross-game exempts icmp if visibility matches (games.md:154-161)
    - Zero ports allowed by wizard (games.md:161)
    - HTTPS (Caddy sidecar) opens 443 and 80 for the whole stack; ACME issuance on first boot needs hostname resolving to task (games.md:163)
    - webPort required for https, 1-65535, not 80/443; additional ports honour visibility; tcp extra duplicating webPort rejected (games.md:167-171)
    - Legacy HTTPS configs without webPort: ports[0] promoted to webPort at read time (not written back); deprecated; legacy ports[1..] become ingressed on next apply (games.md:173-181)
    - Optional authoritative health check: scheme, port (from declared ports/webPort), method GET/POST/PUT/PATCH/HEAD, timeout 100-10000ms, path, JSON path, operator equals/notEquals/greaterThan/lessThan/contains/exists, value, credential type None/Raw ARN/Basic/Bearer (games.md:183-209)
    - Basic/Bearer secrets app-owned, named `hyveon-{game}-healthcheck-auth`; credential never returned; switching to None deletes app-owned secret; removing game deletes it (games.md:211-241)
    - Storage: ≥1 EFS volume, default `data` → `/data`, absolute path; file seeds path/content/base64/mode, blanks dropped (games.md:243-264)
    - Environment: name non-empty, unique; no charset restriction unless IPv4 token used (games.md:266-288)
    - Tokens `${hyveon.network.public-address}` (deploy-time hostname) and `${hyveon.network.public-ipv4}` (boot-time); unknown ${hyveon.*} rejected (games.md:290-306)
    - IPv4 token requires shell-identifier name and a Start command; resolver script retries wget/curl up to 30 times, exports, execs command; exits non-zero on failure; image needs POSIX shell (games.md:308-338)
    - Pin hostname (Node.js only) via NODE_OPTIONS preload; hostname 1-63 chars [A-Za-z0-9._-]; reserves `/hyveon/hostname-shim` path and `hostname-shim` names (games.md:340-373)
    - Review step four cards; secrets/credentials/seed contents never displayed (games.md:375-388)
    - On submit: toast, navigate to detail; wizard never runs plan/apply or uploads (games.md:390-396)
    - Validation as-you-type; Next blocked by current step errors only; server rejection jumps to offending step (games.md:398-408)
    - Draft autosave ~1s debounce, flush on close, best-effort, saved by Electron main process; single draft slot; env values/file contents/credentials stripped from resumed draft (games.md:410-470)
    - Detail page cards Container/Web port/Ports/Volumes/Env/File seeds/Connect message/Seed from folder; ghost-entry variant for Undeclared (games.md:472-509)
    - Folder seeding: native dialog scan, symlinks skipped, tree include/exclude, destination inside a volume path, no ./.. segments; selection stored per game locally not in deployment-config.json (games.md:511-539)
    - Upload only after apply; disabled while game running/starting; conflicts with an open file-manager session (games.md:541-555)
    - Upload helper accepts only operator IP, TLS with per-launch cert; up to 4 concurrent files; verify phase; 3 retries per file (games.md:553-594)
    - Overwrite warning: new/identical/conflict classification; up to 20 conflicts listed; 10-minute answer timeout; resume treats ≤4 conflicts as partial files (games.md:574-592)
    - Startup sweep for helpers >15 minutes (games.md:600-603)
    - Edit form: same 5 sections, Name disabled, ports checked against other games only (games.md:605-639)
    - Remove: type exact case-sensitive untrimmed name; then shows Undeclared (games.md:641-656)
    - Optimistic-lock (S3 version/etag) plumbing exists but UI screens issue unconditional writes → last-write-wins (games.md:658-678)
  role: docs
  observations:
    - Concurrent-edit section admits UI does not opt into optimistic lock (games.md:673-678) — known gap; contrast settings.md:326-331 where General form DOES send version tag
    - Error message "Optimistic lock failed: expected etag ..." (games.md:666) mentions etag while prose says "object version" (games.md:662) — terminology mismatch
    - "Step 3 of the wizard" for health-check (games.md:621) — health check is under Step 3 Networking, consistent
    - games.md:146 says VPC-only detail is in Infra program reference; cross-doc dependency
    - Mixed wrap style: newer sections one-sentence-per-line (games.md:138-181, 340-373, 511-603) vs older hard-wrapped prose
    - Detail-page Seed from folder card ties to openspec/changes/embed-file-browser (in flight); "File manager helper" for uploads described as HTTPS w/ pinned cert, distinct from dashboard Files modal http
    - Mentions Palworld/Foundry VTT as reference cases (games.md:150,167,346)

- path: docs/docs/app/iac.md
  purpose: Infrastructure screen (/iac) — plan/approve/apply flow, plan-hash gate, partial-apply handling, workspace-busy/stale locks, destroy, run history, run detail, rollback.
  covers: PulumiService (Automation API stack.preview()/stack.up()/destroy, initializeStack), plan artifact `<runId>.plan.json`, pulumi.log redaction, run-history DynamoDB records (kind, status, partialApply), durable run lock, S3 backend lock, destroy token, config rollback via S3 object versions, /iac/history, /iac/history/:runId.
  data_shapes: run record {kind: plan|apply|destroy, status: success|failed|aborted, partialApply?, approver, configVersionId, planHash, engineVersion, rollback provenance}; change-summary counts create/update/replace/delete/other/unchanged
  claims:
    - Strict sequence Run plan → Approve plan → Apply; destroy isolated (iac.md:17-23)
    - Plan = stack.preview() via Automation API, writes `<runId>.plan.json` to disk; live streaming (iac.md:25-33)
    - Environment values ≥4 chars redacted to `***REDACTED***` in streamed log and pulumi.log during plan and apply (iac.md:35-47)
    - Only one Pulumi operation at a time (iac.md:49-50)
    - Change-summary badges from Pulumi resource-change counts; "Change summary unavailable" / "No changes — N unchanged" fallbacks (iac.md:52-77)
    - Approver name from OS user, never page-supplied (iac.md:79-84)
    - Approval valid 15 minutes; re-approve restamps same plan; countdown re-evaluated ~30s (iac.md:92-107)
    - Apply gate order: run exists & is plan; approved; not expired; page hash = approval hash; re-hash of artifact bytes + config version id matches; engine version matches plan record (iac.md:109-131)
    - Apply reuses plan run ID (iac.md:133-134)
    - "Apply stopped partway through" banner when step events show mutation; no retry, only Start over; `partial` badge (iac.md:141-159)
    - PulumiService.apply writes durable in-doubt marker (kind 'apply', partialApply: true) before stack.up(); settlement overwrites; resubmission refused because kind no longer 'plan' (iac.md:161-180)
    - Busy banner relabels preview/up → plan/apply (iac.md:182-193)
    - Apply durable lock self-releases after one hour (iac.md:195-196)
    - Apply and destroy take durable run lock; plan only in-memory lock; "Clear lock and retry" with confirmation; no auto-resubmit (iac.md:198-211)
    - State locking is S3 backend lock object, not DynamoDB; stale backend lock banner lists holders (username, hostname, PID, age) (iac.md:213-224)
    - Start over is a pure UI reset (iac.md:226-233)
    - Destroy: type exact "destroy infrastructure", single-use token expiring 5 minutes; no plan/approve; runs no-op inline program so works if config missing/malformed (iac.md:235-270)
    - Run history: Kind/Status/Changes/Started/Completed/Approver/Rollback; statuses Success/Failed/Aborted; apply placeholder record status 'aborted' written before run (iac.md:272-296)
    - Kind filter client-side, Status filter server-side; cursor pagination 25/page (iac.md:298-317)
    - Run detail read-only; log from local file, inline record copy, or S3 offload (iac.md:319-335)
    - Run detail lookup searches only 100 most recent runs → older runs 404; runs live in DynamoDB with no expiry (iac.md:337-349)
    - Rollback: apply rows with recorded config version; resolve (read-only) then confirm; writes historic content as new S3 head version (append-only); auto-starts a plan that still needs approve/apply; tagged `Rollback of apply run <id>` (iac.md:351-384)
  role: docs
  observations:
    - "That last check is the important one" (iac.md:128) refers to the plan-hash check (item 5) but item 6 (engine version) is now the last in the list (iac.md:123-126) — stale wording after engine-check was added
    - Inconsistency: iac.md:146-150 says "partial" badge appears only when flag set; iac.md:290-296 says apply placeholder writes `status: 'aborted'` while iac.md:165 says marker writes `partialApply: true` unconditionally — implies a crashed-before-settle run shows Aborted + partial badge; not stated explicitly, worth checking
    - Run detail 404 cap of 100 most recent runs (iac.md:341-345) is a documented limitation
    - Anchor link /components/infra#state-backend--self-managed-s3-no-dynamodb-lock-table (iac.md:216) matches heading at docs/docs/components/infra.md:50
    - Example approver "chris" and date 26/07/2026 (iac.md:90)
    - No Terraform/ALB references; "infra program" terminology current

- path: docs/docs/app/discord.md
  purpose: Discord screen (/discord) — readiness badge, Get started checklist, Credentials/Guilds/Admins/Per-Game Permissions tabs, CloudFront-fronted interactions domain, permission evaluation order.
  covers: Discord page in @hyveon/web; Secrets Manager bot token/public key; redacted config shape (botTokenSet/publicKeySet); command registrar; interactions Lambda; DynamoDB Discord config table with BASE#discord row; app/packages/infra/src/discordDomain.ts (ACM us-east-1, CloudFront, A/AAAA alias); canRun evaluation order.
  data_shapes: redacted config `{ botTokenSet: Boolean(botToken), publicKeySet: Boolean(publicKey) }` (discord.md:88-91); per-game permission entry {userIds, roleIds, actions[start,stop,status]}; base config fields baseAllowedGuilds/baseAdminUserIds/baseAdminRoleIds
  claims:
    - Bot fully serverless; Discord calls Lambda over HTTPS which verifies signature, allowlist, permissions (discord.md:15-18)
    - Readiness badge: ready = token+public key stored and endpoint URL published; "incomplete" label unreachable in practice (discord.md:22-31)
    - Badge does not check Application ID, guilds, or command registration (discord.md:33-39)
    - Get started card shown when no app-added guilds; 4 steps (discord.md:41-57)
    - Application ID must be 17–20 digit snowflake; secrets masked; input always starts empty (discord.md:71-81)
    - Secrets never echoed — server-side collapse to booleans; only registrar fetches real token (discord.md:83-96)
    - Interactions Endpoint URL is CloudFront custom domain `https://discord.{hostedZoneName}/`, not raw Function URL (discord.md:98-104)
    - Save public key before pasting URL (Discord PING signature verify) (discord.md:111-115)
    - discordDomain.ts always provisions ACM cert in us-east-1 (DNS-validated), CloudFront (caching disabled, origin = Function URL), A+AAAA alias; unconditional; needs ACM perms in us-east-1 (discord.md:121-140)
    - Save credentials always sends Application ID; secrets only if typed (discord.md:142-150)
    - Guild allowlist enforced by interactions Lambda; takes effect next interaction (Lambda re-reads config each invocation) (discord.md:154-171)
    - Commands registered per guild only, bulk overwrite with /server-start, /server-stop, /server-status, /server-list (discord.md:183-198)
    - Register all is sequential, per-guild toasts, continues on failure; registered badge session-local optimistic (discord.md:193-214)
    - Base guilds from Settings (baseAllowedGuilds) in BASE#discord row rewritten by infra on every apply; app read-only; server refuses removal (discord.md:216-235)
    - Remove guild requires typing full ID exactly (discord.md:237-249)
    - Admin chip input: Enter/comma/blur/paste-split; invalid tokens returned to input; save replaces both lists atomically (discord.md:253-293)
    - Base admins unioned with app-managed at runtime (discord.md:295-306)
    - Per-game permissions: rows for every known game; needs ID match AND action ticked; autocomplete respects same rules (discord.md:310-338)
    - Evaluation order: guild allowlist → admin user → admin role → per-game entry → deny (discord.md:340-341)
    - Clear deletes entry; admins bypass (discord.md:349-358)
    - Config unavailable state when infra hasn't published table name/secret ARNs (discord.md:372-382)
    - 11-item checklist for working bot (discord.md:387-407)
  role: docs
  observations:
    - Clear-permissions dialog copy says "recoverable from infrastructure-as-code" (discord.md:352-353) — per-game permissions are app-managed DynamoDB data, so claim seems inaccurate/stale (possibly Terraform-era wording)
    - discord.md:367-368 admits empty-state message also shown on games-list load failure (UX gap)
    - "Incomplete" badge branch documented as unreachable dead code (discord.md:31)
    - CloudFront/ACM in discordDomain.ts — note CLAUDE.md invariant "no ALB, target group, or ACM certificate anywhere in the stack" (TLS via Caddy) conflicts with this ACM cert for discord domain; architecture invariant wording vs this doc should be reconciled
    - discordDomain.ts exists (verified app/packages/infra/src/discordDomain.ts)

- path: docs/docs/app/logs.md
  purpose: Logs screens — Game Logs (/logs) CloudWatch tail per game and Infra Logs (/logs/infrastructure) tail per Lambda; search, autoscroll, pause buffer, 300-line window with historical paging.
  covers: logs.page.tsx, infrastructure-logs.page.tsx, LogTailView component, useLogTail hook (WINDOW_SIZE = 300 in app/packages/web/src/hooks/use-log-tail.hook.ts:16), CloudWatch log groups `/ecs/{game}-server` and `/aws/lambda/{projectName}-{functionKey}`; defineEcs in @hyveon/infra; IPC log channels get/getOlder/getNewer.
  claims:
    - Log group `/ecs/{game}-server` created by defineEcs per gameServers entry (logs.md:290-294)
    - Snapshot of newest stream then live tail polling every 2s from subscribe time (logs.md:296-301)
    - Not-deployed error copy; "No log streams found for <game>." rendered as log line (logs.md:303-308)
    - Combobox search; selecting a game clears buffer, discards paused buffer, resets to Live, clears errors, re-fetches (logs.md:310-331)
    - Card Logs button pre-selects; direct open selects first game (logs.md:330-331)
    - ANSI 16 colours + bold rendered (logs.md:333-338)
    - Search highlights all occurrences, case-insensitive, never filters (logs.md:340-350)
    - Autoscroll default on; suppressed while paused (logs.md:352-358)
    - Pause buffers lines (uncapped); footer "buffered N"; Resume flushes keeping newest 300 (logs.md:360-383, 431-437)
    - 300-line window (WINDOW_SIZE in useLogTail); scroll-up historical mode pages older across multiple streams; "— Beginning of log retention —" on empty fetch (logs.md:385-404)
    - Historical mode buffers live lines; Jump to latest only exit; discards and reloads snapshot (logs.md:406-425)
    - Narrow window collapses search/autoscroll behind Filters (logs.md:439-445)
    - Error copies incl. `IPC bridge (window.hyveon) is not available in this context.`; transient errors inline `[stream error]` (logs.md:447-469)
    - Infra Logs: 5 function buttons watchdog, health-check, dns-updater, interactions, followup; watchdog default; no mobile filter drawer (logs.md:471-481)
    - Lambda log group `/aws/lambda/{projectName}-{functionKey}`, projectName fallback `hyveon` (logs.md:482)
    - health-check log group conditional on any game declaring healthCheck; informational message, tail stops (logs.md:484)
    - Page does not show app logs (Settings → Diagnostics) or Pulumi output (logs.md:486-493)
  role: docs
  observations:
    - efs-seeder Lambda package (app/packages/lambda/efs-seeder) is not among the 5 tailable functions (logs.md:481) — either intentionally excluded or a coverage gap
    - Function key "dns-updater" vs package dir "update-dns" (logs.md:481) — naming divergence to verify against LambdaFunctionKey type
    - "In normal tailing this works the same as before" / "What changed is" (logs.md:388-391) — change-history narration in user docs
    - Doc says useLogTail; actual file is use-log-tail.hook.ts (WINDOW_SIZE=300 confirmed at :16)
    - window.hyveon bridge name (logs.md:466) — post-rebrand; no `gsd` leftovers here

- path: docs/docs/app/costs.md
  purpose: Costs screen (/costs) — per-game Fargate estimate table, Cost Explorer console link-out, formulas and caveats.
  covers: costs page; `costs.estimate` path using ECS DescribeTaskDefinition; stack output `gameNames`; Project=hyveon cost-allocation tag.
  claims:
    - No Cost Explorer API calls ever; removed end-to-end (costs.md:8-13, 19-26)
    - Estimates from DescribeTaskDefinition (not billed) (costs.md:25-26)
    - Static link to Cost Explorer console home (costs.md:30-34)
    - All resources tagged Project=hyveon (costs.md:36-40)
    - Rows come from stack outputs `gameNames`, not deployment-config.json; empty before first apply (costs.md:44-48)
    - Default sort $/hour desc; numeric desc / Game asc on new column; filter substring; narrow → cards w/o sort (costs.md:59-67)
    - $/hour = vCPU × $0.04048 + GB × $0.004445; $/day ×24; $/month ×4×30 (120h) (costs.md:73-86)
    - Fargate compute only; hardcoded us-east-1 on-demand rates (costs.md:88-94)
    - Unreadable task definition silently falls back to 2 vCPU / 8 GB (costs.md:96-98)
    - Fetched once on load (costs.md:100)
  role: docs
  observations:
    - STALE PATH: costs.md:24 cites `openspec/changes/remove-cost-explorer-calls`; change is archived at openspec/changes/archive/2026-08-06-remove-cost-explorer-calls
    - Silent 2 vCPU/8 GB fallback with no indicator (costs.md:96-98) — documented UX quirk
    - "Earlier versions of this page called it automatically" (costs.md:21-24) — history narration
    - Region-hardcoded rates (costs.md:93-94) is a known inaccuracy
    - Dashboard "Est. month cap" uses 24×days-in-month (dashboard.md:23) vs Costs $/month 4h×30 (costs.md:81) — two different monthly figures; costs.md:104-109 acknowledges distinctness

- path: docs/docs/app/audit.md
  purpose: Audit screen (/audit) — table of config writes and IaC workspace ops with before/after JSON.
  covers: audit page; audit DynamoDB table (`${projectName}-audit`); actions add/edit/remove/plan/approve/apply/destroy/rollback; deployment-config.json S3 version IDs; BootstrapService.
  data_shapes: audit entry {timestamp, actor (OS username), action, game?, configVersion?, before, after}
  claims:
    - Entries for game config writes (add/edit/remove) and IaC ops (plan/approve/apply/destroy/rollback) (audit.md:14-28)
    - IaC entries written when a run starts, not on success (audit.md:30-32)
    - Not recorded: start/stop, Discord config, watchdog settings, out-of-app changes (audit.md:37-40)
    - Action badge colours (audit.md:51)
    - Actor is local OS username, not AWS identity (audit.md:57-62)
    - Version = S3 object version of deployment-config.json; requires bucket versioning, enabled by BootstrapService (audit.md:64-71)
    - approve/apply never carry version; plan only if request supplied configVersionId; rollback always (audit.md:73-76)
    - Diff is plain pretty-printed JSON, no highlighting (audit.md:78-102)
    - 25 per page, Load more, no filter/search (audit.md:104-107)
    - Missing audit table → empty state not error; audit writes best-effort, never block (audit.md:118-122)
  role: docs
  observations:
    - "Discord configuration changes ... watchdog settings" not audited (audit.md:37-38) — but watchdog settings now live in deployment-config.json via Settings→General (settings.md:256-273); unclear whether General-form saves generate audit entries; also Settings General writes (projectName, region, etc.) not listed in action table
    - "Infrastructure workspace operations" table lists five but text says "The four Infrastructure actions and rollback" (audit.md:34) — consistent (plan/approve/apply/destroy + rollback)
    - apply audit not linked to plan record (audit.md:73-74) — documented limitation

- path: docs/docs/app/settings.md
  purpose: Settings screen (/settings) — Watchdog pointer, Cloud Health checks, Cloud Setup (engine version + Reconfigure), Updates (auto-update, Check Now, Download & install), General deployment-settings editor, Diagnostics (log tail, export bundle, stray-helper cleanup).
  covers: settings page; watchdog-panel component; Cloud Health ECS service-linked role check + CreateServiceLinkedRoleCommand fix; HyveonDeployAll policy; PULUMI_ENGINE_VERSION (@hyveon/shared pulumiVersion.ts = 3.255.0); PulumiEngineService; electron-store enableAutoUpdate; initUpdater/checkForUpdatesNow/downloadUpdateNow/installDownloadedUpdate in electron-entry.ts / updater; IPC iac.settings.autoUpdate.{get,download,install}; electron-updater; DeploymentConfig top-level fields; winston main-YYYY-MM-DD.log; diagnostics bundle zip; file-manager helper sweep.
  data_shapes: DeploymentConfig top-level fields: projectName, region, vpcCidr, hostedZoneName, dnsTtl, discordApplicationId, watchdog interval/idleChecks/minPackets, baseAllowedGuilds, baseAdminUserIds, baseAdminRoleIds, auditTableName, runsTableName; diagnostics bundle sections Logs/Config summary/Metadata/AWS snapshot + errors.json
  claims:
    - Six sections: Watchdog Configuration, Cloud Health, Cloud Setup, Updates, General, Diagnostics (settings.md:23-24)
    - Watchdog panel read-only; former server_config.json Save flow removed (#348) (settings.md:33-45)
    - Cloud Health: one check — AWSServiceRoleForECS; absence breaks RunTask with InvalidParameterException; runs on mount + Refresh only (settings.md:47-65)
    - Fix calls CreateServiceLinkedRoleCommand; AccessDenied → show HyveonDeployAll JSON, deep link, Download JSON; bare policy, not CFN template (settings.md:74-97)
    - Pinned engine `PULUMI_ENGINE_VERSION`, downloaded/cached by PulumiEngineService, no host binary (settings.md:99-122)
    - Reconfigure swaps page with no confirmation; Provision AWS access writes active credential immediately (settings.md:124-147)
    - App Version via app.getVersion() returned with auto-update flag by `iac.settings.autoUpdate.get` (settings.md:151-153)
    - enableAutoUpdate in electron-store, off by default; initUpdater once at boot (electron-entry.ts); autoDownload/autoInstallOnAppQuit pinned false; fallback retry to newest release with feed (settings.md:155-190)
    - Check Now independent of toggle; outside Electron reports "only available in packaged app" (process.versions.electron) (settings.md:192-222)
    - Feed fallback: newest non-prerelease among 10 most recent releases with latest.yml (settings.md:214)
    - Download & Install via iac.settings.autoUpdate.download / .install, only path that installs (settings.md:224-234)
    - General edits every top-level DeploymentConfig field except gameServers (settings.md:236-254)
    - Watchdog defaults: interval 15 min, idle checks 4, min packets 100; baked into EventBridge `rate(<n> minutes)` + env vars at apply (settings.md:256-273)
    - Idle counter stored as ECS task tag (settings.md:288-289)
    - Base Discord lists written to BASE#discord row on every deploy (settings.md:291-302)
    - Audit/runs table names default to `${projectName}-audit` / `${projectName}-runs` (settings.md:304-310)
    - Client validation mirrors backend; version tag sent on save → conflict rejection with Reload (settings.md:312-332)
    - Diagnostics: last 500 lines of today's main-YYYY-MM-DD.log, polled every 5s, includes forwarded renderer console/errors (settings.md:334-362)
    - Pause holds snapshot, Resume replaces view (settings.md:364-379)
    - Export diagnostics bundle: native save dialog, local only, 4 sections + errors.json, secret scrubbing, allowlist config summary, no partial zip (settings.md:405-446)
    - Clean up stray helpers: stops unowned helpers regardless of age, deregisters task def, revokes SG rule; startup sweep only >15 min (settings.md:448-459)
  role: docs
  observations:
    - Explicit screenshot-stale note (settings.md:14-21): settings.png predates General, read-only Watchdog panel, Diagnostics controls; also caption at settings.md:12 describes "a General placeholder" — stale image + alt text
    - settings.md:23 lists "Cloud Health" and "Updates" sections, but screenshot caption (settings.md:12) omits them
    - DNS TTL field described as "TTL on the per-game DNS A records the watchdog Lambda writes" (settings.md:250) — CONTRADICTION: per index.md:75 and CLAUDE.md, DNS records are written by the update-dns Lambda, not watchdog
    - "Watchdog tuning (3 fields) | `dnsTtl`'s siblings" (settings.md:252) — odd phrasing
    - server_config.json reference (settings.md:40) is history; still referenced in watchdog-panel.component.tsx:4 comment
    - Issue ref "#348" in user docs (settings.md:42)
    - Pinned version example "v3.255.0" (settings.md:104) matches PULUMI_ENGINE_VERSION = '3.255.0' (app/packages/shared/src/pulumiVersion.ts:21) — will drift on bump
    - GitHub Releases URL github.com/CoderCoco-Studios/Hyveon (settings.md:209)
    - Updates newer content is one-line-per-sentence; older prose hard-wrapped (mixed style)
    - Diagnostics "Logs" section of bundle and Updates section of electron-store vs Cloud Setup — Settings is a grab-bag of unrelated capabilities (UI composition, not behaviour)

- path: docs/docs/app/first-run-wizard.md
  purpose: First-run wizard — 5 steps (cloud, guided IAM provisioning, credentials, bootstrap, stack init), resume rules, Start over, Reconfigure mode.
  covers: first-run-wizard components (use-wizard-progress.hook.ts), wizard resume file, GuidedIamService-like flow (iam-bootstrap.yaml CFN template, STS GetCallerIdentity, key rotation, OS keychain/safeStorage), AwsProfileService (AWS CLI profiles, `hyveon-pasted` profile), BootstrapService (S3 state/config buckets, DynamoDB runs table, deployment-config.json seed), IamCheckService (SimulatePrincipalPolicy vs HyveonDeployAll), PulumiService.initializeStack (engine resolve, plugin install, refresh), derived secrets passphrase from AWS account ID, commitReconfigureAnswers.
  data_shapes: wizard progress/resume file (step pointer; guided-IAM sub-screen state); bootstrap resource names; seeded deployment-config.json (empty gameServers, no hosted zone); runs table pk/sk + status-index GSI
  claims:
    - Full-window, unskippable 5-step wizard; header "Welcome to Hyveon", "Step N of 5"; ≥768px shows step-progress list (first-run-wizard.md:8-27)
    - Back/Start over/Next; step 5 Finish setup; step 2 drives own advancement (first-run-wizard.md:29-34, 56-59)
    - Step 1 AWS only, pre-selected; save failure keeps you on step (first-run-wizard.md:36-47)
    - Step 2 region dropdown from static committed list grouped by continent, "Other (enter manually)" (first-run-wizard.md:63-81)
    - Guided: renders iam-bootstrap.yaml to userData path; Open AWS Console region-scoped Create stack; no reveal-in-folder (first-run-wizard.md:83-97)
    - Rotation sequence: verify pasted key via sts:GetCallerIdentity → mint new key → store in OS keychain → verify new → delete bootstrap key; pasted secret memory-only (first-run-wizard.md:99-111)
    - Bootstrap key single-use; reuse → InvalidClientTokenId (first-run-wizard.md:113-119)
    - Failure modes: verification failed (Retry rotation reusing in-memory key), deletion failed (Revoke now) (first-run-wizard.md:121-126)
    - Resume mid-rotation always lands on intake screen; template-stage resume recovers region or falls back to region screen (first-run-wizard.md:128-152)
    - Step 3 skipped to summary if guided credential established; profile mode lists AWS CLI profiles; paste mode stores under `hyveon-pasted` encrypted via keychain; refuses plaintext if safeStorage unavailable (first-run-wizard.md:154-206)
    - Region mandatory because Pulumi self-managed S3 backend has no region default (first-run-wizard.md:208-216)
    - Step 4 defaults hyveon-tfstate (versioned, AES256, no lock table), hyveon-config (versioned, noncurrent expire 90 days, AES256), hyveon-runs (pk/sk, status-index GSI, PITR), seed deployment-config.json idempotently (write only if absent) (first-run-wizard.md:226-231)
    - Created via AWS SDK, no CLI; runs table name not editable (first-run-wizard.md:233-237)
    - Concurrency: state bucket + runs table concurrent; seed chained after config bucket (first-run-wizard.md:239-244)
    - Re-run bootstrap re-asserts config idempotently (first-run-wizard.md:254-258)
    - All four must be Created/Already exists to enable Next (first-run-wizard.md:267-272)
    - IAM permission check advisory, never auto-runs, simulates HyveonDeployAll actions; Passed/Missing (paste-ready denied-actions policy)/Warning (first-run-wizard.md:274-294)
    - Step 5 auto-starts PulumiService.initializeStack: resolve pinned engine (download+verify), passphrase derived from AWS account ID (legacy migration), install @pulumi/aws plugin, pulumi refresh on empty stack (first-run-wizard.md:296-326)
    - Never resume into step 5 — clamp to step 4 (first-run-wizard.md:333-342)
    - Only step pointer restored on first-run resume (except step 2); save-progress failure → restart step 1; finishing deletes resume file (first-run-wizard.md:344-355)
    - Start over: deletes resume file, clears cloud/credential source/bootstrap names incl. pasted creds; never touches AWS resources or Pulumi passphrase (legacy stored passphrase preserved); window reloads (first-run-wizard.md:357-383)
    - Reconfigure from Settings: header "Reconfigure Hyveon"; steps 1/3/4 collapsed; step 2 collapsed only if active credential is guided profile; prefilled; buffered single save on Finish via commitReconfigureAnswers; Cancel can't undo real side effects; guided rotation writes active credential immediately (first-run-wizard.md:385-446)
  role: docs
  observations:
    - State bucket default name `hyveon-tfstate` (first-run-wizard.md:228) — "tfstate" is a Terraform-era name retained for Pulumi state bucket
    - "functionally identical to the old plain-text region input" (first-run-wizard.md:77-78) and "unchanged from narrower layouts" (first-run-wizard.md:19) — history narration
    - Step 4 intro says "three AWS resources" (first-run-wizard.md:222) but table/Next gate lists four (incl. config seed) (first-run-wizard.md:226-231, 267-269) — minor inconsistency
    - index.md:39 likewise says "three bootstrap resources"
    - Passphrase derivation + legacy migration detail defers to /components/infra (first-run-wizard.md:313)
    - Internal symbol names in user docs: PulumiService.initializeStack (:305), commitReconfigureAnswers (:436)
    - Very long, dense paragraphs in Reconfigure (first-run-wizard.md:431-446) and Step 2 resume (:138-152)
```

> Worker notes (docs/superpowers + openspec schemas/config):

Scope: 21 files (1 spec, 9 plans, superpowers-bridge schema bundle of 11 files, openspec/config.yaml). All read in full. Existence checks for referenced code done via `ls`/`[ -e ]` only; archive dirs listed, not read.

## openspec

```yaml
- path: openspec/config.yaml
  purpose: OpenSpec project config — selects the default schema for new changes.
  covers: OpenSpec CLI default schema selection for `openspec new change` / `/opsx:*`.
  claims:
    - "Project default schema is `spec-driven` (config.yaml:1). Rest of file is commented-out examples for `context:` and per-artifact `rules:` (config.yaml:3-20) — no project context or rules are actually set."
  data_shapes: "YAML: `schema: <name>`, optional `context: |` string, optional `rules: { <artifactId>: [string] }`."
  role: config
  observations:
    - "Git history shows the default flipped spec-driven → superpowers-bridge (commit 9e15fa45, 2026-08-04) and back to spec-driven (9c9235dc, 2026-08-05). The current value matches `.claude/rules/spec-driven-development.md` ('the project default remains `spec-driven`'; pass `--schema superpowers-bridge` explicitly)."
    - "No `context:` block — the Hyveon invariants in CLAUDE.md are not injected into artifact generation through this file (config.yaml:3-10 are template comments only)."
```

## openspec/schemas/superpowers-bridge

```yaml
- path: openspec/schemas/superpowers-bridge/schema.yaml
  purpose: Project-local OpenSpec schema that wires Superpowers skills (brainstorming, writing-plans, worktrees, subagent-driven-development, finishing-a-development-branch) into the OpenSpec artifact graph and apply phase.
  covers: "Artifact lifecycle for any change created with `--schema superpowers-bridge` (openspec/changes/<name>/{brainstorm,proposal,design,tasks,plan,verify,retrospective}.md + specs/**). Invokes skills `superpowers:brainstorming`, `superpowers:writing-plans`, `superpowers:using-git-worktrees`, `superpowers:subagent-driven-development`, `superpowers:finishing-a-development-branch`, `openspec-verify-change`; CLI `openspec validate --all --json`, `openspec archive -y`."
  claims:
    - "Header: name `superpowers-bridge`, `version: 1` (schema.yaml:1-2). Description declares DAG brainstorm → proposal → design → specs → tasks → plan → verify → retrospective, design required (schema.yaml:15-19)."
    - "ARTIFACT GRAPH (id | generates | template | requires):"
    - "  brainstorm | brainstorm.md | brainstorm.md | [] (schema.yaml:24-58)"
    - "  proposal | proposal.md | proposal.md | [brainstorm] (schema.yaml:60-83)"
    - "  design | design.md | design.md | [brainstorm] (schema.yaml:85-115)"
    - "  specs | specs/**/*.md | spec.md | [proposal] (schema.yaml:117-143)"
    - "  tasks | tasks.md | tasks.md | [specs, design] (schema.yaml:145-165)"
    - "  plan | plan.md | plan.md | [tasks] (schema.yaml:167-195)"
    - "  verify | verify.md | verify.md | [plan] (schema.yaml:197-309)"
    - "  retrospective | retrospective.md | retrospective.md | [verify] (schema.yaml:311-466)"
    - "  apply: requires [plan], tracks tasks.md (schema.yaml:468-470)"
    - "All output paths are relative to the change dir openspec/changes/<name>/ (implied; schema.yaml:39-40, 182-183, 215, 321)."
    - "brainstorm MUST NOT write to docs/superpowers/specs/; output is raw capture into brainstorm.md; design.md is not pre-filled (schema.yaml:38-50)."
    - "PRECHECK: brainstorm/plan STOP if their Superpowers skill is missing — no silent fallback (schema.yaml:29-34, 172-177)."
    - "plan MUST NOT write to docs/superpowers/plans/ (schema.yaml:181-183)."
    - "specs: one spec per capability in proposal; delta sections ADDED/MODIFIED/REMOVED/RENAMED; SHALL/MUST; scenarios MUST be exactly `####`; every requirement ≥1 scenario (schema.yaml:124-141)."
    - "tasks: every task MUST be `- [ ] X.Y` checkbox (apply parses them) (schema.yaml:152-158)."
    - "verify PRECHECK: commits since merge-base >0 AND `grep -c '^- \\[x\\]' tasks.md` >0 (schema.yaml:202-218); 7 checks: validate --all, task completion, delta sync state, design/spec coherence, implementation signal, front-door leak detector over docs/superpowers/specs/*.md, deferred `[~]` dogfood equivalence (schema.yaml:229-300)."
    - "verify `requires: [plan]` is graph-only; must actually run post-apply (schema.yaml:223-227). Same for retrospective `requires: [verify]` (schema.yaml:333-337)."
    - "retrospective PRECHECK: verify.md exists and `❌ FAIL` not checked (schema.yaml:316-329); §0 Evidence + §1-§6; skipped-skill 3-question rule; skip retro allowed only for trivial single-commit fixes; forward-pointer instead of rewrite (schema.yaml:339-462)."
    - "apply steps: 0 pre-flight skill/CLI check; 1 using-git-worktrees; 2 subagent-driven-development (TDD + code review transitive; executing-plans NOT supported); 3 verify; 4 retrospective BEFORE PR; 5 `openspec archive -y`; 6 finishing-a-development-branch, PR last (schema.yaml:472-575)."
  data_shapes: "OpenSpec schema YAML: {name, version, description, artifacts[{id, generates, description, template, instruction, requires[]}], apply{requires[], tracks, instruction}}."
  role: config (workflow schema)
  observations:
    - "Apply step 1 mandates `superpowers:using-git-worktrees` (schema.yaml:500-502; README.md:370-372 says it creates `.worktrees/<change-name>/`). This conflicts with the repo rule that worktrees are created only through Pane, and `guard-redirect-to-pane` blocks `EnterWorktree`/raw `git worktree add` (CLAUDE.md Git & PR workflow; .claude/rules/worktree.md). The schema text was not adapted to Hyveon."
    - "Apply step 5 runs `openspec archive -y` before the PR (schema.yaml:552-563); Hyveon's CLAUDE.md lists /opsx:sync or /opsx:archive as acceptable — schema is stricter than repo rules."
    - "schema.yaml:15-16 lists verify/retrospective in the linear chain, but they are post-apply in practice (acknowledged at schema.yaml:223-227)."
    - "Front-door leak detector (schema.yaml:258-278) will always flag docs/superpowers/specs/2026-05-10-electron-desktop-pivot-design.md, which predates the schema install (6e43e87d, 2026-08-04) → non-blocking WARNING by its own rule."
    - "Not Hyveon-specific: examples reference mvnw / Spring (templates/verify.md:118, README.md:172)."

- path: openspec/schemas/superpowers-bridge/README.md
  purpose: Upstream (JiangWay/openspec-schemas) README for the bridge bundle — install/upgrade, rationale, DAG, apply walkthrough, versioning.
  covers: Same workflow as schema.yaml; install/upgrade procedures; compatibility baselines.
  claims:
    - "Baselines: OpenSpec 1.4.1, Superpowers v5.1.0, as of 2026-06-10 (README.md:5-6, 480-482)."
    - "Integration is prompt-layer only; no Superpowers or OpenSpec CLI modification (README.md:10, 434-436)."
    - "Upgrade replaces the whole directory; the bundle is monolithic (README.md:101-108)."
    - "When to skip opsx (bug fix, test backfill, tooling, non-breaking dep upgrade, docs, config tweak) table (README.md:147-161); 5 promotion criteria (README.md:169-178); front-door anti-patterns (README.md:182-187)."
    - "Artifact DAG (README.md:195-199) matches schema.yaml requires edges; spec-driven vs bridge comparison (README.md:203-210)."
    - "Seven Superpowers touchpoints (README.md:293-303); no executing-plans fallback (README.md:305, 442-444)."
    - "Six design touches incl. evidence PRECHECKs and time-mismatched verify/retrospective (README.md:428-457)."
    - "Two version ids: schema major `version: 1`, bundle release VERSION `1.0.0` (README.md:463-478)."
  role: docs (vendored third-party)
  observations:
    - "Links to files that do not exist in this repo: `scripts/install-git-hooks.sh` (README.md:413), `../../../.github/workflows/validate-schemas.yml` and `version-check.yml` (README.md:490-491) — upstream-repo-relative paths; MISSING here."
    - "README.md:106 references `CLAUDE.md.fragment.<locale>.md`, but only `templates/adopters/CLAUDE.md.fragment.md` (no locale suffix) exists."
    - "README.md:184-185 cites schema.yaml 'lines 35-39' and '169-171' for redirection; actual lines are 38-50 and 181-183 — stale line refs."
    - "Mermaid header says 'PLANNING — 7 artifacts' (README.md:220) but subgraph contains 6; schema.yaml:562 says 'all 8 artifacts'."
    - "README.md:395 references 'Decision 3 in the design spec' — no design spec ships in this bundle."

- path: openspec/schemas/superpowers-bridge/VERSION
  purpose: Bundle release version.
  covers: Versioning of the vendored bundle.
  claims:
    - "`1.0.0` (VERSION:1)."
  role: config
  observations: []

- path: openspec/schemas/superpowers-bridge/templates/brainstorm.md
  purpose: Template for the brainstorm artifact — an HTML comment only.
  covers: openspec/changes/<name>/brainstorm.md
  claims:
    - "brainstorm.md is raw, unstructured capture; design.md reorganizes it and must not copy it (brainstorm.md:1-15)."
  role: template
  observations: []

- path: openspec/schemas/superpowers-bridge/templates/proposal.md
  purpose: Template for proposal.md.
  covers: openspec/changes/<name>/proposal.md
  claims:
    - "Sections Why / What Changes / Capabilities (New, Modified) / Impact (proposal.md:1-55)."
    - "Why must be 50-1000 chars (OpenSpec zod validation) (proposal.md:6-9)."
    - "From/To/Reason/Impact block for before/after changes (proposal.md:19-29)."
    - "Capability names: kebab-case compound noun ≥2 words (proposal.md:37-41)."
  role: template
  observations:
    - "proposal.md:37 points at `openspec/specs/README.md` for naming rules — MISSING in this repo."

- path: openspec/schemas/superpowers-bridge/templates/design.md
  purpose: Template for design.md.
  covers: openspec/changes/<name>/design.md
  claims:
    - "Sections Context, Goals/Non-Goals, Decisions (D1… Choice/Rationale/Alternatives), Risks/Trade-offs, Migration Plan (or 'N/A — …'), Open Questions (design.md:1-51)."
  role: template
  observations: []

- path: openspec/schemas/superpowers-bridge/templates/spec.md
  purpose: Delta-spec template.
  covers: openspec/changes/<name>/specs/<capability>/spec.md
  claims:
    - "Requirement text MUST contain SHALL/MUST; ≥1 `#### Scenario:`; level-4 only (spec.md:9-12)."
    - "MODIFIED must use identical normalized header and full content (spec.md:30-38)."
    - "REMOVED needs Reason + Migration (spec.md:51-61)."
    - "RENAMED uses FROM/TO inline-code lines; archive apply order RENAMED → REMOVED → MODIFIED → ADDED (spec.md:67-77)."
  role: template
  observations: []

- path: openspec/schemas/superpowers-bridge/templates/tasks.md
  purpose: tasks.md checkbox template.
  covers: openspec/changes/<name>/tasks.md
  claims:
    - "`## N. Group` headings with `- [ ] N.M` items (tasks.md:1-9)."
  role: template
  observations: []

- path: openspec/schemas/superpowers-bridge/templates/plan.md
  purpose: plan.md template for writing-plans output.
  covers: openspec/changes/<name>/plan.md
  claims:
    - "Header directs agentic workers to superpowers:subagent-driven-development (plan.md:3-4)."
    - "Checkbox states `[ ]`, `[x]`, `[~]` deferred; every `[~]` must appear in verify.md §7 (plan.md:16-21)."
  role: template
  observations: []

- path: openspec/schemas/superpowers-bridge/templates/verify.md
  purpose: verify.md report template (7 sections + Overall Decision).
  covers: openspec/changes/<name>/verify.md
  claims:
    - "§1 validate, §2 tasks, §3 delta sync, §4 design/spec coherence, §5 implementation signal, §6 front-door leak (`ls docs/superpowers/specs/*.md`), §7 deferred dogfood equivalence (verify.md:14-129)."
    - "If plan.md has any `[~]`, §7 MUST list them or decision downgrades to FAIL (verify.md:126-129)."
    - "Overall Decision: PASS / PASS WITH WARNINGS / FAIL checkboxes (verify.md:133-137) — the exact strings the retrospective PRECHECK greps for (schema.yaml:327)."
  role: template
  observations:
    - "Example row cites `LinebcIntegrationApplicationTests` / Spring actuator (verify.md:118) — upstream example, not Hyveon."

- path: openspec/schemas/superpowers-bridge/templates/retrospective.md
  purpose: retrospective.md template.
  covers: openspec/changes/<name>/retrospective.md
  claims:
    - "§0 Evidence fields (commit range, diff size, tasks ratio, hours, subagent count, deps, bugs, validate state, coverage, commit chain) (retrospective.md:9-33)."
    - "§4 skill compliance table of the 7 Superpowers skills + Deliberately Skipped Skills 3-question block (retrospective.md:53-89)."
    - "§6 promote candidates as `- [ ]` with Why/How to apply; carry-forward via `grep -A 5 '^- \\[ \\]' openspec/changes/archive/*/retrospective.md` (retrospective.md:95-126)."
  role: template
  observations: []

- path: openspec/schemas/superpowers-bridge/templates/adopters/CLAUDE.md.fragment.md
  purpose: Routing section meant to be pasted into an adopter's CLAUDE.md.
  covers: Claude session routing between direct PR / opsx change / verbal brainstorm.
  claims:
    - "Entry routing table, direct-PR skip table, 5 promotion criteria, front-door anti-patterns (fragment:9-46)."
    - "'the repository default remains `spec-driven`' — pass `--schema superpowers-bridge` explicitly (fragment:14)."
  role: template / docs
  observations:
    - "Pasted near-verbatim into Hyveon as `.claude/rules/spec-driven-development.md` (that rule says 'project default' instead of 'repository default' and drops the header comments). Two copies of the same routing text; the upstream fragment is the source."
```

## docs/superpowers/specs

```yaml
- path: docs/superpowers/specs/2026-05-10-electron-desktop-pivot-design.md
  purpose: Historical design spec (Draft, 2026-05-10) for pivoting Hyveon from a Docker-hosted Nest+React web app to an Electron desktop app that runs terraform locally.
  covers: "Overall architecture of @hyveon/shared, @hyveon/cloud-aws, @hyveon/desktop-main (renamed from @gsd/server), @hyveon/desktop-preload, @hyveon/web, Lambda packages, @hyveon/scripts; IPC transport (`nestjs-electron-ipc-transport`); cloud-provider interfaces; first-run wizard; tfvars sync; TerraformService; logs streaming; storage layout; electron-vite/electron-builder build; test tiers; GitHub issue/epic migration (epics A-G, M1-M4)."
  claims:
    - "Status: 'Draft, awaiting user review' (spec:4)."
    - "Non-goals: no bundled terraform/aws CLI; single-operator desktop; AWS-only v1; unsigned, auto-update disabled; no Docker-compose back-compat (spec:13-17)."
    - "Decisions: S3 as remote source of truth for tfvars; local terraform CLI with S3 backend + DynamoDB lock; IPC via nestjs-electron-ipc-transport, no HTTP listener; provider-interface seams; DiscordEventReceiver; no desktop auth, ApiTokenGuard removed; Win NSIS / macOS DMG / Linux AppImage (spec:21-30)."
    - "Renderer never talks to AWS; every call goes through preload `window.gsd.*` (spec:67)."
    - "Four interfaces CloudProvider / SecretsStore / RemoteFileStore / DiscordEventReceiver in @hyveon/shared, AWS impls in @hyveon/cloud-aws, bound by CloudProviderModule (spec:108-161)."
    - "terraform/ split into terraform/aws/ + top-level composer (spec:165-177)."
    - "First-run wizard: detect terraform/aws CLIs, pick cloud, credentials (profiles or pasted keys via safeStorage in `creds.aws.<profile>`), bootstrap S3 state + DynamoDB lock + tfvars bucket, IAM checklist from `GameServerDeployAll` + SimulatePrincipalPolicy, terraform init (spec:183-199)."
    - "Tfvars at `s3://${bucket}/tfvars/terraform.tfvars.json`, IfMatch etag, 412 conflict modal, history in userData/tfvars-history (spec:203-209)."
    - "TerraformService init/plan/apply/destroy/output, mutex, `${project_name}-runs` DynamoDB run records, ANSI preserved (spec:213-229)."
    - "Logs via IPC `logs.stream.start` + chunk/end channels, `gsd.logs.stream` async iterable (spec:233-242)."
    - "Storage table: electron-store, safeStorage creds, logs `userData/logs/main-${date}.log` (spec:261-270)."
    - "electron-builder appId `dev.gsd.desktop`, extraResources terraform + lambda bundles (spec:291-314)."
    - "Auto-update: electron-updater in desktop-main/updater.ts, disabled by default, `enableAutoUpdate` flag (spec:320)."
    - "Test tiers: unit unchanged, e2e via Playwright `_electron.launch()` + `window.gsd.__test.mock`, integration in-process Nest + aws-sdk-client-mock; `app/test/fake-terraform.mjs` (spec:324-332)."
    - "Risk mitigation: lint rule banning @aws-sdk/* from @hyveon/web; preload has zero AWS SDK (spec:421)."
  role: docs (historical design spec)
  observations:
    - "Heavily superseded. Terraform → Pulumi Automation API (archive 2026-08-10-migrate-iac-to-pulumi; CLAUDE.md 'no host-installed pulumi binary'); spec's whole terraform model (spec:24, 163-229, 270, 297-314, 332) is stale."
    - "`window.gsd.*` preload namespace (spec:43, 67, 87, 237, 242, 329) — the bridge is now `window.hyveon.*` (plans bootstrap-7:136, bootstrap-8:23; archive 2026-07-28-rename-gsd-to-hyveon). gsd leftovers also: `appId: dev.gsd.desktop` (spec:294), `@gsd/server` (spec:81, 372)."
    - "`GameServerDeployAll` policy name (spec:195) — now `HyveonDeployAll` (CLAUDE.md, docs/docs/setup.md)."
    - "Tfvars model (spec:203-209) superseded by `deployment-config.json` in the S3 configuration bucket (CLAUDE.md invariant)."
    - "Cost Explorer `getActualCosts` (spec:61, 117-118) — archive 2026-08-06-remove-cost-explorer-calls exists."
    - "Wizard step 1 'detect terraform/aws CLIs' (spec:185) contradicts current WIZARD_STEPS `['pick-cloud','guided-iam','credentials','bootstrap','stack-init']` (app/packages/shared/src/wizardSteps.ts:9)."
    - "Lambda list names four Lambdas (spec:97-99); repo now has six packages (efs-seeder, followup, health-check, interactions, update-dns, watchdog under app/packages/lambda/)."
    - "`@hyveon/scripts` / init-parent (spec:101-103) — not in CLAUDE.md's workspace list."
    - "`fix-path`, `nestjs-electron-ipc-transport`, CloudProviderModule, `app/test/fake-terraform.mjs`, desktop-main/updater.ts — not verified in this part; flag for cross-check."
    - "Status still 'Draft, awaiting user review' (spec:4) even though the pivot shipped."
    - "Predates superpowers-bridge install (be29df09, 2026-05-10 vs schema 6e43e87d, 2026-08-04) → a legitimate pre-existing file under the schema's leak detector (schema.yaml:276-278)."
    - "spec:428 says the next step is the writing-plans skill; no matching plan in docs/superpowers/plans/ (commit 1fd8247f 'remove accidentally committed superpowers plan artifact' suggests one was removed)."
```

## docs/superpowers/plans

All nine plans are SDD per-group prompts (Context / Global Constraints / Task N) for two OpenSpec changes. Shipped status from `openspec/changes/archive/` listing plus git log of these files.

```yaml
- path: docs/superpowers/plans/bootstrap-1-cfn-template.md
  purpose: SDD plan for Group 1 of add-one-click-aws-bootstrap — HyveonDeployAll statement generator + static CloudFormation template + resolver.
  covers: "app/packages/shared/src/iamPolicy.ts (HYVEON_DEPLOY_ALL_ACTIONS, new HYVEON_DEPLOY_ALL_STATEMENTS + generator), iamPolicy.test.ts, app/packages/desktop-main/resources/cloudformation/iam-bootstrap.yaml, electron-builder.yml extraResources, a resolver under app/packages/desktop-main/src/ (pattern: electron-entry.ts resolveWindowIcon())."
  claims:
    - "Reproduce docs/docs/setup.md four-statement policy exactly: HyveonDeploy (Resource *), HyveonIAM (role/policy hyveon-*), HyveonConfigurationBucket, HyveonStateBucket (plan:17-63)."
    - "HyveonStateBucket MUST NOT contain dynamodb/lock actions — Pulumi S3 backend has no lock table (plan:68-70)."
    - "Keep HYVEON_DEPLOY_ALL_ACTIONS unchanged; add HYVEON_DEPLOY_ALL_STATEMENTS + set-equality drift test (plan:71-86)."
    - "Template is static with literal tokens `__HYVEON_DEPLOY_ALL_POLICY_DOCUMENT__` / `__HYVEON_SELF_ROTATE_POLICY_DOCUMENT__`, replaced with single-line JSON.stringify output (plan:88-107)."
    - "HyveonSelfRotate: iam:CreateAccessKey/DeleteAccessKey/ListAccessKeys on `arn:aws:iam::*:user/${UserName}` (plan:109-119)."
    - "Resources: 2 ManagedPolicy, IAM User (UserName param default `hyveon`), AccessKey with DeletionPolicy RetainExceptOnCreate; Outputs user, policy ARN, AccessKeyId, SecretAccessKey (plan:121-131)."
    - "Resolver returns undefined, never throws, when neither packaged nor dev copy exists (plan:195-207)."
  role: docs (implementation plan)
  shipped: "YES — PR #378 (fbd8fb38); archive/2026-08-10-add-one-click-aws-bootstrap exists; iam-bootstrap.yaml, cloudformationTemplate.ts and HYVEON_DEPLOY_ALL_STATEMENTS exist."
  observations:
    - "Internal contradiction: Global Constraints say `DeletionPolicy: RetainExceptOnCreate` (plan:126) but Task 2 says `DeletionPolicy: Retain` (plan:172). Shipped template uses RetainExceptOnCreate (iam-bootstrap.yaml:73)."
    - "Policy bucket names `${project_name}-tfvars` / `hyveon-tfvars` (plan:50, 66-67, 159-161) — terraform-era naming; current iamPolicy.ts:198 doc mentions `hyveon-config`. Plan is stale on bucket name."
    - "Policy includes `ce:*`, `cloudfront:*`, `acm:*` (plan:30-31). `acm:*` still in docs/docs/setup.md:91 (justified at setup.md:223 for the CloudFront discord domain) — not an ALB leftover, but worth cross-checking against the 'no ACM certificate anywhere' invariant (CLAUDE.md), which reads as Caddy/game-scoped."
    - "References `openspec/changes/add-one-click-aws-bootstrap/...` (plan:5-6) — now under openspec/changes/archive/2026-08-10-add-one-click-aws-bootstrap/."
    - "Hard-wrapped prose (~75 cols), against CLAUDE.md's no-hard-wrap rule (applies to all nine plans)."

- path: docs/superpowers/plans/bootstrap-2-guided-iam-service.md
  purpose: SDD plan for Group 2 — GuidedIamService (render template, console URL, browser open, key intake, mint-then-revoke rotation).
  covers: "app/packages/desktop-main/src/services/GuidedIamService.ts; collaborators ElectronStoreService, SafeStorageService, cloudformationTemplate.ts, iamPolicy generators, ConfigService.getServerConfigPath() pattern, awsCredentialSource.ts resolveAwsCredentialSource, AwsProfileService.SafeStorageUnavailableError; tests with aws-sdk-client-mock."
  claims:
    - "Service takes creds/region as explicit params; never reads ElectronStoreService.get('aws') for its own creds (plan:29-37)."
    - "Protected seams createStsClient/createIamClient; no fromIni (plan:39-46)."
    - "Rendered template written under userData (dev: repo-relative scratch path), UserName not substituted (plan:48-69)."
    - "Console URL exactly `https://<region>.console.aws.amazon.com/cloudformation/home?region=<region>#/stacks/create`, no templateURL, built in one place (plan:71-79)."
    - "Browser open via lazy-required electron shell.openExternal; failure returns {opened:false} not throw (plan:81-92)."
    - "Intake via sts:GetCallerIdentity returns Account; AWS error passed unchanged; nothing persisted on failure (plan:94-104)."
    - "Rotation order: CreateAccessKey(bootstrap) → setPastedCredentials(GUIDED_PROFILE_NAME='hyveon-guided') → GetCallerIdentity(new) → store.set('aws',{profile:GUIDED_PROFILE_NAME,region}) → DeleteAccessKey(bootstrap, using new key) (plan:106-154)."
    - "RotationResult = complete | verification-failed{error} | delete-failed{consoleUrl} (plan:156-160)."
    - "Keychain gate: SafeStorageService.isAvailable() checked first; never plaintext (plan:162-171)."
    - "No secret logging; tests assert no fixture secret in logger args (plan:173-190)."
  role: docs (implementation plan)
  shipped: "YES — PR #379 (e3490e26); GuidedIamService.ts exists; archived change exists."
  observations:
    - "Verification-failure branch in this plan does NOT delete the orphaned new key (plan:128-132); bootstrap-3:47-53 says that was a real bug fixed in Group 2's review — so this plan is stale relative to shipped code."
    - "Cites ConfigService.ts 'lines ~264-304' (plan:63-64) — line-number reference, likely drifted."

- path: docs/superpowers/plans/bootstrap-3-credential-rotation.md
  purpose: SDD plan for Group 3 — general-purpose in-place rotation of the active pasted credential in AwsProfileService.
  covers: "app/packages/desktop-main/src/services/AwsProfileService.ts (rotateActiveCredentials), awsCredentialSource.ts, GuidedIamService.rotate() as reference, AwsProfileService.test.ts."
  claims:
    - "Only `kind: 'pasted'` sources rotatable; profile/none refused (plan:21-31)."
    - "Sequence: CreateAccessKey(current) → GetCallerIdentity(new) → (fail: delete orphan with current key, swallow cleanup failure, report verification-failed, keep old creds) → setPastedCredentials same profile → DeleteAccessKey(old, new client) → delete-failed / complete (plan:33-73)."
    - "Discriminated union result, own name to avoid RotationResult collision (plan:75-76, 96-103)."
    - "GuidedIamService and this method never call each other (plan:85-89)."
  role: docs (implementation plan)
  shipped: "YES — PR #380 (9ba9f05c); rotateActiveCredentials present in AwsProfileService.ts."
  observations:
    - "Documents that GuidedIamService.rotate()'s verification-failure orphan cleanup was added in review (plan:47-53) — contradicts bootstrap-2's constraint text."
    - "Mentions a 'future Settings rotate key affordance — out of scope' (plan:12-13): open whether a UI caller exists now."
    - "Two near-identical rotation flows kept deliberately unshared (plan:85-89) — duplication candidate under .claude/rules/duplication.md (≥2 non-trivial bodies)."

- path: docs/superpowers/plans/bootstrap-4-bucket-encryption.md
  purpose: SDD plan for Group 4 — add AES256 PutBucketEncryption to BootstrapService.ensureConfigurationBucket().
  covers: "app/packages/desktop-main/src/services/BootstrapService.ts (ensureStateBucket, ensureConfigurationBucket, ensurePublicAccessBlock, describeError), BootstrapService.test.ts."
  claims:
    - "Config bucket holds versioned `deployment-config.json` (plan:13)."
    - "Add PutBucketEncryption (AES256) inside the existing try block; failure returns {status:'failed', message} (plan:18-31)."
    - "Order versioning → encryption → public-access-block; applies on both created and exists paths (plan:33-45)."
    - "Public-access-block out of scope; already applied (plan:47-50)."
  role: docs (implementation plan)
  shipped: "YES — PR #381 (2922a968); archived change exists."
  observations:
    - "Line refs `~111-141`, `~163-202` (plan:19-20) — likely drifted."

- path: docs/superpowers/plans/bootstrap-5-iam-gate.md
  purpose: SDD plan for Group 5 — add origin + blocking fields to IamCheckService.checkPermissions().
  covers: "app/packages/desktop-main/src/services/IamCheckService.ts (IamCheckResult, resolveClientConfig, buildPolicyJson), GUIDED_PROFILE_NAME from GuidedIamService.ts, IamCheckService.test.ts."
  claims:
    - "origin ∈ guided|pasted|profile|none; pasted+profile==='hyveon-guided' → guided (plan:27-39)."
    - "blocking = status==='missing' && origin==='guided'; warning never blocks; single source of truth for UI gating (plan:41-51)."
    - "Post-rotation check uses rotated key with zero new code, proven by a regression test (plan:53-75, 94-103)."
    - "Simulation/batching/resolveClientConfig untouched (plan:77-80)."
  role: docs (implementation plan)
  shipped: "YES — PR #382 (fa592401)."
  observations: []

- path: docs/superpowers/plans/bootstrap-6-ipc-surface.md
  purpose: SDD plan for Group 6 — register GuidedIamService, add revokeBootstrapKey, five wizard.guidedIam.* IPC channels, preload bridge, tier-2 integration specs.
  covers: "app/packages/desktop-main/src/modules/wizard.module.ts, GuidedIamService.revokeBootstrapKey, app/packages/desktop-main/src/controllers/wizard.controller.ts, app/packages/desktop-preload/src/hyveon-api.ts + preload.ts, app/packages/web/e2e/integration-specs/."
  claims:
    - "IPC channels: wizard.guidedIam.prepareTemplate / openConsole{region} / submitBootstrapKey / rotate / revokeBootstrapKey{bootstrapAccessKeyId,region} (plan:61-67)."
    - "openConsole controller orchestrates buildCloudFormationConsoleUrl + openConsole (plan:69-73)."
    - "revokeBootstrapKey is the one GuidedIamService method that reads the active store credential; returns {revoked,message?}, never throws (plan:26-53)."
    - "No channel returns secretAccessKey; secrets flow renderer→main only (plan:80-93)."
    - "hyveon-api.ts hand-mirrors desktop-main types with 'mirrors X — keep in sync' TSDoc (plan:95-107)."
  role: docs (implementation plan)
  shipped: "YES — PR #383 (4a47dd56)."
  observations:
    - "Explicitly prescribes 'mirrors X in Y — keep in sync' hand-mirroring (plan:103-107) — .claude/rules/duplication.md rule 4 says such a comment 'is the bug report, not a mitigation'. Rule-vs-plan conflict."

- path: docs/superpowers/plans/bootstrap-7-wizard-ui.md
  purpose: SDD plan for Group 7 — guided-IAM wizard step UI, step insertion, sub-state persistence, credentials 'satisfied' rendering, reconfigure gating.
  covers: "app/packages/shared/src/wizardSteps.ts (WIZARD_STEPS), desktop-preload hyveon-api.ts (WizardStepName, WizardProgress, GUIDED_PROFILE_NAME mirror), web first-run-wizard.component.tsx (STEP_LABELS, RECONFIGURE_PRE_COMPLETED_STEPS, advanceDisabled), guided-iam-step.component.tsx, credentials-step.component.tsx, stack-init-step.component.tsx, FirstRunWizardService.ts (WizardProgress, recordStep, getProgress), WizardController wizard.progress.save/get."
  claims:
    - "Step order ['pick-cloud','guided-iam','credentials','bootstrap','stack-init']; four enumeration sites (plan:19-34)."
    - "GuidedIamSubState not-started|template-written|awaiting-key-intake|rotation-pending|complete; WizardProgress.guidedIam {subState, hasBootstrapKey} (plan:48-60)."
    - "Persist points per sub-state; rotation-pending persisted before rotate() (plan:75-90)."
    - "Secret never persisted; resume on rotation-pending lands on key-intake screen asking operator to re-enter key (plan:92-106)."
    - "guided-iam pre-completed on reconfigure only if aws.profile === GUIDED_PROFILE_NAME (plan:120-136)."
    - "Component owns state like stack-init-step (plan:138-153); region captured in this step (plan:155-165)."
    - "CredentialsStep `satisfiedByGuidedProvisioning` prop with switch-source affordance (plan:167-184)."
  role: docs (implementation plan)
  shipped: "YES — PR #384 (6268ff9a); WIZARD_STEPS matches (wizardSteps.ts:9); guided-iam-step.component.tsx exists."
  observations:
    - "Another 'mirrors … keep in sync' instruction (plan:112-118) — same duplication-rule tension as bootstrap-6."
    - "Allows deferring 'reveal in file manager' to copy-path only (plan:219-224) — check whether shipped UI has reveal."

- path: docs/superpowers/plans/bootstrap-8-e2e-coverage.md
  purpose: SDD plan for Group 8 — Electron e2e page object + specs for the guided-IAM step, plus externalization/teardown audit.
  covers: "app/packages/web/e2e/pages/GuidedIamWizardPage.ts + pages/index.ts, app/packages/web/e2e/specs/guided-iam-wizard.spec.ts, discord.spec.ts precedent, electron.vite.config.ts externals, build/verify-main-bundle-externals.mjs, electron-builder.yml, electron-clean-quit.spec.ts."
  claims:
    - "No real AWS at Electron e2e tier; mock via window.hyveon.__test.mock('wizard.guidedIam.*') (plan:18-27)."
    - "WizardController.getState() defaults wizardCompleted=true under HYVEON_TEST_MODE; specs must mock wizard.state.get / wizard.progress.get (plan:29-35)."
    - "Pre-existing wizard steps have no Electron e2e coverage; out of scope (plan:46-52)."
    - "@pulumi/pulumi, @pulumi/aws, @grpc/grpc-js stay externalized; build guard verify-main-bundle-externals.mjs (plan:109-115)."
  role: docs (implementation plan)
  shipped: "YES — PR #385 (94c72855); page object + spec exist."
  observations:
    - "Mentions 'the docs group closes out the stack' (plan:9-10) — a Group 9 docs plan is not in docs/superpowers/plans/."

- path: docs/superpowers/plans/bump-lambda-runtime-nodejs24.md
  purpose: SDD plan for bump-lambda-runtime-to-nodejs24 — LAMBDA_RUNTIME constant + esbuild targets + test assertions.
  covers: "app/packages/infra/src/lambdas.ts (LAMBDA_RUNTIME), app/packages/lambda/*/esbuild.config.mjs, app/packages/infra/src/lambdas.test.ts, docs/docs/**."
  claims:
    - "nodejs20.x deprecated 2026-04-30; creation blocked 2027-02-01, updates 2027-03-03 (plan:8-9)."
    - "Five Lambdas: interactions, followup, update-dns, watchdog, efs-seeder (plan:9-10, 31-33)."
    - "Single LAMBDA_RUNTIME constant read by all aws.lambda.Function declarations; runtime and esbuild target change together (plan:22-36)."
    - "Live preview/apply tasks (tasks.md §3-4) are manual operator steps, not subagent work (plan:12-18, 75-82)."
  role: docs (implementation plan)
  shipped: "YES — PR #389 (58a0650a); archive/2026-08-10-bump-lambda-runtime-to-nodejs24 exists; LAMBDA_RUNTIME = 'nodejs24.x' (app/packages/infra/src/lambdas.ts:58)."
  observations:
    - "'Five Lambdas' (plan:9) is stale — six Lambda packages now (health-check added; CLAUDE.md 'six Lambda packages')."
    - "Per-package `esbuild.config.mjs` (plan:31) — app/packages/lambda/ now has a shared buildLambda.mjs at root; per-package configs not verified here."
    - "References openspec/changes/bump-lambda-runtime-to-nodejs24/ (plan:5-7) — now archived."
```

> Worker notes (openspec/specs A–G):

Line refs are `openspec/specs/<cap>/spec.md:<line>` unless stated. The requirement/scenario count table lives in mech-specs.md and is not repeated here.

## openspec/specs (A–G: app-diagnostics-logging … game-volume-folder-upload)

```yaml
- path: openspec/specs/app-diagnostics-logging/spec.md
  purpose: "Present (:3-9): renderer console forwarding into the main log, service-layer logging convention, Settings > Diagnostics pause/search/autoscroll."
  covers: renderer console shim -> `diagnostics.reportLog` IPC; `diagnostics.reportError`; winston `main-*.log`; `app/packages/desktop-main/src/services/*.ts` logging; Settings > Diagnostics `DiagnosticsPanel.tsx`; `/logs` `ansi-log-viewer.component.tsx`; `diagnostics.tail`; diagnostics bundle export (zip via native save dialog)
  claims:
    - "Renderer console forwarding to the main-process log: console.log/info/warn/error get batched to `diagnostics.reportLog`, DevTools output stays as it is, levels map log->debug, flush every 2s with a 50-per-flush cap and a 200-entry queue cap, one 'N entries dropped' marker per flush, no-op without a bridge (:11-39)"
    - "Service-layer diagnostic logging coverage: every desktop-main service method that calls AWS SDK/Pulumi logs a debug line on entry and warn/error on failure, and no raw SDK error escapes; pure helpers are exempt (:76-87)"
    - "Diagnostics bundle export: a local .zip with 4 independently gathered sections (scrubbed log, config summary limited to an allowlist, app/system metadata, best-effort AWS snapshot) plus errors.json; cancelling the dialog is silent; a write failure shows a UI error (:103-139)"
    - "Diagnostics panel pause, search, and autoscroll: pausing freezes the view while polling continues; resume swaps in the latest snapshot in one step (tail is a snapshot, not a delta); substring highlighting; no autoscroll while paused (:183-204)"
    - "ANSI escape sequence rendering for log lines: SGR color/bold is rendered, other escape sequences are stripped, highlighting works inside colored runs, malformed sequences fall back to plain text (:238-250)"
  role: spec
  observations:
    - "The Purpose (:3-9) leaves out the bundle-export and ANSI-rendering requirements (:103, :238). The spec has grown past its stated scope."
    - "Service-layer requirement (:78-87) duplicates `.claude/rules/logging.md` rule 2 nearly word for word. The same convention is stated in two places."
    - "Implementation-detail heavy: the exact 2000 ms / 50 / 200 caps and the log-line format strings (:23-34) are tuning values written as SHALLs."
    - "`CostService.ts`'s arithmetic is named as an exempt pure helper (:87). Check that it still has no AWS call, given that cost-visibility allows `DescribeTaskDefinition`."
    - "Bundle export: 'recognizable secret-shaped token' (:166) has no definition, so the scrubbing scenario is weakly testable. 'No partial file left in a way that could be mistaken for a complete bundle' (:180-181) is vague."
    - "The 'Service-layer coverage' requirement is a repo-wide code-convention rule, not operator-facing behaviour, and is hard to test as a scenario."

- path: openspec/specs/app-icon/spec.md
  purpose: "Present (:3-6): the Hyveon icon asset set and its wiring through electron-builder and the web renderer."
  covers: "`build/icon.icns|.ico|.png`, `electron-builder.yml` icon config, `app/packages/web/index.html` favicon"
  claims:
    - "Platform icon asset set exists in the repository: icns/ico (16/32/48/256)/png (>=512) under build/, all derived from one master artwork of >=1024px that the operator approved (:9-11)"
    - "electron-builder packages the icon on every target: the NSIS/DMG/AppImage installers and the running app's taskbar/dock show the Hyveon icon (:23-25)"
    - "Web renderer has a matching favicon: index.html declares `<link rel=icon>` (:37-39)"
  role: spec
  observations:
    - "CLAUDE.md says icons are generated from `build/icon*.svg` via `npm run icons:generate`. The spec never mentions the SVG master or the generator script. It only says 'master artwork >=1024x1024' (:11)."
    - "The 'Placeholder acceptable pending final branding' scenario (:18-21) and 'what this change invents' (:11) are change-scoped language left behind after archive."
    - "The 'Running app shows the icon' and per-platform scenarios can only be verified manually or by the CI matrix (:30). They are not automatable."

- path: openspec/specs/auto-update-scaffold/spec.md
  purpose: "Present (:3-7): electron-updater wired but inert by default behind the `enableAutoUpdate` electron-store flag."
  covers: "`desktop-main/src/updater.ts` (`initUpdater`), `ElectronStoreService` `AppStoreSchema.enableAutoUpdate`, IPC `iac.settings.autoUpdate.get|update|check`, Settings page Updates section, `electron-builder.yml` `publish: github`, GitHub releases API fallback"
  claims:
    - "Updater is wired but inert by default: the updater module is built at startup but never calls checkForUpdates unless the flag is true; no network traffic on a default first launch; no-op outside Electron (:10-12)"
    - "Update-check telemetry is gated by the same flag: no update events or network calls while disabled, beyond one local 'disabled' log line (:29-31)"
    - "enableAutoUpdate flag lives in the typed electron-store schema: an absent value means false; readable and writable via ElectronStoreService and the IPC get/update pair; Settings toggle; takes effect on the next boot (:38-40)"
    - "Packaged builds carry GitHub publish metadata: `publish: github` embeds app-update.yml, and CI packaging must not publish (:72-74)"
    - "Operator can trigger an on-demand update check: the manual check runs whatever the flag says, never downloads or installs, reports none/available+version/error/unavailable-outside-Electron, exposed via `iac.settings.autoUpdate.check` and a Settings button (:86-90)"
    - "Failed update checks fall back to the newest release with a feed: on failure, find the newest non-draft, non-prerelease release that has the platform latest*.yml, retry once via the generic provider, restore the primary feed afterwards, otherwise surface the original error (:141-143)"
    - "Failed manual checks link to the releases page: show a 'Download manually' link to github.com/CoderCoco-Studios/Hyveon/releases only on failure (:160-162)"
  role: spec
  observations:
    - "Internal tension: the first requirement says the updater 'MUST NOT call checkForUpdates ... unless enableAutoUpdate is true' (:12). The manual-check requirement says the check runs 'independent of the flag' (:88-89, :106-111). The first SHALL needs to be reworded to scope it to the boot-time check."
    - "'Update-check telemetry ... no update-related network calls' (:31) also conflicts with the flag-independent manual check and the GitHub releases-API fallback (:143)."
    - "The IPC channel prefix `iac.settings.autoUpdate.*` (:54, :58, :129) puts an auto-update setting under the `iac` namespace. Confirmed present in `app/packages/desktop-preload/src/preload.ts`. It looks like a naming leftover from an older 'IaC settings' grouping."
    - "The name 'scaffold' and the 'wired but inert' Purpose are out of date. The spec now covers a working manual-check feature with a fallback."
    - "The hardcoded releases URL (:162) and the per-platform feed filenames (:143) are implementation detail."

- path: openspec/specs/aws-cloud-health/spec.md
  purpose: "MISSING: Purpose is still 'TBD - created by archiving change aws-cloud-health-checks' (:4)."
  covers: "Settings 'Cloud Health' section; `cloudHealth.list` IPC; `CloudHealthService.getChecks()`, `CloudHealthCheck` (desktop-main `services/CloudHealthService.ts`, `controllers/cloud-health.controller.ts`); `iam:GetRole`/`iam:CreateServiceLinkedRole`; `HyveonDeployAll` policy JSON display"
  claims:
    - "Cloud Health checklist on Settings: a section that is always visible, with one row per registered check (label + ok/missing/error badge), run on mount, a manual Refresh button, no auto-poll (:6-13)"
    - "ECS service-linked role check: check id `ecs-service-linked-role` calls `iam:GetRole AWSServiceRoleForECS`; NoSuchEntity means missing, other errors mean error (logged at warn, no raw SDK error over IPC); the registry is extensible without Settings changes (:32-39)"
    - "Fix action with graceful degradation to policy instructions: Fix calls CreateServiceLinkedRole for ecs.amazonaws.com; created or already-exists counts as fixed and re-checks; AccessDenied leads to needsPolicyUpdate and shows the HyveonDeployAll JSON with a CloudFormation-stack hint; other errors show inline and can be retried; never edits the stack or policy (:59-74)"
  role: spec
  observations:
    - "Purpose TBD (:4)."
    - "There is only one concrete check. The generic 'Fix' requirement (:61) says every broken row shows a Fix action, but only the ECS fix behaviour is defined, so Fix semantics for future checks are undefined."
    - "Overlap with cloud-bootstrap 'HyveonDeployAll permits creating the ECS service-linked role' (cloud-bootstrap:134-157). That is the policy half of this same feature, split across two specs."
    - "game-health-checks:389-401 refers to 'the Settings page's account health check' that 'evaluates account permissions'. This spec defines no permission-evaluation check. IAM simulation lives in the wizard (cloud-bootstrap:89-123). Possible cross-spec mismatch."
    - "'same copyable-block presentation already used by the wizard's IAM permission check' (:70) couples the UI to another component's look."

- path: openspec/specs/aws-credentials/spec.md
  purpose: "Present (:5): ~/.aws profile discovery, safeStorage-encrypted paste flow, pick-or-paste wizard step."
  covers: "`AwsProfileService` (desktop-main), `SafeStorageService`, electron-store `creds.aws.<profile>` (default `hyveon-pasted`), IPC `hyveon.wizard.listAwsProfiles()`, `CloudProviderModule` factories, first-run wizard credentials step, `iam:CreateAccessKey`/`sts:GetCallerIdentity`"
  claims:
    - "AWS profile discovery: parse ~/.aws/credentials and ~/.aws/config through a home-dir seam into `{profileName, region?}`, matching `aws configure list-profiles` (including `profile <name>` aliasing); never returns key material; missing files give [] (:9-11)"
    - "safeStorage paste-flow encryption: pasted keys are encrypted with safeStorage and stored under `creds.aws.hyveon-pasted`, the ciphertext is opaque, decryption happens only in the main process, and an unavailable safeStorage gives an explicit error instead of plaintext storage (:28-30)"
    - "In-app access key rotation: CreateAccessKey, then persist, then verify via GetCallerIdentity, then delete the old key; verification must come before deletion; a failed delete is reported (:47-49)"
    - "Pick-or-paste credentials wizard step: a profile dropdown or a paste form (key id/secret/region); the region defaults from the profile and can be overridden; the choice persists; shown as satisfied (principal+region+switch) after guided IAM provisioning (:61-63)"
  role: spec
  observations:
    - "The rotation requirement says 'keychain' (:54, :59), but the storage described elsewhere is electron-store with safeStorage ciphertext (:30). The terminology is inconsistent."
    - "Rotation is described as a capability of `AwsProfileService` (:49), not as an operator-facing UI flow. No trigger or UI is specified, so it is unclear how an operator reaches it."
    - "Guided IAM provisioning (:63, :80-83) is referenced but not defined here. It belongs to another capability (probably the one-click-bootstrap spec) that this spec cross-references."
    - "'The result set MUST match `aws configure list-profiles`' (:11) makes an external CLI the oracle, which sits awkwardly with the no-CLI stance in desktop-only-operator-surface:213-225. It is test-time only, though."
    - "The header is `# aws-credentials` with no 'Specification' suffix (:1), a format difference from the archived-change specs."

- path: openspec/specs/cloud-bootstrap/spec.md
  purpose: "Present (:5): SDK-only bootstrap of the state and configuration buckets, IAM simulation, IPC with per-resource progress."
  covers: "`BootstrapService` (`ensureStateBucket`, `ensureConfigurationBucket`, `ensurePublicAccessBlock`), `@aws-sdk/client-s3`/`client-iam`, ESLint `@aws-sdk/*` ban for `@hyveon/web`, IPC `wizard.bootstrap.*`, `HYVEON_DEPLOY_ALL_ACTIONS` + `app/packages/shared/src/iamPolicy.ts` + `iamPolicy.test.ts`, `docs/docs/setup.md` policy block, CloudFormation template"
  claims:
    - "SDK-only bootstrap in the main process: bucket and IAM work goes through SDK v3 in main, with no CLI shell-out and no engine invocation; renderer `@aws-sdk/*` imports are a lint error; uses the credentials from the credentials step (:7-9)"
    - "State backend bucket bootstrap: create the state bucket if missing, then enable versioning and SSE; idempotent (owned by us = no-op), owned by someone else = actionable error (:21-23)"
    - "Configuration bucket bootstrap: create the config bucket with versioning and a 90-day noncurrent-version expiry lifecycle; idempotent; used as the canonical RemoteFileStore (:40-42)"
    - "Buckets block public access: all 4 PAB settings on both buckets, including buckets that already exist (:54-56)"
    - "Default encryption on the configuration bucket: AES256 PutBucketEncryption on the created and exists paths; failure is reported as failed (:68-72)"
    - "IAM permission simulation: SimulatePrincipalPolicy, batched, against the caller for the HyveonDeployAll actions; denied actions get a 'Required IAM JSON' panel; never auto-grants; blocking on the guided path after rotation, advisory on profile/paste; a simulation that itself fails gives a non-blocking warning (:89-93)"
    - "Bootstrap IPC and progress reporting: IPC-only `wizard.bootstrap.*` patterns mirrored in preload, with per-resource pending/creating/exists/created/failed (:125-127)"
    - "HyveonDeployAll permits creating the ECS service-linked role: a `HyveonServiceLinkedRoles` statement for CreateServiceLinkedRole, scoped to the ECS SLR ARN with an iam:AWSServiceName condition; generated only from iamPolicy.ts; drift is caught by iamPolicy.test.ts (:134-144)"
  role: spec
  observations:
    - "The Purpose names removed tech: 'never shelling out to the `aws` CLI or Terraform' (:5)."
    - "'Default encryption on the configuration bucket' (:72) carries a history narrative ('already exists ... as a side effect of unrelated `migrate-iac-to-pulumi` work. Encryption is the one asymmetry that remains'). That is change-delta prose inside a main spec. It also restates the PAB requirement (:54-66), so the two requirements overlap."
    - "'MUST NOT be weaker than the infrastructure-defined path it replaces' (:56) refers to a removed path (the old IaC-provisioned buckets), which is now historical."
    - "The state-bucket SSE algorithm is not specified (:23), while the config bucket is pinned to AES256 (:70). Minor asymmetry."
    - "'HYVEON_DEPLOY_ALL_ACTIONS in @hyveon/shared, mirrored in docs/docs/setup.md' (:91) and the requirement saying iamPolicy.ts is the generator (:142) describe the same single source differently (a constant vs a generator file). The two may be the same module."
    - "'batched to stay within API limits and minimize false positives' (:91): 'minimize false positives' is not testable."
    - "The guided-provisioning gating (:93, :110-123) depends on a guided IAM capability defined elsewhere. Same cross-reference as aws-credentials."
    - "The ECS SLR policy requirement (:134-157) belongs with aws-cloud-health."

- path: openspec/specs/cost-visibility/spec.md
  purpose: "Present (:3-8): cost estimates from Fargate task-def specs; never call the Cost Explorer API; link out for billed spend."
  covers: "Dashboard `/` KPI strip, Costs page `/costs`, `CloudProvider` implementations, `DescribeTaskDefinition`, static Fargate pricing constants, add/edit-game Resources step live estimate, infra `Game` tag on task def/log group/EFS-seeder Lambda, `RunTask propagateTags` in `AwsCloudProvider.startWorkload` and the followup Lambda"
  claims:
    - "No AWS Cost Explorer API calls: no code path, provider, service, controller, or IPC channel may call Cost Explorer (:10-14)"
    - "Free per-game Fargate cost estimates: $/hour, $/day, and $/month from task-def CPU/mem plus static pricing; the same constants drive a live hourly estimate in the Resources step before save (:31-41)"
    - "Dashboard KPI cost tiles use only free data: 'Current run rate' = sum of costPerHour over running games; 'Est. month cap' = totalPerHourIfAllOn x 24 x days in the month (:62-68)"
    - "Costs page links out to AWS Cost Explorer for real billed spend: a static console-home link; no in-app chart claiming actual spend (:79-84)"
    - "Per-game AWS resources carry a Game cost allocation tag: per-game metered resources get `Game=<id>` plus Project=hyveon; shared resources get no Game tag (:92-96)"
    - "Running ECS tasks propagate the Game tag from their task definition: every RunTask path (desktop startWorkload and the Discord followup Lambda) requests tag propagation (:120-125)"
  role: spec
  observations:
    - "Overlap with game-resource-picker (the Resources step) on the live estimate (:38-41). That spec is silent on cost."
    - "The 'every independent code path that calls RunTask' clause (:124-125) signals duplicated RunTask logic between desktop-main and the followup Lambda. That is a likely duplication hotspot (see `.claude/rules/duplication.md`)."
    - "The shared-resource list (:115-117) names 'followup/interactions/watchdog/dns-updater Lambdas' but leaves out the conditional health-check Lambda (game-health-checks:183-202) and the file-manager helper (game-volume-folder-upload). Their tagging is unspecified."
    - "'cumulative count of Cost Explorer requests ... remains zero' (:25-29) can only be tested by a negative assertion or grep."
    - "The 'Est. month cap' formula (:65-66) is exact implementation detail."

- path: openspec/specs/custom-title-bar/spec.md
  purpose: "MISSING: Purpose is still 'TBD - created by archiving change add-custom-title-bar' (:4)."
  covers: "Electron `BrowserWindow` options (`titleBarStyle: 'hidden'`, `trafficLightPosition`, `titleBarOverlay`), the renderer top header as the drag region, Linux app-drawn buttons, IPC `window.minimize|toggleMaximize|close|isMaximized` + push `window.maximizedChange`, preload `window.hyveon.window` (`platform`, `onMaximizedChange`)"
  claims:
    - "Window chrome uses the app's own header, not the OS default: titleBarStyle hidden, the header is draggable, and interactive controls (nav toggle, Refresh, LIVE, avatar) stay clickable (:6-9)"
    - "Platform-appropriate window controls: macOS uses traffic lights at a set position; Windows uses titleBarOverlay with matching colors and snap layouts; Linux uses app-drawn min/max/close (:29-31)"
    - "Renderer degrades safely outside Electron: with no `window.hyveon.window` bridge the header renders unchanged (no drag region, no buttons) (:53-57)"
    - "Window-control IPC channels: minimize, toggleMaximize, close, isMaximized, plus a maximizedChange push on any state change, including OS snap (:66-70)"
    - "Preload exposes window platform and controls: `window.hyveon.window.platform` needs no IPC; typed methods; onMaximizedChange subscription (:103-106)"
  role: spec
  observations:
    - "Purpose TBD (:4)."
    - "The Linux scenario (:47-51) is a known pending change. User memory (pr531-linux-native-titlebar-todo) records a decision to move Linux to native titleBarOverlay. Once that work lands, this requirement becomes stale or contradicted."
    - "The header control list 'mobile nav toggle, the Refresh button, the LIVE indicator, or the avatar placeholder' (:24-25) ties the spec to the current header contents. 'Avatar placeholder' may conflict with desktop-only-operator-surface:106-126 ('no non-functional controls', 'placeholder statistics removed')."
    - "'render exactly as it does today' (:63) is change-scoped wording."
    - "The IPC channel names (`window.*`) share the `window` token with the global `window` object. Not a defect, but worth knowing when grepping."

- path: openspec/specs/desktop-only-operator-surface/spec.md
  purpose: "Present (:5): IPC-only desktop-main, no legacy container/shell deploy, no API token, desktop-only docs, harnesses without HTTP, plus UI-integrity rules (sidebar reachability, no dead controls, streaming over contextBridge, contextual navigation)."
  covers: "`app/packages/desktop-main/src/controllers/`, `app.module.ts`, `main.ts` (`NestFactory.createMicroservice` + Electron IPC transport), desktop-main package.json deps, repo root files, `.github/workflows/`, `ConfigService` + `server_config.json` watchdog tunables, docs pages (CLAUDE.md, README, setup/architecture/intro/management-app/guides), `app/packages/web/e2e/` (chromium specs, `hyveon-http-bridge.ts`, integration-specs), sidebar (`app.component.tsx` routes), top bar, game card, preload streaming channels (`logs.stream`, `iac.stack.initialize`, `/iac` runs), logs page preselect, `RemoteFileStore`/S3 config bucket"
  claims:
    - "Desktop-main exposes no HTTP transport: no `*-http.controller.ts`, AppModule registers only IPC controllers, no express/platform-express deps (:9-11)"
    - "No container or shell deployment artifacts at the repo root: Dockerfile, docker-compose.yml, Makefile, setup.sh, and setup.ps1 are absent; no Docker CI (:28-30)"
    - "ConfigService carries no API-token plumbing: API_TOKEN/api_token are removed; server_config.json holds only watchdog tunables (:42-44)"
    - "Documentation describes only the desktop workflow: the listed docs contain no Docker/setup.sh/Makefile/bearer-token instructions; architecture.md shows Electron over IPC as the control plane (:56-58)"
    - "Test harnesses do not depend on the removed HTTP surface: the integration harness dispatches only to IPC controllers; 5 chromium specs stay on vite preview with page.route + hyveon-http-bridge.ts until Epic F (:70-72)"
    - "Every routed screen is reachable from the sidebar: every top-level route has a sidebar entry (Costs included) (:89-92)"
    - "The chrome exposes no non-functional controls: no disabled nav placeholders, no dead search box, no hardcoded game-card stats (:106-110)"
    - "Streamed IPC channels work across the context bridge: streaming returns an async iterable that survives contextBridge; covers logs tail, wizard stack init, IaC run output, and cancellation teardown; at least one test goes through the real bridge with no mock (:128-133)"
    - "Navigating to logs from a game preselects that game: the card's logs action opens /logs with that game; going via the sidebar falls back to the first game (:172-175)"
    - "No operator-editable configuration files: config lives only in the versioned S3 bucket; no local-file fallback; writes use a conditional write with optimistic locking; all deployment settings are form controls; a supportability boundary, not a security one (:187-191)"
    - "Nothing but the app runs in a terminal: provisioning/updating/inspecting/destroying all happen in the app; operator docs give no command except launching the app; legacy Terraform teardown is maintainer-only (:213-215)"
  role: spec
  observations:
    - "This is a catch-all spec. Its Purpose admits two unrelated halves (pivot cleanup vs UI integrity) (:5). The UI-integrity requirements (:89-185) and the config-file/terminal requirements (:187-230) are separate concerns."
    - "Many requirements are one-time removal checks, not ongoing intent ('after the shim deletion' :25, :81, :86; 'after the refresh' :67; 'is NOT part of this change' :72). This is change-scoped language in a main spec."
    - "':72 the five chromium Playwright specs ... their migration to the electron project stays in Epic F (F.2-F.6)' is a transient roadmap reference. The specs and `hyveon-http-bridge.ts` still exist (`app/packages/web/e2e/specs/{audit,games,pending-changes-banner,polling,settings}.spec.ts`). '/api/*' traffic (:82) is HTTP-era vocabulary that persists in tests."
    - "References removed tech by name: Docker, Makefile, setup.sh/.ps1, ApiTokenGuard, Terraform (:30-41, :58-69, :227-230)."
    - "The docs requirement makes CLAUDE.md content a SHALL (:58, :65-69). A dev-workflow file inside a product spec is a scope smell."
    - "'every setting that previously required hand-editing a variables file' (:211) is a historical reference to tfvars."
    - "Possible contradiction: game-environment-variables:68 and game-https-configuration:40 still say the validator runs on the 'IPC/HTTP' and 'IPC and HTTP write surfaces'. This spec says no HTTP surface exists."
    - "The 'Clean machine reaches a deployed cluster through the app alone' scenario (:217-220) is end-to-end and manual only."

- path: openspec/specs/docs-screenshot-capture/spec.md
  purpose: "Present (:5): an on-demand Playwright harness over the real Electron shell that writes deterministic PNGs into the Docusaurus static tree."
  covers: "Screenshot Playwright config and test dir (separate from e2e), `_electron.launch()` on `out/main/index.js` with `HYVEON_TEST_MODE=1`, demo fixtures typed against shared contracts, seeded channels (`games.list`, `drift.get`, `audit.list`, `logs.get`, `logs.stream`, `iac.*`, `diagnostics.*`), `docs/static/img/app/`, `docs/docs/guides/maintainer.md`"
  claims:
    - "Screenshots are captured from the real Electron shell: launch the built main with test mode, never from a browser tab, fixed window content size (:9-15)"
    - "The harness is isolated from the e2e test run: its own config and dir; app:test:e2e and CI never run it (:28-31)"
    - "Captured screens are seeded with deterministic demo data: every channel a screen needs is seeded with contract-correct shapes (games.list returns GameListEntry[]); no unintended empty/loading/error states (:43-48)"
    - "Re-running the harness produces stable images: frozen clock, animations disabled, a repeat run shows no visual diff (:67-71)"
    - "Output location is the Docusaurus static tree: PNGs committed under docs/static/img/app/, not under the gitignored Playwright output (:88-91)"
    - "The capture procedure is documented for maintainers: maintainer.md covers the build-then-capture sequence, Linux display/xvfb-run, and when to refresh (:99-102)"
  role: spec
  observations:
    - "Dev tooling, not product behaviour. It is unclear whether it belongs in openspec/specs at all."
    - "'games.list returning GameListEntry[] rather than a string array' (:48) records a past bug. It is a regression note, not intent."
    - "'byte-identical or visually identical' (:70) is loose. The repeat-run scenario is not strictly testable without a pixel-diff tool."
    - "The seeded channel list (:58-60) will drift whenever a screen gains a channel."
    - "docs/static/img/app/ exists (audit.png, costs.png, dashboard.png ...) and maintainer.md exists."

- path: openspec/specs/env-token-interpolation/spec.md
  purpose: "MISSING: Purpose is still 'TBD - created by archiving change add-env-var-token-interpolation' (:4)."
  covers: "The `${hyveon.*}` allow-list exported from `@hyveon/shared`, the shared game-server validator, infra task-definition build (hostname substitution `<game>.<zone>`), the generated `/bin/sh -c` entryPoint wrapper (checkip.amazonaws.com via wget/curl), `GameServerConfig.command`"
  claims:
    - "Environment variable values support an allow-listed ${hyveon.*} token grammar: exactly public-address and public-ipv4; tokens can be embedded and repeated; an unknown `${hyveon.` token is rejected at the row's value path; everything else passes through byte for byte (:6-8)"
    - "The public-address token resolves to the game's hostname at deploy time: baked into the task def as `<game>.<zone>`; preview/apply fails, naming the game and token, if there is no hosted zone (:25-27)"
    - "The public-ipv4 token resolves at container boot via an injected entrypoint wrapper: the raw token stays in the task def; a generated sh wrapper queries checkip with about a 60s retry budget, rewrites only the variables that carry the token, then execs `command`; games without the token get a byte-identical task def (:39-41)"
    - "Boot-time discovery failure fails the server start visibly: on timeout the container exits non-zero, the game never starts, and the task STOPS (:58-60)"
    - "Wrapper script generation is injection-safe: single-quoted data with `'\\''` escaping, the IP goes through a shell variable; the name of a row carrying the ipv4 token must match `[A-Za-z_][A-Za-z0-9_]*` (:67-69)"
    - "Games gain an optional container start command, required with the ipv4 token: optional `command: string[]` passed through as is; required when the ipv4 token is used (:81-83)"
  role: spec
  observations:
    - "Purpose TBD (:4)."
    - "Validator rules are specified in two places. game-environment-variables:63-78 restates the same token/shell-identifier/command rules, so changes there must stay in sync."
    - "The public-address token assumes the hostname is `<game>.<zone>`. game-https-configuration and the CLAUDE.md DNS invariant also depend on this, and a 'pin game hostname' feature (recent commit 5b984bbe) may make the hostname configurable. Possible staleness of `<game>.<zone>` (:27)."
    - "Dependency on an external endpoint (checkip.amazonaws.com) and on wget/curl existing in the game image (:41) is not stated as a precondition. An image with neither tool always fails."
    - "'byte-identical to today's output' (:41, :56) is change-scoped wording."
    - "Adding `command` to GameServerConfig has a field-touchpoint obligation (CLAUDE.md checklist). The spec does not say whether the wizard exposes `command`."

- path: openspec/specs/game-draft-persistence/spec.md
  purpose: "Present (:3-6): autosave of the add-game wizard draft, persisted across restarts, with a resume/discard banner."
  covers: "Add-game wizard `WizardDraft` + step index, debounced autosave, flush on unmount, desktop-main durable storage (likely electron-store), games list page banner"
  claims:
    - "Debounced draft autosave: save the draft and step about 1s after edits stop; not while the draft is empty or during submit (:9-15)"
    - "Draft flushed on dialog close: a pending edit is written immediately on close/unmount (:36-41)"
    - "Draft survives app restart: persisted in the main process across relaunch (:50-54)"
    - "Resume/discard banner on the games page: the banner appears when a draft exists and never auto-opens the wizard; Resume opens it with the saved state; Discard deletes the draft (:63-67)"
    - "Draft cleared on successful game creation (:92-95)"
    - "Corrupt or unreadable draft degrades to no draft: no banner, no error, the page loads (:104-109)"
  role: spec
  observations:
    - "There is only one draft slot (add-game only). Edit-game drafts are not covered."
    - "The storage mechanism is not named ('durable storage', 'desktop main process' :52). Fine as intent, but it should be cross-checked against `ElectronStoreService` schema in code."
    - "game-https-configuration:164 says 'Wizard drafts SHALL receive the same normalisation' (legacy webPort), which adds a read-path rule for drafts that this spec does not mention."
    - "Interaction with the 'No operator-editable configuration files' rule (desktop-only-operator-surface:187-191) is fine, since drafts are app-local state, but neither spec states that."

- path: openspec/specs/game-environment-variables/spec.md
  purpose: "Present (:4): edit a game's env vars from the add-game wizard and the edit form instead of hand-editing deployment-config.json."
  covers: "Add-game wizard 'Environment' step (between Storage and Review), edit-game form 'Environment' section, `GameServerConfig.environment` `{name,value}[]`, `gameServerValidator.ts`, token hint UI"
  claims:
    - "Operators can set a game's environment variables from the game form: a row editor in both flows; defaults to empty; add/edit/remove with no minimum; unrelated saves keep existing rows (:6-17)"
    - "Environment variable entries must have a non-empty, unique name: the validator rejects empty or duplicate names on every write path; values are checked only for `${hyveon.*}` correctness (per env-token-interpolation); no name charset rule except for rows that carry the ipv4 token (:63-78)"
    - "The environment editor surfaces the available interpolation tokens: a hint lists both tokens with descriptions; value-level issues render per row at `environment[N].value` (:117-125)"
  role: spec
  observations:
    - "Stale reference: 'the IPC/HTTP game-write surface' (:68). The HTTP surface was removed (desktop-only-operator-surface:9-26)."
    - "The Purpose's 'without hand-editing deployment-config.json' (:4) implies hand-editing was once supported. Under desktop-only-operator-surface:187-191 it no longer is."
    - "Duplicates the token/validator rules of env-token-interpolation (:71-78)."
    - "Step ordering is pinned as a SHALL ('between the Storage and Review steps' :11-12). That is UI layout detail."
    - "'Creating a game without adding any environment variables' allows either an empty list or an omitted field (:31). The ambiguity is deliberate but weakens the test."

- path: openspec/specs/game-health-checks/spec.md
  purpose: "Present (:5-8): decide active/idle from a game's own management-API answer when declared, otherwise from network traffic, without weakening the task security boundary or killing a server that has players."
  covers: "`GameServerConfig` optional health-check declaration (kind discriminator, HTTP kind), the watchdog idle decision and consecutive-idle count, the conditional health-check Lambda (its own SG and IAM, `ecs:DescribeTasks`, Secrets Manager, CloudWatch Logs), `app/packages/infra/src/network.ts` (no NAT/VPC endpoints), the shared validator, app-owned Secrets Manager secrets for basic/bearer, redacted UI shape, the Settings account permission check"
  claims:
    - "A game may declare an authoritative health check: an optional kind-discriminated declaration that, when present, replaces the network-traffic measurement entirely (exactly one verdict source) (:12-24)"
    - "The HTTP check kind evaluates a declared request against a declared condition: scheme http/https, port, path, method GET/POST/PUT/PATCH/HEAD, headers, auth, timeoutMs 100-10000 for the whole request; a restricted JSONPath to exactly one scalar; 6 operators (equals/notEquals strict-typed, greater/lessThan numeric, contains on strings, exists at any cardinality); auth type raw (default, header set to the raw secret)/basic (JSON {username,password} gives Basic)/bearer; the constructed Authorization overrides header Authorization; inline-credential-looking headers are rejected; no redirects (3xx = fail); active iff the condition holds (:40-107)"
    - "A failed check reports the server as active: timeout, refusal, non-2xx, non-JSON, no or uncomparable value, unavailable credential, or failure to execute all give active, with a reason marking the failure (:152-162)"
    - "Health checking is provisioned only for games that use it: no resources, permissions, or cost unless some game opts in; resources are shared once across opted-in games (:183-189)"
    - "Reaching into a game task is confined to what the configuration declares: SG egress only to opted-in ports on game tasks (port-level, not game-level, because of the shared SG); AWS API calls are unaffected (public subnet + IGW); secret access only to referenced secrets; the component is not externally reachable and is invocable only by the idle-decision owner; the host comes from the task's reported address, never from config; the watchdog gets no network placement and no credential access (:204-238)"
    - "Health-check configuration is validated before it is saved: reject a port not among the game's ports, a non-rooted path, a timeout out of range, an operator missing its value, malformed auth; basic needs username+password, bearer needs a token, raw/untyped needs an ARN (:253-267)"
    - "The basis for a shutdown decision is recoverable from the logs: each verdict logs game/kind/verdict/reason; failure-derived verdicts are logged at a higher severity; the reason flows into the idle-decision log; no credentials or bodies are logged (:292-304)"
    - "Health-check credentials never reach the operator interface: only a 'credential set' indicator; no basic username or bearer token sent to the UI (:319-326)"
    - "App-owned health-check credentials are provisioned and retired by the app: basic/bearer secrets are created, updated in place, and deleted on removal or game delete; raw secrets are operator-owned and never deleted (:341-355)"
    - "App-owned credential lifecycle requires no additional account permission: the standard deploy policy already covers create/update/delete of app-owned secrets, so the Settings permission check keeps passing (:389-394)"
  role: spec
  observations:
    - "Cross-spec mismatch: :391-401 refers to 'the Settings page's account health check' that evaluates permissions. aws-cloud-health defines only the ECS SLR check, and permission simulation lives in the first-run wizard (cloud-bootstrap:89-123). Either this spec means the wizard IAM check or Cloud Health is assumed to grow a permission check."
    - "'Watchdog state lives in ECS task tags' (CLAUDE.md invariant) is consistent with the 'consecutive-idle count' (:300), though the tag storage is not named here."
    - "Interaction with game-port-visibility: health-check ports are commonly 'internal' ports (game-port-visibility:3-7 Purpose cites health checks). This spec does not say whether a health-check port must or may be internal, or how egress-to-port relates to VPC-CIDR ingress."
    - "Validation says a 'port that is not among the ports the game declares' (:259). Unclear whether an HTTPS game's `webPort` (game-https-configuration:137-159), which is not a `ports` entry, can be a health-check target."
    - "Naming an infra source file in a SHALL rationale (`app/packages/infra/src/network.ts` provisions no NAT gateway :221-222) is implementation detail inside the intent."
    - "'Inline credential resemblance' heuristics (:72-75) are not precisely defined, so they are hard to test exhaustively."
    - "'a credential reference with no declared type ... every existing configuration that predates this requirement' (:52-53) is migration-era wording."
    - "The raw-type validation says 'unchanged from prior behavior' (:267). Change-scoped."
    - "This is the largest spec in the batch (401 lines) and folds together three concerns: HTTP check semantics, security confinement, and credential lifecycle."

- path: openspec/specs/game-https-configuration/spec.md
  purpose: "Present (:5): operator-facing config of a game's in-task TLS (form control, constraints, warning, JSON round-trip); the infra side is in `in-task-tls-termination`."
  covers: "Add/edit-game Networking step HTTPS toggle + web-port field + warning callout, `gameServerValidator.ts` `checkHttpsPortRules`, `GameServerConfig.https` / `.webPort`, `DeploymentConfigService` read-time normaliser (TSDoc `@deprecated`), wizard draft normalisation"
  claims:
    - "Operators can set a game's HTTPS flag from the game form: a Networking-step toggle in both flows, default off, round-trips including explicit false (:9-11)"
    - "An HTTPS-enabled game must satisfy the Caddy sidecar's port constraints: ports tcp/udp only, never container 80/443, never webPort/tcp duplicated; issues pathed at ports[N]/webPort; ports may be empty and the first may be udp (:38-49)"
    - "The form blocks a save the shared validator would reject: violations disable save and are attributed to Networking; a dedicated web-port field is shown when HTTPS is on, with additional ports labelled optional (:81-83)"
    - "Operators are warned about the consequences of enabling HTTPS: an inline callout covering stack-wide 80/443 ingress, loss of direct web-port access, and the ACME issuance/DNS prerequisite (:100-106)"
    - "The HTTPS flag round-trips through the deployment-config JSON: persisted in `GameServerConfig.https` in the S3 object; disabling writes an explicit false (:118-120)"
    - "An HTTPS-enabled game declares an explicit web port: `webPort` is required (1-65535, not 80/443) iff https, absent otherwise; never implied by ports order (:137-139)"
    - "Legacy HTTPS configs are normalised on read: https without webPort means ports[0] becomes webPort and the rest stay ports; idempotent; persisted only on the next save; applied to drafts too; the normaliser is marked @deprecated (:161-163)"
  role: spec
  observations:
    - "Stale reference: 'the validator runs on the IPC and HTTP write surfaces' (:40). There is no HTTP surface any more."
    - "The 'Legacy shape is marked deprecated in code' scenario (:175-178) requires a TSDoc tag and a comment. That is a code-annotation requirement, not behaviour."
    - "Cross-spec rule: no HTTPS-game port may be 80/443 (:45). game-port-visibility:63-91 extends the 80/443 tcp reservation deployment-wide to non-HTTPS games once any HTTPS game exists. The two rules overlap, and both live in the same validator."
    - "The ICMP-on-HTTPS rejection is stated in game-port-visibility:115, 125-127 ('existing HTTPS protocol rule') and comes from constraint 1 here (:44)."
    - "The ACME callout requires `{game}.{hosted_zone_name}` resolving (:106). Same hostname assumption as env-token-interpolation. Possible staleness if hostname pinning (commit 5b984bbe) changed it."
    - "Scenario 'Creating a game without touching the control' expects `https: false` explicitly (:21). The spec is silent on whether an omitted flag is equivalent on read."
    - "Infra counterpart `in-task-tls-termination` is outside this part."

- path: openspec/specs/game-port-visibility/spec.md
  purpose: "Present (:1-7), but the file has NO `# <cap> Specification` title line. It starts directly at `## Purpose`."
  covers: "`GameServerPort.visibility` ('public'|'internal'), the `game_servers` SG ingress (0.0.0.0/0 vs VPC CIDR) in infra, `checkPortCollisions`, the deployment-wide 443/80 tcp reservation, ICMP protocol entries (type 0-255, toPort -1, no portMappings), cross-game ICMP dedupe, the wizard visibility control + ICMP protocol option, `firstPortByGame()` -> Discord `GAME_PORTS` (in `app/packages/infra/src/lambdas.ts`)"
  claims:
    - "Per-port visibility field: optional, only public/internal; omitted means public everywhere (:11-16)"
    - "Internal ports are ingressed from the VPC CIDR block only: public gets 0.0.0.0/0; applies to HTTPS games' additional ports; webPort gets no ingress (:33-34)"
    - "Port visibility applies to an HTTPS game's additional ports: same semantics; webPort is reachable only via Caddy 443/80 (:50-51)"
    - "Container ports 443 and 80 (tcp) are reserved deployment-wide when any game is HTTPS: no game may declare 443/80 tcp if any HTTPS game exists; udp is never reserved; the error names the reserving game (:63-72)"
    - "Wizard exposes per-port visibility: a Public/VPC-only control, default Public (:95-98)"
    - "ICMP port declarations: protocol 'icmp' with container = ICMP type 0-255 gives an SG rule with icmp fromPort=type, toPort=-1 and no portMapping; still rejected on HTTPS games (:114-115)"
    - "Cross-game ICMP declarations: the same icmp pair may appear in several games if the effective visibility matches (one deduped rule); conflicting visibility is rejected naming both games; duplicates within a game are rejected (:135-136)"
    - "Wizard supports ICMP entries: icmp in the protocol dropdown; numeric field relabelled as the ICMP type, default 8 with a ping hint, 0-255 message (:152-153)"
    - "Connect-port surfaces exclude ICMP entries: Discord GAME_PORTS uses the first non-icmp public port; HTTPS games present the https://{game}.{zone} URL, never webPort (:165-166)"
  role: spec
  observations:
    - "Missing the H1 title line (file starts at `## Purpose` :1). It is the only spec in this batch with that format defect."
    - "Scope creep: the name says 'visibility', but the spec also owns ICMP protocol support, the deployment-wide 443/80 reservation, and the Discord connect-port derivation. ICMP and connect-port look like separate capabilities. User memory notes 'add-icmp-ingress' as a separate change."
    - "Possible bug in intent: 'first non-icmp public port' (:166) excludes internal ports from the connect port. The ICMP-first scenario (:168-170) does not exercise that. It also leaves open what happens when every port is internal."
    - "':46 a tcp or udp port cannot be declared with conflicting visibility' is a derived guarantee that depends on `checkPortCollisions`. It is not a new SHALL."
    - "Uses snake_case `game_servers` for the SG and `hosted_zone_name` (:174). That is Terraform-era naming. The Pulumi resource names should be checked."
    - "Before-change wording: 'written before this change' (:19), 'unchanged from before this change' (:22), 'unchanged by this capability' (:46, :127)."
    - "Horizontal-rule separators (`---`) between requirements, unlike the other specs."

- path: openspec/specs/game-resource-picker/spec.md
  purpose: "Present (:3-11): a shared vCPU/memory slider control limited to valid Fargate pairs."
  covers: "Add-game wizard and edit-game form Resources step, the shared slider component, the Fargate (vCPU, memory) matrix"
  claims:
    - "vCPU and memory selected via constrained sliders: the sliders can only land on valid Fargate pairs; vCPU stops at 7 tiers (0.25-16); the memory range follows the tier, including uneven steps (0.25 gives 512/1024/2048; 8 vCPU uses 4 GiB steps, 16 vCPU 8 GiB); a memory value that is no longer valid resets to unset, never clamped (:14-19)"
    - "Resource selection applies to both add and edit flows: the same component in both, pre-populated on edit (:42-46)"
  role: spec
  observations:
    - "Does not mention the live hourly cost estimate that cost-visibility:38-60 places in this same Resources step. The two specs overlap with no cross-reference."
    - "The Fargate tier table is hardcoded into the spec (:23-32). If AWS changes the tiers, the spec goes stale. That is implementation data in a SHALL."
    - "'rather than dropdown lists' (:16-17) and 'not dropdowns' (:50) are change-scoped comparisons."
    - "Behaviour on edit when the stored (cpu, memory) pair is not a valid Fargate pair is unspecified."

- path: openspec/specs/game-volume-folder-upload/spec.md
  purpose: "Present (:5): copy a local folder tree into a game's EFS volume through the app, with a live progress meter."
  covers: "Storage step + game page folder picker (native dialog, include/exclude tree), the file-manager helper ECS task (per-launch credential, self-signed cert pinned by the app, operator-IP SG ingress add/revoke, auto-stop schedule, tags), desktop-main upload engine (progress, resume, verify, conflict check `awaiting-confirmation`), startup/Diagnostics stray-helper sweep, app-local per-game selection state, `file_seeds` untouched"
  claims:
    - "Operator selects a local folder and which entries to include: a native folder dialog; a tree with per-entry include (default all); a destination that must be absolute under a volume `container_path`; relative layout preserved (:9-10)"
    - "Upload goes directly into the mounted volume: via the file-manager helper launched for the duration of the upload; contents and credential stay in main; only after apply; disabled while the server is running; refuses to reuse a helper session that is already open (:24-25)"
    - "Only the operator can reach the upload helper: ingress limited to the operator's public IP, a per-launch credential, a pinned per-launch TLS cert; the app aborts on a mismatched cert; the IP rule is revoked on stop; an IP change gives a failed run with a Resume action (:43-44)"
    - "Helper sessions are tagged and stray ones are cleaned up: tagged per game/project; always stopped; auto-stop if the app exits; a startup and manual sweep stops ownerless helpers older than 15 minutes (:62-63)"
    - "Live progress meter: percent/bytes/files/current file/rate/ETA at least once per second, in the wizard's final step and on the game page; phases; cancel; advances within large files (:77-78)"
    - "Resume and failure handling: skip same-size files already present; report the failing path; bounded per-file retries; overwrite partial files; helper expiry gives a Resume action (:92-93)"
    - "Verification after upload: compare count and per-file size; success with totals, or a list of mismatches with Retry (:103-104)"
    - "Warn before overwriting existing volume files: classify each file as new/identical/conflicting before any write; on conflicts pause in `awaiting-confirmation` with counts and up to 20 samples; write nothing until confirmed; decline or timeout cancels cleanly; the app's own partial run is exempt from the prompt (:114-115)"
    - "Safety limits and scope of state: skip and count symlinks; reject path escape; selection and state live in app-local storage, not deployment-config.json; file_seeds are unaffected (:141-142)"
  role: spec
  observations:
    - "Depends on a 'file-manager helper task' capability defined elsewhere (the embed-file-browser work, per memory and recent commit a2fc26f1). This spec assumes its existence, credential model, and auto-stop."
    - "Security-sensitive: operator-IP ingress plus a pinned self-signed cert. The upload helper is not mentioned in game-port-visibility or cost-visibility tagging ('Game' tag)."
    - "'the wizard's final step' (:78) shows progress during add-game, but upload requires infrastructure to be applied first (:25, :31-33). Unclear how the wizard's final step can upload for a game that is not yet deployed (the scenario says the selection is kept)."
    - "The 15-minute sweep threshold (:71) is in a scenario but not the requirement body. The 'confirmation timeout' (:115, :130) and the 'bounded number of times' retries (:93) are unspecified values."
    - "Uses the `file_seeds` snake_case field name (:142). The shared code uses `file_seeds` in deploymentConfig.test.ts, so this is consistent."
    - "Verification by size only (:104) cannot detect same-size corruption. That is a deliberate weakness, but it is not stated as one."
    - "'identical (present with the same size)' (:115) treats same size as identical, which affects whether a changed file of equal size gets overwritten."
```

> Worker notes (openspec/specs G–W):

All paths relative to repo root. `S:` = `openspec/specs/<cap>/spec.md`. Requirement/scenario counts are in the orchestrator's mechanical table and are not repeated here.

## openspec/specs (G–W: guided-iam-provisioning … wizard-flow)

```yaml
- path: openspec/specs/guided-iam-provisioning/spec.md
  purpose: "One-click path for an operator with no AWS credentials: a generated CloudFormation template creates the HyveonDeployAll-scoped IAM user/key in the operator's own console; the app takes in and validates the bootstrap key, rotates it via the OS keychain, and requires the keychain throughout (Purpose present, :5)."
  covers: "@hyveon/shared HYVEON_DEPLOY_ALL_ACTIONS; CloudFormation template generator (AWS::IAM::ManagedPolicy/User/AccessKey + HyveonSelfRotate policy); docs/docs/setup.md policy JSON; IamCheckService; userData template write + browser open of CloudFormation console URL; STS GetCallerIdentity validation; IAM CreateAccessKey/DeleteAccessKey rotation; SafeStorageService keychain; wizard progress persistence (rotation-pending)."
  role: "spec (desktop-main wizard backend + web wizard step)"
  claims:
    - "CloudFormation template generated from the shared action set — the shipped template makes a managed policy, a user (name from a parameter, default `hyveon`) and an access key with DeletionPolicy Retain. The policy is generated from HYVEON_DEPLOY_ALL_ACTIONS and matches the four statements in setup.md exactly (HyveonDeploy/IAM/ConfigurationBucket/StateBucket). The StateBucket statement holds only the 7 Pulumi S3-backend actions and no DynamoDB. A separate HyveonSelfRotate policy covers the user's own keys (Create/Delete/ListAccessKeys). Outputs: user, policy ARN, key id, secret (:9-11)."
    - "Console handoff for stack creation — the template is written under userData. The CloudFormation Create-stack console opens in the selected region, the step shows the path with a copy action, and there is no reveal-in-file-manager. The console URL is built in exactly one place. Root credentials are never requested. If the browser fails to open, the URL is shown as selectable text (:33-45)."
    - "Bootstrap key intake — the step validates the pasted key id/secret via sts:GetCallerIdentity and records the account ID. On failure it shows the AWS error and does not persist the key. The secret is never written to disk unencrypted and never logged (:47-64)."
    - "Mandatory bootstrap key rotation — mint a new key, store it in the keychain, verify it via STS, and only then delete the bootstrap key. Verification comes before deletion. If deletion fails, show an explicit 'still active, revoke manually' warning with a console link, not success. Rotation runs before the IAM permission gate, and a pending rotation survives a restart (:66-88)."
    - "Keychain requirement for guided credentials — when SafeStorage encryption is unavailable, refuse to store and point the operator to the profile-picker or manual path. Never fall back to plaintext (:90-97)."
  observations:
    - "Historical Terraform reference inside the normative text: 'unlike the project's earlier Terraform backend' (:11). Context only, but it is removed-tech narrative."
    - "Spec treats docs/docs/setup.md as the comparison oracle for the policy (:11, :16). Docs and spec are coupled, and setup.md is also declared single source of truth in CLAUDE.md, so it is unclear which one wins."
    - "Implementation rationale is embedded in the normative text: the 'reveal-in-file-manager is NOT required … judged out of scope for the wizard-UI work' paragraph (:35) is decision history, not intent."
    - "'Rotation MUST run before the IAM permission gate' (:68) points at a gate defined elsewhere (iam permission check / IamCheckService spec, not in this part)."
    - "Overlaps wizard-flow 'Guided IAM provisioning step' (resume sub-states, rotation-pending) — wizard-flow:53-73 and here :85-88 both specify rotation-pending resume."
    - "'Tightening the policy is a separate change' (:11) is change-process language inside a main spec."
- path: openspec/specs/guided-region-selection/spec.md
  purpose: "Region selection on the guided-IAM wizard step: a continent-grouped dropdown backed by a build-time-generated static AWS_REGIONS data set, with a manual-entry fallback (Purpose present, :5-9)."
  covers: "app/packages/shared/src/awsRegions.ts (exists) exported from @hyveon/shared; region-data generator script + npm command; guided-IAM step region screen in @hyveon/web (handleChooseGuided, local `region` state)."
  role: "spec (shared data + web wizard UI)"
  claims:
    - "Static AWS region data set — a committed, generated awsRegions.ts holding {code,name,continent} for commercial regions. It is regenerated by a manually triggered script/npm command, never fetched at runtime. It excludes the us-gov-/cn- prefixes and includes every feed entry typed 'AWS Region'. It works offline, and regeneration sorts by continent then name (:13-34)."
    - "Guided-IAM region selection dropdown — continent-grouped, labeled '{name} — {code}', alphabetical within each group. Selecting sets `region` to the code. The empty-region validation in handleChooseGuided and the state shape stay unchanged (:36-58)."
    - "Manual region entry fallback — a final ungrouped 'Other (enter manually)' item swaps in a pre-focused free-text input. Any code is accepted, so a stale data set never blocks setup (:60-82)."
  observations:
    - "Hard-wrapped prose throughout (:5-9, :15-22 …), which violates the CLAUDE.md 'no hard line wrap' rule for openspec/**."
    - "Change-delta wording survives in the main spec: 'matching the field's behavior prior to this change' (:64-65) and 'identical to today's free-text behavior' (:75). Untestable once 'today' moves."
    - "Implementation-detail binding: names the internal handler `handleChooseGuided` and local state shape (:42-45)."
    - "The generator npm command is not named, so the 'Regenerating' scenario (:30-34) is not mechanically checkable from the spec alone."
    - "Region chosen here flows into guided-IAM console URL (guided-iam-provisioning:35). wizard-flow's Reconfigure scenario edits 'region in the credentials step' (wizard-flow:104), a possible second region input or a mismatch."
- path: openspec/specs/iac-destroy-flow/spec.md
  purpose: "Operator destroy flow: a self-bridged streaming IPC channel under the same durable apply lock as plan/apply, a fresh server-minted single-use confirmation-token gate, a preload bridge, and a type-to-confirm UI on /iac (Purpose present, :5)."
  covers: "IacController `iac.destroy` (self-bridged via onModuleInit, SELF_BRIDGED_PATTERNS in ipc-main-bridge.ts); RunService.createRun durable lock; audit entry; run record kind 'destroy'; token-mint plain-invoke channel + destroy service method + DestroyNotConfirmedError; preload hyveon.iac.mintDestroyToken/destroy; hyveon-api.ts typed mirrors; /iac page destroy dialog + ANSI log viewer."
  role: "spec (desktop-main controller/service + preload + web UI)"
  claims:
    - "Destroy IPC channel — iac.destroy follows the iac.apply streaming pattern: an immediate {started, runId?, error?, conflict?} ack, run-id-tagged chunks, and exactly one end message. A busy workspace gets a conflict ack and no audit or run record. The handler acquires the durable lock before the engine runs and releases it on every exit path, including cancel and app shutdown. It writes an audit entry and a run record visible in history (:9-31)."
    - "Fresh confirmation token gate — the token is server-minted, single-use and expiring. Missing, unknown, expired or consumed tokens are rejected with DestroyNotConfirmedError. The token is bound to its workspace+stack and rejected for any other target. Consumption is atomic and happens before the engine call. No code path may bypass the gate, and every engine-destroy call site goes through the gated method (:33-62)."
    - "Preload destroy bridge — hyveon.iac exposes mintDestroyToken plus a streaming destroy that honors the test-mode mock registry, with typed mirrors in hyveon-api.ts (:64-71)."
    - "Type-to-confirm destroy UI — a fixed phrase must be typed before a token is minted. The dialog states that all infrastructure will be destroyed, output streams live in the same ANSI viewer, and BUSY is shown like plan/apply (:73-85)."
  observations:
    - "Heavy implementation detail in normative text: onModuleInit, SELF_BRIDGED_PATTERNS, ipc-main-bridge.ts file name (:11)."
    - "'No unguarded destroy path exists' (:59-62) is a code-inspection scenario, testable only by static audit or grep, not by behaviour."
    - "Overlaps with orchestrator-integration-coverage 'Destroy gated by fresh confirmation token' (o-i-c:77-109), which adds a 'superseded token' (a later mint for the same target invalidates earlier tokens) that this spec never states. The rule is defined only in the test-coverage spec."
    - "Lock release on cancel/shutdown duplicates pulumi-engine-runtime 'Engine process lifecycle' (p-e-r:190-212)."
    - "Spec names the preload method mintDestroyToken (:66) while o-i-c names the service method mintDestroyConfirmationToken() (o-i-c:79). These are different layers, not a conflict, but the naming drifts."
    - "Heading style '# iac-destroy-flow' lacks the ' Specification' suffix used by other specs (:1). Cosmetic."
- path: openspec/specs/iac-plan-apply-page/spec.md
  purpose: "The /iac Plan/Apply page: plan over IPC, live ANSI output, change-count summary, approval + plan-hash-gated apply, and replacing stale CLI instructions with links into the flow (Purpose present, :5)."
  covers: "@hyveon/web /iac route (PollingProvider → GameStatusProvider → router); hyveon.iac.plan/approve/apply; hyveon.iac.runs.get/streamLogs; shared change-summary type (main+renderer); saved engine update-plan artifact + plan hash + engine-version stamp + config-object version id; RunService durable RunLock (atomic CAS); hyveon.iac.runs.lock.mintToken/clear; PulumiOperationInFlightError; game edit/remove copy."
  role: "spec (web page + desktop-main apply gate)"
  claims:
    - "IaC route and navigation — /iac is in primary nav and uses the same provider stack as the other routed pages (:7-14)."
    - "Plan trigger over IPC — hyveon.iac.plan(). A started ack opens the run view for runId. A not-started ack shows the error, and on conflict a BUSY banner names plan/apply/destroy/rollback (:16-28)."
    - "Live ANSI log stream — consumes runs.streamLogs(runId) (replay then follow). ANSI is preserved end to end, and only the renderer converts it to HTML. The engine runs in human-readable progress mode (:30-42)."
    - "Plan result summary — create/update/replace/delete counts come from the engine's structured summary, never from scraping the log. One shared summary implementation. An absent summary reads as 'summary unavailable', not 'no changes' (:44-61)."
    - "Approve gate before apply — Approve shows for awaiting_approval and calls approve({planRunId}). The approver is resolved server-side. Apply stays disabled until approval (:63-75)."
    - "Plan-hash-gated apply — apply({planRunId, planHash}) is constrained to the saved engine plan. Gate order: record exists → is a plan → approved → within the 15-min window → hash matches the stored record and the re-hashed on-disk artifact → same engine version → atomic CAS on the durable lock (the CAS is authoritative). The hash also covers the config-object version id, and apply refuses if that version moved, without depending on parsing the plan file. An engine upgrade invalidates plans. Partial apply is distinguished from no-change failure and directs a re-plan. Expired approval prompts re-approval. Success shows a banner linking to the dashboard (:77-118)."
    - "Stale CLI copy replaced — game edit/remove no longer say `terraform apply`/`make tf-apply` and link to /iac instead (:120-127)."
    - "Operator recovery from a stuck durable run lock — on a RunLock conflict from apply/destroy, the BUSY banner offers 'Clear lock and retry' behind a confirm. It mints a run-id-bound token via runs.lock.mintToken() → runs.lock.clear({confirmationToken}). A token whose runId no longer matches the held lock is refused. Not offered for PulumiOperationInFlightError or plan/preview refusals. Never auto-resubmits (:129-146)."
  observations:
    - "Removed-tech references: `terraform apply` / `make tf-apply` (:122, :126). The requirement is a one-off migration cleanup that is now permanently satisfied or trivially re-checkable. A candidate for retirement or rewording as 'no instructions to run IaC from a terminal'."
    - "Historical issue reference in normative text: 'not the pre-pivot HTTP/SSE endpoints described in issue #110's stale body' (:18)."
    - "BUSY conflict can name `rollback` (:28), but iac-run-history filters only plan/apply/destroy kinds (iac-run-history:49), and iac-rollback produces a *plan* run tagged rolledBackFrom. It is unclear whether 'rollback' is a real operation kind."
    - "The apply gate (:79) is restated nearly verbatim in orchestrator-integration-coverage 'Apply rejects stale and unapproved plans' (o-i-c:28-75) and partly in iac-rollback:65. The 15-minute window appears in three specs."
    - "Two distinct locks are in play: the durable RunLock (RunService), which this spec's Clear-lock action covers, and the Pulumi backend S3 lock, which pulumi-engine-runtime 'Stale backend lock recovery' (p-e-r:159-188) covers. Both have their own operator-confirmation recovery flow, with possible operator confusion and overlap."
    - "Missing blank line between Purpose and '## Requirements' (:5-6). Cosmetic."
    - "Implementation detail: provider-stack component names (:9), error class name PulumiOperationInFlightError (:131)."
- path: openspec/specs/iac-rollback/spec.md
  purpose: "Rollback of an apply: complete paginated S3 version history, a Rollback action in history that resolves and confirms the target, restore as a new S3 head + plan tagged rolledBackFrom, standard gates, and a clear failure if the version is gone (Purpose present, :5)."
  covers: "AwsRemoteFileStore.listVersions (ListObjectVersionsCommand pagination, @hyveon/cloud-aws); history view Rollback action; RunRecord.rolledBackFrom in @hyveon/shared/runs.ts; restore of the config object (byte-for-byte); shared operation lock; S3 lifecycle 90-day noncurrent expiry."
  role: "spec (cloud-aws store + desktop-main rollback service + web history UI)"
  claims:
    - "Complete remote file version listing — listVersions pages on IsTruncated using NextKeyMarker/NextVersionIdMarker and accumulates every page before the exact-key filter and newest-first sort. A single-page result means one request (:9-21)."
    - "Rollback initiation from history — Rollback is offered only on apply runs that recorded a config version id. The app resolves the version live before that run and confirms the target before any write. It SHOULD show a diff summary (:23-35)."
    - "Rollback restores the version and queues a tagged plan — the historic content is restored as a new head (history never rewritten), then a plan starts. The lock is acquired before the restore and held until the plan record persists. If plan creation fails, the app either restores the previous head or records and surfaces the orphan, never leaving a silent unreviewed head. The plan record carries rolledBackFrom, which history shows. The restore is byte-for-byte with no JSON re-emit (:37-61)."
    - "Rollback goes through the standard approve and apply gates — same approval, 15-min window, hash and lock gates. No bypass (:63-70)."
    - "Missing historic version is a clear error — fail before any write, name the missing version, and leave the head untouched and no plan started (:72-79)."
  observations:
    - "Issue reference in normative text: '(Fixes issue #260 …)' (:11)."
    - "'SHOULD summarize how the target configuration differs' (:25) is a soft, untestable obligation."
    - "'the shared operation lock' (:41) is ambiguous: it could be the in-process workspace lock (PulumiOperationInFlightError) or the durable RunLock. iac-plan-apply-page distinguishes the two (iac-plan-apply-page:131), but this spec does not say which."
    - "Depends on an infra-side fact (a 90-day noncurrent-version lifecycle, :74) defined elsewhere (pulumi-infra-program / config bucket). It is a cross-spec coupling with no reference."
    - "'either restores the previous head or records the orphaned restore' (:41, :51) leaves the behaviour non-deterministic: two allowed outcomes, so a test must accept either."
- path: openspec/specs/iac-run-history/spec.md
  purpose: "Run history: a paginated, status-filterable run-listing API across store/service/IPC/preload, a /iac/history route with kind/status filters, and a read-only run detail with best-source log resolution (Purpose present, :5)."
  covers: "RunRecordStore.listRuns contract (@hyveon/shared/cloud.ts) → AwsRunRecordStore DynamoDB query (status-index GSI on status+startedAt); RunRecordService.listRuns/getLogUrl; IacRunsController iac.runs.list; preload hyveon.iac.runs.list + hyveon-api.ts; RunPageResult (@hyveon/shared/runs.ts); /iac/history route; runs.get/streamLogs; logInline/logS3Key; RunRecord change summary field."
  role: "spec (cross-layer: cloud-aws store, desktop-main, preload, web)"
  claims:
    - "Run listing API — every layer exists. Results come newest-first as RunPageResult {records, nextBefore?} with limit, cursor (`before`) and an optional status filter via the status-index GSI with no table scan. The runs table name comes from stack outputs, and a missing name gives an empty page, not an error (:9-31)."
    - "Run history route — /iac/history shows a table with kind, status, started/completed, approver and the rolledBackFrom tag, plus a load-older button (:33-45)."
    - "History filters — filter by kind (plan/apply/destroy) and by status (:47-59)."
    - "Read-only run detail from history — reuses the live run-view components. The log comes from streamLogs if local <runsDir>/<runId> exists, else logInline, else a presigned URL from logS3Key resolved in main. Terminal runs show no Approve/Apply (:61-78)."
    - "Structured change summary on run records — RunRecord carries the engine's structured summary, never parsed from the log. The field is optional, and rows without it render cleanly (:80-97)."
  observations:
    - "Structured-summary rule duplicated with iac-plan-apply-page 'Plan result summary' (:44-61) and orchestrator-integration-coverage (o-i-c:18-21)."
    - "Kind filter enumerates plan/apply/destroy only (:49). It is consistent with rollback being a tagged plan, but conflicts with iac-plan-apply-page's BUSY list including 'rollback' (iac-plan-apply-page:28)."
    - "Fairly implementation-specific (GSI name `status-index`, class names). It reads more as a design than as intent."
    - "The 350KB inline-log threshold that decides logInline vs logS3Key is stated only in orchestrator-integration-coverage (o-i-c:122), not here."
- path: openspec/specs/in-task-tls-termination/spec.md
  purpose: "TLS for HTTPS games terminates in-task via a Caddy sidecar with Let's Encrypt certs on EFS. No ALB/ACM, and HTTPS games share the Lambda-managed DNS lifecycle (Purpose present, :5)."
  covers: "app/packages/infra/src/ecs.ts defineEcs (Caddy sidecar per https game, proxy to webPort); app/packages/infra/src/efs.ts defineEfs ({game}-certs access point, /data); game-servers security group ingress (443/80, additional ports with visibility); update-dns + watchdog Lambdas (no ELB paths); app/packages/infra/src/lambdas.ts; StackOutputs in @hyveon/shared; CloudWatch /ecs/{game}-server with caddy stream prefix."
  role: "spec (Pulumi infra program + Lambdas)"
  claims:
    - "Caddy TLS sidecar for HTTPS games — each https:true game gets a version-pinned official caddy sidecar on 443/80 that proxies to localhost:webPort. It is generated by iterating gameServers in defineEcs, marked essential, and logs to the game log group under a `caddy` prefix. Turning https on needs only a config edit. https:false games get no sidecar (:9-26)."
    - "HTTPS served with automatically-issued certificates — ACME HTTP-01/TLS-ALPN-01 with no custom image, ECR or ACME IAM. It retries with backoff until the async DNS propagates, within LE rate limits. Valid HTTPS within ~2 minutes (:28-40)."
    - "Certificate persistence across task restarts — a per-game {game}-certs EFS access point is mounted at /data on that game's sidecar only. A restart reuses the cert with no new ACME order (:42-54)."
    - "HTTPS games use the Lambda-managed DNS lifecycle — the same update-dns UPSERT on RUNNING and DELETE on STOPPED. No infra-managed per-game records. No ELBv2 calls, ALB_TARGET_GROUPS/HTTPS_GAMES env or elasticloadbalancing IAM in update-dns or watchdog (:56-67)."
    - "Security-group ingress for HTTPS games — 0.0.0.0/0 on 443/80 when any HTTPS game exists. No ingress on webPort. Additional ports are ingressed per their visibility, and nothing changes for non-HTTPS games (:70-87)."
    - "No load-balancer or ACM resources — no LB/listener/TG/ALB SG/ACM cert/validation records. StackOutputs exposes no ALB DNS or cert ARN. No orphans remain after the removal apply (:89-101)."
  observations:
    - "Retired-tech (ALB) migration residue: 'After the removal apply that retired the original ALB-based design, the account MUST contain no orphaned ELB or ACM resources' (:91). This is a one-time migration assertion about live account state, not code."
    - "Scenarios that need a live AWS account to verify: `aws elbv2 describe-*` (:95), the '~2 minutes' cert timing (:35), and 'no new ACME order' in logs (:49). They cannot be tested in CI."
    - "'Stopped HTTPS game accrues no fixed cost' (:98-101) is a cost assertion, which makes it hard to test."
    - "Overlaps pulumi-infra-program 'Resource parity…' HTTPS scenario (p-i-p:118-121) and the CLAUDE.md invariants (no ALB, DNS Lambda-managed). It also overlaps operator-documentation 'no references to removed infrastructure' (o-d:52-76)."
    - "The webPort / additional-ports semantics match the recent commits #688-#691 (explicit https web port). The spec is likely current."
- path: openspec/specs/infra-log-viewer/spec.md
  purpose: "MISSING: Purpose is still 'TBD - added by archiving change `add-infra-log-viewer`' (:5-6)."
  covers: "Lambda log-group resolver `/aws/lambda/${projectName}-${functionKey}`; CloudWatch Logs recent-lines fetch + polling live tail (AbortSignal); /logs/infrastructure routed page with function picker reusing the game-logs live-tail component; sidebar Monitoring → Logs group (Game Logs → /logs, Infra Logs → /logs/infrastructure)."
  role: "spec (desktop-main logs service + web page/sidebar)"
  claims:
    - "Lambda log group resolution — /aws/lambda/{projectName|'hyveon'}-{functionKey}, where functionKey ∈ {watchdog, health-check, dns-updater, interactions, followup} (:10-25)."
    - "Recent Lambda logs fetch — up to `limit` lines from the most recent stream, oldest-first. With no streams, return one info message. On API failure, return one failure message (no raw SDK error) and logger.error with functionKey + log group (:27-47)."
    - "Live Lambda log tail — poll at the caller's interval (default 2000ms) until the AbortSignal fires. New events only, no duplicates. Exit cleanly on abort (:49-62)."
    - "Infrastructure logs page — /logs/infrastructure has a picker over the 5 keys and reuses the game-logs live-tail component. Switching the picker stops the old tail and starts the new one (:64-79)."
    - "Nested Logs sidebar navigation — Monitoring → Logs group with always-visible Game Logs and Infra Logs children. Labels must not collide with the Games/Infrastructure links. Active highlighting only on the matching child (:81-96)."
  observations:
    - "Purpose is TBD (:5-6)."
    - "Lambda-set conflict: 'the app's 5 Lambda functions' (:11) omits efs-seeder. operator-documentation says six packages, four always-on + two conditional (efs-seeder, health-check) (o-d:89-92). lambda-runtime-currency lists efs-seeder as *always*-provisioned and health-check as conditional (l-r-c:21-22). This spec treats the conditional health-check as one of a fixed 5 with no not-provisioned state."
    - "functionKey `dns-updater` vs package name `update-dns` (@hyveon/lambda-update-dns). Verified the infra program uses `dns-updater` as the function-name suffix (app/packages/infra/src/lambdas.ts:3, plus tests), so the spec is consistent with code but the naming splits from the package name."
    - "There is no requirement for the health-check function when it is not provisioned (its log group won't exist), though 'no streams yet' (:37-41) covers an empty group, not a missing one."
    - "Hard-wrapped prose (:11-15 etc.) violates the CLAUDE.md no-hard-wrap rule."
    - "Error-handling requirement (:43-47) restates .claude/rules/logging.md conventions."
- path: openspec/specs/install-and-signing-docs/spec.md
  purpose: "Docs for installing unsigned MVP builds per OS and the roadmap to signed releases and default auto-update (Purpose present, :4-6)."
  covers: "docs/docs/install.md (exists); README.md Install link; docs/docs/code-signing-roadmap.md (exists); electron-builder.yml hardenedRuntime:false and enableAutoUpdate guidance; GitHub Releases artifacts (.exe/.dmg/.AppImage)."
  role: "spec (documentation content)"
  claims:
    - "Per-OS unsigned-MVP install instructions — install.md has macOS (right-click → Open), Windows (SmartScreen More info → Run anyway) and Linux (chmod +x AppImage) sections. It states the builds are unsigned and why, renders in Docusaurus, and links to GitHub Releases (:9-21)."
    - "README links to the install instructions — README has an Install link near the top (:23-30)."
    - "Code-signing roadmap document — Apple Developer (~$99/yr) + notarization and Azure Trusted Signing (~$10/mo), with the auto-update enablement flow, cost/ownership notes and blockers. hardenedRuntime:false stays intentionally until macOS signing (:32-44)."
  observations:
    - "A content spec for documentation. Prices (~$99/yr, ~$10/month) are time-sensitive facts (:34)."
    - "Hard-wrapped Purpose (:4-6)."
    - "Couples to electron-builder.yml config keys (hardenedRuntime, enableAutoUpdate) (:34, :43). Those should be checked against the current builder config; the file was not read in this part."
    - "Overlaps operator-documentation's general docs-site requirements (build, links)."
- path: openspec/specs/lambda-runtime-currency/spec.md
  purpose: "Keep every Lambda on a supported AWS Node runtime, with the esbuild target and the runtime-provided SDK tracked as dependencies of that choice (Purpose present, :4-6)."
  covers: "LAMBDA_RUNTIME in app/packages/infra/src/lambdas.ts (verified = 'nodejs24.x' at :58); app/packages/lambda/*/esbuild.config.mjs target; deployed functions interactions, followup, update-dns, watchdog, efs-seeder, conditional health-check; runtime-bundled AWS SDK (external)."
  role: "spec (infra program + Lambda build config + release process)"
  claims:
    - "Lambdas run a supported AWS runtime — every declared function, including conditional ones, uses a runtime from AWS's Supported table. No deprecated runtime is introduced, and the move happens before the block-update date. Currently nodejs24.x (:9-22)."
    - "Bundle target matches the executing runtime — the esbuild target's Node major equals LAMBDA_RUNTIME's, and both change in one change (:24-33)."
    - "Runtime-provided SDK is treated as a dependency — a runtime change implies an SDK change, so the real AWS calls (ECS RunTask/StopTask/DescribeTasks, Route53, DynamoDB, Secrets Manager, CloudWatch GetMetricStatistics, ECS tags) are exercised against deployed functions before the change completes (:35-40)."
  observations:
    - "Conflicts with operator-documentation on efs-seeder: this spec calls efs-seeder always-provisioned (:21), while o-d:89-92 calls it a conditional per-game Lambda."
    - "Time-relative, externally-sourced criteria ('appears in AWS's Supported runtimes table at the time of the change', :10) cannot be tested from the repo alone."
    - "The SDK requirement (:35-40) is a process/manual-verification requirement against deployed AWS. It is not automatable."
    - "Duplicates node-toolchain-version 'AWS Lambda runtime versions are governed separately' (n-t-v:44-54), which also requires runtime and esbuild target to move together."
    - "The scenario pins a literal value `nodejs24.x` (:16), so the spec text must change on every runtime bump."
- path: openspec/specs/node-toolchain-version/spec.md
  purpose: "One Node major for dev/CI/docs, separated from the Lambda runtime version (Purpose present, :5)."
  covers: "engines.node in root package.json, docs/package.json, scripts/package.json; .github/workflows/{docs-build,docusaurus-gh-pages,test,lint,e2e,integration,package,release}.yml + setup-app composite action; docs/docs/setup.md prerequisites; docs/docs/guides/maintainer.md workflow list; LAMBDA_RUNTIME + esbuild targets; docs/package.json @docusaurus/* versions."
  role: "spec (repo toolchain/config + docs)"
  claims:
    - "One supported Node major for development and CI — Node 24. Every manifest's engines.node reads >=24.0.0, and older Node triggers EBADENGINE (:9-19)."
    - "Every CI workflow runs the supported Node major — every workflow's setup-node requests '24', with the app workflows going through the setup-app composite action (:21-31)."
    - "Documentation states the supported Node major — the setup.md prerequisites and the maintainer.md workflow list say Node 24. No doc names an unenforced version (:33-42)."
    - "AWS Lambda runtime versions are governed separately — a toolchain bump leaves LAMBDA_RUNTIME and the esbuild targets untouched. Runtime and target change together in their own change (:44-54)."
    - "Documentation toolchain tracks a current Docusaurus release — all six @docusaurus/* pinned to the same exact version, no range. Lockfile regenerated by npm. A clean build succeeds, and the logo, SVG and mermaid diagrams still render (:56-67)."
  observations:
    - "Stale path: `scripts/package.json` is referenced (:13, :18), but no `scripts/` directory exists in the worktree (git ls-files shows 0 entries). Scenario :12-15 cannot pass as written."
    - "Workflow list (:30) matches the current .github/workflows (8 files, all named). OK as of now, but the list is enumerated literally."
    - "'current at the time of the change' (:57) is time-relative and untestable later."
    - "Overlaps lambda-runtime-currency 'Bundle target matches…' (l-r-c:24-33) and operator-documentation 'Prerequisites match enforcement' (o-d:117-120)."
    - "Mixed scope: the Docusaurus-version requirement (:56-67) is unrelated to 'Node toolchain version' and belongs with docs-site tooling."
- path: openspec/specs/operator-documentation/spec.md
  purpose: "What the docs site must contain and must not claim: a screenshot-backed 'Using the app' section per routed screen, coverage of previously undocumented subsystems, factual agreement with code, no removed infra, no orphan assets, and a build that fails on broken links (Purpose present, :5)."
  covers: "docs/docs/app/ (exists) vs routes in app/packages/web/src/app.component.tsx; docs/static/img/app/ (exists); docs/diagrams/*.d2 + render.sh + docs/static/diagrams/*.svg; docs/docs/{intro,architecture,setup}.md, components/{index,lambdas,infra,management-app}.md, guides/{user,maintainer}.md; docs/docusaurus.config.ts onBrokenLinks (verified 'throw' at :16); .github/workflows/*; root package.json workspaces/scripts."
  role: "spec (documentation content/quality gates)"
  claims:
    - "Every routed screen has a dedicated documentation page — docs/docs/app/ has one page per screen: wizard, dashboard, games list/detail, iac (plan/apply/destroy, history, run detail), discord, logs, costs, audit and settings. Each states actions plus loading/empty/error. The pages are in the sidebar, and there are no pages for removed screens (:9-33)."
    - "Screen documentation embeds screenshots — at least one screenshot per page, from docs/static/img/app/, root-relative paths, descriptive alt text, and no docs/screenshots/ refs (:35-50)."
    - "Documentation contains no references to removed infrastructure — no ALB/TG/ACM, no bearer-token HTTP backend. HTTPS = Caddy sidecar. The watchdog only StopTasks and update-dns deletes DNS on STOPPED. No refs to the terraform/ tree. Diagrams are regenerated and match the sources (:52-76)."
    - "Documented counts and paths match the codebase — six Lambda packages (4 always-on + 2 conditional: efs-seeder per-game, health-check shared). Repo maps list every workspace with the root as workspaces root. The infra file table matches app/packages/infra. The root script table matches package.json, and the Node min matches engines. No maintainer invariant claims infra-managed Route53 records (:78-126)."
    - "Previously undocumented subsystems are documented — wizard, plan/apply/destroy + history + rollback, game CRUD (writes the versioned JSON config and still needs plan/apply), drift, audit, cloud-provider abstraction (ConfigModule, CloudProviderModule, CLOUD_PROVIDER/SECRETS_STORE/REMOTE_FILE_STORE/DISCORD_RECEIVER tokens), desktop-preload, efs-seeder, ElectronStore/SafeStorage, the JSON config store, and all CI workflows (:128-154)."
    - "The docs build fails on a broken link — onBrokenLinks:'throw', and the site builds clean (:156-169)."
    - "Orphaned documentation assets are removed — docs/screenshots/ deleted (verified absent) (:171-179)."
  observations:
    - "Lambda-set conflict with lambda-runtime-currency (efs-seeder always vs conditional) and infra-log-viewer (5 functions). See those entries."
    - "Removed-tech mentions are intentional negatives (ALB, terraform/ tree, bearer token) (:54-65)."
    - "Route list (:14-15) omits `/logs/infrastructure` explicitly ('logs' only) and does not name an 'infrastructure' screen. CLAUDE.md lists an 'infrastructure' page under docs/docs/app/, so the two may differ."
    - "The 'every route … no page documents a screen that no longer exists' scenario (:17-21) needs a manual or scripted cross-check. There is no automated enforcement named."
    - "The 'Issue-70 screenshots deleted' scenario (:176) is a one-off migration check."
    - "Hard-wrapped prose throughout (:11-15 …), which violates the CLAUDE.md no-hard-wrap rule."
    - "Meta-overlap: node-toolchain-version restates the Node-in-docs rule (n-t-v:33-42)."
- path: openspec/specs/orchestrator-integration-coverage/spec.md
  purpose: "Integration-test coverage that drives PulumiService through the real DI container and controllers with an in-process engine stub (no real engine, no fake PATH binary): preview/apply/destroy gates, ANSI streaming, run records, stack outputs (Purpose present, :5)."
  covers: "Playwright tier-2 `ipc` integration harness; PulumiService DI seam stub; IacController.apply; PulumiService.destroy + mintDestroyConfirmationToken + DestroyNotConfirmedError; APPROVAL_WINDOW_MS; RunRecordService/RunRecordStore (350KB inline log); iac.runs.list / hyveon.iac.runs.list; stack-outputs IPC channel / stack.outputs()."
  role: "spec (test-suite coverage contract)"
  claims:
    - "Plan integration coverage — preview writes a plan artifact and a planHash covering artifact + config version id. The structured summary matches the stub on both the result and the record. A failed preview has no planHash (:9-26)."
    - "Apply rejects stale and unapproved plans — rejected with no engine call for: unapproved, expired (>15 min), hash mismatch, engine-version change, missing record, on-disk artifact changed, config version moved. A competing apply loses the atomic lock. A fresh valid plan runs the stub `up` (:28-75)."
    - "Destroy gated by fresh confirmation token — DestroyNotConfirmedError for missing, consumed, wrong-target, expired, superseded and concurrent-duplicate tokens. A fresh token runs the stub destroy (:77-109)."
    - "Streamed run chunks preserve ANSI escape sequences — ANSI byte-for-byte in both chunks and the persisted log, with stdout/stderr attribution kept (:111-118)."
    - "Run records persisted for every run — the local record has runId, kind, timestamps, outcome and planHash. Failed runs persist too. The log is inline under 350KB. Records can be retrieved via paged and status-filtered runs.list (:120-142)."
    - "In-process engine stub injected via DI — a stub at PulumiService's DI seam, no subprocess, no patching internals. No spec uses the real engine, downloads the binary or reaches AWS. The stub scripts preview/apply/destroy/outputs (:144-156)."
    - "Stack outputs integration coverage — outputs come via stub stack.outputs(). A never-deployed stack gives 'not deployed yet', not a throw (:158-170)."
  observations:
    - "A meta-spec (requirements on tests). It nearly duplicates behavioural specs: iac-plan-apply-page apply gate (:79), iac-destroy-flow token gate (:33-62), iac-run-history listing, and pulumi-infra-program stack outputs (p-i-p:128-145). Candidate for folding into those specs as their verification method."
    - "Introduces behaviour defined nowhere else: 'superseded by a later mint for the same target' (:101-104) and the 350KB inline-log limit (:122, :136)."
    - "Historical reference: 'rather than … a fake binary on PATH' (:5) refers to an earlier test approach (likely the Terraform-era fake binary)."
    - "Internal tension: 'stub substituted at its DI seam … without patching PulumiService internals' (:146), yet the stub *is* `PulumiService` ('every spec resolves PulumiService to the stub', :156) while also testing PulumiService's own gates (:11, :79). It is unclear whether the stub replaces PulumiService or the engine/automation dependency beneath it."
- path: openspec/specs/preload-bridge-naming/spec.md
  purpose: "Public naming of the preload IPC bridge: window.hyveon with Hyveon* types and the test-mock seam; the gsd/Gsd* names are gone (Purpose present, :5)."
  covers: "@hyveon/desktop-preload contextBridge.exposeInMainWorld('hyveon') and src/index.ts global augmentation (HyveonApi, HyveonTestApi, HyveonMockNamespaces); @hyveon/web globals.d.ts side-effect import; HYVEON_TEST_MODE=1 window.hyveon.__test.mock; e2e helper applyHyveonMocks."
  role: "spec (preload naming contract)"
  claims:
    - "Preload bridge is exposed as window.hyveon — exposes namespaces games, costs, logs, files, discord, env, wizard, drift, diagnostics, audit, iac, cloudHealth, window. window.gsd is undefined (:9-17)."
    - "Bridge TypeScript types are named Hyveon* — HyveonApi/HyveonTestApi/HyveonMockNamespaces, with no Gsd* exports. web globals.d.ts is a bare import, and the single declare-global lives in desktop-preload src/index.ts (:19-27)."
    - "Test-mode mock seam uses the same bridge name — window.hyveon.__test only under HYVEON_TEST_MODE=1, helper applyHyveonMocks, never exposed in prod (:29-36)."
  observations:
    - "Rebrand-residue spec: its whole purpose is the absence of `gsd` (:5, :11, :17). After the rename it is mostly a regression guard. Candidate to merge into a general preload-bridge spec."
    - "The enumerated namespace list (:16) must be edited whenever a namespace is added, which makes it brittle. Whether it matches the current preload was not verified."
    - "Memory notes still reference `window.gsd.__test.mock()` (user memory), which is stale relative to this spec."
- path: openspec/specs/pulumi-engine-runtime/spec.md
  purpose: "How main resolves/downloads/pins/caches the Pulumi engine with nothing operator-installed, plus the single Automation API seam: workspace/stack construction, S3 backend, secrets provider, AWS creds, stale-lock recovery, engine lifecycle (Purpose present, :5)."
  covers: "PulumiEngineService (userData engine + plugin caches, memoized provisioning, typed provisioning errors); PULUMI_ENGINE_VERSION in @hyveon/shared; engine-status accessor for Settings; Automation API workspace seam (stable per-stack workspace dir under userData); S3 state backend; passphrase derivation (STS account id + stack name + app constant) and legacy encrypted-store migration; non-secret init marker; credential env sanitization (AWS_PROFILE/AWS_DEFAULT_PROFILE vs access-key vars); backend lock ownership records; AbortSignal SIGINT cancellation + escalation timeout; Electron quit handling."
  role: "spec (desktop-main infra orchestration runtime)"
  claims:
    - "App-managed engine provisioning — PulumiEngineService resolves from a userData cache and never probes PATH first. It downloads the pinned version when the cache is missing or holds another version. Memoized, so there is one download for concurrent callers. The plugin download is reported as its own phase. Caches are app-owned. The constructor never throws without an engine (:9-41)."
    - "Pinned engine version — a single constant in @hyveon/shared, never 'latest'. Exposed through an accessor for Settings. A stale cached version is replaced by the pin (:43-55)."
    - "Engine provisioning failure is actionable — typed errors name the cause (network/integrity/unwritable). No partial engine is ever treated as valid. Errors reach the wizard and the Plan/Apply page, not a crash, and a retry is offered (:57-69)."
    - "Automation API workspace seam — one seam builds workspace and stack and configures the S3 backend (the operator's bucket), secrets provider and creds, with no Pulumi Cloud. Without the backend, an actionable error points to bootstrap (no implicit create). One stable workspace dir per stack. The passphrase is derived from STS account id + stack name + an app constant, never stored and recomputed each time, and is not a confidentiality boundary. Legacy random passphrases migrate automatically and retryably (re-encrypt, then delete). A non-secret 'has interacted with a stack' marker is set only on success (:71-126)."
    - "Wizard-selected credentials reach the engine — profile → AWS_PROFILE, paste → decrypted keys in main only. Exclusive: the other source's env vars are cleared. No credentials in output, run logs or app logs (:128-157)."
    - "Stale backend lock recovery — locks are recorded by identity. A provably-owned orphan from a terminated run is reclaimed silently. An unowned lock needs operator confirmation showing holder and age. Local idleness is never evidence of staleness. In-app concurrency is reported as busy, not stale (:159-188)."
    - "Engine process lifecycle — every op is cancellable via SDK AbortSignal (one SIGINT), then a bounded escalation timeout abandons the promise (logical, no real kill). Cancel releases workspace and lock and records aborted. A quit never hangs, and an in-flight op is terminated at shutdown (:190-212)."
  observations:
    - "CONFLICT with pulumi-infra-program (p-i-p:70): there, 'the current provider is machine-bound and has no recovery path if the operator's machine is lost'. Here (:77) the passphrase is derived deterministically from account id + stack name and is explicitly reproducible on a second machine. One of the two is stale. p-i-p:70 likely predates the derived-passphrase change."
    - "Internal tension: 'App quits with an operation in flight → the engine invocation is terminated during shutdown' (:209-212) vs ':192/:202 the Automation API exposes no handle to forcibly kill the underlying process'. Termination is at best SIGINT + abandon."
    - "Transitional requirement: legacy passphrase migration (:79, :108-111, :123-126) is a one-time upgrade path that may be removable since there is no release yet (per memory, pre-release)."
    - "Two lock recovery mechanisms: this spec covers the Pulumi S3 backend lock, and iac-plan-apply-page:129-146 covers the durable RunLock 'Clear lock and retry'. They are separate specs with separate confirm flows and no cross-reference."
    - "The 'plugins' progress phase (:28-31) is the same phase set wizard-flow consumes (engine|plugins|operation, wizard-flow:77)."
    - "Pinned-version display duplicated by wizard-flow 'Resolved Pulumi engine version in Settings' (wizard-flow:137-144)."
    - "'Cache holds a stale version → … provisioned and used' (:47-50) restates :11. A minor duplication."
- path: openspec/specs/pulumi-infra-program/spec.md
  purpose: "The TypeScript infra program (@hyveon/infra) that 'replaces the HCL Terraform module': workspace packaging, typed game-server config, config as versioned S3 JSON, no secrets in stack, parity with the retired Terraform module, stack-outputs contract (Purpose present, :5)."
  covers: "app/packages/infra (@hyveon/infra) bundled into app (not extraResources); DeploymentConfig/GameServerConfig in @hyveon/shared; per-game fan-out (task def, save-data AP, log group, SG ingress, cert AP); deployment-config JSON in S3 config bucket via RemoteFileStore (conditional writes, versions); Discord secret placeholders with create-only value; prebuilt Lambda bundles; stack outputs (cluster, networking, SG ids, Discord table/secret, interactions URL, runs table); env-token-interpolation (${hyveon.network.public-address}/public-ipv4, /bin/sh -c wrapper, command passthrough)."
  role: "spec (Pulumi infra program + shared config model + config store)"
  claims:
    - "Infrastructure program workspace — @hyveon/infra is TypeScript and part of the app bundle (not loose extraResources). It is covered by the root lint/typecheck/test scripts (:7-19)."
    - "Typed game-server configuration model — one shared type used by infra and the app. Adding or removing a map entry is the only edit needed, and every per-game resource is derived by iteration. A type change breaks both sides' typecheck (:21-38)."
    - "Configuration persisted as versioned JSON — the S3 config bucket is the only source, and the local-file mode is removed. Reads and writes go via RemoteFileStore (optimistic locking, history). No HCL parser dependency. Covers projectName, region, hosted zone and watchdog tunables. The round trip is lossless, and no bucket means 'setup incomplete' (:40-64)."
    - "No secret material enters the stack — no secret inputs. Discord secrets are declared with placeholders, and the value is create-only and ignored on reconcile, so a redeploy never reverts real creds. A test must prove survival across redeploy (:66-102)."
    - "Resource parity with the retired Terraform module — no ECS Service, no per-game DNS records (only a hosted-zone lookup), Caddy sidecar instead of an LB, watchdog state in task tags. Lambdas are deployed from prebuilt bundles without a container runtime (:104-126)."
    - "Stack outputs contract — exports cluster, networking, SG ids, Discord table/secret, interactions URL and runs table. The app reads the stack, not a state file. Never-deployed means 'not deployed yet', no throw. Outputs cover every consumer (:128-145)."
    - "Task definitions resolve environment variable interpolation tokens — ${hyveon.network.public-address} → <game>.<zone> at deploy, and errors if there is no zone. ${hyveon.network.public-ipv4} gets an injection-safe /bin/sh -c entrypoint wrapper with command from the entry. Command passes through regardless. Token-free games are byte-identical to before (:147-169)."
  observations:
    - "Heavily anchored to removed Terraform: 'replaces the HCL Terraform module' (:5), 'replacing the `terraform/` HCL tree' (:9), 'HCL game_servers map' (:23), 'replacing terraform.tfvars' (:42), 'equivalent of the ignore_changes = [secret_string] lifecycle rule the Terraform module relies on' (:72, present tense about a removed module), 'discord_bot_token/discord_public_key variables are removed rather than ported' (:68), and the requirement title 'Resource parity with the retired Terraform module' (:104). Parity against a deleted module is untestable now. The intent (the invariants list) should stand alone."
    - "CONFLICT with pulumi-engine-runtime (:77): ':70 the current provider is machine-bound and has no recovery path if the operator's machine is lost' contradicts the deterministic, reproducible, account-derived passphrase."
    - "Naming: uses snake_case `game_servers` (:23), while code/CLAUDE.md use `DeploymentConfig.gameServers`. This is HCL-era terminology."
    - "'No HCL parser dependency remains' (:61-64) is migration residue (cf. memory hcl2json bundle issue)."
    - "'identical to those produced before this capability existed' (:168-169) is change-relative wording, and needs a golden snapshot to test."
    - "Overlaps in-task-tls-termination (sidecar, cert AP, SG ingress), the CLAUDE.md invariants (ECS service, DNS, task-tag watchdog), orchestrator-integration-coverage stack outputs (o-i-c:158-170), and iac-run-history (runs table from outputs). Cross-refs an `env-token-interpolation` capability (:149) that is not in this part."
    - "Missing blank line between Purpose and '## Requirements' (:5-6)."
- path: openspec/specs/release-automation/spec.md
  purpose: "A manually triggered release that turns Conventional Commits on main into a versioned, tagged, AI-summarized draft GitHub Release, with a replay mode for regenerating notes (Purpose present, :5)."
  covers: ".github/workflows/release.yml (exists; workflow_dispatch inputs from/to/bump/skip_bump/tag); root package.json version; a non-default-token push identity; build/package jobs in the same run; AI summarization step; draft GitHub Release creation/update."
  role: "spec (CI/release workflow)"
  claims:
    - "Manual release trigger with configurable range — optional from/to/bump. Defaults: last release tag → tip of main. Explicit from/to ignores tags. With no tags, use full history (:9-22)."
    - "Automatic semver bump from Conventional Commits — breaking → major, feat → minor, else patch. An explicit bump overrides (:24-41)."
    - "Versioned commit and tag pushed to the protected default branch — the root package.json version is bumped in a commit containing only that change, pushed directly to the protected main with an annotated tag, using a non-default identity allowed by branch protection. Build and packaging happen in the same run, not on a tag trigger (:43-52)."
    - "Skip-bump replay mode — skip_bump plus an existing tag regenerates the changelog and AI summary with no bump, commit or tag. skip_bump without a tag fails fast (:54-63)."
    - "AI-generated release summary with changelog fallback — the AI summary is grounded only in the changelog, with the raw changelog alongside. If AI fails or times out, publish the raw changelog and do not fail the release (:65-74)."
    - "Draft release requiring human approval — the draft is created only after every platform build succeeds and installers are attached. No release exists while building. Replay updates notes in place and keeps the draft/published state. Never public without a human (:76-89)."
  observations:
    - "Policy tension with CLAUDE.md ('main is protected — direct pushes are blocked. Every change goes through a PR'). This spec mandates a direct commit to the protected default branch via a bypass identity (:44). It is intentional, but CLAUDE.md does not mention the exception."
    - "'grounded strictly in the facts present in the changelog' (:66) is an untestable property of AI output."
    - "The bump-to-patch scenario lists the allowed types (:36). It matches the CLAUDE.md PR title type list."
    - "No mention of install-and-signing-docs' unsigned builds or auto-update. Release artifacts feed install.md's GitHub Releases link (install-and-signing-docs:18-21)."
    - "Inputs `tag` and `skip_bump` are referenced in scenarios but not listed in the requirement's input list (:10 lists only start ref, end ref, bump)."
- path: openspec/specs/wizard-flow/spec.md
  purpose: "First-run wizard flow: launch gating on wizardCompleted, a resumable FirstRunWizardService, cloud choice, stack-init with phased progress, completion, Settings 'Reconfigure' (Purpose present, :5). Purpose omits guided-IAM, engine-version display, and the shell layout/sidebar requirements that the body contains."
  covers: "electron-store wizardCompleted / activeCloud via ElectronStoreService; FirstRunWizardService (app/packages/desktop-main/src/services/FirstRunWizardService.ts, verified references wizard-state.json) + wizard.controller.ts; WIZARD_STEPS (pick-cloud, guided-IAM, credentials, bootstrap, stack-init); window.hyveon.iac.stack.initialize() / iac.stack.initialize async-iterable {phase,status}; Settings Reconfigure (mode:'reconfigure'); iac.settings.engineVersion + PULUMI_ENGINE_VERSION; web wizard shell (md: breakpoint, clamp(672px,55vw,1500px)) + step-progress sidebar."
  role: "spec (desktop-main wizard service + web wizard UI + Settings)"
  claims:
    - "Wizard launch gating — wizardCompleted false or unset opens the wizard, true opens the dashboard. Completing sets it true and navigates (:9-21)."
    - "FirstRunWizardService with resumable state — per-step completion and answers are persisted to userData/wizard-state.json after each step, and the wizard resumes at the first incomplete step. Access goes through the service, with an Electron path seam that degrades outside Electron. A corrupt or missing file starts at step 1 (:23-35)."
    - "Pick-cloud step — single option AWS with a 'more clouds coming' footer. Persists activeCloud:'aws' via ElectronStoreService. Options are list-driven for future gcp/azure (:37-49)."
    - "Guided IAM provisioning step — sits between pick-cloud and credentials. Guided is the default, with an 'I already have credentials' skip. Completing it makes the rotated key the active source and satisfies the credentials step. Resume uses a typed sub-state (not-started|template-written|awaiting-key-intake|rotation-pending|complete) plus key-presence, so no secret is re-displayed (:51-73)."
    - "Stack initialization step with phased progress — iac.stack.initialize() (no payload) streams {phase: engine|plugins|operation, status: start|end}. A three-item checklist. Busy or a throw marks the last-started phase failed with an inline error and retry. Completion is enabled only when all phases are done (:75-87)."
    - "Wizard completion — persist answers, set wizardCompleted, open the dashboard. A clean machine reaches the dashboard with no file editing (:89-96)."
    - "Reconfigure entry point in Settings — reruns all steps. pick-cloud/credentials/bootstrap are always pre-completed. Guided-IAM is pre-completed only if there is a deploy-principal or profile record. Edit affordances. Existing config is preserved except what changes. Cancel restores only local ElectronStore state, and AWS-side mutations (CFN stack, rotated key, S3 encryption) persist, with that made visible (:98-135)."
    - "Resolved Pulumi engine version in Settings — shows the resolved version (iac.settings.engineVersion) and the pinned PULUMI_ENGINE_VERSION (:137-144)."
    - "Responsive wizard shell layout — in first-run mode at ≥768px: sidebar + content clamp(672px,55vw,1500px). Below that, a single centered column as before (:146-168)."
    - "Step progress sidebar — first-run only. Lists steps as completed/current/upcoming, non-interactive. None in reconfigure (:170-195)."
  observations:
    - "Internal inconsistency on state file name: requirement says `userData/wizard-state.json` (:25), scenario says `userData/state.json` (:34). Code (FirstRunWizardService.ts) references wizard-state.json, so the scenario is stale."
    - "Change-delta wording in the main spec: 'ahead of the current four-step baseline (pick-cloud, credentials, bootstrap, stack-init)' (:53), 'matching its current (pre-change) layout', 'increased from a 576px cap' (:152, :155), 'at its original width' (:168). This text is relative to a past change."
    - "Inconsistent evidence for guided-IAM pre-completion: 'when the stored AWS profile is evidence guided provisioning actually produced the active credential' (:100) vs the scenarios' 'a persisted deploy-principal record' (:129, :134)."
    - "Reconfigure step order is listed as 'cloud, credentials, bootstrap, guided-IAM, stack-init' (:100), but the guided-IAM requirement places guided-IAM between pick-cloud and credentials (:53). The ordering is inconsistent."
    - "'Mid-flow cancel → no partial changes are committed' (:117-120) vs the AWS-mutation caveat (:122-125). The first scenario overstates it unless it is read as local-only."
    - "Reconfigure scenario edits 'region in the credentials step' (:104), while guided-region-selection places region selection on the guided-IAM step. There may be two region inputs, or one of them is stale."
    - "The Settings engine-version requirement duplicates pulumi-engine-runtime 'Resolved version is observable' (p-e-r:52-55)."
    - "Guided-IAM sub-state requirement overlaps guided-iam-provisioning 'Rotation pending across restarts' (g-i-p:85-88)."
    - "Mixed hard-wrapped (:148-195) and unwrapped prose."
    - "Pixel and CSS values (clamp(672px, 55vw, 1500px), 576px) are implementation detail in normative text (:152-153)."
```

> Worker notes (active changes (3 large)):

Scope: all non-plan artifacts read in full. `plan.md` read only partly, as the brief said: for embed-file-browser (87 KB) and add-healthcheck-auth-type (92 KB), only the header (Goal/Architecture/Global Constraints) and each task/section heading with its first paragraph. add-pinned-hostname's `plan.md` is only 14 KB, so it was read in full.
Task counts come from `mech-changes.md` and were not recounted.

Implementation-state verdicts in brief:

| change | code on HEAD/main | delta in `openspec/specs/` | verdict |
|---|---|---|---|
| add-healthcheck-auth-type | yes (#530, f94bef16) | yes, all 5 headings, post-change text (synced in #644, cdd0cb8c) | **shipped + synced, unarchived**. verify.md says "Ready for archive". |
| add-pinned-hostname | yes (#692, 5b984bbe) | no: `openspec/specs/game-hostname-pinning/` doesn't exist | **shipped, not synced, unarchived**. 2 manual tasks open. |
| embed-file-browser | no (HEAD still has `filebrowser/filebrowser:latest`, no VolumeFiles/Registry services) | no on HEAD | **implemented on an unmerged 6-branch PR stack** (`origin/embed-file-browser-1-backend` … `-6-closeout`). The closeout branch archives the change to `archive/2026-10-30-embed-file-browser` and syncs both specs. On HEAD, tasks.md is stale (3/44 ticked). |

---

## openspec/changes/add-pinned-hostname

```yaml
- path: openspec/changes/add-pinned-hostname/.openspec.yaml
  purpose: change metadata
  covers: schema superpowers-bridge, created 2026-10-26
  claims: []
  role: config
  observations: []

- path: openspec/changes/add-pinned-hostname/proposal.md
  purpose: why/what for an opt-in per-game pinned os.hostname() (Foundry VTT licence binding on Fargate)
  covers:
    - "@hyveon/shared: GameServer.pinnedHostname (gameServerConfig.ts); gameServerSchema + checkPinnedHostname + reserved-path constant (gameServerValidator.ts)"
    - "@hyveon/infra: new hostnameShim.ts; ecs.ts per-game task definition"
    - "@hyveon/web: WizardDraft, draftFromGameServer/draftToPayload/toProposedEntry (wizard-form.utils.ts), environment-step, review-step"
    - "mirrored type copies: desktop-preload hyveon-api.ts GameServer; web api.service.ts + desktop-main ElectronStoreService.ts GameWizardDraft; isGameWizardDraft in GameWizardDraftService.ts"
    - "desktop-main diagnosticsBundleAllowlist.ts hasPinnedHostname"
  claims:
    - "Fargate awsvpc can't set a container hostname; each task gets ip-10-0-x-y.<region>.compute.internal, so Foundry licence verification fails each start (proposal.md:3)"
    - "When the field is set: task-scoped ephemeral volume, non-essential `hostname-shim` init container (public.ecr.aws/docker/library/busybox), dependsOn SUCCESS, read-only mount at /hyveon/hostname-shim, NODE_OPTIONS=--require=... prepended to the operator's value (proposal.md:9)"
    - "Absent field = byte-identical task definition; non-breaking (proposal.md:11)"
    - "Validation pattern ^[A-Za-z0-9]([A-Za-z0-9._-]{0,61}[A-Za-z0-9])?$; reserved-path collision is rejected (proposal.md:14-15)"
    - "No modified capabilities; new capability game-hostname-pinning (proposal.md:26,30)"
    - "No new AWS resources; ~2 MB extra image pull per start (proposal.md:40)"
  role: docs (OpenSpec proposal)
  observations:
    - "Says mirrored type copies exist and removing them is out of scope (proposal.md:37). This is a known duplication hotspot (hand-kept GameServer/GameWizardDraft copies in 3-4 packages)."

- path: openspec/changes/add-pinned-hostname/design.md
  purpose: design decisions D1-D9 for the pinned hostname shim
  covers: [app/packages/infra/src/ecs.ts (resolveGameEnvironment, ipv4 /bin/sh -c wrapper), app/packages/shared/src/gameServerValidator.ts deep rules, wizard steps identity→resources→networking→storage→environment→review, EditGameForm reuse]
  claims:
    - "D1 field is a literal string, absent = off (design.md:33-37)"
    - "D2 pattern is exported as PINNED_HOSTNAME_PATTERN + _DESCRIPTION like GAME_NAME_PATTERN; underscores are allowed because the value is never DNS-resolved (design.md:39-43)"
    - "D3 delivery: volume '<game>-hostname-shim' with no efsVolumeConfiguration (Fargate ephemeral); container hostname-shim essential:false, command echo <base64> | base64 -d > /hyveon/hostname-shim/hostname-shim.js, awslogs prefix hostname-shim; game container dependsOn SUCCESS + ro mount (design.md:45-52)"
    - "D4 image public.ecr.aws/docker/library/busybox:1.38.0 as a named constant; no new egress (design.md:54-59)"
    - "D5 infra owns the shim bytes; shared owns only the pattern, description and HOSTNAME_SHIM_MOUNT_PATH (barrel-safe) (design.md:61-70)"
    - "D6 NODE_OPTIONS merge happens after resolveGameEnvironment, shim first, exactly one entry (design.md:72-76)"
    - "D7 reject volumes[i].container_path equal to or under /hyveon/hostname-shim (design.md:78-81)"
    - "D8 environment-step switch; helper text leads with 'Node.js game servers only'; empty string is passed through so validation blocks it (design.md:83-86)"
    - "D9 no new DriftChangedField (design.md:88-90)"
    - "Rollback: clear the field and apply (design.md:109)"
  role: docs (OpenSpec design)
  observations:
    - "D7 covers only the reserved container_path. The delta spec (spec.md:19,41-44) also rejects a game named `hostname-shim` and a volume named `hostname-shim`. Those rules are not in design.md or tasks.md 1.4. Code has HOSTNAME_SHIM_RESERVED_NAME (shared/src/gameServerValidator.ts:72), so the spec, not the design, reflects what shipped."
    - "Acceptance mentions 'recorded in verify.md' (design.md:111), but the change has no verify.md."

- path: openspec/changes/add-pinned-hostname/tasks.md
  purpose: implementation checklist (20 [x] / 2 [ ])
  covers: [shared, infra, web wizard, mirrored types, diagnostics allowlist, docs, verification]
  claims:
    - "Open tasks:"
    - "  5.3 Pulumi preview against an existing stack with no opted-in game shows zero task-definition diff (tasks.md:35)"
    - "  5.4 Live: enable on the Foundry game, apply, start, accept the EULA once, stop, start again → log shows `Software license verification succeeded` and no EULA prompt (tasks.md:36)"
  role: docs (task list)
  observations:
    - "Both open tasks are manual/live checks; all code, docs and test tasks are ticked."

- path: openspec/changes/add-pinned-hostname/specs/game-hostname-pinning/spec.md
  purpose: ADDED delta for the new capability game-hostname-pinning (5 requirements)
  covers: [GameServerConfig.pinnedHostname, validator, infra task-definition wiring, NODE_OPTIONS merge, wizard]
  claims:
    - "Optional pinned hostname field: the value is exactly what os.hostname() returns; when absent, behaviour and task definition are unchanged; no secret material; round-trips through deployment-config.json and the redacted shape; absent is not synthesized (spec.md:3-15)"
    - "Pinned hostname validation: pattern, issue at path pinnedHostname. When set, also rejects a container_path that is or sits under /hyveon/hostname-shim, a game named hostname-shim, and a volume named hostname-shim. Wizard and server share the pattern and message (spec.md:17-49)"
    - "Task definition wiring: <game>-hostname-shim volume with no EFS; non-essential hostname-shim container with a pinned busybox image, rw mount, writes a CommonJS module replacing require('node:os').hostname; game container gets dependsOn SUCCESS and a ro mount. No resources outside the task definition, no ECS Service, Caddy unchanged, other games unaffected (spec.md:51-78)"
    - "NODE_OPTIONS preloads the shim: exactly one entry starting with --require=/hyveon/hostname-shim/hostname-shim.js; the operator value is appended after ${hyveon.*} token resolution; coexists with the ipv4 boot wrapper (spec.md:80-97)"
    - "Wizard control: 'Pin hostname' switch in the environment step (also used by the edit form). On = game name, off = cleared. Helper text states Node.js-only, the use case, and the one-time EULA. Invalid values block the step; review shows the value (spec.md:99-131)"
  role: docs (delta spec)
  observations:
    - "Not present in openspec/specs/ (no game-hostname-pinning dir), so it is unsynced although the code shipped in #692."

- path: openspec/changes/add-pinned-hostname/brainstorm.md
  purpose: raw brainstorm capture (2026-10-26 live-debugging session)
  covers: [Foundry felddy/foundryvtt v14.369, Fargate hostname behaviour, shim delivery options]
  claims:
    - "Evidence: felddy README says the licence is bound to the hostname; awsvpc ignores the hostname param; a 4-run local matrix verified the shim (brainstorm.md:12-26)"
    - "Q4 options: A init container + ephemeral volume (chosen); B file_seeds onto EFS; C --import=data: ESM (follow-up spike); D custom image (rejected; Hyveon never builds images) (brainstorm.md:52-57)"
    - "Q7 merge rather than reject NODE_OPTIONS (brainstorm.md:70-74)"
    - "Q9 no DriftChangedField (brainstorm.md:80-82)"
    - "Out of scope: Foundry preset, non-Node pinning (LD_PRELOAD/UTS), --import variant (brainstorm.md:91-95)"
  role: docs
  observations:
    - "Q8 helper-text copy (brainstorm.md:78) lacks the 'Node.js game servers only' lead that the design/spec later made mandatory (operator follow-up noted at brainstorm.md:86). Superseded wording."

- path: openspec/changes/add-pinned-hostname/plan.md
  purpose: superpowers implementation plan, 5 tasks (read in full, 14 KB)
  covers: [Task 1 shared field/validation, Task 2 infra hostnameShim.ts + ecs.ts, Task 3 wizard + type copies, Task 4 diagnostics + docs + field audit, Task 5 gate + live check]
  data_shapes:
    - "hostnameShim.ts exports: HOSTNAME_SHIM_IMAGE, HOSTNAME_SHIM_CONTAINER_NAME='hostname-shim', buildHostnameShimSource(hostname), buildHostnameShimContainer({game,hostname,logConfiguration}), hostnameShimVolumeName(game), mergeNodeOptions(environment) (plan.md:66-72)"
  claims:
    - "Review focus: ipv4 token survives the merge; underscore hostnames; switch-on with an empty name shows a validation error; /hyveon/hostname-shimmer sibling allowed; untouched edit omits the field (plan.md:24-30)"
    - "logConfiguration streamPrefix widened to 'ecs' | 'caddy' | 'hostname-shim' (plan.md:89)"
    - "Switch id pin-hostname-toggle, input id pinned-hostname-input (plan.md:113)"
  role: docs (plan)
  observations:
    - "Plan step checkboxes are all [ ] (plan.md:44-132) while tasks.md is ticked. The plan is not used as a tracker."
    - "The plan names buildHostnameShimContainer (plan.md:70); tasks.md 2.2 names buildHostnameShimInitContainer (tasks.md:12). Naming drift between the artifacts."
    - "Task 5 Step 3 says 'Record in verify.md' (plan.md:132); there is no verify.md."
```

## openspec/changes/add-healthcheck-auth-type

```yaml
- path: openspec/changes/add-healthcheck-auth-type/.openspec.yaml
  purpose: change metadata
  covers: schema superpowers-bridge, created 2026-08-14
  claims: []
  role: config
  observations: []

- path: openspec/changes/add-healthcheck-auth-type/proposal.md
  purpose: add a raw|basic|bearer type to health-check auth, with app-owned Secrets Manager secrets for basic/bearer
  covers: [app/packages/shared/src/gameServerConfig.ts GameServerHealthCheckAuth, gameServerValidator.ts, app/packages/lambda/health-check/src/handler.ts (~L87-113), web networking-step.component.tsx, desktop-main service/controller, desktop-preload hyveon-api.ts, IamCheckService tests, docs/docs/components/*]
  claims:
    - "Today only secretArn exists; its value is injected verbatim as Authorization (proposal.md:3,8)"
    - "type optional, defaults to raw; basic/bearer are app-owned and the engine builds the header (proposal.md:9)"
    - "No IAM change: secretsmanager:* is in HYVEON_DEPLOY_ALL_ACTIONS (iamPolicy.ts) (proposal.md:11)"
    - "App-owned secrets are deleted on auth clear or game delete; raw secrets are never touched (proposal.md:15)"
    - "Depends on add-pluggable-health-checks code having landed (confirmed). That change's archival is a separate housekeeping gap (proposal.md:33)"
  role: docs (proposal)
  observations:
    - "Proposal promises 'New IPC surface for creating/updating/deleting app-owned secrets' (proposal.md:11) and a desktop-preload bridge (proposal.md:30). The implementation deliberately added no new IPC channel (tasks.md:20, plan.md:621). The proposal was not updated."

- path: openspec/changes/add-healthcheck-auth-type/design.md
  purpose: decisions D1-D6
  covers: [GameServerHealthCheck shape, lambda health-check handler, networking-step ARN field (networking-step.component.tsx:409-421), IamCheckService/iamPolicy.ts]
  claims:
    - "D1 type?: 'raw'|'basic'|'bearer', absent = raw everywhere (design.md:22-25)"
    - "D2 basic secret value = JSON.stringify({username,password}); username not in config (design.md:27-30)"
    - "D3 app calls CreateSecretCommand on first save and PutSecretValueCommand later; raw stays operator-owned (design.md:32-35)"
    - "D4 DeleteSecretCommand on clear/switch-away/disable/game delete, app-owned only (design.md:37-40)"
    - "D5 the engine branches header construction on type (Basic base64 / Bearer) (design.md:42-45)"
    - "D6 no IAM change; add a regression test that CreateSecret/PutSecretValue/DeleteSecret are covered (iamPolicy.ts:20,93) (design.md:47-50)"
    - "Risk: deterministic name hyveon-{gameId}-healthcheck-auth; reuse an existing ARN, else create (design.md:55)"
    - "Open questions: recovery window, naming collision (design.md:63-66). Resolved per verify.md:37 (default recovery window, never ForceDeleteWithoutRecovery)."
  role: docs (design)
  observations:
    - "The open questions are still phrased as open in design.md:63-66 although verify.md and plan Global Constraints resolved them."
    - "Line refs (handler.ts:87-113, networking-step.component.tsx:409-421, gameServerConfig.ts:97-101 in brainstorm) are likely stale: health-check fields were later split out of NetworkingStep (c52b76cf, #580), and `type?:` now sits at gameServerConfig.ts:129."

- path: openspec/changes/add-healthcheck-auth-type/tasks.md
  purpose: checklist, 27 [x] / 0 [ ]
  covers: [shared types/validation, engine, secret lifecycle, wizard, IAM regression, docs, pre-PR gate]
  claims:
    - "No open tasks."
    - "3.5 records a deviation: no standalone IPC channel; lifecycle wired into GamesWriteService.createGame/updateGame/deleteGame behind existing games.create/update/delete (tasks.md:20)"
    - "7.3 3227/3227 unit tests; 7.4 42 passed + 1 skipped integration; 7.5 6 e2e failures in iac.spec.ts/logs.spec.ts dismissed as pre-existing flakiness (tasks.md:44-46)"
  role: docs
  observations:
    - "7.5 accepts red e2e runs as 'pre-existing parallel-worker flakiness' (tasks.md:46). .claude/rules/pr-stacking.md requires exit code 0, 'not documented known failure'."

- path: openspec/changes/add-healthcheck-auth-type/verify.md
  purpose: /opsx:verify report
  covers: [handler.ts, gameServerValidator.ts, GamesWriteService, GameWizardDraftService.redactSecretFields, RedactedGameServerHealthCheck, shared/src/secrets/secretsStore.ts, IamCheckService.test.ts]
  claims:
    - "27/27 tasks; requirements mapped to commits dd4756b1/364e8b4b (engine), 26ed50de (validator), 03330ab0 (redaction), b19773b1/9a892e44/4c00adff (lifecycle), ef6fc526 (IAM test) (verify.md:17-23)"
    - "Two critical defects fixed during review: an AWS mutation before validation (9a892e44), and auth:null blocking the wizard (65c0c1fd) (verify.md:29-30)"
    - "Final verdict: 'Ready for archive' (verify.md:54)"
  role: docs (verification report)
  observations:
    - "The summary table says '6/6 delta-spec requirements' (verify.md:7-8), but the delta has 5 requirements and the list enumerates 5 (verify.md:19-23). Count error."
    - "Refers to `.superpowers/sdd/plan/progress.md` ledger (verify.md:11). The path may not exist in the repo (not checked)."
    - "Task 6 notes the write-docs skill was not visible to the subagent and was followed by hand (verify.md:42)."

- path: openspec/changes/add-healthcheck-auth-type/specs/game-health-checks/spec.md
  purpose: delta to game-health-checks, 3 MODIFIED + 2 ADDED
  covers: [health-check Lambda request/header construction, validator, redaction, GamesWriteService secret lifecycle, IamCheckService]
  claims:
    - "MODIFIED 'The HTTP check kind evaluates a declared request against a declared condition': adds type raw|basic|bearer (absent=raw). raw = verbatim Authorization; basic = JSON {username,password} → Basic, malformed = unavailable credential; bearer = Bearer <secret>. The constructed header overrides an operator Authorization header. Validation rejects inline-credential-looking header values. Restates the operator set, the restricted JSONPath, timeoutMs 100-10000, no redirects (spec.md:3-113)"
    - "MODIFIED 'Health-check configuration is validated before it is saved': basic requires username+password, bearer requires a token, raw/no-type requires an ARN (spec.md:115-152)"
    - "MODIFIED 'Health-check credentials never reach the operator interface': applies uniformly to all three types, including the basic username (spec.md:154-174)"
    - "ADDED 'App-owned health-check credentials are provisioned and retired by the app': basic/bearer secrets are created by the system; an edit updates in place; remove/game delete deletes; raw is never deleted (spec.md:178-224)"
    - "ADDED 'App-owned credential lifecycle requires no additional account permission': the Settings account check still passes (spec.md:226-238)"
  role: docs (delta spec)
  observations:
    - "All 5 headings already exist in openspec/specs/game-health-checks/spec.md with the type-aware text (main spec lines ~51-73, 264-289). Synced by cdd0cb8c (#644)."

- path: openspec/changes/add-healthcheck-auth-type/brainstorm.md
  purpose: raw brainstorm, Q1-Q5
  covers: [gameServerConfig.ts:97-101, handler.ts:87-113, secretsStore.ts putBotToken precedent, IamCheckService]
  claims:
    - "Q1 username in the secret; Q2 per-type fields; Q3 app creates the secret; Q4 delete on unset/game removal; Q5 no IAM change plus a regression test (brainstorm.md:17-35)"
  role: docs
  observations:
    - "Resolved design still lists 'New desktop-main IPC (create/update/delete secret) + preload bridge' (brainstorm.md:44). Superseded by the no-new-IPC deviation."

- path: openspec/changes/add-healthcheck-auth-type/plan.md
  purpose: superpowers plan, Tasks 1-7 (headings + first paragraphs + header only; 92 KB)
  covers: [Task 1 shared types/validation (L28), Task 2 engine (L380), Task 3 secret lifecycle (L619), Task 4 wizard (L1141), Task 5 IAM (L1870), Task 6 docs (L1929), Task 7 pre-PR gate (L1956)]
  claims:
    - "Persisted shape stays { type?, secretArn } for all types; GamesWriteService resolves secretArn for basic/bearer before validate+persist (plan.md:7)"
    - "Secret name hyveon-{gameId}-healthcheck-auth; default recovery window; plaintext is write-only; no new @MessagePattern (plan.md:15-23)"
    - "Task 3 design note: no new IPC/preload; lifecycle goes through GamesWriteService (plan.md:621)"
  role: docs (plan)
  observations:
    - "Most of the plan body was not read (by instruction)."
```

## openspec/changes/embed-file-browser

```yaml
- path: openspec/changes/embed-file-browser/.openspec.yaml
  purpose: change metadata
  covers: schema superpowers-bridge, created 2026-10-26
  claims: []
  role: config
  observations: []

- path: openspec/changes/embed-file-browser/proposal.md
  purpose: replace the external-browser FileBrowser link with an in-app per-game file browser page
  covers:
    - "@hyveon/infra buildStackOutputs → new efsVolumeAccessPoints output"
    - "@hyveon/desktop-main FileManagerService split (registry + launch/teardown), PulumiService projection, EcsService.tagTask + findRunningTaskOrThrow, NativeDialogService, VolumeFilesService + VolumeFileBackend (FileBrowser impl extending FileBrowserClient), volumeFiles.* IPC, quit hook, FolderUploadService changes"
    - "@hyveon/shared StackOutputs.efsVolumeAccessPoints, volumeFiles subpath module"
    - "@hyveon/desktop-preload: legacy files.* and FileMgrResult.credentials removed; webUtils.getPathForFile"
    - "@hyveon/web /games/:name/files page; removal of FileManagerModal, useFileManager"
  claims:
    - "Today: Files → modal → <a target=_blank> to http://<ip>:8080 + plaintext username/password; shell.openExternal opened the browser behind another app (proposal.md:3,8)"
    - "FileBrowser archived 2026-09-01 with unfixed advisories (proposal.md:3)"
    - "Every helper session (browse + upload) serves TLS with a per-launch pinned cert; credentials removed from IPC (proposal.md:15)"
    - "Main-process helper session registry per game; stop on Stop, last release, page leave + grace, quit; 2 h auto-stop and orphan sweep remain backstops; orphan → Restart session (proposal.md:21)"
    - "VolumeFileBackend interface; image pinned by digest (proposal.md:27)"
    - "Read-only while the server is STARTING/RUNNING; fails closed with 'Couldn't confirm the server is stopped' + Retry (proposal.md:32)"
    - "Shipped #672 bug: a second-volume upload lands in the first volume; the fix exports every access point and mounts all volumes (proposal.md:35-38)"
    - "Modifies game-volume-folder-upload (base spec exists since add-folder-volume-upload was archived 2026-10-26) (proposal.md:46)"
  role: docs (proposal)
  observations:
    - "Mentions 'docs/docs/setup.md if it mentions the file manager link' (proposal.md:56). Conditional, not verified."

- path: openspec/changes/embed-file-browser/design.md
  purpose: design with resolved Open Questions 1-11 and decisions D1-D13
  covers: [game-card.component.tsx:266, FileManagerModal, useFileManager (use-file-manager.hook.ts:122-136), FilesController, FileManagerService.launch (FileManagerService.ts:332), electron-entry.ts:44-51 setDefaultBrowserOpener, infra/src/program.ts:406-408 buildStackOutputs, infra/src/efs.ts gameAccessPoints, shared/src/folderUpload/paths.ts toRemotePath, FolderScanService, DiagnosticsController, FolderUploadService.prepare, EcsService.findRunningTask, buildTlsContainerSettings, EphemeralCert, fake-filebrowser-server, PollingProvider]
  data_shapes:
    - "Registry entry {taskArn, ip, operatorIp, credentials, cert, backend, layout, holders:Set<'browse'|uploadRunId>, state} (design.md:97)"
    - "VolumeFileBackend: list, stat, readStream, writeStream({overwrite}), mkdir, move, remove({recursive}), optional archiveStream (design.md:112-116)"
    - "efsVolumeAccessPoints: Record<game, Record<volumeName, accessPointId>> (design.md:176)"
    - "Requests {game, volume, path} with path relative to the volume root (design.md:126)"
    - "Session states stopped/starting/running/stopping/orphaned/failed/not_deployed (design.md:154)"
  claims:
    - "OQ resolutions: explicit Start (the dashboard Files button navigates and starts); read-only with no override; FileBrowser replacement is a follow-up (pin v2.63.23 digest); text edit ≤1 MiB UTF-8 with mtime check; 5 min grace; no external-browser escape hatch (design.md:5-10)"
    - "Second round: every volume in v1; #672 fix in-stack; guard fails closed; subagent-driven; no release partway through the stack (design.md:14-18)"
    - "Root cause: the browser opened unfocused behind another app; openExternal rejections go only to console.error; egress-IP mismatch since #672 removed the world-open rule; the useFileManager poller stops early (design.md:30-35)"
    - "The helper sees only the first volume (efsAccessPoints maps game → first volume; mounted at /srv) (design.md:39)"
    - "D1 native renderer page, not a WebContentsView embed (design.md:75-86)"
    - "D2 public IP + operator /32 + pinned TLS for browse too; SSM rejected (host binary) (design.md:88-94)"
    - "D3 HelperSessionRegistry acquire/attach/detach/release/stop/before-quit/orphaned; on IP change authorize the new /32 and re-tag OperatorIp via new EcsService.tagTask (design.md:96-109)"
    - "D4 FileBrowserClient implements the backend with GET /api/raw, PATCH ?action=rename, DELETE, ?algo=zip; the upload engine migrates onto it (design.md:111-120)"
    - "D5 volumeFiles IPC namespace + window.hyveon.volumeFiles; uploadDropped resolves paths in the preload; legacy files.list|start|stop, credentials, url deleted; NativeDialogService extracted from FolderScanService + DiagnosticsController (design.md:122-134)"
    - "D6 path safety: POSIX-normalized, absolute, no ../NUL/empty, names without / (design.md:136-139)"
    - "D7 server-running / server-check-failed typed refusals; findRunningTaskOrThrow plus a catch-and-log findRunningTask wrapper; the folder-upload preflight uses the throwing variant (design.md:141-146)"
    - "D8 readText too-large/binary; writeText conflict on mtime; plain textarea (design.md:148-151)"
    - "D9 ready = RUNNING + public IP + backend login over pinned TLS (design.md:154)"
    - "D11 no platform branches; Windows-reserved filename sanitization on download (design.md:170)"
    - "D12 buildHelperVolumeLayout: vol-<index> mounted at /srv/<dir>, where dir = the volume name if it matches ^[A-Za-z0-9._-]{1,64}$ and is unique, else volume-<index>; first-volume fallback via efsAccessPoints (design.md:174-185)"
    - "D13 the upload resolves the owning volume (deepest container_path) → layout.toHelperPath; refuses an unmounted volume before launch (design.md:187-190)"
  role: docs (design)
  observations:
    - "D1 says desktop-main exposes 'typed files.* IPC operations' (design.md:76), but D5 introduces a separate volumeFiles namespace and deletes files.* (design.md:123-128). Internal inconsistency."
    - "Non-goal says no change to IAM/infra resources/deployment-config except one stack output (design.md:70). That contradicts brainstorm.md Q10, which says 'No infra or IAM change' (brainstorm.md:91). The brainstorm predates the second round."
    - "D7: EcsService.findRunningTask swallows ECS errors and returns null, which reads as 'not running'. That is a fail-open behaviour on HEAD (design.md:143)."
    - "Notes for a separate hardening issue: will-navigate deny and a setDefaultBrowserOpener allowlist (brainstorm.md:85)."

- path: openspec/changes/embed-file-browser/tasks.md
  purpose: 6-group PR-stack checklist (3 [x] / 41 [ ] on HEAD)
  covers: [PR1 backend/path safety, PR2 multi-volume + #672 fix, PR3 registry/TLS, PR4 volumeFiles IPC/preload, PR5 web page + legacy removal, close-out]
  claims:
    - "Done: 0.1 archive add-folder-volume-upload; 0.2 record OQ1-6; 0.3 record OQ7-10 (tasks.md:12-14)"
    - "Open on HEAD (all of groups 1-6):"
    - "  1.1 VolumeFileBackend interface + typed errors (not-found, conflict, unreachable, auth, pin-mismatch); 1.2 extend FileBrowserClient (raw, rename, delete, stat, zip, pinned check); 1.3 migrate uploadEngine onto the interface; 1.4 volume path validator in @hyveon/shared/volumeFiles; 1.5 pin FILEBROWSER_IMAGE to the v2.63.23 digest; 1.6 fake-filebrowser-server extensions + tests"
    - "  2.1 efsVolumeAccessPoints stack output + StackOutputs + PulumiService projection + fixtures; 2.2 buildHelperVolumeLayout; 2.3 FileManagerService mounts the layout; 2.4 fix the #672 wrong-volume upload + regression; 2.5 EcsService.findRunningTaskOrThrow + fail-closed upload preflight; 2.6 tests + tier-2 spec; 2.7 docs (infra.md, management-app.md)"
    - "  3.1 extract launchHelper/listHelperTask; 3.2 HelperSessionRegistry; 3.3 TLS readiness; 3.4 IP-change re-authorize + tagTask; 3.5 FolderUploadService on the registry (replaces the helper-open refusal); 3.6 sweepStrayHelpers skips registry sessions; 3.7 before-quit hook; 3.8 unit + integration tests; 3.9 docs (management-app.md, architecture.md)"
    - "  4.1 shared volumeFiles types; 4.2 NativeDialogService extraction; 4.3 VolumeFilesService; 4.4 downloads; 4.5 uploadFiles/uploadFolder (persistSelection:false); 4.6 VolumeFilesController; 4.7 preload API + uploadDropped + __test.mock; 4.8 tests; 4.9 docs IPC table"
    - "  5.1 hooks; 5.2 /games/:name/files page + components; 5.3 dashboard Files navigates+starts, game detail link; 5.4 delete FileManagerModal/useFileManager/files.* channels/credentials/url; 5.5 jsdom + Playwright chromium + electron smoke + no-secret assertion; 5.6 docs (dashboard.md, games.md)"
    - "  6.1 operator plan+apply for efsVolumeAccessPoints ([~]-eligible); 6.2 manual dogfood ([~]-eligible); 6.3 /opsx:verify + sync/archive; 6.4 follow-up issue to replace the FileBrowser backend"
  role: docs (task list)
  observations:
    - "Stale on HEAD. On origin/embed-file-browser-6-closeout the archived copy (openspec/changes/archive/2026-10-30-embed-file-browser/tasks.md) has 42 [x] and only 6.1 and 6.2 as [~]."
    - "The header comment (tasks.md:2-4) still says 'Each numbered group from 1 to 5 is one PR', while the remote stack has 6 branches (closeout = -6)."

- path: openspec/changes/embed-file-browser/specs/game-volume-file-browser/spec.md
  purpose: ADDED delta for the new capability game-volume-file-browser (10 requirements)
  covers: [web /games/:name/files page, desktop-main registry, backend, VolumeFilesService, preload]
  claims:
    - "In-app file browser page per game: routed per game, volume picker (name + container path), reachable from the dashboard card and the game detail page. Never an external browser or embedded remote content. Dashboard Files navigates and starts; direct navigation doesn't start; not-deployed state; an unavailable volume needs an apply (spec.md:3-28)"
    - "Helper credentials and address stay in the main process: never returned over IPC, rendered, persisted or logged; the renderer gets state, volume names/paths, metadata and results only (spec.md:30-39)"
    - "Encrypted, pinned, operator-only transport: TLS per launch, pinned; credential refused on mismatch; reachable only from the operator /32; the rule is revoked when unneeded; on IP change re-authorize, revoke, retry once, then Restart (spec.md:41-54)"
    - "One application-owned helper session per game: shared by browse and upload; stopped on Stop, on last release (browse after grace), and on quit; auto-stop backstop; no ECS Service; Stop with an active upload asks to confirm then cancels; orphan → only Restart (spec.md:56-81)"
    - "Session readiness and state reporting: states listed; running only after RUNNING + address + pinned auth; keeps refreshing; stop reason on failure; warning when <10 min to auto-stop (spec.md:83-100)"
    - "Browsing and file operations: breadcrumb, sortable listing (name/type/size/mtime), mkdir/rename/delete (confirmed)/upload files+folder/download file+folder archive; folder upload uses selected volume container_path + current dir and doesn't replace the saved selection; drag-drop; name conflict refused (spec.md:102-127)"
    - "Volume path safety: the volume must be mounted by the session; absolute, no ../NUL; names without separators; local paths only from main dialogs or preload drag-drop (spec.md:129-142)"
    - "Read-only while the game server is running: browse/download allowed; mutations disabled and refused; an unknown state counts as running (spec.md:144-157)"
    - "Small text file view and edit: UTF-8 ≤1 MiB; mtime conflict refusal keeps edits; larger/binary files → download (spec.md:159-172)"
    - "Replaceable file backend: interface list/stat/read/write/mkdir/move/delete/optional archive; renderer/IPC independent of the helper; image pinned by digest or exact tag; folder download hidden when the backend has no archive support (spec.md:174-183)"
  role: docs (delta spec)
  observations:
    - "openspec/specs/game-volume-file-browser/ does not exist on HEAD. It is created (193 lines) only on origin/embed-file-browser-6-closeout (commit 66154ed1)."

- path: openspec/changes/embed-file-browser/specs/game-volume-folder-upload/spec.md
  purpose: MODIFIED delta for game-volume-folder-upload (2 requirements)
  covers: [FolderUploadService, sweepStrayHelpers, Diagnostics 'Clean up stray helpers']
  claims:
    - "MODIFIED 'Upload goes directly into the mounted volume': write into the volume whose container_path is the deepest match; the helper mounts each applied volume; reuse an app-held session, else launch for the upload; release the hold on finish/fail/cancel; refused (fail closed) when the server state can't be confirmed; second-volume scenario (/data/saves/worlds → saves); unmounted destination volume refused before launch; orphan → ask to restart (spec.md:3-36)"
    - "MODIFIED 'Helper sessions are tagged and stray ones are cleaned up': upload helpers tagged; the sweep (startup + Diagnostics) stops helpers owned by neither an active run nor an app-held session; startup sweep >15 min; a browse session survives cleanup (spec.md:38-55)"
  role: docs (delta spec)
  observations:
    - "Main spec openspec/specs/game-volume-folder-upload/spec.md:41 still says the app 'asks the operator to stop it first rather than reusing a session whose credential it does not hold'. That is the pre-change text, so the MODIFIED delta is unsynced on HEAD. The closeout branch updates it (+42 lines)."

- path: openspec/changes/embed-file-browser/brainstorm.md
  purpose: raw brainstorm (autonomous run) with root-cause investigation and Q1-Q10
  covers: [operator log %APPDATA%/hyveon/logs/main-2026-10-26.log, CloudWatch /ecs/filebrowser-foundryvtt, file-manager SG sg-0b77e5f21347be585, file-manager-modal.component.tsx:51, electron-entry.ts:45-50, use-file-manager.hook.ts:122-136]
  claims:
    - "Every app-controlled step up to rendering the link worked; the unverified hop is openExternal (brainstorm.md:36-40)"
    - "Latent bug: the useFileManager poller stops on the first running read even if url is undefined (brainstorm.md:42)"
    - "Resolved: the browser opened unfocused (brainstorm.md:44)"
    - "Q1 native page (b) chosen over WebContentsView (a) / hybrid (c) (brainstorm.md:48-56)"
    - "Q2 public IP + /32 + pinned TLS; Lambda-on-EFS is the long-term follow-up (brainstorm.md:58-63)"
    - "Q3 explicit Start; ~a cent/hour at 0.25 vCPU/0.5 GB (brainstorm.md:65-66)"
    - "Q8 hardening ideas: will-navigate deny, openExternal allowlist; not in this change (brainstorm.md:85)"
  role: docs
  observations:
    - "Contains a real AWS security-group ID (brainstorm.md:30) and a local operator log path (brainstorm.md:27) in committed docs."
    - "Q10 'No infra or IAM change is needed' (brainstorm.md:91) was superseded by D12 (one new stack output)."
    - "Q4 registry shape lacks the layout/operatorIp/state fields that design D3 has (brainstorm.md:69 vs design.md:97). Superseded."

- path: openspec/changes/embed-file-browser/plan.md
  purpose: superpowers plan, 24 tasks over 5 PRs + close-out (headings + first paragraphs + header only; 87 KB)
  covers: ["PR1 Tasks 1-5 (path validator L83, backend interface + reads L124, writes L183, upload engine migration L212, image pin L230)", "PR2 Tasks 6-9 (stack output L249, layout L266, #672 fix L310, fail-closed + tier-2 + docs L330)", "PR3 Tasks 10-14 (extract primitives L358, registry core L385, TLS readiness + IP recovery L444, upload on registry/sweep/quit L467, tier-2 + docs L498)", "PR4 Tasks 15-20 (shared types L516, NativeDialogService L557, VolumeFilesService L572, downloads/uploads L609, controller + push channels L633, preload + docs L669)", "PR5 Tasks 21-24 (hooks L694, page L716, remove external link L757, Playwright + docs L768)", "Close-out L786"]
  claims:
    - "Checkbox legend includes [~] deferred, which must be enumerated in verify.md §7 (plan.md:5-8)"
    - "Tech stack: Electron 43, NestJS IPC, undici pinned TLS, react-router HashRouter (plan.md:14)"
    - "Review focus 1: racing acquires → exactly one RunTask (plan.md:39)"
  role: docs (plan)
  observations:
    - "Most of the plan body was not read (by instruction)."
```

## openspec/changes/add-update-feed-fallback

- path: openspec/changes/add-update-feed-fallback/ (.openspec.yaml, proposal.md, design.md, tasks.md, specs/auto-update-scaffold/spec.md)
  purpose: Client-side recovery when the latest GitHub release lacks the platform's electron-updater feed file (v0.7.0 shipped with no assets) — proposal.md:3
  role: openspec change (schema superpowers-bridge, created 2026-10-24 — .openspec.yaml:1-2)
  covers: app/packages/desktop-main/src/updater.ts, new updater-fallback.ts (pickFallbackRelease, resolveFallbackFeedUrl), app/packages/web/src/pages/settings.page.tsx; docs/docs/app/settings.md, docs/docs/components/management-app.md (proposal.md:30-32)
  claims:
    - "[ADDED] Failed update checks fall back to the newest release with a feed: on checkForUpdates failure, query GitHub releases API for newest non-draft/non-prerelease release (greatest published_at) carrying latest.yml / latest-mac.yml / latest-linux.yml, point generic provider at it, retry once; surface ORIGINAL error if none/lookup fails/retry fails; never download/install; restore primary github feed afterwards — specs/auto-update-scaffold/spec.md:3-20 (3 scenarios)"
    - "[ADDED] Failed manual checks link to the releases page: 'Download manually' link to https://github.com/CoderCoco-Studios/Hyveon/releases in a new window on ok:false or IPC rejection; absent on success — spec.md:22-34 (2 scenarios)"
    - Design decisions: resolver in own module using native fetch to GET /repos/CoderCoco-Studios/Hyveon/releases?per_page=10, unauthenticated (design.md:17); retry via setFeedURL({provider:'generic'}) (design.md:18); original error wins (design.md:19); manual-check failure resolved from the call's rejection not first `error` event (design.md:20); shared loadAutoUpdater()/checkWithFallback() (design.md:21); `finally` restores github feed since setFeedURL mutates singleton (design.md:25); no pagination (design.md:26)
  implementation_state: tasks 6 [x] / 0 [ ]. Shipped as commit 1e30ebe7 (#668). Both ADDED requirement headings already present in openspec/specs/auto-update-scaffold/spec.md:141,160 → synced but NOT archived.
  observations:
    - Non-goals pin autoDownload/autoInstallOnAppQuit false (design.md:12) — later superseded in spirit by add-user-initiated-update-install which adds explicit download/install.
    - Owner/repo hardcoded as single constant CoderCoco-Studios/Hyveon (design.md:17); related fix f1124566 (#663) re-pointed links at CoderCoco-Studios.
    - Prevention side landed separately in release workflow (#664, #665, #667) — design.md:3.

## openspec/changes/add-user-initiated-update-install

- path: openspec/changes/add-user-initiated-update-install/ (.openspec.yaml, proposal.md, design.md, tasks.md, specs/auto-update-scaffold/spec.md)
  purpose: Let the operator explicitly download then restart-and-install an update found by Settings → Updates "Check for Updates" — proposal.md:3
  role: openspec change (schema spec-driven — NOT superpowers-bridge — created 2026-10-25, .openspec.yaml:1-2)
  covers: desktop-main updater.ts (downloadUpdateNow(onProgress), installDownloadedUpdate()), ipc-main-bridge.ts SELF_BRIDGED_PATTERNS, controllers/iac-settings.controller.ts; shared/src/autoUpdateSetting.ts (UpdateDownloadProgress, UpdateDownloadResult, UpdateInstallResult); desktop-preload preload.ts + hyveon-api.ts (autoUpdateDownload HyveonStreamHandle, autoUpdateInstall); web settings.page.tsx, web/e2e/fixtures/hyveon-http-bridge.ts (proposal.md:25-29)
  data_shapes: IPC `iac.settings.autoUpdate.download` acks {started, streamId}, pushes `.download.chunk` progress and one `.download.end` (error on failure); `iac.settings.autoUpdate.install` plain invoke → {ok:true} before quit (design.md:14-15); renderer ManualCheckState union + downloading/downloaded/download-failed (design.md:17)
  claims:
    - "[ADDED] Operator can download and install an available update: only two explicit actions may download/install; boot-time and manual checks stay detect-only; autoDownload/autoInstallOnAppQuit stay false; download reports progress + terminal result; install quits and runs installer — spec.md:3-41 (7 scenarios: button only when updateAvailable; `Downloading v<version>… <percent>%`; `v<version> downloaded. Restart to install.`; quitAndInstall; re-check once if no cached check; unavailable outside Electron; streamId/chunk/end over IPC)"
    - "[MODIFIED] Failed manual checks link to the releases page: extended to download and install failures; link hidden while downloading/downloaded; 'Download & Install' re-offered as retry — spec.md:45-62 (3 scenarios)"
    - Design: progress reuses the iac.stack.initialize side-channel stream pattern with createBufferedStream; handler self-bridged because it needs the IpcMainInvokeEvent sender (design.md:14); quitAndInstall(false, true) (design.md:15); "Please check update first" handled by re-running check-with-fallback (design.md:16); unsigned macOS download failures surface as ordinary failure (design.md:18)
  implementation_state: tasks 11 [x] / 0 [ ]. Shipped as commit 47499ed7 (#675). NOT synced: main spec auto-update-scaffold has no "Operator can download and install" requirement and line 160's link requirement is the pre-modification text → shipped-but-unsynced-and-unarchived.
  observations:
    - Uses schema `spec-driven` while sibling change add-update-feed-fallback uses `superpowers-bridge` (.openspec.yaml:1 in each).
    - Reinterprets the main spec's "never downloads or installs itself" as automatic-only (design.md:3) — a semantic shift that should be reflected when merging into auto-update-scaffold.
    - Mid-download page close does not cancel the download (design.md:22).
    - Sequential dependency: its MODIFIED requirement modifies a requirement ADDED by add-update-feed-fallback; must be applied after it.

## openspec/changes/add-icmp-ingress

- path: openspec/changes/add-icmp-ingress/ (.openspec.yaml, proposal.md, design.md, tasks.md, brainstorm.md, plan.md, specs/game-port-visibility/spec.md)
  purpose: Let a game declare ICMP echo (ping) reachability as a `ports` entry so Palworld's community-server-browser join (which pings first) works without manual SG drift — proposal.md:3, brainstorm.md:10-19
  role: openspec change (schema superpowers-bridge, created 2026-08-31 — .openspec.yaml:1-2)
  covers: app/packages/shared/src/gameServerConfig.ts (GameServerPort TSDoc), gameServerValidator.ts (gameServerPortSchema, deep validation, checkPortCollisions); app/packages/infra/src/securityGroups.ts (defineSecurityGroups, dedupedDirectGamePorts/dedupedInternalGamePorts), ecs.ts (portMappings), lambdas.ts (firstPortByGame); app/packages/web/src/components/add-game-wizard/networking-step.component.tsx (PROTOCOL_OPTIONS), wizard-form.utils.ts; docs/docs/components/infra.md, docs/docs/app/ games/wizard pages, README.md + docs/docs/setup.md Palworld examples (proposal.md:36-40, plan.md:24-185)
  data_shapes: port entry `{ container: <ICMP type 0-255>, protocol: 'icmp', visibility? }`; SG rule `{ protocol: 'icmp', fromPort: <type>, toPort: -1, description: 'ICMP type <n>' }` (design.md:28, plan.md:137-140)
  claims:
    - "[ADDED] ICMP port declarations: protocol may be lowercase 'icmp'; `container` = ICMP type, integer 0-255 else rejected naming the entry; produces SG ingress icmp/fromPort=type/toPort=-1, NEVER an ECS portMappings entry; https-games tcp/udp-only rule still rejects icmp — specs/game-port-visibility/spec.md:3-20 (4 scenarios incl. internal icmp sourced from VPC CIDR only)"
    - "[ADDED] Cross-game ICMP declarations: same icmp pair allowed on multiple games if effective visibility matches (public/omitted vs internal), SG carries one deduped rule; conflicting visibility rejected naming both games; same-game duplicates still rejected — spec.md:24-37"
    - "[ADDED] Wizard supports ICMP entries: icmp in protocol dropdown; numeric field presented as ICMP type, default 8, hint '8 = echo request (ping)', 0-255 message — spec.md:41-50"
    - "[ADDED] Connect-port surfaces exclude ICMP entries: firstPortByGame/Discord GAME_PORTS uses first non-icmp port (icmp first + 8211/udp → 8211) — spec.md:54-59"
    - "[MODIFIED] Internal ports are ingressed from the VPC CIDR block only: scoped to non-HTTPS games; adds scenario that tcp/udp pairs can't reach SG with conflicting visibility because cross-game collision rejects them, icmp governed by the cross-game ICMP rule — spec.md:65-78"
    - Design decisions: D1 model as ports entry with protocol 'icmp' (vs allow_ping boolean / always-on; user chose 2026-08-31) design.md:22-25; D2 types 0-255, wizard default 8, no -1 "all types" design.md:27-30; D3 exclude from portMappings (ECS rejects non-tcp/udp; awsvpc ENI receives ICMP regardless) design.md:32-34; D4 exempt icmp from cross-game collision design.md:36-39; D5 visibility applies unchanged design.md:41-43; D6 firstPortByGame skips icmp design.md:45-47
    - Non-goals: no auto-ICMP, no ICMP on https games, no egress modeling, no ICMP health checking — design.md:14-18
  implementation_state: tasks all [x] except 5.3 `[~]` manual `pulumi preview` check (tasks.md:33; mech count 16/0 excludes the [~]). Shipped in f81b09b7 "feat(infra): provision icmp echo ingress from icmp port entries (#599)" — that same commit added the change dir AND synced openspec/specs/game-port-visibility/spec.md (all 4 ADDED headings present at main spec :114,:135,:152,:165). Code present (securityGroups.ts:106-108,204 mention icmp). → shipped + synced, NOT archived.
  observations:
    - Change dir and implementation landed in one commit (f81b09b7) — the proposal never had its own proposal PR.
    - plan.md step checkboxes (plan.md:33-189) all remain `- [ ]` even though tasks.md is fully [x]; plan.md is not the tracker.
    - The MODIFIED "Internal ports…" and ADDED "Connect-port surfaces exclude ICMP entries" have since been overwritten in main by https-explicit-web-port (#691): main spec :33-47 no longer says "For a non-HTTPS game", and :165-175 adds the HTTPS 443-URL clause. Archiving add-icmp-ingress by re-applying its delta would REVERT those https edits — archive must skip spec application.
    - Design migration step names a concrete live SG id `sg-0e37b362ca57210bf` and a live task / public IP (design.md:60, brainstorm.md:10,17) — operational detail baked into the spec record.
    - plan.md line refs (`gameServerValidator.ts ~L627-660`, `~L554/565`, `~L848`, `securityGroups.ts ~L263-292`, `ecs.ts ~L173-177`, `lambdas.ts ~L549`, README ~L85-100, setup.md ~L370) are point-in-time and now stale (e.g. validator later grew; checkHttpsPortRules is at :749).
    - Brainstorm states "healthCheck.port must already match a declared tcp port" (brainstorm.md:45) — since relaxed by https-explicit-web-port (healthCheck.port may be webPort).

## openspec/changes/add-pluggable-health-checks

- path: openspec/changes/add-pluggable-health-checks/ (.openspec.yaml, proposal.md, design.md, tasks.md, specs/game-health-checks/spec.md, specs/lambda-runtime-currency/spec.md)
  purpose: Optional per-game `healthCheck` that replaces the CloudWatch NetworkPacketsIn idle heuristic with a game-aware HTTP check (Palworld REST API trigger) — proposal.md:3-10
  role: openspec change (schema spec-driven, created 2026-08-11 — .openspec.yaml:1-2); no brainstorm.md / plan.md
  covers: @hyveon/shared gameServerConfig.ts (GameServerHealthCheck, activeWhen, auth; healthCheck?), gameServerValidator.ts (gameServerHealthCheckSchema, checkHealthCheckRules, gamesWithHealthChecks helper); new package @hyveon/lambda-health-check (pure engine + handler); app/packages/lambda/watchdog (getNetworkPackets, getEniId, FAMILY_TO_GAME, idle_checks tag, routing); app/packages/infra iam.ts (efsSeederRoles pattern), securityGroups.ts (healthCheckSg, gameServersSg rules), lambdas.ts (function, env var map alongside connectMessagesByGame/firstPortByGame), network.ts; app/package.json build:lambdas; @hyveon/web wizard (secretSet); docs lambdas.md, infra.md, docs/docs/app wizard page (proposal.md:61-79, design.md:5-25, tasks.md)
  data_shapes: invoke payload `{ game, taskArn, healthCheck }` (design.md:94-95); engine `(config, status, rawBody) → { active, reason }` (design.md:77, tasks.md:12); healthCheck = kind 'http', scheme http|https, port, path (rooted), method GET|POST|PUT|PATCH|HEAD, headers, auth.secretArn?, timeoutMs 100-10000, activeWhen { jsonPath, operator equals|notEquals|greaterThan|lessThan|contains|exists, value? } (spec.md:43-85)
  claims:
    - "[ADDED] A game may declare an authoritative health check: optional; if declared its verdict REPLACES (not combines with) the network-traffic measurement; carries a kind discriminator for future kinds — specs/game-health-checks/spec.md:10-36"
    - "[ADDED] The HTTP check kind evaluates a declared request against a declared condition: single comparison; credential injected only as fixed `Authorization` header with raw value, no `Bearer ` prefix, overrides operator header; validation rejects header values resembling inline credentials; restricted JSONPath (field access + numeric index) resolving to exactly one scalar (exists tests any cardinality); strict-typed equals, numeric gt/lt, string contains; timeoutMs 100-10000 wall clock; no redirect following (3xx = failure) — spec.md:38-109"
    - "[ADDED] A failed check reports the server as active: timeout, refused, non-2xx, unparseable JSON, no/uncomparable value, unavailable credential, check not executable at all → active, with reason distinguishing failure from genuine activity — spec.md:111-140"
    - "[ADDED] Health checking is provisioned only for games that use it: zero resources/permissions/cost when no game opts in; one shared set otherwise — spec.md:142-161"
    - "[ADDED] Reaching into a game task is confined to what the configuration declares: egress only to union of opted-in health-check ports toward game-server tasks (port-level, not game-level, because one shared SG); AWS API calls unaffected (public subnets + IGW, no NAT/endpoints per network.ts); Secrets access only referenced secrets; not reachable from outside, invocable only by the idle-decision owner; host derived from ECS task address, never config; watchdog gets no network placement/credential — spec.md:163-210"
    - "[ADDED] Health-check configuration is validated before it is saved: reject port not in game's ports, unrooted path, timeout out of range, comparison without value, malformed credential ref — spec.md:212-233"
    - "[ADDED] The basis for a shutdown decision is recoverable from the logs: verdict logged with game/kind/verdict/reason; failure-derived at elevated severity; reason threaded into watchdog idle-decision log; no credentials or response bodies — spec.md:235-260"
    - "[ADDED] Health-check credentials never reach the operator interface: show credential-set indicator only — spec.md:262-272"
    - "[MODIFIED] lambda-runtime-currency / Lambdas run a supported AWS runtime: conditionally provisioned functions held to same runtime rule; LAMBDA_RUNTIME nodejs24.x; deployed-functions scenario adds health-check function where it exists — specs/lambda-runtime-currency/spec.md:3-18"
    - Design decisions: separate shared conditionally-provisioned Lambda, not inside watchdog (blast radius, ENI cold start) and not per-game (multiplication); invoked RequestResponse (design.md:54-73); pure engine separated from handler, like canRun() (design.md:75-81); routing in watchdog via JSON env var game→full healthCheck declaration, watchdog forwards secretArn (reference) but never GetSecretValue (design.md:83-107); fail-active at engine, handler, and watchdog-invoke layers (design.md:109-116); zod structure vs check* business rules split (design.md:118-125); destination host never configurable — SSRF closed by construction (design.md:127-133)
    - Accepted risks: port-level confinement via shared gameServersSg, per-game SGs recorded as follow-on (design.md:137-144); misconfigured check keeps server running forever → warn logs (design.md:146-150); single-condition activeWhen (design.md:152-155); no body logging (design.md:157-159); build:lambdas explicit enumeration trap (design.md:161-163)
  implementation_state: tasks 29 [x] / 0 [ ] — no open tasks. Shipped 2026-08-11 as fe8564d1 (#496 shared), 77ebc1af (#497 engine), b67ab55b (#498 handler), 58fe9847 (#499 watchdog routing), 58b655f7 (#500 infra), 0a16e68d (#502 wizard); follow-ups c52b76cf (#580), 22f450e0 (#562 package health-check dist). Synced to openspec/specs/game-health-checks/spec.md and lambda-runtime-currency by cdd0cb8c (#644) — all 8 ADDED headings present (main :12,:40,:152,:183,:204,:253,:292,:319) and lambda-runtime-currency main :9-23 matches the MODIFIED text verbatim. → shipped + synced, NOT archived.
  observations:
    - Since sync, three of its ADDED requirements were MODIFIED in main by add-healthcheck-auth-type (shipped f94bef16 #530): main now has `auth.type` raw|basic|bearer (main spec :51-66, :131-151, :264-289) whereas this delta still says "raw value with no added prefix" only (spec.md:49-55). Archiving this change by re-applying its delta would regress the auth-type wording; archive must be spec-skipping, ordered before add-healthcheck-auth-type (covered by another worker).
    - lambda-runtime-currency delta lists `efs-seeder` among "always-provisioned functions" (lambda-runtime-currency/spec.md:17), but the same proposal says efs-seeder functions exist only for games declaring `file_seeds` (proposal.md:24-25; design.md:10-14) — efs-seeder is itself conditional. Same text now lives in main lambda-runtime-currency spec.
    - Delta spec carries a `## Purpose` section (game-health-checks/spec.md:1-6) — unusual for a delta; harmless.
    - Proposal says "five" deployed functions → six (proposal.md:53-57); CLAUDE.md now says six packages (four always-on, two conditional), consistent with efs-seeder being conditional.
    - Design cites code locations as fact: watchdog `getNetworkPackets` returns `MIN_PACKETS + 1` on failed query (design.md:8-9), `getEniId` (design.md:130).
    - healthCheck.port "must appear in the game's ports" (proposal.md:62-63, spec.md:218) — relaxed later by https-explicit-web-port (may be `webPort`, validator.ts:1000).

## openspec/changes/add-release-automation

- path: openspec/changes/add-release-automation/ (.openspec.yaml, proposal.md, design.md, tasks.md, specs/release-automation/spec.md)
  purpose: workflow_dispatch release workflow: git-cliff changelog + semver bump → root package.json bump commit + tag pushed to protected main via GitHub App token → Claude-written summary → draft GitHub Release — proposal.md:3-19
  role: openspec change (schema spec-driven, created 2026-08-11 — .openspec.yaml:1-2)
  covers: .github/workflows/release.yml (new), cliff.toml (new), .github/workflows/package.yml (consumed as-is, per design), root package.json version, docs/docs/guides/maintainer.md, docs/docs/components/infra.md; secrets/vars RELEASE_APP_ID, RELEASE_APP_PRIVATE_KEY, CLAUDE_CODE_OAUTH_TOKEN; ruleset `enforce-main-branch-protection` (proposal.md:29-36)
  data_shapes: workflow_dispatch inputs `from`, `to`, `bump` (auto|major|minor|patch, default auto), `skip_bump` (bool, default false), `tag` (required iff skip_bump) — proposal.md:7-12, tasks.md:16
  claims:
    - "[ADDED] Manual release trigger with configurable range: default from = latest release tag (full history if none), to = main tip; explicit range ignores tags — spec.md:7-20"
    - "[ADDED] Automatic semver bump from Conventional Commits: breaking→major, feat→minor, only fix/chore/refactor/docs/test/perf/build/ci/style→patch; explicit bump override — spec.md:22-39"
    - "[ADDED] Versioned commit and tag pushed to the protected default branch: root manifest version updated, single-change commit + annotated tag pushed with non-default identity SO THAT the tag push triggers downstream tag-triggered workflows (package.yml) — spec.md:41-50"
    - "[ADDED] Skip-bump replay mode: regenerate changelog + summary for an existing tag without manifest/commit/tag changes; skip_bump without tag fails fast before any work — spec.md:52-61"
    - "[ADDED] AI-generated release summary with changelog fallback: grounded in changelog; raw changelog alongside; AI failure never fails the release — spec.md:63-72"
    - "[ADDED] Draft release requiring human approval: draft for new tag; replay updates notes in place without changing draft/published state — spec.md:74-83"
    - Design decisions: git-cliff 2.13.1 via npx (not release-please/semantic-release, which can't do explicit range/replay; not orhun/git-cliff-action) design.md:25-30; `npm version --no-git-tag-version --workspaces=false` root only design.md:32-33; GitHub App installation token via actions/create-github-app-token (GITHUB_TOKEN pushes don't trigger on:push; PAT rejected; auto-merge-PR alternative rejected since ruleset already has bypass actors and 0 required approvals) design.md:35-38; anthropics/claude-code-action with subscription OAuth token instead of hand-rolled @anthropic-ai/sdk script, `--model claude-opus-5`, `--allowedTools "Read,Write"`, continue-on-error + fallback design.md:40-41; draft-only via softprops/action-gh-release design.md:43-44
    - Non-goals: per-workspace versioning, scheduled releases, changing package.yml, creating the GitHub App — design.md:17-21
  implementation_state: tasks 18 [x] / 8 [ ]. Open tasks (all out-of-band admin or live verification): 4.1 create org-owned GitHub App "Hyveon Release Bot" (Contents r/w) and install; 4.2 store RELEASE_APP_ID / RELEASE_APP_PRIVATE_KEY; 4.3 store CLAUDE_CODE_OAUTH_TOKEN; 4.4 add App as Always bypass actor on enforce-main-branch-protection; 4.5 confirm App token can push commit+tag to main; 5.2 end-to-end dry run (bump commit, tag, package.yml fires, draft with AI body); 5.3 replay-path dry run; 5.4 force AI failure and confirm raw-changelog fallback (tasks.md:27-38). Workflow shipped 044176fd (#495); synced to openspec/specs/release-automation/spec.md by cdd0cb8c (#644). In practice the open admin/verification tasks look de-facto done: real releases have been cut through it (chore(release) v0.7.0…v0.9.1 commits; root package.json version is 0.9.1; release.yml:61-64 uses create-github-app-token with vars.RELEASE_APP_ID / secrets.RELEASE_APP_PRIVATE_KEY). → shipped + synced, NOT archived; tasks.md unticked.
  observations:
    - Main spec has DRIFTED PAST this delta (via d01cdd08 #664 and 074a6807 #665): main says the identity is distinct "so that the push is permitted by the branch protection rules" (not to trigger downstream workflows); scenario renamed "Build pipeline runs in the same workflow run" (release.yml builds/packages the tag itself, not package.yml's tag trigger); Draft requirement now requires the release be created only after every platform build succeeds with installers attached, plus new scenario "No release exists while builds are running". The delta (spec.md:42-50,74-79) still has the old wording → archiving with spec application would REVERT main.
    - design.md is stale against current release.yml: model `claude-opus-5` (design.md:41) vs `claude-sonnet-5-5` (release.yml:181, #666); `--max-turns 5` (tasks.md:10) vs `--max-turns 50` (release.yml:181); "reuse package.yml tag-triggered publish path" + non-goal "Changing package.yml" (design.md:15,20) violated by #665 which moved builds into release.yml; release.yml also passes `GITHUB_TOKEN` to steps (release.yml:132,149,302; cf. #673).
    - Design context is frozen at proposal time: "root package.json.version is 0.1.0", "only tag is v0.1.0" (design.md:5-7; proposal.md:3) — now false (v0.9.1).
    - Task 2.4 is struck through as superseded but ticked [x] (tasks.md:12).
    - Task 5.1 references "the new script" typecheck though no script exists after the claude-code-action pivot (tasks.md:35).
    - Release-feed-asset failure gate (#667) and per-platform composite actions (#665: .github/actions/build-package, publish-release, setup-app) have no requirement in either this delta or main release-automation spec headings (6 headings only).

## openspec/changes/add-scripted-health-checks

- path: openspec/changes/add-scripted-health-checks/ (.openspec.yaml, proposal.md, design.md, tasks.md, specs/game-health-checks/spec.md, specs/scripted-health-checks/spec.md)
  purpose: Second health-check kind `script`: operator-authored JS executed in a QuickJS-WASM sandbox inside the health-check Lambda, for games the declarative http kind can't express — proposal.md:3-22
  role: openspec change (schema spec-driven, created 2026-08-11 — .openspec.yaml:1-2); explicitly depends on add-pluggable-health-checks (proposal.md:80-82, design.md:3-7)
  covers: @hyveon/shared GameServerHealthCheck → discriminated union over kind, zod discriminated union, checkHealthCheckRules; @hyveon/lambda-health-check sandbox host + kind dispatch; new dep quickjs-emscripten; app/packages/infra health-check function memory/timeout; @hyveon/web wizard script authoring; audit trail; docs lambdas.md + docs/docs/app wizard page (proposal.md:64-82, tasks.md)
  data_shapes: script declaration { kind:'script', source, port, auth?, timeout } (spec.md:16-17, tasks.md:9); guest entrypoint `export default` fn called with `{ game, task:{host,port}, secret|undefined, request }`, must settle to `{ active: boolean, reason: string }` (design.md:119-136); request capability: script supplies path/method/headers/body only; response = status, game-returned headers, body as UTF-8 (textual/JSON) or base64 (scripted spec.md:24-32)
  claims:
    - "[MODIFIED] game-health-checks / A game may declare an authoritative health check: kind discriminator now selects one of TWO kinds (declarative request+condition, operator-authored source); all kinds same verdict shape + failure semantics; new scenario kind change doesn't alter idle counting — specs/game-health-checks/spec.md:3-39"
    - "[MODIFIED] game-health-checks / Reaching into a game task is confined…: confinement covers requests caused by operator source; destination SHALL NOT derive from any value the source produces; new scenario 'Operator-authored source cannot redirect a check' — game-health-checks/spec.md:41-97"
    - "[ADDED] A script determines the verdict for the game that declares it: declaration = source, port, optional credential ref, timeout; script gets game, task address, credential value, request capability; host-enforced byte limits on outbound body (reject) and inbound body (truncate) — scripted-health-checks/spec.md:11-43"
    - "[ADDED] A script executes without access to the host's authority: isolated interpreter; no env vars, role creds, filesystem, unprovided modules, IMDS, or other destinations; only the host capability can cause requests and it owns the destination; isolation enforced by host, not source inspection; script receives only its own credential — spec.md:45-81"
    - "[ADDED] Script execution is bounded by limits the host enforces: wall clock, memory, outbound-request count, non-cooperative; cannot affect other games' checks; termination cancels in-flight host work — spec.md:83-115"
    - "[ADDED] A script that fails reports the server as active: unevaluable, throws, limit exceeded, invalid/no verdict → active with locating reason — spec.md:117-137"
    - "[ADDED] Authoring a script is an explicit, recorded act: authoring UI shows capability statement; create/modify recorded in audit trail with game + time; credential shown as set-only — spec.md:139-161"
    - "[ADDED] A script's output does not leak into the deployment's records: only verdict + bounded reason logged; reason redacted for secret-like patterns incl. the resolved credential, and truncated — spec.md:163-192"
    - Design decisions: quickjs-emscripten 0.32.0 (pure WASM, bundles with esbuild, Node-version-agnostic, interrupt handler + allocator limit) chosen over isolated-vm 7.0.1 (native addon, layer/ABI burden) and ses (same-realm, not a boundary) design.md:46-72; host owns destination, script owns only request shape — no fetch (design.md:74-95); script CAN mutate game state on the permitted port (design.md:87-95); limits enforced host-side + separate depth/size bound on marshalling the returned value (design.md:97-115); single `export default` contract, thenables drained via executePendingJobs (design.md:117-136); reason truncated at boundary (design.md:138-143); source stored in DeploymentConfig for S3 version history (design.md:145-152)
    - Accepted risks: sandbox escape would reach GetSecretValue on ALL opted-in games' secrets because predecessor chose one shared Lambda on the premise it "executes no operator-supplied code" — explicitly in tension with this change's own goal; possible fixes STS per-secret AssumeRole or per-game Lambdas for script kind (design.md:164-179); slow script delays every other task in the sequential watchdog run (design.md:181-189); QuickJS ≠ Node built-ins (design.md:191-194); WASM bundling into CJS untested in repo → sequenced first (design.md:200-203)
  implementation_state: tasks 0 [x] / 28 [ ] — nothing started. Open tasks: 1.1 add quickjs-emscripten at current registry version and confirm esbuild handler.cjs embeds/resolves WASM; 1.2 spike test against built bundle; 1.3 measure memory/cold-start, raise infra memory/timeout if needed; 2.1 discriminated union with script member; 2.2 zod union + source-length bound; 2.3 port rule both kinds + script-only rules; 2.4 tests (http unchanged, script valid, unknown kind rejected); 3.1 fresh context per execution, disposed on all paths; 3.2 request capability with no destination parameter; 3.3 interrupt-handler wall clock + test; 3.4 memory ceiling + request-cap counter; 3.5 marshal/validate verdict + truncate reason; 4.1 no env/creds/filesystem; 4.2 redirect attempts (absolute URL path, Host header, `://`/authority in path) ignored/rejected; 4.3 no module loading; 4.4 per-execution isolation in warm container; 4.5 fail-active for every failure; 4.6 oversized return value fails safely; 5.1 dispatch on kind; 5.2 fetch credential once, pass only that value; 5.3 logging contract (no credential/source/body); 6.1 wizard script authoring + capability statement; 6.2 audit-trail recording; 6.3 secretSet boolean + spec; 7.1 document QuickJS guest env; 7.2 document security posture; 7.3 update lambdas.md + wizard doc page; 7.4 lint/typecheck/test/integration gates (tasks.md:3-48). No code: `git grep quickjs` in app/ returns nothing; gameServerConfig.ts:173 still `kind: 'http'` only; openspec/specs/scripted-health-checks/ does not exist; main game-health-checks still carries the pre-modification text ("so that additional kinds of check can be introduced later", main :12-13). Spec-only commit e63ad3bd (#491). → NOT shipped (proposal only).
  observations:
    - Its MODIFIED "Reaching into a game task…" drops the `app/packages/infra/src/network.ts provisions no NAT gateway or VPC endpoints` parenthetical present in main (diff vs main spec :15-20) — unintended deletion if applied verbatim.
    - Its MODIFIED requirements were written against add-pluggable-health-checks text; add-healthcheck-auth-type has since reshaped `auth` (type raw|basic|bearer, app-owned credentials). Scripted spec says the script receives "the credential value" / `secret` (spec.md:19-21, design.md:126) — undefined for a `basic` credential (username+password) or app-owned credentials; needs reconciling with auth-type.
    - Proposal says game-health-checks "states that a health check executes no operator-supplied code" (proposal.md:58-62) — no such requirement exists in the delta or main; that statement lives in add-pluggable-health-checks' proposal/design (proposal.md:21-22, design.md:69-70).
    - Delta spec includes `## Purpose` (scripted spec.md:1-7) — fine for a new capability.
    - Dependency versions written from memory into design (quickjs-emscripten 0.32.0, isolated-vm 7.0.1 — design.md:50,57); task 1.1 correctly requires registry lookup.
    - Audit trail referenced as existing ("The repo has an audit trail…", design.md:17) without naming the service.

## openspec/changes/add-vpc-flow-logs

- path: openspec/changes/add-vpc-flow-logs/ (.openspec.yaml, proposal.md, design.md, tasks.md, specs/vpc-flow-logs/spec.md)
  purpose: Pulumi-managed VPC Flow Log to a dedicated CloudWatch Logs group, default-on DeploymentConfig toggle, and in-app recent/page/tail viewer with a REJECT-only filter — proposal.md:3-30
  role: openspec change (schema spec-driven, created 2026-08-31 — .openspec.yaml:1-2); new capability `vpc-flow-logs`, no modified capabilities (proposal.md:36-47)
  covers: app/packages/infra/src/network.ts (defineNetwork, NetworkResources.vpc), new flowLogs.ts, program.ts, iam.ts pattern, new stack output; @hyveon/shared DeploymentConfig + DEPLOYMENT_CONFIG_DEFAULTS; desktop-main LogsService.ts (getRecentLogs, getOlderLogs, getNewerLogs, streamLogs, *Lambda* twins, fetchAcrossStreams, listStreams, MAX_STREAMS_SCANNED, getRecentFromLogGroup, resolveLambdaLogGroup, LogEventLine), logs.controller.ts; @hyveon/web Infrastructure/Logs page; docs infra.md, docs/docs/app/*, games.md/troubleshooting (design.md:5-23, tasks.md)
  data_shapes: `vpcFlowLogsEnabled: boolean` default true (design.md:97-98, tasks.md:3); log group `/vpc/${projectName}-flow-logs` (design.md:78); aws.ec2.FlowLog trafficType 'ALL' on vpc.id (design.md:50-66); parsed pipe-delimited flow record incl. `action` (tasks.md:17)
  claims:
    - "[ADDED] VPC Flow Log resource provisioning: aws.ec2.FlowLog on the VPC, ALL traffic, to dedicated CW Logs group when enabled; default on; disabling removes only the flow log — spec.md:7-20"
    - "[ADDED] Scoped IAM role for flow log delivery: resource scope exactly the flow-log group ARN, no wildcard — spec.md:22-27"
    - "[ADDED] Flow-log enable/disable configuration: DeploymentConfig boolean, unset resolves true — spec.md:29-34"
    - "[ADDED] Recent flow log record fetch: up to N records from newest stream, oldest-first; no streams → single informational message; CW failure → single message + log with group as identifier, no raw SDK error — spec.md:36-49"
    - "[ADDED] Older and newer flow log record paging: across all streams from timestamp boundary; newer excludes already-delivered identities — spec.md:51-60"
    - "[ADDED] Live flow log record tail: yields new records; ends on abort signal — spec.md:62-71"
    - "[ADDED] Reject-only filtering in the operator UI: 'rejected only' filter shows only action=REJECT — spec.md:73-78"
    - Design decisions: D1 VPC-level single FlowLog (not per subnet/ENI) design.md:50-56; D2 trafficType ALL with UI defaulting to REJECT view design.md:58-66; D3 CloudWatch Logs + dedicated role (not S3) design.md:68-76; D4 `/vpc/` naming namespace design.md:78-82; D5 extend LogsService with get{Recent,Older,Newer}FlowLogs/streamFlowLogs, record parsing as pure transform at controller/renderer boundary design.md:84-95; D6 plain boolean toggle, retention never-expire and trafficType fixed design.md:97-106
    - Risks: ingestion cost (docs must state per-GB) design.md:110-113; ~1 min aggregation lag stated in UI design.md:114-117; toggling off orphans log group (manual cleanup) design.md:118-124
  implementation_state: tasks 0 [x] / 22 [ ] — nothing started. Open tasks: 1.1 add vpcFlowLogsEnabled + DEPLOYMENT_CONFIG_DEFAULTS; 1.2 tests; 2.1 flowLogs.ts (role/policy, log group, FlowLog ALL); 2.2 gate on toggle from program.ts; 2.3 stack output for log group name; 2.4 infra tests (enabled/disabled, IAM scope, naming/tags); 3.1 flow-log group resolver; 3.2 four LogsService methods reusing fetchAcrossStreams/listStreams/getRecentFromLogGroup; 3.3 pure record parser; 3.4 service + parser tests; 3.5 IPC handlers with logger.debug entry; 4.1 flow-log view on Infrastructure/Logs page; 4.2 rejected-only filter client-side; 4.3 component/integration tests; 5.1 infra.md resource table + cost note; 5.2 docs/docs/app page; 5.3 settings docs for toggle; 6.1-6.5 lint, typecheck, test, integration, e2e (tasks.md:3-39). No code: `git grep` for vpcFlowLogs/FlowLog in app/ returns nothing; no openspec/specs/vpc-flow-logs/. Only commit: 35c67b53 proposal (#595). → NOT shipped.
  observations:
    - Motivation differs from add-icmp-ingress's root cause: proposal frames Palworld browser failure as possibly "the task successfully reaching Palworld's backend outbound" (proposal.md:5-8), whereas add-icmp-ingress (same date, 2026-08-31) proved — using manually enabled flow logs — it was inbound ICMP echo rejected (add-icmp-ingress/design.md:3). The flow-log proposal predates/doesn't reference that finding.
    - Proposal says flow logs use the "v5+ field set" (proposal.md:21) but design/spec never pin a log format; parser (tasks.md:17) would depend on it.
    - D5 says "a fourth thin wrapper (after game/Lambda's two)" — wording inconsistent ("third resolution family" in heading vs "fourth wrapper") (design.md:84-90).
    - Spec scenario "returns a single informational message rather than throwing or returning an empty array" mirrors LogsService behaviour asserted as existing (spec.md:43-49); not verified here.
    - Design claims log retention default never-expire "matching every other log group this program already creates" (design.md:103-105) — unverified against infra code.
    - Task 3.1 offers two alternatives (stack output vs deriving name from DeploymentConfigService) — open decision left in tasks.

## openspec/changes/https-explicit-web-port

- path: openspec/changes/https-explicit-web-port/ (.openspec.yaml, proposal.md, design.md, tasks.md, brainstorm.md, plan.md, specs/game-https-configuration/spec.md, specs/game-port-visibility/spec.md, specs/in-task-tls-termination/spec.md)
  purpose: Replace implicit "ports[0] is the Caddy upstream" with a dedicated `webPort` for https games; ports[] becomes optional extras with ingress; read-time migration of persisted configs — proposal.md:3-24
  role: openspec change (schema superpowers-bridge, created 2026-10-26 — .openspec.yaml:1-2); 3-PR stack (proposal.md:42)
  covers: @hyveon/shared GameServerConfig.webPort, new shared/src/gameServerPorts.ts (normalizeGameServer @deprecated, ingressPorts, HTTPS_RESERVED_PORTS, HTTPS_CONNECT_PORT/ConnectPort), gameServerValidator.ts (checkWebPortRules, checkHttpsPortRules, checkPortCollisions, checkHealthCheckRules), formatStatus.ts (renderConnectMessage); infra ecs.ts (Caddy `--to localhost:<webPort>`, portMappings), securityGroups.ts (dedupedGamePortsByVisibility), lambdas.ts (firstPortByGame), testing/fixtures.ts `delta`; desktop-main DeploymentConfigService, DriftService, GameWizardDraftService (backfillPortVisibility), ElectronStoreService draft type, diagnosticsBundleAllowlist; lambdas update-dns/followup handlers; web networking-step, wizard-form.utils, review-step, edit-game-form, games/game-detail pages, e2e/specs/games.spec.ts, e2e/screenshots/demo-data.ts; docs app/games.md, components/infra.md, architecture.md, setup.md, guides/user.md, intro.md (proposal.md:37-42, plan.md)
  data_shapes: `webPort?: number` (1-65535, not 80/443, required iff https) design.md:23-26; normaliser legacy https w/o webPort → `webPort = ports[0].container, ports = ports.slice(1)` design.md:38; GAME_PORTS values `number | 'https'` marker (commit ec3e6f51 body; plan.md:87)
  claims:
    - "[ADDED] game-https-configuration / An HTTPS-enabled game declares an explicit web port: present+1-65535+not 80/443 when https, absent otherwise, issues pathed at webPort, never implied by ports order — specs/game-https-configuration/spec.md:3-25 (Foundry webPort 30000 valid; missing; 443/80; on non-https)"
    - "[ADDED] Legacy HTTPS configs are normalised on read: DeploymentConfigService converts legacy shape, idempotent, no operator action, persisted on next save, drafts too; legacy shape marked @deprecated in code; single-port legacy → empty ports — spec.md:27-49"
    - "[MODIFIED] An HTTPS-enabled game must satisfy the Caddy sidecar's port constraints: ports may be empty, tcp/udp only, no 80/443, no tcp entry equal to webPort, webPort rules apply, AND (5) across games no tcp extra may equal another game's webPort and vice versa (shared SG would bypass Caddy); no non-empty / ports[0]-tcp rule — spec.md:53-100 (7 scenarios incl. 'Extra port collides with another game's web port')"
    - "[MODIFIED] The form blocks a save the shared validator would reject: webPort/ports issues attributed to Networking step; dedicated web-port field when https, extras labeled optional; field hidden + no webPort in payload when https off — spec.md:102-119"
    - "[MODIFIED] Operators are warned about the consequences of enabling HTTPS: callout item 2 becomes 'web port no longer publicly reachable directly … additional ports follow their own visibility' — spec.md:121-137"
    - "[RENAMED] game-port-visibility 'HTTPS games are unaffected by port visibility' → 'Port visibility applies to an HTTPS game's additional ports' — specs/game-port-visibility/spec.md:1-4"
    - "[MODIFIED] Internal ports are ingressed from the VPC CIDR block only: applies to every game incl. https extras; webPort gets no ingress — game-port-visibility/spec.md:8-17"
    - "[MODIFIED] Port visibility applies to an HTTPS game's additional ports: visibility governs https extras; webPort only via Caddy 443/80 — spec.md:19-28"
    - "[MODIFIED] Connect-port surfaces exclude ICMP entries: non-https = first non-icmp PUBLIC port; https = `https://{game}.{hosted_zone_name}`, never webPort/extra — spec.md:30-39"
    - "[MODIFIED] in-task-tls-termination / Caddy TLS sidecar for HTTPS games: proxies to declared webPort; port mappings for webPort + extras; flipping https needs https + webPort — specs/in-task-tls-termination/spec.md:3-20"
    - "[MODIFIED] in-task-tls-termination / Security-group ingress for HTTPS games: 443/80 public when any https game; webPort no ingress; extras ingressed honoring visibility — spec.md:22-39"
    - Design decisions: D1 dedicated webPort (vs `upstream:true` flag on a port, vs message-only fix) design.md:23-26; D2 ports optional extras, collisions include webPort, icmp still rejected on https design.md:28-30; D3 extras get ingress, webPort none design.md:32-35; D4 read-time normaliser, no schema version, no write-time migration, legacy shape @deprecated with removal target "first minor after v0.9.x that ships this + one release overlap", debug log with game name only design.md:37-42; D5 Discord {port} → 443 URL, healthCheck.port may be webPort or tcp extra, health-check ingress follows target design.md:44-46; D6 pure helpers in shared/src/gameServerPorts.ts exported from barrel (no AWS imports) design.md:48-50
    - Risks: normalising exposes former ports[1..] publicly (release-note item) design.md:54; S3 keeps legacy shape until next save design.md:55; DriftService diff on normalised shape design.md:56; GAME_PORTS shape change design.md:58; rollback after save needs restoreRawConfig S3 object-version restore design.md:65
  implementation_state: tasks 15 [x] / 0 [ ]. Shipped as 3-PR stack: c059b889 (#688 shared + normaliser), ec3e6f51 (#689 infra/lambdas), 2822efd1 (#691 web + docs + spec sync); proposal 324a7deb (#685). #691 synced all three main specs: ADDED headings present (game-https-configuration main :137 "declares an explicit web port", :161 "Legacy HTTPS configs are normalised on read"); RENAMED heading present (game-port-visibility main :50); MODIFIED wording present for Internal ports (main :34), Port visibility on https extras (:51), Connect-port (:166), Form-blocks (:83), Warning callout item 2 (:106), Caddy sidecar `webPort` (in-task-tls main :11), SG ingress (:72). → shipped + (mostly) synced, NOT archived.
  observations:
    - SYNC GAP: main game-https-configuration "…Caddy sidecar's port constraints" (main :38-80) lists only constraints 1-4 and lacks scenario "Extra port collides with another game's web port"; the delta (spec.md:63, 87-90) has constraint 5 (cross-game tcp extra ↔ webPort). The delta text was edited in c059b889 (#688), and code implements it (gameServerValidator.ts:827-862), but #691's sync did not carry it to main.
    - The delta's MODIFIED "Internal ports…" has only 2 scenarios (game-port-visibility/spec.md:11-17) and omits add-icmp-ingress's "A tcp or udp port cannot be declared with conflicting visibility" scenario; main kept it (main :45-47) — the sync was a manual merge, so a naive archive re-application would drop that scenario.
    - Its MODIFIED "Connect-port surfaces exclude ICMP entries" modifies a requirement ADDED by add-icmp-ingress → sequential dependency on that change.
    - Main game-port-visibility also has "Container ports 443 and 80 (tcp) are reserved deployment-wide when any game is HTTPS" (main :63) — not in this delta nor add-icmp-ingress; comes from an earlier archived change; still consistent (webPort can't be 80/443).
    - proposal.md:31 says ports "`ports[0]`-must-be-tcp and non-empty rules removed" while game-port-visibility delta adds "first non-icmp public port" for non-https (spec.md:31) — introduces "public" qualifier silently (code picks public-first per add-icmp-ingress plan.md:158).
    - Release-history fact: "Releases (v0.7.2–v0.9.1) exist" (design.md:5; brainstorm.md:16) — consistent with git log.
    - Open questions left: legacy normaliser removal release; exact 80/443 error wording (design.md:69-70) — the latter resolved in code (validator.ts:729).
    - "Proposal Capabilities → New Capabilities" heading is empty (proposal.md:28-29).
    - plan.md step checkboxes all `- [ ]` despite tasks fully [x]; plan line refs (ecs.ts:213-251, securityGroups.ts:165-185,267-316, lambdas.ts:298-309, formatStatus.ts:31, docs line ranges) point-in-time.

## openspec/specs — requirement inventory (mechanical extract)

Extracted by script from every `openspec/specs/*/spec.md`: `### Requirement:` headings with line number and `#### Scenario:` count. 36 capabilities, 209 requirements. Per-requirement plain-language claims are in the openspec/specs entries above.

#### app-diagnostics-logging (openspec/specs/app-diagnostics-logging/spec.md) — 5 requirements, 22 scenarios
- L11 Renderer console forwarding to the main-process log — 5 scenario(s)
- L76 Service-layer diagnostic logging coverage — 2 scenario(s)
- L103 Diagnostics bundle export — 6 scenario(s)
- L183 Diagnostics panel pause, search, and autoscroll — 5 scenario(s)
- L238 ANSI escape sequence rendering for log lines — 4 scenario(s)

#### app-icon (openspec/specs/app-icon/spec.md) — 3 requirements, 5 scenarios
- L9 Platform icon asset set exists in the repository — 2 scenario(s)
- L23 electron-builder packages the icon on every target — 2 scenario(s)
- L37 Web renderer has a matching favicon — 1 scenario(s)

#### auto-update-scaffold (openspec/specs/auto-update-scaffold/spec.md) — 7 requirements, 24 scenarios
- L10 Updater is wired but inert by default — 3 scenario(s)
- L29 Update-check telemetry is gated by the same flag — 1 scenario(s)
- L38 enableAutoUpdate flag lives in the typed electron-store schema — 6 scenario(s)
- L72 Packaged builds carry GitHub publish metadata — 2 scenario(s)
- L86 Operator can trigger an on-demand update check — 7 scenario(s)
- L141 Failed update checks fall back to the newest release with a feed — 3 scenario(s)
- L160 Failed manual checks link to the releases page — 2 scenario(s)

#### aws-cloud-health (openspec/specs/aws-cloud-health/spec.md) — 3 requirements, 10 scenarios
- L6 Cloud Health checklist on Settings — 3 scenario(s)
- L32 ECS service-linked role check — 3 scenario(s)
- L59 Fix action with graceful degradation to policy instructions — 4 scenario(s)

#### aws-credentials (openspec/specs/aws-credentials/spec.md) — 4 requirements, 12 scenarios
- L9 AWS profile discovery — 3 scenario(s)
- L28 safeStorage paste-flow encryption — 3 scenario(s)
- L47 In-app access key rotation — 2 scenario(s)
- L61 Pick-or-paste credentials wizard step — 4 scenario(s)

#### cloud-bootstrap (openspec/specs/cloud-bootstrap/spec.md) — 8 requirements, 21 scenarios
- L7 SDK-only bootstrap in the main process — 2 scenario(s)
- L21 State backend bucket bootstrap — 3 scenario(s)
- L40 Configuration bucket bootstrap — 2 scenario(s)
- L54 Buckets block public access — 2 scenario(s)
- L68 Default encryption on the configuration bucket — 3 scenario(s)
- L89 IAM permission simulation — 6 scenario(s)
- L125 Bootstrap IPC and progress reporting — 1 scenario(s)
- L134 HyveonDeployAll permits creating the ECS service-linked role — 2 scenario(s)

#### cost-visibility (openspec/specs/cost-visibility/spec.md) — 6 requirements, 15 scenarios
- L10 No AWS Cost Explorer API calls — 3 scenario(s)
- L31 Free per-game Fargate cost estimates — 3 scenario(s)
- L62 Dashboard KPI cost tiles use only free data — 2 scenario(s)
- L79 Costs page links out to AWS Cost Explorer for real billed spend — 1 scenario(s)
- L92 Per-game AWS resources carry a Game cost allocation tag — 4 scenario(s)
- L120 Running ECS tasks propagate the Game tag from their task definition — 2 scenario(s)

#### custom-title-bar (openspec/specs/custom-title-bar/spec.md) — 5 requirements, 16 scenarios
- L6 Window chrome uses the app's own header, not the OS default — 3 scenario(s)
- L29 Platform-appropriate window controls — 3 scenario(s)
- L53 Renderer degrades safely outside Electron — 1 scenario(s)
- L66 Window-control IPC channels — 6 scenario(s)
- L103 Preload exposes window platform and controls — 3 scenario(s)

#### desktop-only-operator-surface (openspec/specs/desktop-only-operator-surface/spec.md) — 11 requirements, 32 scenarios
- L9 Desktop-main exposes no HTTP transport — 3 scenario(s)
- L28 No container or shell deployment artifacts at the repo root — 2 scenario(s)
- L42 ConfigService carries no API-token plumbing — 2 scenario(s)
- L56 Documentation describes only the desktop workflow — 2 scenario(s)
- L70 Test harnesses do not depend on the removed HTTP surface — 3 scenario(s)
- L89 Every routed screen is reachable from the sidebar — 2 scenario(s)
- L106 The chrome exposes no non-functional controls — 3 scenario(s)
- L128 Streamed IPC channels work across the context bridge — 6 scenario(s)
- L172 Navigating to logs from a game preselects that game — 2 scenario(s)
- L187 No operator-editable configuration files — 4 scenario(s)
- L213 Nothing but the app runs in a terminal — 3 scenario(s)

#### docs-screenshot-capture (openspec/specs/docs-screenshot-capture/spec.md) — 6 requirements, 12 scenarios
- L9 Screenshots are captured from the real Electron shell — 2 scenario(s)
- L28 The harness is isolated from the e2e test run — 2 scenario(s)
- L43 Captured screens are seeded with deterministic demo data — 3 scenario(s)
- L67 Re-running the harness produces stable images — 3 scenario(s)
- L88 Output location is the Docusaurus static tree — 1 scenario(s)
- L99 The capture procedure is documented for maintainers — 1 scenario(s)

#### env-token-interpolation (openspec/specs/env-token-interpolation/spec.md) — 6 requirements, 13 scenarios
- L6 Environment variable values support an allow-listed ${hyveon.*} token grammar — 3 scenario(s)
- L25 The public-address token resolves to the game's hostname at deploy time — 2 scenario(s)
- L39 The public-ipv4 token resolves at container boot via an injected entrypoint wrapper — 3 scenario(s)
- L58 Boot-time discovery failure fails the server start visibly — 1 scenario(s)
- L67 Wrapper script generation is injection-safe — 2 scenario(s)
- L81 Games gain an optional container start command, required with the ipv4 token — 2 scenario(s)

#### game-draft-persistence (openspec/specs/game-draft-persistence/spec.md) — 6 requirements, 11 scenarios
- L9 Debounced draft autosave — 3 scenario(s)
- L36 Draft flushed on dialog close — 1 scenario(s)
- L50 Draft survives app restart — 1 scenario(s)
- L63 Resume/discard banner on the games page — 4 scenario(s)
- L92 Draft cleared on successful game creation — 1 scenario(s)
- L104 Corrupt or unreadable draft degrades to no draft — 1 scenario(s)

#### game-environment-variables (openspec/specs/game-environment-variables/spec.md) — 3 requirements, 13 scenarios
- L6 Operators can set a game's environment variables from the game form — 6 scenario(s)
- L63 Environment variable entries must have a non-empty, unique name — 5 scenario(s)
- L117 The environment editor surfaces the available interpolation tokens — 2 scenario(s)

#### game-health-checks (openspec/specs/game-health-checks/spec.md) — 10 requirements, 30 scenarios
- L12 A game may declare an authoritative health check — 2 scenario(s)
- L40 The HTTP check kind evaluates a declared request against a declared condition — 7 scenario(s)
- L152 A failed check reports the server as active — 3 scenario(s)
- L183 Health checking is provisioned only for games that use it — 2 scenario(s)
- L204 Reaching into a game task is confined to what the configuration declares — 2 scenario(s)
- L253 Health-check configuration is validated before it is saved — 4 scenario(s)
- L292 The basis for a shutdown decision is recoverable from the logs — 2 scenario(s)
- L319 Health-check credentials never reach the operator interface — 2 scenario(s)
- L341 App-owned health-check credentials are provisioned and retired by the app — 5 scenario(s)
- L389 App-owned credential lifecycle requires no additional account permission — 1 scenario(s)

#### game-https-configuration (openspec/specs/game-https-configuration/spec.md) — 7 requirements, 27 scenarios
- L9 Operators can set a game's HTTPS flag from the game form — 5 scenario(s)
- L38 An HTTPS-enabled game must satisfy the Caddy sidecar's port constraints — 6 scenario(s)
- L81 The form blocks a save the shared validator would reject — 3 scenario(s)
- L100 Operators are warned about the consequences of enabling HTTPS — 2 scenario(s)
- L118 The HTTPS flag round-trips through the deployment-config JSON — 3 scenario(s)
- L137 An HTTPS-enabled game declares an explicit web port — 4 scenario(s)
- L161 Legacy HTTPS configs are normalised on read — 4 scenario(s)

#### game-port-visibility (openspec/specs/game-port-visibility/spec.md) — 9 requirements, 23 scenarios
- L11 Per-port visibility field — 2 scenario(s)
- L33 Internal ports are ingressed from the VPC CIDR block only — 3 scenario(s)
- L50 Port visibility applies to an HTTPS game's additional ports — 2 scenario(s)
- L63 Container ports 443 and 80 (tcp) are reserved deployment-wide when any game is HTTPS — 3 scenario(s)
- L95 Wizard exposes per-port visibility — 2 scenario(s)
- L114 ICMP port declarations — 4 scenario(s)
- L135 Cross-game ICMP declarations — 3 scenario(s)
- L152 Wizard supports ICMP entries — 2 scenario(s)
- L165 Connect-port surfaces exclude ICMP entries — 2 scenario(s)

#### game-resource-picker (openspec/specs/game-resource-picker/spec.md) — 2 requirements, 5 scenarios
- L14 vCPU and memory selected via constrained sliders — 3 scenario(s)
- L42 Resource selection applies to both add and edit flows — 2 scenario(s)

#### game-volume-folder-upload (openspec/specs/game-volume-folder-upload/spec.md) — 9 requirements, 29 scenarios
- L9 Operator selects a local folder and which entries to include — 3 scenario(s)
- L24 Upload goes directly into the mounted volume — 4 scenario(s)
- L43 Only the operator can reach the upload helper — 4 scenario(s)
- L62 Helper sessions are tagged and stray ones are cleaned up — 3 scenario(s)
- L77 Live progress meter — 3 scenario(s)
- L92 Resume and failure handling — 2 scenario(s)
- L103 Verification after upload — 2 scenario(s)
- L114 Warn before overwriting existing volume files — 6 scenario(s)
- L141 Safety limits and scope of state — 2 scenario(s)

#### guided-iam-provisioning (openspec/specs/guided-iam-provisioning/spec.md) — 5 requirements, 14 scenarios
- L9 CloudFormation template generated from the shared action set — 4 scenario(s)
- L33 Console handoff for stack creation — 2 scenario(s)
- L47 Bootstrap key intake — 3 scenario(s)
- L66 Mandatory bootstrap key rotation — 4 scenario(s)
- L90 Keychain requirement for guided credentials — 1 scenario(s)

#### guided-region-selection (openspec/specs/guided-region-selection/spec.md) — 3 requirements, 6 scenarios
- L13 Static AWS region data set — 2 scenario(s)
- L36 Guided-IAM region selection dropdown — 2 scenario(s)
- L60 Manual region entry fallback — 2 scenario(s)

#### iac-destroy-flow (openspec/specs/iac-destroy-flow/spec.md) — 4 requirements, 12 scenarios
- L9 Destroy IPC channel — 4 scenario(s)
- L33 Fresh confirmation token gate — 5 scenario(s)
- L64 Preload destroy bridge — 1 scenario(s)
- L73 Type-to-confirm destroy UI — 2 scenario(s)

#### iac-plan-apply-page (openspec/specs/iac-plan-apply-page/spec.md) — 8 requirements, 21 scenarios
- L7 IaC route and navigation — 1 scenario(s)
- L16 Plan trigger over IPC — 2 scenario(s)
- L30 Live ANSI log stream — 2 scenario(s)
- L44 Plan result summary — 3 scenario(s)
- L63 Approve gate before apply — 2 scenario(s)
- L77 Plan-hash-gated apply — 7 scenario(s)
- L120 Stale CLI copy replaced — 1 scenario(s)
- L129 Operator recovery from a stuck durable run lock — 3 scenario(s)

#### iac-rollback (openspec/specs/iac-rollback/spec.md) — 5 requirements, 10 scenarios
- L9 Complete remote file version listing — 2 scenario(s)
- L23 Rollback initiation from history — 2 scenario(s)
- L37 Rollback restores the version and queues a tagged plan — 4 scenario(s)
- L63 Rollback goes through the standard approve and apply gates — 1 scenario(s)
- L72 Missing historic version is a clear error — 1 scenario(s)

#### iac-run-history (openspec/specs/iac-run-history/spec.md) — 5 requirements, 14 scenarios
- L9 Run listing API — 4 scenario(s)
- L33 Run history route — 2 scenario(s)
- L47 History filters — 2 scenario(s)
- L61 Read-only run detail from history — 3 scenario(s)
- L80 Structured change summary on run records — 3 scenario(s)

#### in-task-tls-termination (openspec/specs/in-task-tls-termination/spec.md) — 6 requirements, 14 scenarios
- L9 Caddy TLS sidecar for HTTPS games — 3 scenario(s)
- L28 HTTPS served with automatically-issued certificates — 2 scenario(s)
- L42 Certificate persistence across task restarts — 2 scenario(s)
- L56 HTTPS games use the Lambda-managed DNS lifecycle — 2 scenario(s)
- L70 Security-group ingress for HTTPS games — 3 scenario(s)
- L89 No load-balancer or ACM resources — 2 scenario(s)

#### infra-log-viewer (openspec/specs/infra-log-viewer/spec.md) — 5 requirements, 11 scenarios
- L10 Lambda log group resolution — 2 scenario(s)
- L27 Recent Lambda logs fetch — 3 scenario(s)
- L49 Live Lambda log tail — 2 scenario(s)
- L64 Infrastructure logs page — 2 scenario(s)
- L81 Nested Logs sidebar navigation — 2 scenario(s)

#### install-and-signing-docs (openspec/specs/install-and-signing-docs/spec.md) — 3 requirements, 5 scenarios
- L9 Per-OS unsigned-MVP install instructions — 2 scenario(s)
- L23 README links to the install instructions — 1 scenario(s)
- L32 Code-signing roadmap document — 2 scenario(s)

#### lambda-runtime-currency (openspec/specs/lambda-runtime-currency/spec.md) — 3 requirements, 5 scenarios
- L9 Lambdas run a supported AWS runtime — 2 scenario(s)
- L24 Bundle target matches the executing runtime — 2 scenario(s)
- L35 Runtime-provided SDK is treated as a dependency — 1 scenario(s)

#### node-toolchain-version (openspec/specs/node-toolchain-version/spec.md) — 5 requirements, 10 scenarios
- L9 One supported Node major for development and CI — 2 scenario(s)
- L21 Every CI workflow runs the supported Node major — 2 scenario(s)
- L33 Documentation states the supported Node major — 2 scenario(s)
- L44 AWS Lambda runtime versions are governed separately — 2 scenario(s)
- L56 Documentation toolchain tracks a current Docusaurus release — 2 scenario(s)

#### operator-documentation (openspec/specs/operator-documentation/spec.md) — 7 requirements, 20 scenarios
- L9 Every routed screen has a dedicated documentation page — 3 scenario(s)
- L35 Screen documentation embeds screenshots — 2 scenario(s)
- L52 Documentation contains no references to removed infrastructure — 3 scenario(s)
- L78 Documented counts and paths match the codebase — 6 scenario(s)
- L128 Previously undocumented subsystems are documented — 3 scenario(s)
- L156 The docs build fails on a broken link — 2 scenario(s)
- L171 Orphaned documentation assets are removed — 1 scenario(s)

#### orchestrator-integration-coverage (openspec/specs/orchestrator-integration-coverage/spec.md) — 7 requirements, 27 scenarios
- L9 Plan integration coverage — 3 scenario(s)
- L28 Apply rejects stale and unapproved plans — 9 scenario(s)
- L77 Destroy gated by fresh confirmation token — 6 scenario(s)
- L111 Streamed run chunks preserve ANSI escape sequences — 1 scenario(s)
- L120 Run records persisted for every run — 4 scenario(s)
- L144 In-process engine stub injected via DI — 2 scenario(s)
- L158 Stack outputs integration coverage — 2 scenario(s)

#### preload-bridge-naming (openspec/specs/preload-bridge-naming/spec.md) — 3 requirements, 3 scenarios
- L9 Preload bridge is exposed as `window.hyveon` — 1 scenario(s)
- L19 Bridge TypeScript types are named `Hyveon*` — 1 scenario(s)
- L29 Test-mode mock seam uses the same bridge name — 1 scenario(s)

#### pulumi-engine-runtime (openspec/specs/pulumi-engine-runtime/spec.md) — 7 requirements, 32 scenarios
- L9 App-managed engine provisioning — 6 scenario(s)
- L43 Pinned engine version — 2 scenario(s)
- L57 Engine provisioning failure is actionable — 2 scenario(s)
- L71 Automation API workspace seam — 9 scenario(s)
- L128 Wizard-selected credentials reach the engine — 5 scenario(s)
- L159 Stale backend lock recovery — 4 scenario(s)
- L190 Engine process lifecycle — 4 scenario(s)

#### pulumi-infra-program (openspec/specs/pulumi-infra-program/spec.md) — 7 requirements, 26 scenarios
- L7 Infrastructure program workspace — 2 scenario(s)
- L21 Typed game-server configuration model — 3 scenario(s)
- L40 Configuration persisted as versioned JSON — 4 scenario(s)
- L66 No secret material enters the stack — 6 scenario(s)
- L104 Resource parity with the retired Terraform module — 4 scenario(s)
- L128 Stack outputs contract — 3 scenario(s)
- L147 Task definitions resolve environment variable interpolation tokens — 4 scenario(s)

#### release-automation (openspec/specs/release-automation/spec.md) — 6 requirements, 16 scenarios
- L9 Manual release trigger with configurable range — 3 scenario(s)
- L24 Automatic semver bump from Conventional Commits — 4 scenario(s)
- L43 Versioned commit and tag pushed to the protected default branch — 2 scenario(s)
- L54 Skip-bump replay mode — 2 scenario(s)
- L65 AI-generated release summary with changelog fallback — 2 scenario(s)
- L76 Draft release requiring human approval — 3 scenario(s)

#### wizard-flow (openspec/specs/wizard-flow/spec.md) — 10 requirements, 26 scenarios
- L9 Wizard launch gating — 2 scenario(s)
- L23 FirstRunWizardService with resumable state — 2 scenario(s)
- L37 Pick-cloud step — 2 scenario(s)
- L51 Guided IAM provisioning step — 4 scenario(s)
- L75 Stack initialization step with phased progress — 2 scenario(s)
- L89 Wizard completion — 1 scenario(s)
- L98 Reconfigure entry point in Settings — 7 scenario(s)
- L137 Resolved Pulumi engine version in Settings — 1 scenario(s)
- L146 Responsive wizard shell layout — 2 scenario(s)
- L170 Step progress sidebar — 3 scenario(s)


## openspec/changes (active) — delta inventory and task state (mechanical extract)

Task counts are `- [x]` vs `- [ ]` lines in tasks.md (`[~]` lines are not counted in either: add-icmp-ingress 5.3, embed-file-browser closeout-branch 6.1/6.2). Delta requirement headings with ADDED/MODIFIED section.

#### openspec/changes/add-healthcheck-auth-type/  tasks: 27 [x] / 0 [ ]
- openspec/changes/add-healthcheck-auth-type/specs/game-health-checks/spec.md:3 [MODIFIED] The HTTP check kind evaluates a declared request against a declared condition
- openspec/changes/add-healthcheck-auth-type/specs/game-health-checks/spec.md:115 [MODIFIED] Health-check configuration is validated before it is saved
- openspec/changes/add-healthcheck-auth-type/specs/game-health-checks/spec.md:154 [MODIFIED] Health-check credentials never reach the operator interface
- openspec/changes/add-healthcheck-auth-type/specs/game-health-checks/spec.md:178 [ADDED] App-owned health-check credentials are provisioned and retired by the app
- openspec/changes/add-healthcheck-auth-type/specs/game-health-checks/spec.md:226 [ADDED] App-owned credential lifecycle requires no additional account permission

#### openspec/changes/add-icmp-ingress/  tasks: 16 [x] / 0 [ ]
- openspec/changes/add-icmp-ingress/specs/game-port-visibility/spec.md:3 [ADDED] ICMP port declarations
- openspec/changes/add-icmp-ingress/specs/game-port-visibility/spec.md:24 [ADDED] Cross-game ICMP declarations
- openspec/changes/add-icmp-ingress/specs/game-port-visibility/spec.md:41 [ADDED] Wizard supports ICMP entries
- openspec/changes/add-icmp-ingress/specs/game-port-visibility/spec.md:54 [ADDED] Connect-port surfaces exclude ICMP entries
- openspec/changes/add-icmp-ingress/specs/game-port-visibility/spec.md:65 [MODIFIED] Internal ports are ingressed from the VPC CIDR block only

#### openspec/changes/add-pinned-hostname/  tasks: 20 [x] / 2 [ ]
- openspec/changes/add-pinned-hostname/specs/game-hostname-pinning/spec.md:3 [ADDED] Optional pinned hostname field
- openspec/changes/add-pinned-hostname/specs/game-hostname-pinning/spec.md:17 [ADDED] Pinned hostname validation
- openspec/changes/add-pinned-hostname/specs/game-hostname-pinning/spec.md:51 [ADDED] Task definition wiring for a pinned hostname
- openspec/changes/add-pinned-hostname/specs/game-hostname-pinning/spec.md:80 [ADDED] NODE_OPTIONS preloads the shim
- openspec/changes/add-pinned-hostname/specs/game-hostname-pinning/spec.md:99 [ADDED] Wizard control for pinning the hostname

#### openspec/changes/add-pluggable-health-checks/  tasks: 29 [x] / 0 [ ]
- openspec/changes/add-pluggable-health-checks/specs/game-health-checks/spec.md:10 [ADDED] A game may declare an authoritative health check
- openspec/changes/add-pluggable-health-checks/specs/game-health-checks/spec.md:38 [ADDED] The HTTP check kind evaluates a declared request against a declared condition
- openspec/changes/add-pluggable-health-checks/specs/game-health-checks/spec.md:111 [ADDED] A failed check reports the server as active
- openspec/changes/add-pluggable-health-checks/specs/game-health-checks/spec.md:142 [ADDED] Health checking is provisioned only for games that use it
- openspec/changes/add-pluggable-health-checks/specs/game-health-checks/spec.md:163 [ADDED] Reaching into a game task is confined to what the configuration declares
- openspec/changes/add-pluggable-health-checks/specs/game-health-checks/spec.md:212 [ADDED] Health-check configuration is validated before it is saved
- openspec/changes/add-pluggable-health-checks/specs/game-health-checks/spec.md:235 [ADDED] The basis for a shutdown decision is recoverable from the logs
- openspec/changes/add-pluggable-health-checks/specs/game-health-checks/spec.md:262 [ADDED] Health-check credentials never reach the operator interface
- openspec/changes/add-pluggable-health-checks/specs/lambda-runtime-currency/spec.md:3 [MODIFIED] Lambdas run a supported AWS runtime

#### openspec/changes/add-release-automation/  tasks: 18 [x] / 8 [ ]
- openspec/changes/add-release-automation/specs/release-automation/spec.md:7 [ADDED] Manual release trigger with configurable range
- openspec/changes/add-release-automation/specs/release-automation/spec.md:22 [ADDED] Automatic semver bump from Conventional Commits
- openspec/changes/add-release-automation/specs/release-automation/spec.md:41 [ADDED] Versioned commit and tag pushed to the protected default branch
- openspec/changes/add-release-automation/specs/release-automation/spec.md:52 [ADDED] Skip-bump replay mode
- openspec/changes/add-release-automation/specs/release-automation/spec.md:63 [ADDED] AI-generated release summary with changelog fallback
- openspec/changes/add-release-automation/specs/release-automation/spec.md:74 [ADDED] Draft release requiring human approval

#### openspec/changes/add-scripted-health-checks/  tasks: 0 [x] / 28 [ ]
- openspec/changes/add-scripted-health-checks/specs/game-health-checks/spec.md:3 [MODIFIED] A game may declare an authoritative health check
- openspec/changes/add-scripted-health-checks/specs/game-health-checks/spec.md:41 [MODIFIED] Reaching into a game task is confined to what the configuration declares
- openspec/changes/add-scripted-health-checks/specs/scripted-health-checks/spec.md:11 [ADDED] A script determines the verdict for the game that declares it
- openspec/changes/add-scripted-health-checks/specs/scripted-health-checks/spec.md:45 [ADDED] A script executes without access to the host's authority
- openspec/changes/add-scripted-health-checks/specs/scripted-health-checks/spec.md:83 [ADDED] Script execution is bounded by limits the host enforces
- openspec/changes/add-scripted-health-checks/specs/scripted-health-checks/spec.md:117 [ADDED] A script that fails reports the server as active
- openspec/changes/add-scripted-health-checks/specs/scripted-health-checks/spec.md:139 [ADDED] Authoring a script is an explicit, recorded act
- openspec/changes/add-scripted-health-checks/specs/scripted-health-checks/spec.md:163 [ADDED] A script's output does not leak into the deployment's records

#### openspec/changes/add-update-feed-fallback/  tasks: 6 [x] / 0 [ ]
- openspec/changes/add-update-feed-fallback/specs/auto-update-scaffold/spec.md:3 [ADDED] Failed update checks fall back to the newest release with a feed
- openspec/changes/add-update-feed-fallback/specs/auto-update-scaffold/spec.md:22 [ADDED] Failed manual checks link to the releases page

#### openspec/changes/add-user-initiated-update-install/  tasks: 11 [x] / 0 [ ]
- openspec/changes/add-user-initiated-update-install/specs/auto-update-scaffold/spec.md:3 [ADDED] Operator can download and install an available update
- openspec/changes/add-user-initiated-update-install/specs/auto-update-scaffold/spec.md:45 [MODIFIED] Failed manual checks link to the releases page

#### openspec/changes/add-vpc-flow-logs/  tasks: 0 [x] / 22 [ ]
- openspec/changes/add-vpc-flow-logs/specs/vpc-flow-logs/spec.md:7 [ADDED] VPC Flow Log resource provisioning
- openspec/changes/add-vpc-flow-logs/specs/vpc-flow-logs/spec.md:22 [ADDED] Scoped IAM role for flow log delivery
- openspec/changes/add-vpc-flow-logs/specs/vpc-flow-logs/spec.md:29 [ADDED] Flow-log enable/disable configuration
- openspec/changes/add-vpc-flow-logs/specs/vpc-flow-logs/spec.md:36 [ADDED] Recent flow log record fetch
- openspec/changes/add-vpc-flow-logs/specs/vpc-flow-logs/spec.md:51 [ADDED] Older and newer flow log record paging
- openspec/changes/add-vpc-flow-logs/specs/vpc-flow-logs/spec.md:62 [ADDED] Live flow log record tail
- openspec/changes/add-vpc-flow-logs/specs/vpc-flow-logs/spec.md:73 [ADDED] Reject-only filtering in the operator UI

#### openspec/changes/embed-file-browser/  tasks: 3 [x] / 41 [ ]
- openspec/changes/embed-file-browser/specs/game-volume-file-browser/spec.md:3 [ADDED] In-app file browser page per game
- openspec/changes/embed-file-browser/specs/game-volume-file-browser/spec.md:30 [ADDED] Helper credentials and address stay in the main process
- openspec/changes/embed-file-browser/specs/game-volume-file-browser/spec.md:41 [ADDED] Encrypted, pinned, operator-only transport for every helper session
- openspec/changes/embed-file-browser/specs/game-volume-file-browser/spec.md:56 [ADDED] One application-owned helper session per game shared by browsing and uploading
- openspec/changes/embed-file-browser/specs/game-volume-file-browser/spec.md:83 [ADDED] Session readiness and state reporting
- openspec/changes/embed-file-browser/specs/game-volume-file-browser/spec.md:102 [ADDED] Browsing and file operations
- openspec/changes/embed-file-browser/specs/game-volume-file-browser/spec.md:129 [ADDED] Volume path safety
- openspec/changes/embed-file-browser/specs/game-volume-file-browser/spec.md:144 [ADDED] Read-only while the game server is running
- openspec/changes/embed-file-browser/specs/game-volume-file-browser/spec.md:159 [ADDED] Small text file view and edit
- openspec/changes/embed-file-browser/specs/game-volume-file-browser/spec.md:174 [ADDED] Replaceable file backend
- openspec/changes/embed-file-browser/specs/game-volume-folder-upload/spec.md:3 [MODIFIED] Upload goes directly into the mounted volume
- openspec/changes/embed-file-browser/specs/game-volume-folder-upload/spec.md:38 [MODIFIED] Helper sessions are tagged and stray ones are cleaned up

#### openspec/changes/https-explicit-web-port/  tasks: 15 [x] / 0 [ ]
- openspec/changes/https-explicit-web-port/specs/game-https-configuration/spec.md:3 [ADDED] An HTTPS-enabled game declares an explicit web port
- openspec/changes/https-explicit-web-port/specs/game-https-configuration/spec.md:27 [ADDED] Legacy HTTPS configs are normalised on read
- openspec/changes/https-explicit-web-port/specs/game-https-configuration/spec.md:53 [MODIFIED] An HTTPS-enabled game must satisfy the Caddy sidecar's port constraints
- openspec/changes/https-explicit-web-port/specs/game-https-configuration/spec.md:102 [MODIFIED] The form blocks a save the shared validator would reject
- openspec/changes/https-explicit-web-port/specs/game-https-configuration/spec.md:121 [MODIFIED] Operators are warned about the consequences of enabling HTTPS
- openspec/changes/https-explicit-web-port/specs/game-port-visibility/spec.md:8 [MODIFIED] Internal ports are ingressed from the VPC CIDR block only
- openspec/changes/https-explicit-web-port/specs/game-port-visibility/spec.md:19 [MODIFIED] Port visibility applies to an HTTPS game's additional ports
- openspec/changes/https-explicit-web-port/specs/game-port-visibility/spec.md:30 [MODIFIED] Connect-port surfaces exclude ICMP entries
- openspec/changes/https-explicit-web-port/specs/in-task-tls-termination/spec.md:3 [MODIFIED] Caddy TLS sidecar for HTTPS games
- openspec/changes/https-explicit-web-port/specs/in-task-tls-termination/spec.md:22 [MODIFIED] Security-group ingress for HTTPS games


## openspec/changes/archive — title sweep only

Per instructions the archive was NOT read in full: `ls openspec/changes/archive` (34 changes) and the first ~15 lines of each `proposal.md`. Each line below is the first sentence of the proposal's Why (what problem it shipped a fix for), not a verified summary of what landed.

- `2026-07-26-add-first-run-wizard` — A fresh install of the Hyveon desktop app currently requires hand-editing config files, pre-creating the Terraform S3 backend by hand, and knowing which CLIs must be on PATH before anything works.
- `2026-07-26-add-orchestrator-integration-tests` — `TerraformService` (plan/apply/destroy/output) is the highest-risk orchestration surface in the desktop app — it shells out to a real binary, gates destructive operations behind hashes and confirmation tokens, and persists run history — yet
- `2026-07-26-add-terraform-run-ui` — Epic #138 (local terraform orchestration) shipped a complete backend — `TerraformService` (init/plan/apply/destroy/output with streaming async generators, planHash + stale-plan guards), `RunService` (in-memory mutex + DynamoDB apply lock), 
- `2026-07-26-remove-legacy-operator-surface` — The Electron desktop pivot (#214) made the old web-app/Docker operator workflow obsolete, and the pre-pivot AWS stack has already been destroyed (checked off in #293).
- `2026-07-28-add-https-toggle-to-game-form` — The `replace-alb-with-caddy-sidecar` change made HTTPS a per-game flag that any operator should be able to turn on: set `https = true` in the `game_servers` map and the game's ECS task gains a Caddy sidecar that terminates TLS via Let's Enc
- `2026-07-28-overhaul-docs-and-app-guide` — The docs site has drifted badly behind the codebase.
- `2026-07-28-rename-gsd-to-hyveon` — The desktop preload API, its TypeScript types, the renderer's runtime global, e2e test helpers, and an unrelated Terraform tfvars-bucket marker all carry the name `Gsd`/`gsd`/`GSD` — a leftover from the project's pre-rebrand name.
- `2026-07-28-replace-alb-with-caddy-sidecar` — The ALB provisioned for `https = true` games (`terraform/aws/alb.tf`) bills per hour of existence — ~$16.4/mo even with zero tasks running — and is the only resource in the stack that violates the core scale-to-zero design ("no persistent E
- `2026-07-29-move-toolchain-to-node-24` — The repo does not have one answer to "what Node version do I need?" — it has four.
- `2026-08-05-first-run-wizard-region-dropdown` — The first-run wizard's guided-IAM region screen is a free-text input with emptiness-only validation — a user must already know the exact AWS region
- `2026-08-05-wizard-responsive-layout` — The first-run wizard renders as a single fixed-width card (`max-w-xl`, 576px) with zero responsive classes across all five step components, so on
- `2026-08-06-remove-cost-explorer-calls` — AWS Cost Explorer bills $0.01 per `GetCostAndUsage` API request.
- `2026-08-08-add-game-env-vars-ui` — `GameServer.environment` already exists in the shared type/schema and flows fully through the backend write path, and `game-detail.page.tsx` already
- `2026-08-10-add-app-logging-debugging` — Debugging operator-reported issues today means relying on the winston log file (`userData/logs/main-*.log`) as the only record of what happened, per
- `2026-08-10-add-distribution-updater` — Epic #141 ("distribution + auto-update scaffolding") is the final open epic of the Electron desktop pivot initiative (#214).
- `2026-08-10-add-game-wizard-draft-persistence` — The add-game wizard (`app/packages/web/src/components/add-game-wizard/`) holds its entire in-progress `WizardDraft` in local React state and discards it on
- `2026-08-10-add-one-click-aws-bootstrap` — Getting from a fresh clone to a deployed cluster still requires manual work outside the app: create an IAM user in the AWS console, hand-paste the `HyveonDeployAll` inline policy JSON out of `docs/docs/setup.md`, and mint an access key befo
- `2026-08-10-add-per-game-cost-tags` — Cost Explorer cannot break spend down by game today because only `Project=hyveon` is tagged (applied once at the Pulumi provider level).
- `2026-08-10-add-run-lock-recovery` — An infra apply got stuck live with "Run lock already held by chris" and no way to clear it short of manually deleting a DynamoDB item via the AWS CLI and restarting the desktop app.
- `2026-08-10-ansi-log-rendering` — The `/logs` page and the Settings → Diagnostics panel render CloudWatch and in-app log lines as plain text.
- `2026-08-10-bump-lambda-runtime-to-nodejs24` — All five Lambdas (`interactions`, `followup`, `update-dns`, `watchdog`, `efs-seeder`) declare `runtime = 'nodejs20.x'` via `LAMBDA_RUNTIME` in `app/packages/infra/src/lambdas.ts`, and AWS deprecated that runtime on **30 April 2026** — it is
- `2026-08-10-game-server-resource-sliders` — The add-game wizard's Resources step picks a game server's Fargate vCPU and memory via two cascading `<select>` dropdowns, which force scanning a flat list to find a valid pair and give no sense of cost until after saving.
- `2026-08-10-migrate-iac-to-pulumi` — Hyveon is a packaged desktop app, but it cannot provision anything until the operator has manually installed the `terraform` binary and put it on `PATH`.
- `2026-08-11-aws-cloud-health-checks` — Starting a game server can fail with `InvalidParameterException: Unable to assume the service linked role` when the AWS account is missing
- `2026-08-13-add-internal-game-ports` — Every port a non-HTTPS game declares in `ports` is opened to `0.0.0.0/0` on the shared `game_servers` security group, with no way to restrict a port to
- `2026-08-13-pulumi-portable-passphrase` — The Pulumi secrets passphrase is generated per machine and stored only in that machine's OS keychain, but the S3-backed Pulumi state it protects contains no
- `2026-08-14-add-autoupdate-settings-toggle` — `auto-update-scaffold` shipped the `electron-updater` integration wired but inert behind an `enableAutoUpdate` electron-store flag, with no way to set it except manual store editing — by design, as a v1 scaffold.
- `2026-08-14-add-custom-title-bar` — Electron's default title bar shows a File/Edit/View/Window application menu that exposes no actions this app uses — already removed in a separate PR
- `2026-08-14-add-diagnostics-export` — Operators currently have no way to hand support (project maintainers) enough information to diagnose a problem beyond copy-pasting whatever they can see
- `2026-08-14-add-infra-log-viewer` — The operator app's `/logs` page only tails ECS game-server CloudWatch logs; the 5 Lambda packages (watchdog, health-check, dns-updater, interactions, followup) have no
- `2026-08-21-remove-log-level-filter` — Hyveon's log viewers (game logs, infra logs, Settings Diagnostics panel) classify each line into INFO/WARN/ERROR/DEBUG via a client-side regex, since
- `2026-08-31-add-env-var-token-interpolation` — Game server env values are static strings frozen into the ECS task definition, so operators must hard-code addresses that Hyveon itself owns and can change — the per-game public hostname and the task's public IPv4.
- `2026-09-09-add-manual-update-check` — The `auto-update-scaffold` capability (PR #524) added an `enableAutoUpdate` toggle to Settings, but the underlying updater only checks once at Electron
- `2026-10-26-add-folder-volume-upload` — Seeding a game volume today means hand-adding one `file_seeds` row per file (path + inline text or base64 + mode).

## Active-change conflicts

### From active changes (3 large)

**game-health-checks** (touched by 3 active changes):
- add-pluggable-health-checks ADDs 8 requirements, including "The HTTP check kind…", "Health-check configuration is validated…" and "Health-check credentials never reach the operator interface".
- add-healthcheck-auth-type MODIFIES those same 3 and ADDs 2 more.
- add-scripted-health-checks (0/28 tasks) MODIFIES "A game may declare an authoritative health check" and "Reaching into a game task is confined…". It does not overlap auth-type's headings.
- The main spec already contains the auth-type text, synced via #644 without archiving either change.

Hazard: archiving add-pluggable-health-checks now, or re-syncing it, would hit ADDED requirements that already exist. That either errors or replaces the 3 headings with the pre-auth-type text, silently dropping raw/basic/bearer. The safe order is to archive pluggable with its specs skipped (or verify no-op), then auth-type. scripted-health-checks' MODIFIED base text should be re-checked against the current main spec before it is synced.

**game-volume-folder-upload**: only embed-file-browser touches it among active changes; its base came from the archived add-folder-volume-upload. Its MODIFIED text replaces the `helper-open` "stop it first" behaviour. There is no conflict with another active change, but the main spec on HEAD will stay stale until the closeout branch (#699 stack) merges.

**game-hostname-pinning**: new capability. No other change touches it.

### From active changes (6 others)

- game-health-checks — pluggable vs auth-type vs scripted: add-pluggable-health-checks ADDED the 8 base requirements (synced #644). add-healthcheck-auth-type (other worker) MODIFIED three of them (HTTP check kind, validation, credentials-never-reach-UI) and ADDED two app-owned-credential requirements — main now reflects auth-type. add-scripted-health-checks MODIFIES two different requirements ("A game may declare…", "Reaching into a game task…") whose main text is still pluggable's, so no direct textual collision with auth-type, but: (a) archiving pluggable with spec application would overwrite auth-type's wording; (b) scripted's MODIFIED "Reaching…" drops the network.ts NAT/endpoint parenthetical; (c) scripted's `secret` binding/credential semantics predate auth-type's raw|basic|bearer + app-owned credentials and need reconciling; (d) scripted's script kind must also satisfy auth-type's MODIFIED validation requirement (unknown kind rejection etc.).
- game-port-visibility — icmp vs https-explicit-web-port: both MODIFY "Internal ports are ingressed from the VPC CIDR block only" and touch "Connect-port surfaces exclude ICMP entries" (icmp ADDED it, https MODIFIED it). Main reflects a hand-merge: https wording + icmp's third scenario. Neither delta alone equals main; both must be archived without re-applying deltas (or deltas rewritten). Also https design defers "ICMP on https games" to add-icmp-ingress, which itself declares it a non-goal — net: icmp on https remains rejected (consistent).
- release-automation — change vs main spec: main spec already superseded the delta (#664 build-before-release ordering, #665 build within release.yml, identity rationale changed). Delta is stale on 3 requirements' wording + a missing scenario; archiving must skip spec application.
- game-https-configuration — https-explicit-web-port delta vs main: main is missing constraint 5 + its scenario (sync gap) — this is the one place the delta is AHEAD of main.
- lambda-runtime-currency — pluggable's MODIFIED text is in main verbatim; carries the efs-seeder "always-provisioned" inaccuracy.

## Worker coverage notes

- **docs site root pages, guides, diagrams, config** — Files read: 22 (setup, intro, install, code-signing-roadmap, 4 guides files, 8 diagrams files, custom.css, docusaurus.config.ts, sidebars.ts, package.json, tsconfig.json, .gitignore) fully. Files not read fully: docs/package-lock.json (head -40 + lockfileVersion + top-level versions only, per brief). Ambiguities: whether Mermaid is still used by pages outside this part; watchdog/DNS defaults not verified against code.
- **docs/docs/components + architecture** — - Files read: 7/7 fully (_category_.json, index.md, infra.md, integration-tests.md, lambdas.md, management-app.md, architecture.md); targeted code spot-checks for drift. - Files not read: none. - Ambiguities: line numbers are file-relative; "covers" for very broad pages (management-app.md) lists named symbols rather than every one; several claims (IAM statements, emoji strings) not verified against code.
- **docs/docs/app** — Files read: 11/11 (all of docs/docs/app, every line). Files not read: none. Ambiguities: notable contradictions flagged — settings.md:250 attributes DNS writes to watchdog (should be update-dns); discord.md:128 ACM cert vs CLAUDE.md "no ACM certificate anywhere" invariant; discord.md:352-353 "recoverable from infrastructure-as-code" for app-managed permissions; stale openspec path costs.md:24; iac.md:128 "last check" wording.
- **docs/superpowers + openspec schemas/config** — Files read: 21/21 (config.yaml; 1 spec; 9 plans; schema.yaml, README.md, VERSION, 9 templates incl. adopters fragment). Files not read: none in scope (archive change contents deliberately not read, per instructions — only listed). Ambiguities: 'shipped' judged from archive dir + git commits + file existence, not deep code comparison; plans' bucket-name (`-tfvars`) and acm:* claims flagged but not fully reconciled with current iamPolicy.ts/setup.md; whether the vendored bridge files are meant to be edited locally (README says the upgrade replaces the whole directory) is unclear.
- **openspec/specs A–G** — Files read: all 18 assigned spec.md files in full, plus SWEEP-PROMPT.md and BRIEF.md. I also spot-checked that some cited paths and symbols exist (hyveon-http-bridge.ts, chromium specs, `iac.settings.autoUpdate`, checkHttpsPortRules/firstPortByGame, CloudHealthService, docs/static/img/app, maintainer.md). Files not read: none. Ambiguities: whether "Settings page's account health check" (game-health-checks:391) refers to Cloud Health or to the wizard IAM simulation; whether `<game>.<zone>` and `{game}.{hosted_zone_name}` are still accurate after the hostname-pinning commit (not verified in code); whether the snake_case `game_servers`/`hosted_zone_name` names match the Pulumi resource names (not verified).
- **openspec/specs G–W** — - Files read: 18/18 assigned spec.md files, all read fully. I also did existence spot-checks of referenced paths: scripts/ is missing, terraform/ and docs/screenshots/ are absent as specified, and LAMBDA_RUNTIME and onBrokenLinks were verified. - Files not read: none in scope. I did not open the code/docs the specs reference beyond those existence checks. - Ambiguities: which lock 'shared operation lock' means in iac-rollback; whether the orchestrator-integration-coverage stub replaces PulumiService or the engine beneath it; whether 'rollback' is a real operation kind; whether efs-seeder is always-on or conditional. Region-input location in wizard Reconfigure is also unclear.
- **active changes (3 large)** — Files read: 22 of 22 assigned. All proposal/design/tasks/spec/.openspec.yaml/brainstorm/verify files were read in full, plus pinned-hostname plan.md in full. Not fully read: embed-file-browser/plan.md and add-healthcheck-auth-type/plan.md (header + headings + first paragraph only, by instruction). Ambiguities: whether the embed-file-browser stack (#694-#699 per memory) is merged was judged from origin/main = HEAD (not merged). verify.md's "6/6" count disagrees with the 5-requirement delta. The `.superpowers/sdd/plan/progress.md` ledger path was not checked.
- **active changes (6 others)** — Files read: all 38 files in the 6 assigned changes (icmp 7, pluggable 6, release 5, scripted 6, vpc-flow-logs 5, https 9) fully; plus main-spec sections and commits for sync checks. Files not read: none in scope. Main specs only read in the sections needed for heading/wording comparison. Ambiguities: whether release-automation's open admin tasks 4.x/5.x are "done" (evidence says yes in practice; tasks.md unticked); whether the game-https-configuration constraint-5 omission in main was intentional; mech-changes counts icmp 16/0 but task 5.3 is `[~]`.

## Observed behaviours

### From docs site root pages, guides, diagrams, config

- HyveonDeployAll JSON in docs is generated from and test-locked against HYVEON_DEPLOY_ALL_ACTIONS — setup.md:225-238 (app/packages/shared/src/iamPolicy.ts, iamPolicy.test.ts exist)
- iam:* scoped to hyveon-* roles/policies, not users; self-rotation via separate HyveonSelfRotate policy — setup.md:95-103, 240-257
- Guided IAM: render CFN template, open console, paste bootstrap key, mint new key, verify, revoke bootstrap; Retry rotation path; checkpointed — setup.md:42-48, 295-309
- Credentials source (profile vs pasted key) fully overrides the other; no fallthrough to ambient identity — setup.md:317-323
- Bootstrap creates state bucket, config bucket, run-history table directly via SDK and seeds empty deployment-config — setup.md:324-342
- IAM permission check is advisory only — setup.md:343-346
- Pulumi engine pinned and auto-installed by the app; no host pulumi binary — setup.md:25-28, 347-350
- Pulumi S3 DIY backend locks via objects, no DynamoDB lock table — setup.md:203-206
- Add-game writes only deployment-config.json; AWS changes require plan/approve/apply — setup.md:380-384; maintainer.md:212-216
- ICMP port entries feed SG only, excluded from portMappings — setup.md:378
- HTTPS games: Caddy sidecar, 443/80 public, webPort private, legacy ports[0] normalised to webPort — setup.md:399-418
- EFS access points use UID/GID 1000 — setup.md:390-391
- file_seeds idempotent per content; removed seeds not deleted — setup.md:395-397
- First apply resource inventory incl. Discord CloudFront + us-east-1 ACM — setup.md:432-445
- Discord secrets zero-day recovery; health-check secrets app-managed outside Pulumi — setup.md:656-665
- Slash commands registered per guild only via PUT applications/{id}/guilds/{gid}/commands — maintainer.md:261-265; setup.md:619-621
- /server-start: deferred ack <3s, followup RunTask + PENDING#taskArn 15m TTL, update-dns UPSERT + PATCH on RUNNING — user.md:67-76; server-start.d2:13-27
- update-dns deletes DNS on STOPPED for all games — user.md:80-82
- Watchdog: NetworkPacketsIn below watchdogMinPackets increments idle_checks ECS tag; StopTask at watchdogIdleChecks; never touches DNS — user.md:117-128; control-loops.d2:30-31
- DNS TTL default 30 s — user.md:99-100
- Lambda bundles are content-hashed FileAssets; rebuilds without byte change produce no diff — maintainer.md:315-317
- Lambda bundles shipped inside installer as extraResources — setup.md:519-522
- macOS release needs zip for MacUpdater; release asset check fails draft if latest*.yml/.exe/.dmg/.zip/.AppImage missing — setup.md:509-513; maintainer.md:449-453
- Releases always draft; AI summary falls back to raw changelog — maintainer.md:454-463
- Auto-update disabled by default (enableAutoUpdate) pending signing — code-signing-roadmap.md:71-75
- mac.hardenedRuntime must stay false until signing — code-signing-roadmap.md:36-45
- Docs site throws on broken links — docusaurus.config.ts:16-17
- D2 SVGs rendered by render.sh into docs/static/diagrams and committed — diagrams/README.md:10-15; render.sh:8-16

### From docs/docs/components + architecture

- Renderer ↔ backend is IPC-only via `window.hyveon`; no HTTP listener or bearer token — docs/docs/components/management-app.md:15-17, 101-104; docs/docs/architecture.md:17-23
- desktop-main throws at boot if `process.versions.electron` is unset — management-app.md:69-71
- `RpcErrorMessageFilter` must be registered before `app.listen()` to preserve error messages across IPC — management-app.md:73-99
- `ipc-main-bridge` converts rejections to plain `Error` to survive structured clone — management-app.md:94-99
- Pulumi program is inline (`createInfraProgram`); destroy uses a no-op program — infra.md:24-34
- App downloads and verifies a pinned Pulumi engine into userData; never PATH/~/.pulumi — infra.md:35-43
- Stack passphrase is derived via HMAC-SHA256 from account ID + stack name, never stored; legacy stored passphrase auto-migrates — infra.md:61-100
- Two distinct locks: S3 backend lock object (clearStaleLock) vs RunService DynamoDB apply lock — infra.md:101-110
- Env values ≥4 chars redacted from Pulumi stream output and pulumi.log — infra.md:132-139
- No `aws.ecs.Service` anywhere; tasks via RunTask with `propagateTags: 'TASK_DEFINITION'` at both call sites — infra.md:152, 184-190; architecture.md:47-49
- route53.ts declares zero resources; only Records are 3 in discordDomain.ts; enforced by negative test — infra.md:213-225
- File-manager SG has empty ingress; app authorizes/revokes `<ip>/32:8080` at runtime — infra.md:150; architecture.md:167-169
- Folder-upload helpers HTTPS with pinned per-launch self-signed cert; stray helpers swept >15 min; 2h scheduler auto-stop — architecture.md:170-172; management-app.md:291-294
- Internal-visibility ports ingress from VPC CIDR, not 0.0.0.0/0 — infra.md:268-280
- ICMP port entries become SG rules only; excluded from portMappings and GAME_PORTS — infra.md:291-298
- 443/80 tcp reserved deployment-wide when any game is https — infra.md:325-332
- Legacy https configs normalised at read (ports[0] → webPort) in DeploymentConfigService and PulumiService — infra.md:315-323; management-app.md:43
- `${hyveon.network.public-ipv4}` resolved at container boot by a wrapper polling checkip 30×2s, exits non-zero on failure — infra.md:349-366
- pinnedHostname adds a busybox init container + NODE_OPTIONS `--require` shim — infra.md:388-419
- Runs table created by BootstrapService via SDK, not Pulumi; name from `resolveRunsTableName` — infra.md:421-447
- interactions verifies Ed25519 and returns deferred ack type 5 before async-invoking followup — lambdas.md:41-59
- followup writes `PENDING#{taskArn}` with 15-min TTL; update-dns PATCHes Discord and deletes it on RUNNING — lambdas.md:96-100, 156-159
- update-dns retries public-IP resolution 5×3s; no retry/backstop on Route 53 failure — lambdas.md:152-170
- watchdog uses exactly one verdict source per game (CloudWatch or health-check); both fail-active — lambdas.md:189-206
- watchdog never touches DNS; StopTask → STOPPED event → update-dns delete — lambdas.md:210-214; architecture.md:93-96
- Idle counter lives only in `idle_checks` ECS task tag — lambdas.md:218-222; architecture.md:163-165
- efs-seeder runs synchronously inside `stack.up()` via aws.lambda.Invocation; re-triggered only when seedsHash changes — lambdas.md:239, 273-279
- health-check destination host only from ECS private IP (SSRF closed by construction); fail-active everywhere; never logs response values — lambdas.md:304-363
- Pulumi credential overlay explicitly blanks the non-selected source's env vars and AWS_SESSION_TOKEN; no source → hard error — management-app.md:411-451
- DeploymentConfigService has no local-file fallback; `HYVEON_CONFIG_BUCKET` overrides wizard-persisted bucket — management-app.md:459-476
- Draft autosave stored unencrypted but value fields blanked before crossing IPC — management-app.md:391-409
- `window.hyveon.__test` exists only when `HYVEON_TEST_MODE=1` at preload load — management-app.md:537-561; integration-tests.md:245-251
- Renderer uses HashRouter due to file:// loading — management-app.md:585-592
- Integration harness overrides PulumiService at DI seam so no real engine can run — integration-tests.md:117-119, 197

### From docs/docs/app

- First-run wizard replaces whole window until setup complete; no skip — docs/docs/app/first-run-wizard.md:8-11, index.md:26-31
- Wizard resume never lands on step 5; clamped to step 4 to avoid an unconfirmed write-side stack init — first-run-wizard.md:333-342
- Guided IAM: pasted bootstrap key verified, rotated, stored in OS keychain, original deleted; pasted secret never persisted — first-run-wizard.md:99-111
- Pasted AWS keys refuse to save if safeStorage unavailable (no plaintext fallback) — first-run-wizard.md:201-206
- Bootstrap seeds empty deployment-config.json only if absent (idempotent) — first-run-wizard.md:231
- Pulumi state locking via S3 backend lock objects, no DynamoDB lock table — first-run-wizard.md:228, iac.md:213-216
- Stack secrets passphrase derived from AWS account ID, not stored (legacy stored passphrase migrated) — first-run-wizard.md:313, 372-381
- IAM permission check is advisory only, simulates HyveonDeployAll — first-run-wizard.md:274-291
- Game config edits write only deployment-config.json in S3; AWS unchanged until plan/approve/apply — games.md:13-24, index.md:127-136
- Start/Stop call ECS RunTask/StopTask directly against `{game}-server`; no ECS Service — index.md:68-72, 138-141
- Card locks for 3s after start/stop, then refetches single game status — dashboard.md:95-97
- Status polled every 20s app-wide; pending-changes drift check every 30s; costs.estimate once on mount — dashboard.md:206, 249, 262-264
- Drift banner dismissal keyed to drift-report signature in sessionStorage — dashboard.md:210-221
- FileBrowser helper: per-launch bcrypt'd random password, SG has no ingress, app opens 8080 for operator /32 at runtime, 2h EventBridge Scheduler auto-stop — dashboard.md:163-181
- Folder-upload helpers use HTTPS with per-launch pinned cert, ≤4 concurrent files, 3 retries, verify phase, 10-min overwrite-confirm timeout — games.md:553-594
- Startup sweep stops helpers older than 15 minutes; manual sweep stops all unowned — games.md:600-603, settings.md:448-459
- Plan = stack.preview() writing `<runId>.plan.json`; env values ≥4 chars redacted in streamed/persisted logs — iac.md:25-47
- Approval expires after 15 minutes; re-approve restamps without re-plan — iac.md:92-104
- Apply gate verifies plan kind, approval, expiry, page hash, on-disk re-hash (artifact + config version id), engine version — iac.md:111-126
- Apply writes durable in-doubt marker (kind 'apply', partialApply true) before stack.up(); retries of the same plan run refused — iac.md:161-180
- Apply/destroy durable lock self-releases after 1 hour; plan uses only in-memory lock — iac.md:195-201
- Destroy gated by typed phrase + single-use 5-minute token; runs no-op inline program — iac.md:252-266
- Run detail lookup scans only 100 most recent runs (older 404) — iac.md:341-345
- Rollback writes historic config as new S3 head version and auto-starts a plan that still needs approval — iac.md:351-384
- Audit writes are best-effort; IaC entries written on run start; actor = OS username — audit.md:30-32, 57-62, 118-122
- Discord secrets collapsed to botTokenSet/publicKeySet server-side; never echoed — discord.md:83-96
- Interactions endpoint is CloudFront custom domain `discord.{hostedZoneName}` with ACM cert in us-east-1 — discord.md:98-140
- Discord permission evaluation: guild allowlist → admin user → admin role → per-game entry → deny — discord.md:340-341
- Commands registered per guild only (bulk overwrite of 4 commands) — discord.md:183-191
- BASE#discord DynamoDB row rewritten by infra on every apply; app cannot remove base guilds/admins — discord.md:226-235, settings.md:291-302
- Watchdog defaults 15 min / 4 idle checks / 100 packets, baked into EventBridge rate + env vars at apply; idle counter in ECS task tag — settings.md:262-289
- Auto-update: off by default, boot-time detect-only check, install only on explicit Download & Install — settings.md:155-234
- Diagnostics shows last 500 lines of today's main log, polled every 5s, includes forwarded renderer console — settings.md:336-362
- Cost estimate: vCPU × $0.04048 + GB × $0.004445 (us-east-1), fallback 2 vCPU/8 GB on read failure — costs.md:79, 93-98
- Log tail polls CloudWatch every 2s; 300-line window with historical paging across streams — logs.md:296-301, 385-404

### From docs/superpowers + openspec schemas/config

- OpenSpec default schema is spec-driven; superpowers-bridge is opt-in per change — openspec/config.yaml:1; templates/adopters/CLAUDE.md.fragment.md:14.
- Default schema was flipped to superpowers-bridge and reverted within a day (commits 9e15fa45 → 9c9235dc).
- Despite the default, 16 archived changes (2026-08-05 onward) and 5 in-flight changes (add-healthcheck-auth-type, add-icmp-ingress, add-pinned-hostname, embed-file-browser, https-explicit-web-port) carry bridge artifacts (brainstorm.md/plan.md, mostly verify.md/retrospective.md) — from `ls` of openspec/changes/**.
- Archived changes from before the schema install (e.g. 2026-08-10-add-one-click-aws-bootstrap, 2026-08-10-bump-lambda-runtime-to-nodejs24) have only proposal/design/specs/tasks; their plans live in docs/superpowers/plans/ instead — the pre-install pattern the schema now forbids (schema.yaml:181-183).
- Bridge graph: brainstorm → {proposal, design}; proposal → specs; {specs, design} → tasks → plan → (apply) → verify → retrospective — schema.yaml:58,82-83,114-115,142-143,163-165,194-195,308-309,465-466,469.
- apply requires plan and tracks tasks.md checkboxes — schema.yaml:469-470.
- verify/retrospective edges are file-existence only; runtime ordering enforced by shell PRECHECKs — schema.yaml:202-227, 316-337.
- Leak detector over docs/superpowers/specs/*.md treats pre-install files as non-blocking warnings — schema.yaml:258-278.
- Apply mandates worktree via superpowers:using-git-worktrees — schema.yaml:500-502 (conflicts with Pane-only worktree rule).
- Apply ends retro → `openspec archive -y` → finishing-a-development-branch, PR last — schema.yaml:540-575.
- HyveonDeployAll has four statements; HyveonStateBucket has no DynamoDB/lock actions (Pulumi S3 backend has no lock table) — bootstrap-1:17-70.
- HYVEON_DEPLOY_ALL_ACTIONS (flat) and HYVEON_DEPLOY_ALL_STATEMENTS (structured) coexist with a set-equality drift test — bootstrap-1:71-86.
- CloudFormation template is static with two literal tokens replaced by single-line JSON at render time — bootstrap-1:88-107; bootstrap-2:48-69.
- Bootstrap access key DeletionPolicy RetainExceptOnCreate — bootstrap-1:126; iam-bootstrap.yaml:73.
- CloudFormation console URL has no templateURL; operator uploads the rendered file manually — bootstrap-2:71-79.
- shell.openExternal failure degrades to showing the URL as text — bootstrap-2:81-92.
- Guided rotation: mint with bootstrap key → stage under `hyveon-guided` → verify new key → activate → revoke bootstrap with new key — bootstrap-2:106-154.
- General rotation for active pasted creds deletes the orphaned new key on verification failure and keeps old creds — bootstrap-3:39-73.
- Only pasted credential sources are rotatable — bootstrap-3:21-31.
- Keychain unavailable → refuse, never plaintext — bootstrap-2:162-171.
- Configuration bucket gets AES256 default encryption on both created/exists paths; failure → status 'failed' — bootstrap-4:18-45.
- IAM check `blocking` true only for missing + guided origin — bootstrap-5:41-51.
- revokeBootstrapKey is the one GuidedIamService method that reads the store's active credential — bootstrap-6:26-53.
- Five wizard.guidedIam.* IPC channels; no result type carries secretAccessKey — bootstrap-6:61-93.
- Wizard step order pick-cloud → guided-iam → credentials → bootstrap → stack-init — bootstrap-7:19-21; wizardSteps.ts:9.
- Guided-IAM sub-state persisted (never key material); rotation-pending resume lands on key re-entry — bootstrap-7:48-106.
- Reconfigure pre-completes guided-iam only when aws.profile === 'hyveon-guided' — bootstrap-7:120-136.
- Electron e2e: WizardController.getState() defaults wizardCompleted=true under HYVEON_TEST_MODE — bootstrap-8:29-35.
- Main bundle must keep @pulumi/pulumi, @pulumi/aws, @grpc/grpc-js external, enforced by build/verify-main-bundle-externals.mjs — bootstrap-8:109-115.
- Lambda runtime comes from one constant LAMBDA_RUNTIME = 'nodejs24.x' — bump plan:22-29; lambdas.ts:58.

### From openspec/specs A–G

- Renderer `console.*` is batched to `diagnostics.reportLog` every 2000 ms with a 50-entry send cap and a 200-entry queue cap, plus one "N entries dropped" marker per flush. app-diagnostics-logging:26-35
- `diagnostics.tail` returns a cumulative snapshot, so resuming after a pause replaces the view instead of appending to it. app-diagnostics-logging:193-202
- The diagnostics bundle has 4 sections gathered independently plus `errors.json`. A bundle where every section failed is still a valid export. app-diagnostics-logging:110-134
- The log viewer renders SGR ANSI codes and strips all other escape sequences. app-diagnostics-logging:240-250
- The updater module is constructed at boot but `checkForUpdates` only runs automatically when `enableAutoUpdate` is true. Changing the toggle takes effect on the next boot. auto-update-scaffold:12, :67-70
- A manual update check ignores the flag and never downloads. auto-update-scaffold:88-90
- When an update check fails, the updater falls back to the newest non-draft, non-prerelease GitHub release that has `latest*.yml`, retries once, then restores the primary feed. auto-update-scaffold:143
- Cloud Health runs once on Settings mount and never polls. Only the ECS service-linked-role check exists. aws-cloud-health:11-13, :34-39
- The Cloud Health Fix button treats `InvalidInputException` (already exists) as success and `AccessDeniedException` as needsPolicyUpdate. aws-cloud-health:64-71
- Pasted AWS keys are stored under `creds.aws.hyveon-pasted` as safeStorage ciphertext. When safeStorage is unavailable the paste flow errors instead of storing plaintext. aws-credentials:30, :42-45
- Key rotation order is create, persist, verify, delete old. A failed verification keeps the old key. aws-credentials:49, :56-59
- Both buckets get all four public-access-block settings on both the created and exists paths. The config bucket also gets AES256 and a 90-day noncurrent expiry. cloud-bootstrap:42, :56, :70
- IAM simulation blocks only on the guided-provisioning path and is advisory otherwise. If the simulation call itself fails, the wizard shows a warning. cloud-bootstrap:93
- The renderer is lint-banned from importing `@aws-sdk/*`. cloud-bootstrap:9, :16-19
- Cost Explorer is never called. Cost estimates come from `DescribeTaskDefinition` and static Fargate pricing constants. cost-visibility:11-14, :32-36
- Per-game resources (task def, log group, EFS-seeder Lambda) get the `Game=<id>` tag, and every RunTask path propagates task-definition tags. cost-visibility:92-137
- The window uses `titleBarStyle: 'hidden'`. macOS gets traffic lights, Windows gets titleBarOverlay, and Linux uses app-drawn buttons. custom-title-bar:13, :33-51
- `window.maximizedChange` is pushed on every maximize-state change, including OS snaps. custom-title-bar:96-101
- desktop-main boots through `NestFactory.createMicroservice` with the Electron IPC transport. No HTTP server runs. desktop-only-operator-surface:18-21
- There is no local configuration fallback. Without a config bucket the app reports setup as incomplete and sends the operator to the wizard. desktop-only-operator-surface:189, :193-196
- Streaming channels return async iterables across contextBridge, and cancelling a stream tears it down in the main process. desktop-only-operator-surface:128-164
- The logs action on a game card preselects that game. Opening logs from the sidebar falls back to the first game. desktop-only-operator-surface:172-185
- `${hyveon.network.public-address}` is baked into the task def as `<game>.<zone>`, and the deploy fails when no hosted zone is configured. env-token-interpolation:27
- `${hyveon.network.public-ipv4}` triggers a generated `/bin/sh -c` entryPoint that queries checkip.amazonaws.com for about 60 s. If the query fails, the container exits non-zero. env-token-interpolation:41, :60
- The ipv4 token requires a `command`, and the variable name must be a valid shell identifier. env-token-interpolation:69, :83
- The add-game draft autosaves about 1 s after edits stop, flushes on close, survives restart, and is cleared after the game is created. game-draft-persistence:11-15, :38-41, :94-95
- A declared health check fully replaces the network-traffic idle measurement. game-health-checks:19-21
- Any health-check failure counts as active, never idle. game-health-checks:154-162
- Health-check infrastructure is provisioned only when at least one game opts in, and its egress is limited to the ports declared by opted-in games. game-health-checks:185-189, :210-215
- The health-check target host always comes from the task's reported address and never from config. game-health-checks:232-235
- Basic and bearer health-check secrets are created, updated in place, and deleted by the app. Raw secrets are never deleted. game-health-checks:343-355
- An HTTPS game needs `webPort` (not 80/443), and its `ports` may not use 80/443 or the webPort over tcp. Legacy configs where `ports[0]` acted as upstream are normalised on read. game-https-configuration:44-47, :139, :163
- Internal ports get ingress from the VPC CIDR only. 443/80 tcp are reserved deployment-wide once any HTTPS game exists. game-port-visibility:34, :64-72
- ICMP entries use `container` as the ICMP type (0-255), create an SG rule with toPort -1, and produce no portMapping. game-port-visibility:115
- Discord `GAME_PORTS` uses the first non-icmp public port, or the https URL for HTTPS games. game-port-visibility:166
- The vCPU slider has 7 Fargate tiers. When a vCPU change makes the memory value invalid, memory resets to unset. game-resource-picker:23-40
- Folder upload runs through a temporary file-manager helper with operator-IP ingress, a pinned per-launch certificate, conflict confirmation before writes, size-based resume and verification, and a sweep for ownerless helpers older than 15 minutes. game-volume-folder-upload:25, :44, :71, :93, :104, :115

### From openspec/specs G–W

- Guided-IAM deploy policy is generated from `HYVEON_DEPLOY_ALL_ACTIONS` and must match the four statements in setup.md exactly. The state-bucket statement has no DynamoDB — openspec/specs/guided-iam-provisioning/spec.md:11,16,21
- Bootstrap key rotation order: create → keychain store → STS verify → delete old. A failed delete shows a warning, never success — guided-iam-provisioning/spec.md:68,80-83
- Without the keychain, guided creds are refused rather than stored in plaintext — guided-iam-provisioning/spec.md:92
- AWS region list is a committed generated file (no runtime fetch) excluding us-gov-/cn- — guided-region-selection/spec.md:15-22
- iac.destroy acquires the durable RunLock before the engine runs and releases it on cancel and shutdown — iac-destroy-flow/spec.md:11,23-31
- Destroy tokens are bound to workspace+stack and consumed atomically before the engine call — iac-destroy-flow/spec.md:37,44-47
- A later mint supersedes earlier destroy tokens for the same target. This is stated only in the test-coverage spec — orchestrator-integration-coverage/spec.md:101-104
- Apply gate order: exists → plan → approved → 15-min window → hash (record and re-hashed artifact) → engine version → atomic lock CAS — iac-plan-apply-page/spec.md:79
- Plan hash covers the config-object version id, and apply refuses if the config moved — iac-plan-apply-page/spec.md:79,90-93
- An engine-version change between plan and apply invalidates the plan — iac-plan-apply-page/spec.md:81
- Partial apply is a distinct terminal state that directs a re-plan — iac-plan-apply-page/spec.md:83,115-118
- An empty change summary reports 'unavailable', not 'no changes' — iac-plan-apply-page/spec.md:58-61
- 'Clear lock and retry' only for a durable-RunLock conflict, via a run-id-bound token, never auto-resubmit — iac-plan-apply-page/spec.md:131
- listVersions paginates ListObjectVersions with key/version markers — iac-rollback/spec.md:11
- Rollback holds the lock from restore through plan-record persistence. The restore is byte-for-byte, and the plan is tagged rolledBackFrom — iac-rollback/spec.md:41
- A missing (lifecycle-expired, 90-day) version fails before any write — iac-rollback/spec.md:74
- listRuns returns an empty page when the runs table output is absent — iac-run-history/spec.md:28-31
- Run-detail log source order: local streamLogs → logInline → presigned logS3Key — iac-run-history/spec.md:63
- Logs at or under 350KB are stored inline on the run record — orchestrator-integration-coverage/spec.md:122,136
- A Caddy sidecar is essential, proxies to localhost:webPort, and logs under the `caddy` prefix — in-task-tls-termination/spec.md:11,16
- No ingress on an HTTPS game's webPort. 443/80 open only when an HTTPS game exists — in-task-tls-termination/spec.md:72
- Certs persist on a per-game `{game}-certs` EFS access point at /data — in-task-tls-termination/spec.md:44
- Lambda log group = `/aws/lambda/{projectName}-{functionKey}`, default project 'hyveon' — infra-log-viewer/spec.md:12-15
- Infra log fetch errors return a single message plus logger.error and never throw — infra-log-viewer/spec.md:43-47
- LAMBDA_RUNTIME = nodejs24.x (verified at app/packages/infra/src/lambdas.ts:58), and the esbuild target must match — lambda-runtime-currency/spec.md:16,29
- Dev/CI Node = 24 across manifests and all 8 workflows — node-toolchain-version/spec.md:14,26,31
- Docs build uses onBrokenLinks:'throw' (verified at docs/docusaurus.config.ts:16) — operator-documentation/spec.md:158
- Engine provisioned into the userData cache, pinned version, memoized, and the constructor never throws — pulumi-engine-runtime/spec.md:11
- Stack passphrase is derived from the STS account id + stack name + an app constant and never stored. Legacy random passphrases are migrated — pulumi-engine-runtime/spec.md:77,79
- Credential env is exclusive: a profile run clears key vars, a paste run clears AWS_PROFILE/AWS_DEFAULT_PROFILE — pulumi-engine-runtime/spec.md:132
- Backend lock reclaimed silently only if the app can prove ownership; otherwise confirm with holder and age — pulumi-engine-runtime/spec.md:163-168
- Cancellation = a single SIGINT via AbortSignal, then abandoning the promise after a timeout — pulumi-engine-runtime/spec.md:192
- Discord secret value is create-only (ignored on reconcile) so redeploys don't revert creds — pulumi-infra-program/spec.md:72
- S3 config bucket is the only config source, with no local-file fallback — pulumi-infra-program/spec.md:42,48-49
- `${hyveon.network.public-address}` resolved at deploy, and `public-ipv4` gets a /bin/sh -c wrapper — pulumi-infra-program/spec.md:149
- Release: version bump committed directly to protected main via a distinct identity. The draft release is created only after all builds succeed — release-automation/spec.md:44,77
- AI summary failure falls back to the raw changelog without failing the release — release-automation/spec.md:66,72-74
- Wizard resume uses a typed guided-IAM sub-state with key presence, never re-displaying a secret — wizard-flow/spec.md:53
- Stack-init streams {phase: engine|plugins|operation, status: start|end} — wizard-flow/spec.md:77
- Reconfigure cancel reverts only local ElectronStore state, and AWS mutations persist — wizard-flow/spec.md:100,122-125

### From active changes (3 large)

- Health-check `auth.type` absent means `raw` everywhere; `raw` injects the secret verbatim as `Authorization` with no prefix (add-healthcheck-auth-type/specs/game-health-checks/spec.md:14-21). Code: `type?: 'raw' | 'basic' | 'bearer'` at app/packages/shared/src/gameServerConfig.ts:129.
- A `basic` secret is JSON `{username,password}`; the engine builds `Basic base64(u:p)`; malformed JSON = unavailable credential → the fail-active path (spec.md:23-26; design.md:27-30,54).
- A constructed `Authorization` header overrides an operator-declared `Authorization` header; inline-credential-looking header values are rejected at validation (spec.md:31-38).
- App-owned secret name is deterministic `hyveon-${gameId}-healthcheck-auth` (app/packages/shared/src/secrets/secretsStore.ts:95; plan.md:17).
- The secret lifecycle (create → put → delete) runs inside `GamesWriteService.createGame/updateGame/deleteGame`, behind the existing `games.*` IPC; there is no dedicated IPC (tasks.md:20).
- The AWS secret mutation is deferred until after the structural validation preview, so a rejected save never mutates the live secret (verify.md:29).
- DeleteSecret uses the default recovery window, never ForceDeleteWithoutRecovery (verify.md:37; plan.md:18).
- No IAM change: `secretsmanager:*` in HYVEON_DEPLOY_ALL_ACTIONS covers Create/Put/Delete; a regression test is in IamCheckService.test.ts (design.md:47-50; verify.md:23).
- A `raw` secret is never deleted by the system (spec.md:189-224).
- `pinnedHostname` absent → byte-identical task definition (add-pinned-hostname/specs/game-hostname-pinning/spec.md:5,75-78).
- Pinned-hostname init container: `public.ecr.aws/docker/library/busybox:1.38.0` (app/packages/infra/src/hostnameShim.ts:15), essential:false, writes a base64-decoded shim into an ephemeral volume; the game container `dependsOn` it with SUCCESS (design.md:45-52).
- `NODE_OPTIONS` = `--require=/hyveon/hostname-shim/hostname-shim.js` + space + the operator's resolved value; exactly one entry; the merge runs after `${hyveon.*}` token resolution and before the ipv4 wrapper (spec.md:80-97; tasks.md:14).
- Validator rejects a volume container_path at or under `/hyveon/hostname-shim`, and the reserved name `hostname-shim` for the game or a volume, only when pinnedHostname is set (spec.md:19; shared/src/gameServerValidator.ts:69,72,944).
- If the init container fails, the game container never starts; the reason shows in the ECS stop reason and the `hostname-shim` log stream (design.md:97).
- The shim works only for Node games that read `os.hostname()` and don't strip NODE_OPTIONS; it is inert otherwise (design.md:94-96).
- Diagnostics bundle carries `hasPinnedHostname` but not the value (plan.md:123; tasks.md:27).
- HEAD: the file-manager helper image is `filebrowser/filebrowser:latest` (app/packages/desktop-main/src/services/FileManagerService.ts:17). This is a floating tag of an archived project; embed-file-browser PR1 pins v2.63.23.
- HEAD: the browse helper serves plain HTTP on 8080, and the plaintext credential is returned via `FileMgrResult.credentials` and rendered in the modal (embed-file-browser/proposal.md:14; design.md:22-28).
- HEAD: stack output `efsAccessPoints` exposes only each game's first volume (infra/src/program.ts:406-408), so a #672 folder upload to a second volume lands in the first volume (design.md:39).
- HEAD: `EcsService.findRunningTask` swallows errors → null ("not running"), so upload preflight fails open (design.md:143).
- HEAD: `setDefaultBrowserOpener` (electron-entry.ts:44-51) turns window.open into shell.openExternal and logs failures only to console.error (design.md:28,33).
- HEAD: the `useFileManager` poller can stop before a url resolves (use-file-manager.hook.ts:122-136) (design.md:35).
- HEAD: upload refuses with `helper-open` when a browse helper exists (main spec game-volume-folder-upload/spec.md:41; proposal.md:20).
- Planned: one helper per game held by a main-process HelperSessionRegistry with browse/upload holders, a 5 min browse grace, a before-quit stop, and the 2 h EventBridge auto-stop as backstop (design.md:96-105).
- Planned: a mutation guard with typed `server-running` / `server-check-failed` refusals; an unknown server state counts as running (design.md:141-146).
- Planned: helper volume layout `/srv/<dir>` per applied volume, with a name-sanitization rule and `volume-<index>` fallback (design.md:177).
- Planned: renderer never handles local paths; drag-drop is resolved via `webUtils.getPathForFile` in the preload (design.md:130).

### From active changes (6 others)

- ICMP port entries produce SG rule `{protocol:'icmp', fromPort:type, toPort:-1}` and are excluded from ECS portMappings — add-icmp-ingress/specs/game-port-visibility/spec.md:4; design.md:32-34
- ICMP type must be integer 0-255; wizard defaults new icmp rows to 8 — add-icmp-ingress/spec.md:4,42
- Cross-game duplicate icmp entries allowed iff effective visibility matches; one deduped SG rule — add-icmp-ingress/spec.md:25
- icmp on https games rejected by tcp/udp-only rule — add-icmp-ingress/spec.md:4; https-explicit-web-port/specs/game-https-configuration/spec.md:59
- firstPortByGame skips icmp; picks public-first; https games emit `'https'` marker rendered as https://{game}.{zone} — add-icmp-ingress/plan.md:153-159; https-explicit-web-port/specs/game-port-visibility/spec.md:31; commit ec3e6f51
- A declared healthCheck replaces (not combines with) the NetworkPacketsIn heuristic — add-pluggable-health-checks/specs/game-health-checks/spec.md:17-19
- Health-check Lambda provisioned only when ≥1 game declares healthCheck; zero footprint otherwise — add-pluggable-health-checks/spec.md:144-148; tasks.md:36
- Watchdog invokes health-check Lambda RequestResponse with `{game, taskArn, healthCheck}` from a JSON env var map; never calls GetSecretValue — add-pluggable-health-checks/design.md:72-102
- Fail-active at engine, handler, and watchdog-invoke layers; failed invoke doesn't increment idle counter — add-pluggable-health-checks/design.md:109-116; tasks.md:27
- Health-check destination host comes only from ECS DescribeTasks attachment — add-pluggable-health-checks/spec.md:191-194; design.md:127-133
- No HTTP redirect following; 3xx = failure → active — add-pluggable-health-checks/spec.md:87-89
- Health-check egress limited to union of declared health-check ports toward shared gameServersSg (port-level confinement) — add-pluggable-health-checks/spec.md:169-174
- Response bodies and credentials never logged; failure-derived verdicts at warn — add-pluggable-health-checks/design.md:146-159; tasks.md:19
- LAMBDA_RUNTIME is nodejs24.x — add-pluggable-health-checks/specs/lambda-runtime-currency/spec.md:9-12
- Release workflow is workflow_dispatch only; skip_bump requires tag and fails fast — add-release-automation/spec.md:7-61; tasks.md:16-17
- Release bump commit/tag pushed via GitHub App token (actions/create-github-app-token) — add-release-automation/design.md:35-36; .github/workflows/release.yml:61-64
- AI release notes via anthropics/claude-code-action restricted to Read,Write tools with continue-on-error fallback to raw changelog — add-release-automation/design.md:41; tasks.md:9-11; release.yml:181
- Releases are always drafts requiring human publish — add-release-automation/spec.md:74-79
- git-cliff pinned 2.13.1 via npx — add-release-automation/design.md:25; release.yml:137-159
- (Proposed) script health checks run in fresh QuickJS-WASM context per check, host-enforced wall clock/memory/request cap, host owns destination — add-scripted-health-checks/design.md:46-115
- (Proposed) script reason truncated and redacted of secret-like substrings before logging — add-scripted-health-checks/specs/scripted-health-checks/spec.md:169-177
- (Proposed) script create/modify recorded in audit trail — add-scripted-health-checks/scripted spec.md:145-147
- (Proposed) VPC Flow Log ALL traffic to `/vpc/${projectName}-flow-logs`, default-on `vpcFlowLogsEnabled` — add-vpc-flow-logs/design.md:58-106
- (Proposed) flow-log IAM role scoped to exactly one log group ARN — add-vpc-flow-logs/spec.md:23
- webPort required iff https, 1-65535, not 80/443; issues pathed at `webPort` — https-explicit-web-port/specs/game-https-configuration/spec.md:5; gameServerValidator.ts:704-729
- Legacy https games normalised on read (webPort = ports[0].container, ports = slice(1)), persisted only on next save, debug log with game name only — https-explicit-web-port/design.md:38-42
- Cross-game: tcp extra equal to another game's webPort rejected both directions — https-explicit-web-port/game-https-configuration/spec.md:63; gameServerValidator.ts:827-862
- Caddy sidecar proxies `localhost:<webPort>`; webPort gets no SG ingress; https extras ingressed honoring visibility — https-explicit-web-port/specs/in-task-tls-termination/spec.md:5,24
- healthCheck.port may equal webPort; health-check ingress follows target (Lambda-source only) — https-explicit-web-port/design.md:45; plan.md:32; gameServerValidator.ts:1000

## Cross-scope references

### From docs site root pages, guides, diagrams, config

- app/packages/shared/src/iamPolicy.ts (HYVEON_DEPLOY_ALL_ACTIONS), iamPolicy.test.ts — setup.md:225-238
- IamCheckService, AwsProfileService.rotateActiveCredentials(), GuidedIamService/iam-bootstrap.yaml CFN template — setup.md:179, 251, 298
- DeploymentConfigService, REMOTE_FILE_STORE, CloudProviderModule tokens — maintainer.md:206-207, 353-356
- DiscordConfigService.getRedacted/getEffectiveToken, DiscordCommandRegistrar.registerForGuild — maintainer.md:254-262
- canRun(), actionForCommand(), COMMAND_DESCRIPTORS (app/packages/shared/src/commands.ts), ddb/client.ts — maintainer.md:247-283
- app/packages/lambda/interactions/src/handler.ts, followup handler — maintainer.md:280-281
- app/packages/infra/src/{network,securityGroups,efs,ecs,iam,lambdas,dynamodb,secrets,route53,escapes,discordDomain,program}.ts, testing/pulumiMocks.ts — maintainer.md:70-83, 331
- app/packages/web/src/api.service.ts, window.hyveon, window.hyveon.__test.mock(), app/packages/web/e2e/screenshots, playwright.screenshots.config.ts — maintainer.md:376-388
- Root package.json scripts (desktop:run/dev/build/package, app:*, icons:generate, aws-regions:generate, docs:screenshots), electron-builder.yml, electron.vite.config.ts, build/generate-icons.mjs, build/generate-aws-regions.mjs, app/packages/shared/src/awsRegions.ts, cliff.toml — setup.md, maintainer.md
- .github/workflows/* (8) and .github/actions/{setup-app,build-package,publish-release} — maintainer.md:45-47, 158-190; diagrams/README.md:5
- Other docs pages: /architecture, /components/{infra,lambdas,management-app}, /app/* (first-run-wizard, games, iac, discord, settings, logs, costs, audit, dashboard) — linked throughout
- openspec capabilities: auto-update-scaffold (code-signing-roadmap.md:71); in-task-tls-termination implied by Caddy claims
- docs/static/diagrams/*.svg, docs/static/img/{logo.svg,favicon.ico,app/*.png} — intro.md:71, docusaurus.config.ts:14,59, maintainer.md:385
- CLAUDE.md, CONTRIBUTING.md — maintainer.md:12-14, 133, 148

### From docs/docs/components + architecture

- Docs pages outside scope: /setup (HyveonDeployAll policy, IAM bootstrap), /guides/maintainer (#when-you-touch-the-nest-server, #refreshing-the-documentation-screenshots), /app/iac (#run-plan, #the-workspace-busy-banner), /app/games (#health-check-optional, #seeding-a-volume-from-a-folder, #draft-autosave), /app/settings (#general, #cloud-setup, #updates, #diagnostics), /app/logs (#infrastructure-logs), /app/dashboard, /app/costs, /app/discord, /app/audit, /app/first-run-wizard, /app (index); docs/static/diagrams/*.svg; docs/static/img/app/*.png.
- OpenSpec: openspec/specs/desktop-only-operator-surface (management-app.md:457), openspec/specs/game-health-checks (infra.md:235, lambdas.md:205), `orchestrator-integration-coverage` delta spec (integration-tests.md:145), openspec/changes/archive/2026-08-10-migrate-iac-to-pulumi/tasks.md (integration-tests.md:145), `openspec/changes/remove-cost-explorer-calls` (stale; archived) (management-app.md:276). Active changes with likely doc impact not referenced: add-icmp-ingress, https-explicit-web-port, add-pinned-hostname, embed-file-browser, add-healthcheck-auth-type (their behaviour already appears in infra.md/lambdas.md).
- Code: every app/packages/* workspace (infra src files, six lambda packages, shared modules, desktop-main controllers/services/modules, cloud-aws, desktop-preload, web); app/vitest.config.ts, app/vitest.setup.ts; .github/workflows/e2e.yml; root package.json scripts (app:test:integration, app:test:e2e, app:build:lambdas, docs:screenshots).
- Repo meta: CLAUDE.md (invariants duplicated in architecture.md:119-172), .claude/rules/testing-conventions.md (overlaps integration-tests.md jsdom sections), .claude/rules/logging.md (overlaps management-app.md:321-340).

### From docs/docs/app

- Other docs: /setup (docs/docs/setup.md, HyveonDeployAll policy), /architecture, /components/infra (anchor #state-backend--self-managed-s3-no-dynamodb-lock-table exists at docs/docs/components/infra.md:50), /components/management-app#logging (heading at management-app.md:315), /guides/user.
- OpenSpec: costs.md:24 → openspec/changes/remove-cost-explorer-calls (now archived as openspec/changes/archive/2026-08-06-remove-cost-explorer-calls). Content maps to in-flight changes add-icmp-ingress, https-explicit-web-port, add-pinned-hostname, add-healthcheck-auth-type, add-pluggable-health-checks, add-update-feed-fallback, add-user-initiated-update-install, embed-file-browser (openspec/changes/*) — these doc sections appear to already describe those behaviours.
- @hyveon/infra: defineEcs (log groups), discordDomain.ts (ACM/CloudFront/alias), watchdog EventBridge schedule, BASE#discord row writer, security groups (VPC-only, ICMP, Caddy 80/443), default table names.
- @hyveon/desktop-main: PulumiService (preview/up/destroy/initializeStack/apply marker), PulumiEngineService, BootstrapService, DeploymentConfigService, wizard/guided-IAM/AWS profile/IAM-check services, electron-entry.ts initUpdater, updater check/download/install, IPC channels costs.estimate and iac.settings.autoUpdate.{get,download,install}, ElectronStoreService (enableAutoUpdate, add-game draft, folder selection), diagnostics bundle, helper sweep.
- @hyveon/web: pages dashboard/games/game-detail/iac/iac-history/run-detail/discord/logs/infrastructure-logs/costs/audit/settings; useLogTail (use-log-tail.hook.ts WINDOW_SIZE=300), LogTailView, watchdog-panel.component.tsx, first-run-wizard components.
- @hyveon/shared: PULUMI_ENGINE_VERSION (pulumiVersion.ts:21 = 3.255.0), DeploymentConfig/GameServerConfig fields, legacy-HTTPS read-time normaliser, canRun (permission order).
- Lambdas: update-dns (DNS on RUNNING/STOPPED), watchdog, health-check (conditional), interactions, followup; efs-seeder exists but is not referenced in these docs.
- AWS: ECS RunTask/StopTask/DescribeTaskDefinition, CloudWatch Logs, Secrets Manager, DynamoDB (runs, audit, discord config), S3 versioned config bucket, IAM SimulatePrincipalPolicy/CreateServiceLinkedRole, STS GetCallerIdentity, EventBridge Scheduler, CloudFormation (iam-bootstrap.yaml), electron-updater/GitHub Releases.
- Static assets: all 20 referenced /img/app/*.png exist under docs/static/img/app.

### From docs/superpowers + openspec schemas/config

- openspec/changes/archive/2026-08-10-add-one-click-aws-bootstrap/ (proposal, design, specs guided-iam-provisioning, aws-credentials, cloud-bootstrap, wizard-flow) — target of all bootstrap-* plans.
- openspec/changes/archive/2026-08-10-bump-lambda-runtime-to-nodejs24/ (spec lambda-runtime-currency) — target of the bump plan.
- openspec/specs/* main specs: guided-iam-provisioning, aws-credentials, cloud-bootstrap, wizard-flow, lambda-runtime-currency (named in plans); `openspec/specs/README.md` is referenced by templates/proposal.md:37 but MISSING.
- docs/docs/setup.md HyveonDeployAll policy (bootstrap-1:17); docs/docs/components/integration-tests.md (bootstrap-8:10).
- .claude/rules/spec-driven-development.md — near-copy of templates/adopters/CLAUDE.md.fragment.md; CLAUDE.md OpenSpec workflow section; .claude/rules/worktree.md (conflicts with schema apply step 1); .claude/rules/duplication.md (conflicts with bootstrap-6/7 'keep in sync' mirrors).
- Code: app/packages/shared/src/{iamPolicy.ts, iamPolicy.test.ts, wizardSteps.ts}; app/packages/desktop-main/src/{cloudformationTemplate.ts, electron-entry.ts, logger.ts}, services/{GuidedIamService, AwsProfileService, IamCheckService, BootstrapService, FirstRunWizardService, ConfigService, ElectronStoreService, SafeStorageService, awsCredentialSource}.ts, controllers/wizard.controller.ts, modules/wizard.module.ts, resources/cloudformation/iam-bootstrap.yaml; app/packages/desktop-preload/src/{hyveon-api.ts, preload.ts}; app/packages/web/src/components/first-run-wizard/{first-run-wizard, guided-iam-step, credentials-step, stack-init-step}.component.tsx; app/packages/web/e2e/{pages/GuidedIamWizardPage.ts, pages/index.ts, specs/guided-iam-wizard.spec.ts, specs/discord.spec.ts, specs/electron-clean-quit.spec.ts, integration-specs/*}; app/packages/infra/src/{lambdas.ts, lambdas.test.ts}; app/packages/lambda/*/esbuild.config.mjs; electron-builder.yml; electron.vite.config.ts; build/verify-main-bundle-externals.mjs.
- Pivot spec references packages/concepts to verify elsewhere: @hyveon/cloud-aws CloudProviderModule + four interfaces, nestjs-electron-ipc-transport, fix-path, desktop-main/updater.ts + enableAutoUpdate, @hyveon/scripts/init-parent, app/test/fake-terraform.mjs, lint rule banning @aws-sdk/* in @hyveon/web.
- External/upstream: JiangWay/openspec-schemas (README links to its .github/workflows/validate-schemas.yml, version-check.yml, scripts/install-git-hooks.sh — none present here), obra/superpowers, Fission-AI/OpenSpec PR #970.

### From openspec/specs A–G

- `.claude/rules/logging.md`: restated as a SHALL in app-diagnostics-logging:84, :38.
- `ansi-log-viewer.component.tsx` (`/logs` page) and `DiagnosticsPanel.tsx`: app-diagnostics-logging:185-191.
- `build/icon*`, `electron-builder.yml`, `app/packages/web/index.html`, and the CI package matrix: app-icon. `npm run icons:generate` and the SVG sources (CLAUDE.md) are not referenced.
- `desktop-main/src/updater.ts`, `ElectronStoreService`/`AppStoreSchema`, the Package and release GitHub workflows, and the GitHub releases API: auto-update-scaffold.
- `CloudHealthService`, `cloud-health.controller.ts`, and the wizard IAM permission-check UI component: aws-cloud-health:38, :70.
- Guided IAM provisioning / one-click bootstrap (another spec) and its CloudFormation stack: aws-credentials:63, cloud-bootstrap:93, aws-cloud-health:71.
- `SafeStorageService` and `CloudProviderModule` factories: aws-credentials:30.
- `BootstrapService`, `RemoteFileStore`, `HYVEON_DEPLOY_ALL_ACTIONS`, `app/packages/shared/src/iamPolicy.ts` and its test, the CloudFormation template, and `docs/docs/setup.md`: cloud-bootstrap.
- `migrate-iac-to-pulumi` (archived change): cloud-bootstrap:72.
- `AwsCloudProvider.startWorkload`, the followup Lambda's RunTask, and the infra task-def/log-group/EFS-seeder definitions: cost-visibility:108-137.
- Dashboard and Costs pages, and the add/edit-game Resources step: cost-visibility. Overlaps game-resource-picker.
- `main.ts`, `app.module.ts`, `ConfigService`, `ConfigController`, `server_config.json`, `app.component.tsx` routes, `iac.stack.initialize`, the `/iac` page, `hyveon-http-bridge.ts`, the chromium e2e specs, `app/packages/web/e2e/integration-specs/`, and Epic F: desktop-only-operator-surface.
- Docs pages named as obligations: CLAUDE.md, README.md, docs/docs/{setup,architecture,intro}.md, components/management-app.md, guides/*, guides/maintainer.md (desktop-only-operator-surface:58; docs-screenshot-capture:106).
- `docs/static/img/app/` and `out/main/index.js` (`desktop:build`): docs-screenshot-capture.
- The DNS-update Lambda hostname and the Route53 hosted zone: env-token-interpolation:27. The CLAUDE.md DNS invariant and possibly the hostname-pinning feature (commit 5b984bbe) are relevant.
- `gameServerValidator.ts` (`checkHttpsPortRules`, `checkPortCollisions`) is shared by env-token-interpolation, game-environment-variables, game-https-configuration, game-port-visibility, and game-health-checks.
- `in-task-tls-termination` spec (Caddy sidecar infra): game-https-configuration:5.
- `DeploymentConfigService` (S3 `deployment-config.json`): game-https-configuration:120, :163.
- The watchdog Lambda idle decision, the conditional health-check Lambda, `app/packages/infra/src/network.ts`, and Secrets Manager: game-health-checks.
- The infra `game_servers` SG, VPC CIDR, and `firstPortByGame()` / Discord `GAME_PORTS` (`app/packages/infra/src/lambdas.ts`): game-port-visibility.
- The file-manager helper task (embed-file-browser change/spec), EFS volumes `container_path`, `file_seeds`, and the Diagnostics "Clean up stray helpers" control: game-volume-folder-upload.

### From openspec/specs G–W

- docs/docs/setup.md — oracle for the HyveonDeployAll policy (guided-iam-provisioning:11,16) and Node prerequisite (node-toolchain-version:37-38; operator-documentation:119)
- `IamCheckService` / IAM permission gate spec (not in this part) — guided-iam-provisioning:11,68
- `SafeStorageService`, `ElectronStoreService` — guided-iam-provisioning:92; wizard-flow:39,91; operator-documentation:134
- `env-token-interpolation` capability spec — pulumi-infra-program:149
- `desktop-only-operator-surface` (implied by the no-bearer-token rule) — operator-documentation:55-56
- app/packages/desktop-main ipc-main-bridge.ts `SELF_BRIDGED_PATTERNS`, IacController, IacRunsController, RunService (RunLock), RunRecordService, PulumiService, PulumiEngineService, FirstRunWizardService — iac-destroy-flow:11; iac-run-history:11; iac-plan-apply-page:131; orchestrator-integration-coverage:*; pulumi-engine-runtime:11; wizard-flow:25
- @hyveon/cloud-aws AwsRemoteFileStore, AwsRunRecordStore — iac-rollback:11; iac-run-history:11
- @hyveon/shared: runs.ts (RunRecord, RunPageResult, rolledBackFrom), cloud.ts (RunRecordStore), awsRegions.ts, HYVEON_DEPLOY_ALL_ACTIONS, PULUMI_ENGINE_VERSION, StackOutputs, DeploymentConfig/gameServers — multiple
- @hyveon/desktop-preload hyveon-api.ts, src/index.ts; @hyveon/web globals.d.ts, app.component.tsx routes — iac-destroy-flow:66; iac-run-history:11; preload-bridge-naming:21-27; operator-documentation:19
- app/packages/infra/src/{ecs,efs,lambdas}.ts (defineEcs, defineEfs, LAMBDA_RUNTIME) — in-task-tls-termination:11,44,67; lambda-runtime-currency:15; node-toolchain-version:49
- app/packages/lambda/*/esbuild.config.mjs; lambda-update-dns, lambda-watchdog, lambda-efs-seeder, lambda-health-check — lambda-runtime-currency:28; operator-documentation:89-92; in-task-tls-termination:58
- .github/workflows/* + setup-app composite action; release.yml — node-toolchain-version:25-31; release-automation; operator-documentation:153
- electron-builder.yml (hardenedRuntime, enableAutoUpdate), README.md — install-and-signing-docs:25,34,43
- docs/docs/** pages (intro, architecture, components/*, guides/user|maintainer, app/*, install, code-signing-roadmap), docs/diagrams/*.d2, render.sh, docs/static/** — operator-documentation, install-and-signing-docs, node-toolchain-version
- `scripts/package.json` — referenced by node-toolchain-version:13,18 but does not exist
- Issue refs: #110 (iac-plan-apply-page:18), #260 (iac-rollback:11), issue-70 screenshots (operator-documentation:176)

### From active changes (3 large)

- Code (pinned hostname, on HEAD): app/packages/infra/src/hostnameShim.ts (+ .test.ts), app/packages/infra/src/ecs.ts (`defineEcs`, `logConfiguration`, `resolveGameEnvironment`), app/packages/shared/src/gameServerConfig.ts (`GameServer.pinnedHostname`), app/packages/shared/src/gameServerValidator.ts (`checkPinnedHostname`, `PINNED_HOSTNAME_PATTERN`, `HOSTNAME_SHIM_MOUNT_PATH`, `HOSTNAME_SHIM_RESERVED_NAME`), web wizard-form.utils.ts / environment-step / review-step, desktop-preload/src/hyveon-api.ts, web/src/api.service.ts, desktop-main ElectronStoreService.ts / GameWizardDraftService.ts (`isGameWizardDraft`) / diagnosticsBundleAllowlist.ts.
- Code (health-check auth, on HEAD): app/packages/lambda/health-check/src/handler.ts, app/packages/shared/src/secrets/secretsStore.ts, desktop-main GamesWriteService, GameWizardDraftService (`redactSecretFields`), IamCheckService(.test).ts, app/packages/shared/src/iamPolicy.ts (`HYVEON_DEPLOY_ALL_ACTIONS`), web networking-step / split health-check fields component (#580).
- Code (file browser, HEAD = pre-change; target lives on origin/embed-file-browser-* branches): desktop-main FileManagerService, FilesController, FolderUploadService, FolderScanService, DiagnosticsController, EcsService, PulumiService (`projectStackOutputs`), FileBrowserClient, uploadEngine, `buildTlsContainerSettings`/`EphemeralCert`, `sweepStrayHelpers`; infra program.ts `buildStackOutputs`, efs.ts `gameAccessPoints`; shared folderUpload/paths.ts `toRemotePath`/`validateDestination`, `StackOutputs`; web game-card.component.tsx, FileManagerModal, useFileManager, PollingProvider; desktop-main electron-entry.ts; test fixture fake-filebrowser-server, FolderUpload.integration.test.ts.
- Docs referenced: docs/docs/components/infra.md, docs/docs/app/games.md, docs/docs/app/dashboard.md, docs/docs/components/management-app.md, docs/docs/architecture.md, docs/docs/setup.md, docs/docs/components/integration-tests.md.
- Rules referenced: .claude/rules/{tsdoc-tags,comment-conciseness,testing-conventions,logging,duplication,pr-stacking}.md, ~/.claude/rules/dependencies.md.
- Main specs: openspec/specs/game-health-checks/spec.md (already holds the auth-type text), openspec/specs/game-volume-folder-upload/spec.md (pre-change text), openspec/specs/{pulumi-infra-program,in-task-tls-termination,game-environment-variables} (named as unaffected by pinned hostname).
- Other changes: add-pluggable-health-checks (introduces game-health-checks; unarchived), add-scripted-health-checks (also MODIFIES game-health-checks), add-folder-volume-upload (archived 2026-10-26; base of the folder-upload delta).
- Git: #530 f94bef16 (auth types), #644 cdd0cb8c (health-check spec sync), #692 5b984bbe (pinned hostname), #686/#690 (embed-file-browser proposal/plan), #672 df477b91 (folder upload, source of the wrong-volume bug), #680 (file-manager log groups); unmerged branches origin/embed-file-browser-{1-backend,2-volumes,3-registry,4-ipc,5-page,6-closeout}.

### From active changes (6 others)

- Main specs: openspec/specs/game-port-visibility, game-health-checks, lambda-runtime-currency, release-automation, game-https-configuration, in-task-tls-termination (compared above); openspec/specs/infra-log-viewer (vpc-flow-logs sibling, not modified); operator-documentation (also touched by sync #644).
- Other changes: add-healthcheck-auth-type (game-health-checks MODIFIED/ADDED — other worker); add-internal-game-ports (archived precedent cited by https design.md:39 / brainstorm.md:17).
- Code: app/packages/shared/src/{gameServerConfig.ts, gameServerValidator.ts, gameServerPorts.ts, formatStatus.ts, deploymentConfig/DEPLOYMENT_CONFIG_DEFAULTS, canRun}; app/packages/infra/src/{securityGroups.ts, ecs.ts, lambdas.ts, iam.ts, network.ts, program.ts, testing/fixtures.ts, flowLogs.ts (proposed)}; app/packages/lambda/{watchdog, health-check, update-dns, followup, efs-seeder}; app/package.json build:lambdas; desktop-main services {DeploymentConfigService, DriftService, GameWizardDraftService, ElectronStoreService, LogsService, diagnosticsBundleAllowlist}, controllers/logs.controller.ts; web components/add-game-wizard/{networking-step, wizard-form.utils, review-step}, edit-game-form, pages/{games, game-detail}, e2e/specs/games.spec.ts, e2e/screenshots/demo-data.ts.
- CI: .github/workflows/release.yml, package.yml, .github/actions/{build-package,publish-release,setup-app}; cliff.toml; root package.json version.
- Docs: docs/docs/components/{infra.md, lambdas.md}, docs/docs/app/{games.md, wizard pages, settings}, docs/docs/architecture.md, setup.md (Palworld example; HyveonDeployAll), guides/{user.md, maintainer.md}, intro.md, README.md.
- Rules: .claude/rules/{pr-stacking.md, duplication.md, tsdoc-tags.md, logging.md, testing-conventions.md, comment-conciseness.md}; skills write-docs, deployment-config-field-auditor agent, /opsx:sync.
- External: GitHub ruleset enforce-main-branch-protection; GitHub App "Hyveon Release Bot"; secrets RELEASE_APP_ID/RELEASE_APP_PRIVATE_KEY/CLAUDE_CODE_OAUTH_TOKEN; live SG sg-0e37b362ca57210bf.
