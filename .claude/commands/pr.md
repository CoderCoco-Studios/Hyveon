Create a pull request for the current branch, enforcing the repo's Conventional Commits title format.

## Steps

1. **Gather context** — run these in parallel:
   - `git log main..HEAD --oneline` — commits on this branch
   - `git diff main...HEAD --stat` — files changed
   - `git status` — any uncommitted work (warn if present)

2. **Check for a linked issue** — scan for issue references in the branch name and commit messages:
   - Look for patterns like `#123`, `fixes #123`, `closes #123`, or `issue-123` in `git log main..HEAD` output and the branch name
   - If found, note the issue number(s) — `Closes #N` will be required in the body
   - If not found, ask the user: "Does this PR resolve a GitHub issue? If so, what's the number?"
   - If the user confirms an issue, use `Closes #N`; if no issue, skip

3. **Derive a CC-formatted title.**
   - Format: `<type>(<optional-scope>): <imperative summary>`
   - `<type>` must be one of: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, `build`, `ci`, `style`
   - Keep the full title under 70 characters
   - Base the title on what the branch actually changes — use the commit log and diff stat as evidence, not just the branch name
   - If $ARGUMENTS is non-empty, treat it as the user's suggested title or type hint and incorporate it

4. **Validate before proceeding.**
   - The title must match: `^(feat|fix|refactor|docs|test|chore|perf|build|ci|style)(\([^)]+\))?: .+$`
   - The full title must be under 70 characters total
   - If either check fails, fix the title — do not create the PR with a non-conforming title

5. **Show the proposed title** to the user and ask for confirmation before creating the PR.

6. **Determine the base branch.**
   - Default: `main`.
   - If this branch is part of a stack (see `.claude/rules/pr-stacking.md` / the `gh-stack-prs` skill — check `gh stack view` or whether the branch name matches a `<theme>-<n>-<slug>` stack pattern), base on the *previous* group's branch instead of `main`.

7. **Create the PR** using `mcp__plugin_github_github__create_pull_request` with:
   - The validated title
   - A body with: `Closes #N` as the first line (if a linked issue exists), then a summary of what changed, why, and a test plan (bullet points)
   - Base branch: the one determined in step 6

8. **Return the PR URL** when done.
