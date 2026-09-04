import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import { EnvController } from './env.controller.js';
import type { ConfigService } from '../services/ConfigService.js';
import type { StackOutputs } from '@hyveon/shared';
import { configServiceStub } from '../testing/config-service.fixture.js';
import { stackOutputs } from '../testing/stack-outputs.fixture.js';

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

/** Build a ConfigService stub returning the given (partial) stack outputs, or `null` to simulate an undeployed stack. */
function makeConfig(overrides: Partial<StackOutputs> | null = null): ConfigService {
  return configServiceStub({ outputs: overrides === null ? null : stackOutputs(overrides) });
}

/**
 * The metadata key NestJS stores on each method decorated with
 * `@MessagePattern`. Asserting this value is the only automated guard
 * that prevents a typo in the controller from silently breaking IPC —
 * calling the method directly (as every other test does) would succeed
 * regardless of what string is registered with the transport.
 */
const PATTERN_METADATA_KEY = 'microservices:pattern';

describe('EnvController', () => {
  describe('@MessagePattern channel names', () => {
    it('should register getEnv on the "env.get" IPC channel', () => {
      const pattern = Reflect.getMetadata(PATTERN_METADATA_KEY, EnvController.prototype.getEnv);
      expect(pattern).toEqual(['env.get']);
    });
  });

  describe('getEnv', () => {
    it('should return region and domain from stack outputs', async () => {
      const result = await new EnvController(
        makeConfig({ awsRegion: 'us-east-1', domainName: 'example.com' }),
      ).getEnv();
      expect(result.region).toBe('us-east-1');
      expect(result.domain).toBe('example.com');
    });

    it('should derive environment as PROD when a domain_name is present', async () => {
      const result = await new EnvController(
        makeConfig({ awsRegion: 'us-east-1', domainName: 'servers.example.com' }),
      ).getEnv();
      expect(result.environment).toBe('PROD');
    });

    it('should fall back to "local" region and empty domain when stack outputs are missing', async () => {
      const result = await new EnvController(makeConfig(null)).getEnv();
      expect(result.region).toBe('local');
      expect(result.domain).toBe('');
      expect(result.environment).toBe('local');
    });

    it('should set environment to "local" when domain_name is an empty string', async () => {
      const result = await new EnvController(
        makeConfig({ awsRegion: 'eu-west-1', domainName: '' }),
      ).getEnv();
      expect(result.environment).toBe('local');
    });
  });
});
