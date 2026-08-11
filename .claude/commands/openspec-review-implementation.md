---
name: "OpenSpec: Review Implementation"
description: "Multi-agent review of an OpenSpec implementation PR — code correctness/cleanup plus tasks.md fidelity and delta-spec conformance"
allowed-tools: Bash(gh pr view:*), Bash(gh pr diff:*), Bash(gh pr comment:*), Bash(gh pr list:*), Bash(git diff:*), Bash(git log:*)
category: "Review"
tags: ["review", "openspec", "workflow"]
---

Review an OpenSpec **implementation** PR — a PR that implements a change's `tasks.md` in
`app/` code. For a PR that only edits `openspec/changes/<name>/{proposal,design,tasks}.md` and
delta specs, use `/openspec-review-proposal` instead.

**Input**: `$ARGUMENTS` accepts, in any order, separated by whitespace:
- an optional level — one of `low`, `medium`, `high`, `xhigh`, `max`, `ultra`
- an optional `--fix` flag
- an optional `--comment` flag
- an optional target — a PR number, a branch name, or a path; omit to use the current branch

## Steps

1. **Parse `$ARGUMENTS` and resolve the target.**
   - Split on whitespace. A token matching one of the six level names (case-insensitive) is the level. A token starting with `--` must be exactly `--fix` or `--comment` — any other `--flag` is a typo, stop and ask. Everything else is the target — at most one; more than one non-level/non-flag token is an error, stop and ask which one is intended.
   - No level given → omit effort entirely (these commands have no memory of "the level last used"; don't guess one).
   - If the target looks like a PR number or branch, use `gh pr view <target> --json number,title,body,state,isDraft,headRefName,baseRefName,headRefOid` and `gh pr diff <target> --name-only`. Otherwise use the current branch: `git diff main...HEAD --name-only` (fall back to `git diff @{upstream}...HEAD`).
   - Bail out (report why, do not proceed) if:
     - the PR is closed, merged, or a draft;
     - the changed files include none under `app/**`;
     - the changed files touch `openspec/changes/**` docs only, with no `app/**` code — that's a proposal PR; tell the user to run `/openspec-review-proposal` instead.

2. **Identify the change this PR implements.** Look for `Closes #N` in the PR body and the branch name (this repo's stacked-PR branches follow a `<change>-N-*` pattern per `.claude/rules/pr-stacking.md`). Cross-check against `openspec/changes/*/tasks.md` — the change whose tasks.md group matches the branch/PR. If no change can be confidently identified this way, ask the user to confirm the change directory (or confirm this PR isn't part of an OpenSpec change) before proceeding — do not silently invoke the Workflow with an unresolved `changeDir`.

3. **Call the `Workflow` tool** with `scriptPath` set to `.claude/workflows/openspec-review-implementation.js` and `args: { changeDir: "<name or null>", prNumber: <resolved PR number or null>, headRefOid: "<resolved head SHA or null>", baseRefName: "<resolved base branch>", effort: "<level or null>" }`. Do not inline or re-derive the script — use the file as-is. (`ultra` is passed through as `effort: "ultra"`; the script maps it to `max` per-agent effort — there's no separate cloud tier here, unlike `/code-review ultra`.)

4. **Apply fixes, then present findings and confirm before posting.**
   - **If `--fix` was passed:** apply every `CONFIRMED` finding directly to the reviewed files (in `app/**` and/or `openspec/changes/<name>/`, whichever the finding is under) with the Edit tool. Leave `PLAUSIBLE` findings untouched and call them out in the report as needing manual judgment. This is a tracked-file edit — per `.claude/rules/worktree.md`, it must happen in a worktree: if already isolated (current branch, already in a worktree), edit in place; for a branch name, reuse a matching worktree from `git worktree list` or create one from `origin/<branch>`; for a PR number, fetch its head ref (`git fetch origin pull/<n>/head:<local-branch>`, using `headRefName` from step 1) into a worktree. After editing, run `git diff --stat` and summarize what changed. **Do not commit or push** — `--fix` only authorizes local edits; state the worktree path/branch in step 5 so the user can review, run the relevant gates (lint/typecheck/test per CLAUDE.md), and push themselves. If no findings were `CONFIRMED`, say so and skip this sub-step.
   - Format the returned `findings` into a single PR comment body, same format and citation rules as `/openspec-review-proposal` step 4 (full-SHA GitHub blob links, `#L[start]-[end]`, brief, no emoji, `🤖 Generated with [Claude Code](https://claude.ai/code)` footer). If `--fix` applied any findings, note which ones were auto-fixed.
   - **If `--comment` was passed and there's a PR:** post it immediately with `gh pr comment <PR> --body-file <scratch-file>` — no confirmation gate. **Otherwise:** show the drafted comment and ask for explicit confirmation before posting. If there's no PR, present the findings in chat instead (and note that `--comment` was a no-op if it was passed).

5. **Report back.** State the PR/comment URL (if posted), the worktree path/branch if `--fix` applied edits, a one-line summary, and surface the sync-readiness note from the workflow's `summary` field if present.
