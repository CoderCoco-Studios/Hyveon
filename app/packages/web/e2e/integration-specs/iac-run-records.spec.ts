import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IacRunsController } from '@hyveon/desktop-main/dist/controllers/iac-runs.controller.js';
import { RunRecordService, type PersistRunRecordParams } from '@hyveon/desktop-main/dist/services/RunRecordService.js';
import { test, expect, DEFAULT_STACK_OUTPUTS } from './index.js';

/** Writes `content` to a fresh temp file and returns its path — shared by every scenario below that needs a real `logFilePath`. */
function writeTempLog(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'iac-run-records-'));
  const logFilePath = join(dir, 'run.log');
  writeFileSync(logFilePath, content, 'utf8');
  return logFilePath;
}

/**
 * Verifies the `orchestrator-integration-coverage` delta spec's "Run
 * records persisted for every run" requirement. `IacController.plan`/
 * `.apply`/`.destroy` never reach `RunRecordService.persist` themselves —
 * that call lives inside real `PulumiService`, which the DI-substituted
 * `PulumiServiceStub` fully replaces — so this suite exercises
 * `RunRecordService` directly (via `ipc.get(RunRecordService)`, mirroring
 * `pulumi-di-seam.spec.ts`'s `ipc.get(PulumiService)` pattern), backed by
 * the harness's mocked DynamoDB run-record store, then verifies retrieval
 * through the real `IacRunsController.list` IPC surface.
 */
test.describe('RunRecordService — run-record persistence and retrieval', () => {
  test('should persist a successful preview run record with a matching planHash', async ({ ipc, serverMocks: _reset }) => {
    ipc.mocks.pulumi.scriptStackOutputs(DEFAULT_STACK_OUTPUTS);
    const runId = randomUUID();
    const params: PersistRunRecordParams = {
      runId,
      kind: 'plan',
      startedAt: new Date(0).toISOString(),
      completedAt: new Date(1_000).toISOString(),
      exitCode: 0,
      planHash: 'sha256-successful-preview-hash',
      changeSummary: { create: 2, same: 3 },
    };

    await ipc.get(RunRecordService).persist(params, null);

    const record = await ipc.get(RunRecordService).getByRunId(runId);
    expect(record?.kind).toBe('plan');
    expect(record?.status).toBe('success');
    expect(record?.planHash).toBe('sha256-successful-preview-hash');
  });

  test('should persist a failed run record with no planHash', async ({ ipc, serverMocks: _reset }) => {
    ipc.mocks.pulumi.scriptStackOutputs(DEFAULT_STACK_OUTPUTS);
    const runId = randomUUID();
    const params: PersistRunRecordParams = {
      runId,
      kind: 'apply',
      startedAt: new Date(0).toISOString(),
      completedAt: new Date(1_000).toISOString(),
      exitCode: 1,
    };

    await ipc.get(RunRecordService).persist(params, null);

    const record = await ipc.get(RunRecordService).getByRunId(runId);
    expect(record?.status).toBe('failed');
    expect(record?.planHash).toBeUndefined();
  });

  test('should embed a captured log inline, matching the run log content, when under the 350KB limit', async ({
    ipc,
    serverMocks: _reset,
  }) => {
    ipc.mocks.pulumi.scriptStackOutputs(DEFAULT_STACK_OUTPUTS);
    const runId = randomUUID();
    const logContent = 'line one\nline two\nline three\n';
    const logFilePath = writeTempLog(logContent);
    const params: PersistRunRecordParams = {
      runId,
      kind: 'destroy',
      startedAt: new Date(0).toISOString(),
      completedAt: new Date(1_000).toISOString(),
      exitCode: 0,
    };

    await ipc.get(RunRecordService).persist(params, logFilePath);

    const record = await ipc.get(RunRecordService).getByRunId(runId);
    expect(record?.logInline).toBe(logContent);
    expect(record?.logS3Key).toBeUndefined();
  });

  test('should be retrievable through iac.runs.list via both a page-size limit and a status filter', async ({
    ipc,
    serverMocks: _reset,
  }) => {
    ipc.mocks.pulumi.scriptStackOutputs(DEFAULT_STACK_OUTPUTS);
    const runId = randomUUID();
    const params: PersistRunRecordParams = {
      runId,
      kind: 'plan',
      startedAt: new Date(0).toISOString(),
      completedAt: new Date(1_000).toISOString(),
      exitCode: 0,
      planHash: 'sha256-retrievable-run-hash',
    };
    await ipc.get(RunRecordService).persist(params, null);

    const paged = await ipc.dispatch(IacRunsController, 'list', { limit: 5 });
    expect(paged.records.some((r) => r.runId === runId)).toBe(true);

    const filtered = await ipc.dispatch(IacRunsController, 'list', { status: 'success' });
    expect(filtered.records.some((r) => r.runId === runId)).toBe(true);
    expect(filtered.records.every((r) => r.status === 'success')).toBe(true);
  });
});
