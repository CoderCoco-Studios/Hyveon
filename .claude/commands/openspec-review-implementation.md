---
name: "OpenSpec: Review Implementation"
description: "Multi-agent review of an OpenSpec implementation PR — code correctness/cleanup plus tasks.md fidelity and delta-spec conformance"
allowed-tools: Bash(gh pr view:*), Bash(gh pr diff:*), Bash(gh pr comment:*), Bash(gh pr list:*), Bash(git diff:*), Bash(git log:*), Workflow, Edit
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
- an optional target — a PR number, a branch name, or a path; omit to use the current branch. To target a branch whose name collides with one of the six level names (e.g. a branch literally called `high` or `max`), pass it as `--target=<name>` instead of a bare token — a bare token matching a level name is always parsed as the level.

## Steps

1. **Parse `$ARGUMENTS` and resolve the target.**
   - Split on whitespace. A token starting with `--target=` sets the target explicitly (strip the prefix) and is never treated as a level, no matter what it matches. More than one `--target=` token is an error, stop and ask which one is intended. Among the remaining tokens: a token starting with `--` must be exactly `--fix` or `--comment` — any other `--flag` is a typo, stop and ask. A token matching one of the six level names (case-insensitive) is the level. Everything else is the target — at most one; more than one non-level/non-flag/non-`--target=` token, or a target given both as `--target=` and as a bare token, is an error, stop and ask which one is intended.
   - No level given → omit effort entirely (these commands have no memory of "the level last used"; don't guess one).
   - If a target was given (bare or via `--target=`) and it looks like a PR number, use `gh pr view <target> --json number,title,body,state,isDraft,headRefName,baseRefName,headRefOid` and `gh pr diff <target> --name-only`; the resolved `baseRefName` is `baseRefName` from that JSON. If a target was given and it names an existing local or remote branch (not a PR), resolve `baseRefName` as `git rev-parse --abbrev-ref <branch>@{upstream} 2>/dev/null | sed 's#^[^/]*/##'`, falling back to `main` if that branch has no upstream, then run `git diff <that resolved baseRefName>...<branch> --name-only`; there is no PR, so `prNumber` and `headRefOid` are `git rev-parse <branch>` and PR metadata is omitted from the report. If a target was given and it names an existing filesystem path instead, treat it as `changeDir` directly (skip step 2's change-identification) if it matches `openspec/changes/<name>`, otherwise stop and ask — arbitrary paths outside `openspec/changes/**` aren't a supported target for this command. If a target was given but doesn't resolve to a PR, branch, or path, stop and ask — do not silently fall back to the current branch. If no target was given at all, use the current branch: resolve `baseRefName` as `git rev-parse --abbrev-ref @{upstream} 2>/dev/null | sed 's#^[^/]*/##'`, falling back to `main` if no upstream is configured. Track which ref the diff actually used — `<that resolved baseRefName>` unless it doesn't exist locally, in which case fall back to `git diff @{upstream}...HEAD --name-only` and treat `@{upstream}` (not the stripped name) as the resolved base for the rest of this step. Use this same resolved base — the one the diff above actually ran against — for the `Workflow` call in step 3's `baseRefName` argument, so the command-side diff and the workflow's internal diff compare against an identical base.
   - Bail out (report why, do not proceed) if:
     - the PR is closed, merged, or a draft;
     - the changed files include none under `app/**`;
     - the changed files touch `openspec/changes/**` docs only, with no `app/**` code — that's a proposal PR; tell the user to run `/openspec-review-proposal` instead.

2. **Identify the change this PR implements.** Look for `Closes #N` in the PR body and the branch name (this repo's stacked-PR branches follow a `<change>-N-*` pattern per `.claude/rules/pr-stacking.md`). Cross-check against `openspec/changes/*/tasks.md` — the change whose tasks.md group matches the branch/PR. If no change can be confidently identified this way, ask the user to confirm the change directory (or confirm this PR isn't part of an OpenSpec change) before proceeding — do not silently invoke the Workflow with an unresolved `changeDir`.

3. **Call the `Workflow` tool** with `scriptPath` set to `.claude/workflows/openspec-review-implementation.js` and `args: { changeDir: "<name or null>", prNumber: <resolved PR number or null>, headRefOid: "<resolved head SHA or null>", baseRefName: "<the exact baseRefName resolved in step 1>", effort: "<level or null>" }`. Do not inline or re-derive the script — use the file as-is. (`ultra` is passed through as `effort: "ultra"`; the script maps it to `max` per-agent effort — there's no separate cloud tier here, unlike `/code-review ultra`.)

4. **Apply fixes, then present findings and confirm before posting.**
   - **If `--fix` was passed:** apply every `CONFIRMED` finding directly to the reviewed files (in `app/**` and/or `openspec/changes/<name>/`, whichever the finding is under) with the Edit tool. Leave `PLAUSIBLE` findings untouched and call them out in the report as needing manual judgment. This is a tracked-file edit — per `.claude/rules/worktree.md`, it must happen in a worktree: if already isolated (current branch, already in a worktree), edit in place; for a branch name, reuse a matching worktree from `git worktree list` or create one from `origin/<branch>`; for a PR number, fetch its head ref (`git fetch origin pull/<n>/head:<local-branch>`, using `headRefName` from step 1) into a worktree. After editing, run `git diff --stat` and summarize what changed. **Do not commit or push** — `--fix` only authorizes local edits; state the worktree path/branch in step 5 so the user can review, run the relevant gates (lint/typecheck/test per CLAUDE.md), and push themselves. If no findings were `CONFIRMED`, say so and skip this sub-step.
   - Format the returned `findings` into a single PR comment body, same format and citation rules as `/openspec-review-proposal` step 4 (full-SHA GitHub blob links, `#L[start]-[end]`, brief, no emoji, `🤖 Generated with [Claude Code](https://claude.ai/code)` footer). If `--fix` applied any findings, note which ones were auto-fixed and state explicitly that those fixes are **local, unpushed edits** in the worktree noted in step 5 — not yet part of the PR — so the comment cannot be read as claiming the PR itself was fixed.
   - **If `--comment` was passed and there's a PR:** post it immediately with `gh pr comment <PR> --body-file <scratch-file>` — no confirmation gate. **Otherwise:** show the drafted comment and ask for explicit confirmation before posting. If there's no PR, present the findings in chat instead (and note that `--comment` was a no-op if it was passed).

5. **Report back.** State the PR/comment URL (if posted), the worktree path/branch if `--fix` applied edits, a one-line summary, and surface the sync-readiness note from the workflow's `summary` field if present.
