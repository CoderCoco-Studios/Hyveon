# 04 — Agent-facing instruction drift

## Summary

The repo's agent-facing instruction surface is roughly 4,900 hand-written lines (`CLAUDE.md`, 8 `.claude/rules/*.md`, 6 skills, 6 agents, 3 commands, `.github/copilot-instructions.md`, `README.md`, `CONTRIBUTING.md`) plus about 9,600 lines of generated OpenSpec workflow text mirrored four ways.
The dominant pattern is *silent factual drift*: counts, build orders, workspace names, and MCP tool names that were true when written and were never re-checked, because nothing in lint or CI reads these files.
Four of those stale facts are functional, not cosmetic — `CLAUDE.md` and `/pr` name `mcp__github__*` tools the currently-enabled GitHub plugin does not expose (`mcp__plugin_github_github__*`), the `gh-stack-prs` skill's primary command is one a hook denies unconditionally, and both `/openspec-review-*` commands declare `allowed-tools` that exclude the tools their own steps call.
The secondary pattern is *unrouted guidance*: five of the eight rule files, all four non-OpenSpec skills, and both non-docs agents are absent from `CLAUDE.md`'s "Where to look" table, while four global CLI prerequisites (`bun`, `openspec`, `graphify`, `gh`) that the hooks and skills hard-depend on are documented nowhere at all.
Total effort across all findings is roughly 2–3 days, split into 7 PRs; the first (the four functional breaks) is under an hour and carries the most value per minute.

## Findings

### A. Stale facts — claims that no longer match the code

| # | Location (file:line) | Issue | Proposed fix | Effort | Risk / test coverage |
|---|---|---|---|---|---|
| A1 | `CLAUDE.md:176` | "resolved via `mcp__github__resolve_review_thread`" | No such tool exists. The enabled plugin (`github@claude-plugins-official`, `.claude/settings.json:9`) exposes `mcp__plugin_github_github__*` and has no `resolve_review_thread` at all. Replace with the real mechanism (`mcp__plugin_github_github__pull_request_review_write` / `add_reply_to_pull_request_comment`), or state plainly that resolution is done in the GitHub UI. | S | None. No test reads `CLAUDE.md`. Verify by name-matching against the plugin's tool list. |
| A2 | `.claude/commands/pr.md:30` | "**Create the PR** using `mcp__github__create_pull_request`" | Rename to `mcp__plugin_github_github__create_pull_request`. `CLAUDE.md:158` mandates `/pr` as the only PR path, so this stale name breaks the mandated workflow. | S | None. Manual: run `/pr` on a throwaway branch. |
| A3 | `.claude/commands/pr.md:33` | "Base branch: `main`" — hardcoded | Contradicts `.claude/rules/pr-stacking.md:13` (`gh pr create --base <previous-branch>`; only the first PR bases on `main`). Add a step: detect a stacked branch and ask for / derive the base. | M | None. Covered only by the stacking rule's prose. |
| A4 | `CLAUDE.md:15` | "The five Lambda packages (four always-on, one conditional)" | Six packages exist (`efs-seeder`, `followup`, `health-check`, `interactions`, `update-dns`, `watchdog`). Four always-on; **two** conditional — `efs-seeder` per game with `file_seeds` (`app/packages/infra/src/lambdas.ts:223`) and `health-check` when a game declares `healthCheck` (`lambdas.ts:228`). | S | None. Verify with `ls app/packages/lambda`. |
| A5 | `CLAUDE.md:39` | "and five Lambda packages under `app/packages/lambda/*`" | Same correction as A4. | S | Same. |
| A6 | `CLAUDE.md:52` | "`npm run app:build:lambdas` # bundle all five Lambda packages" | The script bundles six (`app/package.json` `build:lambdas` lists all six `-w @hyveon/lambda-*`). | S | Same. |
| A7 | `CLAUDE.md:46` | "`npm run app:build` # compile shared → cloud-aws → desktop-main → preload → web" | Actual order is `shared → infra → cloud-aws → desktop-main → desktop-preload → web` (`app/package.json` `build`). `@hyveon/infra` is missing from the documented chain; `CONTRIBUTING.md:57` already has it right. | S | None. Verify against `app/package.json`. |
| A8 | `.github/copilot-instructions.md:71` | "**Framework**: Nest.js (on `@nestjs/platform-express`)" | `@nestjs/platform-express` is not a dependency anywhere; `desktop-main` depends on `@nestjs/microservices` (`app/packages/desktop-main/package.json:30`). This also contradicts `CLAUDE.md:101` ("The desktop app has no HTTP transport"). Replace with "Nest.js as an Electron IPC microservice (`@nestjs/microservices`)". | S | None. Grep for `platform-express` returns nothing. |
| A9 | `CONTRIBUTING.md:87` | "`[CLAUDE.md](./CLAUDE.md#code--test-conventions)` — read that for … test naming, TSDoc style, and the no-`as unknown as T` rule" | Dead anchor. `CLAUDE.md` has no such heading (its headings are Where to look / Commands / Invariants / Markdown formatting / Before opening a PR / Git & PR workflow / PR review workflow / graphify). Those conventions now live in `.claude/rules/typescript-conventions.md`, `testing-conventions.md`, `tsdoc-tags.md`. Point at the rule files. | S | None. |
| A10 | `CONTRIBUTING.md:54`, `:56`, `:72`, `:74` | "not the scripts workspace", "over web, every Lambda, and scripts" | There is no `scripts` workspace. Root `package.json` `workspaces` is `["app", "app/packages/*", "app/packages/desktop-preload", "app/packages/lambda/*"]`. Delete the four references. | S | None. |
| A11 | `README.md:50` | "**Lambdas** — interactions, followup, update-dns, watchdog" | Omits `efs-seeder` and `health-check`. | S | None. |
| A12 | `README.md:120-125` | Repository-structure tree lists 5 lambda dirs | Omits `health-check/`. The tree also omits `.claude/` and `openspec/` entirely, which is where every workflow rule lives. | S | None. |
| A13 | `.claude/rules/worktree.md:3` | "Hooks enforce isolation, `.claude/worktrees/` paths, and `main` sync (`…guard-git-worktree-add-path.ts`…)" | Mischaracterises the hook. `guard-git-worktree-add-path.ts:44-56,94` denies **every** `git worktree add` regardless of target path ("even when the target path is under .claude/worktrees/", `:6`). An agent reading the rule may assume an in-tree path is permitted; it is not. Reword to "blocks all direct `git worktree add`". | S | None. Hook has no test. |
| A14 | `.claude/skills/write-docs/SKILL.md:24` | "Code comments / TSDoc \| ordinary editing — see the conventions in `CLAUDE.md`" | Same dead pointer as A9 — those conventions moved to `.claude/rules/tsdoc-tags.md` and `comment-conciseness.md`. | S | None. |
| A15 | `.claude/skills/gh-stack-prs/SKILL.md:11`, `:39`, `:40` | "`git worktree add -b <branch> .worktrees/<name> <base-branch>`", "`git worktree add --detach .worktrees/<stack-name> main`", "`cd .worktrees/<stack-name>`" | Wrong path prefix. The enforced convention is `.claude/worktrees/` (`guard-enter-worktree-path.ts:68-72` denies anything else). Three occurrences. | S | None. Reproduced in `openspec/changes/archive/2026-08-06-remove-cost-explorer-calls/retrospective.md:106` ("required creating and discarding one wrong worktree first"). |
| A16 | `.claude/skills/honest-pr-review/SKILL.md:25` | "\| An AI service to review the PR and post its own findings \| `/code-review` (CodeRabbit) \|" | `/code-review` is the `code-review@claude-plugins-official` plugin (enabled at `.claude/settings.json:11`), not CodeRabbit. CodeRabbit is the `@coderabbitai` GitHub bot configured by `.coderabbit.yaml`. The routing table sends the reader to the wrong tool. | S | None. |
| A17 | `CLAUDE.md:184` | "If `graphify-out/wiki/index.md` exists, use it for broad navigation instead of raw source browsing." | The file does not exist. The conditional makes it harmless, but the instruction is dead weight in an always-loaded file. | S | None. |
| A18 | `.claude/agents/docs-accuracy-auditor.md:28` | Uses `("the five Lambdas")` as its worked example of a rot-prone count | The example is itself the stale count this audit is fixing (A4–A6). Change to a neutral example once A4–A6 land, or the agent teaches the wrong number. | S | None. |
| A19 | `openspec/schemas/superpowers-bridge/README.md:413`, `:490-491`, `:220` | "`bash scripts/install-git-hooks.sh`"; links to `.github/workflows/validate-schemas.yml` and `version-check.yml`; "PLANNING — 7 artifacts" | None of those three files exist in this repo; the mermaid subgraph labelled "7 artifacts" enumerates 6 nodes. This is **vendored upstream** content (`JiangWay/openspec-schemas`) that assumes files the adopting repo never added. | Add a one-line "vendored — upstream references may not resolve in this repo" banner at the top rather than editing vendored text. | S | None. |
| A20 | `.claude/settings.json:21,31,36,46,56,61,91` (hook commands) | All six hooks run via `bun run .claude/hooks/*.ts`, but **`bun` is documented nowhere** — not in `README.md`, `CONTRIBUTING.md`, `CLAUDE.md`, `docs/docs/guides/maintainer.md`, or any CI workflow. Same for the `openspec` CLI (required by all 12 generated skills' `allowed-tools: Bash(openspec:*)`), `graphify`, and `gh`/`gh stack`. On a fresh clone every worktree guard silently fails to run. | Add a "Toolchain prerequisites" block to `CONTRIBUTING.md` (and a routing row in `CLAUDE.md`) listing `bun`, `openspec`, `graphify`, `gh` + `gh stack`, with install commands. | M | None. Reproduce by unsetting `bun` from `PATH` and calling `EnterWorktree`. |

### B. Contradictions and missing precedence

| # | Location (file:line) | Issue | Proposed fix | Effort | Risk / test coverage |
|---|---|---|---|---|---|
| B1 | Repo-wide | **No precedence rule exists.** Nothing in `CLAUDE.md`, `.claude/rules/*`, or any skill states which file wins when two conflict. Every contradiction below is therefore unresolvable by an agent reading in good faith. | Add a short "Precedence" paragraph at the top of `CLAUDE.md`: CLAUDE.md invariants > `.claude/rules/*` > skills > `.github/copilot-instructions.md` (which targets a different consumer and is allowed to restate). | S | None. |
| B2 | `.claude/rules/pr-stacking.md:12` vs `.claude/skills/gh-stack-prs/SKILL.md:18-35` | Rule: "One worktree + branch per group … for hop 2+, ask the user to run `git worktree add …` themselves". Skill: "create **one** worktree for the entire stack … this is the one place this skill deliberately overrides pr-stacking.md". The skill declares the override; the rule has no forward pointer, so an agent that reads only the rule creates N worktrees and then cannot run `gh stack sync`. | Add one line to `pr-stacking.md:12`: "If using `gh stack`, follow the single-worktree override in `.claude/skills/gh-stack-prs/SKILL.md` instead." | S | None. |
| B3 | `.claude/skills/gh-stack-prs/SKILL.md:29` | "satisfies `~/.claude/rules/git.md`'s 'never edit on `main`' requirement" | A checked-in skill cites a **user-private, out-of-repo** path. Any other contributor's agent cannot resolve it. Cite `CLAUDE.md:152` ("`main` is protected — direct pushes are blocked") instead. | S | None. |
| B4 | `.claude/commands/pr.md` (whole file) vs `.claude/commands/opsx/*.md` | `pr.md` has **no frontmatter at all** — no `description`, no `allowed-tools`, no `name` — while all 11 `opsx/*.md` commands declare `name`, `description`, `allowed-tools`, `category`, `tags`. Inconsistent shape for the same asset kind. | Add frontmatter to `pr.md` matching the opsx shape. | S | None. |
| B5 | `CLAUDE.md:126` vs `.github/workflows/test.yml:48` | Gate step 3 is `npm run app:test`; CI runs `npm run app:test:coverage`. `CONTRIBUTING.md:60-62` documents the difference, `CLAUDE.md` does not. | Note the substitution in `CLAUDE.md`'s gate, or drop the note from `CONTRIBUTING.md` once it links to `CLAUDE.md`. | S | CI is the check. |
| B6 | `CONTRIBUTING.md:53-58` vs `CLAUDE.md:124-128` | Two different pre-PR gates. `CONTRIBUTING.md` lists four commands (lint, typecheck, test, **build**) and omits `app:test:integration` and `app:test:e2e` entirely; `CLAUDE.md` lists five and omits `app:build`. Both claim to be "the local checks before opening a PR". | Make `CLAUDE.md:119-128` the single home; replace `CONTRIBUTING.md`'s block with a pointer plus the CI-runs-coverage note. | S | Divergence is caught by CI only for the steps CI runs; `e2e`/`integration` are conditional and would be silently skipped. |
| B7 | `.github/copilot-instructions.md:87-99` | A second "Commit Structure" section restates the Conventional Commits format already given at `:25-42`, and adds a `<body>` requirement that contradicts `CONTRIBUTING.md:42` ("Individual commits within a PR don't need to be Conventional Commits"). | Delete `:87-99` outright — it duplicates the file's own earlier section and conflicts with the squash-merge policy. | S | None. |
| B8 | `.claude/rules/spec-driven-development.md:14-21` vs `openspec/schemas/superpowers-bridge/README.md:149-161` | Two independently-maintained "when NOT to use opsx" tables covering the same scenario set at different granularity, even though `spec-driven-development.md:3` says the README is authoritative and "below is routing only". | Collapse the rule's table to a pointer at the README's table; keep only the entry-routing table, which is genuinely repo-local. | S | None. |
| B9 | `.claude/skills/gh-stack-prs/SKILL.md:39` vs `.claude/hooks/guard-git-worktree-add-path.ts:94-99` | Skill's primary instruction is "`git worktree add --detach .worktrees/<stack-name> main`". The hook **unconditionally denies** every direct `git worktree add` via Bash. The skill's own fallback at `:49` ("`EnterWorktree` with a `name` also works here") is the only path that actually runs. | Replace the bash block with `EnterWorktree` + `name`, and delete the `--detach` rationale (`EnterWorktree` cannot detach, and the stack doesn't need it). | S | None. Already burned a session — `openspec/changes/archive/2026-08-06-remove-cost-explorer-calls/retrospective.md:106`. |
| B10 | `.claude/hooks/guard-superpowers-paths.ts:18` vs `docs/superpowers/**` | The hook blocks all writes matching `docs/superpowers/(specs\|plans)/`, but those directories contain 11 committed legacy files (`docs/superpowers/specs/2026-05-10-electron-desktop-pivot-design.md`, `docs/superpowers/plans/bootstrap-1..8-*.md`, `bump-lambda-runtime-nodejs24.md`). They can be read but never corrected, and nothing routes to them. | Decide explicitly: either move them under `openspec/changes/archive/` (consistent with the routing rule) or add a `docs/superpowers/README.md` marking them frozen-historical, and note the exemption in the rule. | M | None. |

### C. Routing gaps in CLAUDE.md

| # | Location (file:line) | Issue | Proposed fix | Effort | Risk / test coverage |
|---|---|---|---|---|---|
| C1 | `CLAUDE.md:10-28` | The "Where to look" table routes only 3 of 8 rule files (`typescript-conventions`, `testing-conventions`, `comment-conciseness`). Unrouted: `logging.md`, `pr-stacking.md`, `spec-driven-development.md`, `tsdoc-tags.md`, `worktree.md`. Two of those (`pr-stacking`, `worktree`) are referenced from prose at `:154`; three are not referenced anywhere in `CLAUDE.md`. | Add a row per unrouted rule. | S | None. |
| C2 | `CLAUDE.md:114-117` | "TypeScript coding conventions live in … `.claude/rules/testing-conventions.md` — both auto-load by file-glob scope" — describes only the glob mechanism. In fact only three rules declare `paths:` frontmatter (`comment-conciseness.md:1-3`, `testing-conventions.md:1-6`, `typescript-conventions.md:1-3`); the other five have none and therefore load into **every** session, including docs-only ones (93 lines of always-on context). | Add `paths:` frontmatter to `logging.md` (`app/packages/desktop-main/**/*.ts`) and `tsdoc-tags.md` (`**/*.{ts,tsx}`), and state the two-mode behaviour in `CLAUDE.md`. | S | None. Measurable by which rules appear in a fresh session's injected context. |
| C3 | `CLAUDE.md:10-28` | No routing row for: where e2e/integration tests live (`app/packages/web/e2e` — the only such directory in the repo), `.claude/hooks/`, release automation (`.github/workflows/release.yml`, `cliff.toml`, `electron-builder.yml`), or the Lambda build. | Add four rows. | S | None. |
| C4 | `CLAUDE.md:43-64` | Commands block omits two root scripts that exist: `aws-regions:generate` and `docs:screenshots`. `docs:screenshots` is actively referenced by `.claude/skills/write-docs/SKILL.md:140` and `.claude/agents/docs-writer.md:57`, so an agent is told to run a command the Commands table never lists. | Add both rows. | S | None. |
| C5 | `CLAUDE.md:10-33` | No routing for four skills (`gh-stack-prs`, `honest-pr-review`, `coderabbit-rate-limit-retry`, `scan-vocabulary`) or two agents (`deployment-config-field-auditor`, `discord-iam-reviewer`). These fire only on description-match, so they are effectively invisible when the description does not hit. `gh-stack-prs` in particular exists *because of* `pr-stacking.md`, which never names it. | Add a "Workflow helpers" sub-table listing each skill/agent with its trigger. | S | None. |
| C6 | `.claude/CLAUDE.md:1-3` vs `CLAUDE.md:178-186` | Two CLAUDE.md files both assert graphify routing, with different content — the nested one says "before doing anything else", the root one gives usage policy. Confusing provenance, and it duplicates the trigger already in the skill's own `description`. | Fold the nested file's one useful line into `CLAUDE.md:178-186` and delete `.claude/CLAUDE.md`. | S | None. |
| C7 | — | Superseded by E7 (five unowned docs pages, listed there). | — | — | — |

### D. Duplication

| # | Location | Issue | Proposed fix | Effort | Risk / test coverage |
|---|---|---|---|---|---|
| D1 | `.claude/skills/openspec-*` (2,472 lines) · `.github/skills/openspec-*` (2,472) · `.claude/commands/opsx/*` (2,360) · `.github/prompts/opsx-*` (2,312) | ~9,600 lines of the same OpenSpec workflow text mirrored four ways. **These are generated**, not hand-written — `generatedBy: "1.7.0"` in each frontmatter, last regenerated in `8d32ff56`/`285a3519`. Nothing anywhere says so, so the natural response to drift is to hand-edit one copy. | Add a routing note in `CLAUDE.md`: these four trees are generated by `openspec update` (CLI 1.7.0) — never hand-edit; regenerate. Separately, decide whether the `.github/` mirror (4,784 lines) is still needed — it exists for GitHub Copilot, and nothing in this repo's workflow uses Copilot for opsx. | S (note) / M (drop mirror) | None. Regeneration is the check. |
| D2 | `CLAUDE.md:159-162` · `CONTRIBUTING.md:6-38` · `.github/copilot-instructions.md:25-42` and `:87-99` · `.claude/commands/pr.md:16-24` · `.claude/skills/gh-stack-prs/SKILL.md:108-112` | The Conventional Commits rule is stated five times (six counting B7's duplicate). All agree on the type list and regex today. | Keep `CLAUDE.md:159-162` as the home. `pr.md` and `gh-stack-prs` legitimately need the regex inline (they execute it); `CONTRIBUTING.md` and `copilot-instructions.md` should keep the examples (human/Copilot audiences) but cite `CLAUDE.md` as the source. Delete `copilot-instructions.md:87-99`. | S | None. |
| D3 | `CLAUDE.md:74-102` · `.github/copilot-instructions.md:78-81` · `.claude/agents/discord-iam-reviewer.md:7-33` | The architectural invariants are restated in three places. | **Not debt** — flagged so it is not "fixed" later. `copilot-instructions.md` and the agent both run in isolated contexts with no access to `CLAUDE.md`, so restating is required. Add a comment in each pointing at `CLAUDE.md:74-102` as the source to keep in sync. | S | None. |

### E. Skills, agents, and commands — supersession and shape

| # | Location (file:line) | Issue | Proposed fix | Effort | Risk / test coverage |
|---|---|---|---|---|---|
| E1 | `.claude/skills/openspec-*` (12 dirs, 2,472 lines) vs `.claude/commands/opsx/*` (11 files, 2,360 lines) | The same OpenSpec workflow is advertised to the model **twice, simultaneously** — `openspec-propose` and `opsx:propose` both appear in the skill list with indistinguishable descriptions. Bodies are near-identical: `openspec-onboard` vs `opsx/onboard.md` is 520 lines with **zero** differing body lines; `sync` differs by 2, `verify` by 2, `apply` by 8, `propose` by 6. Nothing routes to the skill form — `.claude/rules/spec-driven-development.md` and `CLAUDE.md:30-33` name only `/opsx:*`. | Delete the 12 `.claude/skills/openspec-*` dirs; keep `.claude/commands/opsx/`. Because both are generated, also pin the generator config so `openspec update` does not re-emit the skill surface — otherwise the deletion regresses on the next update. Confirm that before deleting. | S (delete) + S (pin) | None. Verify by re-running `openspec update` and checking the dirs stay gone. |
| E2 | `.claude/commands/openspec-review-implementation.md:4` and `openspec-review-proposal.md:4` | `allowed-tools: Bash(gh pr view:*), … Bash(git log:*)` — but step 3 says "Call the `Workflow` tool" (`:32` / `:33`) and the `--fix` branch says "apply every `CONFIRMED` finding … with the Edit tool" (`:35` / `:36`). Neither `Workflow` nor `Edit` is in `allowed-tools`, so both commands are declared unable to do their own documented steps. | Add `Workflow` and `Edit` to both `allowed-tools` lists. | S | None. Manual: run `/openspec-review-proposal` on any open PR. |
| E3 | `.claude/agents/deployment-config-field-auditor.md:9-12` vs `.claude/agents/docs-coverage-auditor.md:48-54` | The dedicated auditor's entire four-item checklist (type in `@hyveon/shared` → `defineX()` consumer → add/edit-game wizard → `docs/docs/components/infra.md`) is already restated inside the coverage auditor, and both cite `CLAUDE.md:139-148` as the source. The dedicated agent has zero inbound references repo-wide. Its rationale is also gone: `CLAUDE.md:139-141` says "there is no five-file checklist any more". | Delete `deployment-config-field-auditor.md`; `docs-coverage-auditor` already covers it. | S | None. |
| E4 | `.claude/agents/discord-iam-reviewer.md:1-4`, `deployment-config-field-auditor.md:1-4` | Neither declares `model:`, so both inherit the caller's tier unpredictably. The four `docs-*` agents all pin one (`docs-accuracy-auditor.md:5` `model: opus`, `docs-style-reviewer.md:5` `model: sonnet`). | Add `model: opus` to `discord-iam-reviewer` (security reasoning). Moot for the config auditor if E3 lands. | S | None. |
| E5 | `.claude/skills/*/SKILL.md` frontmatter | Five different shapes across the six non-OpenSpec skills. `coderabbit-rate-limit-retry` and `honest-pr-review` declare a `metadata: {version, triggers}` block that is not a recognised skill frontmatter key (dead config); `scan-vocabulary` uniquely sets `disable-model-invocation: true`; **none of the six declares `allowed-tools`**, though `honest-pr-review` and `coderabbit-rate-limit-retry` both post to GitHub. Only the vendored `openspec-*` skills declare it (`allowed-tools: Bash(openspec:*)`). | Standardise on `name` / `description` / `allowed-tools`; drop the two dead `metadata` blocks. | M | None. |
| E6 | `.claude/skills/graphify/SKILL.md` (713 lines) | Largest single instruction file in the repo, and it is a vendored upstream runbook: it inlines a Python-interpreter-detection shell block and cites upstream issue numbers (`#1392`, `#1361`, `#479`) meaningless in this repo, while the CLI that does all of it is installed (`graphify 0.9.42`). The same routing advice is stated three more times — `CLAUDE.md:178-186`, `.claude/CLAUDE.md:1-3`, and mechanically via four `graphify hook-guard` PreToolUse hooks (`.claude/settings.json:66-84`). | Shrink to CLI usage + the `references/*.md` pointers (those are well-gated and worth keeping); delete `.claude/CLAUDE.md` (see C6). | M | None. |
| E7 | `.claude/skills/write-docs/SKILL.md:40-48` | Every page the ownership table names exists (no dangling rows), but 5 of the 23 real pages have no owning row: `docs/docs/intro.md`, `code-signing-roadmap.md`, `guides/index.md`, `app/index.md`, `app/iac.md`. | Add the five rows. Supersedes C7. | S | None. |

**Confirmed not redundant** (flagged so a later cleanup does not delete them): `honest-pr-review` survives the `/code-review` plugin — the plugin posts inline comments, the skill posts one grouped `POST /reviews` with the own-PR `COMMENT` constraint (`:127`, `:131`); `coderabbit-rate-limit-retry` is live (`.coderabbit.yaml` present and configured); `scan-vocabulary`'s apparent orphan status is `disable-model-invocation: true` working as intended; `discord-iam-reviewer` encodes eight repo-specific security invariants (`:25-32`) no general reviewer knows. All four need routing rows (C5), not deletion.

## Proposed maintenance convention

Nothing currently owns these files, and nothing verifies them. Four concrete pieces:

### 1. Ownership table

Add to `CLAUDE.md` (or a new `.claude/rules/instruction-files.md`) a table naming the *concern* that owns each file, so a change to that concern has an obvious instruction-file consequence:

| File | Owning concern | Changes when |
|---|---|---|
| `CLAUDE.md` § Commands | root/workspace `package.json` scripts | a script is added, renamed, or removed |
| `CLAUDE.md` § Invariants | `app/packages/infra`, the Lambda packages, IPC surface | an architectural invariant is added or retired |
| `CLAUDE.md` § Where to look | `docs/docs/**` tree, `.claude/rules/*`, `.claude/skills/*`, `.claude/agents/*` | any of those trees gains or loses a file |
| `CLAUDE.md` § Before opening a PR | `.github/workflows/*.yml` | a CI job's command changes |
| `.claude/rules/worktree.md` | `.claude/hooks/*.ts` + `.claude/settings.json` | a hook is added, removed, or its enforcement changes |
| `.claude/rules/pr-stacking.md` | `.claude/skills/gh-stack-prs` | the stacking mechanics change |
| `.claude/rules/testing-conventions.md` | `app/packages/web/e2e`, vitest/playwright configs | a test tier or harness changes |
| `.claude/rules/logging.md` | `app/packages/desktop-main/src/controllers`, services | the logging contract changes |
| `.github/copilot-instructions.md` | `CLAUDE.md` invariants + PR title rule | either changes (it is a deliberate isolated-context copy) |
| `CONTRIBUTING.md` | `CLAUDE.md` § Before opening a PR + CI | either changes |
| `README.md` § Repository structure | `app/packages/**` tree | a package is added or removed |
| `.claude/skills/write-docs/SKILL.md` mapping table | `docs/docs/**` tree, `.claude/agents/docs-*` | a page or evaluator agent is added/removed |
| `.claude/skills/openspec-*`, `.claude/commands/opsx/*`, `.github/skills/*`, `.github/prompts/*` | **generated** — `openspec update` | never hand-edited |

### 2. Change triggers

State these as explicit "if you did X, also do Y" rules in the same file:

- Rename/add/remove a `package.json` script → update `CLAUDE.md` § Commands **and** grep `.claude/` + `CONTRIBUTING.md` + `README.md` for the old name.
- Add/remove a package under `app/packages/**` → `CLAUDE.md` § Commands workspace list, `README.md` tree, and any count phrasing ("five Lambda packages").
- Add/remove/rewire a hook → `.claude/settings.json`, `.claude/rules/worktree.md`, and the hook's own header comment.
- Add a `.claude/agents/*.md` or `.claude/skills/*/SKILL.md` → a routing row in `CLAUDE.md` § Where to look; if it is a docs evaluator, also `.claude/skills/write-docs/SKILL.md`.
- Add a `docs/docs/**` page → `CLAUDE.md` routing row (if agent-relevant) + the `write-docs` mapping table + `docs/docs/components/index.md`.
- Change an MCP plugin in `.claude/settings.json` `enabledPlugins` → grep for the old tool-name prefix (`mcp__github__` → `mcp__plugin_github_github__`); this is exactly what produced A1 and A2.
- Change a CI job's command → `CLAUDE.md` § Before opening a PR and `CONTRIBUTING.md` § What CI checks.

### 3. A verification script (proposed shape, not written here)

A small Node script — `scripts/check-instructions.mjs`, wired as an `npm run instructions:check` and a job in `lint.yml` — that parses the in-scope markdown and fails on:

1. **Commands** — every `` `npm run X` `` token must exist as a script in root/`app`/`docs` `package.json`.
2. **Paths** — every backticked repo-relative path (heuristic: contains `/`, no spaces, not a URL, not an `@scope/name`) must satisfy `fs.existsSync`; glob-looking paths (`**`, `*`) check the nearest non-glob ancestor directory.
3. **Package names** — every `` `@hyveon/x` `` must match a real `name` field under `app/packages/**/package.json`.
4. **Assets** — every `` `.claude/rules/*.md` ``, `.claude/skills/<n>/`, `.claude/agents/<n>`, `.claude/hooks/<n>.ts` reference resolves; every hook file is wired in `.claude/settings.json` and vice versa.
5. **Markdown links** — every relative link and `#anchor` into another repo file resolves to a real file and, for anchors, a real heading (this alone catches A9).
6. **Counts** — a small allowlist of "N Lambda packages" / "N docs-* evaluator agents" phrasings compared against `fs.readdirSync` counts.

Roughly 150–200 lines, no dependencies beyond `node:fs`/`node:path` and a trivial fenced-code-block stripper. Rules 1, 2, 3 and 5 are pure wins; rule 6 is the only one needing a hand-kept list, and it is worth it because counts are the single most-drifted category here (A4–A6, A11–A12).

### 4. Changelog practice

A dedicated instruction-files changelog is **not** warranted — the repo already squash-merges with Conventional Commits and runs `git-cliff` (`cliff.toml`). Cheaper and equivalent: adopt `docs(claude):` / `chore(claude):` as the conventional scope for any change to `CLAUDE.md`, `.claude/**`, or `.github/copilot-instructions.md` (the repo already used `chore(claude):` in `b86af154`), so `git log --oneline --grep '(claude)'` is the changelog. Add that scope convention to `CONTRIBUTING.md`'s scope list, which currently offers only `app`, `server`, `web`, `watchdog`, `infra`, `lambda`.

## Proposed PR breakdown

All five PRs are documentation/config only, so verification is "referenced paths exist" plus `npm run app:lint` for the one PR that touches TypeScript. No integration or e2e gate applies (no controller, service, renderer, preload, or IPC change), except where noted.

**PR 1 — `fix(claude): correct broken tool names and blocked commands in agent instructions`**
Covers A1, A2, A3, A15, A16, B9, E2 — the findings where an agent following the instruction literally fails.
Files: `CLAUDE.md`, `.claude/commands/pr.md`, `.claude/commands/openspec-review-implementation.md`, `.claude/commands/openspec-review-proposal.md`, `.claude/skills/gh-stack-prs/SKILL.md`, `.claude/skills/honest-pr-review/SKILL.md`.
Verification: `grep -rn 'mcp__github__' .claude CLAUDE.md` returns nothing; `grep -rn 'git worktree add' .claude/skills` returns nothing; `grep -rn '\.worktrees/' .claude/skills` returns nothing.
Depends on: nothing. Land first — these are functional breaks, not prose.

**PR 2 — `docs(claude): correct stale facts in agent instruction files`**
Covers A4–A14, A17–A19.
Files: `CLAUDE.md`, `CONTRIBUTING.md`, `README.md`, `.github/copilot-instructions.md`, `.claude/rules/worktree.md`, `.claude/skills/write-docs/SKILL.md`, `.claude/agents/docs-accuracy-auditor.md`, `openspec/schemas/superpowers-bridge/README.md` (banner only).
Verification: `test -e` on every changed path reference; grep confirms no remaining "five Lambda", no "scripts workspace", no `#code--test-conventions`, no `platform-express`.
Depends on: PR 1 (same `CLAUDE.md` regions).

**PR 3 — `docs(claude): document toolchain prerequisites and add a precedence rule`**
Covers A20, B1, B3, B4.
Files: `CONTRIBUTING.md`, `CLAUDE.md`, `.claude/commands/pr.md` (frontmatter), `.claude/skills/gh-stack-prs/SKILL.md`.
Verification: `command -v bun openspec graphify gh` matches the documented list.
Depends on: PR 2.

**PR 4 — `docs(claude): route unlisted rules, skills, agents, and commands`**
Covers C1, C3, C4, C5, C6, E7, and D1's "generated, do not hand-edit" note.
Files: `CLAUDE.md`, delete `.claude/CLAUDE.md`, `.claude/skills/write-docs/SKILL.md`.
Verification: every asset under `.claude/rules`, `.claude/skills`, `.claude/agents`, `.claude/commands` appears in `CLAUDE.md`; every routed path exists.
Depends on: PR 2.

**PR 5 — `refactor(claude): delete superseded skills and agents`**
Covers E1, E3, E4, E5, E6.
Files: delete `.claude/skills/openspec-*` (12 dirs), delete `.claude/agents/deployment-config-field-auditor.md`, edit `.claude/agents/discord-iam-reviewer.md`, `.claude/skills/graphify/SKILL.md`, and the frontmatter of the six non-OpenSpec skills.
Verification: `openspec update` re-run does **not** recreate `.claude/skills/openspec-*` (pin the generator config first — if it does, this PR must instead document the duplication and stop). No remaining reference to `deployment-config-field-auditor` anywhere.
Depends on: PR 4 (which routes what survives).

**PR 6 — `refactor(claude): consolidate duplicated guidance to a single home`**
Covers B2, B5, B6, B7, B8, C2, D2, D3.
Files: `CONTRIBUTING.md`, `.github/copilot-instructions.md`, `.claude/rules/pr-stacking.md`, `.claude/rules/spec-driven-development.md`, `.claude/rules/logging.md` and `tsdoc-tags.md` (add `paths:` frontmatter), `CLAUDE.md`.
Verification: the pre-PR gate is stated once; the Conventional Commits regex drops from 5 copies to 2 executable ones plus citations.
Depends on: PR 2 and PR 4.

**PR 7 — `chore(claude): add instruction-file verification script`**
Covers the § 3 script and § 1/§ 2 ownership tables; resolves B10 (the `docs/superpowers/**` legacy question) in the same pass, since the link checker surfaces those files as unrouted.
Files: new `scripts/check-instructions.mjs`, root `package.json` (`instructions:check`), `.github/workflows/lint.yml`, new `.claude/rules/instruction-files.md`, `CONTRIBUTING.md` (scope convention), plus whatever `docs/superpowers/**` disposition is chosen.
Verification: `npm run app:lint` (JS touched) **and** `npm run instructions:check` exits 0 against the post-PR-6 tree. Only green *because* PRs 1–6 fixed the facts it checks — must land last.
Depends on: PRs 1–6.

## Rules to add or update

1. **New file `.claude/rules/instruction-files.md`** (no `paths:` frontmatter — it must always load): the ownership table and change triggers from the maintenance-convention section above, plus the one-line invariant: *"`.claude/skills/openspec-*`, `.claude/commands/opsx/*`, `.github/skills/*`, and `.github/prompts/*` are generated by `openspec update` — never hand-edit them."*

2. **`CLAUDE.md`, new "Precedence" paragraph** (immediately after the intro): *"When instruction files conflict: this file's invariants win, then `.claude/rules/*`, then skills, then `.github/copilot-instructions.md` (which targets Copilot and deliberately restates content it cannot link to). If you find a conflict, fix the losing file in the same PR rather than working around it."*

3. **`.claude/rules/pr-stacking.md`, append to step 2**: *"If you are using `gh stack`, follow the single-worktree-per-stack override in `.claude/skills/gh-stack-prs/SKILL.md` instead of creating one worktree per group — `gh stack sync` cannot rebase a branch that is checked out in a sibling worktree."*

4. **`.claude/rules/worktree.md`, correct line 3**: *"`guard-git-worktree-add-path.ts` blocks **every** direct `git worktree add`, regardless of target path — worktree creation must go through `EnterWorktree`."*

5. **`CONTRIBUTING.md`, scope list**: add `claude` as a recognised Conventional Commits scope for changes to `CLAUDE.md`, `.claude/**`, and `.github/copilot-instructions.md`, so `git log --grep '(claude)'` serves as the instruction-files changelog.

## Bugs found incidentally

1. `.claude/commands/pr.md:30` — `/pr` calls `mcp__github__create_pull_request`, a tool name the currently-enabled GitHub plugin does not expose (it exposes `mcp__plugin_github_github__create_pull_request`). Since `CLAUDE.md:158` mandates `/pr` as the only PR-creation path, the repo's documented PR workflow references a non-existent tool. Fix: rename to the plugin-prefixed name. (Also listed as A2 — repeated here because it is a functional break, not just prose drift.)
2. `.claude/commands/pr.md:33` — `/pr` hardcodes `Base branch: main`, so any PR in a stack created via `/pr` targets `main` instead of the previous group's branch, silently producing a PR whose diff includes every earlier group. Fix: derive or prompt for the base when the current branch is not based on `main`.
3. `.claude/commands/openspec-review-implementation.md:4` and `openspec-review-proposal.md:4` — both declare `allowed-tools` that omit `Workflow` and `Edit`, yet step 3 of each command calls the `Workflow` tool and the `--fix` branch edits files with `Edit`. As declared, `/openspec-review-*` cannot execute its own step 3 and `--fix` cannot apply anything. Fix: add both tools to `allowed-tools`.
4. `.claude/skills/gh-stack-prs/SKILL.md:39` — the skill's primary instruction (`git worktree add --detach .worktrees/<stack-name> main`) is denied unconditionally by `guard-git-worktree-add-path.ts:94-99`, and uses a path prefix (`.worktrees/`) that `guard-enter-worktree-path.ts:68-72` also rejects. Every invocation wastes a round-trip before falling back to the parenthetical `EnterWorktree` note at `:49`. Already observed once — `openspec/changes/archive/2026-08-06-remove-cost-explorer-calls/retrospective.md:106`.

## Method

I fanned out four read-only sub-agents: three Sonnet (one extracting and mechanically verifying every command/path/package-name/asset reference across all in-scope files; one building the reference graph of which skill/agent/command/rule is cited from where, plus diffing the four OpenSpec mirrors; one building the topic × file duplication matrix) and one Opus judging skills/agents/commands quality and supersession. Two further Opus agents (contradictions/precedence, and READMEs/copilot-instructions accuracy) could not be launched — the repo-wide concurrent-subagent limit was saturated by the other audit coordinators — so I performed those two passes inline myself, reading all six hook sources, `.claude/settings.json`, all eight rule files, both top-level prose files, `.github/copilot-instructions.md`, all seven CI workflows, and every `package.json`. Every `file:line` above was re-verified with `grep -n`/`sed -n` before inclusion. I dropped one sub-agent claim (that `.claude/rules/logging.md` is undiscoverable because it lacks `paths:` frontmatter) after a live session's injected context showed the opposite — unscoped rules load *always*, which is why C2 is framed as an always-on context cost rather than a discoverability gap — and downgraded another (that unreferenced skills should be deleted) to "route them", since skills fire on description-match rather than textual linking. Not covered: the content of `docs/docs/**` and `openspec/specs/**` (owned by other coordinators — I only checked that instruction files point at paths that exist there), the 12 generated OpenSpec skills' *procedural* correctness (vendored output of `openspec` CLI 1.7.0), and `openspec/changes/archive/**/README.md` (historical records, deliberately frozen).
