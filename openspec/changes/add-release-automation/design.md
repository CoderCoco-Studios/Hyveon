## Context

See `proposal.md` - Why. Relevant current state:

- `.github/workflows/package.yml` builds installers on PR/merge-queue and publishes a **draft** GitHub Release (`softprops/action-gh-release`, `draft: true`) only `if: startsWith(github.ref, 'refs/tags/v')`. That job is unreachable today - no tag has ever been pushed.
- `main` is protected by a GitHub **ruleset** (`enforce-main-branch-protection`), not classic branch protection. It already has two configured bypass actors (one `Integration`, one `User`), so adding a third (this release bot) is a proven, existing pattern in this repo, not a new category of risk.
- Root `package.json.version` is `0.1.0` and has never been bumped by tooling. `app/package.json` carries an unrelated `1.0.0` and is not touched by this change (see proposal - Impact: workspace packages are not independently versioned).
- No changelog or version-bump tooling exists anywhere in the repo (no `semantic-release`, `changesets`, `release-please`, `standard-version`).

## Goals / Non-Goals

**Goals:**
- A single `workflow_dispatch` workflow an operator can run by hand to cut a release end-to-end: changelog → bump → commit → tag → AI summary → draft release.
- Full control over the commit range (explicit override or autodetect-since-last-tag) and a replay mode that never mutates version/commit/tag state.
- Reuse the existing `package.yml` tag-triggered publish path rather than duplicating installer builds into the new workflow.

**Non-Goals:**
- Per-workspace-package versioning. All `app/packages/*` ship inside one Electron installer; only the root manifest version is meaningful externally.
- Automatic/scheduled releases. This change is deliberately human-in-the-loop at trigger time and at draft-publish time.
- Changing `package.yml`'s own triggers, matrix, or publish logic - it is consumed as-is.
- Provisioning the GitHub App itself. Creating the App, installing it, and adding it to the ruleset's bypass list are one-time actions only a repo/org admin can perform in GitHub's UI; this change ships the workflow that *depends* on that App existing; it does not and cannot create it.

## Decisions

### Changelog + bump engine: `git-cliff` (pinned `2.13.1`), invoked via `npx`
Alternatives considered: `release-please` and `semantic-release` are both fundamentally push-driven state machines (a "release PR" or an auto-computed next version from full history) - neither supports an explicit `from`/`to` range override or a changelog-only replay mode without inventing a new tag, which this change requires by design. `conventional-changelog-cli` primitives were the fallback if git-cliff's range/replay support proved insufficient; it did not, so the lower-level composition was unnecessary.

`npx git-cliff@2.13.1` is used directly rather than `orhun/git-cliff-action` because the action is a thin wrapper around the same CLI flags and adds an extra layer of arg-string marshalling for no benefit in a workflow that already runs Node.

Config lives in a root `cliff.toml`: commit parser groups mirror this repo's enforced commit types (`feat|fix|refactor|docs|test|chore|perf|build|ci|style`), and `--context` output feeds the AI summarizer as structured JSON (per-commit group/scope/breaking-flag), not the rendered changelog text.

### Version bump application: `npm version --no-git-tag-version` on root `package.json` only
git-cliff computes the *version string* (`--bumped-version`) but does not write `package.json`; the workflow applies it explicitly. Scoped to root only per the Non-Goals above - `--workspaces=false` prevents `npm version` from cascading into workspace packages.

### Protected-branch push identity: GitHub App installation token, not `GITHUB_TOKEN` or a PAT
`GITHUB_TOKEN`-authored pushes do not trigger other `on: push` workflows (a GitHub Actions platform restriction, not a repo config choice) - a tag pushed with it would never wake `package.yml`'s tag-triggered publish job, silently breaking the one thing this change exists to enable. A personal-account PAT was rejected: it ties the release identity to a human, has broad default scope, and doesn't expire on a predictable schedule. `actions/create-github-app-token` mints a short-lived (1h), repo-scoped token for a bot identity with no human owner, and its pushes do trigger downstream workflows - this is also what `release-please`/`semantic-release`'s own docs converged on for the identical problem.

An **auto-merge PR** alternative (bot opens a version-bump PR, auto-merges it, tags after merge) was considered and rejected for this repo: `enforce-main-branch-protection` already permits bypass actors, `required_approving_review_count` is 0 (so no self-approval deadlock either way), and a PR round-trip only adds a full CI cycle of latency and an extra moving part (a second workflow watching for the merge to find the squashed SHA) without removing any risk that direct push doesn't already carry.

### AI summary: hand-rolled Node script calling `claude-opus-5`, not a wrapper action
No existing Anthropic-maintained action fits a stateless one-shot "text in, text out" summarization - `anthropics/claude-code-action` is a full agentic harness (checkout, tool loop, PR/issue context) and is the wrong shape here, both slower and harder to reason about for a single Messages API call. A small script using `@anthropic-ai/sdk` reads the git-cliff `--context` JSON from a file (never as a CLI argument, to avoid shell-quoting/injection issues with arbitrary commit message content) and writes plain Markdown to a file consumed by `softprops/action-gh-release`'s `body_path`. Model: `claude-opus-5` per this session's research into current model/pricing guidance - a summarization call of this size costs fractions of a cent per release; downgrading to a cheaper tier is a future knob, not a blocker.

### Draft-only publication
`softprops/action-gh-release` with `draft: true` for both the create path (new release) and the replay path (update existing release notes in place, per its documented upsert-by-tag behavior) - satisfies the requirement that no release becomes publicly visible without a separate explicit human action, consistent with `package.yml`'s existing publish job which already defaults to draft.

## Risks / Trade-offs

- **[Risk]** A bypass actor on the branch ruleset is inherently a hole in "no direct pushes to `main`." → **Mitigation**: scope the App's permission to `Contents: read & write` only (no `Administration`, no arbitrary workflow-file write); the App can only be invoked by `workflow_dispatch`, which itself requires write access to the repo to trigger; every push it makes is attributable to the App's bot identity in the audit log, distinct from any human actor.
- **[Risk]** `git-cliff`'s auto-bump heuristic could disagree with an operator's intent (e.g. a `fix` that's actually a breaking change without a footer marker). → **Mitigation**: the `bump` input always allows an explicit override; auto is a default, not a mandate.
- **[Risk]** AI summarization could hallucinate features not present in the changelog. → **Mitigation**: spec requires the summary be grounded strictly in changelog facts (prompt-level constraint) and requires a raw-changelog fallback if the step fails outright; a human still reviews the draft before publishing, which is the final backstop.
- **[Risk]** This change ships a workflow that cannot function until a repo admin performs manual GitHub-UI setup (App creation, secret storage, ruleset bypass entry). → **Mitigation**: called out explicitly in the proposal's Impact section and `tasks.md` as a non-automatable prerequisite step, not silently assumed.
- **[Trade-off]** Replay mode re-runs changelog generation and AI summarization but trusts the operator-supplied `tag` rather than re-validating that the tag's commit range matches what was originally released. Accepted: replay is an explicitly operator-driven corrective action: the operator is expected to know which tag they're regenerating.

## Migration Plan

No existing behavior is being replaced, so there is no migration/rollback for in-flight state. Rollout sequence:
1. Repo admin creates and installs the GitHub App, stores its credentials, adds it to the ruleset bypass list (out-of-band, see proposal - Impact).
2. `ANTHROPIC_API_KEY` secret is added.
3. This change's workflow, script, and `cliff.toml` are merged to `main` via the normal PR process (this change itself is not exempt from review).
4. First manual run is a real release: `v0.1.0` or whatever version the accumulated history computes to, exercising the full path including the previously-dead `package.yml` tag trigger.
5. If the workflow misbehaves, it can simply not be run again (`workflow_dispatch`-only, no schedule) while it's fixed in a follow-up PR; no rollback of already-pushed tags/releases is in scope - a bad draft release can be deleted or left unpublished by a human.
