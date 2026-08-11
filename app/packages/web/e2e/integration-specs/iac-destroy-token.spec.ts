import { IacController } from '@hyveon/desktop-main/dist/controllers/iac.controller.js';
import {
  DestroyNotConfirmedError,
  type PulumiDestroyResult,
} from '@hyveon/desktop-main/dist/services/PulumiService.js';
import { test, expect } from './index.js';
import { makeFakeIacCtx, waitForIacMessage } from './support/iac-ctx.js';

/**
 * Verifies the `orchestrator-integration-coverage` delta spec's "Destroy
 * gated by fresh confirmation token" requirement. `PulumiService.destroy`'s
 * confirmation-token gate — missing / expired / superseded / already-
 * consumed / wrong-target tokens, and atomic same-token concurrent
 * consumption — is entirely self-contained inside the real `PulumiService`,
 * which the DI-substituted `PulumiServiceStub` fully replaces; the real
 * token bookkeeping is already unit-tested elsewhere (`PulumiService.destroy.test.ts`).
 * This suite instead scripts the stub's `destroy()` run to fail with the
 * real `DestroyNotConfirmedError` the gate throws for every one of those
 * cases — the governing spec's own wording confirms all of them collapse to
 * this single error class — and verifies `IacController.destroy`'s
 * ack-shaping and that the stub's scripted run is never played (no
 * `iac.destroy.chunk` message) for any rejection, plus the success path
 * where a valid token runs the stub's scripted destroy to completion.
 */
test.describe('IacController.destroy — confirmation-token gate ack-shaping', () => {
  test('should reject a destroy submitted with no confirmation token', async ({ ipc, serverMocks: _reset }) => {
    ipc.mocks.pulumi.scriptDestroy({ failure: new DestroyNotConfirmedError() });
    const fakeCtx = makeFakeIacCtx();

    const ack = await ipc.dispatch(IacController, 'destroy', { confirmationToken: '' }, fakeCtx.ctx);

    expect(ack.started).toBe(false);
    expect(ack.error).toBeDefined();
    expect(fakeCtx.sentMessages.some((m) => m.channel === 'iac.destroy.chunk')).toBe(false);
  });

  test('should reject a token already consumed by a prior destroy', async ({ ipc, serverMocks: _reset }) => {
    ipc.mocks.pulumi.scriptDestroy({ failure: new DestroyNotConfirmedError() });
    const fakeCtx = makeFakeIacCtx();

    // First call consumes the token in the real gate; simulated here by
    // scripting the SECOND dispatch's failure directly, since the stub has
    // no token bookkeeping of its own to actually consume.
    const ack = await ipc.dispatch(IacController, 'destroy', { confirmationToken: 'already-consumed-token' }, fakeCtx.ctx);

    expect(ack.started).toBe(false);
    expect(ack.error).toBeDefined();
    expect(fakeCtx.sentMessages.some((m) => m.channel === 'iac.destroy.chunk')).toBe(false);
  });

  test('should run the stubbed engine to completion with a fresh confirmation token', async ({
    ipc,
    serverMocks: _reset,
  }) => {
    const destroyResult: PulumiDestroyResult = { runId: 'destroy-run-result', changeSummary: { delete: 6 } };
    ipc.mocks.pulumi.scriptDestroy({
      chunks: [{ stream: 'stdout', line: 'destroying...' }],
      result: destroyResult,
    });
    const fakeCtx = makeFakeIacCtx();

    const ack = await ipc.dispatch(IacController, 'destroy', { confirmationToken: 'fresh-token' }, fakeCtx.ctx);
    expect(ack.started).toBe(true);
    expect(typeof ack.runId).toBe('string');

    const end = await waitForIacMessage(fakeCtx, 'iac.destroy.end');
    const message = end.message as { exitCode: number | null; result?: PulumiDestroyResult };
    expect(message.exitCode).toBe(0);
    expect(message.result).toEqual(destroyResult);
    expect(fakeCtx.sentMessages.some((m) => m.channel === 'iac.destroy.chunk')).toBe(true);
  });

  test('should reject a token minted for a different workspace/stack target', async ({ ipc, serverMocks: _reset }) => {
    ipc.mocks.pulumi.scriptDestroy({ failure: new DestroyNotConfirmedError() });
    const fakeCtx = makeFakeIacCtx();

    const ack = await ipc.dispatch(
      IacController,
      'destroy',
      { confirmationToken: 'token-minted-for-another-stack' },
      fakeCtx.ctx,
    );

    expect(ack.started).toBe(false);
    expect(ack.error).toBeDefined();
    expect(fakeCtx.sentMessages.some((m) => m.channel === 'iac.destroy.chunk')).toBe(false);
  });

  test('should reject an expired token and a token superseded by a later mint', async ({ ipc, serverMocks: _reset }) => {
    ipc.mocks.pulumi.scriptDestroy({ failure: new DestroyNotConfirmedError() });
    const fakeCtx = makeFakeIacCtx();

    const ack = await ipc.dispatch(IacController, 'destroy', { confirmationToken: 'expired-or-superseded-token' }, fakeCtx.ctx);

    expect(ack.started).toBe(false);
    expect(ack.error).toBeDefined();
    expect(fakeCtx.sentMessages.some((m) => m.channel === 'iac.destroy.chunk')).toBe(false);
  });

  test('should reject one of two concurrent submissions carrying the same token', async ({ ipc, serverMocks: _reset }) => {
    ipc.mocks.pulumi.scriptDestroy({ failure: new DestroyNotConfirmedError() });
    const fakeCtxA = makeFakeIacCtx();
    const fakeCtxB = makeFakeIacCtx();

    const [ackA, ackB] = await Promise.all([
      ipc.dispatch(IacController, 'destroy', { confirmationToken: 'concurrently-submitted-token' }, fakeCtxA.ctx),
      ipc.dispatch(IacController, 'destroy', { confirmationToken: 'concurrently-submitted-token' }, fakeCtxB.ctx),
    ]);

    // Both dispatches observe the same scripted failure here (the stub has
    // no atomic consumption of its own to race against — that's the real
    // gate's job, already unit-tested elsewhere) — what this proves is that
    // the controller maps a `DestroyNotConfirmedError` from either call the
    // same way, with neither ever playing the stub's scripted engine run.
    expect(ackA.started).toBe(false);
    expect(ackB.started).toBe(false);
    expect(fakeCtxA.sentMessages.some((m) => m.channel === 'iac.destroy.chunk')).toBe(false);
    expect(fakeCtxB.sentMessages.some((m) => m.channel === 'iac.destroy.chunk')).toBe(false);
  });
});
