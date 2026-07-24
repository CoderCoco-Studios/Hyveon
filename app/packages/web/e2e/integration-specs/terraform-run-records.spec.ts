import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TerraformPlanError, TerraformService } from '@hyveon/desktop-main/dist/services/TerraformService.js';
import type { TerraformRunChunk } from '@hyveon/desktop-main/dist/services/TerraformService.js';
import { TerraformRunsController } from '@hyveon/desktop-main/dist/controllers/terraform-runs.controller.js';
import { runRecordMockStore } from '@hyveon/desktop-main/dist/test-mocks/run-record-mock.js';
import { test, expect } from '../fixtures/terraform-shim.js';
import { failedPlanEntry, successfulPlanEntry, versionEntry, writeFixture } from '../fixtures/terraform-fixtures.js';

/** Drains a `TerraformService` async generator to completion. */
async function drive<T>(gen: AsyncGenerator<TerraformRunChunk, T>): Promise<T> {
  let next = await gen.next();
  while (!next.done) {
    next = await gen.next();
  }
  return next.value;
}

test.describe('Terraform run-record persistence (integration)', () => {
  test('should write run.json with kind, exitCode, and planHash for a successful plan run', async ({
    ipc,
    terraformFixture,
    serverMocks: _serverMocks,
  }) => {
    writeFixture(terraformFixture.scriptPath, {
      version: versionEntry(),
      plan: successfulPlanEntry(),
    });

    const terraform = ipc.get(TerraformService);
    const result = await drive(terraform.plan());
    expect(result).toBeDefined();

    const recordPath = join(terraformFixture.runsDir, result!.runId, 'run.json');
    const record = JSON.parse(readFileSync(recordPath, 'utf8'));

    expect(record.kind).toBe('plan');
    expect(record.exitCode).toBe(0);
    expect(record.runId).toBe(result!.runId);
    expect(record.planHash).toBe(result!.planHash);
  });

  test('should still persist run.json with a non-zero exitCode and no planHash for a failed run', async ({
    ipc,
    terraformFixture,
    serverMocks: _serverMocks,
  }) => {
    writeFixture(terraformFixture.scriptPath, {
      version: versionEntry(),
      plan: failedPlanEntry(),
    });

    const terraform = ipc.get(TerraformService);
    const gen = terraform.plan();
    await expect(drive(gen)).rejects.toThrow(TerraformPlanError);

    // The failed run's runId was never returned (plan() threw), so recover it
    // the same way an operator would: the sole entry under runsDir.
    const runIds = readdirSync(terraformFixture.runsDir);
    expect(runIds).toHaveLength(1);
    const runId = runIds[0]!;

    const record = terraform.readRunRecord(runId);
    expect(record?.kind).toBe('plan');
    expect(record?.exitCode).not.toBe(0);
    expect(record?.exitCode).not.toBeNull();
    expect(record?.planHash).toBeUndefined();
  });

  test('should persist an inline log on the RunRecordStore record and expose the run via the runs IPC surface', async ({
    ipc,
    terraformFixture,
    serverMocks: _serverMocks,
  }) => {
    writeFixture(terraformFixture.scriptPath, {
      version: versionEntry(),
      plan: successfulPlanEntry(),
    });

    const terraform = ipc.get(TerraformService);
    const result = await drive(terraform.plan());
    expect(result).toBeDefined();

    const logPath = join(terraformFixture.runsDir, result!.runId, 'terraform.log');
    const logContents = readFileSync(logPath, 'utf8');

    const storeRecord = runRecordMockStore.findByRunId(result!.runId);
    expect(storeRecord).toBeDefined();
    expect(storeRecord?.['logInline']).toBe(logContents);
    expect(storeRecord).not.toHaveProperty('logS3Key');

    const detail = await ipc.dispatch(TerraformRunsController, 'get', { runId: result!.runId });
    expect(detail).toMatchObject({ found: true, status: 'awaiting_approval' });
    if (detail.found) {
      expect(detail.record?.runId).toBe(result!.runId);
      expect(detail.record?.planHash).toBe(result!.planHash);
    }
  });
});
