---
name: honest-pr-review
description: Review a GitHub PR yourself — read past the diff, verify each finding against the real code, and post one review with line-anchored comments (COMMENT event on your own PRs)
metadata:
  version: "0.1.0"
  triggers:
    - honest.?review
    - review.?pr
    - review.?pull.?request
    - leave.?(a.)?review
    - line.?comments
---

# Honest PR Review

A first-person review of a pull request: you read the change, verify what it claims, and post a
single GitHub review whose findings are anchored to specific lines. "Honest" is the operative
word — every finding names a concrete failure, findings are ranked by whether they should block
the merge, and anything you did *not* verify is said out loud rather than implied.

This is **not** the CodeRabbit path. Pick the right tool:

| Want | Use |
|------|-----|
| An AI service to review the PR and post its own findings | `/code-review` (CodeRabbit) |
| To act on feedback CodeRabbit already left | `autofix` skill |
| CodeRabbit stuck behind a rate limit | `coderabbit-rate-limit-retry` skill |
| **You** to read the code and leave your own reviewed opinion | **this skill** |

## When to use

- The user asks you to review a PR, look at a PR, or leave a review on one.
- The user asks for an "honest" or "critical" read of a change.
- Before merging something substantial where a second read is worth the tokens.

## Steps

### 1. Pull the PR and its full context

```bash
gh pr view <PR_NUMBER> --json number,title,body,headRefName,baseRefName,author,state,additions,deletions,changedFiles,commits
gh pr diff <PR_NUMBER> > "$CLAUDE_JOB_DIR/tmp/pr<PR_NUMBER>.diff"   # or a scratch dir
gh pr diff <PR_NUMBER> --name-only
```

Note the **head SHA** from `commits` (the last entry's `oid`) — step 5 needs it.

Then fetch the head ref so you can read *whole files*, not just hunks:

```bash
git fetch origin <headRefName>:refs/remotes/origin/pr<PR_NUMBER> --force -q
git show refs/remotes/origin/pr<PR_NUMBER>:<path>
```

### 2. Read past the diff

This is the step that separates a real review from a diff-skim. A diff shows what changed; it
does not show what the change *assumes*. For every non-trivial hunk, go read:

- **The file it lives in, in full.** State initialisation, default values, and sibling effects
  are usually outside the hunk and are usually where the bug is.
- **The contract on the other side of every call it makes.** If the change consumes an async
  iterable, read whether that iterable throws or returns on failure. If it writes a file, read
  the sibling that already writes files and see whether this one matches.
- **The parent/caller.** A component's props tell you almost nothing about what values actually
  reach it at runtime.
- **The task/issue/spec the PR closes**, if it names one — a checked-off task whose
  implementation doesn't match its wording is a finding.

Concretely: most real findings come from asking *"what values can actually be in this variable
at this point?"* and following the answer backwards out of the diff.

### 3. Turn observations into findings

A finding earns a line comment only if you can state:

1. **What is wrong** — one sentence.
2. **A concrete failure** — specific inputs or a specific sequence, ending in the wrong
   behaviour. "Operator renames the bucket, closes the app, reopens → init runs against the
   default bucket name" is a finding. "This could be fragile" is not.
3. **What to do instead** — a direction, not necessarily a patch.

If you can't produce #2, either dig until you can or drop it. Padding a review with nits to look
thorough is the main way these reviews become noise.

Rank the survivors into **fix before merge** vs. **cheap/optional**, and say which is which. An
unranked list of ten items reads the same as an unranked list of two.

Give credit where it's due, briefly and specifically — "the never-throw degrade contract and the
streamId filtering are solid" is useful signal; "great work overall!" is not.

### 4. Compose the review as a JSON file

Write the whole review to a scratch JSON file rather than passing flags — bodies are multi-line
markdown and will not survive shell quoting.

```jsonc
{
  "commit_id": "<head SHA from step 1>",
  "event": "COMMENT",
  "body": "Top-level summary — the headline finding, then a ranked table of all findings, then an explicit note on what you did and did not verify.",
  "comments": [
    {
      "path": "app/packages/web/src/components/foo.tsx",
      "line": 91,
      "side": "RIGHT",
      "body": "**One-line claim.**\n\nWhy it happens (cite the specific state/default/contract you read in step 2).\n\nConcrete failure: ...\n\nSuggested fix: ..."
    }
  ]
}
```

Rules that will otherwise cost you a 422:

- **`line` must be a line the diff touches** — an added line, or a context line inside a hunk.
  A line outside every hunk is rejected and takes the *entire* review POST down with it.
  Confirm each anchor against the saved diff before posting.
- **`side: "RIGHT"`** for added/context lines; `"LEFT"` only for deleted lines.
- **`commit_id`** must be the PR head SHA, not `main` and not an older commit in the branch.
- For a range, add `start_line` + `start_side` alongside `line`. Single-line anchors are usually
  clearer.

### 5. Pick the right `event`

| Situation | `event` |
|-----------|---------|
| **You (the git user) opened the PR** | `COMMENT` — mandatory |
| Someone else opened it, and it's good | `APPROVE` |
| Someone else opened it, and something must change | `REQUEST_CHANGES` |

GitHub **rejects** `APPROVE` and `REQUEST_CHANGES` on your own pull request. In this repo the
common case is reviewing your own work, so `COMMENT` is the default. If the user names an event
explicitly, use theirs.

Check authorship before choosing:

```bash
gh pr view <PR_NUMBER> --json author --jq .author.login
gh api user --jq .login
```

### 6. Post it, then verify it attached

```bash
gh api repos/<OWNER>/<REPO>/pulls/<PR_NUMBER>/reviews --method POST --input review.json
```

Capture the returned review `id`, then confirm every line comment actually landed:

```bash
gh api repos/<OWNER>/<REPO>/pulls/<PR_NUMBER>/comments \
  --jq '.[] | select(.pull_request_review_id==<REVIEW_ID>) | "\(.path):\(.line)"'
```

The count must match `comments` in your JSON. If the POST 422'd, the usual cause is an anchor
outside the diff (step 4) — fix that line and re-post; nothing partial was created.

### 7. Report back

Lead with the review URL and the findings that block merge. Do not re-paste the whole review as
chat prose — the user can read it on GitHub. Two or three sentences on the headline findings,
then stop.

## Honesty rules

These are the point of the skill, not decoration:

- **Never claim to have run something you didn't.** If the PR body says "2080 tests passing" and
  you didn't re-run them, write "taking those as stated" in the review body. Either run the
  suite and report the real output, or say you didn't.
- **Separate verified from suspected.** If a finding rests on an ordering you reasoned about but
  didn't observe, say so in the comment ("today the read wins because effects run in declaration
  order — but that's the only thing keeping it correct").
- **Don't soften a real defect into a suggestion.** If resuming runs the deploy against the wrong
  state backend, that is a bug, and the comment says "bug", not "consider guarding".
- **Don't inflate a nit into a defect.** A duplicated constant with sync comments is a
  maintainability risk; label it that way and put it at the bottom.
- **Report what you skipped.** If you didn't read the infra program's side, or didn't check the
  e2e specs, name it. A review that implies full coverage it doesn't have is worse than a short one.

## Notes

- One review, not a stream of standalone comments. A single `POST /reviews` with a `comments`
  array groups everything under one collapsible review and sends one notification.
- Scratch files go in `$CLAUDE_JOB_DIR/tmp` when it's set (parallel background jobs clobber
  each other in `/tmp`).
- Reviewing does not mean fixing. Post the review, then let the user decide what to act on —
  unless they asked for both in the same breath.
- After the user acts on the review, the repo's normal PR-review-feedback rule applies: every
  thread ends in an affirmative fix-with-SHA or a reasoned decline, then gets resolved.
