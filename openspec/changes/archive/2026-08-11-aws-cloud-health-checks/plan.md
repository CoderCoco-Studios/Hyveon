# AWS Cloud Health Checks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an always-visible "Cloud Health" checklist to the Settings page, shipping with one check (does the `AWSServiceRoleForECS` service-linked role exist) and a Fix action that creates it or falls back to policy-update instructions.

**Architecture:** A new `CloudHealthService` (desktop-main, registered in `WizardModule`) exposes `getChecks(): CloudHealthCheck[]` — currently one entry backed by `checkEcsServiceLinkedRole()`/`fixEcsServiceLinkedRole()`. A new `CloudHealthController` (registered in `AppModule`) exposes `cloudHealth.list`/`cloudHealth.fix` over IPC, following the exact `GamesController`/`EcsService` pattern already in the codebase. The web layer adds a `CloudHealthSection` component (styled like `bootstrap-step.component.tsx`'s resource rows) mounted on `settings.page.tsx`. `iamPolicy.ts` gains one new statement plus a new optional `Condition` field on its statement type (which doesn't exist yet).

**Tech Stack:** NestJS (desktop-main), `@aws-sdk/client-iam`, React + Vitest/jsdom (web), `aws-sdk-client-mock` for AWS mocking.

## Global Constraints

- Every `@MessagePattern` handler starts with `logger.debug('<Controller>: <pattern> invoked')` (pattern name only, never payload contents) — `.claude/rules/logging.md`.
- Every service method that can fail catches, logs via `logger.warn` (expected/recoverable) or `logger.error` (unexpected), and returns a modeled result — never lets a raw SDK error escape uncaught — `.claude/rules/logging.md`.
- TSDoc comments must use only TSDoc-spec tags, `@param name - description` (hyphen form) — `.claude/rules/tsdoc-tags.md`.
- Test names read as sentences starting with "should" (CLAUDE.md).
- No raw `process.env` in business logic (CLAUDE.md) — not applicable here, no new env access.
- Run `npm run app:lint`, `npm run app:typecheck`, `npm run app:test` before considering any task done; `npm run app:test:integration`/`:e2e` are not required (no controller/service/IPC-surface change outside the new, additive `cloudHealth` namespace, and no renderer/preload bridge *shape* change beyond an addition).

---

### Task 1: `iamPolicy.ts` — new IAM statement with Condition support

**Files:**
- Modify: `app/packages/shared/src/iamPolicy.ts:9-36` (add action), `:38-57` (extend statement type), `:74-140` (add statement), `:142-179` (render `Condition`)
- Modify: `docs/docs/setup.md` (append matching statement to the `HyveonDeployAll` policy JSON block, in the same last position)
- Test: `app/packages/shared/src/iamPolicy.test.ts`

**Interfaces:**
- Produces: `HYVEON_DEPLOY_ALL_STATEMENTS` gains a `HyveonServiceLinkedRoles` entry; `generateHyveonDeployAllPolicy()` output includes a `Condition` field on any statement that declares one. Task 2 imports `generateHyveonDeployAllPolicy` from `@hyveon/shared` to build the `needsPolicyUpdate` fallback JSON.

- [x] **Step 1: Read the exact current bodies of the three untouched test helpers before editing them**

Read `app/packages/shared/src/iamPolicy.test.ts` lines 40-91 in full (`extractDocActions`, `normalizeActions`, `normalizeResource`, `extractDocStatements`) — the plan needs their exact current bodies to extend correctly, and they weren't fully captured during research.

- [x] **Step 2: Add the new action and statement to `iamPolicy.ts`**

In `HYVEON_DEPLOY_ALL_ACTIONS` (lines 9-36), add `'iam:CreateServiceLinkedRole'` to the array.

Extend the statement interface (lines 38-57) with an optional `Condition`:

```ts
interface HyveonDeployAllStatement {
  readonly Sid: string;
  readonly Effect: 'Allow';
  readonly Action: string | readonly string[];
  readonly Resource: string | readonly string[] | ((projectName: string) => readonly string[]);
  /** IAM condition block, e.g. restricting `iam:CreateServiceLinkedRole` to one AWS service. */
  readonly Condition?: Readonly<Record<string, Readonly<Record<string, string>>>>;
}
```

Append a new entry to `HYVEON_DEPLOY_ALL_STATEMENTS` (after `HyveonStateBucket`):

```ts
  {
    Sid: 'HyveonServiceLinkedRoles',
    Effect: 'Allow',
    Action: 'iam:CreateServiceLinkedRole',
    Resource: 'arn:aws:iam::*:role/aws-service-role/ecs.amazonaws.com/AWSServiceRoleForECS*',
    Condition: {
      StringEquals: { 'iam:AWSServiceName': 'ecs.amazonaws.com' },
    },
  },
```

Extend `RenderedPolicyStatement` (lines 142-158) the same way (add the same optional `Condition` field), and update `generateHyveonDeployAllPolicy`'s mapper (lines 160-179) to carry it through:

```ts
    Statement: HYVEON_DEPLOY_ALL_STATEMENTS.map((statement) => ({
      Sid: statement.Sid,
      Effect: statement.Effect,
      Action: statement.Action,
      Resource: typeof statement.Resource === 'function' ? statement.Resource(projectName) : statement.Resource,
      ...(statement.Condition ? { Condition: statement.Condition } : {}),
    })),
```

- [x] **Step 3: Update `docs/docs/setup.md`**

Open `docs/docs/setup.md`, find the `HyveonDeployAll` policy JSON code block (the one `iamPolicy.test.ts` parses via the first ` ```json ` fence), and append a matching statement as the **last** entry (position must match `HYVEON_DEPLOY_ALL_STATEMENTS`'s order, since the test compares statement-by-index):

```json
    {
      "Sid": "HyveonServiceLinkedRoles",
      "Effect": "Allow",
      "Action": "iam:CreateServiceLinkedRole",
      "Resource": "arn:aws:iam::*:role/aws-service-role/ecs.amazonaws.com/AWSServiceRoleForECS*",
      "Condition": {
        "StringEquals": { "iam:AWSServiceName": "ecs.amazonaws.com" }
      }
    }
```

- [x] **Step 4: Extend `iamPolicy.test.ts` to assert `Condition` matches too**

Based on the bodies read in Step 1, extend `extractDocStatements()`'s return type and mapping to also capture each statement's `Condition` field (pass it through unchanged — it's already a plain object in the parsed JSON), and extend the third test ("should match ... statement-for-statement, including Effect and Resource") to also assert:

```ts
      expect(statement.Condition).toEqual(docStatement.Condition);
```

adding `Condition?: Record<string, Record<string, string>>` to both the generated-statement projection and the doc-parser's returned type shape used by that test.

- [x] **Step 5: Run the test suite for this file**

Run: `npm run app:test -- iamPolicy.test.ts`
Expected: PASS — all four `describe` blocks green, including the new `Condition` assertion.

- [x] **Step 6: Commit**

```bash
git add app/packages/shared/src/iamPolicy.ts app/packages/shared/src/iamPolicy.test.ts docs/docs/setup.md
git commit -m "feat(shared): add HyveonServiceLinkedRoles IAM statement for ECS SLR"
```

---

### Task 2: `CloudHealthService`

**Files:**
- Create: `app/packages/desktop-main/src/services/CloudHealthService.ts`
- Test: `app/packages/desktop-main/src/services/CloudHealthService.test.ts`

**Interfaces:**
- Consumes: `ElectronStoreService` (constructor param, for `resolveAwsClientCredentialsWithSignature`), `ConfigService.getRegion(): string` (constructor param), `generateHyveonDeployAllPolicy` from `@hyveon/shared`.
- Produces: `CloudHealthCheckStatus = 'ok' | 'missing' | 'error'`, `CloudHealthCheckResult = { status: CloudHealthCheckStatus; message?: string }`, `CloudHealthFixOutcome = 'fixed' | 'needsPolicyUpdate' | 'failed'`, `CloudHealthFixResult = { outcome: CloudHealthFixOutcome; policyJson?: string; message?: string }`, `CloudHealthCheck = { id: string; label: string; check(): Promise<CloudHealthCheckResult>; fix(): Promise<CloudHealthFixResult> }`, `class CloudHealthService { getChecks(): CloudHealthCheck[] }`. Task 3's `CloudHealthController` consumes `CloudHealthService.getChecks()`.

- [x] **Step 1: Write the failing test file**

Create `app/packages/desktop-main/src/services/CloudHealthService.test.ts`:

```ts
import 'reflect-metadata';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { IAMClient, GetRoleCommand, CreateServiceLinkedRoleCommand } from '@aws-sdk/client-iam';

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { CloudHealthService } from './CloudHealthService.js';
import type { ElectronStoreService } from './ElectronStoreService.js';
import type { ConfigService } from './ConfigService.js';

const iamMock = mockClient(IAMClient);

function makeStore(): ElectronStoreService {
  return {
    get: vi.fn().mockImplementation((key: string) => (key === 'aws' ? { profile: 'default', region: 'us-east-1' } : undefined)),
    getPastedCredentials: vi.fn().mockReturnValue(undefined),
  } as Partial<ElectronStoreService> as ElectronStoreService;
}

function makeConfig(): ConfigService {
  return { getRegion: vi.fn().mockReturnValue('us-east-1') } as Partial<ConfigService> as ConfigService;
}

beforeEach(() => {
  iamMock.reset();
});

describe('CloudHealthService.getChecks', () => {
  it('should include exactly one check with id "ecs-service-linked-role"', () => {
    const service = new CloudHealthService(makeStore(), makeConfig());

    const checks = service.getChecks();

    expect(checks).toHaveLength(1);
    expect(checks[0]!.id).toBe('ecs-service-linked-role');
  });
});

describe('ECS service-linked role check', () => {
  it('should report ok when the role exists', async () => {
    iamMock.on(GetRoleCommand).resolves({ Role: { RoleName: 'AWSServiceRoleForECS' } as never });
    const service = new CloudHealthService(makeStore(), makeConfig());

    const result = await service.getChecks()[0]!.check();

    expect(result).toEqual({ status: 'ok' });
  });

  it('should report missing when the role does not exist', async () => {
    const err = Object.assign(new Error('not found'), { name: 'NoSuchEntityException' });
    iamMock.on(GetRoleCommand).rejects(err);
    const service = new CloudHealthService(makeStore(), makeConfig());

    const result = await service.getChecks()[0]!.check();

    expect(result.status).toBe('missing');
  });

  it('should report error for an unexpected failure', async () => {
    iamMock.on(GetRoleCommand).rejects(new Error('boom'));
    const service = new CloudHealthService(makeStore(), makeConfig());

    const result = await service.getChecks()[0]!.check();

    expect(result).toEqual({ status: 'error', message: 'boom' });
  });
});

describe('ECS service-linked role fix', () => {
  it('should report fixed when creation succeeds', async () => {
    iamMock.on(CreateServiceLinkedRoleCommand).resolves({});
    const service = new CloudHealthService(makeStore(), makeConfig());

    const result = await service.getChecks()[0]!.fix();

    expect(result).toEqual({ outcome: 'fixed' });
  });

  it('should report fixed when the role already exists', async () => {
    const err = Object.assign(new Error('Service linked role already exists'), { name: 'InvalidInputException' });
    iamMock.on(CreateServiceLinkedRoleCommand).rejects(err);
    const service = new CloudHealthService(makeStore(), makeConfig());

    const result = await service.getChecks()[0]!.fix();

    expect(result).toEqual({ outcome: 'fixed' });
  });

  it('should report needsPolicyUpdate with policy JSON when access is denied', async () => {
    const err = Object.assign(new Error('not authorized'), { name: 'AccessDeniedException' });
    iamMock.on(CreateServiceLinkedRoleCommand).rejects(err);
    const service = new CloudHealthService(makeStore(), makeConfig());

    const result = await service.getChecks()[0]!.fix();

    expect(result.outcome).toBe('needsPolicyUpdate');
    expect(result.policyJson).toContain('HyveonServiceLinkedRoles');
  });

  it('should report failed for an unexpected error', async () => {
    iamMock.on(CreateServiceLinkedRoleCommand).rejects(new Error('boom'));
    const service = new CloudHealthService(makeStore(), makeConfig());

    const result = await service.getChecks()[0]!.fix();

    expect(result).toEqual({ outcome: 'failed', message: 'boom' });
  });
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `npm run app:test -- CloudHealthService.test.ts`
Expected: FAIL — `Cannot find module './CloudHealthService.js'`.

- [x] **Step 3: Write the implementation**

Create `app/packages/desktop-main/src/services/CloudHealthService.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { IAMClient, GetRoleCommand, CreateServiceLinkedRoleCommand } from '@aws-sdk/client-iam';
import { generateHyveonDeployAllPolicy } from '@hyveon/shared';
import { logger } from '../logger.js';
import { ConfigService } from './ConfigService.js';
import { ElectronStoreService } from './ElectronStoreService.js';
import { resolveAwsClientCredentialsWithSignature } from './awsCredentialSource.js';

/** Outcome of a single {@link CloudHealthCheck.check} call. */
export type CloudHealthCheckStatus = 'ok' | 'missing' | 'error';

/** Result of running a {@link CloudHealthCheck}'s `check()`. */
export interface CloudHealthCheckResult {
  status: CloudHealthCheckStatus;
  /** Present when `status` is `'missing'` or `'error'` — an actionable, human-readable message. */
  message?: string;
}

/** Outcome of a single {@link CloudHealthCheck.fix} call. */
export type CloudHealthFixOutcome = 'fixed' | 'needsPolicyUpdate' | 'failed';

/** Result of running a {@link CloudHealthCheck}'s `fix()`. */
export interface CloudHealthFixResult {
  outcome: CloudHealthFixOutcome;
  /** Present when `outcome` is `'needsPolicyUpdate'` — the current `HyveonDeployAll` policy JSON to apply. */
  policyJson?: string;
  /** Present when `outcome` is `'failed'` — an actionable, human-readable message. */
  message?: string;
}

/** One AWS-account prerequisite check surfaced on the Settings page's Cloud Health section. */
export interface CloudHealthCheck {
  id: string;
  label: string;
  check(): Promise<CloudHealthCheckResult>;
  fix(): Promise<CloudHealthFixResult>;
}

/**
 * Backs the Settings page's Cloud Health checklist — a small, extensible set
 * of account-level prerequisite checks. Ships with one check: whether the
 * `AWSServiceRoleForECS` service-linked role exists, since its absence
 * causes ECS `RunTask` to fail with `InvalidParameterException` at game
 * start with no in-app way to discover or fix it.
 */
@Injectable()
export class CloudHealthService {
  constructor(
    private readonly store: ElectronStoreService,
    private readonly config: ConfigService,
  ) {}

  /** Returns every registered {@link CloudHealthCheck}. Add future checks here. */
  getChecks(): CloudHealthCheck[] {
    return [
      {
        id: 'ecs-service-linked-role',
        label: 'ECS service-linked role',
        check: () => this.checkEcsServiceLinkedRole(),
        fix: () => this.fixEcsServiceLinkedRole(),
      },
    ];
  }

  private getIamClient(): IAMClient {
    const region = this.config.getRegion();
    const { credentials } = resolveAwsClientCredentialsWithSignature(this.store);
    return new IAMClient({ region, credentials });
  }

  private async checkEcsServiceLinkedRole(): Promise<CloudHealthCheckResult> {
    logger.debug('CloudHealthService.checkEcsServiceLinkedRole: checking');
    try {
      await this.getIamClient().send(new GetRoleCommand({ RoleName: 'AWSServiceRoleForECS' }));
      return { status: 'ok' };
    } catch (err) {
      const name = err instanceof Error ? err.name : undefined;
      const message = err instanceof Error ? err.message : String(err);
      if (name === 'NoSuchEntityException') {
        return {
          status: 'missing',
          message: 'The AWSServiceRoleForECS service-linked role does not exist in this account.',
        };
      }
      logger.warn('CloudHealthService.checkEcsServiceLinkedRole: unexpected failure', { message });
      return { status: 'error', message };
    }
  }

  private async fixEcsServiceLinkedRole(): Promise<CloudHealthFixResult> {
    logger.debug('CloudHealthService.fixEcsServiceLinkedRole: attempting fix');
    try {
      await this.getIamClient().send(new CreateServiceLinkedRoleCommand({ AWSServiceName: 'ecs.amazonaws.com' }));
      return { outcome: 'fixed' };
    } catch (err) {
      const name = err instanceof Error ? err.name : undefined;
      const message = err instanceof Error ? err.message : String(err);
      // "Already exists" arrives as InvalidInputException — the SDK models no
      // dedicated exception for this case, so the message must be inspected.
      if (name === 'InvalidInputException' && /already exists/i.test(message)) {
        return { outcome: 'fixed' };
      }
      // AWS-wide errors like AccessDenied aren't always modeled as a
      // service-specific exception class, so both common name spellings are checked.
      if (name === 'AccessDeniedException' || name === 'AccessDenied') {
        logger.warn('CloudHealthService.fixEcsServiceLinkedRole: access denied, deploy policy needs updating', {
          message,
        });
        return { outcome: 'needsPolicyUpdate', policyJson: JSON.stringify(generateHyveonDeployAllPolicy(), null, 2) };
      }
      logger.error('CloudHealthService.fixEcsServiceLinkedRole: unexpected failure', { message });
      return { outcome: 'failed', message };
    }
  }
}
```

- [x] **Step 4: Run the test to verify it passes**

Run: `npm run app:test -- CloudHealthService.test.ts`
Expected: PASS — all 7 tests green.

- [x] **Step 5: Commit**

```bash
git add app/packages/desktop-main/src/services/CloudHealthService.ts app/packages/desktop-main/src/services/CloudHealthService.test.ts
git commit -m "feat(desktop-main): add CloudHealthService with ECS service-linked-role check"
```

---

### Task 3: `CloudHealthController` + module registration

**Files:**
- Create: `app/packages/desktop-main/src/controllers/cloud-health.controller.ts`
- Modify: `app/packages/desktop-main/src/modules/wizard.module.ts` (add `CloudHealthService` to `providers`/`exports`)
- Modify: `app/packages/desktop-main/src/app.module.ts` (import `CloudHealthController`, add to `controllers`)
- Test: `app/packages/desktop-main/src/controllers/cloud-health.controller.test.ts`

**Interfaces:**
- Consumes: `CloudHealthService.getChecks()` (Task 2).
- Produces: IPC patterns `cloudHealth.list` → `Promise<CloudHealthCheckSummary[]>` where `CloudHealthCheckSummary = { id: string; label: string; status: CloudHealthCheckStatus; message?: string }`; `cloudHealth.fix` (payload `{ id: string }`) → `Promise<CloudHealthFixResult>`. Task 4 (preload) consumes these exact channel names and shapes.

- [x] **Step 1: Write the failing test**

Create `app/packages/desktop-main/src/controllers/cloud-health.controller.test.ts`:

```ts
import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { CloudHealthController } from './cloud-health.controller.js';
import type { CloudHealthService, CloudHealthCheck } from '../services/CloudHealthService.js';

function makeService(checks: CloudHealthCheck[]): CloudHealthService {
  return { getChecks: vi.fn().mockReturnValue(checks) } as Partial<CloudHealthService> as CloudHealthService;
}

describe('CloudHealthController.list', () => {
  it('should return one summary per registered check', async () => {
    const check: CloudHealthCheck = {
      id: 'ecs-service-linked-role',
      label: 'ECS service-linked role',
      check: vi.fn().mockResolvedValue({ status: 'ok' }),
      fix: vi.fn(),
    };
    const controller = new CloudHealthController(makeService([check]));

    const result = await controller.list();

    expect(result).toEqual([{ id: 'ecs-service-linked-role', label: 'ECS service-linked role', status: 'ok' }]);
  });
});

describe('CloudHealthController.fix', () => {
  it('should call fix() on the matching check', async () => {
    const check: CloudHealthCheck = {
      id: 'ecs-service-linked-role',
      label: 'ECS service-linked role',
      check: vi.fn(),
      fix: vi.fn().mockResolvedValue({ outcome: 'fixed' }),
    };
    const controller = new CloudHealthController(makeService([check]));

    const result = await controller.fix({ id: 'ecs-service-linked-role' });

    expect(result).toEqual({ outcome: 'fixed' });
  });

  it('should return a failed outcome for an unknown check id', async () => {
    const controller = new CloudHealthController(makeService([]));

    const result = await controller.fix({ id: 'nonexistent' });

    expect(result).toEqual({ outcome: 'failed', message: 'Unknown health check id: nonexistent' });
  });
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `npm run app:test -- cloud-health.controller.test.ts`
Expected: FAIL — `Cannot find module './cloud-health.controller.js'`.

- [x] **Step 3: Write the controller**

Create `app/packages/desktop-main/src/controllers/cloud-health.controller.ts`:

```ts
import { Controller } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { CloudHealthService, type CloudHealthCheckStatus, type CloudHealthFixResult } from '../services/CloudHealthService.js';
import { logger } from '../logger.js';

/** One row's worth of data for the Settings page's Cloud Health checklist. */
export interface CloudHealthCheckSummary {
  id: string;
  label: string;
  status: CloudHealthCheckStatus;
  message?: string;
}

/**
 * IPC-only Cloud Health controller. Surfaces the account-prerequisite
 * checklist from {@link CloudHealthService} to the Settings page via
 * `cloudHealth.list` / `cloudHealth.fix` — no HTTP routes are registered.
 */
@Controller()
export class CloudHealthController {
  constructor(private readonly cloudHealth: CloudHealthService) {}

  @MessagePattern('cloudHealth.list')
  async list(): Promise<CloudHealthCheckSummary[]> {
    logger.debug('CloudHealthController: cloudHealth.list invoked');
    return Promise.all(
      this.cloudHealth.getChecks().map(async (check) => {
        const result = await check.check();
        return { id: check.id, label: check.label, ...result };
      }),
    );
  }

  @MessagePattern('cloudHealth.fix')
  async fix(@Payload() payload: { id: string }): Promise<CloudHealthFixResult> {
    logger.debug('CloudHealthController: cloudHealth.fix invoked', { id: payload.id });
    const check = this.cloudHealth.getChecks().find((c) => c.id === payload.id);
    if (!check) {
      return { outcome: 'failed', message: `Unknown health check id: ${payload.id}` };
    }
    return check.fix();
  }
}
```

- [x] **Step 4: Register in `WizardModule` and `AppModule`**

In `app/packages/desktop-main/src/modules/wizard.module.ts`, add `CloudHealthService` to both `providers` and `exports` arrays, and import it at the top of the file:

```ts
import { CloudHealthService } from '../services/CloudHealthService.js';
```

In `app/packages/desktop-main/src/app.module.ts`, import the controller and add it to `controllers`:

```ts
import { CloudHealthController } from './controllers/cloud-health.controller.js';
```

```ts
  controllers: [
    GamesController,
    CostsController,
    LogsController,
    FilesController,
    DiscordController,
    EnvController,
    DiagnosticsController,
    DriftController,
    AuditController,
    IacController,
    IacRunsController,
    IacSettingsController,
    WizardController,
    CloudHealthController,
  ],
```

`CloudHealthController` resolves `CloudHealthService` via `WizardModule`'s export since `WizardModule` is already listed in `AppModule`'s `imports`.

- [x] **Step 5: Run the test to verify it passes**

Run: `npm run app:test -- cloud-health.controller.test.ts`
Expected: PASS — all 3 tests green.

- [x] **Step 6: Run the full desktop-main build to catch module-wiring errors**

Run: `npm run app:typecheck`
Expected: PASS — no missing-provider errors from Nest's DI graph.

- [x] **Step 7: Commit**

```bash
git add app/packages/desktop-main/src/controllers/cloud-health.controller.ts app/packages/desktop-main/src/controllers/cloud-health.controller.test.ts app/packages/desktop-main/src/modules/wizard.module.ts app/packages/desktop-main/src/app.module.ts
git commit -m "feat(desktop-main): add CloudHealthController IPC surface"
```

---

### Task 4: Preload bridge (`cloudHealth` IPC namespace)

**Files:**
- Modify: `app/packages/desktop-preload/src/hyveon-api.ts` (add `HyveonCloudHealthApi`, `CloudHealthCheckSummary`, `CloudHealthFixResult` types + field on `HyveonApi`)
- Modify: `app/packages/desktop-preload/src/preload.ts` (add `cloudHealth` implementation block)

**Interfaces:**
- Consumes: IPC channel names `cloudHealth.list` / `cloudHealth.fix` (Task 3).
- Produces: `window.hyveon.cloudHealth.list(): Promise<CloudHealthCheckSummary[]>`, `window.hyveon.cloudHealth.fix(id: string): Promise<CloudHealthFixResult>`. Task 5 (`api.service.ts`) consumes these.

- [x] **Step 1: Add types and the `HyveonCloudHealthApi` interface**

In `app/packages/desktop-preload/src/hyveon-api.ts`, near `HyveonGamesApi` (around line 1103), add:

```ts
/** Status of a single Cloud Health check, as surfaced by `cloudHealth.list`. */
export type CloudHealthCheckStatus = 'ok' | 'missing' | 'error';

/** One row's worth of data for the Settings page's Cloud Health checklist. */
export interface CloudHealthCheckSummary {
  id: string;
  label: string;
  status: CloudHealthCheckStatus;
  message?: string;
}

/** Outcome of attempting to fix a single Cloud Health check. */
export type CloudHealthFixOutcome = 'fixed' | 'needsPolicyUpdate' | 'failed';

/** Result of a `cloudHealth.fix` call. */
export interface CloudHealthFixResult {
  outcome: CloudHealthFixOutcome;
  /** Present when `outcome` is `'needsPolicyUpdate'` — the current `HyveonDeployAll` policy JSON to apply. */
  policyJson?: string;
  /** Present when `outcome` is `'failed'` — an actionable, human-readable message. */
  message?: string;
}

/** Cloud Health checklist: lists AWS-account prerequisite checks and attempts one-click fixes. */
export interface HyveonCloudHealthApi {
  /** Runs every registered health check and returns one summary per check. */
  list: () => Promise<CloudHealthCheckSummary[]>;
  /** Attempts to fix the check with the given id. */
  fix: (id: string) => Promise<CloudHealthFixResult>;
}
```

Then add a field to the `HyveonApi` interface (near line 1998, alongside `drift`/`audit`):

```ts
  /** AWS account-prerequisite health checklist surfaced on the Settings page. */
  cloudHealth: HyveonCloudHealthApi;
```

- [x] **Step 2: Implement the bridge in `preload.ts`**

In `app/packages/desktop-preload/src/preload.ts`, add a block to the `api` object (near the `drift`/`audit` blocks, after `costs`):

```ts
  cloudHealth: {
    list: () => invoke('cloudHealth.list'),
    fix: (id: string) => invoke('cloudHealth.fix', { id }),
  },
```

- [x] **Step 3: Typecheck**

Run: `npm run app:typecheck`
Expected: PASS — `HyveonApi` implementation in `preload.ts` satisfies the extended interface.

- [x] **Step 4: Commit**

```bash
git add app/packages/desktop-preload/src/hyveon-api.ts app/packages/desktop-preload/src/preload.ts
git commit -m "feat(desktop-preload): add cloudHealth IPC bridge"
```

---

### Task 5: `api.service.ts` passthrough

**Files:**
- Modify: `app/packages/web/src/api.service.ts`

**Interfaces:**
- Consumes: `window.hyveon.cloudHealth` (Task 4).
- Produces: `api.cloudHealthList(): Promise<CloudHealthCheckSummary[]>`, `api.cloudHealthFix(id: string): Promise<CloudHealthFixResult>`. Task 6 (`CloudHealthSection`) consumes these.

- [x] **Step 1: Add mirrored types and passthrough methods**

Per this file's existing convention (each type mirrors its `@hyveon/desktop-preload` counterpart with a "keep this copy in sync" TSDoc note), add near the top of `app/packages/web/src/api.service.ts`:

```ts
/** Status of a single Cloud Health check. Mirrors `CloudHealthCheckStatus` in `@hyveon/desktop-preload` — keep this copy in sync with it. */
export type CloudHealthCheckStatus = 'ok' | 'missing' | 'error';

/** One row's worth of data for the Settings page's Cloud Health checklist. Mirrors `CloudHealthCheckSummary` in `@hyveon/desktop-preload` — keep this copy in sync with it. */
export interface CloudHealthCheckSummary {
  id: string;
  label: string;
  status: CloudHealthCheckStatus;
  message?: string;
}

/** Outcome of attempting to fix a single Cloud Health check. Mirrors `CloudHealthFixOutcome` in `@hyveon/desktop-preload` — keep this copy in sync with it. */
export type CloudHealthFixOutcome = 'fixed' | 'needsPolicyUpdate' | 'failed';

/** Result of a Cloud Health fix attempt. Mirrors `CloudHealthFixResult` in `@hyveon/desktop-preload` — keep this copy in sync with it. */
export interface CloudHealthFixResult {
  outcome: CloudHealthFixOutcome;
  policyJson?: string;
  message?: string;
}
```

Add to the `api` object (near `drift`/`audit`, around line 489):

```ts
  cloudHealthList: async (): Promise<CloudHealthCheckSummary[]> => hyveon().cloudHealth.list(),
  cloudHealthFix: async (id: string): Promise<CloudHealthFixResult> => hyveon().cloudHealth.fix(id),
```

- [x] **Step 2: Typecheck**

Run: `npm run app:typecheck`
Expected: PASS.

- [x] **Step 3: Commit**

```bash
git add app/packages/web/src/api.service.ts
git commit -m "feat(web): add cloudHealth API passthrough"
```

---

### Task 6: `CloudHealthSection` component + Settings page wiring

**Files:**
- Create: `app/packages/web/src/components/cloud-health-section.component.tsx`
- Test: `app/packages/web/src/components/cloud-health-section.component.test.tsx`
- Modify: `app/packages/web/src/pages/settings.page.tsx` (mount the new section, between the Watchdog and Cloud Setup sections)
- Modify: `app/packages/web/src/pages/settings.page.test.tsx` (extend the `apiMock` hoisted object with `cloudHealthList`/`cloudHealthFix` so existing tests keep passing)

**Interfaces:**
- Consumes: `api.cloudHealthList()`, `api.cloudHealthFix(id)` (Task 5).
- Produces: `export function CloudHealthSection(): JSX.Element`, mounted with no props on `settings.page.tsx`.

- [x] **Step 1: Extend `settings.page.test.tsx`'s API mock so existing tests don't break**

In `app/packages/web/src/pages/settings.page.test.tsx`, add to the `vi.hoisted` `apiMock` object:

```ts
  cloudHealthList: vi.fn(),
  cloudHealthFix: vi.fn(),
```

and to the `beforeEach` reset block:

```ts
    apiMock.cloudHealthList.mockResolvedValue([{ id: 'ecs-service-linked-role', label: 'ECS service-linked role', status: 'ok' }]);
```

- [x] **Step 2: Write the failing component test**

Create `app/packages/web/src/components/cloud-health-section.component.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const apiMock = vi.hoisted(() => ({
  cloudHealthList: vi.fn(),
  cloudHealthFix: vi.fn(),
}));
vi.mock('../api.service.js', () => ({ api: apiMock }));

import { CloudHealthSection } from './cloud-health-section.component.js';

beforeEach(() => {
  apiMock.cloudHealthList.mockReset();
  apiMock.cloudHealthFix.mockReset();
});

describe('CloudHealthSection', () => {
  it('should render an ok row with no Fix button', async () => {
    apiMock.cloudHealthList.mockResolvedValue([
      { id: 'ecs-service-linked-role', label: 'ECS service-linked role', status: 'ok' },
    ]);
    render(<CloudHealthSection />);

    expect(await screen.findByText('ECS service-linked role')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /fix/i })).not.toBeInTheDocument();
  });

  it('should render a missing row with a Fix button', async () => {
    apiMock.cloudHealthList.mockResolvedValue([
      { id: 'ecs-service-linked-role', label: 'ECS service-linked role', status: 'missing', message: 'not found' },
    ]);
    render(<CloudHealthSection />);

    expect(await screen.findByRole('button', { name: /fix/i })).toBeInTheDocument();
    expect(screen.getByText('not found')).toBeInTheDocument();
  });

  it('should re-render green after a successful Fix', async () => {
    apiMock.cloudHealthList
      .mockResolvedValueOnce([{ id: 'ecs-service-linked-role', label: 'ECS service-linked role', status: 'missing' }])
      .mockResolvedValueOnce([{ id: 'ecs-service-linked-role', label: 'ECS service-linked role', status: 'ok' }]);
    apiMock.cloudHealthFix.mockResolvedValue({ outcome: 'fixed' });
    render(<CloudHealthSection />);

    await userEvent.click(await screen.findByRole('button', { name: /fix/i }));

    await waitFor(() => expect(screen.queryByRole('button', { name: /fix/i })).not.toBeInTheDocument());
    expect(apiMock.cloudHealthList).toHaveBeenCalledTimes(2);
  });

  it('should show the copyable policy JSON on needsPolicyUpdate', async () => {
    apiMock.cloudHealthList.mockResolvedValue([
      { id: 'ecs-service-linked-role', label: 'ECS service-linked role', status: 'missing' },
    ]);
    apiMock.cloudHealthFix.mockResolvedValue({ outcome: 'needsPolicyUpdate', policyJson: '{"Sid":"HyveonServiceLinkedRoles"}' });
    render(<CloudHealthSection />);

    await userEvent.click(await screen.findByRole('button', { name: /fix/i }));

    expect(await screen.findByText(/HyveonServiceLinkedRoles/)).toBeInTheDocument();
  });

  it('should show an inline error and keep Fix available on an unexpected failure', async () => {
    apiMock.cloudHealthList.mockResolvedValue([
      { id: 'ecs-service-linked-role', label: 'ECS service-linked role', status: 'missing' },
    ]);
    apiMock.cloudHealthFix.mockResolvedValue({ outcome: 'failed', message: 'boom' });
    render(<CloudHealthSection />);

    await userEvent.click(await screen.findByRole('button', { name: /fix/i }));

    expect(await screen.findByText('boom')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /fix/i })).toBeInTheDocument();
  });
});
```

- [x] **Step 3: Run the test to verify it fails**

Run: `npm run app:test -- cloud-health-section.component.test.tsx`
Expected: FAIL — `Cannot find module './cloud-health-section.component.js'`.

- [x] **Step 4: Write the component**

Create `app/packages/web/src/components/cloud-health-section.component.tsx`:

```tsx
import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, AlertTriangle, XCircle, Copy, Loader2 } from 'lucide-react';
import { api, type CloudHealthCheckSummary, type CloudHealthFixResult } from '../api.service.js';
import { Button } from './ui/button.component.js';
import { Badge } from './ui/badge.component.js';

/** Status badge for a single Cloud Health row. */
function HealthBadge({ status }: { status: CloudHealthCheckSummary['status'] }) {
  switch (status) {
    case 'ok':
      return <Badge variant="success">OK</Badge>;
    case 'missing':
      return <Badge variant="destructive">Missing</Badge>;
    case 'error':
      return <Badge variant="destructive">Error</Badge>;
  }
}

/** One row of the Cloud Health checklist, with its own Fix state. */
function HealthRow({ check, onFixed }: { check: CloudHealthCheckSummary; onFixed: () => void }) {
  const [fixing, setFixing] = useState(false);
  const [fixResult, setFixResult] = useState<CloudHealthFixResult | null>(null);

  async function handleFix() {
    setFixing(true);
    setFixResult(null);
    try {
      const result = await api.cloudHealthFix(check.id);
      if (result.outcome === 'fixed') {
        onFixed();
      } else {
        setFixResult(result);
      }
    } finally {
      setFixing(false);
    }
  }

  const broken = check.status !== 'ok';

  return (
    <div className="rounded-[var(--radius-md)] border border-[var(--color-border)] p-4 space-y-2">
      <div className="flex items-center gap-2">
        {check.status === 'ok' && <CheckCircle2 className="size-4 text-[var(--color-green)]" />}
        {check.status === 'missing' && <AlertTriangle className="size-4 text-[var(--color-amber)]" />}
        {check.status === 'error' && <XCircle className="size-4 text-[var(--color-red)]" />}
        <span className="font-medium flex-1">{check.label}</span>
        <HealthBadge status={check.status} />
        {broken && (
          <Button type="button" variant="outline" size="sm" onClick={() => void handleFix()} disabled={fixing}>
            {fixing ? <Loader2 className="size-3 animate-spin" /> : 'Fix'}
          </Button>
        )}
      </div>
      {check.message && !fixResult && <p className="text-xs text-muted-foreground">{check.message}</p>}
      {fixResult?.outcome === 'failed' && <p className="text-xs text-[var(--color-red)]">{fixResult.message}</p>}
      {fixResult?.outcome === 'needsPolicyUpdate' && fixResult.policyJson && (
        <div className="space-y-2">
          <p className="text-xs text-[var(--color-amber)]">
            Your Hyveon deploy policy needs updating. Apply the JSON below via your CloudFormation stack, then click
            Fix again.
          </p>
          <div className="relative">
            <pre className="max-h-64 overflow-auto rounded-[var(--radius-md)] bg-[var(--color-surface-2)] p-3 text-xs">
              {fixResult.policyJson}
            </pre>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="absolute top-2 right-2"
              onClick={() =>
                void navigator.clipboard.writeText(fixResult.policyJson!).catch(() => {
                  /* clipboard denial is non-critical; the policy JSON is still visible above */
                })
              }
              aria-label="Copy required IAM JSON"
            >
              <Copy className="size-3" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Always-visible AWS account-prerequisite checklist for the Settings page.
 * Runs on mount and on manual Refresh — no automatic polling.
 */
export function CloudHealthSection() {
  const [checks, setChecks] = useState<CloudHealthCheckSummary[] | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setChecks(await api.cloudHealthList());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Button type="button" variant="ghost" size="sm" onClick={() => void refresh()} disabled={loading}>
          {loading ? <Loader2 className="size-3 animate-spin" /> : 'Refresh'}
        </Button>
      </div>
      {(checks ?? []).map((check) => (
        <HealthRow key={check.id} check={check} onFixed={() => void refresh()} />
      ))}
    </div>
  );
}
```

- [x] **Step 5: Run the test to verify it passes**

Run: `npm run app:test -- cloud-health-section.component.test.tsx`
Expected: PASS — all 5 tests green.

- [x] **Step 6: Mount on `settings.page.tsx`**

In `app/packages/web/src/pages/settings.page.tsx`, add the import:

```tsx
import { CloudHealthSection } from '../components/cloud-health-section.component.js';
```

Insert a new section between the Watchdog block (ending line 89) and the Cloud Setup block (starting line 90):

```tsx
      {/* Cloud Health section: always-visible AWS account-prerequisite checklist. */}
      <div className="mb-8">
        <h3 className="text-lg font-medium mb-4">Cloud Health</h3>
        <CloudHealthSection />
      </div>

```

- [x] **Step 7: Run the full settings page test file**

Run: `npm run app:test -- settings.page.test.tsx`
Expected: PASS — existing tests still green with the extended `apiMock`.

- [x] **Step 8: Commit**

```bash
git add app/packages/web/src/components/cloud-health-section.component.tsx app/packages/web/src/components/cloud-health-section.component.test.tsx app/packages/web/src/pages/settings.page.tsx app/packages/web/src/pages/settings.page.test.tsx
git commit -m "feat(web): add Cloud Health checklist to Settings page"
```

---

### Task 7: Docs

**Files:**
- Modify: `docs/docs/app/settings.md`

**Interfaces:**
- N/A — documentation only.

- [x] **Step 1: Add a "Cloud Health" section to `docs/docs/app/settings.md`**

Read the existing "Cloud Setup" section of `docs/docs/app/settings.md` for the house style, then add a new section (placed to match the page's actual section order after Task 6's UI change) describing: the always-visible checklist, that it ships with one check (ECS service-linked role), the check/fix cycle, and the `needsPolicyUpdate` fallback (apply the shown policy JSON via CloudFormation, then retry).

- [x] **Step 2: Confirm the `HyveonDeployAll` policy JSON block in `docs/docs/setup.md` already reflects the new statement**

This was done in Task 1, Step 3. Run: `npm run app:test -- iamPolicy.test.ts` once more here as a final confirmation the docs and generator are still in sync after all other changes.

- [x] **Step 3: Commit**

```bash
git add docs/docs/app/settings.md
git commit -m "docs(app): document the Cloud Health checklist"
```

---

### Task 8: Full verification gate

**Files:** none (verification only).

- [x] **Step 1: Lint**

Run: `npm run app:lint`
Expected: PASS, no errors.

- [x] **Step 2: Typecheck**

Run: `npm run app:typecheck`
Expected: PASS, no errors.

- [x] **Step 3: Full unit suite**

Run: `npm run app:test`
Expected: PASS, all tests green including every file touched above.

- [x] **Step 4: Open the PR**

Follow `.claude/commands/pr.md` (the `/pr` skill) — Conventional Commits title, e.g. `feat(app): add AWS Cloud Health checklist to Settings`, body summarizing the change and linking back to this OpenSpec change (`openspec/changes/aws-cloud-health-checks/`).
