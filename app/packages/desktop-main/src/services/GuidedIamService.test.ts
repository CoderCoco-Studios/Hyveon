import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'path';
import { mockClient } from 'aws-sdk-client-mock';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';

vi.mock('fs', () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

/** Spy for `resolveCloudFormationTemplatePath`, driving whether a template "exists" per test. */
const mockResolveTemplatePath = vi.hoisted(() => vi.fn());
vi.mock('../cloudformationTemplate.js', () => ({
  resolveCloudFormationTemplatePath: mockResolveTemplatePath,
}));

import { readFileSync, writeFileSync } from 'fs';
import { generateHyveonDeployAllPolicy, generateHyveonSelfRotatePolicy } from '@hyveon/shared';
import { GuidedIamService } from './GuidedIamService.js';

/** Typed stand-in for the AWS STS SDK client, shared across the `intakeBootstrapKey` tests below. */
const stsMock = mockClient(STSClient);

/** Strongly-typed mock handles for the `fs` module. */
const mockRead = vi.mocked(readFileSync);
const mockWrite = vi.mocked(writeFileSync);

/**
 * Minimal CloudFormation template fixture standing in for the real
 * `iam-bootstrap.yaml`: both literal placeholder tokens `renderTemplate()`
 * must substitute, plus a `!Ref UserName` line that must survive untouched
 * (the CFN parameter is operator-editable in the console, never baked in by
 * this service).
 */
const FIXTURE_TEMPLATE = [
  'Parameters:',
  '  UserName:',
  '    Type: String',
  '    Default: hyveon',
  'Resources:',
  '  HyveonDeployAllPolicy:',
  '    Properties:',
  '      PolicyDocument: __HYVEON_DEPLOY_ALL_POLICY_DOCUMENT__',
  '  HyveonSelfRotatePolicy:',
  '    Properties:',
  '      PolicyDocument: __HYVEON_SELF_ROTATE_POLICY_DOCUMENT__',
  '  HyveonDeployUser:',
  '    Properties:',
  '      UserName: !Ref UserName',
].join('\n');

/**
 * Test-only subclass that re-exposes `GuidedIamService`'s protected
 * environment-probing / path-resolution seams as public members so
 * `vi.spyOn` can target them directly, mirroring `ConfigService.test.ts`'s
 * `TestableConfigService` pattern — avoids `as unknown as` casts.
 */
class TestableGuidedIamService extends GuidedIamService {
  public override readIsPackaged(): boolean {
    return super.readIsPackaged();
  }

  public override readUserDataPath(): string | null {
    return super.readUserDataPath();
  }

  public override getRenderedTemplatePath(): string {
    return super.getRenderedTemplatePath();
  }

  public override readIsElectron(): boolean {
    return super.readIsElectron();
  }

  public override openExternalUrl(url: string): Promise<void> {
    return super.openExternalUrl(url);
  }

  public override createStsClient(creds: { accessKeyId: string; secretAccessKey: string; region: string }): STSClient {
    return super.createStsClient(creds);
  }
}

describe('GuidedIamService', () => {
  let service: TestableGuidedIamService;

  beforeEach(() => {
    service = new TestableGuidedIamService();
    mockResolveTemplatePath.mockReset();
    mockRead.mockReset();
    mockWrite.mockReset();
    stsMock.reset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete (process.versions as Record<string, string | undefined>)['electron'];
  });

  describe('buildCloudFormationConsoleUrl', () => {
    it('should construct the exact AWS CloudFormation console URL for us-east-1', () => {
      const url = service.buildCloudFormationConsoleUrl('us-east-1');
      expect(url).toBe('https://us-east-1.console.aws.amazon.com/cloudformation/home?region=us-east-1#/stacks/create');
    });

    it('should construct the exact AWS CloudFormation console URL for eu-west-2', () => {
      const url = service.buildCloudFormationConsoleUrl('eu-west-2');
      expect(url).toBe('https://eu-west-2.console.aws.amazon.com/cloudformation/home?region=eu-west-2#/stacks/create');
    });

    it('should include the region in both the subdomain and query parameter', () => {
      const testRegion = 'ap-southeast-1';
      const url = service.buildCloudFormationConsoleUrl(testRegion);
      // Verify region appears exactly twice: once in subdomain, once in query string.
      const regionMatches = url.match(/ap-southeast-1/g);
      expect(regionMatches).toHaveLength(2);
      expect(url).toContain(`${testRegion}.console.aws.amazon.com`);
      expect(url).toContain(`?region=${testRegion}`);
    });

    it('should not include a templateURL parameter', () => {
      const url = service.buildCloudFormationConsoleUrl('us-west-2');
      expect(url).not.toContain('templateURL');
      expect(url).not.toContain('TemplateURL');
    });
  });

  describe('renderTemplate', () => {
    it('should throw a clear error when the template cannot be located', () => {
      mockResolveTemplatePath.mockReturnValue(undefined);

      expect(() => service.renderTemplate()).toThrow(/iam-bootstrap\.yaml/);
      expect(mockWrite).not.toHaveBeenCalled();
    });

    it('should substitute both placeholder tokens with single-line JSON and leave UserName untouched', () => {
      mockResolveTemplatePath.mockReturnValue('/fake/iam-bootstrap.yaml');
      mockRead.mockReturnValue(FIXTURE_TEMPLATE);
      vi.spyOn(service, 'readIsPackaged').mockReturnValue(false);

      const result = service.renderTemplate();

      expect(mockRead).toHaveBeenCalledWith('/fake/iam-bootstrap.yaml', 'utf-8');
      expect(mockWrite).toHaveBeenCalledTimes(1);
      const [writtenPath, content] = mockWrite.mock.calls[0]!;
      expect(writtenPath).toBe(result.path);

      const rendered = content as string;
      expect(rendered).not.toContain('__HYVEON_DEPLOY_ALL_POLICY_DOCUMENT__');
      expect(rendered).not.toContain('__HYVEON_SELF_ROTATE_POLICY_DOCUMENT__');
      expect(rendered).toContain(`PolicyDocument: ${JSON.stringify(generateHyveonDeployAllPolicy())}`);
      expect(rendered).toContain(`PolicyDocument: ${JSON.stringify(generateHyveonSelfRotatePolicy())}`);
      // UserName stays a real CloudFormation parameter reference — never substituted.
      expect(rendered).toContain('UserName: !Ref UserName');
      // Single-line JSON.stringify output (no `null, 2` pretty-print): the
      // substitution must not introduce any new line breaks.
      expect(rendered.split('\n')).toHaveLength(FIXTURE_TEMPLATE.split('\n').length);
    });
  });

  describe('openConsole', () => {
    const CONSOLE_URL = 'https://us-east-1.console.aws.amazon.com/cloudformation/home?region=us-east-1#/stacks/create';

    it('should return opened: true when shell.openExternal resolves', async () => {
      (process.versions as Record<string, string | undefined>)['electron'] = '30.0.0';
      vi.spyOn(service, 'openExternalUrl').mockResolvedValue(undefined);

      const result = await service.openConsole(CONSOLE_URL);

      expect(result).toEqual({ opened: true });
      expect(service.openExternalUrl).toHaveBeenCalledWith(CONSOLE_URL);
    });

    it('should return opened: false and not throw when shell.openExternal rejects', async () => {
      (process.versions as Record<string, string | undefined>)['electron'] = '30.0.0';
      vi.spyOn(service, 'openExternalUrl').mockRejectedValue(new Error('no registered browser handler'));

      await expect(service.openConsole(CONSOLE_URL)).resolves.toEqual({ opened: false });
    });

    it('should return opened: false and never call openExternalUrl when process.versions.electron is unset', async () => {
      const openExternalSpy = vi.spyOn(service, 'openExternalUrl');

      const result = await service.openConsole(CONSOLE_URL);

      expect(result).toEqual({ opened: false });
      expect(openExternalSpy).not.toHaveBeenCalled();
    });

    describe('readIsElectron', () => {
      it('should return false when process.versions.electron is unset', () => {
        expect(service.readIsElectron()).toBe(false);
      });

      it('should return true when process.versions.electron is set', () => {
        (process.versions as Record<string, string | undefined>)['electron'] = '30.0.0';
        expect(service.readIsElectron()).toBe(true);
      });
    });
  });

  describe('getRenderedTemplatePath', () => {
    it('should return <userData>/iam-bootstrap-rendered.yaml when packaged', () => {
      vi.spyOn(service, 'readIsPackaged').mockReturnValue(true);
      vi.spyOn(service, 'readUserDataPath').mockReturnValue('/fake/userData');

      expect(service.getRenderedTemplatePath()).toBe(path.join('/fake/userData', 'iam-bootstrap-rendered.yaml'));
    });

    it('should fall back to the repo-relative dev path when not packaged', () => {
      vi.spyOn(service, 'readIsPackaged').mockReturnValue(false);

      const result = service.getRenderedTemplatePath();
      expect(result).toMatch(/\.iam-bootstrap-dev$/);
      expect(path.isAbsolute(result)).toBe(true);
    });

    it('should fall back to the repo-relative dev path when packaged but readUserDataPath returns null', () => {
      vi.spyOn(service, 'readIsPackaged').mockReturnValue(true);
      vi.spyOn(service, 'readUserDataPath').mockReturnValue(null);

      const result = service.getRenderedTemplatePath();
      expect(result).toMatch(/\.iam-bootstrap-dev$/);
      expect(result).not.toContain('userData');
    });

    describe('outside an Electron process', () => {
      it('should return false from readIsPackaged when process.versions.electron is unset', () => {
        expect(service.readIsPackaged()).toBe(false);
      });

      it('should return null from readUserDataPath when process.versions.electron is unset', () => {
        expect(service.readUserDataPath()).toBeNull();
      });
    });

    describe('with process.versions.electron set but the electron module unusable (matches a plain Node test process)', () => {
      it('should return false from readIsPackaged when requiring "electron" does not yield a usable app object', () => {
        (process.versions as Record<string, string | undefined>)['electron'] = '30.0.0';
        expect(service.readIsPackaged()).toBe(false);
      });

      it('should return null from readUserDataPath when requiring "electron" does not yield a usable app object', () => {
        (process.versions as Record<string, string | undefined>)['electron'] = '30.0.0';
        expect(service.readUserDataPath()).toBeNull();
      });
    });
  });

  describe('intakeBootstrapKey', () => {
    const BOOTSTRAP_INPUT = {
      accessKeyId: 'AKIABOOTSTRAPKEY',
      secretAccessKey: 'super-secret-bootstrap-value',
      region: 'us-west-2',
    };

    it('should return the resolved account ID for a valid bootstrap key pair', async () => {
      stsMock.on(GetCallerIdentityCommand).resolves({
        Account: '123456789012',
        Arn: 'arn:aws:iam::123456789012:user/hyveon-bootstrap',
      });

      const result = await service.intakeBootstrapKey(BOOTSTRAP_INPUT);

      expect(result).toEqual({ accountId: '123456789012' });
      const calls = stsMock.commandCalls(GetCallerIdentityCommand);
      expect(calls).toHaveLength(1);
    });

    it('should build the STS client directly from the submitted credentials and region, not from ElectronStoreService', async () => {
      stsMock.on(GetCallerIdentityCommand).resolves({ Account: '123456789012' });
      const createStsClientSpy = vi.spyOn(service, 'createStsClient');

      await service.intakeBootstrapKey(BOOTSTRAP_INPUT);

      expect(createStsClientSpy).toHaveBeenCalledWith(BOOTSTRAP_INPUT);
    });

    it('should propagate the original AWS error unchanged when the bootstrap key is invalid', async () => {
      const awsError = new Error('The security token included in the request is invalid');
      awsError.name = 'InvalidClientTokenId';
      stsMock.on(GetCallerIdentityCommand).rejects(awsError);

      await expect(service.intakeBootstrapKey(BOOTSTRAP_INPUT)).rejects.toMatchObject({
        name: 'InvalidClientTokenId',
        message: 'The security token included in the request is invalid',
      });
    });

    it('should throw a clear error when a successful response is missing the Account field', async () => {
      stsMock.on(GetCallerIdentityCommand).resolves({ Arn: 'arn:aws:iam::123456789012:user/hyveon-bootstrap' });

      await expect(service.intakeBootstrapKey(BOOTSTRAP_INPUT)).rejects.toThrow(/did not return an Account/);
    });
  });
});
