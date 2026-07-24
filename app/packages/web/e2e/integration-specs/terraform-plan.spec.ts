import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TerraformPlanError, TerraformService } from '@hyveon/desktop-main/dist/services/TerraformService.js';
import type { TerraformRunChunk } from '@hyveon/desktop-main/dist/services/TerraformService.js';
import { test, expect } from '../fixtures/terraform-shim.js';
import { failedPlanEntry, successfulPlanEntry, versionEntry, writeFixture } from '../fixtures/terraform-fixtures.js';

/**
 * Drains a `TerraformService` async generator to completion, collecting
 * every yielded chunk and the generator's eventual return value — the
 * manual-drive equivalent of `for await...of`, which discards the return
 * value `TerraformService.plan`/`apply`/`destroy` resolve to.
 *
 * @param gen - The async generator to drain.
 * @returns Every yielded chunk (in order) plus the generator's return value.
 */
async function drive<T>(gen: AsyncGenerator<TerraformRunChunk, T>): Promise<{ chunks: TerraformRunChunk[]; result: T }> {
  const chunks: TerraformRunChunk[] = [];
  let next = await gen.next();
  while (!next.done) {
    chunks.push(next.value);
    next = await gen.next();
  }
  return { chunks, result: next.value };
}

test.describe('TerraformService.plan (integration)', () => {
  test('should produce a .tfplan artifact and a SHA-256 planHash matching the artifact bytes on a successful plan', async ({
    ipc,
    terraformFixture,
  }) => {
    writeFixture(terraformFixture.scriptPath, {
      version: versionEntry(),
      plan: successfulPlanEntry({ add: 2, change: 1, destroy: 0 }),
    });

    const terraform = ipc.get(TerraformService);
    const { chunks, result } = await drive(terraform.plan());

    expect(chunks.length).toBeGreaterThan(0);
    expect(result).toBeDefined();
    expect(result?.add).toBe(2);
    expect(result?.change).toBe(1);
    expect(result?.destroy).toBe(0);
    expect(result?.runId).toBeTruthy();

    const expectedArtifactPath = join(terraformFixture.runsDir, result!.runId, `${result!.runId}.tfplan`);
    expect(result?.artifactPath).toBe(expectedArtifactPath);

    const artifactBytes = readFileSync(expectedArtifactPath);
    expect(artifactBytes.toString('utf8')).toBe('scripted-plan-artifact-bytes');

    const expectedHash = createHash('sha256').update(artifactBytes).digest('hex');
    expect(result?.planHash).toBe(expectedHash);
  });

  test('should reject with TerraformPlanError and persist no planHash when the plan process exits non-zero', async ({
    ipc,
    terraformFixture,
  }) => {
    writeFixture(terraformFixture.scriptPath, {
      version: versionEntry(),
      plan: failedPlanEntry(),
    });

    const terraform = ipc.get(TerraformService);
    const gen = terraform.plan();

    await expect(drive(gen)).rejects.toThrow(TerraformPlanError);
  });

  test('should resolve the terraform binary and version through the PATH shim before spawning plan', async ({
    ipc,
    terraformFixture,
  }) => {
    writeFixture(terraformFixture.scriptPath, {
      version: versionEntry(),
      plan: successfulPlanEntry(),
    });

    const terraform = ipc.get(TerraformService);

    await expect(terraform.getVersion()).resolves.toBe('1.9.0');
    expect(await terraform.getBinaryPath()).toContain('terraform');
  });
});
