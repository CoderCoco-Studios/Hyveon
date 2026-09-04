/**
 * Generic mint/assert/consume gate for a lock-clear confirmation token,
 * factored out of `PulumiService` (Pulumi backend lock) and `RunService`
 * (durable `RunLock`) — both services needed the exact same shape:
 *
 * - Mint a fresh, single-use token bound to a snapshot of "what's currently
 *   locked" (`TBinding`), where minting always supersedes any previously
 *   minted, unconsumed token.
 * - On a subsequent clear attempt, validate the supplied token against that
 *   pending mint: unexpired, not already consumed, AND still bound to what
 *   is CURRENTLY locked — not a different lock that was released and
 *   re-acquired in between. A stale/mismatched validation never mutates
 *   pending state, so a genuinely correct, still-valid token minted earlier
 *   remains usable by a later call even if an intervening call supplied a
 *   wrong one first.
 *
 * `TBinding` is deliberately generic: `PulumiService` binds on the
 * self-managed backend's state bucket/region/stack/project (its
 * `PulumiLockClearBinding`-shaped target), while `RunService` binds on a
 * bare `RunLock.runId` string. Neither caller's error type is
 * modeled here — `assertFresh` reports which check failed via
 * {@link LockClearAssertResult}'s `reason`, and each caller maps that to its
 * own thrown error type ({@link LockClearNotConfirmedError} /
 * `RunLockClearNotConfirmedError`) so existing call sites and log wording
 * are unaffected by this extraction.
 *
 * @typeParam TBinding - Shape of "what a minted token is bound to".
 */
import { randomUUID } from 'node:crypto';

/** A minted, not-yet-consumed confirmation token and what it's bound to. */
interface PendingLockClearConfirmation<TBinding> {
  /** The single-use token the caller must supply back to {@link LockClearConfirmationGate.assertFresh}. */
  token: string;
  /** Snapshot of "what's locked" at mint time — compared against the current snapshot on assert. */
  binding: TBinding;
  /** `Date.now() + ttlMs`, captured at mint time. */
  expiresAt: number;
}

/**
 * Outcome of {@link LockClearConfirmationGate.assertFresh}: either the token
 * was valid (and has now been consumed), returning the `TBinding` it was
 * minted for, or it was rejected for exactly one of four reasons — no token
 * was ever minted, the supplied token doesn't match the most recently minted
 * one, the most recently minted token has expired, or the binding it was
 * minted against no longer matches what's currently locked.
 */
export type LockClearAssertResult<TBinding> =
  | { ok: true; binding: TBinding }
  | { ok: false; reason: 'no-token-minted' | 'token-mismatch' | 'expired' | 'binding-mismatch' };

/**
 * Generic mint/assert/consume lock-clear confirmation token gate — see this
 * file's top-level doc comment for the full rationale.
 */
export class LockClearConfirmationGate<TBinding> {
  private pending: PendingLockClearConfirmation<TBinding> | null = null;

  /**
   * @param ttlMs - How long a minted token remains valid before
   *   {@link assertFresh} rejects it as expired, even if never consumed.
   * @param isMatch - Equality check between the binding recorded at mint
   *   time and the binding observed at assert time — plain equality for a
   *   bare `runId` string, or a field-by-field comparison for a multi-field
   *   target.
   */
  constructor(
    private readonly ttlMs: number,
    private readonly isMatch: (minted: TBinding, current: TBinding) => boolean,
  ) {}

  /**
   * Mints a fresh, single-use token bound to `binding`, superseding any
   * previously minted, unconsumed token (only the most recently minted token
   * is ever accepted by {@link assertFresh}).
   *
   * @param binding - Snapshot of what is currently locked, to bind the
   *   returned token to.
   * @returns The minted token.
   */
  mint(binding: TBinding): string {
    const token = randomUUID();
    this.pending = { token, binding, expiresAt: Date.now() + this.ttlMs };
    return token;
  }

  /**
   * Validates `token` against the most recently minted, not-yet-consumed
   * token: unexpired, and still bound (via `isMatch`) to `current`. On
   * success, consumes the token (clears the pending mint, so it can never be
   * replayed) and returns the binding it was minted for. On failure, leaves
   * the pending mint untouched.
   *
   * @param current - What is currently locked, or `null` if nothing is
   *   currently locked (never matches any minted binding).
   * @returns A {@link LockClearAssertResult} naming the specific rejection
   *   reason on failure, for the caller to log before throwing its own
   *   typed error.
   */
  assertFresh(token: string, current: TBinding | null): LockClearAssertResult<TBinding> {
    const pending = this.pending;
    if (!pending) return { ok: false, reason: 'no-token-minted' };
    if (pending.token !== token) return { ok: false, reason: 'token-mismatch' };
    if (Date.now() > pending.expiresAt) return { ok: false, reason: 'expired' };
    if (current === null || !this.isMatch(pending.binding, current)) return { ok: false, reason: 'binding-mismatch' };
    this.pending = null;
    return { ok: true, binding: pending.binding };
  }
}
