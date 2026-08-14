# Retrospective: add-internal-game-ports

> Written: 2026-08-13 (after verify passed)
> Commit range: `2e027b7e..8f540f22`
> Worktree: `/home/chris/GitHub/Hyveon/.claude/worktrees/add-internal-game-ports`

---

## 0. Evidence

- **Commit range**: `2e027b7e..8f540f22` (17 commits)
- **Diff size**: +2129 / -44 lines across 26 files
- **Tasks done**: 18/18 (`grep -cE '^\s*- \[x\]' tasks.md` → 18)
- **Active hours**: ~1.5 (single continuous session: brainstorm → proposal → apply → verify)
- **Subagent dispatches**: 27 (1 plan-writer fork + 10 task implementers + 10 task reviewers + 1 fix-round resume + 2 final-review fix/re-review dispatches + 1 fix-wave dispatch + 1 final whole-branch reviewer + verify/retro done inline by the controller)
- **New external dependencies**: none
- **Bugs encountered during this cycle**: 3 — (1) plan-mandated `as unknown as T` casts violating the repo's own test-cast constraint (Task 4 review); (2) a security-relevant gap where an `'internal'`-visibility port on 443/80/tcp stayed internet-reachable whenever any HTTPS game existed, due to SG rule unioning with the pre-existing unconditional Caddy ingress (final whole-branch review); (3) a tautological test copied verbatim from the plan's brief (final whole-branch review)
- **OpenSpec validate state at archive**: pass (33/33 items valid, 0 issues)
- **Test coverage signal**: vitest 3157/3157 passing (full unit suite); Playwright tier-2 integration 42 passed / 1 skipped (pre-existing skip, unrelated to this change)

Commit chain (chronological):

```
2e027b7e feat(infra): derive Pulumi secrets passphrase from AWS account ID (#511)   [base]
3f3f045b docs(openspec): propose per-port public/internal network visibility
18b74a20 feat(shared): add optional visibility field to GameServerPort
c0a0cd24 feat(shared): validate GameServerPort.visibility
5df526a6 feat(infra): ingress internal-visibility game ports from the VPC CIDR
fc0a0c38 feat(web): thread port visibility through the wizard draft model
17d7228f fix(web): drop as-unknown-as casts in port visibility tests
8d39d75f feat(web): expose per-port visibility toggle in the networking step
e1db5d06 test(web): cover port visibility persistence in the edit-game form
0b4091a7 chore(web): mirror GameServerPort.visibility in api.service.ts IPC types
ae1ed398 feat(web): show port visibility in the review step and game detail page
5ba8e31e docs(infra): document per-port public/internal visibility
a329c42c fix(shared): reserve https 443/80/tcp across the whole deployment
8cc958d1 test(web): drop tautological WizardDraftPort default-visibility test
45a5a448 docs(infra): qualify the port-visibility "never both buckets" claim
55a46a22 docs(app): document port visibility toggle in the wizard's Networking step
b50e0e1e chore(openspec): mark add-internal-game-ports tasks complete
8f540f22 docs(openspec): record verification report for add-internal-game-ports   [head]
```

---

## 1. Wins

- [evidence: commits `18b74a20`..`0b4091a7`] Threading one field (`visibility`) through 7 independent surfaces (shared type, zod schema, 2 infra dedup buckets, wizard draft read/write, 2 UI display sites, IPC-mirror types) with zero cross-surface inconsistency — confirmed identical `undefined ≡ 'public'` handling everywhere by the final whole-branch review, not just asserted by individual task reviews.
- [evidence: Task 8 report, `0b4091a7`] The plan's own explicit ordering note ("do Task 8's type-only step first or pull it forward here") was followed via a pre-flight ledger ruling before any task executed, and the anticipated typecheck errors in Tasks 4-6 resolved exactly as predicted once Task 8 landed — the ordering constraint the plan-writer fork flagged held up under real execution.
- [evidence: `a329c42c`, final-review dispatch] The final whole-branch review, dispatched on a model distinct from and more capable than the per-task reviewers, caught a genuine security gap (443/80 cross-game leak) that 10 individually-clean task reviews structurally could not see, because no single task's diff contained both the Caddy block and the new visibility field's interaction.
- [evidence: `18b74a20`, review verdict] Task 1's TSDoc was accepted character-for-character identical to the brief on first pass — the plan-writer fork's investment in exact wording paid off with zero fix-loop iterations on the foundational type.

## 2. Misses

- 🔴 [blocking (caught, fixed) | evidence: final-review finding I1, commit `a329c42c`] design.md's Risks section anticipated the *port-level, not caller-scoped* confinement trade-off for internal visibility, but neither design.md nor the plan considered the interaction with the pre-existing, unconditional Caddy 443/80 public-ingress block. SG rule unioning meant a port explicitly marked `'internal'` could still be internet-reachable in that one corner case — a real violation of the spec's own "Internal port unreachable from the internet" guarantee. Caught only by the final whole-branch review reading the full diff against the live `hasHttpsGame` block, not by any per-task review.
- 🟡 [painful | evidence: Task 4 review finding, commit `17d7228f`] The plan's own Task 4 Step 1 test snippet used `as unknown as Parameters<typeof draftFromGameServer>[0]`, directly violating that same task's Global Constraint ("No `as unknown as T` casts in tests"). The plan-writer fork copied a pattern into example code that the plan's own binding rules forbid — a self-contradiction that survived plan self-review and had to be caught by task-level review instead.
- 🟡 [painful | evidence: ledger Task 4 ruling, resolved by `0b4091a7`] `api.service.ts`'s hand-maintained IPC-mirror types were not identified as a dependency until Task 4's implementer hit the typecheck error live — the plan's own dependency ordering note for Task 7↔8 didn't anticipate that Tasks 4-6 would also transitively depend on Task 8 landing first. Handled gracefully via ledger rulings each time, but it cost 3 separate "known gap, not a defect" review conversations across Tasks 4, 5, and 6 that a single upfront dependency-graph note in the plan could have prevented.
- 📌 [nit | evidence: final-review finding M2, commit `8cc958d1`] One test in the plan's Task 4 brief ("should default a new WizardDraftPort to visibility 'public' via createEmptyWizardDraft plus a manually appended row") asserted a property of a locally-constructed literal against itself — zero behavioral coverage. Copied verbatim from the brief by the implementer without scrutiny; caught only at final review.
- 📌 [nit | evidence: `55a46a22`, tasks.md item 4.2] tasks.md (the OpenSpec change's coarse task list) specified updating `docs/docs/app/` wizard/games pages (item 4.2), but plan.md's Task 9 (the fine-grained TDD plan the plan-writer fork actually wrote) only covered `docs/docs/components/infra.md`. This 1:1 mismatch between the two task lists wasn't caught until the verify step cross-checked tasks.md against actual commits.

## 3. Plan deviations

| Plan task | What changed | Why |
|-----------|--------------|-----|
| Task 4 | One additional fix round (removed `as unknown as T` casts) beyond the plan's own Step 1-7 | Plan-mandated test code violated the plan's own Global Constraint — ruled and fixed per the subagent-driven-development skill's plan-mandated-finding process |
| Task order | Executed 1,2,3,4,5,6,8,7,9,10 instead of numeric 1-10 | Plan's own text (Task 7's Interfaces line, Task 8 Step 2) explicitly called for this reordering; ledgered as a pre-flight ruling before Task 1 dispatched |
| (post-Task 10) | Added a fix wave (3 commits: `a329c42c`, `8cc958d1`, `45a5a448`) not in the original 10-task plan | Final whole-branch review is structurally outside the plan — it exists precisely to catch what individual tasks can't; the subagent-driven-development skill's process, not a plan defect |
| tasks.md 4.2 | Added `docs/docs/app/games.md` documentation (commit `55a46a22`) not covered by plan.md's Task 9 | tasks.md (coarser OpenSpec-level list) and plan.md (fine-grained TDD plan) diverged on doc scope; closed during verify rather than left as a silent gap |
| tasks.md checkboxes | Marked all 18 complete in one batch commit (`b50e0e1e`) rather than incrementally per coarse-task-group as apply's instructions suggested | The subagent-driven-development skill tracks progress via its own plan.md-scoped ledger, not tasks.md; tasks.md was correctly the deliverable but its checkbox bookkeeping wasn't part of that skill's contract — closed as a verify-time correction |

## 4. Skill / workflow compliance

| Skill                                            | Used |
|---------------------------------------------------|------|
| superpowers:brainstorming                        | ✓    |
| superpowers:writing-plans                        | ✓ (via a forked subagent, per parent-session judgment to keep raw source reads out of context) |
| superpowers:using-git-worktrees                  | ✓ (detected pre-existing isolation via `EnterWorktree`, skipped redundant creation per skill's own Step 0) |
| superpowers:subagent-driven-development          | ✓    |
| (transitive) superpowers:test-driven-development | ✓ (every task's implementer dispatch required RED→GREEN evidence) |
| (transitive) superpowers:requesting-code-review  | ✓ (per-task reviewer + final whole-branch reviewer, both dispatched per the skill's template) |
| superpowers:finishing-a-development-branch       | pending — next step after this retrospective |

> **Default expectation**: all ✓. No skill was skipped this cycle.

### Deliberately Skipped Skills

(none — every skill in the apply-phase flow was used)

## 5. Surprises

- The plan-writer fork's own generated plan.md contained a self-contradiction (Task 4's example code violating Task 4's own Global Constraint) — an assumption that a single agent writing both the constraints and the example code in the same document would keep them consistent turned out wrong. Worth noting since it's the second time in this session a fork corrected itself mid-flight (it also caught and fixed a stale claim in brainstorm.md/proposal.md/design.md that PR #491 was still "in-flight" when it had actually merged) — forks self-correcting against live repo state is a good sign, but plan self-review evidently doesn't catch same-document internal contradictions between prose rules and embedded code samples.
- The security gap (443/80 cross-game leak) existed as *latent* risk in the codebase before this change too (two non-HTTPS-conflicting games both declaring 443/tcp would have produced a loud duplicate-ingress-rule error pre-change), but this change's CIDR-vs-0.0.0.0/0 split turned a loud failure mode into a silent one for that specific corner case. Not something design.md's Risks section anticipated, because it wasn't cast as "this change interacts with a pre-existing conditional block" but rather analyzed in isolation.

## 6. Promote candidates → long-term learning

- [ ] 🟡 **When a plan task's own Global Constraints forbid a pattern, scan the plan's own example code blocks for that pattern before dispatching, not just after task review.** → **Promote to schema** (writing-plans skill's self-review step)
  > **Why**: Task 4's brief contained `as unknown as T` casts in its own Step 1 code sample, directly violating the same task's stated Global Constraint. The plan-writer fork's self-review checklist (placeholder scan, type consistency) didn't include a "does example code violate this plan's own stated constraints" check, so it survived to task-level review instead of being caught during plan authoring.
  > **How to apply**: In `superpowers:writing-plans`'s Self-Review section, add an explicit check: grep every task's code blocks against the Global Constraints list for forbidden patterns (cast idioms, banned APIs, naming violations) before considering the plan done.

- [ ] 🟡 **A fine-grained TDD plan.md and its parent OpenSpec tasks.md can silently diverge in scope — reconcile them explicitly before dispatching, not at verify time.** → **Promote to schema** (writing-plans / apply skill's setup step)
  > **Why**: tasks.md item 4.2 (docs/docs/app/ update) had no corresponding plan.md task; it was only caught because verify's Task Completion check cross-referenced tasks.md against actual commits after everything else was already done, requiring a same-session out-of-band fix rather than being part of the planned flow.
  > **How to apply**: When writing-plans generates plan.md from an existing tasks.md, explicitly map every tasks.md line item to a plan.md task/step before finalizing, and flag any tasks.md item with no plan.md coverage as a gap to resolve during plan authoring, not during verify.

- [ ] 📌 **Forks correcting stale claims against live repo state (e.g. "PR #491 is still in-flight" → actually merged) is a good sign worth watching for, not a one-off.** → **One-off** (record only, do not promote)
  > **Why**: Doesn't generalize into an actionable rule yet — it's evidence that dispatching forks with instructions to verify claims against live state (rather than trusting conversational context/memory) works as intended, observed twice in one session.
