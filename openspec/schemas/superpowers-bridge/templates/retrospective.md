# Retrospective: <change-name>

> Written: <YYYY-MM-DD> (after verify passed)
> Commit range: `<base-sha>..<head-sha>`
> Worktree: <path or "merged to main">

---

## 0. Evidence

> Quantitative front-matter data — later Wins / Misses bullets reference this
> directly, avoiding repeating [evidence: ...] on every line.
> Cold-write scenario (retro written some time after the cycle ended): this
> section should be reconstructable from just `git log` + `tasks.md` + commit
> messages.

- **Commit range**: `<base-sha>..<head-sha>` (<n> commits)
- **Diff size**: <+X / -Y lines across N files>
- **Tasks done**: <x>/<y> (`grep -cE '^\s*- \[x\]' tasks.md` → x; the regex allows for sub-task indentation)
- **Active hours**: <estimate>
- **Subagent dispatches**: <count or "n/a">
- **New external dependencies**: <list, with license + version, or "none">
- **Bugs encountered post-merge**: <count, one-line each, or "none">
- **OpenSpec validate state at archive**: <pass / fail / not-run>
- **Test coverage signal**: <e.g. jacoco %, pytest count, vitest count, or "n/a">

Commit chain (chronological):

```
<base-sha> <one-line summary>
...
<head-sha> <archive commit one-line>
```

---

## 1. Wins

- [evidence: <commit/file/test>] <description>

## 2. Misses

- 🔴 [blocking | evidence: ...] <description>
- 🟡 [painful  | evidence: ...] <description>
- 📌 [nit      | evidence: ...] <description>

## 3. Plan deviations

| Plan task | What changed | Why |
|-----------|--------------|-----|
| 1.2       | ...          | ... |

## 4. Skill / workflow compliance

| Skill                                            | Used |
|--------------------------------------------------|------|
| superpowers:brainstorming                        |      |
| superpowers:writing-plans                        |      |
| superpowers:using-git-worktrees                  |      |
| superpowers:subagent-driven-development          |      |
| (transitive) superpowers:test-driven-development |      |
| (transitive) superpowers:requesting-code-review  |      |
| superpowers:finishing-a-development-branch       |      |

> **Default expectation**: all ✓. Every skill is part of the schema's
> design — skipping one is an exceptional situation. Any ✗ MUST have its
> reason and prevention plan stated below in the
> `### Deliberately Skipped Skills` subsection.

### Deliberately Skipped Skills

> Skipping a skill is a designed escape hatch, not a normal path. Every ✗
> must answer the three questions below; a blank section (all green) is the
> expected state.

- **`<skill name>`**
  - **What was skipped**: <specifically, was the entire skill skipped, or just a sub-step>
  - **Why this cycle**: <the specific cycle conditions — do not write vague reasons like "not needed" / "too small" / "no time" / "blocked by an external dep" / "the skill's output looked wrong"; write the actual trigger (a specific commit / log line / observed behavior)>
  - **How to prevent recurrence**: how does the next cycle avoid skipping again under the same conditions? Pick one:
    - `schema graph fix` — write which specific section of schema.yaml needs to change
    - `skill description tightening` — write which skill's frontmatter / instruction needs to change, specifically
    - `CLAUDE.md trigger` — write which specific routing rule needs to be added to the adopter CLAUDE.md.fragment
    - `scope-judgment rule` — write how this specific cycle's scope should have been judged
    - `one-off — schema boundary case, no prevention possible` — but you must state exactly why it's a boundary case (vague hedging not accepted)

> **Relationship to §6 Promote candidates**: if multiple cycles skip the
> same skill with the same `How to prevent` answer → that pattern should be
> promoted to §6 and directly trigger a schema / skill PR — it must not be
> allowed to accumulate into "the new normal".

## 5. Surprises

- <assumption that turned out wrong>

## 6. Promote candidates → long-term learning

Each candidate uses a `- [ ]` checklist:

- Title: severity emoji (🔴/🟡/📌) + one-sentence learning
- `→ **Promote to** <destination>` (memory / CLAUDE.md / schema / skill / one-off)
- Two-line body (matches the superpowers feedback memory body schema):
  - `> **Why**: <reason; often a past incident or strong preference>`
  - `> **How to apply**: <when/where this guidance kicks in>`

An unchecked `- [ ]` means the candidate hasn't been promoted yet — it can
be carried into the next cycle's retro for re-evaluation, or kept as a
cross-cycle observation point.

> **Carry-forward mechanism**: when writing the next cycle's retro, run
> `grep -A 5 '^- \[ \]' openspec/changes/archive/*/retrospective.md` to pull
> out previously unchecked candidates, and decide item by item whether to
> carry each forward into this cycle's §6, promote it in place, or mark it
> stale and stop tracking it.

Example:

- [ ] 🔴 **<short rule>** → **Promote to memory** (type: feedback)
  > **Why**: <past incident or strong preference that motivated this rule>
  > **How to apply**: <which file / cycle phase / decision moment this kicks in>

- [ ] 🟡 **<another candidate>** → **Promote to project CLAUDE.md** (`<path/to/CLAUDE.md>` section)
  > **Why**: ...
  > **How to apply**: ...

- [ ] 📌 **<third candidate>** → **One-off** (record only, do not promote)
  > **Why**: <why it doesn't generalize>
