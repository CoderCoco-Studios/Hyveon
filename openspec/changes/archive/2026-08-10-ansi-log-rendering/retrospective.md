# Retrospective: ansi-log-rendering

> Written: 2026-08-10 (after verify passed)
> Commit range: `8785f4fc..49e5f1b8`
> Worktree: `.claude/worktrees/add-ansi-log-rendering` (branch `worktree-add-ansi-log-rendering`, pushed to origin)

---

## 0. Evidence

- **Commit range**: `8785f4fc..49e5f1b8` (10 commits)
- **Diff size**: +1519 / -121 lines across 18 files
- **Tasks done**: 13/14 (`grep -cE '^\s*- \[x\]' tasks.md` → 13; the 14th row is `- [~]` deliberately deferred, not `- [ ]`)
- **Active hours**: ~1 (single continuous session: brainstorm → propose → apply → verify)
- **Subagent dispatches**: 11 (5 implementers: Tasks 1-5; 4 task reviewers; 1 final whole-branch reviewer; 1 fix-wave implementer + 1 scoped re-reviewer = 11 total review/implementation dispatches, plus the 2 upfront research agents from the original "what would it take" exploration in a prior turn, not counted here as they predate this change's brainstorm)
- **New external dependencies**: none
- **Bugs encountered during this cycle**: 5, all caught by the final whole-branch review (none escaped to a task-level review — see §2)
- **OpenSpec validate state at archive**: pass (25/25 items valid, see verify.md §1)
- **Test coverage signal**: vitest, 166 files / 2928 tests passing at HEAD (full suite); 21 new tests added across `ansi.utils.test.ts` (18), `log-line-display.component.test.tsx` (7), `log-level.utils.test.ts` (4) — net new after fix-wave additions

Commit chain (chronological):

```
8785f4fc feat(web): replace Resources step dropdowns with slider controls (#463)   <- base (main)
2ec44d62 docs(openspec): propose ansi-log-rendering change
6016fc4e docs(openspec): mark ansi-log-rendering tasks complete   (contains Tasks 1-5 as sub-commits: 84df43a6, 00e36cf5, 26e66bde, ebd74e8b)
40513ca4 fix(web): stop mis-rendering non-SGR/extended-color ANSI sequences
ac2fc59e docs(web): document ANSI color rendering on /logs and Diagnostics
710dde91 test(web): remove duplicated parseAnsiLine tests from ansi-log-viewer spec
49e5f1b8 docs(openspec): verify ansi-log-rendering implementation
```

---

## 1. Wins

- [evidence: task-1-report.md, task-2-report.md reviews] Every one of the 5 task-level reviews came back Spec ✅ / Approved on the first pass, with zero fix-loop rounds needed at the task level — the plan.md's verbatim code-in-the-brief approach (per superpowers:writing-plans' "No Placeholders" rule) meant implementer subagents transcribed rather than interpreted, eliminating an entire class of spec-drift.
- [evidence: commit 26e66bde + task-3 review] Task 3 (the highest-risk task — shared `HighlightedLine`, two untouched consumer test files at stake) shipped correctly on the first attempt because the plan.md brief front-loaded the DOM-nesting hazard explicitly (why wrapping every segment in a `<span>` would break `getByText` in `logs.page.test.tsx`/`DiagnosticsPanel.test.tsx`) rather than leaving the implementer to discover it.
- [evidence: final whole-branch review report] The final whole-branch review (opus model, general-purpose agent standing in for the unavailable `code-reviewer` agent type) caught 5 real issues that no task-scoped review could have — 2 of them (finding 1: incomplete ANSI stripping; finding 3: 256-color mis-parse) required cross-referencing the actual byte grammar of ANSI escape sequences against real-world tool output (steamcmd, apt, docker), which is exactly the kind of broad, adversarial pass task-level reviews aren't scoped for. This validates the schema's two-tier review design (task review + final review) rather than relying on task review alone.
- [evidence: commit 40513ca4, final-fix-report.md] The one-shot fix-wave dispatch (all 5 findings in a single subagent call, per subagent-driven-development's "ONE fix dispatch, not one fixer per finding") completed cleanly with a single scoped re-review — no second fix round needed.

## 2. Misses

- 🔴 [blocking-if-unfixed | evidence: final whole-branch review report, finding 3] The original Task 1 implementation (and the pre-existing `ansi-log-viewer.component.tsx` parser it was extracted from) mis-parsed 256-color/24-bit SGR codes (`38;5;N`, `38;2;R;G;B`) as independent standard SGR codes, sometimes producing a *wrong* color via numeric coincidence (e.g. `38;5;31` → wrongly red) rather than the intended "unsupported, no styling." This bug predates this change (it lived in `AnsiLogViewer` already) but this change extended its blast radius from Pulumi-only output to all game-server log output, and design.md's own Non-Goals section mischaracterized the risk as "unsupported" rather than "actively wrong." Caught only at final review, not at Task 1's task-level review — the task-1 brief's test cases didn't include a `38;5;N`-style example.
- 🟡 [painful | evidence: final whole-branch review report, finding 1] The Task 1 brief's CSI regex (`/\x1b\[([0-9;]*)([A-Za-z])/g`) was written from the ANSI SGR grammar specifically (digits + semicolons), not the full CSI grammar (which also permits `:`, `<`, `=`, `>`, `?` in the parameter-byte range 0x30-0x3F) — so DEC private-mode sequences like `\x1b[?25l` (cursor hide, common in real steamcmd/apt output) weren't stripped. This is exactly the class of bug the design's own stated Goal ("never show a raw ANSI escape sequence... even for sequences the parser doesn't style") was meant to prevent, but the design.md D2 decision text described the mitigation in CSI-shorthand without spelling out the full byte-range implication.
- 📌 [nit | evidence: re-review report] The fix wave's `ANSI_PATTERN` TSDoc comment cites "charset selection" as an example covered by the Fe-escape single-byte fallback branch, but charset selection sequences (`\x1b(B`) actually use a different intermediate-byte range not matched by that branch. Comment-only inaccuracy, no functional impact — not fixed in this cycle (parked, see verify.md §7 note is unrelated; this is a separate, lower-priority nit noted by the re-reviewer as an aside, not a formal finding).

## 3. Plan deviations

| Plan task | What changed | Why |
|-----------|--------------|-----|
| 4.4 (manual smoke check) | Executed as deferred (`- [~]`) rather than run live | Plan step required a running Electron app + human observation; not available in this automated cycle. verify.md §7 established full automated-test equivalence (the exact bug-report sample line is now a test case), so this was accepted as a non-gap deferral rather than a skipped requirement. |
| (post-plan) Final review fix wave | Added: broader `ANSI_PATTERN` (3-way alternation for CSI/OSC/Fe), segment coalescing, extended-color skip-ahead logic, two docs pages, test dedup | Not in the original plan.md — surfaced entirely by the final whole-branch review after all 5 planned tasks were "complete." This is the intended failure mode the final-review stage exists to catch (task-scoped correctness ≠ whole-feature correctness against real-world input). |

## 4. Skill / workflow compliance

| Skill                                            | Used |
|--------------------------------------------------|------|
| superpowers:brainstorming                        | ✓    |
| superpowers:writing-plans                        | ✓    |
| superpowers:using-git-worktrees                  | ✗ (see below) |
| superpowers:subagent-driven-development          | ✓    |
| (transitive) superpowers:test-driven-development | ✓    |
| (transitive) superpowers:requesting-code-review  | ✓    |
| superpowers:finishing-a-development-branch       | (pending — next step after this retrospective) |

### Deliberately Skipped Skills

- **`superpowers:using-git-worktrees`**
  - **What was skipped**: the entire skill invocation at subagent-driven-development's Setup step ("use superpowers:using-git-worktrees to create one or verify the existing one").
  - **Why this cycle**: this session's harness already provides its own worktree-isolation primitive (`EnterWorktree` tool), invoked once at the very start of this change (before the brainstorm, per this repo's `.claude/rules/git.md` "Always use a worktree via `EnterWorktree`" rule) — the session was already running inside `.claude/worktrees/add-ansi-log-rendering` on branch `worktree-add-ansi-log-rendering` by the time `/opsx:apply` reached the subagent-driven-development setup step. Invoking `superpowers:using-git-worktrees` on top would have created a second, nested worktree-within-a-worktree, which the harness's own worktree tooling does not support cleanly (nested `EnterWorktree` calls are for switching between worktrees, not stacking).
  - **How to prevent recurrence**: `scope-judgment rule` — when the calling harness already provides worktree isolation before `/opsx:apply` is invoked (detectable: current working directory is already under `.claude/worktrees/` or equivalent, and `git status` on `main` was never touched), treat `superpowers:using-git-worktrees`'s Setup step as already-satisfied rather than skipped, and note it explicitly in the retrospective (as done here) rather than silently omitting the row. This is a harness-integration boundary case, not a quality shortcut — the isolation guarantee the skill exists to provide was met via an equivalent mechanism.

## 5. Surprises

- The pre-existing `ansi-log-viewer.component.tsx` parser (which this change extracted rather than wrote from scratch) turned out to have two latent correctness bugs (findings 1 and 3) that had gone unnoticed because its only prior consumer (the Pulumi/IaC run viewer) apparently never encountered DEC private-mode sequences, OSC sequences, or 256-color codes in practice. Extracting and reusing existing "working" code carried an unstated assumption that it was correct for all ANSI input, not just the input it had previously been exposed to — worth flagging generally: reuse still needs adversarial testing against the *new* consumer's real input space, not just regression tests confirming the *old* consumer's behavior is unchanged.
- The final review's empirical falsification of Task 3's own stated rationale (the DOM-nesting concern that motivated the Fragment/bare-string rendering choice) — the reviewer patched the component to reintroduce the "unsafe" pattern and confirmed all 26 consumer tests still passed — was a genuine surprise: `@testing-library/dom`'s `getNodeText` only reads *direct* child text nodes, so the anticipated duplicate-match failure mode couldn't actually occur the way the brief predicted. The shipped code remains correct and arguably cleaner regardless, but the stated justification in plan.md is now known to be inaccurate.

## 6. Promote candidates → long-term learning

- [ ] 🔴 **When extracting/reusing an existing internal parser or utility for a new consumer, task-level test briefs must include adversarial input drawn from the new consumer's real-world data, not just regression cases proving the old consumer is unaffected.** → **Promote to memory** (type: feedback)
  > **Why**: this cycle's Task 1 brief tested the extracted SGR parser only against the same cases the original `AnsiLogViewer`/Pulumi-viewer test suite already covered; two real correctness bugs (DEC private-mode/OSC stripping gap, 256-color numeric collision) survived to final review because nothing in the task-level test brief exercised steamcmd/apt/docker-style real-world ANSI output, even though that was the explicit new consumer this whole change existed to serve.
  > **How to apply**: when a plan.md task brief says "extract/reuse existing parser X for new consumer Y," require the brief's test cases to include at least one real sample drawn from Y's actual input (not just X's prior test fixtures) before dispatching the task-1-equivalent implementer.

- [ ] 🟡 **The final whole-branch review stage in subagent-driven-development is not redundant with per-task review — it caught 100% of this cycle's real bugs (5/5) that task-level review caught 0/5 of.** → **Promote to memory** (type: feedback)
  > **Why**: it would be tempting on a small, well-specified plan (5 tasks, all task reviews clean on the first pass) to treat the final review as a formality and skip or lighten it. This cycle demonstrates the opposite: task-scoped review structurally cannot catch cross-cutting correctness issues (a parser tested only against its own task's brief cases, not the whole feature's real input surface).
  > **How to apply**: never skip or shorten the final whole-branch review dispatch on the rationale that "every task already passed review" — the two review tiers catch different failure classes by design, not by redundancy.

- [ ] 📌 **This harness's `Agent` tool registry doesn't include a `code-reviewer` subagent type; `subagent_type: "general-purpose"` with an equivalent prompt is the working substitute for superpowers' `requesting-code-review/code-reviewer.md` template.** → **One-off** (record only, do not promote)
  > **Why**: doesn't generalize beyond this specific harness's currently-configured agent registry, which may change; re-check availability each cycle rather than hardcoding the substitution as a rule.
