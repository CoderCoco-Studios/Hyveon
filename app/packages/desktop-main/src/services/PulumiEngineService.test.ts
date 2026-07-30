import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SemVer } from 'semver';
import { PULUMI_ENGINE_VERSION } from '@hyveon/shared';

/*
 * Spy variables must be hoisted before vi.mock() factories run, because
 * vi.mock() calls are lifted to the top of the compiled output above regular
 * declarations — mirrors TerraformService.test.ts's `execFileMock` pattern.
 */
const { getMock, installMock, existsSyncMock, mkdirSyncMock, renameSyncMock, rmSyncMock, loggerMock } = vi.hoisted(
  () => ({
    getMock: vi.fn(),
    installMock: vi.fn(),
    existsSyncMock: vi.fn(),
    mkdirSyncMock: vi.fn(),
    renameSyncMock: vi.fn(),
    rmSyncMock: vi.fn(),
    loggerMock: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  }),
);

vi.mock('@pulumi/pulumi/automation/index.js', () => ({
  PulumiCommand: {
    get: getMock,
    install: installMock,
  },
}));

vi.mock('node:fs', () => ({
  existsSync: existsSyncMock,
  mkdirSync: mkdirSyncMock,
  renameSync: renameSyncMock,
  rmSync: rmSyncMock,
}));

vi.mock('../logger.js', () => ({ logger: loggerMock }));

import { PulumiEngineService, PulumiEngineNetworkError, PulumiEngineIntegrityError, PulumiEngineCacheWriteError } from './PulumiEngineService.js';

/** Minimal `PulumiCommand`-shaped object the mocked SDK resolves with. */
interface FakeCommand {
  command: string;
  version: SemVer | null;
}

function fakeCommand(root: string, version: string): FakeCommand {
  return { command: `${root}/bin/pulumi`, version: new SemVer(version) };
}

/**
 * Test-only subclass that re-exposes `PulumiEngineService`'s protected
 * `userData` seam as public so `vi.spyOn` can target it directly, mirroring
 * `ConfigService.test.ts`'s `TestableConfigService`.
 */
class TestablePulumiEngineService extends PulumiEngineService {
  public override resolveUserDataPath(): string | null {
    return super.resolveUserDataPath();
  }
}

/** Builds a service with a fixed, fake `userData` path so cache paths are deterministic. */
function makeService(userDataPath: string | null = '/fake/userData'): TestablePulumiEngineService {
  const service = new TestablePulumiEngineService();
  vi.spyOn(service, 'resolveUserDataPath').mockReturnValue(userDataPath);
  return service;
}

/** Absolute path to the pinned version's install directory under the fake `userData`. */
const PIN_ROOT = `/fake/userData/pulumi/versions/${PULUMI_ENGINE_VERSION}`;

beforeEach(() => {
  getMock.mockReset();
  installMock.mockReset();
  existsSyncMock.mockReset();
  mkdirSyncMock.mockReset();
  renameSyncMock.mockReset();
  rmSyncMock.mockReset();
  loggerMock.debug.mockReset();
  loggerMock.info.mockReset();
  loggerMock.warn.mockReset();
  loggerMock.error.mockReset();

  // Default: empty cache, install succeeds first try, final re-resolve succeeds.
  existsSyncMock.mockReturnValue(false);
  installMock.mockResolvedValue(fakeCommand('/staging', PULUMI_ENGINE_VERSION));
  getMock.mockResolvedValue(fakeCommand(PIN_ROOT, PULUMI_ENGINE_VERSION));
});

describe('PulumiEngineService construction', () => {
  it('should not throw when constructed on a machine with no network and no engine', () => {
    // Nothing has been stubbed to succeed yet — installMock/getMock still
    // reject by default outside beforeEach's happy-path stubs. Construction
    // must not touch either.
    installMock.mockReset();
    getMock.mockReset();
    installMock.mockRejectedValue(new Error('should never be called by the constructor'));
    getMock.mockRejectedValue(new Error('should never be called by the constructor'));

    expect(() => new PulumiEngineService()).not.toThrow();
    expect(installMock).not.toHaveBeenCalled();
    expect(getMock).not.toHaveBeenCalled();
  });

  it('should not throw even when resolving the userData path would itself throw', () => {
    // Adversarial: userData resolution blows up. Construction never calls it
    // (deferred to first resolve()), so this must still not throw.
    class ThrowingUserDataService extends PulumiEngineService {
      protected override resolveUserDataPath(): string | null {
        throw new Error('electron not ready yet');
      }
    }
    expect(() => new ThrowingUserDataService()).not.toThrow();
  });

  it('should report null for getResolvedVersion before resolve() has ever been called', () => {
    const service = makeService();
    expect(service.getResolvedVersion()).toBeNull();
  });

  it('should report the pinned version from getPinnedVersion regardless of resolution state', () => {
    const service = makeService();
    expect(service.getPinnedVersion()).toBe(PULUMI_ENGINE_VERSION);
  });
});

describe('PulumiEngineService.resolve — memoization and concurrency', () => {
  it('should call PulumiCommand.install exactly once across two concurrent resolve() calls', async () => {
    const service = makeService();

    // Gate installMock behind a manually-controlled promise so both
    // resolve() calls are guaranteed to be in flight simultaneously before
    // either the install call itself, or the whole attempt, ever settles —
    // this is what makes the assertion below prove a *shared* in-flight
    // promise rather than two calls that merely happen to interleave.
    let releaseInstall!: () => void;
    const gate = new Promise<void>((resolvePromise) => {
      releaseInstall = resolvePromise;
    });
    installMock.mockImplementationOnce(async () => {
      await gate;
      return fakeCommand('/staging', PULUMI_ENGINE_VERSION);
    });

    const first = service.resolve();
    const second = service.resolve();

    // Flush pending microtasks (tryReuseCached's early return, provision()'s
    // await chain) so installMock has actually been invoked by the time it's
    // asserted below — the assignment of `this.resolution` that guarantees a
    // *shared* promise across `first`/`second` already happened synchronously
    // above, before either `resolve()` call returned.
    await new Promise((r) => setTimeout(r, 0));
    expect(installMock).toHaveBeenCalledTimes(1);

    releaseInstall();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(installMock).toHaveBeenCalledTimes(1);
    expect(firstResult).toBe(secondResult);
  });

  it('should memoize a successful resolution so a later call does not reprovision', async () => {
    const service = makeService();

    await service.resolve();
    await service.resolve();

    expect(installMock).toHaveBeenCalledTimes(1);
  });

  it('should not memoize a failed attempt, so the next resolve() call retries', async () => {
    const service = makeService();
    installMock.mockRejectedValueOnce(new Error('Failed to download https://get.pulumi.com/install.sh: no network'));

    await expect(service.resolve()).rejects.toThrow(PulumiEngineNetworkError);
    expect(installMock).toHaveBeenCalledTimes(1);

    // Second call, network back — must actually retry, not replay the
    // memoized rejection.
    installMock.mockResolvedValueOnce(fakeCommand('/staging', PULUMI_ENGINE_VERSION));
    await expect(service.resolve()).resolves.toBeDefined();
    expect(installMock).toHaveBeenCalledTimes(2);
  });
});

describe('PulumiEngineService.resolve — cache reuse and version pinning', () => {
  it('should reuse a verified cache entry without calling install', async () => {
    const service = makeService();
    existsSyncMock.mockReturnValue(true);
    getMock.mockResolvedValue(fakeCommand(PIN_ROOT, PULUMI_ENGINE_VERSION));

    const command = await service.resolve();

    expect(installMock).not.toHaveBeenCalled();
    expect(getMock).toHaveBeenCalledWith({ root: PIN_ROOT, version: new SemVer(PULUMI_ENGINE_VERSION), skipVersionCheck: false });
    expect(String(command.version)).toBe(PULUMI_ENGINE_VERSION);
    expect(service.getResolvedVersion()).toBe(PULUMI_ENGINE_VERSION);
  });

  it('should discard and reprovision when the cache holds a different version than the pin', async () => {
    const service = makeService();
    existsSyncMock.mockReturnValue(true);
    // The pin's own directory reports a stale/mismatched version — a
    // defensive scenario since PulumiCommand.get()'s own check is a
    // minimum-version check, not exact-match (see the service's TSDoc).
    getMock.mockResolvedValueOnce(fakeCommand(PIN_ROOT, '3.200.0'));
    installMock.mockResolvedValueOnce(fakeCommand('/staging', PULUMI_ENGINE_VERSION));
    getMock.mockResolvedValueOnce(fakeCommand(PIN_ROOT, PULUMI_ENGINE_VERSION));

    const command = await service.resolve();

    // Stale entry removed, not reused.
    expect(rmSyncMock).toHaveBeenCalledWith(PIN_ROOT, { recursive: true, force: true });
    expect(installMock).toHaveBeenCalledTimes(1);
    expect(String(command.version)).toBe(PULUMI_ENGINE_VERSION);
    expect(service.getResolvedVersion()).toBe(PULUMI_ENGINE_VERSION);
  });

  it('should discard a cache entry that fails to execute at all', async () => {
    const service = makeService();
    existsSyncMock.mockReturnValue(true);
    getMock.mockRejectedValueOnce(new Error('spawn ENOENT'));
    installMock.mockResolvedValueOnce(fakeCommand('/staging', PULUMI_ENGINE_VERSION));
    getMock.mockResolvedValueOnce(fakeCommand(PIN_ROOT, PULUMI_ENGINE_VERSION));

    await service.resolve();

    expect(rmSyncMock).toHaveBeenCalledWith(PIN_ROOT, { recursive: true, force: true });
    expect(installMock).toHaveBeenCalledTimes(1);
  });

  it('should reject with an integrity error when a freshly installed engine reports the wrong version', async () => {
    const service = makeService();
    installMock.mockResolvedValueOnce(fakeCommand('/staging', '9.9.9'));

    await expect(service.resolve()).rejects.toThrow(PulumiEngineIntegrityError);
    // A mismatched fresh install must never be renamed into the final path.
    expect(renameSyncMock).not.toHaveBeenCalled();
  });
});

describe('PulumiEngineService.resolve — no partial-install reuse', () => {
  it('should not rename a failed install into place and must reprovision fully on the next call', async () => {
    const service = makeService();
    installMock.mockRejectedValueOnce(new Error('install.sh exited 1: interrupted'));

    await expect(service.resolve()).rejects.toThrow();
    expect(renameSyncMock).not.toHaveBeenCalled();
    // Staging debris is cleaned up best-effort.
    expect(rmSyncMock).toHaveBeenCalled();
    const cleanedPath = rmSyncMock.mock.calls[0]?.[0] as string;
    expect(cleanedPath).toMatch(/\.staging-/);

    // Cache still empty (existsSync keeps returning false) — the retry must
    // go through installFresh again, not find anything reusable.
    installMock.mockResolvedValueOnce(fakeCommand('/staging-2', PULUMI_ENGINE_VERSION));
    const command = await service.resolve();

    expect(installMock).toHaveBeenCalledTimes(2);
    expect(String(command.version)).toBe(PULUMI_ENGINE_VERSION);
  });

  it('should install into a staging directory and only rename it into the final path after verification', async () => {
    const service = makeService();

    await service.resolve();

    expect(installMock).toHaveBeenCalledTimes(1);
    const installArgs = installMock.mock.calls[0]?.[0] as { root: string };
    expect(installArgs.root).not.toBe(PIN_ROOT);
    expect(installArgs.root).toMatch(/\.staging-/);
    expect(renameSyncMock).toHaveBeenCalledWith(installArgs.root, PIN_ROOT);
  });
});

describe('PulumiEngineService.resolve — typed provisioning errors', () => {
  it('should reject with PulumiEngineNetworkError when the install-script fetch itself fails', async () => {
    const service = makeService();
    installMock.mockRejectedValueOnce(
      new Error('Failed to download https://get.pulumi.com/install.sh: getaddrinfo ENOTFOUND get.pulumi.com'),
    );

    await expect(service.resolve()).rejects.toThrow(PulumiEngineNetworkError);
  });

  it('should reject with PulumiEngineIntegrityError when the install script exits non-zero for an unrecognised reason', async () => {
    const service = makeService();
    installMock.mockRejectedValueOnce(new Error('command failed with exit code 1: checksum mismatch'));

    await expect(service.resolve()).rejects.toThrow(PulumiEngineIntegrityError);
  });

  it('should reject with PulumiEngineCacheWriteError when the cache root cannot be created', async () => {
    const service = makeService();
    const eacces: NodeJS.ErrnoException = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    mkdirSyncMock.mockImplementationOnce(() => {
      throw eacces;
    });

    await expect(service.resolve()).rejects.toThrow(PulumiEngineCacheWriteError);
    expect(installMock).not.toHaveBeenCalled();
  });

  it('should reject with PulumiEngineCacheWriteError when a verified install cannot be renamed into place', async () => {
    const service = makeService();
    const erofs: NodeJS.ErrnoException = Object.assign(new Error('read-only file system'), { code: 'EROFS' });
    renameSyncMock.mockImplementationOnce(() => {
      throw erofs;
    });

    await expect(service.resolve()).rejects.toThrow(PulumiEngineCacheWriteError);
  });

  it('should classify an install failure carrying an EACCES code as a cache-write error even mid-install', async () => {
    const service = makeService();
    const eacces: NodeJS.ErrnoException = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    installMock.mockRejectedValueOnce(eacces);

    await expect(service.resolve()).rejects.toThrow(PulumiEngineCacheWriteError);
  });
});

describe('PulumiEngineService — engine cache root resolution', () => {
  const originalEnv = process.env['PULUMI_ENGINE_DIR'];

  afterEach(() => {
    if (originalEnv === undefined) delete process.env['PULUMI_ENGINE_DIR'];
    else process.env['PULUMI_ENGINE_DIR'] = originalEnv;
  });

  it('should install under an env override when PULUMI_ENGINE_DIR is set', async () => {
    process.env['PULUMI_ENGINE_DIR'] = '/env/override';
    const service = makeService('/fake/userData');
    await service.resolve();

    const installArgs = installMock.mock.calls[0]?.[0] as { root: string };
    expect(installArgs.root.startsWith('/env/override/versions')).toBe(true);
  });

  it('should fall back to the OS temp directory when no userData path is available', async () => {
    const service = makeService(null);
    await service.resolve();

    const installArgs = installMock.mock.calls[0]?.[0] as { root: string };
    expect(installArgs.root).toContain('hyveon-pulumi-engine');
  });
});
