import { HelperSessionRegistry } from '@hyveon/desktop-main/dist/services/volumeFiles/HelperSessionRegistry.js';
import { PublicIpService } from '@hyveon/desktop-main/dist/services/PublicIpService.js';
import { test, expect, DEFAULT_STACK_OUTPUTS, type IpcHarness, type ServerMocks } from './index.js';

/** ARN `RunTask` returns for the helper, and the task every later `ListTasks`/`DescribeTasks` reports. */
const HELPER_TASK_ARN = 'arn:aws:ecs:us-east-1:123456789012:task/test-cluster/helper-task-id';
/** ENI the running helper task is attached to; its lookup reports no public association. */
const HELPER_ENI_ID = 'eni-helper1234';
/** Polls of the helper's readiness loop the queued ECS/EC2 responses cover; later polls fall back to "task not listed". */
const SCRIPTED_POLLS = 200;

/**
 * Scripts the deployed stack and the operator-IP detection a helper launch needs. The credential secret is left unset
 * so the launch never reaches Secrets Manager.
 */
function scriptDeployedStack(ipc: IpcHarness): void {
  ipc.mocks.pulumi.scriptStackOutputs({ ...DEFAULT_STACK_OUTPUTS, fileBrowserCredentialSecretArn: '' });
  ipc.get(PublicIpService).detect = async () => '203.0.113.7';
}

/**
 * Queues what a launch that reaches readiness sees: no helper at the orphan check and the launch guard, then the
 * launched task RUNNING with an ENI whose public-IP lookup comes back empty on every poll.
 */
async function scriptHelperWithoutPublicIp(serverMocks: ServerMocks): Promise<void> {
  await serverMocks.pushRunTask({ type: 'success', data: { tasks: [{ taskArn: HELPER_TASK_ARN }], failures: [] } });
  for (let i = 0; i < 2; i++) await serverMocks.pushListTasks({ type: 'success', data: { taskArns: [] } });
  for (let i = 0; i < SCRIPTED_POLLS; i++) {
    await serverMocks.pushListTasks({ type: 'success', data: { taskArns: [HELPER_TASK_ARN] } });
    await serverMocks.pushDescribeTasks({
      type: 'success',
      data: {
        tasks: [
          {
            taskArn: HELPER_TASK_ARN,
            lastStatus: 'RUNNING',
            attachments: [
              {
                type: 'ElasticNetworkInterface',
                details: [{ name: 'networkInterfaceId', value: HELPER_ENI_ID }],
              },
            ],
          },
        ],
      },
    });
    await serverMocks.pushDescribeNetworkInterfaces({
      type: 'success',
      data: { NetworkInterfaces: [{ NetworkInterfaceId: HELPER_ENI_ID }] },
    });
  }
}

test.describe('HelperSessionRegistry — file manager helper sessions', () => {
  // @spec HELPER-FB-021
  test('should report starting while the helper has no public IP', async ({ ipc, serverMocks }) => {
    scriptDeployedStack(ipc);
    await scriptHelperWithoutPublicIp(serverMocks);
    const registry = ipc.get(HelperSessionRegistry);
    Object.assign(registry.timings, { pollMs: 10, helperIpTimeoutMs: 30000, loginTimeoutMs: 30000 });

    // Resolves only once the helper is reachable, which never happens here; settled by the stop below.
    const acquiring = registry.acquire('minecraft', 'browse');
    try {
      await expect.poll(async () => (await registry.status('minecraft')).state).toBe('starting');
      await new Promise((resolve) => setTimeout(resolve, 100));

      const snapshot = await registry.status('minecraft');
      expect(snapshot.state).toBe('starting');
      expect(snapshot.browseHeld).toBe(true);
    } finally {
      await registry.stop('minecraft');
    }

    expect(await acquiring).toMatchObject({ ok: false, code: 'failed' });
    expect(registry.ownedGames().has('minecraft')).toBe(false);
  });

  // @spec HELPER-FB-019
  test('should report orphaned for an unowned helper', async ({ ipc, serverMocks }) => {
    scriptDeployedStack(ipc);
    await serverMocks.pushListTasks({ type: 'success', data: { taskArns: [HELPER_TASK_ARN] } });
    await serverMocks.pushDescribeTasks({
      type: 'success',
      data: { tasks: [{ taskArn: HELPER_TASK_ARN, lastStatus: 'RUNNING' }] },
    });

    const snapshot = await ipc.get(HelperSessionRegistry).status('minecraft');

    expect(snapshot.state).toBe('orphaned');
    expect(snapshot.browseHeld).toBe(false);
  });
});
