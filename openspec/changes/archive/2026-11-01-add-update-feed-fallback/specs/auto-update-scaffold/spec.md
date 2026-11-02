## ADDED Requirements

### Requirement: Failed update checks fall back to the newest release with a feed

When `checkForUpdates` fails, the updater SHALL query the GitHub releases API for the newest release that is neither a draft nor a prerelease and carries the current platform's feed file (`latest.yml` on win32, `latest-mac.yml` on darwin, `latest-linux.yml` on linux), point the generic provider at that release's download URL, and retry the check once. If no such release exists, the lookup fails, or the retry fails, the updater MUST surface the original error. The updater MUST NOT download or install as part of the fallback. After the retry (success or failure) the updater MUST restore the primary GitHub feed so later checks do not stay on the fallback feed. The newest eligible release is the one with the greatest `published_at`.

#### Scenario: Latest release has no feed file

- **WHEN** the primary check fails because the latest release lacks the platform feed file and an older published release carries it
- **THEN** the updater retries once against that older release and reports its availability result instead of the primary error

#### Scenario: No usable fallback release

- **WHEN** the primary check fails and no non-draft, non-prerelease release has the platform feed file, or the releases lookup fails
- **THEN** the original primary error is surfaced and no retry is attempted

#### Scenario: Primary error event does not end a manual check early

- **WHEN** a manual check's primary attempt emits an `error` event but the fallback retry succeeds
- **THEN** the manual check resolves with the retry's result, not with the primary error

### Requirement: Failed manual checks link to the releases page

When the Settings page's manual update check reports failure (including when the IPC call itself rejects), it SHALL render a "Download manually" link to `https://github.com/CoderCoco-Studios/Hyveon/releases` that opens in a new window. The link MUST NOT appear when the check succeeds.

#### Scenario: Check fails

- **WHEN** the operator presses "Check for Updates" and the result is `ok: false`
- **THEN** the error text is shown alongside a "Download manually" link to the GitHub Releases page

#### Scenario: Check succeeds

- **WHEN** the manual check reports up to date or an available update
- **THEN** no "Download manually" link is shown
