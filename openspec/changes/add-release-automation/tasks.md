## 1. Changelog & version-bump engine

- [x] 1.1 Add root `cliff.toml` configuring commit parser groups for `feat|fix|refactor|docs|test|chore|perf|build|ci|style`, breaking-change detection, and `--context` JSON output shape.
- [x] 1.2 Verify `npx git-cliff@2.13.1` locally against this repo's actual commit history: `--unreleased`, an explicit `<from>..<to>` range, `--bumped-version`, `--bump major|minor|patch`, and `--context` all produce sane output.
- [x] 1.3 Confirm behavior with zero prior tags (first-release case) - range should fall back to full history up to `to`.

## 2. AI release-notes step

- [x] 2.1 Wire an `anthropics/claude-code-action@v1` step, authenticated via `CLAUDE_CODE_OAUTH_TOKEN` (bills against the Claude subscription that minted the token, not metered API usage - see design.md), with a `prompt` that reads the git-cliff `--context` JSON and rendered changelog from the checkout and writes a Markdown "what's new" summary, grounded in changelog facts only, to `release-notes.md`.
- [x] 2.2 Restrict the step to `claude_args: '--allowedTools "Read,Write" --max-turns 5'` so it can only read the changelog files and write the summary - no git/bash access, no ability to touch the version-bump commit or push anything itself.
- [x] 2.3 Implement the fallback path: run the AI step with `continue-on-error: true`, then a follow-up step that falls back to the raw changelog (as `release-notes.md`) if the step failed or produced no output, so the job never fails solely because of the AI step.
- [x] 2.4 ~~Unit-test the prompt-assembly and fallback logic~~ - superseded: there is no longer a standalone script to unit test: the fallback logic is a workflow shell step, exercised by task 5.4's dry run instead.

## 3. Release workflow

- [x] 3.1 Add `.github/workflows/release.yml` with `workflow_dispatch` inputs: `from`, `to`, `bump` (`auto|major|minor|patch`, default `auto`), `skip_bump` (boolean, default `false`), `tag` (used only when `skip_bump: true`).
- [x] 3.2 Add input validation step: fail fast if `skip_bump: true` and `tag` is empty, before any changelog/AI/publish work runs.
- [x] 3.3 Wire range resolution: default `from` to the latest existing `v*` tag (or full history if none), default `to` to `HEAD`.
- [x] 3.4 Wire the non-replay path: compute version via git-cliff, `npm version --no-git-tag-version --workspaces=false`, commit only the version-bump diff, push commit + tag to `main` using an `actions/create-github-app-token`-minted token (not `GITHUB_TOKEN`, not a PAT).
- [x] 3.5 Wire the replay path (`skip_bump: true`): regenerate changelog/context for the range ending at the supplied `tag` and skip all commit/tag/push steps entirely.
- [x] 3.6 Wire the AI summary step (task 2) into both paths, feeding its output (or the raw-changelog fallback) to `softprops/action-gh-release` as `body_path`, with `draft: true` and the release keyed to the resolved tag.
- [x] 3.7 Set the git committer identity to the GitHub App's bot identity (`<app-slug>[bot]` / `<id>+<app-slug>[bot]@users.noreply.github.com`).
- [x] 3.8 Confirm `permissions:` block on the workflow is scoped minimally (no broader than `contents: write` for the jobs that need it).

## 4. Repo-admin prerequisites (out-of-band, tracked but not automated by this change)

- [ ] 4.1 Create an org-owned GitHub App ("Hyveon Release Bot") with `Contents: read & write` permission only; install it on the repo.
- [ ] 4.2 Store `RELEASE_APP_ID` (repo/org variable) and `RELEASE_APP_PRIVATE_KEY` (repo/org secret).
- [ ] 4.3 Store `CLAUDE_CODE_OAUTH_TOKEN` as a repo secret, generated locally via `claude setup-token` under the Claude subscription the AI summary step should bill against.
- [ ] 4.4 Add the App as an **Always** bypass actor on the `enforce-main-branch-protection` ruleset.
- [ ] 4.5 Confirm (via a harmless dry run, e.g. task 5.2) that the App's token can push a commit and a tag to `main` before relying on it for a real release.

## 5. Verification

- [x] 5.1 `npm run app:lint` and `npm run app:typecheck` pass with the new script/config in place (if the script is typechecked - confirm scope per 2.2).
- [ ] 5.2 Dry-run the workflow end-to-end on a throwaway/test scenario (e.g. targeting a fork or a test tag range) to confirm: version bump commit lands on `main`, tag is pushed, `package.yml`'s tag-triggered publish job actually fires, draft release appears with AI-generated body.
- [ ] 5.3 Dry-run the replay path (`skip_bump: true`) against the test release from 5.2 and confirm no new commit/tag is created and the release body updates in place.
- [ ] 5.4 Confirm the AI-summary fallback path by temporarily forcing a failure (e.g. invalid `CLAUDE_CODE_OAUTH_TOKEN`) and confirming the release still publishes with the raw changelog.

## 6. Documentation

- [x] 6.1 Update `docs/docs/guides/maintainer.md` release section: document the new `workflow_dispatch` trigger, all inputs, the replay mode, and a link to the one-time GitHub App setup steps (task 4).
- [x] 6.2 Cross-check `docs/docs/components/infra.md` and related pages for any stale "no release automation exists" language that this change makes inaccurate.
