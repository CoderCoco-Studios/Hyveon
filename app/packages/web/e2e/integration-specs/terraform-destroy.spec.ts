import { DestroyNotConfirmedError, TerraformService } from '@hyveon/desktop-main/dist/services/TerraformService.js';
import type { TerraformRunChunk } from '@hyveon/desktop-main/dist/services/TerraformService.js';
import { test, expect } from '../fixtures/terraform-shim.js';
import { successfulDestroyEntry, versionEntry, writeFixture } from '../fixtures/terraform-fixtures.js';

/** Drains a `TerraformService` async generator, returning its eventual return value. */
async function drive<T>(gen: AsyncGenerator<TerraformRunChunk, T>): Promise<T> {
  let next = await gen.next();
  while (!next.done) {
    next = await gen.next();
  }
  return next.value;
}

test.describe('TerraformService.destroy (integration)', () => {
  test('should throw DestroyNotConfirmedError and never spawn terraform when no confirmation token was minted', async ({
    ipc,
    terraformFixture,
  }) => {
    writeFixture(terraformFixture.scriptPath, {
      version: versionEntry(),
      destroy: successfulDestroyEntry(),
    });

    const terraform = ipc.get(TerraformService);

    await expect(drive(terraform.destroy('some-random-token'))).rejects.toThrow(DestroyNotConfirmedError);
  });

  test('should reject reusing an already-consumed confirmation token', async ({ ipc, terraformFixture }) => {
    writeFixture(terraformFixture.scriptPath, {
      version: versionEntry(),
      destroy: successfulDestroyEntry({ destroyed: 2 }),
    });

    const terraform = ipc.get(TerraformService);
    const token = terraform.mintDestroyConfirmationToken();

    const firstResult = await drive(terraform.destroy(token));
    expect(firstResult?.destroyed).toBe(2);

    await expect(drive(terraform.destroy(token))).rejects.toThrow(DestroyNotConfirmedError);
  });

  test('should stream the scripted destroy to completion for a freshly minted token', async ({ ipc, terraformFixture }) => {
    writeFixture(terraformFixture.scriptPath, {
      version: versionEntry(),
      destroy: successfulDestroyEntry({ destroyed: 5 }),
    });

    const terraform = ipc.get(TerraformService);
    const token = terraform.mintDestroyConfirmationToken();

    const result = await drive(terraform.destroy(token));

    expect(result).toBeDefined();
    expect(result?.destroyed).toBe(5);
    expect(result?.runId).toBeTruthy();

    const record = terraform.readRunRecord(result!.runId);
    expect(record?.kind).toBe('destroy');
    expect(record?.exitCode).toBe(0);
  });
});
