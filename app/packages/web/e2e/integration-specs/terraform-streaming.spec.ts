import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TerraformService } from '@hyveon/desktop-main/dist/services/TerraformService.js';
import type { TerraformRunChunk } from '@hyveon/desktop-main/dist/services/TerraformService.js';
import { test, expect } from '../fixtures/terraform-shim.js';
import { ANSI_RED, ANSI_RESET, ansiPlanEntry, versionEntry, writeFixture } from '../fixtures/terraform-fixtures.js';

/** Drains a `TerraformService` async generator, collecting every yielded chunk and the eventual return value. */
async function drive<T>(gen: AsyncGenerator<TerraformRunChunk, T>): Promise<{ chunks: TerraformRunChunk[]; result: T }> {
  const chunks: TerraformRunChunk[] = [];
  let next = await gen.next();
  while (!next.done) {
    chunks.push(next.value);
    next = await gen.next();
  }
  return { chunks, result: next.value };
}

test.describe('TerraformService streaming (integration)', () => {
  test('should preserve ANSI escape sequences and stream attribution byte-for-byte in chunks and terraform.log', async ({
    ipc,
    terraformFixture,
  }) => {
    writeFixture(terraformFixture.scriptPath, {
      version: versionEntry(),
      plan: ansiPlanEntry(),
    });

    const terraform = ipc.get(TerraformService);
    const { chunks, result } = await drive(terraform.plan());

    expect(result).toBeDefined();
    // Stdout and stderr are two independent OS pipes, so their *relative*
    // arrival order isn't guaranteed even though fake-terraform.mjs writes
    // them in a fixed sequence — assert set membership (every scripted chunk
    // arrived, byte-for-byte, with correct stream attribution) rather than a
    // single total order across streams. Within a single stream, order is
    // still guaranteed (a single pipe delivers in write order), matching the
    // "stdout/stderr attribution preserved" requirement.
    expect(chunks).toHaveLength(3);
    expect(chunks).toContainEqual({ stream: 'stdout', line: `${ANSI_RED}Refreshing state...${ANSI_RESET}` });
    expect(chunks).toContainEqual({ stream: 'stderr', line: `${ANSI_RED}Warning: deprecated argument${ANSI_RESET}` });
    expect(chunks).toContainEqual({ stream: 'stdout', line: 'Plan: 1 to add, 0 to change, 0 to destroy.' });

    const stdoutChunks = chunks.filter((c) => c.stream === 'stdout');
    expect(stdoutChunks.map((c) => c.line)).toEqual([
      `${ANSI_RED}Refreshing state...${ANSI_RESET}`,
      'Plan: 1 to add, 0 to change, 0 to destroy.',
    ]);

    const logPath = join(terraformFixture.runsDir, result!.runId, 'terraform.log');
    const logContents = readFileSync(logPath, 'utf8');
    expect(logContents).toBe(`${chunks.map((c) => c.line).join('\n')}\n`);
    expect(logContents).toContain(`${ANSI_RED}Refreshing state...${ANSI_RESET}`);
    expect(logContents).toContain(`${ANSI_RED}Warning: deprecated argument${ANSI_RESET}`);
  });
});
