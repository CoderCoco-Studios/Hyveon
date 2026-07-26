import 'reflect-metadata';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { IAMClient, SimulatePrincipalPolicyCommand } from '@aws-sdk/client-iam';
import { IamCheckService } from './IamCheckService.js';
import type { ElectronStoreService } from './ElectronStoreService.js';

/** Typed stand-in for the AWS STS SDK client, shared across the tests below. */
const stsMock = mockClient(STSClient);

/** Typed stand-in for the AWS IAM SDK client, shared across the tests below. */
const iamMock = mockClient(IAMClient);

/** Build an `ElectronStoreService` stub whose `get('aws')` resolves to the given choice. */
function makeStore(
  aws: { profile?: string; region?: string } | undefined,
  pastedCredentials?: { accessKeyId: string; secretAccessKey: string; region?: string },
): ElectronStoreService {
  return {
    get: vi.fn().mockImplementation((key: string) => (key === 'aws' ? aws : undefined)),
    getPastedCredentials: vi.fn().mockReturnValue(pastedCredentials),
  } as Partial<ElectronStoreService> as ElectronStoreService;
}

/** Subclass exposing a fixed, arbitrary-length action list, so batching can be tested independent of the real policy's size. */
class TestableIamCheckService extends IamCheckService {
  constructor(
    store: ElectronStoreService,
    private readonly actions: string[],
  ) {
    super(store);
  }
  protected override actionsToCheck(): readonly string[] {
    return this.actions;
  }
}

beforeEach(() => {
  stsMock.reset();
  iamMock.reset();
});

describe('IamCheckService', () => {
  describe('checkPermissions', () => {
    it('should return passed when every simulated action is allowed', async () => {
      stsMock.on(GetCallerIdentityCommand).resolves({ Arn: 'arn:aws:iam::123456789012:user/hyveon' });
      iamMock.on(SimulatePrincipalPolicyCommand).resolves({
        EvaluationResults: [
          { EvalActionName: 'ecs:*', EvalDecision: 'allowed' },
          { EvalActionName: 's3:*', EvalDecision: 'allowed' },
        ],
      });
      const service = new IamCheckService(makeStore({ region: 'us-west-2' }));

      const result = await service.checkPermissions();

      expect(result).toEqual({ status: 'passed' });
    });

    it('should return missing with a minimal pasteable policy JSON when some actions are denied', async () => {
      stsMock.on(GetCallerIdentityCommand).resolves({ Arn: 'arn:aws:iam::123456789012:user/hyveon' });
      iamMock.on(SimulatePrincipalPolicyCommand).resolves({
        EvaluationResults: [
          { EvalActionName: 'ecs:*', EvalDecision: 'allowed' },
          { EvalActionName: 's3:*', EvalDecision: 'explicitDeny' },
          { EvalActionName: 'iam:*', EvalDecision: 'implicitDeny' },
        ],
      });
      const service = new IamCheckService(makeStore({ region: 'us-west-2' }));

      const result = await service.checkPermissions();

      expect(result.status).toBe('missing');
      const policy = JSON.parse(result.policyJson!);
      expect(policy).toEqual({
        Version: '2012-10-17',
        Statement: [{ Effect: 'Allow', Action: ['s3:*', 'iam:*'], Resource: '*' }],
      });
    });

    it('should batch SimulatePrincipalPolicy calls at 50 actions per request', async () => {
      stsMock.on(GetCallerIdentityCommand).resolves({ Arn: 'arn:aws:iam::123456789012:user/hyveon' });
      iamMock.on(SimulatePrincipalPolicyCommand).resolves({ EvaluationResults: [] });
      const actions = Array.from({ length: 120 }, (_, i) => `service${i}:Action`);
      const service = new TestableIamCheckService(makeStore({ region: 'us-west-2' }), actions);

      await service.checkPermissions();

      const calls = iamMock.commandCalls(SimulatePrincipalPolicyCommand);
      expect(calls).toHaveLength(3);
      expect(calls[0]!.args[0].input.ActionNames).toHaveLength(50);
      expect(calls[1]!.args[0].input.ActionNames).toHaveLength(50);
      expect(calls[2]!.args[0].input.ActionNames).toHaveLength(20);
    });

    it('should pass the caller ARN from GetCallerIdentity as the PolicySourceArn', async () => {
      stsMock.on(GetCallerIdentityCommand).resolves({ Arn: 'arn:aws:iam::123456789012:role/hyveon-role' });
      iamMock.on(SimulatePrincipalPolicyCommand).resolves({ EvaluationResults: [] });
      const service = new IamCheckService(makeStore({ region: 'us-west-2' }));

      await service.checkPermissions();

      expect(iamMock.commandCalls(SimulatePrincipalPolicyCommand)[0]!.args[0].input.PolicySourceArn).toBe(
        'arn:aws:iam::123456789012:role/hyveon-role',
      );
    });

    it('should normalize an STS assumed-role session ARN to the underlying IAM role ARN', async () => {
      stsMock.on(GetCallerIdentityCommand).resolves({
        Arn: 'arn:aws:sts::123456789012:assumed-role/hyveon-role/hyveon-session',
      });
      iamMock.on(SimulatePrincipalPolicyCommand).resolves({ EvaluationResults: [] });
      const service = new IamCheckService(makeStore({ region: 'us-west-2' }));

      await service.checkPermissions();

      expect(iamMock.commandCalls(SimulatePrincipalPolicyCommand)[0]!.args[0].input.PolicySourceArn).toBe(
        'arn:aws:iam::123456789012:role/hyveon-role',
      );
    });

    it('should degrade to a warning when GetCallerIdentity fails', async () => {
      stsMock.on(GetCallerIdentityCommand).rejects(new Error('access denied'));
      const service = new IamCheckService(makeStore({ region: 'us-west-2' }));

      const result = await service.checkPermissions();

      expect(result).toEqual({ status: 'warning', message: 'access denied' });
      expect(iamMock.commandCalls(SimulatePrincipalPolicyCommand)).toHaveLength(0);
    });

    it('should degrade to a warning when SimulatePrincipalPolicy itself is not permitted', async () => {
      stsMock.on(GetCallerIdentityCommand).resolves({ Arn: 'arn:aws:iam::123456789012:user/hyveon' });
      iamMock.on(SimulatePrincipalPolicyCommand).rejects(new Error('User is not authorized to perform iam:SimulatePrincipalPolicy'));
      const service = new IamCheckService(makeStore({ region: 'us-west-2' }));

      const result = await service.checkPermissions();

      expect(result.status).toBe('warning');
      expect(result.message).toMatch(/not authorized/i);
    });

    it('should degrade to a warning when no region is configured, rather than throwing', async () => {
      const service = new IamCheckService(makeStore(undefined));

      const result = await service.checkPermissions();

      expect(result.status).toBe('warning');
      expect(result.message).toMatch(/no region is configured/i);
    });

    it('should build the STS/IAM clients with static credentials when the profile resolves to pasted credentials', async () => {
      stsMock.on(GetCallerIdentityCommand).resolves({ Arn: 'arn:aws:iam::123456789012:user/hyveon' });
      iamMock.on(SimulatePrincipalPolicyCommand).resolves({ EvaluationResults: [] });
      const store = makeStore({ profile: 'gsd-pasted', region: 'us-west-2' }, {
        accessKeyId: 'AKID',
        secretAccessKey: 'SECRET',
      });
      const service = new IamCheckService(store);

      const result = await service.checkPermissions();

      expect(result).toEqual({ status: 'passed' });
      expect(store.getPastedCredentials).toHaveBeenCalledWith('gsd-pasted');
    });
  });
});
