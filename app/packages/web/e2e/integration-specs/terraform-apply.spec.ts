import { TerraformController } from '@hyveon/desktop-main/dist/controllers/terraform.controller.js';
import { TerraformService } from '@hyveon/desktop-main/dist/services/TerraformService.js';
import type { TerraformRunChunk } from '@hyveon/desktop-main/dist/services/TerraformService.js';
import { runRecordMockStore } from '@hyveon/desktop-main/dist/test-mocks/run-record-mock.js';
import { test, expect } from '../fixtures/terraform-shim.js';
import { successfulApplyEntry, successfulPlanEntry, versionEntry, writeFixture } from '../fixtures/terraform-fixtures.js';

/** The `terraform.apply` side channel `TerraformController.apply` sends its terminal message on — see `terraform.controller.ts`. */
const APPLY_END_CHANNEL = 'terraform.apply.end';

/** Drains a `TerraformService` async generator, returning its yielded chunks and eventual return value. */
async function drive<T>(gen: AsyncGenerator<TerraformRunChunk, T>): Promise<T> {
  let next = await gen.next();
  while (!next.done) {
    next = await gen.next();
  }
  return next.value;
}

/**
 * Builds a minimal `IpcMainInvokeEvent`-shaped context for dispatching
 * `TerraformController.apply` — mirrors the `sender` stub
 * `terraform.controller.test.ts` uses, but without `vitest`'s `vi.fn()`
 * (unavailable in this Playwright-driven tier): every `send` call is instead
 * appended to the plain `sent` array so a spec can poll for the terminal
 * `terraform.apply.end` message.
 */
function makeCtx(): { ctx: { evt: { sender: unknown } }; sent: Array<{ channel: string; payload: unknown }> } {
  const sent: Array<{ channel: string; payload: unknown }> = [];
  const sender = {
    send: (channel: string, payload: unknown) => {
      sent.push({ channel, payload });
    },
    isDestroyed: () => false,
    once: () => {},
    removeListener: () => {},
  };
  return { ctx: { evt: { sender } }, sent };
}

/** Polls `predicate` until it returns `true`, or throws once `timeoutMs` has elapsed. */
async function waitUntil(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('waitUntil: timed out waiting for predicate to become true');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test.describe('TerraformController.apply (integration)', () => {
  test('should reject an unapproved plan run without spawning terraform apply', async ({ ipc, terraformFixture }) => {
    writeFixture(terraformFixture.scriptPath, {
      version: versionEntry(),
      plan: successfulPlanEntry(),
      apply: successfulApplyEntry(),
    });

    const terraform = ipc.get(TerraformService);
    const planResult = await drive(terraform.plan());
    expect(planResult).toBeDefined();

    const { ctx } = makeCtx();
    const ack = await ipc.dispatch(TerraformController, 'apply', { planRunId: planResult!.runId, planHash: planResult!.planHash }, ctx);

    expect(ack.started).toBe(false);
    expect(ack.error).toContain('not been approved');

    const record = terraform.readRunRecord(planResult!.runId);
    expect(record?.kind).toBe('plan');
  });

  test('should reject an apply once the approval window has expired', async ({ ipc, terraformFixture }) => {
    writeFixture(terraformFixture.scriptPath, {
      version: versionEntry(),
      plan: successfulPlanEntry(),
      apply: successfulApplyEntry(),
    });

    const terraform = ipc.get(TerraformService);
    const planResult = await drive(terraform.plan());
    expect(planResult).toBeDefined();

    await ipc.dispatch(TerraformController, 'approve', { planRunId: planResult!.runId });
    const expiredApprovedAt = new Date(Date.now() - 16 * 60 * 1000).toISOString();
    runRecordMockStore.patchApprovedAt(planResult!.runId, expiredApprovedAt);

    const { ctx } = makeCtx();
    const ack = await ipc.dispatch(TerraformController, 'apply', { planRunId: planResult!.runId, planHash: planResult!.planHash }, ctx);

    expect(ack.started).toBe(false);
    expect(ack.error).toContain('expired');

    const record = terraform.readRunRecord(planResult!.runId);
    expect(record?.kind).toBe('plan');
  });

  test('should reject an apply whose planHash does not match the approved plan record', async ({ ipc, terraformFixture }) => {
    writeFixture(terraformFixture.scriptPath, {
      version: versionEntry(),
      plan: successfulPlanEntry(),
      apply: successfulApplyEntry(),
    });

    const terraform = ipc.get(TerraformService);
    const planResult = await drive(terraform.plan());
    expect(planResult).toBeDefined();

    await ipc.dispatch(TerraformController, 'approve', { planRunId: planResult!.runId });

    const { ctx } = makeCtx();
    const ack = await ipc.dispatch(
      TerraformController,
      'apply',
      { planRunId: planResult!.runId, planHash: 'deliberately-wrong-hash' },
      ctx,
    );

    expect(ack.started).toBe(false);
    expect(ack.error).toContain('hash');

    const record = terraform.readRunRecord(planResult!.runId);
    expect(record?.kind).toBe('plan');
  });

  test('should apply a fresh, matching approved plan and run the scripted apply to completion', async ({
    ipc,
    terraformFixture,
  }) => {
    writeFixture(terraformFixture.scriptPath, {
      version: versionEntry(),
      plan: successfulPlanEntry(),
      apply: successfulApplyEntry({ added: 3, changed: 1, destroyed: 0 }),
    });

    const terraform = ipc.get(TerraformService);
    const planResult = await drive(terraform.plan());
    expect(planResult).toBeDefined();

    await ipc.dispatch(TerraformController, 'approve', { planRunId: planResult!.runId });

    const { ctx, sent } = makeCtx();
    const ack = await ipc.dispatch(
      TerraformController,
      'apply',
      { planRunId: planResult!.runId, planHash: planResult!.planHash },
      ctx,
    );

    expect(ack.started).toBe(true);
    expect(ack.runId).toBe(planResult!.runId);

    await waitUntil(() => sent.some((m) => m.channel === APPLY_END_CHANNEL));
    const endMessage = sent.find((m) => m.channel === APPLY_END_CHANNEL)!.payload as {
      exitCode: number | null;
      error?: string;
      result?: { added: number; changed: number; destroyed: number };
    };

    expect(endMessage.exitCode).toBe(0);
    expect(endMessage.error).toBeUndefined();
    expect(endMessage.result).toMatchObject({ added: 3, changed: 1, destroyed: 0 });

    const record = terraform.readRunRecord(planResult!.runId);
    expect(record?.kind).toBe('apply');
    expect(record?.exitCode).toBe(0);
  });
});
