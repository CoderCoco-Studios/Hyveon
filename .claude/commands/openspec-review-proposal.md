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

**Input**: `$ARGUMENTS` is a PR number, a branch name, or empty (use the current branch).

## Steps

1. **Resolve the target and check eligibility.**
   - If `$ARGUMENTS` looks like a PR number or branch, use `gh pr view <target> --json number,title,state,isDraft,headRefName,baseRefName,headRefOid` and `gh pr diff <target> --name-only`. Otherwise use the current branch: `git diff main...HEAD --name-only` (fall back to `git diff @{upstream}...HEAD`); resolve `headRefOid` as `git rev-parse HEAD` in that case.
   - Bail out (report why, do not proceed) if:
     - the PR is closed, merged, or a draft;
     - the changed files include none under `openspec/changes/**`;
     - the changed files include any under `app/**` — that's an implementation PR; tell the user to run `/openspec-review-implementation` instead.
     - the changed files include any path NOT under `openspec/changes/**` (e.g. `.github/**`, root config, unrelated docs) — this is a mixed-scope PR; tell the user to split it before requesting a proposal review.

2. **Identify the change directory (or directories).** From the changed-file list, extract the distinct `openspec/changes/<name>/` prefixes touched. If more than one, repeat steps 3-5 once per change directory.

3. **Call the `Workflow` tool** with `scriptPath` set to `.claude/workflows/openspec-review-proposal.js` and `args: { prNumber: <resolved PR number or null>, headRefOid: "<resolved head SHA or null>", changeDir: "<name>" }`. Do not inline or re-derive the script — use the file as-is.

4. **Present findings and confirm before posting.** Format the returned `findings` into a single PR comment body:
   - Heading `### OpenSpec proposal review`
   - `Found N issues:` (or `No issues found. Checked scenario format, cross-document coherence, delta-spec correctness, conflicts, and conventions.`)
   - Numbered list, each with a one-line description and a full-SHA GitHub blob link with line range, e.g. `https://github.com/<owner>/<repo>/blob/<full-sha>/openspec/changes/<name>/specs/<capability>/spec.md#L12-L18` (get the full SHA via `git rev-parse HEAD` or the PR's head SHA from `gh pr view --json headRefOid`; at least 1 line of context before/after the cited line).
   - Footer: `🤖 Generated with [Claude Code](https://claude.ai/code)`

   Show this drafted comment to the user and ask for explicit confirmation before running `gh pr comment <PR> --body-file <scratch-file>` — posting to a PR is visible to others. If there's no PR (reviewing a local branch), just present the findings in chat instead of posting anything.

5. **Report back.** State the PR/comment URL (if posted) and a one-line summary of what was found.
