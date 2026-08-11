import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IacController } from '@hyveon/desktop-main/dist/controllers/iac.controller.js';
import type { PulumiPreviewResult } from '@hyveon/desktop-main/dist/services/PulumiService.js';
import { test, expect } from './index.js';
import { makeFakeIacCtx, waitForIacMessage } from './support/iac-ctx.js';

/**
 * Verifies the `orchestrator-integration-coverage` delta spec's "Plan
 * integration coverage" requirement — `IacController.plan`, dispatched
 * through the real controller wiring, streams the DI-substituted
 * `PulumiServiceStub`'s scripted `preview()` run to completion and reports
 * its terminal result on the `iac.plan.end` side channel, including a
 * failed preview's "no planHash" case.
 */
test.describe('IacController.plan — preview integration coverage', () => {
  test('should complete with a success outcome whose plan artifact exists and whose planHash covers it', async ({
    ipc,
    serverMocks: _reset,
  }) => {
    // The stub itself never touches the filesystem — this spec writes a real
    // plan-artifact file and scripts the result to point at it, standing in
    // for "the plan artifact is written by the stub" against an in-memory
    // stub that has no filesystem-writing surface of its own.
    const dir = mkdtempSync(join(tmpdir(), 'iac-plan-spec-'));
    const artifactPath = join(dir, 'plan-artifact.json');
    writeFileSync(artifactPath, JSON.stringify({ resources: [] }));

    const result: PulumiPreviewResult = {
      runId: 'plan-run-success',
      artifactPath,
      changeSummary: { create: 2, same: 5 },
      planHash: 'sha256-covers-artifact-and-config-version',
      engineVersion: '3.255.0',
    };
    ipc.mocks.pulumi.scriptPreview({ result });

    const fakeCtx = makeFakeIacCtx();
    const ack = await ipc.dispatch(IacController, 'plan', {}, fakeCtx.ctx);
    expect(ack.started).toBe(true);

    const end = await waitForIacMessage(fakeCtx, 'iac.plan.end');
    const message = end.message as { runId: string; exitCode: number | null; result?: PulumiPreviewResult };

    expect(message.exitCode).toBe(0);
    expect(message.result?.planHash).toBe(result.planHash);
    expect(message.result?.artifactPath).toBe(artifactPath);
    expect(existsSync(message.result!.artifactPath)).toBe(true);
  });

  test('should return a change summary matching the scripted create/update/replace/delete counts', async ({
    ipc,
    serverMocks: _reset,
  }) => {
    const changeSummary = { create: 3, update: 1, replace: 1, delete: 2, same: 10 };
    const result: PulumiPreviewResult = {
      runId: 'plan-run-summary',
      artifactPath: `/tmp/${randomUUID()}.json`,
      changeSummary,
      planHash: 'sha256-summary-run',
      engineVersion: '3.255.0',
    };
    ipc.mocks.pulumi.scriptPreview({ result });

    const fakeCtx = makeFakeIacCtx();
    await ipc.dispatch(IacController, 'plan', {}, fakeCtx.ctx);

    const end = await waitForIacMessage(fakeCtx, 'iac.plan.end');
    const message = end.message as { result?: PulumiPreviewResult };

    expect(message.result?.changeSummary).toEqual(changeSummary);
  });

  test('should complete with a failed outcome and no planHash when the scripted preview fails', async ({
    ipc,
    serverMocks: _reset,
  }) => {
    ipc.mocks.pulumi.scriptPreview({ failure: new Error('stub-scripted preview failure') });

    const fakeCtx = makeFakeIacCtx();
    await ipc.dispatch(IacController, 'plan', {}, fakeCtx.ctx);

    const end = await waitForIacMessage(fakeCtx, 'iac.plan.end');
    const message = end.message as { exitCode: number | null; error?: string; result?: PulumiPreviewResult };

    expect(message.exitCode).toBeNull();
    expect(message.error).toBeDefined();
    expect(message.result).toBeUndefined();
  });
});
