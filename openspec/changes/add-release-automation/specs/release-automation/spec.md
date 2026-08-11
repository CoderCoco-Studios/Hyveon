## Purpose

Defines a manually-triggered release process that turns Conventional Commits accumulated on `main` into a versioned, tagged, AI-summarized draft GitHub Release, with an explicit replay mode for regenerating a release's notes after the fact.

## ADDED Requirements

### Requirement: Manual release trigger with configurable range
The system SHALL expose a manually-triggered workflow that accepts an optional start ref, an optional end ref, and an optional bump strategy, and SHALL default the start ref to the most recent existing release tag and the end ref to the current tip of `main` when not supplied.

#### Scenario: Trigger with no inputs
- **WHEN** an operator triggers the release workflow with no `from`/`to`/`bump` inputs and at least one prior release tag exists
- **THEN** the system computes the changelog and version bump over the range from the most recent existing tag to the current tip of `main`

#### Scenario: Trigger with explicit range
- **WHEN** an operator triggers the release workflow with explicit `from` and `to` inputs
- **THEN** the system computes the changelog and version bump only over commits in that explicit range, ignoring any existing tags

#### Scenario: First release with no prior tags
- **WHEN** an operator triggers the release workflow with no `from` input and no release tag exists yet in the repository
- **THEN** the system computes the changelog over the full commit history up to the `to` ref

### Requirement: Automatic semver bump from Conventional Commits
The system SHALL derive a semantic version bump (major, minor, or patch) from the Conventional Commit types and breaking-change markers present in the selected commit range when the bump strategy is `auto`, and SHALL allow an operator to override the computed bump with an explicit `major`, `minor`, or `patch` selection.

#### Scenario: Breaking change forces a major bump
- **WHEN** the selected commit range contains a commit marked as a breaking change
- **THEN** the computed version bump is `major`, regardless of other commit types present

#### Scenario: Feature commits without breaking changes force a minor bump
- **WHEN** the selected commit range contains one or more `feat` commits and no breaking-change markers
- **THEN** the computed version bump is `minor`

#### Scenario: Only fix/chore commits force a patch bump
- **WHEN** the selected commit range contains only `fix`, `chore`, `refactor`, `docs`, `test`, `perf`, `build`, `ci`, or `style` commits
- **THEN** the computed version bump is `patch`

#### Scenario: Operator overrides the computed bump
- **WHEN** an operator supplies an explicit `bump` input of `major`, `minor`, or `patch`
- **THEN** the system uses that value instead of the value it would otherwise have computed from commit types

### Requirement: Versioned commit and tag pushed to the protected default branch
The system SHALL update the version field in the repository's root package manifest to the computed or overridden version, commit that change directly to the protected default branch, and push an annotated tag pointing at that commit, using an authentication identity distinct from the default workflow token so that the resulting tag push triggers downstream tag-triggered workflows.

#### Scenario: Version bump committed and tagged
- **WHEN** a release run with `skip_bump` not set completes changelog generation successfully
- **THEN** the root package manifest's version field is updated, a commit containing only that change is pushed to the default branch, and a tag named for the new version is pushed pointing at that commit

#### Scenario: Tag push reaches the build pipeline
- **WHEN** the release workflow pushes a new version tag
- **THEN** the existing tag-triggered build/publish workflow observes the tag push and runs, rather than silently no-opping as it would for a push made with the default workflow token

### Requirement: Skip-bump replay mode
The system SHALL support a replay mode that regenerates the changelog and AI-written summary for an already-tagged release, identified by an operator-supplied tag, without creating a new version, commit, or tag.

#### Scenario: Replay against an existing tag
- **WHEN** an operator triggers the release workflow with `skip_bump` set to true and an existing tag supplied
- **THEN** the system regenerates the changelog and AI summary for the commit range ending at that tag without modifying the package manifest, committing, or pushing any tag

#### Scenario: Replay without a target tag is rejected
- **WHEN** an operator triggers the release workflow with `skip_bump` set to true and no tag supplied
- **THEN** the workflow fails fast with an error before performing any changelog generation or release publication step

### Requirement: AI-generated release summary with changelog fallback
The system SHALL generate a user-facing release summary from the structured changelog using an AI text-generation call, grounded strictly in the facts present in the changelog, and SHALL fall back to publishing the raw grouped changelog as the release body if the AI generation step fails for any reason.

#### Scenario: AI summary succeeds
- **WHEN** the AI summarization step completes successfully
- **THEN** the generated summary is used as the primary release body content, with the raw changelog included alongside it

#### Scenario: AI summary step fails
- **WHEN** the AI summarization step errors or times out
- **THEN** the release is still published using the raw grouped changelog as its body, and the release process does not fail solely because of the AI step

### Requirement: Draft release requiring human approval
The system SHALL publish (or update, in replay mode) the resulting release as a draft GitHub Release associated with the relevant tag, and SHALL NOT make the release publicly visible without an explicit separate human action.

#### Scenario: New release published as draft
- **WHEN** a non-replay release run completes
- **THEN** a draft GitHub Release is created for the new tag, visible only to repository collaborators until a human manually publishes it

#### Scenario: Replay updates the existing draft or release notes
- **WHEN** a replay run completes for an existing tag
- **THEN** the release notes associated with that tag's GitHub Release are updated in place, without altering the release's published/draft state
