import { IacController } from '@hyveon/desktop-main/dist/controllers/iac.controller.js';
import {
  PulumiPlanNotApprovedError,
  PulumiApprovalExpiredError,
  PulumiPlanHashMismatchError,
  PulumiEngineVersionMismatchError,
  PulumiPlanRunNotFoundError,
  PulumiPlanArtifactStaleError,
  StalePlanError,
  type PulumiUpResult,
} from '@hyveon/desktop-main/dist/services/PulumiService.js';
import { RunLockHeldError, type RunLock } from '@hyveon/shared';
import { test, expect } from './index.js';
import { makeFakeIacCtx, waitForIacMessage } from './support/iac-ctx.js';

/** A well-formed `IacController.apply` payload every scenario below reuses (only the scripted stub response varies). */
const APPLY_PAYLOAD = { planRunId: 'plan-run-1', planHash: 'sha256-approved-hash' };

/** A `RunLock` fixture for the "competing applies" scenario's `RunLockHeldError`. */
function buildLock(): RunLock {
  return {
    runId: 'plan-run-1',
    kind: 'apply',
    initiator: 'operator@example.com',
    acquiredAt: new Date(0).toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
}

/**
 * Verifies the `orchestrator-integration-coverage` delta spec's "Apply
 * rejects stale and unapproved plans" requirement. `PulumiService.apply`'s
 * 8-step gate is entirely self-contained and lives inside the real
 * `PulumiService`, which the DI-substituted `PulumiServiceStub` fully
 * replaces — so this suite does not re-derive that gate math (already
 * unit-tested in `PulumiService.apply.test.ts`). Instead, it scripts the
 * stub's `apply()` run to fail with the exact real gate-error class the
 * corresponding gate step throws, and verifies `IacController.apply`'s own
 * ack-shaping: which `conflict`/`staleLock` field (if any) each error class
 * maps to, and that the stub's scripted run was never played (no
 * `iac.apply.chunk` message) for every rejection.
 */
test.describe('IacController.apply — gate rejection ack-shaping', () => {
  test('should reject an unapproved plan with a generic error and never invoke the engine', async ({
    ipc,
    serverMocks: _reset,
  }) => {
    ipc.mocks.pulumi.scriptApply({ failure: new PulumiPlanNotApprovedError(APPLY_PAYLOAD.planRunId) });
    const fakeCtx = makeFakeIacCtx();

    const ack = await ipc.dispatch(IacController, 'apply', APPLY_PAYLOAD, fakeCtx.ctx);

    expect(ack.started).toBe(false);
    expect(ack.error).toBeDefined();
    expect(ack.conflict).toBeUndefined();
    expect(ack.staleLock).toBeUndefined();
    expect(fakeCtx.sentMessages.some((m) => m.channel === 'iac.apply.chunk')).toBe(false);
  });

  test('should reject an approval older than the 15-minute approval window', async ({ ipc, serverMocks: _reset }) => {
    ipc.mocks.pulumi.scriptApply({
      failure: new PulumiApprovalExpiredError(APPLY_PAYLOAD.planRunId, new Date(0).toISOString()),
    });
    const fakeCtx = makeFakeIacCtx();

    const ack = await ipc.dispatch(IacController, 'apply', APPLY_PAYLOAD, fakeCtx.ctx);

    expect(ack.started).toBe(false);
    expect(ack.error).toBeDefined();
    expect(fakeCtx.sentMessages.some((m) => m.channel === 'iac.apply.chunk')).toBe(false);
  });

  test('should reject a planHash that does not match the approved plan record', async ({ ipc, serverMocks: _reset }) => {
    ipc.mocks.pulumi.scriptApply({
      failure: new PulumiPlanHashMismatchError(APPLY_PAYLOAD.planRunId, 'stored-hash', APPLY_PAYLOAD.planHash),
    });
    const fakeCtx = makeFakeIacCtx();

    const ack = await ipc.dispatch(IacController, 'apply', APPLY_PAYLOAD, fakeCtx.ctx);

    expect(ack.started).toBe(false);
    expect(ack.error).toBeDefined();
    expect(fakeCtx.sentMessages.some((m) => m.channel === 'iac.apply.chunk')).toBe(false);
  });

  test('should reject a plan whose recorded engine version differs from the current engine version', async ({
    ipc,
    serverMocks: _reset,
  }) => {
    ipc.mocks.pulumi.scriptApply({
      failure: new PulumiEngineVersionMismatchError(APPLY_PAYLOAD.planRunId, '3.250.0', '3.255.0'),
    });
    const fakeCtx = makeFakeIacCtx();

    const ack = await ipc.dispatch(IacController, 'apply', APPLY_PAYLOAD, fakeCtx.ctx);

    expect(ack.started).toBe(false);
    expect(ack.error).toContain('3.250.0');
    expect(fakeCtx.sentMessages.some((m) => m.channel === 'iac.apply.chunk')).toBe(false);
  });

  test('should apply a fresh, approved plan and run the stubbed engine to completion', async ({
    ipc,
    serverMocks: _reset,
  }) => {
    const upResult: PulumiUpResult = { runId: APPLY_PAYLOAD.planRunId, changeSummary: { create: 1, same: 4 } };
    ipc.mocks.pulumi.scriptApply({
      chunks: [{ stream: 'stdout', line: 'applying...' }],
      result: upResult,
    });
    const fakeCtx = makeFakeIacCtx();

    const ack = await ipc.dispatch(IacController, 'apply', APPLY_PAYLOAD, fakeCtx.ctx);
    expect(ack.started).toBe(true);
    expect(ack.runId).toBe(APPLY_PAYLOAD.planRunId);

    const end = await waitForIacMessage(fakeCtx, 'iac.apply.end');
    const message = end.message as { exitCode: number | null; result?: PulumiUpResult };
    expect(message.exitCode).toBe(0);
    expect(message.result).toEqual(upResult);
    expect(fakeCtx.sentMessages.some((m) => m.channel === 'iac.apply.chunk')).toBe(true);
  });

  test('should reject a planRunId with no persisted plan record', async ({ ipc, serverMocks: _reset }) => {
    ipc.mocks.pulumi.scriptApply({ failure: new PulumiPlanRunNotFoundError(APPLY_PAYLOAD.planRunId) });
    const fakeCtx = makeFakeIacCtx();

    const ack = await ipc.dispatch(IacController, 'apply', APPLY_PAYLOAD, fakeCtx.ctx);

    expect(ack.started).toBe(false);
    expect(ack.error).toBeDefined();
    expect(fakeCtx.sentMessages.some((m) => m.channel === 'iac.apply.chunk')).toBe(false);
  });

  test('should reject when the on-disk plan artifact no longer matches its approved hash', async ({
    ipc,
    serverMocks: _reset,
  }) => {
    ipc.mocks.pulumi.scriptApply({
      failure: new PulumiPlanArtifactStaleError(APPLY_PAYLOAD.planRunId, '/runs/plan-run-1/plan.json'),
    });
    const fakeCtx = makeFakeIacCtx();

    const ack = await ipc.dispatch(IacController, 'apply', APPLY_PAYLOAD, fakeCtx.ctx);

    expect(ack.started).toBe(false);
    expect(ack.error).toBeDefined();
    expect(fakeCtx.sentMessages.some((m) => m.channel === 'iac.apply.chunk')).toBe(false);
  });

  test('should reject a plan whose configuration object has moved since it was produced', async ({
    ipc,
    serverMocks: _reset,
  }) => {
    ipc.mocks.pulumi.scriptApply({
      failure: new StalePlanError('deployment-config.json', 'test-config-bucket', 'v1', 'v2'),
    });
    const fakeCtx = makeFakeIacCtx();

    const ack = await ipc.dispatch(IacController, 'apply', APPLY_PAYLOAD, fakeCtx.ctx);

    expect(ack.started).toBe(false);
    expect(ack.error).toBeDefined();
    expect(fakeCtx.sentMessages.some((m) => m.channel === 'iac.apply.chunk')).toBe(false);
  });

  test('should refuse a losing competing apply with conflict "up" when the durable lock is already held', async ({
    ipc,
    serverMocks: _reset,
  }) => {
    ipc.mocks.pulumi.scriptApply({ failure: new RunLockHeldError(buildLock()) });
    const fakeCtx = makeFakeIacCtx();

    const ack = await ipc.dispatch(IacController, 'apply', APPLY_PAYLOAD, fakeCtx.ctx);

    expect(ack.started).toBe(false);
    expect(ack.conflict).toBe('up');
    expect(fakeCtx.sentMessages.some((m) => m.channel === 'iac.apply.chunk')).toBe(false);
  });
});
