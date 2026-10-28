import { mockClient, type AwsClientStub } from 'aws-sdk-client-mock';
import {
  ECSClient,
  ListTasksCommand,
  DescribeTasksCommand,
  RunTaskCommand,
  StopTaskCommand,
  DescribeTaskDefinitionCommand,
  RegisterTaskDefinitionCommand,
  DeregisterTaskDefinitionCommand,
  TagResourceCommand,
} from '@aws-sdk/client-ecs';
import { mockStore } from './mock-store.js';

/** Execution role `DescribeTaskDefinition` reports for every game's task definition. */
const MOCK_EXECUTION_ROLE_ARN = 'arn:aws:iam::123456789012:role/test-execution';
/** ARN `RegisterTaskDefinition` reports for the helper's throwaway task definition. */
const MOCK_HELPER_TASK_DEFINITION_ARN = 'arn:aws:ecs:us-east-1:123456789012:task-definition/filebrowser-test:1';

/**
 * Installs `aws-sdk-client-mock` interceptors on the `ECSClient` prototype,
 * wired to the shared {@link mockStore} FIFO queues (`ListTasks`,
 * `DescribeTasks`, `RunTask`, `StopTask`). The task-definition and tagging
 * commands the file-manager helper launch issues (`DescribeTaskDefinition`,
 * `RegisterTaskDefinition`, `DeregisterTaskDefinition`, `TagResource`) have
 * fixed success responses and no queue.
 *
 * Extracted so the in-process IPC test harness (`e2e/fixtures/ipc-harness.ts`)
 * can patch `ECSClient` without duplicating the four command handlers.
 *
 * `EcsService` creates its `ECSClient` lazily (on first request), so patching
 * the *prototype* is sufficient — this only needs to run once, before the
 * first `send()` call anywhere in the process, regardless of when the DI
 * container instantiates `EcsService`.
 *
 * @returns the `aws-sdk-client-mock` stub. Callers rarely need it directly
 * since all queued state routes through {@link mockStore}, but it's returned
 * so callers can `.reset()` the interceptor itself if ever needed.
 */
export function installEcsMock(): AwsClientStub<ECSClient> {
  const ecsMock = mockClient(ECSClient);

  ecsMock.on(ListTasksCommand).callsFake(async () => {
    const next = mockStore.dequeueListTasks();
    if (next?.type === 'error') {
      throw Object.assign(new Error(next.message ?? 'Mock ListTasks error'), {
        name: next.code ?? 'ServiceException',
      });
    }
    return (next?.data as object | undefined) ?? { taskArns: [] };
  });

  ecsMock.on(DescribeTasksCommand).callsFake(async () => {
    const next = mockStore.dequeueDescribeTasks();
    if (next?.type === 'error') {
      throw Object.assign(new Error(next.message ?? 'Mock DescribeTasks error'), {
        name: next.code ?? 'ServiceException',
      });
    }
    return (next?.data as object | undefined) ?? { tasks: [] };
  });

  ecsMock.on(RunTaskCommand).callsFake(async () => {
    const next = mockStore.dequeueRunTask();
    if (next?.type === 'error') {
      throw Object.assign(new Error(next.message ?? 'Mock RunTask error'), {
        name: next.code ?? 'ServiceException',
      });
    }
    return (
      (next?.data as object | undefined) ?? {
        tasks: [{ taskArn: 'arn:aws:ecs:us-east-1:123456789012:task/test-cluster/test-task-id' }],
        failures: [],
      }
    );
  });

  ecsMock.on(StopTaskCommand).callsFake(async () => {
    const next = mockStore.dequeueStopTask();
    if (next?.type === 'error') {
      throw Object.assign(new Error(next.message ?? 'Mock StopTask error'), {
        name: next.code ?? 'ServiceException',
      });
    }
    return (next?.data as object | undefined) ?? {};
  });

  ecsMock.on(DescribeTaskDefinitionCommand).resolves({
    taskDefinition: { cpu: '1024', memory: '2048', executionRoleArn: MOCK_EXECUTION_ROLE_ARN },
  });
  ecsMock.on(RegisterTaskDefinitionCommand).resolves({ taskDefinition: { taskDefinitionArn: MOCK_HELPER_TASK_DEFINITION_ARN } });
  ecsMock.on(DeregisterTaskDefinitionCommand).resolves({});
  ecsMock.on(TagResourceCommand).resolves({});

  return ecsMock;
}
