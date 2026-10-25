# Worktrees

Worktrees are created through Pane (`runpane`), never by Claude directly. One feature = one worktree = one branch = one Pane.

Hooks (don't restate or re-check these):

- `.claude/hooks/guard-main-checkout.ts` denies Edit/Write/NotebookEdit on a file in a repo's main checkout, and `git add|commit|merge|rebase|reset` run there. It judges the target file's own repo, not the session cwd.
- `.claude/hooks/guard-redirect-to-pane.ts` denies `EnterWorktree` and raw `git worktree add`, with the Pane instructions as the deny reason.

Judge these yourself:

1. **Reuse before creating.** `git worktree list` and `mcp__pane__panes_list` first. A Pane already exists for the branch → add a tab with `panels_create` (or `agents_start` with `pane: <id>`). None → start a session in a fresh worktree via the `pane` skill / `mcp__pane__agents_start` with the task prompt.
2. **Setup.** Pane's own setup installs dependencies. If `node_modules` looks stale (e.g. `realpathSync('node_modules/@hyveon/<pkg>')` resolves outside the worktree), run `npm ci` before lint/typecheck/test/build.
3. **Subagents.** For parallel subagents each needing an isolated branch, use `Agent({ isolation: "worktree", ... })` (harness-managed, unaffected by the hooks) or a Pane tab. If the agent needs a specific existing branch, have its prompt run `git fetch origin <branch> && git checkout --detach origin/<branch>` first — a plain `git checkout <branch>` fails when that branch is checked out in another worktree.
4. **PR stacks.** First group branches from `main`; later groups from the previous group's branch (fetch that base first). Stack mechanics: see `pr-stacking.md` and the `gh-stack` skill.
