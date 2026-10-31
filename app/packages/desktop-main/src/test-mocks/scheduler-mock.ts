import { mockClient, type AwsClientStub } from 'aws-sdk-client-mock';
import { SchedulerClient, CreateScheduleCommand, DeleteScheduleCommand } from '@aws-sdk/client-scheduler';

/**
 * Installs `aws-sdk-client-mock` interceptors on the `SchedulerClient` prototype so the helper's auto-stop schedule
 * calls succeed without reaching AWS.
 *
 * @returns the `aws-sdk-client-mock` stub.
 */
export function installSchedulerMock(): AwsClientStub<SchedulerClient> {
  const schedulerMock = mockClient(SchedulerClient);
  schedulerMock.on(CreateScheduleCommand).resolves({});
  schedulerMock.on(DeleteScheduleCommand).resolves({});
  return schedulerMock;
}
