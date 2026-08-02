/**
 * The structured resource-change summary a Pulumi `preview`/`up` operation
 * reports. `PulumiService.preview`/`.up` populate this from the Automation
 * API's own structured `SummaryEvent.resourceChanges` field
 * (`@pulumi/pulumi/automation/events.js`) — never by parsing streamed CLI
 * text — so this type is the shape {@link RunRecord.changeSummary} persists.
 *
 * `OpType`/`ChangeSummary` deliberately duplicate (rather than import)
 * `@pulumi/pulumi/automation`'s own `OpType`/`OpMap` types byte-for-byte:
 * `@hyveon/shared` is consumed by the Lambda packages and the web renderer,
 * neither of which has any other reason to depend on the (Node-only,
 * Electron-bundled-as-`external`) `@pulumi/pulumi` package.
 */

/**
 * The granular CRUD operation Pulumi's engine performed (or planned to
 * perform) on a single resource during a `preview`/`up`/`destroy`. Mirrors
 * `@pulumi/pulumi/automation`'s `OpType` union exactly — every member here
 * has a same-named counterpart there.
 */
export type OpType =
  | 'same'
  | 'create'
  | 'update'
  | 'delete'
  | 'replace'
  | 'create-replacement'
  | 'delete-replaced'
  | 'read'
  | 'read-replacement'
  | 'refresh'
  | 'discard'
  | 'discard-replaced'
  | 'remove-pending-replace'
  | 'import'
  | 'import-replacement';

/**
 * A structured resource-change summary: a count of affected resources keyed
 * by {@link OpType}. Sourced verbatim from the Automation API's own
 * `SummaryEvent.resourceChanges` (an `OpMap`) — never derived by parsing
 * streamed CLI output text.
 *
 * **Sharp edge:** `{}` (every key absent/zero) means "the engine's
 * structured summary event was never observed for this run" — e.g. the
 * process was killed, or crashed, before the summary event fired — NOT
 * "this operation made no changes". A genuine no-op run reports
 * `{ same: N }` for the N unchanged resources, which is never an empty
 * object once at least one resource exists in the stack. Every consumer
 * MUST treat an empty/absent {@link ChangeSummary} as "summary unavailable"
 * and render that distinctly from "no changes" — never collapse the two.
 */
export type ChangeSummary = {
  [key in OpType]?: number;
};
