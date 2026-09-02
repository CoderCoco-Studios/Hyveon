/**
 * Unit tests for the stale-backend-lock-recovery primitives, covering the
 * `pulumi-engine-runtime` delta spec's "Stale backend lock recovery"
 * requirement's four scenarios: "Force-terminated run reclaims its own
 * lock", "Unrecognised lock requires confirmation with evidence", "Another
 * machine's active lock is not presented as stale", and "In-app concurrency
 * is reported as busy" (the last is not directly testable here — see the
 * describe block below explaining why this module never even sees that
 * case, so it is argued in prose/TSDoc rather than exercised by a test).
 *
 * Also covers: a live same-machine lock must never be classified as
 * reclaimable regardless of identity match, ownership records must be
 * pruned after a bounded age, and evidence used to justify a reclaim must
 * be consumed (cleared) rather than reusable.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';

const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../logger.js', () => ({ logger: loggerMock }));

import {
  isStackLockConflict,
  parseStackLocks,
  classifyStackLockConflict,
  isPidAlive,
  formatLockAge,
  PulumiUnrecognizedLockError,
  PULUMI_LOCK_OWNERSHIP_RECORD_MAX_AGE_MS,
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

/** Builds the DIY-backend lock-conflict stderr text for one or more locks, in the exact shape `pkg/backend/diy/lock.go` produces. */
function diyLockStderr(entries: { pid: number; username: string; hostname: string; lockedAt: string; url?: string }[]): string {
  const header = `the stack is currently locked by ${entries.length} lock(s). Either wait for the other process(es) to end or delete the lock file with \`pulumi cancel\`.`;
  const lines = entries.map(
    (e, i) =>
      `\n  ${e.url ?? `s3://my-bucket/.pulumi/locks/production/lock-${i}.json`}: created by ${e.username}@${e.hostname} (pid ${e.pid}) at ${e.lockedAt}`,
  );
  return header + lines.join('');
}

const SERVICE_BACKEND_CONFLICT_STDERR = '[409] Conflict: Another update is currently in progress.';

const IDENTITY = { username: 'chris', hostname: 'dev-machine' };

/** Simulates `process.kill(pid, 0)` throwing ESRCH — the "process is definitely gone" case. */
function mockPidDead(): void {
  vi.spyOn(process, 'kill').mockImplementation(() => {
    const err = new Error('no such process') as NodeJS.ErrnoException;
    err.code = 'ESRCH';
    throw err;
  });
}

/** Simulates `process.kill(pid, 0)` succeeding — the "process still exists" case. */
function mockPidAlive(): void {
  vi.spyOn(process, 'kill').mockImplementation(() => true);
}

/** Builds a stub `ElectronStoreService` whose `listPulumiLockAttempts`/`clearPulumiLockAttempt` are directly controlled and observable. */
function makeStore(records: (PulumiLockOwnershipRecord & { runId: string })[]): ElectronStoreService & {
  clearPulumiLockAttempt: ReturnType<typeof vi.fn>;
} {
  const cleared: string[] = [];
  return {
    listPulumiLockAttempts: vi.fn().mockImplementation(() => records.filter((r) => !cleared.includes(r.runId))),
    clearPulumiLockAttempt: vi.fn().mockImplementation((runId: string) => cleared.push(runId)),
  } as Partial<ElectronStoreService> as ElectronStoreService & { clearPulumiLockAttempt: ReturnType<typeof vi.fn> };
}

/** Builds a fresh `PulumiLockOwnershipRecord` for stack `production` under {@link IDENTITY}, with per-test overrides. */
function makeRecord(
  overrides: Partial<PulumiLockOwnershipRecord & { runId: string }> = {},
): PulumiLockOwnershipRecord & { runId: string } {
  return {
    runId: 'run-1',
    stackName: 'production',
    startedAt: '2024-01-15T10:29:00Z',
    username: 'chris',
    hostname: 'dev-machine',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('isStackLockConflict', () => {
  it('should return true for a real SDK ConcurrentUpdateError instance', () => {
    const stderr = diyLockStderr([{ pid: 4242, username: 'chris', hostname: 'dev-machine', lockedAt: '2024-01-15T10:30:00Z' }]);
    const err = realSdkErrorFromStderr(stderr);
    expect(err.name).toBe('ConcurrentUpdateError');

    expect(isStackLockConflict(err)).toBe(true);
  });

  it('should return true for a plain Error whose message matches the DIY-backend conflict text (backstop)', () => {
    const stderr = diyLockStderr([{ pid: 4242, username: 'chris', hostname: 'dev-machine', lockedAt: '2024-01-15T10:30:00Z' }]);
    expect(isStackLockConflict(new Error(stderr))).toBe(true);
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
    const stderr = diyLockStderr([{ pid: 4242, username: 'chris', hostname: 'dev-machine', lockedAt: '2024-01-15T10:30:00Z' }]);
    const err = realSdkErrorFromStderr(stderr);

    const locks = parseStackLocks(err);

    expect(locks).toHaveLength(1);
    expect(locks[0]).toMatchObject({
      lockUrl: 's3://my-bucket/.pulumi/locks/production/lock-0.json',
      username: 'chris',
      hostname: 'dev-machine',
      pid: 4242,
    });
    expect(locks[0].lockedAt.toISOString()).toBe(new Date('2024-01-15T10:30:00Z').toISOString());
  });

  it('should parse every entry out of a multi-lock message', () => {
    const stderr = diyLockStderr([
      { pid: 4242, username: 'chris', hostname: 'dev-machine', lockedAt: '2024-01-15T10:30:00Z' },
      { pid: 999, username: 'other-user', hostname: 'other-machine', lockedAt: '2024-01-15T10:31:00Z' },
    ]);
    const err = realSdkErrorFromStderr(stderr);

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

describe('isPidAlive', () => {
  it('should return false when process.kill throws ESRCH', () => {
    mockPidDead();

    expect(isPidAlive(999999)).toBe(false);
  });

  it('should return true when process.kill succeeds', () => {
    mockPidAlive();

    expect(isPidAlive(4242)).toBe(true);
  });

  it('should return true (conservative) when process.kill throws EPERM', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      const err = new Error('operation not permitted') as NodeJS.ErrnoException;
      err.code = 'EPERM';
      throw err;
    });

    expect(isPidAlive(1)).toBe(true);
  });
});

describe('classifyStackLockConflict — not a lock conflict', () => {
  it('should return kind "not-a-lock-conflict" for an unrelated error', () => {
    const store = makeStore([]);

    const result = classifyStackLockConflict(new Error('boom'), store, 'production', IDENTITY);

    expect(result).toEqual({ kind: 'not-a-lock-conflict' });
  });
});

describe('classifyStackLockConflict — force-terminated run reclaims its own lock', () => {
  it('should return "reclaimable-own-orphan" when identity matches, the pid is dead, and a fresh consistent record exists', () => {
    mockPidDead();
    const store = makeStore([makeRecord({ runId: 'run-1', startedAt: '2024-01-15T10:29:00Z' })]);
    const stderr = diyLockStderr([{ pid: 4242, username: 'chris', hostname: 'dev-machine', lockedAt: '2024-01-15T10:30:00Z' }]);
    const err = realSdkErrorFromStderr(stderr);
    const now = new Date('2024-01-15T10:35:00Z');

    const result = classifyStackLockConflict(err, store, 'production', IDENTITY, now);

    expect(result.kind).toBe('reclaimable-own-orphan');
    if (result.kind === 'reclaimable-own-orphan') {
      expect(result.locks).toHaveLength(1);
    }
  });

  it('should consume (clear) the specific evidence record used to justify the reclaim', () => {
    mockPidDead();
    const store = makeStore([makeRecord({ runId: 'the-evidence-run', startedAt: '2024-01-15T10:29:00Z' })]);
    const stderr = diyLockStderr([{ pid: 4242, username: 'chris', hostname: 'dev-machine', lockedAt: '2024-01-15T10:30:00Z' }]);
    const err = realSdkErrorFromStderr(stderr);
    const now = new Date('2024-01-15T10:35:00Z');

    classifyStackLockConflict(err, store, 'production', IDENTITY, now);

    expect(store.clearPulumiLockAttempt).toHaveBeenCalledWith('the-evidence-run');
  });

  it('should not let a consumed reclaim be replayed against a later, unrelated live lock (regression for the Critical finding)', () => {
    // First conflict: a genuine dead orphan, correctly reclaimed and its
    // evidence consumed.
    mockPidDead();
    const store = makeStore([makeRecord({ runId: 'the-evidence-run', startedAt: '2024-01-15T10:29:00Z' })]);
    const firstStderr = diyLockStderr([{ pid: 4242, username: 'chris', hostname: 'dev-machine', lockedAt: '2024-01-15T10:30:00Z' }]);
    const firstResult = classifyStackLockConflict(
      realSdkErrorFromStderr(firstStderr),
      store,
      'production',
      IDENTITY,
      new Date('2024-01-15T10:35:00Z'),
    );
    expect(firstResult.kind).toBe('reclaimable-own-orphan');

    // Second conflict, later: a genuinely LIVE same-machine process (the
    // exact Critical-finding failure mode) — must NOT be reclaimable, even
    // though the (now-cleared) evidence record used to exist.
    mockPidAlive();
    const secondStderr = diyLockStderr([{ pid: 5555, username: 'chris', hostname: 'dev-machine', lockedAt: '2024-01-15T11:00:00Z' }]);

    const secondResult = classifyStackLockConflict(
      realSdkErrorFromStderr(secondStderr),
      store,
      'production',
      IDENTITY,
      new Date('2024-01-15T11:01:00Z'),
    );

    expect(secondResult.kind).toBe('requires-confirmation');
  });
});

describe('classifyStackLockConflict — a LIVE same-machine lock must never be reclaimed (Critical finding)', () => {
  it('should return "requires-confirmation" when the lock pid is still alive, even with matching identity and a fresh outstanding record', () => {
    mockPidAlive();
    const store = makeStore([makeRecord({ runId: 'run-1', startedAt: '2024-01-15T10:29:00Z' })]);
    const stderr = diyLockStderr([{ pid: 4242, username: 'chris', hostname: 'dev-machine', lockedAt: '2024-01-15T10:30:00Z' }]);
    const err = realSdkErrorFromStderr(stderr);
    const now = new Date('2024-01-15T10:35:00Z');

    const result = classifyStackLockConflict(err, store, 'production', IDENTITY, now);

    expect(result.kind).toBe('requires-confirmation');
  });

  it('should not clear any record when the lock is live', () => {
    mockPidAlive();
    const store = makeStore([makeRecord({ runId: 'run-1', startedAt: '2024-01-15T10:29:00Z' })]);
    const stderr = diyLockStderr([{ pid: 4242, username: 'chris', hostname: 'dev-machine', lockedAt: '2024-01-15T10:30:00Z' }]);

    classifyStackLockConflict(realSdkErrorFromStderr(stderr), store, 'production', IDENTITY, new Date('2024-01-15T10:35:00Z'));

    expect(store.clearPulumiLockAttempt).not.toHaveBeenCalled();
  });
});

describe('classifyStackLockConflict — time-consistency: a lock predating every record is not evidence', () => {
  it('should return "requires-confirmation" when the only outstanding record started AFTER the lock was created', () => {
    mockPidDead();
    // Record starts AFTER the lock's own timestamp — cannot be the record
    // for a lock that already existed before this attempt began.
    const store = makeStore([makeRecord({ runId: 'run-1', startedAt: '2024-01-15T10:31:00Z' })]);
    const stderr = diyLockStderr([{ pid: 4242, username: 'chris', hostname: 'dev-machine', lockedAt: '2024-01-15T10:30:00Z' }]);

    const result = classifyStackLockConflict(
      realSdkErrorFromStderr(stderr),
      store,
      'production',
      IDENTITY,
      new Date('2024-01-15T10:35:00Z'),
    );

    expect(result.kind).toBe('requires-confirmation');
  });
});

describe('classifyStackLockConflict — ownership records are pruned after their max evidence age', () => {
  it('should prune (clear) a record older than PULUMI_LOCK_OWNERSHIP_RECORD_MAX_AGE_MS and not use it as evidence', () => {
    mockPidDead();
    const now = new Date('2024-01-15T10:35:00Z');
    const staleStartedAt = new Date(now.getTime() - PULUMI_LOCK_OWNERSHIP_RECORD_MAX_AGE_MS - 1_000).toISOString();
    const store = makeStore([makeRecord({ runId: 'stale-run', startedAt: staleStartedAt })]);
    const stderr = diyLockStderr([{ pid: 4242, username: 'chris', hostname: 'dev-machine', lockedAt: '2024-01-15T10:30:00Z' }]);

    const result = classifyStackLockConflict(realSdkErrorFromStderr(stderr), store, 'production', IDENTITY, now);

    expect(result.kind).toBe('requires-confirmation');
    expect(store.clearPulumiLockAttempt).toHaveBeenCalledWith('stale-run');
  });

  it('should keep a record within the max evidence age and still allow reclaim', () => {
    mockPidDead();
    const now = new Date('2024-01-15T10:35:00Z');
    const freshStartedAt = new Date(now.getTime() - PULUMI_LOCK_OWNERSHIP_RECORD_MAX_AGE_MS + 60_000).toISOString();
    const store = makeStore([makeRecord({ runId: 'fresh-run', startedAt: freshStartedAt })]);
    const stderr = diyLockStderr([
      { pid: 4242, username: 'chris', hostname: 'dev-machine', lockedAt: new Date(now.getTime() - 60_000).toISOString() },
    ]);

    const result = classifyStackLockConflict(realSdkErrorFromStderr(stderr), store, 'production', IDENTITY, now);

    expect(result.kind).toBe('reclaimable-own-orphan');
  });
});

describe('classifyStackLockConflict — unrecognised lock requires confirmation with evidence', () => {
  it('should return "requires-confirmation" carrying the parsed locks when no outstanding record exists at all', () => {
    mockPidDead();
    const store = makeStore([]);
    const stderr = diyLockStderr([{ pid: 4242, username: 'chris', hostname: 'dev-machine', lockedAt: '2024-01-15T10:30:00Z' }]);
    const err = realSdkErrorFromStderr(stderr);

    const result = classifyStackLockConflict(err, store, 'production', IDENTITY, new Date('2024-01-15T10:35:00Z'));

    expect(result.kind).toBe('requires-confirmation');
    if (result.kind === 'requires-confirmation') {
      expect(result.locks).toHaveLength(1);
      expect(result.locks[0].username).toBe('chris');
    }
  });

  it('should return "requires-confirmation" for a conflict with no parseable lock detail, even with an outstanding record', () => {
    const store = makeStore([makeRecord({ runId: 'run-1' })]);

    const result = classifyStackLockConflict(
      new Error(SERVICE_BACKEND_CONFLICT_STDERR),
      store,
      'production',
      IDENTITY,
      new Date('2024-01-15T10:35:00Z'),
    );

    expect(result).toEqual({ kind: 'requires-confirmation', locks: [] });
  });
});

describe("classifyStackLockConflict — another machine's active lock is not presented as stale", () => {
  it('should return "requires-confirmation" when the lock identity does not match this machine, even with an outstanding local record', () => {
    // This installation has its own outstanding record (e.g. from a
    // genuinely separate crashed run), but the *specific* lock we hit here
    // was created by a different machine entirely.
    const store = makeStore([makeRecord({ runId: 'run-1', startedAt: '2024-01-15T10:29:00Z' })]);
    const stderr = diyLockStderr([{ pid: 4242, username: 'chris', hostname: 'dev-machine', lockedAt: '2024-01-15T10:30:00Z' }]);
    const err = realSdkErrorFromStderr(stderr);

    const result = classifyStackLockConflict(
      err,
      store,
      'production',
      { username: 'someone-else', hostname: 'other-machine' },
      new Date('2024-01-15T10:35:00Z'),
    );

    expect(result.kind).toBe('requires-confirmation');
  });

  it('should return "requires-confirmation" when only some of several locks match this identity', () => {
    mockPidDead();
    const store = makeStore([makeRecord({ runId: 'run-1', startedAt: '2024-01-15T10:29:00Z' })]);
    const stderr = diyLockStderr([
      { pid: 4242, username: 'chris', hostname: 'dev-machine', lockedAt: '2024-01-15T10:30:00Z' },
      { pid: 999, username: 'other-user', hostname: 'other-machine', lockedAt: '2024-01-15T10:31:00Z' },
    ]);
    const err = realSdkErrorFromStderr(stderr);

    const result = classifyStackLockConflict(err, store, 'production', IDENTITY, new Date('2024-01-15T10:35:00Z'));

    expect(result.kind).toBe('requires-confirmation');
  });
});

describe('classifyStackLockConflict — one ownership record cannot prove two locks', () => {
  it('should return "requires-confirmation" when two dead same-machine locks share only one fresh record', () => {
    mockPidDead();
    const store = makeStore([makeRecord({ runId: 'run-1', startedAt: '2024-01-15T10:29:00Z' })]);
    const stderr = diyLockStderr([
      { pid: 4242, username: 'chris', hostname: 'dev-machine', lockedAt: '2024-01-15T10:30:00Z' },
      { pid: 4243, username: 'chris', hostname: 'dev-machine', lockedAt: '2024-01-15T10:31:00Z' },
    ]);
    const err = realSdkErrorFromStderr(stderr);

    const result = classifyStackLockConflict(err, store, 'production', IDENTITY, new Date('2024-01-15T10:35:00Z'));

    expect(result.kind).toBe('requires-confirmation');
  });
});

describe('classifyStackLockConflict — absence of in-flight activity is not evidence of staleness', () => {
  it('should return "requires-confirmation" when the lock identity happens to match this machine but no local record was ever made', () => {
    // Same machine identity as the lock, but this installation never
    // recorded starting an attempt against this stack at all (e.g. a manual
    // `pulumi` CLI invocation outside the app, on the same box).
    mockPidDead();
    const store = makeStore([]);
    const stderr = diyLockStderr([{ pid: 4242, username: 'chris', hostname: 'dev-machine', lockedAt: '2024-01-15T10:30:00Z' }]);
    const err = realSdkErrorFromStderr(stderr);

    const result = classifyStackLockConflict(err, store, 'production', IDENTITY, new Date('2024-01-15T10:35:00Z'));

    expect(result.kind).toBe('requires-confirmation');
  });
});

describe('classifyStackLockConflict — "in-app busy" is not this module\'s concern', () => {
  // The controller's pre-flight guard refuses in-app-concurrent requests before any SDK invocation, so they never reach this module.
  it.todo('should never reach classifyStackLockConflict for in-app-busy requests refused by the workspace guard');
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
    const stderr = diyLockStderr([{ pid: 4242, username: 'chris', hostname: 'dev-machine', lockedAt: '2024-01-15T10:30:00Z' }]);
    const locks = parseStackLocks(realSdkErrorFromStderr(stderr));

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
