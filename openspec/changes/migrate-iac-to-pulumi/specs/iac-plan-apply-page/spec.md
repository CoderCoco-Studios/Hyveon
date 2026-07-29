## MODIFIED Requirements

### Requirement: Live ANSI log stream

The run view SHALL stream the run's output live by consuming `hyveon.iac.runs.streamLogs(runId)` (which replays an in-flight run's buffered output then follows it live). ANSI escape sequences MUST be preserved end-to-end from the infrastructure engine and converted to styled HTML in the renderer — the main process and preload MUST NOT strip or rewrite them. The engine SHALL be invoked in a mode that emits human-readable progress output rather than a machine-only event stream, so the log pane remains meaningful to the operator.

#### Scenario: Chunks render in order with ANSI colors

- **WHEN** the plan run emits stdout/stderr chunks containing ANSI color escapes
- **THEN** the log viewer appends each chunk in arrival order, rendering the ANSI escapes as styled HTML rather than showing raw escape bytes

#### Scenario: Stream ends when the run settles

- **WHEN** the run reaches a terminal state and the log stream's end message arrives
- **THEN** the log viewer stops following and the page renders the run's terminal status

### Requirement: Plan result summary

When a plan run completes successfully, the run view SHALL display the resource-change summary (counts of resources to create, update, replace, and delete) prominently, with the full streamed plan output available in an expandable section. The counts MUST be taken from the structured change summary the engine returns, and MUST NOT be recovered by pattern-matching the human-readable log text. Exactly one implementation of the summary shape SHALL exist, shared between the main process and the renderer — the renderer MUST NOT re-derive counts from the stream.

#### Scenario: Successful plan shows the change summary

- **WHEN** a plan run ends successfully with a structured change summary
- **THEN** the page shows the create/update/replace/delete counts as a summary and offers the full log text in an expandable view

#### Scenario: Summary is not scraped from output

- **WHEN** a plan run's human-readable output is altered (for example by an engine version whose wording differs)
- **THEN** the displayed counts are unaffected, because they come from the structured summary rather than from the text

#### Scenario: Missing summary is not reported as "no changes"

- **WHEN** a plan run completes successfully but the engine's summary data is absent, so the change summary is empty
- **THEN** the page MUST NOT report "no changes"; it reports that the summary was unavailable and still offers the full log, because an empty summary is indistinguishable from a dropped summary event

### Requirement: Plan-hash-gated apply

The "Apply" action SHALL call `hyveon.iac.apply({ planRunId, planHash })` using the plan hash returned by the plan run, so the backend's gate decides whether the apply proceeds. The plan run SHALL persist an engine-produced update plan as a run artifact, and the apply SHALL be constrained by that saved plan so the engine itself refuses changes the operator did not review. The gate MUST verify, in order: the plan record exists, it is a plan run, it is approved, the approval is unexpired within the 15-minute window, the hash matches both the stored record and the re-hashed on-disk plan artifact, and the engine version matches the one that produced the plan. Acquiring the durable apply lock SHALL be the final and authoritative step, and it MUST be a single atomic compare-and-set whose conflict result decides the outcome. A preceding "is the workspace free" observation MUST NOT be relied on as the gate: two applies can both observe a free workspace before either acquires the lock, and only the atomic acquisition can order them. Because the saved plan format carries no stability guarantee, the plan hash MUST additionally cover the version identifier of the configuration object the plan ran against, and the apply MUST refuse when that version has moved — the configuration check MUST NOT depend on the plan file being parseable.

The saved plan is stamped with the engine version that produced it. A plan produced by one engine version MUST NOT be applied by another, because the plan format is explicitly unstable and a silently reinterpreted plan would defeat the review the gate exists to enforce. An engine upgrade between plan and apply SHALL invalidate outstanding plans with an error that names the version change.

A plan-constrained apply is not all-or-nothing: the engine applies changes in batches as the program executes, so a divergence detected partway through leaves earlier changes applied. The apply run's terminal state MUST therefore distinguish "failed with no changes applied" from "failed partway through", and the UI MUST direct the operator to re-plan rather than retry blindly after a partial failure. A `{ started: false }` ack MUST be surfaced to the operator with its error text; an expired-approval rejection MUST prompt re-approval. On a successful apply the page SHALL show a success banner with a link back to the dashboard.

#### Scenario: Approved plan applies end-to-end

- **WHEN** the operator clicks "Apply" on an approved, unexpired plan and the ack resolves `{ started: true, runId }`
- **THEN** the page streams the apply run's output live and, once it ends successfully, shows a success banner linking to the dashboard

#### Scenario: Configuration changed since the plan

- **WHEN** the configuration object has been written again since the plan ran, so its current version no longer matches the version recorded on the plan
- **THEN** the apply is refused with an error explaining that the plan is stale, and the operator is directed to re-plan

#### Scenario: Expired approval is rejected

- **WHEN** the operator clicks "Apply" more than 15 minutes after approval and the ack resolves `{ started: false }` with an approval-expired error
- **THEN** the page surfaces the error and prompts the operator to re-approve the plan before applying

#### Scenario: Apply refused while the lock is held

- **WHEN** the apply ack resolves `{ started: false, conflict }` because the workspace or the durable apply lock is held by another run
- **THEN** the page shows the BUSY banner naming the conflict and does not stream any apply output

#### Scenario: Two simultaneous applies are ordered by the lock

- **WHEN** two applies for the same approved plan are submitted close enough together that both observe a free workspace before either acquires the lock
- **THEN** exactly one acquires the durable apply lock and proceeds, and the other is refused with a conflict — the outcome is decided by the atomic acquisition, not by the earlier observation

#### Scenario: Engine upgraded between plan and apply

- **WHEN** the operator applies a plan that was produced by a different engine version than the one now installed
- **THEN** the apply is refused with an error naming the version change, and the operator is directed to re-plan

#### Scenario: Apply fails partway through

- **WHEN** a plan-constrained apply fails after some resource operations have already been applied
- **THEN** the run settles in a state that identifies it as a partial apply, and the page directs the operator to re-plan rather than presenting a plain retry of the same plan
