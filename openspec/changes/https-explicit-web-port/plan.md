# Explicit HTTPS Web Port Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `https = true` games a dedicated `webPort` (the Caddy upstream), make `ports[]` optional additional ports that receive ingress, and migrate legacy configs on read.

**Architecture:** A pure helper module in `@hyveon/shared` owns the port rules and the legacy normaliser; the validator, `DeploymentConfigService`, infra, lambdas and wizard all call it. Three stacked PRs per `.claude/rules/pr-stacking.md`: shared → infra/lambdas → wizard/docs.

**Tech Stack:** TypeScript, zod, Vitest, Pulumi (`@hyveon/infra`), NestJS (`desktop-main`), React (`@hyveon/web`), Playwright.

**Spec:** `openspec/changes/https-explicit-web-port/` (`proposal.md`, `design.md`, `specs/`, `tasks.md`).

## Global Constraints

- `webPort`: integer 1–65535, never 80 or 443, required iff `https: true`, absent otherwise; issues pathed at `webPort`.
- `ports[]` on https games: tcp/udp only, no 80/443, no tcp entry equal to `webPort`; empty allowed; no `ports[0]`-tcp rule; icmp still rejected.
- Normaliser: https with no `webPort` → `webPort = ports[0].container`, `ports = ports.slice(1)`; idempotent; persisted only by the next ordinary save.
- `webPort` gets no security-group ingress; https extras get ingress honoring `visibility`.
- Caddy upstream is `localhost:<webPort>`; ECS `portMappings` cover `webPort` and non-icmp extras.
- Discord connect surface for https games shows the `https://{game}.{hosted_zone_name}` URL.
- `shared/src/index.ts` barrel gains no AWS SDK imports; new helper is pure.
- No Foundry credentials or license keys in any file or PR.
- Every PR: `npm run app:lint`, `app:typecheck`, `app:test` exit 0; `app:test:integration` for PR 1/2; `app:test:e2e` for PR 3. TSDoc per `.claude/rules/tsdoc-tags.md`; IPC handlers log per `.claude/rules/logging.md`.

## Review Focus

- Legacy https game with exactly one port → `ports: []`, `webPort` set (empty `ports` must survive every consumer: SG, ECS, wizard, review step, drift).
- Legacy https game whose `ports[0]` is udp or 443 (previously impossible; must not crash the normaliser — surface a validation issue on save instead).
- Normalised-on-read games log one debug line with no payload; the deprecation tag survives lint (`tsdoc/syntax`).
- Re-saving a normalised config twice yields byte-identical JSON (idempotence).
- Two https games with the same `webPort` (allowed: ports are per-task) but an extra colliding with another game's public port (must still be rejected by cross-game collision).
- `healthCheck.port` equal to `webPort`: health-check ingress must not open `webPort` publicly beyond the health-check Lambda source.

---

## Task 1: Shared port helpers, type, validator (PR 1)

**Files:**
- Create: `app/packages/shared/src/gameServerPorts.ts`, `app/packages/shared/src/gameServerPorts.test.ts`
- Modify: `app/packages/shared/src/gameServerConfig.ts`, `gameServerValidator.ts`, `gameServerValidator.test.ts`, `index.ts`

**Interfaces:**
- Produces: `normalizeGameServer<T extends Pick<GameServerConfig,'https'|'ports'|'webPort'>>(game: T): T`; `ingressPorts(game: GameServerConfig): GameServerPort[]` (non-icmp-aware list of `ports` entries eligible for ingress; excludes `webPort`); `HTTPS_RESERVED_PORTS: readonly [80, 443]`; `GameServerConfig.webPort?: number`.

- [ ] **Step 1: Write failing tests** in `gameServerPorts.test.ts`: `normalizeGameServer` on legacy `[8080/tcp, 27015/udp]` returns `webPort 8080`, `ports [27015/udp]`; single port → `ports []`; already-normalised and non-https inputs returned unchanged; applying twice equals applying once.
- [ ] **Step 2: Run** `npx vitest run app/packages/shared/src/gameServerPorts.test.ts` — expect FAIL (module missing).
- [ ] **Step 3: Implement** `gameServerPorts.ts` and add `webPort?: number` with TSDoc to `GameServerConfig` (`gameServerConfig.ts`, next to `https`); export from `index.ts`. Mark the legacy shape deprecated: `normalizeGameServer` gets a TSDoc `@deprecated` modifier tag (last, per `tsdoc-tags.md`) and a comment naming the legacy shape (https game, no `webPort`, `ports[0]` is the upstream) and the removal condition; the `ports` and `https` field TSDoc on `GameServerConfig` says treating `ports[0]` as the upstream is deprecated. Keep comments brief per `comment-conciseness.md`; no task numbers or history.
- [ ] **Step 4: Write failing validator tests** in `gameServerValidator.test.ts` for each scenario in `specs/game-https-configuration/spec.md` (Foundry config valid; missing/443/80 `webPort`; `webPort` on non-https; empty `ports` ok; first extra udp ok; extra duplicating `webPort` rejected at `ports[N]`; healthCheck on `webPort` ok). Remove/adjust the old "no ports" and "first port udp" cases.
- [ ] **Step 5: Implement** in `gameServerValidator.ts`: new `checkWebPortRules`, rewrite `checkHttpsPortRules` (drop non-empty and `ports[0]`-tcp), include `webPort` in `checkPortCollisions` same-game check, `checkHealthCheckRules` accepts `webPort`.
- [ ] **Step 6: Run** `npm run app:test --workspace @hyveon/shared` (or repo `npm run app:test`) — expect PASS.
- [ ] **Step 7: Commit** `feat(shared): add explicit https webPort and port helpers`.

## Task 2: Normalise on read; drift, drafts, diagnostics (PR 1)

**Files:**
- Modify: `app/packages/desktop-main/src/services/DeploymentConfigService.ts` (+ tests `DeploymentConfigService.*.test.ts`), `DriftService.ts`, `GameWizardDraftService.ts` (backfill near `backfillPortVisibility`), `ElectronStoreService.ts` (draft port type), `diagnosticsBundleAllowlist.ts`

**Interfaces:**
- Consumes: `normalizeGameServer` from Task 1.

- [ ] **Step 1: Write failing tests**: `DeploymentConfigService` returns normalised games for a legacy fixture and leaves new-shape games identical; a read→save round trip persists `webPort` and shortened `ports`; `DriftService` reports no drift between a legacy and its normalised form; draft backfill normalises a legacy https draft; diagnostics allowlist records `webPort` presence without value changes elsewhere.
- [ ] **Step 2: Run** the touched test files — expect FAIL.
- [ ] **Step 3: Implement**: at each call site add a one-line comment that it exists only for the deprecated legacy shape, and emit `logger.debug` (game name only) when a game was actually normalised; apply `normalizeGameServer` to each game in the single `DeploymentConfigService` read path (not duplicated per caller); diff `DriftService` on normalised shape; extend draft backfill; allowlist `webPort`. Log per `logging.md` if a handler is touched.
- [ ] **Step 4: Run** `npm run app:test` and `npm run app:test:integration` — expect PASS; then `npm run app:lint` and `npm run app:typecheck`.
- [ ] **Step 5: Commit** `feat(desktop-main): normalise legacy https ports on read`; open PR 1 with `/pr` (title `feat(shared): explicit https web port and read-time normaliser`).

## Task 3: Infra — Caddy upstream, port mappings, ingress (PR 2, stacked on PR 1)

**Files:**
- Modify: `app/packages/infra/src/ecs.ts:213-251`, `securityGroups.ts:165-185,267-316`, `testing/fixtures.ts`, `ecs.test.ts`, `securityGroups.test.ts`, `efs.test.ts`

**Interfaces:**
- Consumes: `ingressPorts`, `GameServerConfig.webPort`.

- [ ] **Step 1: Write failing tests**: Caddy command contains `localhost:30000` for `webPort: 30000`; `portMappings` include `webPort` and extras; SG has `0.0.0.0/0` udp rule for an https extra and a VPC-CIDR rule for an internal https extra; no rule for `webPort`; healthCheck on `webPort` adds only the health-check Lambda source rule; two https games still yield one 443/80 pair.
- [ ] **Step 2: Run** `npx vitest run app/packages/infra` — expect FAIL.
- [ ] **Step 3: Implement**: `ecs.ts` uses `config.webPort` for `--to`; `dedupedGamePortsByVisibility` stops skipping https games and iterates `ingressPorts(game)`; update the `delta` fixture to `webPort: 8080, ports: []`.
- [ ] **Step 4: Run** infra tests — expect PASS.
- [ ] **Step 5: Commit** `feat(infra): proxy to webPort and ingress https extra ports`.

## Task 4: Connect surfaces — Discord `{port}` (PR 2)

**Files:**
- Modify: `app/packages/infra/src/lambdas.ts:298-309`, `app/packages/shared/src/formatStatus.ts:31`, lambda handlers `update-dns/src/handler.ts`, `followup/src/handler.ts` and their tests

**Interfaces:**
- Consumes: `GameServerConfig.https`; produces `GAME_PORTS` entry for https games (shape decided here: keep the existing map, but https games map to the string/marker `formatStatus` renders as the 443 URL; choose the minimal change that leaves non-https output byte-identical).

- [ ] **Step 1: Write failing tests**: `firstPortByGame` for an https game with `webPort: 30000` and a udp extra does not yield 30000 or the extra; `formatStatus` for that game renders `https://{game}.{zone}`; non-https output unchanged; icmp-first scenario from the existing spec still passes.
- [ ] **Step 2: Run** relevant tests — expect FAIL.
- [ ] **Step 3: Implement** per the Interfaces note; keep one shared helper rather than separate copies in lambdas and `formatStatus` (`duplication.md`).
- [ ] **Step 4: Run** `npm run app:test`, `app:lint`, `app:typecheck`, `app:test:integration` — expect PASS; note in PR body that normalising legacy configs exposes former `ports[1..]` publicly (release-note item).
- [ ] **Step 5: Commit** `fix(lambdas): show https URL as connect target`; open PR 2 with `/pr` (base = PR 1 branch).

## Task 5: Wizard Ports step (PR 3, stacked on PR 2)

**Files:**
- Modify: `app/packages/web/src/components/add-game-wizard/networking-step.component.tsx`, `wizard-form.utils.ts`, `review-step.component.tsx`, `edit-game-form/edit-game-form.component.tsx`, `pages/games.page.tsx`, `pages/game-detail.page.tsx`, matching `*.test.tsx`/`wizard-form.utils.test.ts`

**Interfaces:**
- Consumes: `GameServerConfig.webPort`, validator issues pathed at `webPort`.

- [ ] **Step 1: Write failing jsdom tests** (per `testing-conventions.md`): enabling HTTPS renders a labeled web-port field and an "additional ports (optional)" list; empty web port shows the error and disables save; entering 30000 clears it; disabling HTTPS removes the field and payload `webPort`; updated warning callout text; edit form pre-fills `webPort`; review step and detail page show web port separately from extras.
- [ ] **Step 2: Run** `npx vitest run app/packages/web` on those files — expect FAIL.
- [ ] **Step 3: Implement** the field, draft mapping in `wizard-form.utils.ts` (`https` mapping near lines 165/182/223/355/461), and display changes; strings stay hardcoded English like the rest.
- [ ] **Step 4: Update** `e2e/specs/games.spec.ts` and `e2e/screenshots/demo-data.ts` (palworld: `webPort` + UDP extras); run `npm run app:test`, `app:test:e2e`.
- [ ] **Step 5: Commit** `feat(web): dedicated web port field for https games`.

## Task 6: Docs, specs sync, audit (PR 3)

**Files:**
- Modify: `docs/docs/app/games.md:150-170`, `docs/docs/components/infra.md:247-251,283`, `docs/docs/architecture.md:70`, `docs/docs/setup.md:401-422`, `docs/docs/guides/user.md:72-73`, `docs/docs/intro.md:19`

- [ ] **Step 1: Run** the `write-docs` skill mapping the diff to pages; draft via `docs-writer`, review via the three `docs-*` evaluators; fix findings.
- [ ] **Step 2: Run** the `deployment-config-field-auditor` agent; fix any missing touchpoint it lists.
- [ ] **Step 3: Sync** delta specs with `/opsx:sync`; run `openspec validate https-explicit-web-port --strict`.
- [ ] **Step 4: Run** the full gate (`app:lint`, `app:typecheck`, `app:test`, `app:test:integration`, `app:test:e2e`) — expect exit 0.
- [ ] **Step 5: Commit** `docs: document https web port and migration`; open PR 3 with `/pr` (base = PR 2 branch).
