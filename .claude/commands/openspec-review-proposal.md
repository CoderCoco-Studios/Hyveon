---
name: "OpenSpec: Review Proposal"
description: "Multi-agent review of an OpenSpec proposal PR — scenario well-formedness, cross-document coherence, delta-spec correctness, conflicts, and conventions"
allowed-tools: Bash(gh pr view:*), Bash(gh pr diff:*), Bash(gh pr comment:*), Bash(gh pr list:*), Bash(git diff:*), Bash(git log:*)
category: "Review"
tags: ["review", "openspec", "workflow"]
---

Review an OpenSpec **proposal** PR — a PR that only adds/edits
`openspec/changes/<name>/{proposal,design,tasks}.md` and delta spec files, with no `app/` code.
For a PR that implements a change's `tasks.md`, use `/openspec-review-implementation` instead.

**Input**: `$ARGUMENTS` accepts, in any order, separated by whitespace:
- an optional level — one of `low`, `medium`, `high`, `xhigh`, `max`, `ultra`
- an optional `--fix` flag
- an optional `--comment` flag
- an optional target — a PR number or a branch name; omit to use the current branch. To target a branch whose name collides with one of the six level names (e.g. a branch literally called `high` or `max`), pass it as `--target=<name>` instead of a bare token — a bare token matching a level name is always parsed as the level.

## Steps

1. **Parse `$ARGUMENTS` and resolve the target.**
   - Split on whitespace. A token starting with `--target=` sets the target explicitly (strip the prefix) and is never treated as a level, no matter what it matches. Among the remaining tokens: a token starting with `--` must be exactly `--fix` or `--comment` — any other `--flag` is a typo, stop and ask. A token matching one of the six level names (case-insensitive) is the level. Everything else is the target — at most one; more than one non-level/non-flag/non-`--target=` token, or a target given both as `--target=` and as a bare token, is an error, stop and ask which one is intended.
   - No level given → omit effort entirely (these commands have no memory of "the level last used"; don't guess one).
   - If a target was given (bare or via `--target=`) and it looks like a PR number or branch, use `gh pr view <target> --json number,title,state,isDraft,headRefName,baseRefName,headRefOid` and `gh pr diff <target> --name-only`. If a target was given but doesn't resolve to a PR/branch, stop and ask — do not silently fall back to the current branch. If no target was given at all, use the current branch: `git diff main...HEAD --name-only` (fall back to `git diff @{upstream}...HEAD`); resolve `headRefOid` as `git rev-parse HEAD` in that case.
   - Bail out (report why, do not proceed) if:
     - the PR is closed, merged, or a draft;
     - the changed files include none under `openspec/changes/**`;
     - the changed files include any under `app/**` — that's an implementation PR; tell the user to run `/openspec-review-implementation` instead.
     - the changed files include any path NOT under `openspec/changes/**` (e.g. `.github/**`, root config, unrelated docs) — this is a mixed-scope PR; tell the user to split it before requesting a proposal review.

2. **Identify the change directory (or directories).** From the changed-file list, extract the distinct `openspec/changes/<name>/` prefixes touched. If more than one, repeat steps 3-5 once per change directory.

3. **Call the `Workflow` tool** with `scriptPath` set to `.claude/workflows/openspec-review-proposal.js` and `args: { prNumber: <resolved PR number or null>, headRefOid: "<resolved head SHA or null>", changeDir: "<name>", effort: "<level or null>" }`. Do not inline or re-derive the script — use the file as-is. (`ultra` is passed through as `effort: "ultra"`; the script maps it to `max` per-agent effort — there's no separate cloud tier here, unlike `/code-review ultra`.)

4. **Apply fixes, then present findings and confirm before posting.**
   - **If `--fix` was passed:** apply every `CONFIRMED` finding directly to the reviewed `openspec/changes/<name>/` files with the Edit tool. Leave `PLAUSIBLE` findings untouched and call them out in the report as needing manual judgment. This is a tracked-file edit — per `.claude/rules/worktree.md`, it must happen in a worktree: if already isolated (current branch, already in a worktree), edit in place; for a branch name, reuse a matching worktree from `git worktree list` or create one from `origin/<branch>`; for a PR number, fetch its head ref (`git fetch origin pull/<n>/head:<local-branch>`, using `headRefName` from step 1) into a worktree. After editing, run `git diff --stat` and summarize what changed. **Do not commit or push** — `--fix` only authorizes local edits; state the worktree path/branch in step 5 so the user can review and push themselves. If no findings were `CONFIRMED`, say so and skip this sub-step.
   - Format the returned `findings` into a single PR comment body:
     - Heading `### OpenSpec proposal review`
     - `Found N issues:` (or `No issues found. Checked scenario format, cross-document coherence, delta-spec correctness, conflicts, and conventions.`)
     - Numbered list, each with a one-line description and a full-SHA GitHub blob link with line range, e.g. `https://github.com/<owner>/<repo>/blob/<full-sha>/openspec/changes/<name>/specs/<capability>/spec.md#L12-L18` (get the full SHA via `git rev-parse HEAD` or the PR's head SHA from `gh pr view --json headRefOid`; at least 1 line of context before/after the cited line). If `--fix` applied any findings, note which ones were auto-fixed and state explicitly that those fixes are **local, unpushed edits** in the worktree noted in step 5 — not yet part of the PR — so the comment cannot be read as claiming the PR itself was fixed.
     - Footer: `🤖 Generated with [Claude Code](https://claude.ai/code)`
   - **If `--comment` was passed and there's a PR:** post it immediately with `gh pr comment <PR> --body-file <scratch-file>` — no confirmation gate. **Otherwise:** show the drafted comment and ask for explicit confirmation before posting — posting to a PR is visible to others. If there's no PR (reviewing a local branch), just present the findings in chat instead of posting anything (and note that `--comment` was a no-op if it was passed).

5. **Report back.** State the PR/comment URL (if posted), the worktree path/branch if `--fix` applied edits, and a one-line summary of what was found.
