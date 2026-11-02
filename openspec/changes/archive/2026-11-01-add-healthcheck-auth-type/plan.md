# Health-Check Credential Types (`raw`/`basic`/`bearer`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let operators declare a health check's credential as `basic` (username+password) or `bearer` (token) without hand-encoding anything, while keeping today's `raw` (operator-supplied ARN, operator-owned secret) behavior unchanged — and have the app itself provision, update, and retire the Secrets Manager secret backing a `basic`/`bearer` credential.

**Architecture:** `GameServerHealthCheckAuth` gains an optional `type` discriminator (`'raw' | 'basic' | 'bearer'`, default `'raw'`). The persisted shape stays `{ type?, secretArn }` in all three cases — for `basic`/`bearer` the operator never sees or supplies `secretArn`; `GamesWriteService` resolves it by creating/updating an app-owned Secrets Manager secret (deterministically named `hyveon-{gameId}-healthcheck-auth`) from operator-submitted plaintext (username/password or token) before the entry is validated and persisted. The health-check Lambda's engine branches header construction on `auth.type` at request time. The wizard gains a type selector and per-type plaintext inputs; plaintext never survives past the write path — nothing beyond the existing `secretSet` boolean crosses back to the renderer.

**Tech Stack:** TypeScript, Zod (validation), NestJS (`@MessagePattern` IPC), `@aws-sdk/client-secrets-manager`, React (wizard), Vitest + `aws-sdk-client-mock` (tests).

**Spec:** `openspec/changes/add-healthcheck-auth-type/specs/game-health-checks/spec.md` (also see `design.md` and `brainstorm.md` in the same directory for the decision record this plan implements).

## Global Constraints

- Absent `auth.type` on any existing or new config means `type: 'raw'` everywhere (validator, engine, redaction, wizard hydration) — zero migration, every pre-existing config keeps working unchanged.
- `basic` secret value is `JSON.stringify({ username, password })`; engine sets `Authorization: Basic <base64(username:password)>`. `bearer` secret value is the raw token; engine sets `Authorization: Bearer <token>`. `raw` injects the secret's raw value verbatim, no prefix — unchanged from today.
- App-owned secret name is deterministic: `hyveon-{gameId}-healthcheck-auth` (one per game, since `GameServerHealthCheck` allows at most one `auth`). Confirmed against no other naming scheme in this codebase before use (Task 3.1).
- `DeleteSecretCommand` uses AWS's default recovery window — never pass `ForceDeleteWithoutRecovery` (design.md's stated default).
- A malformed `basic` secret (not valid `{ username, password }` JSON) is treated as an unavailable credential: caught, `logger.warn`'d, health check evaluates as failed/active for that cycle — the existing fail-active path, no new error class.
- Plaintext credential parts (username, password, token) are write-only: submitted by the operator, consumed once to create/update the app-owned secret, and never persisted to `deployment-config.json` or returned to the renderer. Only `RedactedGameServerHealthCheck.secretSet: boolean` ever crosses the IPC boundary, uniformly across all three types.
- No IAM policy change — `secretsmanager:*` in `HYVEON_DEPLOY_ALL_ACTIONS` already covers `CreateSecret`/`PutSecretValue`/`DeleteSecret`; Task 5 adds regression coverage only.
- Every IPC-reachable handler this change touches (`GamesController`'s existing `games.create`/`games.update`/`games.delete`) already logs on entry per `.claude/rules/logging.md` — no new `@MessagePattern` channel is introduced by this change (see Task 3's rationale for why).
- Test names read as sentences starting with "should". TSDoc on non-trivial functions/constants, ordered summary → `@remarks` → `@param` → `@returns` → `@throws` per `.claude/rules/tsdoc-tags.md`.
- Commit style: Conventional Commits, one commit per task group, matching this repo's history (`feat(health-check): ...`, `feat(shared): ...`, etc.).

---

## Task 1: Shared types and validation

**Files:**
- Modify: `app/packages/shared/src/gameServerConfig.ts:97-101` (`GameServerHealthCheckAuth`)
- Modify: `app/packages/shared/src/gameServerValidator.ts:93-116` (`gameServerHealthCheckAuthSchema`), plus new exports
- Modify: `app/packages/shared/src/gamesWrite.ts` (write-payload types)
- Test: `app/packages/shared/src/gameServerValidator.test.ts`

**Interfaces:**
- Produces: `GameServerHealthCheckAuth.type?: 'raw' | 'basic' | 'bearer'` (persisted shape, unchanged `secretArn: string`).
- Produces: `GameServerHealthCheckAuthWriteInput` (`app/packages/shared/src/gameServerValidator.ts`) — `{ type?: 'raw' | 'basic' | 'bearer'; secretArn?: string; username?: string; password?: string; token?: string }`, the operator-submitted shape before the app resolves a persisted `secretArn`.
- Produces: `validateHealthCheckAuthInput(auth: unknown): GameServerValidationIssue[]` — validates the write-input shape's per-type plaintext requirements; treats `undefined`/`null` as valid (no credential change).
- Produces: `GameServerHealthCheckWriteInput` / `GameServerWriteConfig` (`app/packages/shared/src/gamesWrite.ts`) — the `CreateGamePayload`/`UpdateGamePayload.config` shape, widened so `healthCheck.auth` accepts `GameServerHealthCheckAuthWriteInput | null | undefined` (`null` means "explicitly clear the credential", `undefined` means "leave unchanged" on update, unset on create).
- Consumes: nothing from earlier tasks (this is the foundation task).

- [ ] **Step 1: Write failing tests for the `type` field on the persisted schema**

Add to `app/packages/shared/src/gameServerValidator.test.ts`, inside the existing `describe('health check', ...)` block (after the `'should accept a well-formed auth.secretArn'` test, ~line 663):

```typescript
    it('should accept auth.type "raw" alongside a well-formed secretArn', () => {
      const result = validateGameServer(
        'game',
        makeProposed({
          healthCheck: makeHealthCheck({
            auth: { type: 'raw', secretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:game-token-AbCdEf' },
          }),
        }),
        [],
      );
      expect(result.success).toBe(true);
    });

    it('should accept auth.type "basic" alongside a well-formed secretArn (persisted app-owned shape)', () => {
      const result = validateGameServer(
        'game',
        makeProposed({
          healthCheck: makeHealthCheck({
            auth: { type: 'basic', secretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:game-auth-AbCdEf' },
          }),
        }),
        [],
      );
      expect(result.success).toBe(true);
    });

    it('should accept auth.type "bearer" alongside a well-formed secretArn (persisted app-owned shape)', () => {
      const result = validateGameServer(
        'game',
        makeProposed({
          healthCheck: makeHealthCheck({
            auth: { type: 'bearer', secretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:game-auth-AbCdEf' },
          }),
        }),
        [],
      );
      expect(result.success).toBe(true);
    });

    it('should reject an auth.type of "basic" with no secretArn (the persisted schema always requires one)', () => {
      const result = validateGameServer(
        'game',
        makeProposed({ healthCheck: makeHealthCheck({ auth: { type: 'basic' } }) }),
        [],
      );
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.issues.some((i) => i.path === 'healthCheck.auth.secretArn')).toBe(true);
      }
    });

    it('should reject an unrecognized auth.type', () => {
      const result = validateGameServer(
        'game',
        makeProposed({
          healthCheck: makeHealthCheck({
            auth: { type: 'oauth', secretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:game-token-AbCdEf' },
          }),
        }),
        [],
      );
      expect(result.success).toBe(false);
    });
```

Also add a new top-level `describe` block at the end of the file (after the `estimateFargateHourlyCost` block) for the new write-input validator:

```typescript
import { validateHealthCheckAuthInput } from './gameServerValidator.js';

describe('validateHealthCheckAuthInput', () => {
  it('should accept undefined (no credential change)', () => {
    expect(validateHealthCheckAuthInput(undefined)).toEqual([]);
  });

  it('should accept null (explicit clear)', () => {
    expect(validateHealthCheckAuthInput(null)).toEqual([]);
  });

  it('should accept a well-formed raw credential', () => {
    const issues = validateHealthCheckAuthInput({
      type: 'raw',
      secretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:game-token-AbCdEf',
    });
    expect(issues).toEqual([]);
  });

  it('should reject a raw credential with no secretArn', () => {
    const issues = validateHealthCheckAuthInput({ type: 'raw' });
    expect(issues.some((i) => i.path === 'healthCheck.auth.secretArn')).toBe(true);
  });

  it('should treat an omitted type the same as "raw"', () => {
    const issues = validateHealthCheckAuthInput({ secretArn: 'not-an-arn' });
    expect(issues.some((i) => i.path === 'healthCheck.auth.secretArn')).toBe(true);
  });

  it('should accept a well-formed basic credential', () => {
    const issues = validateHealthCheckAuthInput({ type: 'basic', username: 'admin', password: 'hunter2' });
    expect(issues).toEqual([]);
  });

  it('should reject a basic credential missing a password', () => {
    const issues = validateHealthCheckAuthInput({ type: 'basic', username: 'admin' });
    expect(issues.some((i) => i.path === 'healthCheck.auth.password')).toBe(true);
  });

  it('should reject a basic credential missing a username', () => {
    const issues = validateHealthCheckAuthInput({ type: 'basic', password: 'hunter2' });
    expect(issues.some((i) => i.path === 'healthCheck.auth.username')).toBe(true);
  });

  it('should accept a well-formed bearer credential', () => {
    const issues = validateHealthCheckAuthInput({ type: 'bearer', token: 'sk-abc123' });
    expect(issues).toEqual([]);
  });

  it('should reject a bearer credential missing a token', () => {
    const issues = validateHealthCheckAuthInput({ type: 'bearer' });
    expect(issues.some((i) => i.path === 'healthCheck.auth.token')).toBe(true);
  });
});
```

- [ ] **Step 2: Run the new tests to confirm they fail**

Run: `npm run app:test -- gameServerValidator --run` (from repo root)
Expected: FAIL — `validateHealthCheckAuthInput` is not exported yet; `auth.type` is rejected by the current schema (`z.object({ secretArn })` has no `type` key but `.strict()` isn't set, so extra keys are actually silently stripped by default Zod behavior, meaning the `'basic'`/`'bearer'` tests currently pass structurally but fail your new assertions about `type` round-tripping — confirm by reading the failure output, not by assuming).

- [ ] **Step 3: Add `type` to `GameServerHealthCheckAuth`**

In `app/packages/shared/src/gameServerConfig.ts`, replace lines 97-101:

```typescript
/**
 * Credential reference for an authenticated health check. Carries a
 * Secrets Manager ARN — never a raw value — plus a `type` discriminator for
 * how the resolved secret's value is turned into the outbound request's
 * `Authorization` header.
 */
export interface GameServerHealthCheckAuth {
  /**
   * Credential shape this reference declares. `'raw'` (the default when
   * this field is absent) injects the resolved secret's raw value verbatim,
   * no prefix — exactly the behavior every configuration had before this
   * field existed. `'basic'` and `'bearer'` are both app-owned: the system
   * creates, updates, and deletes the backing secret itself; the operator
   * supplies only the credential's plaintext parts (never a `secretArn`) for
   * those two types. See `GamesWriteService.resolveHealthCheckAuthSecret`
   * (`@hyveon/desktop-main`) for the write-side resolution that turns
   * operator-submitted plaintext into this field's `secretArn`.
   */
  type?: 'raw' | 'basic' | 'bearer';
  /**
   * ARN of the Secrets Manager secret whose value is injected as the
   * outbound request's `Authorization` header. Operator-supplied and
   * operator-owned for `type: 'raw'` (or no `type`). App-created and
   * app-owned for `type: 'basic'`/`'bearer'` — deterministically named
   * `hyveon-{gameId}-healthcheck-auth`; the operator never sees or enters
   * this ARN for those two types.
   */
  secretArn: string;
}
```

- [ ] **Step 4: Update `gameServerHealthCheckAuthSchema` to accept `type`**

In `app/packages/shared/src/gameServerValidator.ts`, replace lines 108-116:

```typescript
/** Zod schema mirroring `GameServerHealthCheckAuth` — the persisted shape, always carrying a `secretArn` regardless of `type`. */
export const gameServerHealthCheckAuthSchema = z.object({
  type: z.enum(['raw', 'basic', 'bearer']).optional(),
  secretArn: z
    .string()
    .regex(
      SECRET_ARN_PATTERN,
      'healthCheck.auth.secretArn must be a Secrets Manager secret ARN (arn:aws:secretsmanager:<region>:<account>:secret:<name>).',
    ),
});
```

- [ ] **Step 5: Add the write-input schema, type, and `validateHealthCheckAuthInput`**

In `app/packages/shared/src/gameServerValidator.ts`, add immediately after the `gameServerHealthCheckAuthSchema` block from Step 4:

```typescript
/**
 * Operator-submitted shape of a health-check credential, as it travels over
 * the `games.create`/`games.update` IPC channels before the write path
 * resolves a persisted `secretArn` — see `GameServerHealthCheckAuthWriteInput`'s
 * doc comment for the full write-time contract.
 */
export const gameServerHealthCheckAuthInputSchema = z
  .object({
    type: z.enum(['raw', 'basic', 'bearer']).optional(),
    secretArn: z.string().optional(),
    username: z.string().optional(),
    password: z.string().optional(),
    token: z.string().optional(),
  })
  .superRefine((auth, ctx) => {
    const type = auth.type ?? 'raw';
    if (type === 'basic') {
      if (!auth.username) {
        ctx.addIssue({ code: 'custom', message: 'healthCheck.auth.username is required for type "basic".', path: ['username'] });
      }
      if (!auth.password) {
        ctx.addIssue({ code: 'custom', message: 'healthCheck.auth.password is required for type "basic".', path: ['password'] });
      }
      return;
    }
    if (type === 'bearer') {
      if (!auth.token) {
        ctx.addIssue({ code: 'custom', message: 'healthCheck.auth.token is required for type "bearer".', path: ['token'] });
      }
      return;
    }
    if (!auth.secretArn) {
      ctx.addIssue({
        code: 'custom',
        message: 'healthCheck.auth.secretArn is required for type "raw" (or no declared type).',
        path: ['secretArn'],
      });
    }
  });

/**
 * Operator-submitted shape of a health-check credential — the type
 * {@link gameServerHealthCheckAuthInputSchema} validates. Distinct from the
 * persisted {@link GameServerHealthCheckAuth} (imported from
 * `./gameServerConfig.js`) in `@hyveon/shared`'s `gameServerConfig.ts`:
 * `secretArn` is only ever present here for `type: 'raw'` (the operator's
 * own pre-existing ARN); `basic`/`bearer` instead carry plaintext
 * (`username`/`password`, or `token`) that the write path consumes once to
 * create or update an app-owned secret, never persisting the plaintext
 * itself.
 */
export interface GameServerHealthCheckAuthWriteInput {
  type?: 'raw' | 'basic' | 'bearer';
  secretArn?: string;
  username?: string;
  password?: string;
  token?: string;
}

/**
 * Validates the per-type plaintext requirements of an operator-submitted
 * health-check credential: `basic` requires both `username` and `password`;
 * `bearer` requires a `token`; `raw` (or no declared `type`) requires a
 * `secretArn`. Returns no issues for `undefined` or `null` — both are valid
 * "no credential change" states on the write path (see
 * `GameServerHealthCheckAuthWriteInput`'s doc and `gamesWrite.ts`'s
 * `null`-means-clear / `undefined`-means-unchanged convention).
 *
 * Reused by both the wizard's client-side per-step validation
 * (`@hyveon/web`'s `wizard-form.utils.ts`) and `GamesWriteService`'s
 * server-side check, so the two can never phrase this rule differently.
 *
 * @param auth - The candidate write-input value, typically untrusted (e.g.
 *   parsed JSON from an IPC payload).
 * @returns Every validation issue found, each pathed under `healthCheck.auth`.
 */
export function validateHealthCheckAuthInput(auth: unknown): GameServerValidationIssue[] {
  if (auth === undefined || auth === null) {
    return [];
  }
  const result = gameServerHealthCheckAuthInputSchema.safeParse(auth);
  if (result.success) {
    return [];
  }
  return result.error.issues.map((issue) => ({
    path: issue.path.length > 0 ? `healthCheck.auth.${formatPath(issue.path)}` : 'healthCheck.auth',
    message: issue.message,
  }));
}
```

- [ ] **Step 6: Run the tests to confirm they pass**

Run: `npm run app:test -- gameServerValidator --run`
Expected: PASS — all new and existing tests green.

- [ ] **Step 7: Widen the write-payload types in `gamesWrite.ts`**

In `app/packages/shared/src/gamesWrite.ts`, add after the existing imports (line 10) and before `GameWriteSuccess` (line 19):

```typescript
import type { GameServerHealthCheck } from './gameServerConfig.js';
import type { GameServerHealthCheckAuthWriteInput } from './gameServerValidator.js';

/**
 * Write-side shape of `GameServerHealthCheck.auth`: the operator-submitted
 * {@link GameServerHealthCheckAuthWriteInput}, `null` to explicitly clear an
 * existing credential (deleting its app-owned secret if one backs it), or
 * `undefined` to leave whatever credential is already on record unchanged.
 * Only ever appears in a create/update payload — never in a persisted
 * `GameServerHealthCheck`, which always resolves to a concrete
 * `GameServerHealthCheckAuth | undefined`.
 */
export type GameServerHealthCheckWriteInput = Omit<GameServerHealthCheck, 'auth'> & {
  auth?: GameServerHealthCheckAuthWriteInput | null;
};

/**
 * Write-side shape of a `game_servers` entry submitted to `games.create` /
 * `games.update`: identical to `Omit<GameServer, 'name'>` except
 * `healthCheck`, which uses {@link GameServerHealthCheckWriteInput} so a
 * `basic`/`bearer` credential can be submitted as plaintext rather than a
 * pre-resolved `secretArn`.
 */
export type GameServerWriteConfig = Omit<GameServer, 'name' | 'healthCheck'> & {
  healthCheck?: GameServerHealthCheckWriteInput;
};
```

Then change `CreateGamePayload.config` and `UpdateGamePayload.config` (lines 95 and 105) from `Omit<GameServer, 'name'>` to `GameServerWriteConfig`, and add `GameServer` to the existing `import type { GameServer, GameListEntry, RedactedGameServer } from './gameServerConfig.js';` (already imported — no change needed there).

- [ ] **Step 8: Run the full shared-package typecheck and test suite**

Run: `npm run app:typecheck && npm run app:test -- --run` (from repo root)
Expected: PASS — no type errors, all tests green. (`app.controller`/`GamesController` etc. still compile because `GameServerWriteConfig` is structurally compatible with how `GamesWriteService` currently reads `payload.config` — Task 3 updates that consumption.)

- [ ] **Step 9: Commit**

```bash
git add app/packages/shared/src/gameServerConfig.ts app/packages/shared/src/gameServerValidator.ts app/packages/shared/src/gameServerValidator.test.ts app/packages/shared/src/gamesWrite.ts
git commit -m "feat(shared): add basic/bearer credential types to health-check auth"
```

---

## Task 2: Health-check engine

**Files:**
- Modify: `app/packages/lambda/health-check/src/handler.ts:87-116`
- Test: `app/packages/lambda/health-check/src/handler.test.ts`

**Interfaces:**
- Consumes: `GameServerHealthCheckAuth.type` from Task 1.
- Produces: nothing new consumed by later tasks — this is a leaf.

- [ ] **Step 1: Write failing tests for `basic`/`bearer` header construction**

Add to `app/packages/lambda/health-check/src/handler.test.ts`, after the existing `'should override an operator-supplied Authorization header...'` test (~line 120):

```typescript
  it('should base64-encode a well-formed basic credential as Authorization: Basic', async () => {
    ecsMock.on(DescribeTasksCommand).resolves({ tasks: [runningTask('10.0.1.23')] });
    secretsManagerMock.on(GetSecretValueCommand).resolves({ SecretString: JSON.stringify({ username: 'admin', password: 'hunter2' }) });
    fetchMock.mockResolvedValue(new Response('{"players":{"online":1}}', { status: 200 }));

    await handler({
      game: 'palworld',
      taskArn: 'task-arn',
      healthCheck: makeHealthCheck({
        auth: { type: 'basic', secretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:palworld-auth-AbCdEf' },
      }),
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const expected = `Basic ${Buffer.from('admin:hunter2', 'utf8').toString('base64')}`;
    expect((init.headers as Record<string, string>)['Authorization']).toBe(expected);
  });

  it('should prefix a bearer credential as Authorization: Bearer', async () => {
    ecsMock.on(DescribeTasksCommand).resolves({ tasks: [runningTask('10.0.1.23')] });
    secretsManagerMock.on(GetSecretValueCommand).resolves({ SecretString: 'sk-abc123' });
    fetchMock.mockResolvedValue(new Response('{"players":{"online":1}}', { status: 200 }));

    await handler({
      game: 'palworld',
      taskArn: 'task-arn',
      healthCheck: makeHealthCheck({
        auth: { type: 'bearer', secretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:palworld-auth-AbCdEf' },
      }),
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer sk-abc123');
  });

  it('should inject a raw credential verbatim when auth.type is explicitly "raw"', async () => {
    ecsMock.on(DescribeTasksCommand).resolves({ tasks: [runningTask('10.0.1.23')] });
    secretsManagerMock.on(GetSecretValueCommand).resolves({ SecretString: 'super-secret-token' });
    fetchMock.mockResolvedValue(new Response('{"players":{"online":1}}', { status: 200 }));

    await handler({
      game: 'palworld',
      taskArn: 'task-arn',
      healthCheck: makeHealthCheck({
        auth: { type: 'raw', secretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:palworld-token-AbCdEf' },
      }),
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['Authorization']).toBe('super-secret-token');
  });

  it('should be fail-active when a basic credential secret is not valid JSON', async () => {
    ecsMock.on(DescribeTasksCommand).resolves({ tasks: [runningTask('10.0.1.23')] });
    secretsManagerMock.on(GetSecretValueCommand).resolves({ SecretString: 'not-json' });

    const verdict = await handler({
      game: 'palworld',
      taskArn: 'task-arn',
      healthCheck: makeHealthCheck({
        auth: { type: 'basic', secretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:palworld-auth-AbCdEf' },
      }),
    });

    expect(verdict.active).toBe(true);
    expect(verdict.failureDerived).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('should be fail-active when a basic credential secret is JSON but missing username/password', async () => {
    ecsMock.on(DescribeTasksCommand).resolves({ tasks: [runningTask('10.0.1.23')] });
    secretsManagerMock.on(GetSecretValueCommand).resolves({ SecretString: JSON.stringify({ username: 'admin' }) });

    const verdict = await handler({
      game: 'palworld',
      taskArn: 'task-arn',
      healthCheck: makeHealthCheck({
        auth: { type: 'basic', secretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:palworld-auth-AbCdEf' },
      }),
    });

    expect(verdict.active).toBe(true);
    expect(verdict.failureDerived).toBe(true);
  });

  it('should never let a basic credential\'s username or password reach the logger', async () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    ecsMock.on(DescribeTasksCommand).resolves({ tasks: [runningTask('10.0.1.23')] });
    secretsManagerMock.on(GetSecretValueCommand).resolves({ SecretString: JSON.stringify({ username: 'admin', password: 'hunter2' }) });
    fetchMock.mockResolvedValue(new Response('{"players":{"online":1}}', { status: 200 }));

    await handler({
      game: 'palworld',
      taskArn: 'task-arn',
      healthCheck: makeHealthCheck({
        auth: { type: 'basic', secretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:palworld-auth-AbCdEf' },
      }),
    });

    const allLoggedText = [...debugSpy.mock.calls, ...warnSpy.mock.calls].flat().join(' ');
    expect(allLoggedText).not.toContain('hunter2');
    expect(allLoggedText).not.toContain('admin');
  });
```

- [ ] **Step 2: Run the tests to confirm they fail**

Run: `npm run app:test -- handler.test --run` (from repo root, or `cd app/packages/lambda/health-check && npx vitest run`)
Expected: FAIL — `basic`/`bearer` currently fall through to the verbatim-injection path, so the `Authorization` header is the raw JSON/token, not `Basic ...`/`Bearer ...`.

- [ ] **Step 3: Implement type-branched header construction**

In `app/packages/lambda/health-check/src/handler.ts`, change the import on line 19 to also pull in the auth type:

```typescript
import type { GameServerHealthCheck, GameServerHealthCheckAuth } from '@hyveon/shared';
```

Replace `resolveAuthValue` (lines 87-97) and `buildHeaders` (lines 99-116) with:

```typescript
/** Resolves the declared credential's raw secret string, or `undefined` when the health check declares no `auth`. */
async function resolveAuthSecretValue(healthCheck: GameServerHealthCheck): Promise<string | undefined> {
  if (!healthCheck.auth) {
    return undefined;
  }
  const resp = await secretsManager.send(new GetSecretValueCommand({ SecretId: healthCheck.auth.secretArn }));
  if (resp.SecretString === undefined) {
    throw new Error('Secret has no string value');
  }
  return resp.SecretString;
}

/**
 * Builds the `Authorization` header value for a resolved secret, branching
 * on `auth.type` (absent or `'raw'` injects `secretValue` verbatim, no
 * prefix — unchanged from before `type` existed). Throws for a `basic`
 * credential whose secret isn't valid `{ username, password }` JSON — the
 * caller's existing top-level try/catch turns that into the same fail-active
 * verdict as any other resolve failure.
 *
 * @param auth - The health check's credential declaration.
 * @param secretValue - The raw string fetched from Secrets Manager for `auth.secretArn`.
 * @throws {Error} When `auth.type === 'basic'` and `secretValue` isn't valid `{ username, password }` JSON.
 */
function buildAuthorizationHeader(auth: GameServerHealthCheckAuth, secretValue: string): string {
  const type = auth.type ?? 'raw';
  if (type === 'raw') {
    return secretValue;
  }
  if (type === 'bearer') {
    return `Bearer ${secretValue}`;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(secretValue);
  } catch {
    throw new Error('basic credential secret is not valid JSON');
  }
  const record = parsed as Record<string, unknown> | null;
  if (
    typeof record !== 'object' ||
    record === null ||
    typeof record['username'] !== 'string' ||
    typeof record['password'] !== 'string'
  ) {
    throw new Error('basic credential secret is not a { username, password } object');
  }
  const encoded = Buffer.from(`${record['username']}:${record['password']}`, 'utf8').toString('base64');
  return `Basic ${encoded}`;
}

/**
 * Merges the declared headers with the resolved, type-branched credential.
 * The injected `Authorization` header always takes precedence over an
 * operator-supplied one of the same name, so a working credential can't be
 * silently overridden by a stray declared header.
 */
function buildHeaders(healthCheck: GameServerHealthCheck, authorizationValue: string | undefined): Record<string, string> {
  const headers = { ...(healthCheck.headers ?? {}) };
  if (authorizationValue !== undefined) {
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === 'authorization') {
        delete headers[key];
      }
    }
    headers['Authorization'] = authorizationValue;
  }
  return headers;
}
```

Then update the `handler` body (lines 130-160) where `resolveAuthValue`/`buildHeaders` are called — replace:

```typescript
    const [host, authValue] = await Promise.all([resolveTaskHost(taskArn), resolveAuthValue(healthCheck)]);
    const headers = buildHeaders(healthCheck, authValue);
```

with:

```typescript
    const [host, secretValue] = await Promise.all([resolveTaskHost(taskArn), resolveAuthSecretValue(healthCheck)]);
    const authorizationValue =
      secretValue !== undefined && healthCheck.auth ? buildAuthorizationHeader(healthCheck.auth, secretValue) : undefined;
    const headers = buildHeaders(healthCheck, authorizationValue);
```

- [ ] **Step 4: Run the tests to confirm they pass**

Run: `npm run app:test -- handler.test --run`
Expected: PASS — all new and existing tests green, including the pre-existing `'should never let a secret value reach the logger'` and raw-injection regression tests.

- [ ] **Step 5: Commit**

```bash
git add app/packages/lambda/health-check/src/handler.ts app/packages/lambda/health-check/src/handler.test.ts
git commit -m "feat(health-check): branch Authorization header construction on auth.type"
```

---

## Task 3: App-owned secret lifecycle

**Design note (deviates from `tasks.md` 3.5's literal phrasing):** `tasks.md` describes "an IPC-exposed service method" plus a new `desktop-preload` bridge entry for the create/update/delete calls. In practice, the credential is always submitted as part of the full game entry through the *already-IPC-exposed* `games.create`/`games.update`/`games.delete` channels (`GamesController`, unchanged in this task) — there is no wizard UX moment that saves a credential independently of saving the whole game. Introducing a second, separate IPC channel with no caller would be dead code. This plan instead threads the secret lifecycle through `GamesWriteService`, which already owns the `games.create`/`update`/`delete` write path, already follows the logging convention (`logger.debug` on entry, `logger.warn`/`error` on caught failures), and already has access to the "before" config needed to detect an app-owned secret to reuse or retire. No new `@MessagePattern` or preload method is added.

**Files:**
- Modify: `app/packages/shared/src/secrets/secretsStore.ts` (new create/update/delete functions)
- Test: `app/packages/shared/src/secrets/secretsStore.test.ts`
- Modify: `app/packages/desktop-main/src/services/GamesWriteService.ts` (wire lifecycle into create/update/delete)
- Test: `app/packages/desktop-main/src/services/GamesWriteService.test.ts`

**Interfaces:**
- Consumes: `GameServerHealthCheckAuthWriteInput`, `validateHealthCheckAuthInput`, `GameServerWriteConfig` from Task 1.
- Produces: `healthCheckAuthSecretName(gameId: string): string`, `upsertHealthCheckAuthSecret(gameId: string, value: string): Promise<string>`, `deleteHealthCheckAuthSecret(gameId: string): Promise<void>` (`app/packages/shared/src/secrets/secretsStore.ts`) — consumed by Task 4's wizard-facing code only indirectly (via `GamesWriteService`, not directly).
- Produces: `GamesWriteService.resolveHealthCheckAuthSecret` (private) — referenced by name in this plan's Global Constraints and by `gameServerConfig.ts`'s TSDoc from Task 1; not called by any other task.

- [ ] **Step 1: Confirm the secret naming scheme has no collision**

Run: `grep -rn "hyveon-.*-healthcheck\|SecretId\|CreateSecretCommand" app/packages/shared/src/secrets/ app/packages/infra/src/secrets.ts app/packages/desktop-main/src/services/DiscordConfigService.ts 2>/dev/null`

Confirm the Discord bot-token/public-key secrets (provisioned by `@hyveon/infra`'s `secrets.ts`, read/written via `secretsStore.ts`'s `getBotToken`/`putBotToken`/`getPublicKey`/`putPublicKey`) use a different naming pattern than `hyveon-{gameId}-healthcheck-auth` (they're Pulumi-provisioned resource names, not app-created-at-runtime names) — record the confirmation in the PR description. No code change in this step.

- [ ] **Step 2: Write failing tests for the new `secretsStore.ts` functions**

Add to `app/packages/shared/src/secrets/secretsStore.test.ts` (create the file if it doesn't already exist, following the `handler.test.ts`/`IamCheckService.test.ts` `aws-sdk-client-mock` convention):

```typescript
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  SecretsManagerClient,
  PutSecretValueCommand,
  CreateSecretCommand,
  DeleteSecretCommand,
  ResourceNotFoundException,
} from '@aws-sdk/client-secrets-manager';
import {
  healthCheckAuthSecretName,
  upsertHealthCheckAuthSecret,
  deleteHealthCheckAuthSecret,
  __resetSecretsClient,
} from './secretsStore.js';

const secretsManagerMock = mockClient(SecretsManagerClient);

beforeEach(() => {
  secretsManagerMock.reset();
  __resetSecretsClient();
});

afterEach(() => {
  secretsManagerMock.reset();
});

describe('healthCheckAuthSecretName', () => {
  it('should build a deterministic per-game secret name', () => {
    expect(healthCheckAuthSecretName('palworld')).toBe('hyveon-palworld-healthcheck-auth');
  });
});

describe('upsertHealthCheckAuthSecret', () => {
  it('should PutSecretValue and return the ARN when the secret already exists', async () => {
    secretsManagerMock
      .on(PutSecretValueCommand, { SecretId: 'hyveon-palworld-healthcheck-auth' })
      .resolves({ ARN: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:hyveon-palworld-healthcheck-auth-AbCdEf' });

    const arn = await upsertHealthCheckAuthSecret('palworld', 'sk-abc123');

    expect(arn).toBe('arn:aws:secretsmanager:us-east-1:123456789012:secret:hyveon-palworld-healthcheck-auth-AbCdEf');
    expect(secretsManagerMock.commandCalls(CreateSecretCommand)).toHaveLength(0);
  });

  it('should CreateSecret and return the ARN when PutSecretValue reports the secret does not exist', async () => {
    secretsManagerMock
      .on(PutSecretValueCommand)
      .rejects(new ResourceNotFoundException({ message: 'not found', $metadata: {} }));
    secretsManagerMock
      .on(CreateSecretCommand, { Name: 'hyveon-palworld-healthcheck-auth', SecretString: 'sk-abc123' })
      .resolves({ ARN: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:hyveon-palworld-healthcheck-auth-AbCdEf' });

    const arn = await upsertHealthCheckAuthSecret('palworld', 'sk-abc123');

    expect(arn).toBe('arn:aws:secretsmanager:us-east-1:123456789012:secret:hyveon-palworld-healthcheck-auth-AbCdEf');
  });

  it('should rethrow a PutSecretValue failure that is not ResourceNotFoundException', async () => {
    secretsManagerMock.on(PutSecretValueCommand).rejects(new Error('AccessDenied'));

    await expect(upsertHealthCheckAuthSecret('palworld', 'sk-abc123')).rejects.toThrow('AccessDenied');
    expect(secretsManagerMock.commandCalls(CreateSecretCommand)).toHaveLength(0);
  });
});

describe('deleteHealthCheckAuthSecret', () => {
  it('should DeleteSecret without ForceDeleteWithoutRecovery (default recovery window)', async () => {
    secretsManagerMock.on(DeleteSecretCommand).resolves({});

    await deleteHealthCheckAuthSecret('palworld');

    const calls = secretsManagerMock.commandCalls(DeleteSecretCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args[0].input).toEqual({ SecretId: 'hyveon-palworld-healthcheck-auth' });
  });

  it('should not throw when the secret does not exist', async () => {
    secretsManagerMock
      .on(DeleteSecretCommand)
      .rejects(new ResourceNotFoundException({ message: 'not found', $metadata: {} }));

    await expect(deleteHealthCheckAuthSecret('palworld')).resolves.toBeUndefined();
  });

  it('should rethrow a DeleteSecret failure that is not ResourceNotFoundException', async () => {
    secretsManagerMock.on(DeleteSecretCommand).rejects(new Error('AccessDenied'));

    await expect(deleteHealthCheckAuthSecret('palworld')).rejects.toThrow('AccessDenied');
  });
});
```

- [ ] **Step 3: Run the tests to confirm they fail**

Run: `npm run app:test -- secretsStore --run`
Expected: FAIL — `healthCheckAuthSecretName`/`upsertHealthCheckAuthSecret`/`deleteHealthCheckAuthSecret` don't exist yet.

- [ ] **Step 4: Implement the new `secretsStore.ts` functions**

In `app/packages/shared/src/secrets/secretsStore.ts`, change the import on lines 1-5 to:

```typescript
import {
  SecretsManagerClient,
  GetSecretValueCommand,
  PutSecretValueCommand,
  CreateSecretCommand,
  DeleteSecretCommand,
  ResourceNotFoundException,
} from '@aws-sdk/client-secrets-manager';
```

Add at the end of the file:

```typescript
/** Builds the deterministic, per-game Secrets Manager secret name for an app-owned health-check credential (`basic`/`bearer`). One secret per game — `GameServerHealthCheck` allows at most one `auth`. */
export function healthCheckAuthSecretName(gameId: string): string {
  return `hyveon-${gameId}-healthcheck-auth`;
}

/**
 * Creates or updates the app-owned health-check credential secret for
 * `gameId`, and returns its ARN. Idempotent by construction: the secret name
 * is deterministic ({@link healthCheckAuthSecretName}), so this always tries
 * `PutSecretValueCommand` first (the common "already exists" case) and only
 * falls back to `CreateSecretCommand` when Secrets Manager reports the
 * secret doesn't exist yet — no separate "does it already exist" read is
 * needed, and no caller has to track prior ARNs across edits.
 *
 * @param gameId - The `game_servers` map key this credential belongs to.
 * @param value - The secret's plaintext value — `JSON.stringify({ username, password })`
 *   for a `basic` credential, or the raw token for `bearer`. Never logged.
 * @returns The secret's ARN, to persist as `GameServerHealthCheckAuth.secretArn`.
 */
export async function upsertHealthCheckAuthSecret(gameId: string, value: string): Promise<string> {
  const name = healthCheckAuthSecretName(gameId);
  try {
    const putResp = await getClient().send(new PutSecretValueCommand({ SecretId: name, SecretString: value }));
    inProcessCache.delete(name);
    if (!putResp.ARN) {
      throw new Error(`PutSecretValueCommand for ${name} did not return an ARN`);
    }
    return putResp.ARN;
  } catch (err) {
    if (!(err instanceof ResourceNotFoundException)) {
      throw err;
    }
    const createResp = await getClient().send(new CreateSecretCommand({ Name: name, SecretString: value }));
    if (!createResp.ARN) {
      throw new Error(`CreateSecretCommand for ${name} did not return an ARN`);
    }
    return createResp.ARN;
  }
}

/**
 * Deletes the app-owned health-check credential secret for `gameId`, using
 * Secrets Manager's default recovery window (no `ForceDeleteWithoutRecovery`
 * — a deliberate default-recovery-window choice, safer against an
 * accidental clear than immediate, unrecoverable deletion). A no-op if the
 * secret doesn't exist — deleting an already-absent app-owned secret (e.g.
 * a retry after a partial failure) must not surface as an error.
 *
 * @param gameId - The `game_servers` map key whose credential secret should be retired.
 */
export async function deleteHealthCheckAuthSecret(gameId: string): Promise<void> {
  const name = healthCheckAuthSecretName(gameId);
  try {
    await getClient().send(new DeleteSecretCommand({ SecretId: name }));
    inProcessCache.delete(name);
  } catch (err) {
    if (!(err instanceof ResourceNotFoundException)) {
      throw err;
    }
  }
}
```

- [ ] **Step 5: Run the tests to confirm they pass**

Run: `npm run app:test -- secretsStore --run`
Expected: PASS.

- [ ] **Step 6: Write failing tests for `GamesWriteService`'s lifecycle wiring**

Add to `app/packages/desktop-main/src/services/GamesWriteService.test.ts` (matching that file's existing mock/setup conventions — inspect it for the exact `ConfigService`/`DeploymentConfigService`/`AuditService` stub shapes before writing these; the assertions below are what must hold regardless of that scaffolding):

```typescript
import { upsertHealthCheckAuthSecret, deleteHealthCheckAuthSecret } from '@hyveon/shared/secrets/secretsStore';

vi.mock('@hyveon/shared/secrets/secretsStore', () => ({
  upsertHealthCheckAuthSecret: vi.fn(),
  deleteHealthCheckAuthSecret: vi.fn(),
}));

describe('health-check credential lifecycle', () => {
  it('should create an app-owned secret on first save of a basic credential and persist only its secretArn', async () => {
    vi.mocked(upsertHealthCheckAuthSecret).mockResolvedValue(
      'arn:aws:secretsmanager:us-east-1:123456789012:secret:hyveon-minecraft-healthcheck-auth-AbCdEf',
    );
    const { service, deploymentConfig } = makeService({ existingGameServers: [] });

    const result = await service.createGame({
      name: 'minecraft',
      config: makeConfig({
        healthCheck: makeHealthCheck({ auth: { type: 'basic', username: 'admin', password: 'hunter2' } }),
      }),
    });

    expect(upsertHealthCheckAuthSecret).toHaveBeenCalledWith('minecraft', JSON.stringify({ username: 'admin', password: 'hunter2' }));
    expect(result.ok).toBe(true);
    const written = vi.mocked(deploymentConfig.addGameServer).mock.calls[0]?.[1];
    expect(written.healthCheck?.auth).toEqual({
      type: 'basic',
      secretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:hyveon-minecraft-healthcheck-auth-AbCdEf',
    });
  });

  it('should update the existing app-owned secret in place when a bearer token changes, not create a new one', async () => {
    vi.mocked(upsertHealthCheckAuthSecret).mockResolvedValue(
      'arn:aws:secretsmanager:us-east-1:123456789012:secret:hyveon-minecraft-healthcheck-auth-AbCdEf',
    );
    const before = makeExistingGame({
      name: 'minecraft',
      healthCheck: makeHealthCheck({
        auth: {
          type: 'bearer',
          secretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:hyveon-minecraft-healthcheck-auth-AbCdEf',
        },
      }),
    });
    const { service } = makeService({ existingGameServers: [before] });

    await service.updateGame({
      name: 'minecraft',
      config: makeConfig({ healthCheck: makeHealthCheck({ auth: { type: 'bearer', token: 'new-token' } }) }),
    });

    expect(upsertHealthCheckAuthSecret).toHaveBeenCalledWith('minecraft', 'new-token');
  });

  it('should delete the app-owned secret when a basic credential is removed', async () => {
    const before = makeExistingGame({
      name: 'minecraft',
      healthCheck: makeHealthCheck({
        auth: {
          type: 'basic',
          secretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:hyveon-minecraft-healthcheck-auth-AbCdEf',
        },
      }),
    });
    const { service } = makeService({ existingGameServers: [before] });

    await service.updateGame({
      name: 'minecraft',
      config: makeConfig({ healthCheck: { ...makeHealthCheck(), auth: null } }),
    });

    expect(deleteHealthCheckAuthSecret).toHaveBeenCalledWith('minecraft');
  });

  it('should delete the app-owned secret when a game with an app-owned credential is deleted', async () => {
    const before = makeExistingGame({
      name: 'minecraft',
      healthCheck: makeHealthCheck({
        auth: {
          type: 'basic',
          secretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:hyveon-minecraft-healthcheck-auth-AbCdEf',
        },
      }),
    });
    const { service } = makeService({ existingGameServers: [before] });

    await service.deleteGame({ name: 'minecraft' });

    expect(deleteHealthCheckAuthSecret).toHaveBeenCalledWith('minecraft');
  });

  it('should never call upsertHealthCheckAuthSecret or deleteHealthCheckAuthSecret for a raw credential', async () => {
    const before = makeExistingGame({
      name: 'minecraft',
      healthCheck: makeHealthCheck({
        auth: { type: 'raw', secretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:operator-owned-AbCdEf' },
      }),
    });
    const { service } = makeService({ existingGameServers: [before] });

    await service.deleteGame({ name: 'minecraft' });

    expect(upsertHealthCheckAuthSecret).not.toHaveBeenCalled();
    expect(deleteHealthCheckAuthSecret).not.toHaveBeenCalled();
  });

  it('should return a validation failure without calling Secrets Manager when a basic credential is missing a password', async () => {
    const { service } = makeService({ existingGameServers: [] });

    const result = await service.createGame({
      name: 'minecraft',
      config: makeConfig({ healthCheck: makeHealthCheck({ auth: { type: 'basic', username: 'admin' } }) }),
    });

    expect(result).toMatchObject({ ok: false, code: 'validation' });
    expect(upsertHealthCheckAuthSecret).not.toHaveBeenCalled();
  });
});
```

(Add `makeConfig`/`makeExistingGame`/`makeHealthCheck` helper functions at the top of the test file if the file doesn't already have equivalents — mirror `gameServerValidator.test.ts`'s `makeProposed`/`makeExisting` pattern, returning a minimal valid `GameServerWriteConfig`/`GameServer` with overridable fields, and `makeService` returning `{ service: GamesWriteService, deploymentConfig: <stubbed DeploymentConfigService> }` per this file's existing constructor-stubbing convention.)

- [ ] **Step 7: Run the tests to confirm they fail**

Run: `npm run app:test -- GamesWriteService --run`
Expected: FAIL — `GamesWriteService` doesn't yet call `upsertHealthCheckAuthSecret`/`deleteHealthCheckAuthSecret`, and `createGame`/`updateGame` reject a `basic`/`bearer` `auth` with no `secretArn` (today's schema requires one unconditionally before Task 1's Step 4 change — already fixed — but nothing yet resolves the plaintext into a `secretArn` before validation).

- [ ] **Step 8: Wire the lifecycle into `GamesWriteService`**

In `app/packages/desktop-main/src/services/GamesWriteService.ts`, add to the imports (after line 32):

```typescript
import { deleteHealthCheckAuthSecret, upsertHealthCheckAuthSecret } from '@hyveon/shared/secrets/secretsStore';
import { validateHealthCheckAuthInput, type GameServerHealthCheckAuthWriteInput } from '@hyveon/shared/gameServerValidator';
import type { GameServerWriteConfig } from '@hyveon/shared';
```

Add a private method to the `GamesWriteService` class (after `errorResult`, before the closing brace):

```typescript
  /**
   * Resolves `config.healthCheck.auth` into the persisted
   * `GameServerHealthCheckAuth` shape (`{ type?, secretArn }`), performing
   * whatever Secrets Manager write the declared change requires:
   *  - `auth` omitted → leave `before`'s credential unchanged (existing
   *    behavior, unchanged from before this feature).
   *  - `auth === null` → explicit clear. Deletes `before`'s app-owned secret
   *    (if `before.auth.type` was `'basic'`/`'bearer'`) and returns `config`
   *    with `healthCheck.auth` unset.
   *  - `auth.type` `'raw'`/absent → the operator-supplied `secretArn` is
   *    used as-is (already required by {@link validateHealthCheckAuthInput}
   *    before this method runs). If `before`'s credential was app-owned
   *    (`'basic'`/`'bearer'`), its now-orphaned secret is deleted.
   *  - `auth.type` `'basic'`/`'bearer'` → builds the secret value
   *    (`JSON.stringify({ username, password })` or the raw `token`) and
   *    calls {@link upsertHealthCheckAuthSecret}, which creates the secret on
   *    first save and updates it in place on every subsequent edit (see
   *    that function's own doc for why no separate "does it already exist"
   *    check is needed).
   *
   * Never called for a `deleteGame` — that path calls
   * {@link deleteHealthCheckAuthSecret} directly in {@link deleteGame} once
   * the config removal itself has succeeded.
   *
   * @param gameId - The `game_servers` map key this entry is being saved under.
   * @param config - The proposed write-side config (may be `undefined` when the entry has no `healthCheck` at all).
   * @param before - The entry's prior persisted state, or `null` for a brand-new game.
   * @returns `config` with `healthCheck.auth` resolved to the persisted shape (or `undefined`), ready for `validateGameServer`.
   */
  private async resolveHealthCheckAuthSecret(
    gameId: string,
    config: GameServerWriteConfig,
    before: GameServer | null,
  ): Promise<Omit<GameServer, 'name'>> {
    if (!config.healthCheck) {
      if (before?.healthCheck?.auth && (before.healthCheck.auth.type === 'basic' || before.healthCheck.auth.type === 'bearer')) {
        await this.deleteAppOwnedSecret(gameId, before.healthCheck.auth.secretArn);
      }
      return { ...config, healthCheck: undefined };
    }

    const { auth, ...healthCheckRest } = config.healthCheck;
    const beforeAuth = before?.healthCheck?.auth;

    if (auth === undefined) {
      return { ...config, healthCheck: { ...healthCheckRest, auth: beforeAuth } };
    }

    if (auth === null) {
      if (beforeAuth && (beforeAuth.type === 'basic' || beforeAuth.type === 'bearer')) {
        await this.deleteAppOwnedSecret(gameId, beforeAuth.secretArn);
      }
      return { ...config, healthCheck: { ...healthCheckRest, auth: undefined } };
    }

    const type = auth.type ?? 'raw';
    if (type === 'raw') {
      if (beforeAuth && (beforeAuth.type === 'basic' || beforeAuth.type === 'bearer')) {
        await this.deleteAppOwnedSecret(gameId, beforeAuth.secretArn);
      }
      return { ...config, healthCheck: { ...healthCheckRest, auth: { type: 'raw', secretArn: auth.secretArn as string } } };
    }

    const secretValue = type === 'basic' ? JSON.stringify({ username: auth.username, password: auth.password }) : (auth.token as string);
    const secretArn = await this.upsertAppOwnedSecret(gameId, secretValue);
    return { ...config, healthCheck: { ...healthCheckRest, auth: { type, secretArn } } };
  }

  /** Wraps {@link upsertHealthCheckAuthSecret}, normalizing and logging any Secrets Manager failure per this repo's logging convention. */
  private async upsertAppOwnedSecret(gameId: string, value: string): Promise<string> {
    try {
      return await upsertHealthCheckAuthSecret(gameId, value);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('GamesWriteService.resolveHealthCheckAuthSecret: failed to create/update the health-check credential secret', {
        game: gameId,
        error: message,
      });
      throw new Error(`Failed to save the health-check credential: ${message}`);
    }
  }

  /** Wraps {@link deleteHealthCheckAuthSecret}, logging (not throwing on) a Secrets Manager failure — a delete-cleanup failure must not block the config write it's tidying up after. */
  private async deleteAppOwnedSecret(gameId: string, secretArn: string): Promise<void> {
    try {
      await deleteHealthCheckAuthSecret(gameId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn('GamesWriteService.resolveHealthCheckAuthSecret: failed to delete an orphaned health-check credential secret', {
        game: gameId,
        secretArn,
        error: message,
      });
    }
  }
```

Then update `createGame` (replace lines 91-97):

```typescript
  async createGame(payload: CreateGamePayload): Promise<GameWriteResult> {
    logger.debug('GamesWriteService.createGame: creating game server entry', { game: payload.name });
    const authIssues = validateHealthCheckAuthInput(payload.config.healthCheck?.auth);
    if (authIssues.length > 0) {
      return { ok: false, code: 'validation', issues: authIssues };
    }
    const resolvedConfig = await this.resolveHealthCheckAuthSecret(payload.name, payload.config, null);
    const siblings = await this.deploymentConfig.getGameServers();
    const validation = validateGameServer(payload.name, resolvedConfig, siblings);
    if (!validation.success) {
      return { ok: false, code: 'validation', issues: validation.issues };
    }
```

Update `updateGame` (replace lines 146-164, which currently splices `before?.healthCheck?.auth` inline):

```typescript
  async updateGame(payload: UpdateGamePayload): Promise<GameWriteResult> {
    logger.debug('GamesWriteService.updateGame: updating game server entry', { game: payload.name });
    const siblings = await this.deploymentConfig.getGameServers();
    const before = siblings.find((sibling) => sibling.name === payload.name) ?? null;

    const authIssues = validateHealthCheckAuthInput(payload.config.healthCheck?.auth);
    if (authIssues.length > 0) {
      return { ok: false, code: 'validation', issues: authIssues };
    }

    // resolveHealthCheckAuthSecret now owns the "omitted auth means unchanged"
    // splice that used to live inline here — see its own doc comment.
    const incomingConfig = await this.resolveHealthCheckAuthSecret(payload.name, payload.config, before);

    const validation = validateGameServer(payload.name, incomingConfig, siblings);
    if (!validation.success) {
      return { ok: false, code: 'validation', issues: validation.issues };
    }
```

Update `deleteGame` to delete an app-owned secret after a successful removal — insert immediately after the `write = await this.deploymentConfig.removeGameServer(...)` try block succeeds (after line 212, before `return this.successResult(...)` on line 226):

```typescript
    if (before?.healthCheck?.auth && (before.healthCheck.auth.type === 'basic' || before.healthCheck.auth.type === 'bearer')) {
      await this.deleteAppOwnedSecret(payload.name, before.healthCheck.auth.secretArn);
    }

    return this.successResult('delete', payload.name, undefined, { before, after: null, versionId: write.versionId });
```

Finally, remove the now-redundant `import type { CreateGamePayload, ... UpdateGamePayload } from '@hyveon/shared';` reference to `GameServerWriteConfig` handling — no import removal needed, `CreateGamePayload`/`UpdateGamePayload` are already `@hyveon/shared` exports and now resolve `config` to `GameServerWriteConfig` automatically via Task 1's Step 7 change.

- [ ] **Step 9: Run the tests to confirm they pass**

Run: `npm run app:test -- GamesWriteService --run`
Expected: PASS.

- [ ] **Step 10: Run the shared + desktop-main test suites and typecheck**

Run: `npm run app:typecheck && npm run app:test -- --run`
Expected: PASS — no type errors anywhere in the workspace, all unit tests green.

- [ ] **Step 11: Commit**

```bash
git add app/packages/shared/src/secrets/secretsStore.ts app/packages/shared/src/secrets/secretsStore.test.ts app/packages/desktop-main/src/services/GamesWriteService.ts app/packages/desktop-main/src/services/GamesWriteService.test.ts
git commit -m "feat(desktop-main): provision and retire app-owned health-check credential secrets"
```

---

## Task 4: Wizard UI

**Files:**
- Modify: `app/packages/web/src/components/add-game-wizard/wizard-form.utils.ts`
- Modify: `app/packages/web/src/components/add-game-wizard/networking-step.component.tsx:407-424`
- Test: `app/packages/web/src/components/add-game-wizard/networking-step.component.test.tsx` (create if it doesn't exist, following `docs/docs/components/integration-tests.md`'s jsdom/`renderPage()` convention)
- Modify: `app/packages/desktop-main/src/services/GameWizardDraftService.ts`
- Modify: `app/packages/desktop-preload/src/hyveon-api.ts` (the `GameWizardDraft.healthCheck` mirror, ~line 60)

**Interfaces:**
- Consumes: `GameServerHealthCheckAuthWriteInput`, `validateHealthCheckAuthInput` from Task 1.
- Produces: `WizardDraftHealthCheck.authType: 'none' | 'raw' | 'basic' | 'bearer'` and `username`/`password`/`token` fields — read by nothing outside this task and `GameWizardDraftService`'s redaction.

- [ ] **Step 1: Write failing tests for the draft→payload auth conversion**

Add to a new file `app/packages/web/src/components/add-game-wizard/wizard-form.utils.test.ts` (or the existing test file for this module if one already exists — check first with `find app/packages/web/src/components/add-game-wizard -name "wizard-form.utils.test.ts"`):

```typescript
import { describe, it, expect } from 'vitest';
import { createEmptyWizardDraft, draftToPayload, validateNetworkingStep } from './wizard-form.utils.js';

describe('health-check auth draft conversion', () => {
  function draftWithHealthCheck(overrides: Record<string, unknown> = {}) {
    const draft = createEmptyWizardDraft();
    return {
      ...draft,
      ports: [{ container: 25565, protocol: 'tcp', visibility: 'public' as const }],
      healthCheck: {
        ...draft.healthCheck,
        enabled: true,
        port: 25565,
        path: '/status',
        jsonPath: 'players.online',
        operator: 'exists',
        authType: 'none',
        username: '',
        password: '',
        token: '',
        ...overrides,
      },
    };
  }

  it('should submit auth: undefined when authType is "none" and no credential was previously set', () => {
    const payload = draftToPayload(draftWithHealthCheck());
    expect(payload.config.healthCheck?.auth).toBeUndefined();
  });

  it('should submit auth: null when authType is "none" and a credential was previously set (explicit clear)', () => {
    const payload = draftToPayload(draftWithHealthCheck({ secretSet: true }));
    expect(payload.config.healthCheck?.auth).toBeNull();
  });

  it('should submit a raw auth write-input when authType is "raw" with a non-blank secretArn', () => {
    const payload = draftToPayload(
      draftWithHealthCheck({ authType: 'raw', secretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:foo-AbCdEf' }),
    );
    expect(payload.config.healthCheck?.auth).toEqual({
      type: 'raw',
      secretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:foo-AbCdEf',
    });
  });

  it('should submit a basic auth write-input when authType is "basic" with username and password', () => {
    const payload = draftToPayload(draftWithHealthCheck({ authType: 'basic', username: 'admin', password: 'hunter2' }));
    expect(payload.config.healthCheck?.auth).toEqual({ type: 'basic', username: 'admin', password: 'hunter2' });
  });

  it('should submit a bearer auth write-input when authType is "bearer" with a token', () => {
    const payload = draftToPayload(draftWithHealthCheck({ authType: 'bearer', token: 'sk-abc123' }));
    expect(payload.config.healthCheck?.auth).toEqual({ type: 'bearer', token: 'sk-abc123' });
  });

  it('should submit auth: undefined when authType is "basic" but both fields are blank (edit, unchanged)', () => {
    const payload = draftToPayload(draftWithHealthCheck({ authType: 'basic', username: '', password: '', secretSet: true }));
    expect(payload.config.healthCheck?.auth).toBeUndefined();
  });

  it('should flag a missing password on the networking step when authType is "basic" with only a username', () => {
    const issues = validateNetworkingStep(draftWithHealthCheck({ authType: 'basic', username: 'admin' }), []);
    expect(issues.some((i) => i.path === 'healthCheck.auth.password')).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to confirm they fail**

Run: `npm run app:test -- wizard-form.utils --run`
Expected: FAIL — `authType`/`username`/`password`/`token` don't exist on `WizardDraftHealthCheck` yet, and `auth` is still always `{ secretArn }` or omitted.

- [ ] **Step 3: Update `WizardDraftHealthCheck` and its conversion functions**

In `app/packages/web/src/components/add-game-wizard/wizard-form.utils.ts`, replace the `WizardDraftHealthCheck` interface (lines 88-112):

```typescript
/**
 * Draft form of the optional `healthCheck` declaration. `enabled` toggles
 * whether the game gets a `healthCheck` at all; every other field is only
 * meaningful when it's `true`. `authType` drives which credential fields are
 * shown/submitted: `'none'` (no credential), `'raw'` (operator-supplied
 * ARN, unchanged from before this field existed), `'basic'`
 * (username+password), `'bearer'` (token). For `'basic'`/`'bearer'`,
 * `username`/`password`/`token` are write-only — always blank on a resumed
 * or edit-mode draft; `secretSet` (from the redacted read-side shape) is
 * the only signal that a credential is already configured, regardless of
 * type. See {@link healthCheckFromDraft}'s doc for exactly how these fields
 * convert into the submitted `auth` write-input (including when a blank
 * `'none'` selection submits `null` vs. `undefined`).
 * `value` stores the declared comparison value as free text; it is parsed
 * to a JSON scalar (number/boolean/null/string) on submit, and is unused
 * (and not submitted) when `operator` is `"exists"`.
 */
export interface WizardDraftHealthCheck {
  enabled: boolean;
  scheme: string;
  port: number | null;
  path: string;
  method: string;
  timeoutMs: number | null;
  jsonPath: string;
  operator: string;
  value: string;
  authType: 'none' | 'raw' | 'basic' | 'bearer';
  secretArn: string;
  username: string;
  password: string;
  token: string;
  secretSet: boolean;
}
```

Replace `emptyHealthCheckDraft` (lines 115-129):

```typescript
function emptyHealthCheckDraft(): WizardDraftHealthCheck {
  return {
    enabled: false,
    scheme: 'http',
    port: null,
    path: '',
    method: 'GET',
    timeoutMs: 2000,
    jsonPath: '',
    operator: 'equals',
    value: '',
    authType: 'none',
    secretArn: '',
    username: '',
    password: '',
    token: '',
    secretSet: false,
  };
}
```

Replace the `healthCheck` branch of `draftFromGameServer` (lines 203-217):

```typescript
    healthCheck: game.healthCheck
      ? {
          enabled: true,
          scheme: game.healthCheck.scheme,
          port: game.healthCheck.port,
          path: game.healthCheck.path,
          method: game.healthCheck.method,
          timeoutMs: game.healthCheck.timeoutMs,
          jsonPath: game.healthCheck.activeWhen.jsonPath,
          operator: game.healthCheck.activeWhen.operator,
          value: game.healthCheck.activeWhen.value === undefined ? '' : String(game.healthCheck.activeWhen.value),
          authType: game.healthCheck.secretSet ? 'raw' : 'none',
          secretArn: '',
          username: '',
          password: '',
          token: '',
          secretSet: game.healthCheck.secretSet,
        }
      : emptyHealthCheckDraft(),
```

(`authType` on hydration defaults to `'raw'` when a credential is set — `RedactedGameServerHealthCheck` never reveals the underlying `type`, only `secretSet`, so the operator re-selects `Basic`/`Bearer` explicitly if that's what's actually configured; re-entering plaintext is required either way per the blank-on-edit contract, so this default costs nothing beyond one extra click if they guess wrong.)

Replace `healthCheckFromDraft` (lines 230-263):

```typescript
/**
 * Converts a {@link WizardDraftHealthCheck} into the `healthCheck` field of
 * a proposed/submitted entry, or `undefined` when the operator hasn't
 * enabled one.
 *
 * `auth` follows the write-side convention `gamesWrite.ts` (`@hyveon/shared`)
 * declares: `undefined` leaves an existing credential unchanged (the
 * operator left every credential field blank on an edit), `null` explicitly
 * clears an existing credential (the operator selected `authType: 'none'`
 * on a draft that had `secretSet: true`), and a populated write-input object
 * sets/replaces it. `raw` submits `{ type: 'raw', secretArn }` only when
 * `secretArn` is non-blank; `basic` submits `{ type: 'basic', username,
 * password }` only when at least one of the two is non-blank (so a
 * half-filled edit still surfaces {@link validateHealthCheckAuthInput}'s
 * "both required" issue rather than silently no-op'ing); `bearer` submits
 * `{ type: 'bearer', token }` only when `token` is non-blank.
 */
function healthCheckFromDraft(draft: WizardDraftHealthCheck): GameServerHealthCheckWriteInput | undefined {
  if (!draft.enabled) {
    return undefined;
  }

  const activeWhen: GameServerHealthCheckCondition =
    draft.operator === 'exists'
      ? { jsonPath: draft.jsonPath, operator: 'exists' }
      : {
          jsonPath: draft.jsonPath,
          operator: draft.operator as GameServerHealthCheckCondition['operator'],
          value: parseHealthCheckValue(draft.value),
        };

  const base = {
    kind: 'http' as const,
    scheme: draft.scheme as GameServerHealthCheck['scheme'],
    port: draft.port ?? 0,
    path: draft.path,
    method: draft.method as GameServerHealthCheck['method'],
    timeoutMs: draft.timeoutMs ?? 0,
    activeWhen,
  };

  const auth = healthCheckAuthInputFromDraft(draft);
  return auth === undefined ? base : { ...base, auth };
}

/** Builds the `auth` write-input `healthCheckFromDraft` submits — see that function's doc for the `undefined`/`null`/object convention. */
function healthCheckAuthInputFromDraft(draft: WizardDraftHealthCheck): GameServerHealthCheckAuthWriteInput | null | undefined {
  switch (draft.authType) {
    case 'none':
      return draft.secretSet ? null : undefined;
    case 'raw':
      return draft.secretArn.trim().length > 0 ? { type: 'raw', secretArn: draft.secretArn.trim() } : undefined;
    case 'basic':
      return draft.username.trim().length > 0 || draft.password.trim().length > 0
        ? { type: 'basic', username: draft.username.trim(), password: draft.password.trim() }
        : undefined;
    case 'bearer':
      return draft.token.trim().length > 0 ? { type: 'bearer', token: draft.token.trim() } : undefined;
  }
}
```

Add the new imports at the top of the file (alongside the existing `import type { CreateGamePayload, ... }` block, ~line 23):

```typescript
import type {
  CreateGamePayload,
  GameServer,
  GameServerHealthCheck,
  GameServerHealthCheckCondition,
  GameServerHealthCheckAuthWriteInput,
  GameServerHealthCheckWriteInput,
  RedactedGameServer,
} from '../../api.service.js';
import { validateHealthCheckAuthInput } from '@hyveon/shared/gameServerValidator';
```

(`api.service.js` already re-exports `@hyveon/shared` types for `@hyveon/web` — confirm `GameServerHealthCheckAuthWriteInput`/`GameServerHealthCheckWriteInput` are re-exported there the same way `CreateGamePayload` is; if `api.service.ts` hand-picks its re-export list rather than doing `export *`, add both to that list as part of this step.)

Update `toProposedEntry` (lines 383-409) so the client-side structural preview never trips the persisted schema's `secretArn`-required rule for `basic`/`bearer` (which don't have a real ARN yet client-side) — replace the `healthCheck: healthCheckFromDraft(draft.healthCheck),` line with:

```typescript
    healthCheck: toStructuralHealthCheckPreview(draft.healthCheck),
```

and add the helper near `healthCheckFromDraft`:

```typescript
/**
 * Builds the `healthCheck` object passed to `validateGameServer` for the
 * wizard's own client-side gating (`toProposedEntry`) — NOT the submitted
 * payload (`draftToPayload` uses {@link healthCheckFromDraft} directly).
 * `validateGameServer`'s persisted-shape schema always requires `secretArn`
 * on a declared `auth`; for `basic`/`bearer` that ARN doesn't exist yet
 * client-side (the app only creates it on submit), so `auth` is stripped
 * from this preview object for those two types. The per-type plaintext
 * requirement itself is still enforced — via
 * {@link validateHealthCheckAuthInput}, called separately by
 * {@link validateWizardDraft} — so nothing is silently skipped, only the
 * ARN-shape check that can't apply yet.
 */
function toStructuralHealthCheckPreview(draft: WizardDraftHealthCheck): GameServerHealthCheck | undefined {
  const withAuth = healthCheckFromDraft(draft);
  if (!withAuth) {
    return undefined;
  }
  if (!withAuth.auth || withAuth.auth.type === 'raw' || withAuth.auth.type === undefined) {
    return withAuth as GameServerHealthCheck;
  }
  const { auth: _auth, ...rest } = withAuth;
  return rest as GameServerHealthCheck;
}
```

Finally, update `validateWizardDraft` (lines 444-464) to also run `validateHealthCheckAuthInput`:

```typescript
export function validateWizardDraft(
  draft: WizardDraft,
  existingGames: GameServer[],
  mode: WizardMode = 'create',
): GameServerValidationIssue[] {
  const issues = [...checkName(draft.name, existingGames, mode), ...checkImage(draft.image)];

  if (draft.healthCheck.enabled) {
    issues.push(...validateHealthCheckAuthInput(healthCheckAuthInputFromDraft(draft.healthCheck) ?? undefined));
  }

  const name = draft.name.trim().length > 0 ? draft.name.trim() : DRAFT_NAME_PLACEHOLDER;
  const result = validateGameServer(name, toProposedEntry(draft), existingGames);
  if (!result.success) {
    issues.push(...result.issues);
    issues.push(...checkConnectMessagePlaceholders(draft.connect_message));
  }

  return dedupeIssues(issues);
}
```

- [ ] **Step 4: Run the tests to confirm they pass**

Run: `npm run app:test -- wizard-form.utils --run`
Expected: PASS.

- [ ] **Step 5: Write failing component tests for the new auth-type selector**

Create `app/packages/web/src/components/add-game-wizard/networking-step.component.test.tsx`, following this repo's jsdom/`renderPage()`-adjacent component-test convention (a plain React Testing Library render is fine for a leaf component like this one — check `docs/docs/components/integration-tests.md` for whether this directory's existing component tests use `render()` directly or a shared harness before writing):

```typescript
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { NetworkingStep } from './networking-step.component.js';
import type { WizardDraftHealthCheck } from './wizard-form.utils.js';

function baseHealthCheck(overrides: Partial<WizardDraftHealthCheck> = {}): WizardDraftHealthCheck {
  return {
    enabled: true,
    scheme: 'http',
    port: 25565,
    path: '/status',
    method: 'GET',
    timeoutMs: 2000,
    jsonPath: 'players.online',
    operator: 'exists',
    value: '',
    authType: 'none',
    secretArn: '',
    username: '',
    password: '',
    token: '',
    secretSet: false,
    ...overrides,
  };
}

const noop = () => undefined;

describe('NetworkingStep health-check auth type selector', () => {
  it('should render no credential fields when authType is "none"', () => {
    render(
      <NetworkingStep
        ports={[{ container: 25565, protocol: 'tcp', visibility: 'public' }]}
        issues={[]}
        onChange={noop}
        https={false}
        onHttpsChange={noop}
        healthCheck={baseHealthCheck()}
        onHealthCheckChange={noop}
      />,
    );
    expect(screen.queryByLabelText(/username/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/password/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/token/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/secrets manager arn/i)).not.toBeInTheDocument();
  });

  it('should render only the ARN field when authType is "raw"', () => {
    render(
      <NetworkingStep
        ports={[{ container: 25565, protocol: 'tcp', visibility: 'public' }]}
        issues={[]}
        onChange={noop}
        https={false}
        onHttpsChange={noop}
        healthCheck={baseHealthCheck({ authType: 'raw' })}
        onHealthCheckChange={noop}
      />,
    );
    expect(screen.getByLabelText(/secrets manager arn/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/^username$/i)).not.toBeInTheDocument();
  });

  it('should render username and password fields when authType is "basic"', () => {
    render(
      <NetworkingStep
        ports={[{ container: 25565, protocol: 'tcp', visibility: 'public' }]}
        issues={[]}
        onChange={noop}
        https={false}
        onHttpsChange={noop}
        healthCheck={baseHealthCheck({ authType: 'basic' })}
        onHealthCheckChange={noop}
      />,
    );
    expect(screen.getByLabelText(/^username$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^password$/i)).toBeInTheDocument();
  });

  it('should render a token field when authType is "bearer"', () => {
    render(
      <NetworkingStep
        ports={[{ container: 25565, protocol: 'tcp', visibility: 'public' }]}
        issues={[]}
        onChange={noop}
        https={false}
        onHttpsChange={noop}
        healthCheck={baseHealthCheck({ authType: 'bearer' })}
        onHealthCheckChange={noop}
      />,
    );
    expect(screen.getByLabelText(/^token$/i)).toBeInTheDocument();
  });

  it('should call onHealthCheckChange with the new authType when the selector changes', () => {
    const onHealthCheckChange = vi.fn();
    render(
      <NetworkingStep
        ports={[{ container: 25565, protocol: 'tcp', visibility: 'public' }]}
        issues={[]}
        onChange={noop}
        https={false}
        onHttpsChange={noop}
        healthCheck={baseHealthCheck()}
        onHealthCheckChange={onHealthCheckChange}
      />,
    );
    fireEvent.change(screen.getByLabelText(/credential type/i), { target: { value: 'basic' } });
    expect(onHealthCheckChange).toHaveBeenCalledWith({ authType: 'basic' });
  });

  it('should show "a credential is already set" when secretSet is true, regardless of authType', () => {
    render(
      <NetworkingStep
        ports={[{ container: 25565, protocol: 'tcp', visibility: 'public' }]}
        issues={[]}
        onChange={noop}
        https={false}
        onHttpsChange={noop}
        healthCheck={baseHealthCheck({ authType: 'basic', secretSet: true })}
        onHealthCheckChange={noop}
      />,
    );
    expect(screen.getByText(/a credential is already set/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 6: Run the tests to confirm they fail**

Run: `npm run app:test -- networking-step.component --run`
Expected: FAIL — the component still renders the single always-visible ARN field with no type selector.

- [ ] **Step 7: Implement the auth-type selector and per-type fields**

In `app/packages/web/src/components/add-game-wizard/networking-step.component.tsx`, add a new options constant near the other `HEALTH_CHECK_*` constants (~line 48):

```typescript
/** `healthCheck.authType` options. */
const HEALTH_CHECK_AUTH_TYPE_OPTIONS: { value: WizardDraftHealthCheck['authType']; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'raw', label: 'Raw ARN' },
  { value: 'basic', label: 'Basic' },
  { value: 'bearer', label: 'Bearer' },
];
```

Replace the credential block (lines 407-424, the `<Label htmlFor="health-check-secret">...` div) with:

```typescript
            <div className="space-y-3 border-t border-[var(--color-border)] pt-3">
              <div className="w-40">
                <Label htmlFor="health-check-auth-type">Credential type</Label>
                <select
                  id="health-check-auth-type"
                  value={healthCheck.authType}
                  onChange={(event) =>
                    onHealthCheckChange({ authType: event.target.value as WizardDraftHealthCheck['authType'] })
                  }
                  className="flex h-9 w-full rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1 text-sm text-[var(--color-foreground)]"
                >
                  {HEALTH_CHECK_AUTH_TYPE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>

              {healthCheck.secretSet && (
                <p className="text-xs text-[var(--color-muted-foreground)]">A credential is already set.</p>
              )}

              {healthCheck.authType === 'raw' && (
                <div>
                  <Label htmlFor="health-check-secret-arn">Secrets Manager ARN</Label>
                  <Input
                    id="health-check-secret-arn"
                    value={healthCheck.secretArn}
                    aria-invalid={Boolean(messageFor(issues, 'healthCheck.auth.secretArn'))}
                    placeholder={
                      healthCheck.secretSet ? 'Leave blank to keep the existing credential' : 'arn:aws:secretsmanager:...'
                    }
                    onChange={(event) => onHealthCheckChange({ secretArn: event.target.value })}
                  />
                  <p className="text-xs text-[var(--color-muted-foreground)]">
                    You manage this secret's lifecycle yourself — the app only reads its value.
                  </p>
                </div>
              )}

              {healthCheck.authType === 'basic' && (
                <div className="flex flex-wrap gap-3">
                  <div className="flex-1">
                    <Label htmlFor="health-check-username">Username</Label>
                    <Input
                      id="health-check-username"
                      value={healthCheck.username}
                      aria-invalid={Boolean(messageFor(issues, 'healthCheck.auth.username'))}
                      placeholder={healthCheck.secretSet ? 'Re-enter to change' : ''}
                      onChange={(event) => onHealthCheckChange({ username: event.target.value })}
                    />
                  </div>
                  <div className="flex-1">
                    <Label htmlFor="health-check-password">Password</Label>
                    <Input
                      id="health-check-password"
                      type="password"
                      value={healthCheck.password}
                      aria-invalid={Boolean(messageFor(issues, 'healthCheck.auth.password'))}
                      placeholder={healthCheck.secretSet ? 'Re-enter to change' : ''}
                      onChange={(event) => onHealthCheckChange({ password: event.target.value })}
                    />
                  </div>
                  <p className="w-full text-xs text-[var(--color-muted-foreground)]">
                    The app stores this as a Secrets Manager secret it creates and manages for you.
                  </p>
                </div>
              )}

              {healthCheck.authType === 'bearer' && (
                <div>
                  <Label htmlFor="health-check-token">Token</Label>
                  <Input
                    id="health-check-token"
                    value={healthCheck.token}
                    aria-invalid={Boolean(messageFor(issues, 'healthCheck.auth.token'))}
                    placeholder={healthCheck.secretSet ? 'Re-enter to change' : ''}
                    onChange={(event) => onHealthCheckChange({ token: event.target.value })}
                  />
                  <p className="text-xs text-[var(--color-muted-foreground)]">
                    The app stores this as a Secrets Manager secret it creates and manages for you.
                  </p>
                </div>
              )}

              <p className="text-xs text-[var(--color-muted-foreground)]">
                Injected as the request&apos;s <code>Authorization</code> header. The credential value itself never
                appears here — only whether one is configured.
              </p>
            </div>
```

- [ ] **Step 8: Run the tests to confirm they pass**

Run: `npm run app:test -- networking-step.component wizard-form.utils --run`
Expected: PASS.

- [ ] **Step 9: Extend `GameWizardDraftService`'s narrowing and redaction for the new fields**

In `app/packages/desktop-main/src/services/GameWizardDraftService.ts`, replace `isWizardDraftHealthCheck` (lines 153-169):

```typescript
function isWizardDraftHealthCheck(value: unknown): value is NonNullable<GameWizardDraft['healthCheck']> {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<NonNullable<GameWizardDraft['healthCheck']>>;
  return (
    typeof candidate.enabled === 'boolean' &&
    typeof candidate.scheme === 'string' &&
    (candidate.port === null || (typeof candidate.port === 'number' && Number.isFinite(candidate.port))) &&
    typeof candidate.path === 'string' &&
    typeof candidate.method === 'string' &&
    (candidate.timeoutMs === null || (typeof candidate.timeoutMs === 'number' && Number.isFinite(candidate.timeoutMs))) &&
    typeof candidate.jsonPath === 'string' &&
    typeof candidate.operator === 'string' &&
    typeof candidate.value === 'string' &&
    // `authType`/`username`/`password`/`token` were added after this draft
    // slot shipped its first cut of healthCheck — a draft autosaved before
    // then has `secretArn`/`secretSet` but none of these, and that must
    // still be treated as valid rather than discarding the whole draft.
    (candidate.authType === undefined ||
      candidate.authType === 'none' ||
      candidate.authType === 'raw' ||
      candidate.authType === 'basic' ||
      candidate.authType === 'bearer') &&
    typeof candidate.secretArn === 'string' &&
    (candidate.username === undefined || typeof candidate.username === 'string') &&
    (candidate.password === undefined || typeof candidate.password === 'string') &&
    (candidate.token === undefined || typeof candidate.token === 'string') &&
    typeof candidate.secretSet === 'boolean'
  );
}
```

Update `DEFAULT_HEALTH_CHECK_DRAFT` (lines 230-242):

```typescript
const DEFAULT_HEALTH_CHECK_DRAFT: NonNullable<GameWizardDraft['healthCheck']> = {
  enabled: false,
  scheme: 'http',
  port: null,
  path: '',
  method: 'GET',
  timeoutMs: 2000,
  jsonPath: '',
  operator: 'equals',
  value: '',
  authType: 'none',
  secretArn: '',
  username: '',
  password: '',
  token: '',
  secretSet: false,
};
```

Update `redactSecretFields` (lines 270-280) to also blank `username`/`password`/`token`:

```typescript
function redactSecretFields(stored: StoredGameWizardDraft): StoredGameWizardDraft {
  return {
    ...stored,
    draft: {
      ...stored.draft,
      file_seeds: stored.draft.file_seeds.map((seed) => ({ ...seed, content: '', content_base64: '' })),
      environment: stored.draft.environment.map((variable) => ({ ...variable, value: '' })),
      healthCheck: {
        ...(stored.draft.healthCheck ?? DEFAULT_HEALTH_CHECK_DRAFT),
        secretArn: '',
        username: '',
        password: '',
        token: '',
      },
    },
  };
}
```

Also add a backfill for a pre-`authType` draft in `backfillHealthCheck` (lines 245-248) — replace with:

```typescript
/**
 * Fills in a missing `healthCheck` on a draft autosaved before that field
 * existed, with {@link DEFAULT_HEALTH_CHECK_DRAFT}. Also backfills
 * `authType`/`username`/`password`/`token` on a draft that has a
 * `healthCheck` from before those fields existed (only `secretArn`/`secretSet`
 * present): `authType` becomes `'raw'` when `secretSet` is true (an
 * already-configured credential, necessarily `raw` — `basic`/`bearer` did
 * not exist yet when such a draft was autosaved) or `'none'` otherwise.
 */
function backfillHealthCheck(stored: StoredGameWizardDraft): StoredGameWizardDraft {
  if (!stored.draft.healthCheck) {
    return { ...stored, draft: { ...stored.draft, healthCheck: DEFAULT_HEALTH_CHECK_DRAFT } };
  }
  const hc = stored.draft.healthCheck;
  if (hc.authType !== undefined) {
    return stored;
  }
  return {
    ...stored,
    draft: {
      ...stored.draft,
      healthCheck: { ...hc, authType: hc.secretSet ? 'raw' : 'none', username: '', password: '', token: '' },
    },
  };
}
```

- [ ] **Step 10: Mirror the new fields in the preload's `GameWizardDraft` type**

In `app/packages/desktop-preload/src/hyveon-api.ts`, replace the `healthCheck` block of the `GameWizardDraft` interface (~lines 68-79, found via `grep -n "healthCheck: {" app/packages/desktop-preload/src/hyveon-api.ts`):

```typescript
  healthCheck: {
    enabled: boolean;
    scheme: string;
    port: number | null;
    path: string;
    method: string;
    timeoutMs: number | null;
    jsonPath: string;
    operator: string;
    value: string;
    authType: 'none' | 'raw' | 'basic' | 'bearer';
    secretArn: string;
    username: string;
    password: string;
    token: string;
    secretSet: boolean;
  };
```

- [ ] **Step 11: Run the full web + desktop-main + desktop-preload unit suites and typecheck**

Run: `npm run app:typecheck && npm run app:test -- --run`
Expected: PASS.

- [ ] **Step 12: Commit**

```bash
git add app/packages/web/src/components/add-game-wizard/wizard-form.utils.ts app/packages/web/src/components/add-game-wizard/wizard-form.utils.test.ts app/packages/web/src/components/add-game-wizard/networking-step.component.tsx app/packages/web/src/components/add-game-wizard/networking-step.component.test.tsx app/packages/desktop-main/src/services/GameWizardDraftService.ts app/packages/desktop-preload/src/hyveon-api.ts
git commit -m "feat(web): add basic/bearer credential fields to the add-game wizard"
```

---

## Task 5: IAM permission verification

**Files:**
- Test: `app/packages/desktop-main/src/services/IamCheckService.test.ts`

**Interfaces:**
- Consumes: `HYVEON_DEPLOY_ALL_ACTIONS` (`@hyveon/shared`, unchanged — already includes `secretsmanager:*`).
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Write the regression test**

Add to `app/packages/desktop-main/src/services/IamCheckService.test.ts`, in a new top-level `describe` block:

```typescript
import { HYVEON_DEPLOY_ALL_ACTIONS } from '@hyveon/shared';

describe('health-check credential lifecycle IAM coverage', () => {
  it('should already cover secretsmanager:CreateSecret/PutSecretValue/DeleteSecret via the secretsmanager:* wildcard', () => {
    // The app-owned health-check credential lifecycle (GamesWriteService,
    // via secretsStore.ts's upsertHealthCheckAuthSecret/deleteHealthCheckAuthSecret)
    // calls CreateSecret, PutSecretValue, and DeleteSecret. This asserts the
    // deploy policy's action set already grants coverage for all three, so a
    // future narrowing of the `secretsmanager:*` wildcard in `iamPolicy.ts`
    // fails this test instead of silently breaking the feature for
    // already-deployed accounts (see design.md's D6).
    expect(HYVEON_DEPLOY_ALL_ACTIONS).toContain('secretsmanager:*');

    // Simulate the actual per-action grant the way IamCheckService itself
    // would evaluate it: a `secretsmanager:*` entry in the granted action
    // set covers any `secretsmanager:<Verb>` action.
    const wildcardGranted = HYVEON_DEPLOY_ALL_ACTIONS.some((action) => action === 'secretsmanager:*');
    for (const action of ['secretsmanager:CreateSecret', 'secretsmanager:PutSecretValue', 'secretsmanager:DeleteSecret']) {
      const explicitlyGranted = HYVEON_DEPLOY_ALL_ACTIONS.includes(action);
      expect(wildcardGranted || explicitlyGranted).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run the test to confirm it currently passes (this is a pure regression guard, not new behavior)**

Run: `npm run app:test -- IamCheckService --run`
Expected: PASS immediately — `HYVEON_DEPLOY_ALL_ACTIONS` already contains `secretsmanager:*` (`iamPolicy.ts:20`), so this test needs no production code change. Confirm it fails if you temporarily comment out `'secretsmanager:*'` from `HYVEON_DEPLOY_ALL_ACTIONS` locally (do not commit that change) — this proves the guard actually guards something before moving on.

- [ ] **Step 3: Confirm no `docs/docs/setup.md` change is needed**

Run: `grep -n "secretsmanager" docs/docs/setup.md`

Confirm `secretsmanager:*` is already present in the documented `HyveonDeploy` statement (it mirrors `iamPolicy.ts`'s `HYVEON_DEPLOY_ALL_STATEMENTS`, which Step 1 confirmed already covers this). Note this explicitly in the PR description — no doc edit required for the IAM policy itself (Task 6 still documents the new feature's *behavior*, just not a policy change).

- [ ] **Step 4: Commit**

```bash
git add app/packages/desktop-main/src/services/IamCheckService.test.ts
git commit -m "test(desktop-main): assert secretsmanager:* already covers the health-check credential lifecycle"
```

---

## Task 6: Documentation

**Files:**
- Modify: `docs/docs/components/lambdas.md` and/or `docs/docs/app/games.md` (whichever page documents the health-check `auth` field today — confirm which one via the `write-docs` skill's diff-to-page mapping, don't guess)
- Modify: `docs/docs/components/integration-tests.md` if the new wizard component test changes that page's documented conventions (unlikely, but check)

- [ ] **Step 1: Draft the documentation update**

Invoke the `write-docs` skill (`.claude/skills/write-docs/`) with the full diff from Tasks 1-5 (shared types, engine, secret lifecycle, wizard UI) as context. Let it map the change to the pages that own health-check credential documentation and draft through the `docs-writer` subagent — do not hand-write doc prose here; this plan only enumerates that the step must happen and what it must cover:
  - `GameServerHealthCheckAuth.type` (`'raw' | 'basic' | 'bearer'`, default `'raw'`) and what each type means for header construction.
  - The app-owned secret model for `basic`/`bearer` (deterministic naming, create-on-first-save, update-in-place, delete-on-clear/game-delete) versus the unchanged operator-owned model for `raw`.
  - The wizard's new credential-type selector and per-type fields.
  - That no IAM policy change was needed (cross-reference Task 5's regression test).

- [ ] **Step 2: Run the three docs evaluator agents**

Dispatch `docs-accuracy-auditor`, `docs-coverage-auditor`, and `docs-style-reviewer` (per this repo's CLAUDE.md "Before opening a PR" documentation requirement) over the pages `write-docs` touched. Address every finding before proceeding — an evaluator flagging a real inaccuracy or gap blocks the PR; a style nit is fixed inline.

- [ ] **Step 3: Commit**

```bash
git add docs/docs/
git commit -m "docs: document basic/bearer health-check credential types"
```

---

## Task 7: Pre-PR verification

Run each of the following from the repo root, in order, and confirm a clean/passing result before opening the PR — per this repo's CLAUDE.md "Before opening a PR" checklist. Do not proceed to the next command until the current one passes; do not claim the branch is ready without having seen every command's actual exit code.

- [ ] **Step 1:** `npm run app:lint` — expect a clean exit with no errors.
- [ ] **Step 2:** `npm run app:typecheck` — expect a clean exit with no type errors, including `@hyveon/infra`.
- [ ] **Step 3:** `npm run app:test` — expect the full unit suite green, including every new test from Tasks 1-5.
- [ ] **Step 4:** `npm run app:test:integration` — required because `GamesController`/`GamesWriteService` (IPC/controller layer) changed in Task 3.
- [ ] **Step 5:** `npm run app:test:e2e` — required because the wizard renderer (`networking-step.component.tsx`) and the preload bridge (`hyveon-api.ts`) changed in Task 4.
- [ ] **Step 6:** Run the `opsx:verify` skill to confirm the implementation matches this change's delta spec (`specs/game-health-checks/spec.md`) and `tasks.md` before archiving the change.
