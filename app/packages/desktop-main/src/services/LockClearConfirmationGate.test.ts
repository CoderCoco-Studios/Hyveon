/**
 * Tests for `LockClearConfirmationGate` — the generic mint/assert/consume
 * gate shared by the Pulumi-lock and durable run-lock clear flows.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LockClearConfirmationGate } from './LockClearConfirmationGate.js';

const TTL_MS = 5 * 60 * 1000;

// @spec IAC-RUN-LCLR-008
describe('LockClearConfirmationGate', () => {
  let gate: LockClearConfirmationGate<string>;

  beforeEach(() => {
    vi.useFakeTimers();
    gate = new LockClearConfirmationGate<string>(TTL_MS, (minted, current) => minted === current);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should report no-token-minted when nothing was minted', () => {
    expect(gate.assertFresh('x', 'run-1')).toEqual({ ok: false, reason: 'no-token-minted' });
  });

  it('should accept a minted token and return its binding', () => {
    const token = gate.mint('run-1');
    expect(gate.assertFresh(token, 'run-1')).toEqual({ ok: true, binding: 'run-1' });
  });

  it('should consume the token on success so it cannot be replayed', () => {
    const token = gate.mint('run-1');
    gate.assertFresh(token, 'run-1');
    expect(gate.assertFresh(token, 'run-1')).toEqual({ ok: false, reason: 'no-token-minted' });
  });

  it('should reject a superseded token and accept only the latest mint', () => {
    const first = gate.mint('run-1');
    const second = gate.mint('run-1');
    expect(gate.assertFresh(first, 'run-1')).toEqual({ ok: false, reason: 'token-mismatch' });
    expect(gate.assertFresh(second, 'run-1').ok).toBe(true);
  });

  it('should reject an expired token', () => {
    const token = gate.mint('run-1');
    vi.advanceTimersByTime(TTL_MS + 1);
    expect(gate.assertFresh(token, 'run-1')).toEqual({ ok: false, reason: 'expired' });
  });

  it('should reject a token whose binding no longer matches the current lock, including no lock', () => {
    const token = gate.mint('run-1');
    expect(gate.assertFresh(token, 'run-2')).toEqual({ ok: false, reason: 'binding-mismatch', minted: 'run-1' });
    expect(gate.assertFresh(token, null)).toEqual({ ok: false, reason: 'binding-mismatch', minted: 'run-1' });
  });

  it('should keep the pending token after a failed assert', () => {
    const token = gate.mint('run-1');
    gate.assertFresh('wrong', 'run-1');
    gate.assertFresh(token, 'run-2');
    expect(gate.assertFresh(token, 'run-1').ok).toBe(true);
  });
});
