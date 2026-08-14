import 'reflect-metadata';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { IAMClient, GetRoleCommand, CreateServiceLinkedRoleCommand } from '@aws-sdk/client-iam';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('fs', () => ({ writeFileSync: vi.fn() }));

import { writeFileSync } from 'fs';
import { CloudHealthService } from './CloudHealthService.js';
import type { ElectronStoreService } from './ElectronStoreService.js';
import type { ConfigService } from './ConfigService.js';
import type { DeploymentConfigService } from './DeploymentConfigService.js';

/** Widens {@link CloudHealthService}'s protected test seams to public so specs can spy on them without casts. */
class TestableCloudHealthService extends CloudHealthService {
  public override getPolicyDownloadPath(): string {
    return super.getPolicyDownloadPath();
  }

  public override readIsElectron(): boolean {
    return super.readIsElectron();
  }

  public override openExternalUrl(url: string): Promise<void> {
    return super.openExternalUrl(url);
  }
}

const iamMock = mockClient(IAMClient);
const stsMock = mockClient(STSClient);
const mockWrite = vi.mocked(writeFileSync);

function makeStore(): ElectronStoreService {
  return {
    get: vi.fn().mockImplementation((key: string) => (key === 'aws' ? { profile: 'default', region: 'us-east-1' } : undefined)),
    getPastedCredentials: vi.fn().mockReturnValue(undefined),
  } as Partial<ElectronStoreService> as ElectronStoreService;
}

function makeConfig(): ConfigService {
  return { getRegion: vi.fn().mockReturnValue('us-east-1') } as Partial<ConfigService> as ConfigService;
}

/** Builds a stub {@link DeploymentConfigService} whose `getTopLevelSettings()` resolves with the given project name. */
function makeDeploymentConfig(projectName = 'hyveon'): DeploymentConfigService {
  return {
    getTopLevelSettings: vi.fn().mockResolvedValue({ settings: { projectName } }),
  } as Partial<DeploymentConfigService> as DeploymentConfigService;
}

beforeEach(() => {
  iamMock.reset();
  stsMock.reset();
  mockWrite.mockReset();
});

describe('CloudHealthService.getChecks', () => {
  it('should include exactly one check with id "ecs-service-linked-role"', () => {
    const service = new CloudHealthService(makeStore(), makeConfig(), makeDeploymentConfig());

    const checks = service.getChecks();

    expect(checks).toHaveLength(1);
    expect(checks[0]!.id).toBe('ecs-service-linked-role');
  });
});

describe('ECS service-linked role check', () => {
  it('should report ok when the role exists', async () => {
    iamMock.on(GetRoleCommand).resolves({ Role: { RoleName: 'AWSServiceRoleForECS' } as never });
    const service = new CloudHealthService(makeStore(), makeConfig(), makeDeploymentConfig());

    const result = await service.getChecks()[0]!.check();

    expect(result).toEqual({ status: 'ok' });
  });

  it('should report missing when the role does not exist', async () => {
    const err = Object.assign(new Error('not found'), { name: 'NoSuchEntityException' });
    iamMock.on(GetRoleCommand).rejects(err);
    const service = new CloudHealthService(makeStore(), makeConfig(), makeDeploymentConfig());

    const result = await service.getChecks()[0]!.check();

    expect(result.status).toBe('missing');
  });

  it('should report error for an unexpected failure', async () => {
    iamMock.on(GetRoleCommand).rejects(new Error('boom'));
    const service = new CloudHealthService(makeStore(), makeConfig(), makeDeploymentConfig());

    const result = await service.getChecks()[0]!.check();

    expect(result).toEqual({ status: 'error', message: 'boom' });
  });
});

describe('ECS service-linked role fix', () => {
  it('should report fixed when creation succeeds', async () => {
    iamMock.on(CreateServiceLinkedRoleCommand).resolves({});
    const service = new CloudHealthService(makeStore(), makeConfig(), makeDeploymentConfig());

    const result = await service.getChecks()[0]!.fix();

    expect(result).toEqual({ outcome: 'fixed' });
  });

  it('should report fixed when the role already exists', async () => {
    const err = Object.assign(new Error('Service linked role already exists'), { name: 'InvalidInputException' });
    iamMock.on(CreateServiceLinkedRoleCommand).rejects(err);
    const service = new CloudHealthService(makeStore(), makeConfig(), makeDeploymentConfig());

    const result = await service.getChecks()[0]!.fix();

    expect(result).toEqual({ outcome: 'fixed' });
  });

  it('should report needsPolicyUpdate with policy JSON and a console URL when access is denied', async () => {
    const err = Object.assign(new Error('not authorized'), { name: 'AccessDeniedException' });
    iamMock.on(CreateServiceLinkedRoleCommand).rejects(err);
    stsMock.on(GetCallerIdentityCommand).resolves({ Account: '123456789012' });
    const service = new CloudHealthService(makeStore(), makeConfig(), makeDeploymentConfig());

    const result = await service.getChecks()[0]!.fix();

    expect(result.outcome).toBe('needsPolicyUpdate');
    expect(result.policyJson).toContain('HyveonServiceLinkedRoles');
    expect(result.policyConsoleUrl).toBe(
      'https://console.aws.amazon.com/iam/home#/policies/arn:aws:iam::123456789012:policy/HyveonDeployAll',
    );
  });

  it('should omit the console URL when the account ID cannot be resolved', async () => {
    const err = Object.assign(new Error('not authorized'), { name: 'AccessDeniedException' });
    iamMock.on(CreateServiceLinkedRoleCommand).rejects(err);
    stsMock.on(GetCallerIdentityCommand).rejects(new Error('sts unavailable'));
    const service = new CloudHealthService(makeStore(), makeConfig(), makeDeploymentConfig());

    const result = await service.getChecks()[0]!.fix();

    expect(result.outcome).toBe('needsPolicyUpdate');
    expect(result.policyConsoleUrl).toBeUndefined();
  });

  it('should report failed for an unexpected error', async () => {
    iamMock.on(CreateServiceLinkedRoleCommand).rejects(new Error('boom'));
    const service = new CloudHealthService(makeStore(), makeConfig(), makeDeploymentConfig());

    const result = await service.getChecks()[0]!.fix();

    expect(result).toEqual({ outcome: 'failed', message: 'boom' });
  });
});

describe('CloudHealthService.writePolicyToDisk', () => {
  it('should write the given JSON to the resolved download path and return it', () => {
    const service = new TestableCloudHealthService(makeStore(), makeConfig(), makeDeploymentConfig());
    vi.spyOn(service, 'getPolicyDownloadPath').mockReturnValue('/tmp/hyveon-deploy-all-policy.json');

    const result = service.writePolicyToDisk('{"Version":"2012-10-17"}');

    expect(result).toEqual({ path: '/tmp/hyveon-deploy-all-policy.json' });
    expect(mockWrite).toHaveBeenCalledWith('/tmp/hyveon-deploy-all-policy.json', '{"Version":"2012-10-17"}');
  });
});

describe('CloudHealthService.openPolicyConsole', () => {
  it('should report opened: false for a non-https URL without attempting to open it', async () => {
    const service = new CloudHealthService(makeStore(), makeConfig(), makeDeploymentConfig());

    const result = await service.openPolicyConsole('http://console.aws.amazon.com/iam/home');

    expect(result).toEqual({ opened: false, url: 'http://console.aws.amazon.com/iam/home' });
  });

  it('should report opened: false when not running inside Electron', async () => {
    const service = new TestableCloudHealthService(makeStore(), makeConfig(), makeDeploymentConfig());
    vi.spyOn(service, 'readIsElectron').mockReturnValue(false);

    const result = await service.openPolicyConsole('https://console.aws.amazon.com/iam/home');

    expect(result).toEqual({ opened: false, url: 'https://console.aws.amazon.com/iam/home' });
  });

  it('should report opened: true when shell.openExternal succeeds', async () => {
    const service = new TestableCloudHealthService(makeStore(), makeConfig(), makeDeploymentConfig());
    vi.spyOn(service, 'readIsElectron').mockReturnValue(true);
    vi.spyOn(service, 'openExternalUrl').mockResolvedValue(undefined);

    const result = await service.openPolicyConsole('https://console.aws.amazon.com/iam/home');

    expect(result).toEqual({ opened: true });
  });
});
