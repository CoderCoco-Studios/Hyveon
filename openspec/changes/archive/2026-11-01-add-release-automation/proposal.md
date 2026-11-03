## Why

Hyveon has a build/package pipeline (`.github/workflows/package.yml`) but no way to actually cut a release: nothing bumps the version, nothing creates a `v*` tag, and the pipeline's own publish job only fires on a tag push that never happens. A single `v0.1.0` tag exists, pointing at the current `main` tip — it was never produced by a release process (no changelog, no bump commit, no draft release) and does not reflect a version that was actually cut. Cutting a real release today requires a human to hand-compute a semver bump, hand-write release notes, and manually push a tag past branch protection — a process nobody has actually done end-to-end. We need a one-click, auditable way to turn accumulated Conventional Commits into a versioned, tagged, human-readable draft release.

## What Changes

- New `release.yml` GitHub Actions workflow, triggered only by `workflow_dispatch`, with inputs:
  - `from` (optional) — start ref/tag/commit for the changelog range; defaults to the latest existing `v*` tag (or repo root if none exist).
  - `to` (optional) — end ref/commit for the changelog range; defaults to `HEAD`.
  - `bump` (optional, `auto|major|minor|patch`) — semver bump strategy; defaults to `auto` (derived from Conventional Commit types/breaking markers in range).
  - `skip_bump` (boolean, default `false`) — when `true`, regenerates the changelog and AI summary for an **already-tagged** release without bumping the version, committing, or creating a new tag. Used to improve a release's description or give the AI summarizer more context after the fact.
  - `tag` (optional) — required when `skip_bump: true`; identifies which existing tag's release to regenerate.
- Changelog and version-bump computation via `git-cliff` (Conventional Commits parsing, `--bumped-version`, `--context` JSON output) driven directly via `npx`, not the community wrapper action.
- An AI summary step, driven by `anthropics/claude-code-action@v1` authenticated with a `CLAUDE_CODE_OAUTH_TOKEN` (bills against the Claude subscription used to generate it, not metered API usage), reads git-cliff's structured changelog context and produces an engaging, user-facing "what's new" summary, falling back to the raw changelog if the step fails.
- Version bump: `npm version --no-git-tag-version` against the **root `package.json`** only (workspace packages are not independently versioned — they ship inside one Electron installer).
- The workflow commits the version bump and pushes the tag directly to `main`, authenticated via a GitHub App installation token (`actions/create-github-app-token`) rather than `GITHUB_TOKEN` (which does not trigger downstream `push: tags` workflows) or a personal PAT.
- A draft GitHub Release is created/updated (`softprops/action-gh-release`, `draft: true`) with the AI-generated summary as the body and the raw changelog attached in a collapsed `<details>` section, requiring human review/publish before it goes live.
- **Out-of-band, repo-admin-only prerequisite** (documented in `design.md`, not automatable from this change): a GitHub App must be created and installed on the repo, its credentials stored as `RELEASE_APP_ID`/`RELEASE_APP_PRIVATE_KEY`, and the app added as an **Always** bypass actor on the `enforce-main-branch-protection` ruleset. The workflow cannot push to `main` until this is done manually in GitHub settings.
- **BREAKING**: none — this is new automation; it does not change any existing workflow trigger or behavior. `package.yml`'s existing `push: tags: ['v*']` trigger is reused as-is (this workflow's tag push is what will finally exercise it).

## Capabilities

### New Capabilities
- `release-automation`: a manually-triggered GitHub Actions workflow that computes a Conventional-Commits-derived changelog and semver bump over a configurable commit range, generates an AI-written release summary, versions and tags a release commit on `main` via a privileged bot identity, and publishes a draft GitHub Release for human approval — with a replay mode to regenerate a release's notes without re-tagging.

### Modified Capabilities
_(none — `package.yml`'s existing tag-triggered publish job is consumed as-is; its spec, if any, is unaffected.)_

## Impact

- **New files**: `.github/workflows/release.yml`, a `cliff.toml` (git-cliff config) at repo root.
- **New repo secrets/vars**: `RELEASE_APP_ID`, `RELEASE_APP_PRIVATE_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`.
- **GitHub settings (manual, out-of-band)**: new GitHub App installation; `enforce-main-branch-protection` ruleset gains one more bypass actor.
- **`package.json` (root)**: `version` field will actually advance for the first time (currently frozen at `0.1.0`).
- **Docs**: `docs/docs/guides/maintainer.md` release section needs to document the new trigger, inputs, and the one-time GitHub App setup steps.
- **No changes** to `app/`, Lambdas, infra, or any runtime behavior of the shipped product — this is pure release tooling.
