# PR Stacking for Large Changes

## Large changes must be split into a stack of PRs, not one giant PR

When a task is large enough that it naturally decomposes into multiple
logical groups of work — a multi-phase migration, an OpenSpec change with
several independent capability areas, or any change touching more than
roughly 5-6 files across unrelated concerns — implement it as a **stack of
small, individually-reviewable PRs**, each based on the previous one, rather
than a single PR containing the whole change.

**Why:** a single PR spanning dozens of files and multiple concerns is slow
and unreliable to review — reviewers (human or agent) either skim it and
miss real issues, or spend disproportionate effort on it. This repo has
already validated the pattern twice at scale: the `migrate-iac-to-pulumi`
change shipped as an 8-PR stack (`pulumi-1-foundation-infra` through
`pulumi-8-final-hardening`), and `add-one-click-aws-bootstrap` shipped as a
9-PR stack (`bootstrap-1-cfn-template` through `bootstrap-9-docs`). Both
kept each PR reviewable in isolation, let review findings from an earlier
group inform later ones instead of arriving all at once, and made it
possible to `/opsx:sync`/merge incrementally instead of holding one massive
diff in flight.

**How to apply:**

- **Decompose along real dependency lines, not arbitrary file count.** If
  the work has a natural plan/tasks breakdown (e.g. an OpenSpec change's
  `tasks.md` grouped into numbered sections), each group is usually one PR.
  Order groups by dependency — a group that depends on another group's
  code goes later in the stack, stacked on top of it.
- **One branch and one worktree per group, each based on the previous
  group's branch** — not on `main` (except the first group, which bases on
  `main`). Use `git worktree add -b <branch> .worktrees/<name> <base-branch>`
  with an explicit `<base-branch>` argument; the `EnterWorktree` tool's
  fresh/HEAD-only base-ref model can't express "branch from a specific
  prior feature branch," so use plain `git worktree add` for every hop
  after the first, matching this repo's own `pulumi-N-*`/`bootstrap-N-*`
  naming precedent.
- **Each PR's base branch is the previous group's branch**, not `main` —
  `gh pr create --base <previous-branch>` (a deliberate, disclosed
  deviation from `/pr`'s default of basing on `main`). Only the stack's
  first PR bases on `main`.
- **Each PR must independently pass this repo's full pre-PR gate**
  (`npm run app:lint`, `app:typecheck`, `app:test`, plus `app:test:integration`/
  `app:test:e2e` when applicable per `CLAUDE.md`) before opening it — a
  later group in the stack inheriting a broken earlier group compounds the
  problem.
- **Documentation updates can land in a dedicated, later PR in the same
  stack** rather than every individual PR, when the design explicitly calls
  for writing docs only once the full flow is verifiable end-to-end (see
  `add-one-click-aws-bootstrap`'s `design.md` Migration Plan and its
  `bootstrap-9-docs` PR) — this is a sanctioned exception to `CLAUDE.md`'s
  "docs in the same PR as the behaviour change" rule, not a blanket license
  to defer docs indefinitely. State the reason explicitly when doing this.
- **Small, self-contained changes stay as a single PR** — this rule does
  not apply to a typical bug fix, a one-file change, or anything that
  doesn't naturally decompose. Don't manufacture artificial groups to force
  stacking where a single PR is already reviewable.
