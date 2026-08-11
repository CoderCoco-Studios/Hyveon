import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IacController } from '@hyveon/desktop-main/dist/controllers/iac.controller.js';
import { IacRunsController } from '@hyveon/desktop-main/dist/controllers/iac-runs.controller.js';
import type { PulumiPreviewResult, PulumiRunChunk } from '@hyveon/desktop-main/dist/services/PulumiService.js';
import { RunRecordService, type PersistRunRecordParams } from '@hyveon/desktop-main/dist/services/RunRecordService.js';
import { test, expect, DEFAULT_STACK_OUTPUTS } from './index.js';
import { makeFakeIacCtx, waitForIacMessage } from './support/iac-ctx.js';

/** ANSI-coloured lines used to prove escape sequences survive verbatim, on both streams. */
const STDOUT_ANSI_LINE = '[32mresource created successfully[0m';
const STDERR_ANSI_LINE = '[31mwarning: deprecated provider option[0m';

/**
 * Verifies the `orchestrator-integration-coverage` delta spec's "Streamed
 * run chunks preserve ANSI escape sequences" requirement — both halves of
 * it: the `iac.plan.chunk` side channel forwards the `PulumiServiceStub`'s
 * scripted stdout/stderr lines byte-for-byte with correct stream
 * attribution, and a persisted run log (driven directly through
 * `RunRecordService.persist`, per this suite's "Run records persisted"
 * sibling file — `PulumiService.apply`/`.preview`'s own log-capture/persist
 * path is unreachable through the fully-stubbed `PulumiService`) embeds the
 * same escape sequences unmodified.
 */
test.describe('Streamed run output — ANSI escape sequence preservation', () => {
  test('should preserve ANSI escape sequences byte-for-byte, with correct stream attribution, in both the live stream and the persisted run log', async ({
    ipc,
    serverMocks: _reset,
  }) => {
    // Scripted before the plan run below: `ConfigService.getStackOutputs()`
    // caches its first result, so `runsTableName` must be in place before
    // that first call (triggered by `plan()`'s own audit/config reads) or
    // the later `RunRecordService.persist` call would see a stale cached
    // `null` and skip persistence.
    ipc.mocks.pulumi.scriptStackOutputs(DEFAULT_STACK_OUTPUTS);

    const chunks: PulumiRunChunk[] = [
      { stream: 'stdout', line: STDOUT_ANSI_LINE },
      { stream: 'stderr', line: STDERR_ANSI_LINE },
    ];
    const result: PulumiPreviewResult = {
      runId: 'ansi-plan-run',
      artifactPath: `/tmp/${randomUUID()}.json`,
      changeSummary: { create: 1 },
      planHash: 'sha256-ansi-run',
      engineVersion: '3.255.0',
    };
    ipc.mocks.pulumi.scriptPreview({ chunks, result });

    const fakeCtx = makeFakeIacCtx();
    await ipc.dispatch(IacController, 'plan', {}, fakeCtx.ctx);
    await waitForIacMessage(fakeCtx, 'iac.plan.end');

    const chunkMessages = fakeCtx.sentMessages.filter((m) => m.channel === 'iac.plan.chunk');
    const streamedChunks = chunkMessages.map((m) => (m.message as { chunk: PulumiRunChunk }).chunk);
    expect(streamedChunks).toEqual(chunks);
    expect(streamedChunks.find((c) => c.stream === 'stdout')?.line).toBe(STDOUT_ANSI_LINE);
    expect(streamedChunks.find((c) => c.stream === 'stderr')?.line).toBe(STDERR_ANSI_LINE);

    // Second half: a persisted run log with the same ANSI content, embedded
    // unmodified — exercised directly against `RunRecordService`, since
    // `PulumiService.preview`'s own log-capture/persist path lives inside the
    // fully-stubbed `PulumiService` (see this file's own TSDoc).
    const dir = mkdtempSync(join(tmpdir(), 'iac-ansi-log-'));
    const logFilePath = join(dir, 'run.log');
    const logContent = `${STDOUT_ANSI_LINE}\n${STDERR_ANSI_LINE}\n`;
    writeFileSync(logFilePath, logContent, 'utf8');

    const runId = randomUUID();
    const params: PersistRunRecordParams = {
      runId,
      kind: 'plan',
      startedAt: new Date(0).toISOString(),
      completedAt: new Date(1000).toISOString(),
      exitCode: 0,
      planHash: result.planHash,
      changeSummary: result.changeSummary,
    };
    await ipc.get(RunRecordService).persist(params, logFilePath);

    const page = await ipc.dispatch(IacRunsController, 'list', { limit: 50 });
    const record = page.records.find((r) => r.runId === runId);
    expect(record?.logInline).toBe(logContent);
  });
});
