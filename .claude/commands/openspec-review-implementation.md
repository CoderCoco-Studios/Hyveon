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

**Input**: `$ARGUMENTS` is a PR number, a branch name, or empty (use the current branch).

## Steps

1. **Resolve the target and check eligibility.**
   - If `$ARGUMENTS` looks like a PR number or branch, use `gh pr view <target> --json number,title,body,state,isDraft,headRefName,baseRefName,headRefOid` and `gh pr diff <target> --name-only`. Otherwise use the current branch: `git diff main...HEAD --name-only` (fall back to `git diff @{upstream}...HEAD`).
   - Bail out (report why, do not proceed) if:
     - the PR is closed, merged, or a draft;
     - the changed files include none under `app/**`;
     - the changed files touch `openspec/changes/**` docs only, with no `app/**` code — that's a proposal PR; tell the user to run `/openspec-review-proposal` instead.

2. **Identify the change this PR implements.** Look for `Closes #N` in the PR body and the branch name (this repo's stacked-PR branches follow a `<change>-N-*` pattern per `.claude/rules/pr-stacking.md`). Cross-check against `openspec/changes/*/tasks.md` — the change whose tasks.md group matches the branch/PR. If no change can be confidently identified this way, ask the user to confirm the change directory (or confirm this PR isn't part of an OpenSpec change) before proceeding — do not silently invoke the Workflow with an unresolved `changeDir`.

3. **Call the `Workflow` tool** with `scriptPath` set to `.claude/workflows/openspec-review-implementation.js` and `args: { changeDir: "<name or null>", prNumber: <resolved PR number or null>, headRefOid: "<resolved head SHA or null>", baseRefName: "<resolved base branch>" }`. Do not inline or re-derive the script — use the file as-is.

4. **Present findings and confirm before posting.** Format the returned `findings` into a single PR comment body, same format and citation rules as `/openspec-review-proposal` step 4 (full-SHA GitHub blob links, `#L[start]-[end]`, brief, no emoji, `🤖 Generated with [Claude Code](https://claude.ai/code)` footer). Show the drafted comment to the user and ask for explicit confirmation before `gh pr comment <PR> --body-file <scratch-file>`. If there's no PR, present the findings in chat instead.

5. **Report back.** State the PR/comment URL (if posted), a one-line summary, and surface the sync-readiness note from the workflow's `summary` field if present.
