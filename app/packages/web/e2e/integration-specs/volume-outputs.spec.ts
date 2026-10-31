import { ConfigService } from '@hyveon/desktop-main/dist/services/ConfigService.js';
import { test, expect, DEFAULT_STACK_OUTPUTS } from './index.js';

/**
 * Verifies that the per-volume EFS access point map (`efsVolumeAccessPoints`) the infra program exports reaches the
 * main process intact: scripted into the `PulumiService` stub and read back through the real `ConfigService`.
 */
test.describe('ConfigService — efsVolumeAccessPoints stack output', () => {
  test('should project efsVolumeAccessPoints from the scripted stack outputs', async ({ ipc, serverMocks: _reset }) => {
    const efsVolumeAccessPoints = { minecraft: { data: 'fsap-mc1234', mods: 'fsap-mods' } };
    ipc.mocks.pulumi.scriptStackOutputs({ ...DEFAULT_STACK_OUTPUTS, efsVolumeAccessPoints });

    const outputs = await ipc.get(ConfigService).getStackOutputs();

    expect(outputs?.efsVolumeAccessPoints).toEqual(efsVolumeAccessPoints);
  });
});
