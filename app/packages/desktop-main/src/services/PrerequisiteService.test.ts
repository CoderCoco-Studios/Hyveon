import { describe, it, expect, vi, beforeEach } from 'vitest';

/*
 * Spy variable must be hoisted before vi.mock() factories run, because
 * vi.mock() calls are lifted to the top of the compiled output above regular
 * declarations.
 */
const { execFileMock } = vi.hoisted(() => {
  const execFileMock = vi.fn();
  return { execFileMock };
});

vi.mock('node:child_process', () => ({
  execFile: execFileMock,
}));

import { PrerequisiteService, lookupCommandFor } from './PrerequisiteService.js';

/** Error-first callback shape `util.promisify` invokes the mocked `execFile` with. */
type ExecFileCallback = (error: Error | null, result?: { stdout: string; stderr: string }) => void;

/** Extracts the error-first callback from an `execFile` call's arguments. */
function lastArgAsCallback(args: unknown[]): ExecFileCallback {
  return args[args.length - 1] as ExecFileCallback;
}

/** Either a successful stdout (stderr defaults to empty) or a failure sentinel. */
type RouteResult = { stdout: string; stderr?: string } | 'fail';

/**
 * Installs an `execFile` mock that dispatches on the actual `(file, args)`
 * being invoked rather than call order — required because
 * `PrerequisiteService.check()` runs the `terraform` and `aws` probes
 * concurrently via `Promise.all`, so a strict FIFO queue of responses can't
 * reliably tell which branch a given `execFile` call belongs to.
 */
function routeExecFile(handler: (file: string, args: string[]) => RouteResult): void {
  execFileMock.mockImplementation((...callArgs: unknown[]) => {
    const file = callArgs[0] as string;
    const argv = (callArgs[1] as string[] | undefined) ?? [];
    const callback = lastArgAsCallback(callArgs);
    const result = handler(file, argv);
    if (result === 'fail') {
      callback(new Error('spawn ENOENT'));
    } else {
      callback(null, { stdout: result.stdout, stderr: result.stderr ?? '' });
    }
  });
}

/**
 * Test-only subclass overriding the protected `readPlatform` seam to always
 * report `linux` (so `which`, not `where.exe`, is used), avoiding a double
 * `as unknown as` cast to reach a protected method from a plain spy.
 */
class LinuxPrerequisiteService extends PrerequisiteService {
  protected override readPlatform(): NodeJS.Platform {
    return 'linux';
  }
}

/** Builds a `PrerequisiteService` that resolves the platform as `linux`. */
function makeService(): PrerequisiteService {
  return new LinuxPrerequisiteService();
}

const TERRAFORM_PATH = '/usr/local/bin/terraform';
const AWS_PATH = '/usr/local/bin/aws';

beforeEach(() => {
  execFileMock.mockReset();
});

describe('lookupCommandFor', () => {
  it('should return where.exe for the win32 platform', () => {
    expect(lookupCommandFor('win32')).toBe('where.exe');
  });

  it('should return which for the darwin platform', () => {
    expect(lookupCommandFor('darwin')).toBe('which');
  });

  it('should return which for the linux platform', () => {
    expect(lookupCommandFor('linux')).toBe('which');
  });
});

describe('PrerequisiteService.isVersionAtLeast', () => {
  it('should return true when the version exactly equals the minimum', () => {
    expect(PrerequisiteService.isVersionAtLeast('1.5.0', '1.5.0')).toBe(true);
  });

  it('should return true when the version is greater than the minimum', () => {
    expect(PrerequisiteService.isVersionAtLeast('1.9.0', '1.5.0')).toBe(true);
  });

  it('should return false when the version is less than the minimum', () => {
    expect(PrerequisiteService.isVersionAtLeast('1.4.9', '1.5.0')).toBe(false);
  });

  it('should treat an equal-core pre-release as below the stable minimum', () => {
    expect(PrerequisiteService.isVersionAtLeast('1.5.0-beta1', '1.5.0')).toBe(false);
  });

  it('should still allow a pre-release to satisfy a lower minimum via the numeric core', () => {
    expect(PrerequisiteService.isVersionAtLeast('1.9.0-beta1', '1.5.0')).toBe(true);
  });

  it('should compare minor and patch components independently of major', () => {
    expect(PrerequisiteService.isVersionAtLeast('2.0.0', '1.99.99')).toBe(true);
    expect(PrerequisiteService.isVersionAtLeast('1.5.1', '1.5.10')).toBe(false);
  });
});

describe('PrerequisiteService.check: terraform', () => {
  it('should report not found when the lookup command fails', async () => {
    const service = makeService();
    routeExecFile(() => 'fail');

    const report = await service.check();

    expect(report.terraform).toEqual({ found: false });
  });

  it('should report found with version and minimumVersionSatisfied when -json output parses', async () => {
    const service = makeService();
    routeExecFile((file, argv) => {
      if (file === 'which' && argv[0] === 'terraform') return { stdout: `${TERRAFORM_PATH}\n` };
      if (file === 'which' && argv[0] === 'aws') return 'fail';
      if (file === TERRAFORM_PATH && argv[0] === 'version' && argv[1] === '-json') {
        return { stdout: JSON.stringify({ terraform_version: '1.9.0' }) };
      }
      return 'fail';
    });

    const report = await service.check();

    expect(report.terraform).toEqual({
      found: true,
      path: TERRAFORM_PATH,
      version: '1.9.0',
      minimumVersionSatisfied: true,
    });
  });

  it('should flag minimumVersionSatisfied as false when the resolved version is below the minimum', async () => {
    const service = makeService();
    routeExecFile((file, argv) => {
      if (file === 'which' && argv[0] === 'terraform') return { stdout: `${TERRAFORM_PATH}\n` };
      if (file === 'which' && argv[0] === 'aws') return 'fail';
      if (file === TERRAFORM_PATH && argv[0] === 'version' && argv[1] === '-json') {
        return { stdout: JSON.stringify({ terraform_version: '1.2.0' }) };
      }
      return 'fail';
    });

    const report = await service.check();

    expect(report.terraform.minimumVersionSatisfied).toBe(false);
  });

  it('should fall back to plain-text version parsing when -json output is unparseable', async () => {
    const service = makeService();
    routeExecFile((file, argv) => {
      if (file === 'which' && argv[0] === 'terraform') return { stdout: `${TERRAFORM_PATH}\n` };
      if (file === 'which' && argv[0] === 'aws') return 'fail';
      if (file === TERRAFORM_PATH && argv[0] === 'version' && argv[1] === '-json') return { stdout: 'not json' };
      if (file === TERRAFORM_PATH && argv[0] === 'version' && argv.length === 1) {
        return { stdout: 'Terraform v1.6.3\non linux_amd64\n' };
      }
      return 'fail';
    });

    const report = await service.check();

    expect(report.terraform).toMatchObject({ found: true, version: '1.6.3' });
  });

  it('should report found with version undefined when neither version form parses', async () => {
    const service = makeService();
    routeExecFile((file, argv) => {
      if (file === 'which' && argv[0] === 'terraform') return { stdout: `${TERRAFORM_PATH}\n` };
      if (file === 'which' && argv[0] === 'aws') return 'fail';
      if (file === TERRAFORM_PATH && argv[0] === 'version' && argv[1] === '-json') return { stdout: 'not json' };
      if (file === TERRAFORM_PATH && argv[0] === 'version' && argv.length === 1) {
        return { stdout: 'unrecognized output' };
      }
      return 'fail';
    });

    const report = await service.check();

    expect(report.terraform).toEqual({ found: true, path: TERRAFORM_PATH });
  });
});

describe('PrerequisiteService.check: aws', () => {
  it('should report not found when the lookup command fails', async () => {
    const service = makeService();
    routeExecFile(() => 'fail');

    const report = await service.check();

    expect(report.aws).toEqual({ found: false });
  });

  it('should report found with a parsed version from the aws-cli/X.Y.Z banner', async () => {
    const service = makeService();
    routeExecFile((file, argv) => {
      if (file === 'which' && argv[0] === 'aws') return { stdout: `${AWS_PATH}\n` };
      if (file === 'which' && argv[0] === 'terraform') return 'fail';
      if (file === AWS_PATH && argv[0] === '--version') {
        return { stdout: 'aws-cli/2.15.30 Python/3.11.6 Linux/5.15.0 exe/x86_64.ubuntu.22 prompt/off\n' };
      }
      return 'fail';
    });

    const report = await service.check();

    expect(report.aws).toEqual({ found: true, path: AWS_PATH, version: '2.15.30' });
  });

  it('should report found with version undefined when the banner is unparseable', async () => {
    const service = makeService();
    routeExecFile((file, argv) => {
      if (file === 'which' && argv[0] === 'aws') return { stdout: `${AWS_PATH}\n` };
      if (file === 'which' && argv[0] === 'terraform') return 'fail';
      if (file === AWS_PATH && argv[0] === '--version') return { stdout: 'unrecognized banner' };
      return 'fail';
    });

    const report = await service.check();

    expect(report.aws).toEqual({ found: true, path: AWS_PATH });
  });
});
