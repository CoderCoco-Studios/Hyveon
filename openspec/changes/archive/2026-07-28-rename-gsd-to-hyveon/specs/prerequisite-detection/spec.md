## MODIFIED Requirements

### Requirement: Prerequisite check IPC

The prerequisite check SHALL be exposed to the renderer via an IPC-only controller message pattern `wizard.prereqs.check` (bridged by `registerIpcMainBridges`), mirrored in the preload as `hyveon.wizard.checkPrereqs()` with a typed entry in `hyveon-api.ts`. The renderer MUST NOT probe PATH or spawn processes itself.

#### Scenario: Renderer requests a prerequisite check

- **WHEN** the renderer invokes `hyveon.wizard.checkPrereqs()`
- **THEN** the main process runs the detection service and resolves with per-tool `{ found, path?, version? }` results

### Requirement: Install-prerequisites wizard step

The first wizard step SHALL display the detection result per tool, render OS-specific install instructions (macOS, Windows, Linux — chosen from the platform reported by the main process) with links to the vendor download pages, and provide a "Re-check" button that re-invokes the prerequisite check. The step MUST block progression until both tools are detected as satisfied, and the wizard MUST NEVER attempt to install either tool itself (no elevation).

#### Scenario: Missing tool blocks progression

- **WHEN** the check reports `terraform` as not found
- **THEN** the step shows install instructions for the operator's OS, the Next/Continue control is disabled, and no auto-install is attempted

#### Scenario: Re-check after installing

- **WHEN** the operator installs the missing tool and clicks "Re-check"
- **THEN** the step re-invokes `hyveon.wizard.checkPrereqs()` and, once both tools are satisfied, enables progression to the next step

#### Scenario: Correct instructions per platform

- **WHEN** the step renders on each of macOS, Windows, and Linux
- **THEN** the install instructions shown match that platform (e.g. `brew`/installer/`winget`/package-manager guidance respectively)
