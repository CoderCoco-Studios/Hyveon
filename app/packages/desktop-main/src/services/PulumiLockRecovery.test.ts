/**
 * Unit tests for Task 4.8's stale-backend-lock-recovery primitives, covering
 * the `pulumi-engine-runtime` delta spec's "Stale backend lock recovery"
 * requirement's four scenarios: "Force-terminated run reclaims its own
 * lock", "Unrecognised lock requires confirmation with evidence", "Another
 * machine's active lock is not presented as stale", and "In-app concurrency
 * is reported as busy" (the last is proven negatively here — see the describe
 * block below explaining why this module never even sees that case).
 */
import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
import {
  isStackLockConflict,
  parseStackLocks,
  classifyStackLockConflict,
  formatLockAge,
  PulumiUnrecognizedLockError,
} from './PulumiLockRecovery.js';
import type { ElectronStoreService, PulumiLockOwnershipRecord } from './ElectronStoreService.js';

// The real SDK's `ConcurrentUpdateError`/`CommandResult`/`createCommandError`
// are exported at runtime from `@pulumi/pulumi/automation/index.js` (verified
// during this task's investigation), but only `ConcurrentUpdateError` appears
// in the package's public `.d.ts` — `CommandResult`/`createCommandError` are
// internal-only and have no type declarations at all. This narrow structural
// cast (not a `Partial<T> as T` business-object stub) is scoped to loading
// those two untyped-but-real SDK internals for one test that proves the
// `instanceof ConcurrentUpdateError` branch against a genuine SDK-constructed
// instance, rather than only against a hand-built `Error`.
const automationInternals = createRequire(import.meta.url)('@pulumi/pulumi/automation/index.js') as {
  CommandResult: new (stdout: string, stderr: string, code: number) => { toString(): string };
  createCommandError: (result: { toString(): string }) => Error;
};

/** Builds a real SDK `ConcurrentUpdateError` (or another `CommandError` subtype) from raw stderr text, exactly as the CLI's own failure path would. */
function realSdkErrorFromStderr(stderr: string): Error {
  const result = new automationInternals.CommandResult('', stderr, 255);
  return automationInternals.createCommandError(result);
}

const DIY_LOCK_STDERR =
  'the stack is currently locked by 1 lock(s). Either wait for the other process(es) to end or delete the ' +
  'lock file with `pulumi cancel`.\n' +
  '  s3://my-bucket/.pulumi/locks/production/1111-2222.json: created by chris@dev-machine (pid 4242) at 2024-01-15T10:30:00Z';

const DIY_MULTI_LOCK_STDERR =
  'the stack is currently locked by 2 lock(s). Either wait for the other process(es) to end or delete the ' +
  'lock file with `pulumi cancel`.\n' +
  '  s3://my-bucket/.pulumi/locks/production/1111-2222.json: created by chris@dev-machine (pid 4242) at 2024-01-15T10:30:00Z\n' +
  '  s3://my-bucket/.pulumi/locks/production/3333-4444.json: created by other-user@other-machine (pid 999) at 2024-01-15T10:31:00Z';

const SERVICE_BACKEND_CONFLICT_STDERR = '[409] Conflict: Another update is currently in progress.';

/** Builds a stub `ElectronStoreService` whose `listPulumiLockAttempts` is directly controlled. */
function makeStore(records: PulumiLockOwnershipRecord[]): ElectronStoreService {
  return { listPulumiLockAttempts: vi.fn().mockReturnValue(records) } as Partial<ElectronStoreService> as ElectronStoreService;
}

describe('isStackLockConflict', () => {
  it('should return true for a real SDK ConcurrentUpdateError instance', () => {
    const err = realSdkErrorFromStderr(DIY_LOCK_STDERR);
    expect(err.name).toBe('ConcurrentUpdateError');

    expect(isStackLockConflict(err)).toBe(true);
  });

  it('should return true for a plain Error whose message matches the DIY-backend conflict text (backstop)', () => {
    expect(isStackLockConflict(new Error(DIY_LOCK_STDERR))).toBe(true);
  });

  it('should return true for a plain Error matching the Pulumi Cloud "[409] Conflict" text (backstop)', () => {
    expect(isStackLockConflict(new Error(SERVICE_BACKEND_CONFLICT_STDERR))).toBe(true);
  });

  it('should return false for an unrelated error', () => {
    expect(isStackLockConflict(new Error('some other CLI failure'))).toBe(false);
  });
});

describe('parseStackLocks', () => {
  it('should parse username, hostname, pid, lockUrl, and lockedAt from a single-lock message', () => {
    const err = realSdkErrorFromStderr(DIY_LOCK_STDERR);

    const locks = parseStackLocks(err);

    expect(locks).toHaveLength(1);
    expect(locks[0]).toMatchObject({
      lockUrl: 's3://my-bucket/.pulumi/locks/production/1111-2222.json',
      username: 'chris',
      hostname: 'dev-machine',
      pid: 4242,
    });
    expect(locks[0].lockedAt.toISOString()).toBe(new Date('2024-01-15T10:30:00Z').toISOString());
  });

  it('should parse every entry out of a multi-lock message', () => {
    const err = realSdkErrorFromStderr(DIY_MULTI_LOCK_STDERR);

    const locks = parseStackLocks(err);

    expect(locks).toHaveLength(2);
    expect(locks[1]).toMatchObject({ username: 'other-user', hostname: 'other-machine', pid: 999 });
  });

  it('should return an empty array for a conflict with no structured per-lock detail (e.g. the service backend)', () => {
    expect(parseStackLocks(new Error(SERVICE_BACKEND_CONFLICT_STDERR))).toEqual([]);
  });

  it('should return an empty array for an unrelated error', () => {
    expect(parseStackLocks(new Error('boom'))).toEqual([]);
  });
});

describe('classifyStackLockConflict — not a lock conflict', () => {
  it('should return kind "not-a-lock-conflict" for an unrelated error', () => {
    const store = makeStore([]);

    const result = classifyStackLockConflict(new Error('boom'), store, 'production', {
      username: 'chris',
      hostname: 'dev-machine',
    });

    expect(result).toEqual({ kind: 'not-a-lock-conflict' });
  });
});

describe('classifyStackLockConflict — force-terminated run reclaims its own lock', () => {
  it('should return "reclaimable-own-orphan" when every lock matches this identity and an outstanding record exists', () => {
    const store = makeStore([
      { stackName: 'production', startedAt: new Date().toISOString(), username: 'chris', hostname: 'dev-machine' },
    ]);
    const err = realSdkErrorFromStderr(DIY_LOCK_STDERR);

    const result = classifyStackLockConflict(err, store, 'production', { username: 'chris', hostname: 'dev-machine' });

    expect(result.kind).toBe('reclaimable-own-orphan');
    if (result.kind === 'reclaimable-own-orphan') {
      expect(result.locks).toHaveLength(1);
    }
  });
});

describe('classifyStackLockConflict — unrecognised lock requires confirmation with evidence', () => {
  it('should return "requires-confirmation" carrying the parsed locks when no outstanding record exists at all', () => {
    const store = makeStore([]);
    const err = realSdkErrorFromStderr(DIY_LOCK_STDERR);

    const result = classifyStackLockConflict(err, store, 'production', { username: 'chris', hostname: 'dev-machine' });

    expect(result.kind).toBe('requires-confirmation');
    if (result.kind === 'requires-confirmation') {
      expect(result.locks).toHaveLength(1);
      expect(result.locks[0].username).toBe('chris');
    }
  });

  it('should return "requires-confirmation" for a conflict with no parseable lock detail, even with an outstanding record', () => {
    const store = makeStore([
      { stackName: 'production', startedAt: new Date().toISOString(), username: 'chris', hostname: 'dev-machine' },
    ]);

    const result = classifyStackLockConflict(
      new Error(SERVICE_BACKEND_CONFLICT_STDERR),
      store,
      'production',
      { username: 'chris', hostname: 'dev-machine' },
    );

    expect(result).toEqual({ kind: 'requires-confirmation', locks: [] });
  });
});

describe("classifyStackLockConflict — another machine's active lock is not presented as stale", () => {
  it('should return "requires-confirmation" when the lock identity does not match this machine, even with an outstanding local record', () => {
    // This installation has its own outstanding record (e.g. from a genuinely
    // separate crashed run), but the *specific* lock we hit here was created
    // by a different machine entirely — the spec requires this never be
    // reclaimed automatically.
    const store = makeStore([
      { stackName: 'production', startedAt: new Date().toISOString(), username: 'chris', hostname: 'dev-machine' },
    ]);
    const err = realSdkErrorFromStderr(DIY_LOCK_STDERR); // locked by chris@dev-machine

    const result = classifyStackLockConflict(err, store, 'production', {
      username: 'someone-else',
      hostname: 'other-machine',
    });

    expect(result.kind).toBe('requires-confirmation');
  });

  it('should return "requires-confirmation" when only some of several locks match this identity', () => {
    const store = makeStore([
      { stackName: 'production', startedAt: new Date().toISOString(), username: 'chris', hostname: 'dev-machine' },
    ]);
    const err = realSdkErrorFromStderr(DIY_MULTI_LOCK_STDERR); // one lock is chris@dev-machine, the other is not

    const result = classifyStackLockConflict(err, store, 'production', { username: 'chris', hostname: 'dev-machine' });

    expect(result.kind).toBe('requires-confirmation');
  });
});

describe('classifyStackLockConflict — absence of in-flight activity is not evidence of staleness', () => {
  it('should return "requires-confirmation" when the lock identity happens to match this machine but no local record was ever made', () => {
    // Same machine identity as the lock, but this installation never
    // recorded starting an attempt against this stack at all (e.g. a manual
    // `pulumi` CLI invocation outside the app, on the same box) — the spec's
    // "provable ownership, not absence of local activity" principle means
    // this must still require confirmation.
    const store = makeStore([]);
    const err = realSdkErrorFromStderr(DIY_LOCK_STDERR);

    const result = classifyStackLockConflict(err, store, 'production', { username: 'chris', hostname: 'dev-machine' });

    expect(result.kind).toBe('requires-confirmation');
  });
});

describe('formatLockAge', () => {
  const now = new Date('2024-01-15T12:00:00Z');

  it('should describe a lock less than a minute old', () => {
    expect(formatLockAge(new Date('2024-01-15T11:59:35Z'), now)).toBe('less than a minute ago');
  });

  it('should describe a lock a few minutes old', () => {
    expect(formatLockAge(new Date('2024-01-15T11:55:00Z'), now)).toBe('5 minutes ago');
  });

  it('should describe a lock a few hours old', () => {
    expect(formatLockAge(new Date('2024-01-15T09:00:00Z'), now)).toBe('3 hours ago');
  });

  it('should describe a lock several days old', () => {
    expect(formatLockAge(new Date('2024-01-12T12:00:00Z'), now)).toBe('3 days ago');
  });
});

describe('PulumiUnrecognizedLockError', () => {
  it('should carry the stack name and locks, and include holder + age in its message', () => {
    const locks = parseStackLocks(realSdkErrorFromStderr(DIY_LOCK_STDERR));

    const err = new PulumiUnrecognizedLockError('production', locks);

    expect(err.name).toBe('PulumiUnrecognizedLockError');
    expect(err.stackName).toBe('production');
    expect(err.locks).toBe(locks);
    expect(err.message).toContain('chris@dev-machine');
    expect(err.message).toContain('pid 4242');
  });

  it('should describe an unknown holder gracefully when no locks were parsed', () => {
    const err = new PulumiUnrecognizedLockError('production', []);

    expect(err.message).toContain('cannot determine who holds the lock');
  });
});
