## MODIFIED Requirements

### Requirement: Plan trigger over IPC

The Plan/Apply page SHALL start a plan by calling `hyveon.terraform.plan()` (the shipped IPC surface — not the pre-pivot HTTP/SSE endpoints described in issue #110's stale body). On a `{ started: true, runId }` ack the page MUST transition to a run-detail view for that `runId`; on a `{ started: false }` ack it MUST surface the returned `error` without transitioning.

#### Scenario: Plan accepted

- **WHEN** the operator clicks "Plan" and the `terraform.plan` invoke resolves `{ started: true, runId }`
- **THEN** the page transitions to the run view for `runId` and begins streaming that run's output

#### Scenario: Plan rejected because the workspace is busy

- **WHEN** the operator clicks "Plan" and the ack resolves `{ started: false, conflict }` naming the in-flight subcommand
- **THEN** the page stays on the trigger view and shows a BUSY banner naming the conflicting operation (`init`/`plan`/`apply`/`destroy`), and no run view is opened

### Requirement: Live ANSI log stream

The run view SHALL stream the run's output live by consuming `hyveon.terraform.runs.streamLogs(runId)` (which replays an in-flight run's buffered output then follows it live). ANSI escape sequences MUST be preserved end-to-end from the terraform process and converted to styled HTML in the renderer — the main process and preload MUST NOT strip or rewrite them.

#### Scenario: Chunks render in order with ANSI colors

- **WHEN** the plan run emits stdout/stderr chunks containing ANSI color escapes
- **THEN** the log viewer appends each chunk in arrival order, rendering the ANSI escapes as styled HTML rather than showing raw escape bytes

#### Scenario: Stream ends when the run settles

- **WHEN** the run reaches a terminal state and the log stream's end message arrives
- **THEN** the log viewer stops following and the page renders the run's terminal status

### Requirement: Approve gate before apply

The run view SHALL show an "Approve" action for a plan run whose status is `awaiting_approval` (as reported by `hyveon.terraform.runs.get`). Approval MUST call `hyveon.terraform.approve({ planRunId })`; the approver identity is resolved server-side and MUST NOT be supplied by the renderer. The "Apply" action MUST remain disabled until the plan run has been approved.

#### Scenario: Operator approves a successful plan

- **WHEN** the operator clicks "Approve" on a plan run in `awaiting_approval` and the invoke resolves `{ approved: true, approvedBy, approvedAt }`
- **THEN** the page shows who approved and when, and enables the "Apply" action

#### Scenario: Apply is disabled before approval

- **WHEN** a plan run has completed successfully but has not been approved
- **THEN** the "Apply" button is disabled and the page indicates approval is required first

### Requirement: Plan-hash-gated apply

The "Apply" action SHALL call `hyveon.terraform.apply({ planRunId, planHash })` using the plan hash returned by the plan run, so the backend's seven-step gate (plan record exists, is a plan, is approved, approval unexpired within the 15-minute window, hash match against both the stored record and the re-hashed on-disk `.tfplan` artifact, workspace free, apply lock acquired) decides whether the apply proceeds. A `{ started: false }` ack MUST be surfaced to the operator with its error text; an expired-approval rejection MUST prompt re-approval. On a successful apply the page SHALL show a success banner with a link back to the dashboard.

#### Scenario: Approved plan applies end-to-end

- **WHEN** the operator clicks "Apply" on an approved, unexpired plan and the ack resolves `{ started: true, runId }`
- **THEN** the page streams the apply run's output live and, once it ends with exit code 0, shows a success banner linking to the dashboard

#### Scenario: Expired approval is rejected

- **WHEN** the operator clicks "Apply" more than 15 minutes after approval and the ack resolves `{ started: false }` with an approval-expired error
- **THEN** the page surfaces the error and prompts the operator to re-approve the plan before applying

#### Scenario: Apply refused while the lock is held

- **WHEN** the apply ack resolves `{ started: false, conflict }` because the workspace or the durable apply lock is held by another run
- **THEN** the page shows the BUSY banner naming the conflict and does not stream any apply output
