# Retrospective: add-env-var-token-interpolation

> Written: 2026-08-31 (after verify passed)
> Commit range: `fa5d090b..df22992e`
> Worktree: .claude/worktrees/env-var-interpolation

---

## 0. Evidence

- **Commit range**: `fa5d090b..df22992e` (9 commits)
- **Diff size**: +974 / -25 lines across 23 files
- **Tasks done**: 11/11
- **Active hours**: ~1.5h implementation (19:40–20:25) + ~15min final review/fix round after a 3h rate-limit pause (23:36–23:50); planning/brainstorm earlier the same evening (~1h)
- **Subagent dispatches**: 16 (1 batched implementer + 3 implementers, 4 task/re-reviews, 1 final review (resumed once after a 429), 1 fix wave, 3 docs writers, 3 docs evaluators + field auditor)
- **New external dependencies**: none
- **Bugs encountered during this cycle**: 3 — (1) pre-upgrade wizard drafts would crash on resume (missing `command` backfill; caught by final review, fixed df22992e); (2) GNU wget default retries breached the ~60s discovery budget (fixed df22992e); (3) docs `node_modules` corruption from two agents racing `npm ci` in the same directory (environment, not product; resolved by re-running serially)
- **OpenSpec validate state at archive**: pass (38/38 items)
- **Test coverage signal**: vitest 3523 passing (was 3497 at base; +26 across shared/infra/desktop-main/web), integration 46/46, e2e 96/96, docs build green

Commit chain (chronological):

```
28fa778c feat(shared): add ${hyveon.*} env token grammar and helpers
e001087e feat(shared): add optional command field to GameServer
ffa7ba8b feat(shared): validate ${hyveon.*} env tokens and ipv4 prerequisites
c042e94e feat(infra): add injection-safe boot-time IP wrapper generator
8f085309 feat(infra): resolve env tokens in task definitions and inject boot wrapper
daff135f feat(web): env token hint, value errors, and start-command editor
42a67609 docs: document env var token interpolation and start command
e1fbb7fe chore(openspec): check off remaining tasks
df22992e fix: backfill wizard draft command, cap wget retries, validate echoed IP shape
```

---

## 1. Wins

- [evidence: §0 commit chain, task reviews all "Approved" first pass] The plan carried complete reference code for every task; all four implementer dispatches returned DONE with zero fix rounds at the task level — the only fix round of the whole cycle came from the final whole-branch review.
- [evidence: envTokenWrapper.test.ts sh-execution tests] Testing the generated wrapper under real `/bin/sh` against a live local HTTP stub (including the adversarial `'; rm -rf / #` value and garbage-body recovery) proved the injection defense end to end rather than asserting string shapes.
- [evidence: pre-existing full-object `toEqual` test in ecs.test.ts unchanged across 8f085309] The byte-identical guarantee for token-free games was enforced by construction (conditional spreads) and verified by a test that never had to change.
- [evidence: final review report] The Fable final review earned its cost again: both merge-blocking findings (draft-resume crash, wget retry budget) were invisible to all task-scoped reviews because they lived in cross-task/upstream code the task diffs never touched.
- [evidence: brainstorm.md decision chain] Locking grammar/mechanism/failure-mode decisions with the user before scaffolding meant zero design churn during implementation.

## 2. Misses

- 🔴 [blocking | evidence: df22992e, final review finding 1] The `command` draft-field widening missed desktop-main's `GameWizardDraft` mirror and its backfill pattern — the repo has two prior backfill precedents in the same file, and neither the plan nor the Task 6 brief named the draft-persistence surface. Plan-authoring gap: renderer draft types have a persisted twin.
- 🟡 [painful | evidence: three failed docs builds ~20:15] Controller and the docs-style evaluator both ran `npm ci`/builds in `docs/` concurrently, corrupting `node_modules` twice (tar ENOENT, empty `.bin`, missing packages) before a quiet serial install succeeded.
- 📌 [nit | evidence: task-4 review minor] tasks.md checkbox edits were bundled into an implementation commit instead of the bookkeeping commit.

## 3. Plan deviations

| Plan task | What changed | Why |
|-----------|--------------|-----|
| 1 (brief import path) | `GameServerEnvironmentVariable` imported from `@hyveon/shared` root, not the brief's `gameServerConfig` subpath | the subpath is not in shared's exports map; verified equivalent by reviewer |
| 4 | added a vitest alias for `@hyveon/shared/envTokens` in app/vitest.config.ts | value import needs runtime resolution in tests, unlike type-only imports |
| 6 | also updated `api.service.ts` mirror types + one `games.page.test.tsx` fixture | required for cross-package `tsc -b`; reviewer confirmed minimal |
| post-plan | final-review fix round: `backfillCommand`, `wget -t 1`, IP shape check | findings 1–3 of the whole-branch review |

## 4. Skill / workflow compliance

| Skill                                            | Used |
|--------------------------------------------------|------|
| superpowers:brainstorming                        | ✓ |
| superpowers:writing-plans                        | ✓ |
| superpowers:using-git-worktrees                  | ✓ (EnterWorktree — repo's mandated equivalent; hooks enforce isolation/sync/npm ci) |
| superpowers:subagent-driven-development          | ✓ |
| (transitive) superpowers:test-driven-development | ✓ (RED/GREEN evidence in every implementer report) |
| (transitive) superpowers:requesting-code-review  | ✓ (4 task-scoped reviews + final whole-branch review + 1 scoped re-review) |
| superpowers:finishing-a-development-branch       | ✓ (in progress at write time — PR step follows archive) |

### Deliberately Skipped Skills

(none — all rows green)

## 5. Surprises

- Fargate task metadata does not expose the public IP, but `https://checkip.amazonaws.com` made boot-time discovery possible with zero IAM/taskRole additions — the design's cheapest path survived contact with implementation unchanged.
- GNU wget's `-T` is per-try with 20 default tries; the "~60s budget" the spec stated was silently wrong on GNU-wget images until the final review hand-traced the script. BusyBox and GNU wget semantics diverge enough to matter in generated shell.
- The docs site's `node_modules` is a shared mutable resource across agents: the read-only-labeled style evaluator legitimately needed a build, colliding with the controller's own build.

## 6. Promote candidates → long-term learning

- [ ] 🔴 **Widening a renderer draft/config type means checking its persisted desktop-main twin and backfill chain** → **Promote to memory** (type: feedback)
  > **Why**: this cycle's only Critical finding — `WizardDraft.command` became required in the renderer while desktop-main's stored `GameWizardDraft` had no field and no `backfillCommand`, crashing pre-upgrade draft resume; the same file already had two backfill precedents (`backfillHealthCheck`, `backfillPortVisibility`) that should have been the template.
  > **How to apply**: any change touching `WizardDraft`/`GameWizardDraft`/stored draft or settings shapes in Hyveon — grep `ElectronStoreService`/`GameWizardDraftService` for the mirror type and add a backfill + regression test in the same commit.

- [ ] 🟡 **Serialize anything that installs into a shared `node_modules`; never run two npm installs/builds of the same package dir concurrently** → **Promote to memory** (type: feedback)
  > **Why**: controller + docs evaluator raced `npm ci` in `docs/`, corrupting installs twice (tar ENOENT / empty `.bin`) and costing ~10 minutes of phantom debugging; related to the existing WSL parallel-load memory.
  > **How to apply**: before running a build/install in a directory a dispatched agent might also touch, either do it after that agent reports or state in the agent's prompt that the controller owns the build step.

- [ ] 📌 **Generated-shell specs should state per-tool retry semantics, not just a total budget** → **One-off** (record only; the fix — `wget -t 1` — is now in the code and docs)
  > **Why**: "~60s budget" met BusyBox wget but not GNU wget's 20-try default; the spec's budget language hid a tool-semantics dependency.
  > **How to apply**: n/a — captured here; the shipped script pins `-t 1`/`-m 5` explicitly.
