import 'reflect-metadata';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { IAMClient, GetRoleCommand, CreateServiceLinkedRoleCommand } from '@aws-sdk/client-iam';

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { CloudHealthService } from './CloudHealthService.js';
import type { ElectronStoreService } from './ElectronStoreService.js';
import type { ConfigService } from './ConfigService.js';
import type { DeploymentConfigService } from './DeploymentConfigService.js';

const iamMock = mockClient(IAMClient);

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

  it('should report needsPolicyUpdate with policy JSON when access is denied', async () => {
    const err = Object.assign(new Error('not authorized'), { name: 'AccessDeniedException' });
    iamMock.on(CreateServiceLinkedRoleCommand).rejects(err);
    const service = new CloudHealthService(makeStore(), makeConfig(), makeDeploymentConfig());

    const result = await service.getChecks()[0]!.fix();

    expect(result.outcome).toBe('needsPolicyUpdate');
    expect(result.policyJson).toContain('HyveonServiceLinkedRoles');
  });

  it('should report failed for an unexpected error', async () => {
    iamMock.on(CreateServiceLinkedRoleCommand).rejects(new Error('boom'));
    const service = new CloudHealthService(makeStore(), makeConfig(), makeDeploymentConfig());

    const result = await service.getChecks()[0]!.fix();

    expect(result).toEqual({ outcome: 'failed', message: 'boom' });
  });
});
