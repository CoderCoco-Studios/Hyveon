import { hostname as osHostname, userInfo } from 'node:os';
import { ConcurrentUpdateError } from '@pulumi/pulumi/automation/index.js';
import { formatRelativeAge } from '@hyveon/shared';
import type { ElectronStoreService, PulumiLockOwnershipRecord } from './ElectronStoreService.js';
import { logger } from '../logger.js';

/**
 * Stale-backend-lock-recovery primitives, satisfying the
 * `pulumi-engine-runtime` delta spec's "Stale backend lock recovery"
 * requirement.
 *
 * The self-managed (DIY/`file://`/`s3://`) backend's lock-conflict message is
 * structured and parseable: each lock file still present gets its own line
 * naming the lock's URL, the OS username and hostname of the process that
 * created it, that process's PID, and an RFC3339 creation timestamp —
 * {@link parseStackLocks} parses exactly this shape. The Node SDK wraps any
 * CLI failure containing this text (or the Pulumi Cloud-only "[409]
 * Conflict" text) in a `ConcurrentUpdateError`, checked first via
 * `instanceof`; message-pattern matching is kept only as a best-effort
 * backstop.
 *
 * A lock's `pid`/`username`/`hostname` belong to the `pulumi` CLI child
 * process, not this Electron app, and the Automation API never exposes that
 * child's PID to this app in advance — so PID can't be used as an identity
 * key. `username`/`hostname` are inherited from the OS session the CLI child
 * is spawned under, i.e. this app's own — every lock this installation
 * causes will carry this app's username/hostname pair.
 *
 * Identity match alone is **not sufficient** to call a lock a provable
 * orphan: an earlier run can crash leaving an uncleared ownership record,
 * and later a genuinely *live* `pulumi up` against the same stack from the
 * same machine (a second app instance — this app never calls
 * `app.requestSingleInstanceLock()` — or a manual CLI invocation) would
 * carry the same username/hostname as the stale record. Identity-only
 * matching would then misclassify that active lock as reclaimable and clear
 * a lock that is not stale, permitting concurrent writes to state.
 * {@link classifyStackLockConflict} therefore requires, for **every** parsed
 * lock:
 *
 * 1. **Identity match** — username and hostname match this installation's.
 * 2. **Liveness** ({@link isPidAlive}) — the lock's `pid` confirmed dead via
 *    `process.kill(pid, 0)` throwing `ESRCH` (a standard cross-platform
 *    existence probe, no special privileges needed).
 * 3. **Time-consistency** — some outstanding local record's `startedAt` is
 *    at or before the lock's `lockedAt`; a lock created before this
 *    installation ever recorded starting an attempt can't be that attempt's
 *    lock.
 *
 * See {@link findReclaimEvidence}. In-app concurrency (a second request from
 * this same app instance) is rejected by a layer above this module
 * (`iac.controller.ts`'s pre-flight guard via `PulumiService.getOperationInFlight()`)
 * before it ever reaches this classifier — this module only guards against a
 * live conflicting process this app instance is not the one running.
 *
 * Ownership records are bounded evidence, not permanent licence: without
 * pruning, a single leaked record would arm auto-reclaim for that stack
 * forever. {@link classifyStackLockConflict} treats any record older than
 * {@link PULUMI_LOCK_OWNERSHIP_RECORD_MAX_AGE_MS} as absent (pruning it
 * outright) and clears the specific record(s) actually relied on once a lock
 * is classified as a reclaimable own orphan, so that evidence can't be
 * reused for some future, unrelated lock.
 */

/**
 * One parsed lock entry from a DIY-backend "currently locked" conflict
 * message — see this file's top-level TSDoc for the verified Go source this
 * targets.
 */
export interface PulumiStackLockInfo {
  /** The lock object's URL, as rendered by the CLI's own `lockURLForError` (credentials already redacted by the CLI). */
  lockUrl: string;
  /** OS username of the process that created the lock (`user.Current().Username` in the Go CLI). */
  username: string;
  /** OS hostname of the machine that created the lock (`os.Hostname()` in the Go CLI). */
  hostname: string;
  /**
   * PID of the `pulumi` CLI process that created the lock. This app never
   * learns this PID *in advance* (the Automation API exposes no child-process
   * handle — see `PulumiCancellation.ts`'s TSDoc), so it cannot be used as an
   * identity key the way `username`/`hostname` are. Once a lock's
   * username/hostname already indicate "same machine", though, this PID
   * becomes directly useful: {@link isPidAlive} checks whether a process with
   * this PID still exists at classification time, distinguishing a
   * same-machine lock left behind by a process that has since exited from
   * one whose process is still genuinely running.
   */
  pid: number;
  /** When the lock was created, parsed from the CLI's RFC3339 timestamp. */
  lockedAt: Date;
}

/** Matches each per-lock detail line the Go CLI appends — see this file's top-level TSDoc for the exact `fmt.Fprintf` format this mirrors. */
const LOCK_ENTRY_PATTERN = /^\s*(\S+):\s*created by (\S+)@(\S+) \(pid (\d+)\) at (.+)$/gm;

/** Matches the Pulumi Cloud (non-DIY) backend's conflict text — see `errors.js`'s `conflictText`. Carries no structured holder/age detail, unlike the DIY-backend shape {@link LOCK_ENTRY_PATTERN} parses. */
const SERVICE_BACKEND_CONFLICT_PATTERN = /\[409\] Conflict/;

/** Matches the DIY-backend conflict summary line — see `errors.js`'s `diyBackendConflictText` and this file's top-level TSDoc. */
const DIY_BACKEND_CONFLICT_PATTERN = /the stack is currently locked by/i;

/**
 * True when `err` represents the backend refusing an operation because the
 * stack is locked — matched primarily via `instanceof ConcurrentUpdateError`
 * (the SDK's own typed class for this, per `errors.js`'s `createCommandError`),
 * with a message-pattern match kept only as a best-effort backstop for an
 * error that reached this code some other way (e.g. re-thrown/re-wrapped
 * upstream). Distinguishing this from "in-app busy" is **not** this
 * function's job — see this file's top-level TSDoc's "Why provable ownership"
 * section for why an in-app conflict never reaches this function at all.
 */
export function isStackLockConflict(err: unknown): boolean {
  if (err instanceof ConcurrentUpdateError) return true;
  const message = err instanceof Error ? err.message : String(err);
  return DIY_BACKEND_CONFLICT_PATTERN.test(message) || SERVICE_BACKEND_CONFLICT_PATTERN.test(message);
}

/**
 * Best-effort parse of every structured lock entry out of `err`'s message —
 * see {@link LOCK_ENTRY_PATTERN} and this file's top-level TSDoc for the
 * exact shape this targets. Returns an empty array (never throws) when `err`
 * is a lock conflict but carries no parseable per-lock detail (e.g. the
 * Pulumi Cloud backend's `"[409] Conflict"` text, which this app never
 * actually produces since it always uses the DIY backend — see the
 * `pulumi-engine-runtime` delta spec's "Automation API workspace seam"
 * requirement — but is handled defensively rather than assumed away), or
 * when `err` is not a lock conflict at all.
 */
export function parseStackLocks(err: unknown): PulumiStackLockInfo[] {
  const message = err instanceof Error ? err.message : String(err);
  const locks: PulumiStackLockInfo[] = [];
  for (const match of message.matchAll(LOCK_ENTRY_PATTERN)) {
    const [, lockUrl, username, hostname, pid, timestamp] = match;
    const lockedAt = new Date(timestamp);
    // Defensive: skip a line whose timestamp doesn't parse rather than
    // propagate an `Invalid Date` into a classification/confirmation-error
    // downstream consumers would otherwise have to guard against themselves.
    if (Number.isNaN(lockedAt.getTime())) continue;
    locks.push({ lockUrl, username, hostname, pid: Number(pid), lockedAt });
  }
  return locks;
}

/**
 * The three outcomes {@link classifyStackLockConflict} can reach. Does not
 * include "in-app busy" — see this file's top-level TSDoc for why that
 * category is handled by a layer above this module and never reaches a
 * `ConcurrentUpdateError` in the first place.
 */
export type PulumiLockClassification =
  | { kind: 'not-a-lock-conflict' }
  | { kind: 'reclaimable-own-orphan'; locks: PulumiStackLockInfo[] }
  | { kind: 'requires-confirmation'; locks: PulumiStackLockInfo[] };

/**
 * True when a process with `pid` still exists, checked via
 * `process.kill(pid, 0)` — signal `0` is a standard, cross-platform (Node/
 * libuv implement it on Windows too) existence probe that never actually
 * delivers a signal. Returns `false` only on `ESRCH` (no such process) —
 * the unambiguous "definitely gone" case. Any other failure, most notably
 * `EPERM` (a process with this PID exists but is owned by another user this
 * app can't signal), is treated conservatively as "possibly still alive"
 * rather than risk misclassifying a live process as dead: this function is
 * only ever used to decide whether it's safe to *skip* an operator
 * confirmation, so a false "alive" merely costs an extra confirmation
 * prompt, while a false "dead" would risk clearing a live lock.
 */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? String((err as { code: unknown }).code) : undefined;
    return code !== 'ESRCH';
  }
}

/**
 * Upper bound on how long an ownership record is treated as live evidence of
 * provable ownership — see this file's top-level TSDoc "Ownership records
 * are bounded evidence, not permanent licence" section. Without a bound, a
 * single record that never gets cleared (e.g. the app never runs again after
 * recording an attempt whose CLI invocation exits some other unusual way)
 * would arm auto-reclaim for that stack forever. 2 hours is a deliberately
 * generous multiple of what any realistic `preview`/`up`/`destroy` against
 * this app's stack (tens of resources) should take — tens of minutes at
 * most — chosen to avoid false negatives on a legitimately slow run while
 * still bounding the risk to a finite window rather than forever.
 */
export const PULUMI_LOCK_OWNERSHIP_RECORD_MAX_AGE_MS = 2 * 60 * 60 * 1000;

/** True when `record` is within {@link PULUMI_LOCK_OWNERSHIP_RECORD_MAX_AGE_MS} of `nowMs`. */
function isRecordFresh(record: PulumiLockOwnershipRecord, nowMs: number): boolean {
  return nowMs - new Date(record.startedAt).getTime() <= PULUMI_LOCK_OWNERSHIP_RECORD_MAX_AGE_MS;
}

/**
 * One outstanding ownership record together with the run id it's keyed
 * under — see {@link ElectronStoreService.listPulumiLockAttempts}.
 */
type OwnershipEntry = PulumiLockOwnershipRecord & { runId: string };

/**
 * True when `lock` can be proven a reclaimable orphan of *this installation's
 * own* prior run, per this file's top-level TSDoc: identity match, the
 * lock's process confirmed dead, and at least one fresh outstanding record
 * whose `startedAt` is at or before the lock's `lockedAt` (a lock created
 * before any recorded attempt began cannot be that attempt's lock). Returns
 * the matching record (so the caller can consume it) or `null`.
 */
function findReclaimEvidence(
  lock: PulumiStackLockInfo,
  identity: { username: string; hostname: string },
  freshRecords: OwnershipEntry[],
): OwnershipEntry | null {
  if (lock.username !== identity.username || lock.hostname !== identity.hostname) return null;
  if (isPidAlive(lock.pid)) return null;
  const lockedAtMs = lock.lockedAt.getTime();
  return freshRecords.find((record) => new Date(record.startedAt).getTime() <= lockedAtMs) ?? null;
}

/**
 * Classifies a caught error against the `pulumi-engine-runtime` delta spec's
 * "Stale backend lock recovery" requirement's provable-ownership test — see
 * this file's top-level TSDoc for the full reasoning, including the
 * liveness/time-consistency checks added after an independent review found
 * identity-matching alone could misclassify a live same-machine lock as a
 * reclaimable orphan.
 *
 * A lock is `'reclaimable-own-orphan'` only when **every** parsed lock entry
 * has matching own-installation reclaim evidence (see
 * {@link findReclaimEvidence}) — i.e. this installation both plausibly could
 * have created every lock present, has confirmed each one's process is no
 * longer running, and has a fresh local record consistent with having
 * started that specific lock's attempt. Requiring *every* lock to match (not
 * just one) matters because `stack.cancel()` — the mechanism used to
 * actually clear a stale lock — is not scoped to a single
 * lock file; reclaiming when even one present lock belongs to someone else
 * (or is still live) would improperly clear their lock too.
 *
 * As a side effect, this function also prunes the store: every record older
 * than {@link PULUMI_LOCK_OWNERSHIP_RECORD_MAX_AGE_MS} is cleared outright
 * (it's never valid evidence for anything, so there is no reason to keep
 * it), and if this call reaches `'reclaimable-own-orphan'`, the specific
 * record(s) actually relied on as evidence are cleared too — consuming that
 * evidence so it cannot be replayed to justify reclaiming some future,
 * unrelated lock.
 *
 * Anything else — no parsed locks at all, an identity mismatch, a live
 * process, or no fresh matching local record — is `'requires-confirmation'`,
 * carrying whatever locks *were* parsed (possibly none) for the caller to
 * surface via {@link PulumiUnrecognizedLockError}.
 *
 * @param now - Injectable for tests; defaults to the real current time.
 */
export function classifyStackLockConflict(
  err: unknown,
  store: ElectronStoreService,
  stackName: string,
  identity: { username: string; hostname: string } = { username: userInfo().username, hostname: osHostname() },
  now: Date = new Date(),
): PulumiLockClassification {
  if (!isStackLockConflict(err)) {
    return { kind: 'not-a-lock-conflict' };
  }

  const locks = parseStackLocks(err);
  const nowMs = now.getTime();

  const allRecords = store.listPulumiLockAttempts(stackName);
  const freshRecords: OwnershipEntry[] = [];
  for (const record of allRecords) {
    if (isRecordFresh(record, nowMs)) {
      freshRecords.push(record);
    } else {
      logger.warn('Pulumi lock-ownership record exceeded its max evidence age — pruning', {
        stackName,
        runId: record.runId,
        startedAt: record.startedAt,
      });
      store.clearPulumiLockAttempt(record.runId);
    }
  }

  if (locks.length === 0) {
    return { kind: 'requires-confirmation', locks };
  }

  const unusedRecords = [...freshRecords];
  const provenEvidence: OwnershipEntry[] = [];
  for (const lock of locks) {
    const evidence = findReclaimEvidence(lock, identity, unusedRecords);
    if (!evidence) break;
    unusedRecords.splice(unusedRecords.indexOf(evidence), 1);
    provenEvidence.push(evidence);
  }
  const allReclaimable = provenEvidence.length === locks.length;

  if (allReclaimable) {
    const consumedRunIds = new Set(provenEvidence.map((evidence) => evidence.runId));
    for (const runId of consumedRunIds) store.clearPulumiLockAttempt(runId);
    return { kind: 'reclaimable-own-orphan', locks };
  }
  return { kind: 'requires-confirmation', locks };
}

/**
 * Formats how long ago `lockedAt` was, for the confirmation prompt's "age"
 * display (`pulumi-engine-runtime`'s "Unrecognised lock requires
 * confirmation with evidence" scenario: "...the recorded holder, and the
 * lock's age"). Deliberately coarse (minutes/hours/days) rather than exact —
 * a stale-lock confirmation dialog cares whether a lock is "5 minutes old"
 * (plausibly still in progress — pause and check) vs. "3 days old"
 * (plausibly abandoned), not second-level precision.
 *
 * @remarks
 * Signature adapter over `@hyveon/shared`'s {@link formatRelativeAge} — this side works in
 * `Date`s, the web side (`submission-banners.component.tsx`'s `formatLockAge`) works in ISO
 * strings + an epoch ms, so each converts its own timestamp shape into a millisecond delta.
 *
 * @param lockedAt - When the lock was created (see {@link PulumiStackLockInfo.lockedAt}).
 * @param now - Injectable for tests; defaults to the real current time.
 */
export function formatLockAge(lockedAt: Date, now: Date = new Date()): string {
  return formatRelativeAge(now.getTime() - lockedAt.getTime());
}

/**
 * Thrown when a backend lock conflict cannot be proven to belong to this
 * installation — the `pulumi-engine-runtime` delta spec's "Unrecognised lock
 * requires confirmation with evidence" scenario. Carries `locks` (holder +
 * age, via {@link PulumiStackLockInfo.lockedAt}/{@link formatLockAge}) for
 * the renderer's confirmation UI to render; nothing is cleared until the
 * operator explicitly confirms — this class only *reports* the condition, it
 * never calls `stack.cancel()` itself.
 *
 * There is deliberately no equivalent `PulumiReclaimableLockError` — the
 * `'reclaimable-own-orphan'` classification is not surfaced to the operator
 * at all (per spec: "The app MAY reclaim it without prompting"); the caller
 * acts on that classification directly (calling `stack.cancel()` and
 * retrying) without ever constructing or throwing an error for it.
 */
export class PulumiUnrecognizedLockError extends Error {
  constructor(
    public readonly stackName: string,
    public readonly locks: PulumiStackLockInfo[],
  ) {
    super(describeUnrecognizedLock(stackName, locks));
    this.name = 'PulumiUnrecognizedLockError';
  }
}

function describeUnrecognizedLock(stackName: string, locks: PulumiStackLockInfo[]): string {
  if (locks.length === 0) {
    return (
      `Cannot run this Pulumi operation: the stack "${stackName}" is locked, but this installation cannot ` +
      'determine who holds the lock or how long ago it was taken. Confirm the lock is genuinely stale ' +
      '(e.g. a crashed run on another machine) before clearing it.'
    );
  }
  const holders = locks
    .map((lock) => `${lock.username}@${lock.hostname} (pid ${lock.pid}), ${formatLockAge(lock.lockedAt)}`)
    .join('; ');
  return (
    `Cannot run this Pulumi operation: the stack "${stackName}" is locked by ${holders}. This installation ` +
    'cannot prove it owns this lock — confirm it is genuinely stale before clearing it.'
  );
}
