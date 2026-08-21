# Tech-debt audit — executive summary

Audit date: 2026-08-21, against `main` at `f5e16ab0`.
Five coordinators (one per area) fanned out ~30 read-only sub-agents; every finding in the per-area plans carries `file:line`, a proposed fix, an S/M/L effort guess, and a test-coverage note.
This file ranks the cross-area picture and fixes the execution order; the per-area files hold the detail.

| Plan | Area | Findings | PRs | Effort |
|---|---|---|---|---|
| [01-component-splitting.md](01-component-splitting.md) | Oversized React components | ~40 | 18 | 12–16 days |
| [02-doc-comments.md](02-doc-comments.md) | Doc-comment bloat and gaps | 180 rows (34 delete / 107 trim / 19 rewrite / 20 add) | 15 | 9–11 days |
| [03-duplication.md](03-duplication.md) | Duplicated / over-complex logic | 73 | 18 | 18–22 days |
| [04-instruction-drift.md](04-instruction-drift.md) | Agent-facing instruction drift | ~50 | 7 | 2–3 days |
| [05-docs-accuracy.md](05-docs-accuracy.md) | Docs-site and OpenSpec accuracy | 88 (19 of 23 pages stale) | 10 docs + 2 code | 4–5 days |
| [bugs-incidental.md](bugs-incidental.md) | Real bugs found along the way | see file | — | — |

**Total: ~70 PRs, roughly 45–57 engineer-days if everything is taken.** About a third of the raw occurrence count (the S-effort items in 02, 03, 04, 05) is reachable in the first ~5 days, which is where the plan below starts.

## What the audit says about the codebase

- **The code is in better shape than the words around it.** `tsdoc-tags.md` is ~99.9% satisfied repo-wide, every non-`ui/` web component has a co-located jsdom spec, all Playwright specs go through page objects, and three suspected duplication hot-spots (`infra/src/iam.ts`, resource tagging, the e2e harness structure) were checked and found clean. Don't re-audit those.
- **The authority document is itself a source of rot.** `CLAUDE.md` says "five Lambda packages" (there are six; two conditional), claims `canRun()` is imported by the desktop app (it isn't), says "no ACM certificate anywhere" (`discordDomain.ts:145` declares one), and names `mcp__github__*` tools the enabled plugin doesn't expose. Those errors have already been copied into `infra/src/lambdas.ts:1`, `lambdaFunctionKey.ts:2`, one OpenSpec spec, and four docs pages. Fix the root first (Phase 1), or the docs/comment PRs will re-propagate it.
- **One duplication shape dominates: "game variant + Lambda/infra variant written twice."** PR #538 fixed it inside `LogsService` but the same pair survives in `logs.controller.ts:152/283` and four ~80-line generators in `preload.ts`. Same shape across desktop-main services, the Lambdas, cloud-aws, and the two log pages (01 finding C1–C3, 03 findings 17/18/34).
- **Comment debt is conciseness debt, not syntax debt.** 25.4% of the TS tree is comment; the mass is history narration (197 lines), issue/PR refs (174), Terraform HCL citations pointing at a deleted tree (249), ASCII banners (234), and a 402-line TSDoc block on `PulumiService.apply()`. Meanwhile the six `AWS_REGION_` reads and the Caddy sidecar block carry zero explanation of the invariants they embody.
- **Nothing machine-enforces any of it.** `app/eslint.config.js` has no `max-lines`, `complexity`, `jsdoc/sort-tags`, `jsdoc/check-tag-names`, or duplicate-detection rule; no CI job reads `CLAUDE.md`, `.claude/**`, or `docs/docs/**` for dead paths/commands. Review pressure is also uneven: across 132 relevant PRs no reviewer ever flagged an oversized `.tsx`, and `fix:` PRs update docs 1/6 of the time vs 7/7 for `feat:`.

## Top 10 findings (impact × ease)

| # | Finding | Where | Effort | Why it ranks here |
|---|---|---|---|---|
| 1 | `/pr` and `CLAUDE.md` reference `mcp__github__resolve_review_thread` / `create_pull_request`, which don't exist under the enabled plugin; `gh-stack-prs` tells agents to run a `git worktree add` a hook denies unconditionally; both `/openspec-review-*` commands omit `Workflow`/`Edit` from `allowed-tools` | 04 A1–A3, A15, B9 | S (<1h) | The mandatory PR path is broken as written; fix is four file edits |
| 2 | Packaged app omits `lambda/health-check/dist` (`electron-builder.yml:224-235`) — apply fails for any game with a health check | 05 bug 1 / bugs-incidental | S | Release blocker, same class as PR #465 |
| 3 | Lambda count (5 → 6) and three wrong invariants in `CLAUDE.md`, propagated to 9 docs/spec/comment sites | 04 A4–A6, 05 findings 1–8/13–16, 02 rule 7 | S | Root of the enumeration rot; one PR fixes all sites |
| 4 | `err instanceof Error ? err.message : String(err)` × 189 with no helper (four private `errMessage` re-implementations already exist) | 03 finding 1, PR 9–10 | M | Largest single mechanical duplication; `logging.md` already mandates the pattern |
| 5 | PR #538 left the game/Lambda log-stream pairing intact in `logs.controller.ts` and `preload.ts` | 03 findings 17/18/34, PR 16–17 | S–M | The exact pattern the owner already asked to remove |
| 6 | `web/src/api.service.ts` hand-copies 24 types from `@hyveon/shared` ("keep this copy in sync"), ~430 of 742 lines; `hyveon-api.ts` is a third copy | 03 finding 30–31, PR 15 | M | Type drift risk in a package that already depends on shared |
| 7 | Invariants with no comment at their site: six `AWS_REGION_` reads, Caddy sidecar (`infra/src/ecs.ts:189-207`), `canRun.ts:15` never-fork, raw NUL separator at `wizard-form.utils.ts:555` | 02 PR 14–15 | S | ~20 one-to-four-line additions; the only comment PR whose absence causes outages |
| 8 | Three completed OpenSpec changes never synced/archived → `game-health-checks` and `release-automation` have no spec; 5 more specs stale | 05 findings 74–88, PR 9–10 | M | Spec tree is the declared source of truth and is silently wrong |
| 9 | Existing helpers simply unused: `resolveDefaultAwsRegion` (rewritten 9×), `sleep()`, `launchElectron()` (bypassed 15×), `ui/select` (10 raw `<select>`), `test-mock-registry.ts` (documented seam, 60 hand-rolled stubs) | 03 findings 3, 33, 46, 59, 65; 01 A8 | S each | Pure adoption, no new code |
| 10 | No `FormField`/`InlineAlert`/`PageHeader` primitives — 21 label+input+error triads, 15 identical `role="alert"` paragraphs, 10 page headers; `logs.page.tsx` and `infrastructure-logs.page.tsx` share ~110 of 217 lines | 01 A1–A10, C1–C3, PR 1–2, 9 | M | Unblocks every later component split and fixes 5 broken `aria-describedby` wirings structurally |

Close behind: `iac.page.tsx` triplicated run-submission state machine (01 C4, `useIacRun`, L — also fixes two latent bugs); `PulumiService.ts` 402/283/206-line TSDoc memos (02 A-1…A-14, L); the seven `PulumiService.*.test.ts` files each redefining ten `makeX()` factories (03 finding 61, ~1200 lines).

## Cross-area overlaps — resolved here so the plans don't collide

| Overlap | Owner | Others defer |
|---|---|---|
| Lambda count / CLAUDE.md invariant fixes | One PR: `docs: correct lambda count and stale invariants` (05 PR 1–2 scope, plus `CLAUDE.md`, `infra/src/lambdas.ts:1`, `lambdaFunctionKey.ts:2`, `lambda-runtime-currency` spec) | 02 rule 7, 04 A4–A6 |
| `formatTimestamp` / `formatUsd` duplicated in 4 web files | 03 PR 8 | 01 PR 2 (A7), 02 PR 13 (C-18) |
| `api.service.ts` type copies | 03 PR 15 | 02 C-6 (comment half only) |
| Reference-checker script (paths, commands, package names, anchors, counts, IPC channel names) | One script `scripts/check-references.mjs` covering 04 §3 **and** 05 rule 2, wired into `lint.yml` + `docs-build.yml` | 04 PR 7, 05 rule 2 |
| "Check for an existing primitive/helper before writing one" | One clause in `typescript-conventions.md` | 01 rule 2, 03 rule 2 |
| `docs/docs/components/integration-tests.md` documents `test-mock-registry.ts` as the mock seam nobody uses | 03 PR (adopt the seam) **first**, then 05 PR 6 (refresh the page) — don't document the current state | — |
| `infra/src/*` comments duplicating `docs/docs/components/infra.md` | 02 PR 9 (collapse to pointers), then re-run `docs-accuracy-auditor` on infra.md | 05 |
| CodeRabbit PR #514 "use `renderPage()` everywhere" | Wrong (03 §Summary); add the scope clause to `testing-conventions.md` so it isn't re-raised | — |

## Proposed PR-stack order

Six phases. Phases run mostly in parallel tracks once Phase 1 lands; within a phase, follow each plan's dependency table. Every PR passes `npm run app:lint`, `app:typecheck`, `app:test` with exit 0; e2e/integration gates are listed per PR in the area plans.

**Phase 0 — standalone bug fixes (1 day).** From `bugs-incidental.md` "fix soon": health-check Lambda bundle omission; Discord Client-ID wipe; `mountedRef` StrictMode re-arm in two forms; `iam:SimulatePrincipalPolicy` grant; corrupted TSDoc at `PulumiService.ts:791`; NUL byte separator. Own `fix(...)` PRs, no dependencies.

**Phase 1 — make the authority documents true (1–2 days).** 04 PR 1 (broken tool names/commands) → 04 PR 2 + 05 PR 1–3 merged (Lambda count, invariants, script chains) → 04 PR 3–4 (prerequisites, precedence rule, routing). Do this before any comment or docs PR, or they will copy the wrong facts.

**Phase 2 — cheap mechanical wins (4–5 days, parallel tracks).**
Track A (code): 03 PR 1–8 (existing-helper adoption, S each) → 03 PR 9–10 (`errMessage`) → 03 PR 15 (api.service types) → 03 PR 16–17 (PR #538 completion).
Track B (comments): 02 wave 1 (PR 1–4 sweeps) → 02 wave 2 (PR 5–8 history/issue refs) → 02 PR 14–15 (invariant `add`s — land these before wave 3 so nothing deletes them).
Track C (OpenSpec): 05 PR 9 (sync) → 05 PR 10 (archive + stale specs).

**Phase 3 — docs pages (3–4 days).** 05 PR 4–7 through `write-docs`, then 05 PR 8 (screenshot regeneration) last — after Phase 4's layout splits if those are imminent, otherwise now.

**Phase 4 — component primitives and splits (12–16 days).** 01 PR 1–4 (primitives, additive) → PR 9 (`LogTailView`) and PR 8 (app-layout) → PR 10–12 (IaC) → PR 5–7 (wizard; add the missing `games.spec.ts` wizard e2e first) → PR 13–14 (Discord) → PR 15–17 (first-run wizard; fix the positional `input[readonly]` locator first) → PR 18. Every PR needs `app:test:e2e`.

**Phase 5 — deeper dedup and comment trims (10–14 days).** 03 PR 11–14 (shared Lambda/ECS helpers, cached-client wrapper), 03 PR 18 + test-scaffold cleanups (finding 61 early), 02 wave 3 (PR 9–13 trims/rewrites), then the deferred `PulumiService`/`iac.controller` internals.

**Phase 6 — lock it in (2 days).** Rules PR (below) + `scripts/check-references.mjs` + ESLint additions, landing last so they are green on arrival.

## Rules to add or update (consolidated)

The five plans propose overlapping rule changes; this is the merged set. Full text for each lives in the area plan cited.

| File | Change | Source |
|---|---|---|
| `CLAUDE.md` | Fix Lambda count, `canRun()` claim, ACM claim, `app:build` order, MCP tool names; add a "Precedence" paragraph (CLAUDE.md invariants > rules > skills > copilot-instructions); add routing rows for the 5 unrouted rules, 4 skills, 2 agents, hooks, e2e location, lambda build, graphify; add the `@hyveon/shared` barrel-hygiene invariant; extend "docs in same PR" to `fix:` PRs explicitly | 04 A/B/C, 03 rule 4, 05 rule 4 |
| `.claude/rules/instruction-files.md` (new, always-loaded) | Ownership table + "if you changed X, also update Y" triggers (scripts, packages, hooks, agents/skills, docs pages, MCP plugins, CI commands) + the enumeration rule (grep for the old count word repo-wide) + "`.claude/skills/openspec-*` / `commands/opsx/*` are generated, never hand-edit" | 04 §convention, 05 rule 1 (fold `docs-enumerations.md` in here rather than a third file) |
| `.claude/rules/duplication.md` (new) | "The second copy is the review gate" — ≥3 occurrences or ≥2 non-trivial → extract before opening the PR; extract at every layer the pair crosses; a "keep in sync with X" comment is a bug report | 03 rule 1 |
| `.claude/rules/typescript-conventions.md` | Component size (~200 lines / ~8 hooks → split; hook first, then child components); check for an existing helper/primitive before writing one (third copy → extract); `mountedRef` must re-arm under StrictMode | 01 rules 1–2, 03 rules 2, 5 |
| `.claude/rules/testing-conventions.md` | Semantic Playwright locators only; refactor DOM-parity gate (roles/headings/testids byte-identical, run e2e); fixtures over per-spec scaffolding, builder required for no-optional-field types; `renderPage()` is routed-page-only | 01 rules 3–4, 03 rule 3 |
| `.claude/rules/comment-conciseness.md` | Rule 6 "no archaeology" (no issue/PR/phase numbers, no "previously/renamed from", no refs to deleted trees); rule 7 "one canonical explanation per constraint, link from the rest" | 02 rules 5–6 |
| `.claude/rules/pr-stacking.md` / `worktree.md` | Reconcile one-worktree-per-group vs `gh stack` single-worktree override; state that `guard-git-worktree-add-path` blocks every direct `git worktree add` | 04 rules 3–4 |
| `.claude/rules/spec-driven-development.md` | Exit gate: a change with all tasks checked and code merged must be synced + archived before the next change in that capability area | 05 rule 5 |
| `write-docs` skill / `docs-screenshot-capture` spec | Screenshot freshness: PRs touching `web/src/pages/**` or `app-layout` re-run `docs:screenshots` or state why not | 05 rule 3 |
| `app/eslint.config.js` | `jsdoc/sort-tags`, `jsdoc/check-tag-names` (allowlist), `jsdoc/require-description` (with 02 PR 12), `jsdoc/informative-docs` as `warn`; `max-lines-per-function` `warn` 250 on `**/*.tsx` | 02 rules 1–4, 01 rule 5 |
| `scripts/check-references.mjs` + CI | Paths, `npm run` tokens, `@hyveon/*` names, markdown anchors, hook wiring, hand-listed counts, `/img/**` assets, IPC-channel tokens vs `@MessagePattern` — across `CLAUDE.md`, `.claude/**`, `CONTRIBUTING.md`, `README.md`, `docs/docs/**` | 04 §3, 05 rule 2 |
| `CONTRIBUTING.md` | `claude` as a recognised commit scope so `git log --grep '(claude)'` is the instruction-files changelog | 04 rule 5 |

## Recommended first step

Execute **Phase 0 + Phase 1** as one stack this week (~2–3 days, 8–10 small PRs): the bug fixes have user-visible consequences, and the CLAUDE.md/instruction corrections are prerequisites for everything else — every later comment, docs, and OpenSpec PR otherwise risks re-copying the wrong Lambda count and the wrong tool names.
Then start Phase 2 Track A (03 PR 1–10): the `errMessage` and existing-helper adoptions are the best value-per-hour in the whole audit and touch files the component work in Phase 4 will later want clean.

## Method

Lead: Fable (this file, overlap resolution, ordering). Coordinators: Opus, one per area, each fanning out 4–8 sub-agents — Sonnet for mechanical sweeps (inventories, line counts, path/command existence, comment-pattern scans), Opus for judgment (is this worth extracting, is this claim true), and the repo's own `docs-accuracy-auditor` / `docs-coverage-auditor` agents for every docs page.
All agents were read-only; the only files created are the ones in this directory.
Not covered: `docs/superpowers/**` disposition (flagged in 04 B10, needs an owner decision), `PulumiService.ts` internal decomposition beyond comments (03 deferred 19/21/22 — needs its own design pass), and a performance/bundle-size audit (out of scope).
