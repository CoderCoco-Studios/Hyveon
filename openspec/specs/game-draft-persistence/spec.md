# game-draft-persistence Specification

## Purpose
Defines how the add-game wizard's in-progress draft is autosaved,
persisted across app restarts, and offered back to the operator via a
resume/discard banner on the games page.

## Requirements
### Requirement: Debounced draft autosave

The add-game wizard SHALL persist its current `WizardDraft` and step index to
durable storage automatically as the operator edits it, without requiring an
explicit save action. A save SHALL be triggered after edits settle for
approximately 1 second (debounced), and SHALL NOT fire while the draft is
still empty or while the wizard is submitting.

#### Scenario: Autosave fires after idle typing

- **WHEN** the operator edits a field in the add-game wizard and stops typing
  for about 1 second
- **THEN** the current `WizardDraft` and step index are written to durable
  storage

#### Scenario: No autosave for an untouched wizard

- **WHEN** the add-game wizard is opened and no field has been edited yet
- **THEN** no draft is written to durable storage

#### Scenario: Autosave suppressed during submission

- **WHEN** the operator has clicked submit and the wizard is in the
  submitting state
- **THEN** no autosave write is triggered, even if draft state changes as a
  result of the submission flow

### Requirement: Draft flushed on dialog close

The add-game wizard SHALL immediately write any pending (not-yet-debounced)
draft change to durable storage when the wizard dialog closes or the wizard
component unmounts, so that closing the wizard shortly after the last edit
does not lose that edit.

#### Scenario: Closing shortly after an edit preserves it

- **WHEN** the operator edits a field and closes the wizard dialog (Escape,
  overlay click, or the close control) less than 1 second later
- **THEN** the edit made just before closing is present in the persisted
  draft

### Requirement: Draft survives app restart

A saved add-game wizard draft SHALL be persisted in the desktop main process
such that it survives the operator quitting and relaunching the Electron
app, not only in-session navigation.

#### Scenario: Draft available after relaunch

- **WHEN** an add-game wizard draft was saved, the app is fully closed, and
  the app is relaunched
- **THEN** the previously saved draft is retrievable and reflects the last
  autosaved state

### Requirement: Resume/discard banner on the games page

The games list page SHALL check for a saved add-game wizard draft when it
loads and, if one exists, SHALL display a banner offering to resume or
discard it. The banner SHALL NOT automatically reopen the wizard.

#### Scenario: Banner shown when a draft exists

- **WHEN** the games page loads and a saved add-game wizard draft exists
- **THEN** a banner is shown offering "Resume" and "Discard" actions, and the
  add-game wizard dialog does not open automatically

#### Scenario: No banner when no draft exists

- **WHEN** the games page loads and no saved add-game wizard draft exists
- **THEN** no draft banner is shown

#### Scenario: Resuming opens the wizard with saved state

- **WHEN** the operator clicks "Resume" on the draft banner
- **THEN** the add-game wizard dialog opens populated with the saved draft's
  field values and step index

#### Scenario: Discarding clears the draft without opening the wizard

- **WHEN** the operator clicks "Discard" on the draft banner
- **THEN** the saved draft is deleted from durable storage, the banner is
  hidden, and the add-game wizard dialog does not open

### Requirement: Draft cleared on successful game creation

Once the add-game wizard successfully creates a game, any saved draft for the
add-game wizard SHALL be deleted from durable storage.

#### Scenario: Draft removed after successful submit

- **WHEN** the operator completes the add-game wizard and the game is
  created successfully
- **THEN** the saved draft is deleted from durable storage and the draft
  banner no longer appears on subsequent visits to the games page

### Requirement: Corrupt or unreadable draft degrades to no draft

If the saved draft cannot be read or does not match the expected shape (for
example, after an app update changes the draft format), the system SHALL
treat this the same as no draft being present, and SHALL NOT block the games
page from loading or throw an unhandled error.

#### Scenario: Corrupt draft entry does not block the games page

- **WHEN** the games page loads and the saved draft entry is corrupt or
  unparseable
- **THEN** the games page loads normally, no draft banner is shown, and no
  error is surfaced to the operator
