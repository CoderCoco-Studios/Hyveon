<!--
Delta spec template for a change.

This template demonstrates the 4 delta section types — use whichever apply:
- ADDED / MODIFIED / REMOVED / RENAMED
File name and location: openspec/changes/<change-name>/specs/<capability>/spec.md
(`<capability>` must match the directory name under openspec/specs/<capability>/)

Hard format rules (OpenSpec validates these):
- Requirement sentences MUST contain `SHALL` or `MUST`
- Every Requirement MUST have at least one `#### Scenario:`
- Scenario MUST use level-4 (`####`) — level-3 or a bullet silently fails
-->

## ADDED Requirements

<!-- New behavior. List the new Requirements this change adds to the capability. -->

### Requirement: <!-- requirement name -->
<!-- requirement text — must contain SHALL or MUST -->

#### Scenario: <!-- scenario name -->
- **WHEN** <!-- condition -->
- **THEN** <!-- expected outcome -->

---

## MODIFIED Requirements

<!--
Modify an existing Requirement. **MUST use the exact same normalized header**
as in openspec/specs/<capability>/spec.md (trimmed, case-sensitive match) —
otherwise the delta apply during archive will fail to find the matching
requirement.

**MUST paste the full modified content** (not just a diff), because OpenSpec
archive applies MODIFIED by replacing the entire text.
-->

### Requirement: <!-- same header as in the existing spec -->
<!-- full modified requirement text — must contain SHALL or MUST -->

#### Scenario: <!-- scenario name (may be added or modified) -->
- **WHEN** <!-- condition -->
- **THEN** <!-- expected outcome -->

---

## REMOVED Requirements

<!--
Remove an existing Requirement. MUST include Reason and Migration notes so
reviewers understand why it's being removed and how existing callers should
migrate.
-->

### Requirement: <!-- the header to remove, exactly matching the existing spec -->

**Reason**: <!-- why this is being removed -->

**Migration**: <!-- how existing callers/dependents should adjust -->

---

## RENAMED Requirements

<!--
Rename a Requirement header. Fixed format: FROM / TO as inline-code lines
(not a fenced code block), exactly as shown below.
If both the name and the content change, list the rename under RENAMED **and**
also write the full content under MODIFIED using the **new** header.

Apply order during archive: RENAMED → REMOVED → MODIFIED → ADDED
-->

- FROM: `### Requirement: <Old Name>`
- TO: `### Requirement: <New Name>`
