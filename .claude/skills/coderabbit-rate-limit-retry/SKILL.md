---
name: coderabbit-rate-limit-retry
description: Read CodeRabbit's "Review limit reached" comment on a PR, wait out the stated cooldown, then trigger a re-review with `@coderabbitai review`
metadata:
  version: "0.1.0"
  triggers:
    - coderabbit.?rate.?limit
    - coderabbit.?review.?limit
    - review.?limit.?reached
    - retry.?coderabbit
    - coderabbit.?cooldown
---

# CodeRabbit Rate-Limit Retry

CodeRabbit occasionally replies to a PR with a "Review limit reached" comment instead of a
review, under its Fair Usage Limits Policy. That comment names a cooldown ("Next review
available in: **N minutes**") measured from *when CodeRabbit posted the comment*, not from
whenever you happen to read it. This skill reads that comment, computes the real remaining
wait, and re-triggers the review once the cooldown has actually elapsed.

## When to use

- The user asks to check on / retry / unblock a CodeRabbit review that hit a rate limit.
- You notice a PR has a CodeRabbit comment containing "Review limit reached" or the HTML
  marker `<!-- This is an auto-generated comment: rate limited by coderabbit.ai -->` and no
  actual review followed.

## Steps

### 1. Find the rate-limit comment

```bash
gh pr view <PR_NUMBER> --json comments --jq '
  .comments[]
  | select(.author.login | test("coderabbit"))
  | select(.body | test("rate limited by coderabbit\\.ai"))
  | {body, createdAt}
'
```

If nothing matches, there is no active rate limit — stop here and tell the user so (don't
guess a wait time or comment blind).

### 2. Extract the cooldown and compute the real wait

Pull two things out of the matched comment:

- `createdAt` — an ISO 8601 timestamp, already in the JSON.
- The cooldown, from the line `**Next review available in:** **N minutes**` (or "N hours" —
  handle both units).

Compute seconds remaining from *now*, not a flat re-read of "N minutes":

```bash
python3 -c "
from datetime import datetime, timezone
created = datetime.fromisoformat('<createdAt>'.replace('Z', '+00:00'))
available_at = created.timestamp() + <N> * 60   # multiply by 3600 instead if the unit was hours
remaining = available_at - datetime.now(timezone.utc).timestamp()
print(max(0, remaining))
"
```

Add a small safety buffer (30–60s) on top of the computed remainder — CodeRabbit's stated
cooldown is a rounded estimate, and firing exactly on the boundary risks hitting the limit
again and burning another cooldown cycle.

### 3. Wait it out without blocking the conversation

- If the remaining wait is small (a couple of minutes), run the wait + retry as a single
  **backgrounded** Bash command so the conversation isn't stuck idle:

  ```bash
  sleep <seconds> && gh pr comment <PR_NUMBER> --body "@coderabbitai review"
  ```

  Launch with `run_in_background: true`. Continue other work; you'll get a completion
  notification when it posts.

- If the remaining wait is long (tens of minutes or more), don't hold a giant `sleep` open.
  Tell the user the specific available-at time and either move on, or use the `schedule`
  skill / a cron-style follow-up if the user wants to be reminded rather than have you sit on
  it.

### 4. Handle a repeat rate limit

Sustained high review volume can trigger the limit again right after a retry. If the comment
posted after step 3 is *also* a rate-limit comment, repeat from step 1 with the new comment
— don't loop blindly on a fixed guess.

### 5. Report outcome

State plainly what happened: the wait time used, that the `@coderabbitai review` comment was
posted, and the PR link. If a real review follows, you don't need to do anything further —
CodeRabbit posts it on its own once it runs.

## Notes

- Never comment `@coderabbitai review` speculatively "just in case" — always confirm an
  active rate-limit comment first (step 1). Commenting when there's no limit just spends a
  review needlessly on paid plans, or does nothing on unpaid ones.
- This skill only unblocks a *stuck* review after a rate limit. For acting on the feedback
  once a review does land, use the `autofix` skill instead.
