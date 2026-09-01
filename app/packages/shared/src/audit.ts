import { ulid } from 'ulid';
import type { RedactedGameServer } from './gameServerConfig.js';

/**
 * The kind of mutation an {@link AuditEntry} records. Mirrors the CRUD verbs
 * exposed by the `game_servers` write endpoints in `@hyveon/desktop-main`,
 * plus `plan` for a dry-run plan invocation that touched no
 * infrastructure, `approve` for marking a successful `plan` run approved
 * for a later `apply` (see `IacController.approve`),
 * `apply` for an apply invocation that actually mutated
 * infrastructure (see `IacController.apply`), and
 * `destroy` for a confirmed destroy invocation that was
 * initiated to tear down every managed resource — recorded once the run
 * starts, not once it's confirmed successful (see `IacController.destroy`), and
 * `rollback` for restoring a historic deployment-config version as a new head (see
 * `IacController.confirmRollback`).
 */
export type AuditAction =
  | 'add'
  | 'edit'
  | 'remove'
  | 'plan'
  | 'approve'
  | 'apply'
  | 'destroy'
  | 'rollback';

/**
 * A single row in the DynamoDB audit log (`${project_name}-audit` table,
 * `pk = AUDIT`, `sk = ` {@link buildAuditSk}). Records who changed a game
 * server's configuration, what changed, and the resulting `deployment-config.json`
 * S3 object version — see `app/packages/infra/src/dynamodb.ts` for the table definition.
 */
export interface AuditEntry {
  /** Sort key: `<ISO timestamp>#<ULID>` — see {@link buildAuditSk}. */
  sk: string;
  /** ISO-8601 timestamp of the mutation. Duplicated from `sk` for cheap reads without parsing. */
  timestamp: string;
  /** Identifier of the user or system that performed the mutation. */
  actor: string;
  /** The kind of mutation performed. */
  action: AuditAction;
  /** The `game_servers` map key the mutation applied to. */
  game: string;
  /** The game's configuration before the mutation, redacted, or `null` for `add`. */
  before: RedactedGameServer | null;
  /** The game's configuration after the mutation, redacted, or `null` for `remove`. */
  after: RedactedGameServer | null;
  /** S3 object version id of `deployment-config.json` produced by the write, if known. */
  versionId?: string;
}

/**
 * A page of audit entries returned by {@link AuditLogStore.listEntries},
 * newest-first, plus an optional cursor for fetching the next page.
 */
export interface AuditPageResult {
  /** The page of entries, newest-first. */
  entries: AuditEntry[];
  /** Cursor (an {@link AuditEntry.sk} value) to pass as `before` to fetch the next, older page. Absent on the last page. */
  nextBefore?: string;
}

/**
 * Builds a DynamoDB sort key for a new {@link AuditEntry}: the ISO-8601
 * timestamp of `now` followed by a `#`-separated ULID, e.g.
 * `2026-07-17T12:34:56.789Z#01J...`. The ISO prefix keeps entries sorted
 * chronologically within the `AUDIT` partition; the ULID suffix disambiguates
 * entries written within the same millisecond.
 *
 * Pure: takes the timestamp as an (optional) argument rather than reading a
 * clock internally, so callers can pass a fixed `Date` for deterministic
 * ordering/testing.
 *
 * @param now - The timestamp to encode. Defaults to `new Date()`.
 * @returns The `<ISO timestamp>#<ULID>` sort key.
 */
export function buildAuditSk(now: Date = new Date()): string {
  return `${now.toISOString()}#${ulid(now.getTime())}`;
}
