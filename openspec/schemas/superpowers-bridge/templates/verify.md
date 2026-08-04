# Verification Report

> This file is produced by the `openspec-verify-change` skill after apply
> completes, to confirm the implementation is consistent with specs / design /
> tasks. A failed check must go back to the relevant artifact for a fix, then
> verify re-runs.

**Change**: `<change-name>`
**Verified at**: `YYYY-MM-DD HH:mm`
**Verifier**: `<who / which agent>`

---

## 1. Structural Validation (`openspec validate --all --json`)

- [ ] All items `"valid": true`

**Result**:

```text
<paste the openspec validate --all output summary>
```

If there are failing items, list id + issues:

| Item | Type | Issues |
|---|---|---|
| — | — | — |

---

## 2. Task Completion (`tasks.md`)

- [ ] All `- [ ]` have become `- [x]`

**Incomplete tasks** (if any):

| Task | Reason incomplete | Blocks archive? |
|---|---|---|
| — | — | — |

---

## 3. Delta Spec Sync State

For each capability directory under `openspec/changes/<name>/specs/`, compare
against `openspec/specs/<capability>/spec.md`:

| Capability | Sync status | Notes |
|---|---|---|
| — | ✓ synced / ✗ pending sync / N/A | — |

---

## 4. Design / Specs Coherence Spot Check

Spot-check whether `design.md`'s decisions are reflected in the Requirements
and Scenarios of `specs/*.md`:

| Sample item | design description | specs mapping | Gap |
|---|---|---|---|
| — | — | — | — |

**Drift warning** (non-blocking):

- <list if any; otherwise write "None">

---

## 5. Implementation Signal

- [ ] No unstaged files in the worktree
- [ ] All relevant commits have been pushed

**Commit range** (if known): `<from-sha>..<to-sha>`

---

## 6. Front-Door Routing Leak Detector

Design output should not land in `docs/superpowers/specs/` (the brainstorm
artifact's output redirection should route it to
`openspec/changes/<name>/brainstorm.md` instead).

Detection:

```bash
ls docs/superpowers/specs/*.md 2>/dev/null
```

- [ ] No files, or any existing files are legitimate leftovers from before
      the schema was installed

**Leak list** (if any):

| File | Produced this cycle? | Content already captured in the change? | Suggested action |
|---|---|---|---|
| — | — | — | — |

> A leak produced by the current schema-installed cycle blocks PASS and
> archive. Move it into `openspec/changes/<name>/brainstorm.md` or
> `design.md`, then delete the original file. Leaks that predate the
> schema install (legitimate pre-existing use of the directory) remain
> non-blocking.

---

## 7. Deferred Manual Dogfood vs Automated Test Equivalence

For each manual dogfood / smoke task marked `[~]` deferred in plan.md, list
the equivalent automated test coverage item by item. If there is no
equivalent automated test, that item should be treated as a **real gap**
rather than a reasonable deferral — record it in the retrospective Misses
section.

| Deferred dogfood (plan §) | Equivalent automated test | Coverage assessment | Real gap? |
|---|---|---|---|
| e.g.: §11.3 `compose up + curl /actuator/health` | `LinebcIntegrationApplicationTests` (Testcontainers, 24s) | Spring context boot + Flyway migration completes + key bean injection | ❌ already equivalently covered |
| — | — | — | — |

> **Judgment rules**:
> - "Equivalent" = the automated test's assertion set is a superset of the manual dogfood's expected assertions
> - "Coverage assessment" = list the layers actually touched (context / DB schema / wiring / HTTP path / etc.)
> - Any row where "Real gap = ✅" can still let the Overall Decision be PASS, but a follow-up item must be left in the retrospective
>
> **When this section can be left blank**: when plan.md has no rows marked
> `[~]` at all, this section doesn't need to be filled in (blank = PASS).
> As soon as plan.md has any `[~]`, this section MUST list them item by item,
> otherwise the Overall Decision must be downgraded to FAIL.

---

## Overall Decision

- [ ] ✅ PASS — may proceed to finishing-a-development-branch and archive
- [ ] ⚠️ PASS WITH WARNINGS — may proceed but note: `<explanation>`
- [ ] ❌ FAIL — go back to the failing artifact, fix it, then re-run verify

**Next step**:

<describe the next action>
