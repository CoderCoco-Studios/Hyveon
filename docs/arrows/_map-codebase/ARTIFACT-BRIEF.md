# Artifact-generation brief (Phase 5 of /map-codebase)

Repo: /home/chris/GitHub/Hyveon/worktrees/lid-conversion (run everything here; never cd to the main checkout). Date: 2026-10-30.

## Inputs you must read first
1. `docs/arrows/_map-codebase/final-clustering.md` — §1 row and §2 complete file list for YOUR leaf, plus §4 (boundary rulings), §5, §6 (sweep disagreements), §7 (active OpenSpec changes) entries that mention your leaf.
2. `docs/arrows/_map-codebase/inventory.md` — the functional-unit rows, cross-layer chains and findings-digest entries for your leaf's files.
3. The sweep files (`docs/arrows/_map-codebase/sweep-N.md`) that cover your files: grep them by path to pull the per-file entries and observed behaviours. Coverage: 1,2 web components; 3 web pages/hooks/lib; 4,5 desktop-main services; 6 desktop-main controllers/modules/root; 7 shared/preload/cloud-aws; 8 infra + lambdas; 9 e2e/CI/tooling; 10 docs + OpenSpec.
4. The OpenSpec specs your leaf carries: `openspec/specs/<capability>/spec.md` — read every requirement and scenario. Also any active change under `openspec/changes/<name>/specs/` mapped to your leaf in §7.
5. **The actual source files** in your leaf. Every claim you write must trace to file:line. When a sweep note and the code disagree, the code wins; say so.

## Design tree (16 leaves)
```
iac/            → run, engine, program
game-runtime/   → task-and-dns, watchdog, health-check
operator-app/   → wizard-and-bootstrap, diagnostics, infra-logs, app-update-and-release, desktop-shell, ipc-bridge
(flat)          → game-server, deployment-config, discord-bot, helper-task
```
EARS prefixes: IAC-RUN, IAC-ENGINE, IAC-PROGRAM, RT-TASK, RT-WATCHDOG, RT-HEALTH, APP-WIZARD, APP-DIAG, APP-LOGS, APP-UPDATE, APP-SHELL, APP-IPC, GAME, CONFIG, DISCORD, HELPER.

## Paths (node-as-folder, tree-mirrored)
| Artifact | Nested leaf (e.g. iac/run) | Flat leaf (e.g. game-server) |
|---|---|---|
| Arrow doc | `docs/arrows/iac/run.md` | `docs/arrows/game-server.md` |
| LLD | `docs/intent/iac/run/run-design.md` | `docs/intent/game-server/game-server-design.md` |
| EARS | `docs/intent/iac/run/run-specs.md` | `docs/intent/game-server/game-server-specs.md` |

Templates (read before writing):
- Arrow doc: `/home/chris/.claude/plugins/cache/jszmajda-lid/arrow-maintenance/1.4.2/skills/arrow-maintenance/references/arrow-doc-template.md`
- LLD: `/home/chris/.claude/plugins/cache/jszmajda-lid/linked-intent-dev/1.4.2/skills/linked-intent-dev/references/lld-templates.md`
- EARS: `/home/chris/.claude/plugins/cache/jszmajda-lid/linked-intent-dev/1.4.2/skills/linked-intent-dev/references/ears-syntax.md`

## Rules (from the map-codebase skill — non-negotiable)
- **Describe current reality, not aspirational design.** If the code is messy or contradicts docs, say so.
- **Every claim traces to file:line.** No speculation presented as fact; use "appears to" and `[inferred]` markers.
- **Repo markdown style:** no hard line wrap — one sentence/paragraph per line (see CLAUDE.md "Markdown formatting"). No em-dashes in prose. No task numbers or PR-history narration in doc bodies (except the arrow doc's Key Findings, which may cite PR numbers as evidence).
- Speak the project's language: use Hyveon's own names (deployment-config.json, RunTask, watchdog, helper task, stack outputs…).
- Do not edit any file outside your leaf's artifact paths. Do not touch code, openspec/, CLAUDE.md, or other leaves' docs.

## Wave 1: Arrow doc (status MAPPED)
Write ONLY the arrow doc for your leaf, following the arrow-doc template exactly. Fill:
- `# Arrow: {leaf-name}` + one-line description (from §1 Purpose).
- `## Status`: `**MAPPED** — mapped 2026-10-30 (git SHA `2822efd1`), not yet audited.` + one line on current state.
- `## References`: HLD → `docs/high-level-design.md` (not yet written; say so). LLD and EARS → the tree-mirrored paths from the table above (not yet written; list the path anyway). Tests → every test/spec file from your §2 list. Code → every non-test file from your §2 list, grouped by package. Also list "Cited from other leaves" (files owned elsewhere that your leaf depends on, per §4) and "OpenSpec sources" (the spec.md files and active changes carried, with their shipped/synced state from §7).
- `## Architecture`: Purpose + Key Components (5–12 bullets, each a real file/service/lambda with its role, file:line for entry points).
- `## Spec Coverage`: a table with one row per OpenSpec capability carried, columns `OpenSpec capability | requirements | scenarios | notes`; and a summary line saying EARS specs are not yet written (prefix reserved). Discord/watchdog/deployment-config: state "no OpenSpec capability; EARS will be authored from code".
- `## Key Findings`: 5–15 numbered findings with file:line — behaviours, invariants, bugs, stale comments, duplication, sweep disagreements from §6. Mark unverified sweep claims you could not confirm in code as `[unverified]`; mark ones you verified by reading the code as plain facts.
- `## Work Required`: Must Fix / Should Fix / Nice to Have from the findings (no spec IDs yet; say "spec IDs TBD").
Keep it an orientation page: pointers + status, not design prose.

## Wave 2: Skeleton LLD
Write ONLY `docs/intent/<segment-path>/<leaf>-design.md` for your leaf (create the folder). Read your leaf's arrow doc (`docs/arrows/<path>.md`, wave 1) first: it is your findings source, and the LLD must agree with it. Follow the LLD template (`lld-templates.md`, "Standard Structure") with brownfield content:

- Frontmatter: `parent: <grouping-node name, or high-level-design for flat leaves>` and `prefix: <EARS prefix>`.
- `# <Leaf name>` title using the project's noun (e.g. "IaC Run Lifecycle", "Discord Bot").
- `## Context and Design Philosophy`: why this subsystem exists, what it owns, what it deliberately does not own (cite the neighbouring leaves). Describe CURRENT reality. State the CLAUDE.md invariants that live here.
- 2–5 `## Major sections` describing how it works today: data shapes, state machines/lifecycles, IPC channels or Lambda triggers, storage, failure handling. Narrative where constraints interact, tables for channel/endpoint/config contracts. Every claim with file:line. Where current behaviour and documented intent (OpenSpec/docs) differ, say so explicitly in place.
- `## Decisions & Alternatives`: table `Decision | Chosen | Alternatives Considered | Rationale`. 6–15 rows. Rationale cells carry `[inferred]` unless the rationale is written in code comments, docs, or OpenSpec design.md (then cite it). Alternatives may be "unknown" if none is evidenced.
- `## Open Questions & Future Decisions`: `### Resolved` (empty or decisions evidenced in OpenSpec design docs) and `### Deferred`: every Must/Should Fix and every sweep disagreement from the arrow doc, phrased as a question with file:line, plus observed-but-unexplained behaviours and technical debt.
- `## References`: the arrow doc, the (future) specs file path, OpenSpec spec.md files carried, docs/docs pages that describe this area, neighbouring leaf design docs.
Do NOT write EARS requirement lines (`- [x] **ID**:`) in the design doc; those go in the specs file in wave 3. Length guide: 150–350 lines. Do not restate the arrow doc's file inventory.

## Wave 3: EARS spec file
Write ONLY `docs/intent/<segment-path>/<leaf>-specs.md` beside your design doc. Read `ears-syntax.md` fully first, then your arrow doc and design doc.

Content:
- Header: `# <Leaf name> Specs` + one line naming the prefix and the design doc. No frontmatter.
- `## <facet>` sections grouping specs by area. IDs are `<PREFIX>-<FACET>-<NNN>` where FACET is a short uppercase token (2–6 chars) you choose per facet (e.g. `IAC-RUN-LOCK-001`, `GAME-VALID-003`, `DISCORD-AUTH-002`). Number from 001 within each facet. Never reuse a number.
- One requirement per line: `- [x] **ID**: <EARS statement>` using the five EARS patterns (ubiquitous / When / While / Where / If…then). Scope must be explicit in the statement (see "Scope Disambiguation"), so a line read in isolation is unambiguous.
- **Source of specs, in priority order:**
  1. Every requirement + scenario in the OpenSpec `spec.md` files your leaf carries (and the delta specs of active changes mapped to your leaf that are shipped-but-unsynced, e.g. add-pinned-hostname, add-user-initiated-update-install, embed-file-browser for helper-task). Translate each scenario into one or more EARS lines; keep the OpenSpec requirement name in a trailing `(OpenSpec: <capability> / <requirement heading>)` note so the migration is traceable. Where an OpenSpec requirement is Terraform-era, HTTP-era, or otherwise no longer describes reality, drop it and list it under a final `## Dropped from OpenSpec` section with a one-line reason.
  2. Observed behaviours and invariants from your arrow doc and design doc that no OpenSpec requirement covers (CLAUDE.md invariants that live in your leaf, IPC contracts, state transitions, guards). Mark these `(observed)`.
- **Status markers, verified against code** (brownfield semantics): `[x]` = behaviour is implemented and you located the implementing code; `[ ]` = specified (by OpenSpec/docs) but broken, partial, or missing in current code (every Must Fix / Should Fix with a spec-able behaviour becomes a `[ ]` line); `[D]` = documented explicit non-want / deferred (rare).
- For each `[ ]` line, append `(gap: <file:line or "not implemented">)`.
- Aim for 40–120 specs for large leaves, 15–40 for small ones (watchdog, app-update, health-check). Do not pad.
- Do NOT add `@spec` annotations to code in this wave.
End with a count table in your reply (not the file): total, [x], [ ], [D], dropped-from-OpenSpec.
