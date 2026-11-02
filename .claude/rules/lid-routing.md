## Workflow routing

Changes are routed by risk through Linked-Intent Development (LID): `HLD → LLDs → EARS → tests → code`, with the `linked-intent-dev` skill driving the phases.
The design tree is `docs/high-level-design.md` and `docs/intent/`; the arrow overlay is `docs/arrows/`; the `arrow-maintenance` skill audits it; `npm run lid:check` (`node bin/coherence-check.mjs --strict`) checks it deterministically and must exit 0 before a PR that touches the arrow.

### Entry routing

| Trigger you observe | What to do |
|---|---|
| New feature, new capability, architectural change, or a change to an external contract, schema, or cross-system integration | Walk the arrow: HLD check → LLD → EARS specs → edge audit → failing tests first → code. Stop for inspection by the user (or an inspector they name) after each phase before the next begins |
| Bug fix | Also walk the arrow. Find where behaviour diverged from intent and cascade from that level; a bug fix has no short-circuit, though it often touches only an EARS line, its tests, and the code |
| Typo, config value tweak, docs-only change, test backfill, linter tweak, non-breaking dependency upgrade | Direct PR — no design or spec change needed |
| User starts a narrative "design discussion / let's brainstorm" | Keep it verbal. Do not write design docs or specs until the conversation converges (see below), then start at the HLD or LLD phase |
| User is mid-change | Resume at the phase the arrow shows (`docs/arrows/index.yaml` status, the owning `<node>-specs.md` markers) rather than restarting |

Principle: **process ceremony scales with risk**. External contracts, schema, cross-system integration, and compliance walk the full arrow. Everything else that does not alter specified behaviour goes straight to a PR.

### Brainstorm → arrow promotion criteria

All 5 must hold before writing design or spec docs (any missing → keep brainstorming):

1. **Scope locked** — one sentence describes what's in / out
2. **Major design forks resolved** — alternatives weighed; remaining TBDs have an owner and impact-scope statement
3. **Cross-system dependencies mapped** — ready / mockable / genuinely unknown — pick one per dep
4. **Acceptance criteria stateable** — concrete pass conditions that become EARS lines
5. **Conversation converging** — recent turns are confirmations, not new alternatives

When all 5 hold, proactively suggest "ready to start the arrow at the LLD?" and wait for the user's ack. Never auto-trigger.

### Anti-patterns

- Writing code before the owning EARS lines exist and their tests fail
- Cascading across an arrow-segment boundary without pausing for the user
- Starting the arrow with unresolved blocking TBDs
- Skipping the arrow for a bug fix because "it's small" when it changes specified behaviour
- Recording project intent in agent memory instead of the design tree
