import { TerraformController } from '@hyveon/desktop-main/dist/controllers/terraform.controller.js';
import { test, expect } from '../fixtures/terraform-shim.js';
import { successfulOutputEntry, versionEntry, writeFixture } from '../fixtures/terraform-fixtures.js';

test.describe('TerraformController.output (integration)', () => {
  test('should return the parsed outputs from the scripted terraform output -json response', async ({
    ipc,
    terraformFixture,
  }) => {
    writeFixture(terraformFixture.scriptPath, {
      version: versionEntry(),
      output: successfulOutputEntry({
        ecs_cluster_name: { value: 'scripted-cluster' },
        game_names: { value: ['minecraft', 'valheim'] },
        domain_name: { value: 'scripted.example.com' },
      }),
    });

    const outputs = await ipc.dispatch(TerraformController, 'output', {});

    expect(outputs).toMatchObject({
      ecs_cluster_name: 'scripted-cluster',
      game_names: ['minecraft', 'valheim'],
      domain_name: 'scripted.example.com',
    });
  });
});
