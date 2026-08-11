## 1. Changelog & version-bump engine

- [ ] 1.1 Add root `cliff.toml` configuring commit parser groups for `feat|fix|refactor|docs|test|chore|perf|build|ci|style`, breaking-change detection, and `--context` JSON output shape.
- [ ] 1.2 Verify `npx git-cliff@2.13.1` locally against this repo's actual commit history: `--unreleased`, an explicit `<from>..<to>` range, `--bumped-version`, `--bump major|minor|patch`, and `--context` all produce sane output.
- [ ] 1.3 Confirm behavior with zero prior tags (first-release case) - range should fall back to full history up to `to`.

## 2. AI release-notes script

- [ ] 2.1 Add `.github/scripts/release-notes.mjs` using `@anthropic-ai/sdk`: reads git-cliff `--context` JSON from a file path (env var), calls `claude-opus-5` with a system prompt constrained to changelog facts only, writes Markdown output to a file path (env var).
- [ ] 2.2 Add `@anthropic-ai/sdk` as a dependency where the script runs (root `package.json` devDependency, or a scoped `.github/scripts/package.json` - pick one and document why in the PR).
- [ ] 2.3 Implement the fallback path: if the API call throws or times out, the calling workflow step must still produce a usable release body from the raw changelog rather than failing the job.
- [ ] 2.4 Unit-test the prompt-assembly and fallback logic (no live API call) - e.g. via a small script test or a Vitest spec if colocated under a workspace.

## 3. Release workflow

- [ ] 3.1 Add `.github/workflows/release.yml` with `workflow_dispatch` inputs: `from`, `to`, `bump` (`auto|major|minor|patch`, default `auto`), `skip_bump` (boolean, default `false`), `tag` (used only when `skip_bump: true`).
- [ ] 3.2 Add input validation step: fail fast if `skip_bump: true` and `tag` is empty, before any changelog/AI/publish work runs.
- [ ] 3.3 Wire range resolution: default `from` to the latest existing `v*` tag (or full history if none), default `to` to `HEAD`.
- [ ] 3.4 Wire the non-replay path: compute version via git-cliff, `npm version --no-git-tag-version --workspaces=false`, commit only the version-bump diff, push commit + tag to `main` using an `actions/create-github-app-token`-minted token (not `GITHUB_TOKEN`, not a PAT).
- [ ] 3.5 Wire the replay path (`skip_bump: true`): regenerate changelog/context for the range ending at the supplied `tag` and skip all commit/tag/push steps entirely.
- [ ] 3.6 Wire the AI summary step (task 2) into both paths, feeding its output (or the raw-changelog fallback) to `softprops/action-gh-release` as `body_path`, with `draft: true` and the release keyed to the resolved tag.
- [ ] 3.7 Set the git committer identity to the GitHub App's bot identity (`<app-slug>[bot]` / `<id>+<app-slug>[bot]@users.noreply.github.com`).
- [ ] 3.8 Confirm `permissions:` block on the workflow is scoped minimally (no broader than `contents: write` for the jobs that need it).

## 4. Repo-admin prerequisites (out-of-band, tracked but not automated by this change)

- [ ] 4.1 Create an org-owned GitHub App ("Hyveon Release Bot") with `Contents: read & write` permission only; install it on the repo.
- [ ] 4.2 Store `RELEASE_APP_ID` (repo/org variable) and `RELEASE_APP_PRIVATE_KEY` (repo/org secret).
- [ ] 4.3 Store `ANTHROPIC_API_KEY` as a repo secret.
- [ ] 4.4 Add the App as an **Always** bypass actor on the `enforce-main-branch-protection` ruleset.
- [ ] 4.5 Confirm (via a harmless dry run, e.g. task 5.2) that the App's token can push a commit and a tag to `main` before relying on it for a real release.

## 5. Verification

- [ ] 5.1 `npm run app:lint` and `npm run app:typecheck` pass with the new script/config in place (if the script is typechecked - confirm scope per 2.2).
- [ ] 5.2 Dry-run the workflow end-to-end on a throwaway/test scenario (e.g. targeting a fork or a test tag range) to confirm: version bump commit lands on `main`, tag is pushed, `package.yml`'s tag-triggered publish job actually fires, draft release appears with AI-generated body.
- [ ] 5.3 Dry-run the replay path (`skip_bump: true`) against the test release from 5.2 and confirm no new commit/tag is created and the release body updates in place.
- [ ] 5.4 Confirm the AI-summary fallback path by temporarily forcing a failure (e.g. invalid API key) and confirming the release still publishes with the raw changelog.

## 6. Documentation

- [ ] 6.1 Update `docs/docs/guides/maintainer.md` release section: document the new `workflow_dispatch` trigger, all inputs, the replay mode, and a link to the one-time GitHub App setup steps (task 4).
- [ ] 6.2 Cross-check `docs/docs/components/infra.md` and related pages for any stale "no release automation exists" language that this change makes inaccurate.
