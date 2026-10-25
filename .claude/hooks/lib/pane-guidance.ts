/**
 * Guidance text shared by the guards that steer worktree creation toward Pane.
 */

/** Tells the agent how to get an isolated worktree through Pane instead of EnterWorktree or raw `git worktree add`. */
export const PANE_GUIDANCE =
  'Worktrees are created through Pane. ' +
  '1) Call `mcp__pane__panes_list` and reuse an existing Pane for this branch (add a tab with `panels_create`). ' +
  '2) Otherwise start a new session in a fresh worktree with `mcp__pane__agents_start` (or the `pane` skill), passing the task prompt. ' +
  'Do not use EnterWorktree or raw `git worktree add`. See .claude/rules/worktree.md.';
