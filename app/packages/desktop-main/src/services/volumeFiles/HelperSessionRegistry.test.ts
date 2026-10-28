import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { HelperSessionRegistry, type HelperSessionSnapshot } from './HelperSessionRegistry.js';
import type { FileManagerService, HelperLaunchOutcome } from '../FileManagerService.js';
import type { FileBrowserClientFactory } from '../folderUpload/FileBrowserClient.js';
import { buildHelperVolumeLayout, type HelperVolumeLayout } from './helperVolumeLayout.js';
import { VolumeFileError } from './VolumeFileBackend.js';
import { fakeBackend, type FakeBackend } from '../../testing/fake-volume-backend.js';

const GRACE_MS = 5 * 60 * 1000;
const TASK_ARN = 'arn:t1';

const LAYOUT: HelperVolumeLayout = buildHelperVolumeLayout(
  'mc',
  [
    { name: 'config', container_path: '/data/config' },
    { name: 'saves', container_path: '/data/saves' },
  ],
  { efsAccessPoints: { mc: 'fsap-c' }, efsVolumeAccessPoints: { mc: { config: 'fsap-c' } } },
);

/** A successful launch carrying a recognisable credential, so tests can prove it never leaks. */
function launchOk(): HelperLaunchOutcome {
  return {
    ok: true,
    taskArn: TASK_ARN,
    credentials: { username: 'admin', password: 'pw-secret' },
    cert: { certPem: 'CERT-PEM', keyPem: 'KEY-PEM', fingerprint256: 'AA:BB' },
    operatorIp: '203.0.113.7',
    startedAt: 0,
    autoStopAt: 7_200_000,
    scheduleWarning: '',
    layout: LAYOUT,
  };
}

interface Harness {
  registry: HelperSessionRegistry;
  fm: {
    launchHelper: ReturnType<typeof vi.fn<FileManagerService['launchHelper']>>;
    stop: ReturnType<typeof vi.fn<FileManagerService['stop']>>;
    listHelperTask: ReturnType<typeof vi.fn<FileManagerService['listHelperTask']>>;
    getHelperPublicIp: ReturnType<typeof vi.fn<FileManagerService['getHelperPublicIp']>>;
    getHelperStopReason: ReturnType<typeof vi.fn<FileManagerService['getHelperStopReason']>>;
    planHelperLayout: ReturnType<typeof vi.fn<FileManagerService['planHelperLayout']>>;
  };
  backend: FakeBackend;
  create: ReturnType<typeof vi.fn>;
  /** Games for which ECS reports a helper task; a game joins once `launchHelper` runs and leaves on `stop`. */
  ecs: Set<string>;
}

/**
 * Builds a registry over a stubbed {@link FileManagerService}. The stub models ECS: no task until `launchHelper` runs,
 * and none again once `stop` runs.
 */
function harness(): Harness {
  const ecs = new Set<string>();
  const backend = fakeBackend();
  const fm: Harness['fm'] = {
    launchHelper: vi.fn(async (game: string) => {
      ecs.add(game);
      return launchOk();
    }),
    stop: vi.fn(async (game: string) => {
      ecs.delete(game);
      return { success: true, message: 'stopping' };
    }),
    listHelperTask: vi.fn(async (game: string) => (ecs.has(game) ? { taskArn: TASK_ARN } : null)),
    getHelperPublicIp: vi.fn(async () => '127.0.0.1'),
    getHelperStopReason: vi.fn(async () => null),
    planHelperLayout: vi.fn(async () => LAYOUT),
  };
  const create = vi.fn().mockReturnValue(backend);
  const registry = new HelperSessionRegistry(fm as Partial<FileManagerService> as FileManagerService, { create } as Partial<FileBrowserClientFactory> as FileBrowserClientFactory);
  return { registry, fm, backend, create, ecs };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('HelperSessionRegistry', () => {
  it('should share one launch between concurrent acquires', async () => {
    const { registry, fm } = harness();

    const results = await Promise.all([registry.acquire('mc', 'browse'), registry.acquire('mc', 'upload:r1')]);

    expect(results).toEqual([{ ok: true }, { ok: true }]);
    expect(fm.launchHelper).toHaveBeenCalledTimes(1);
    expect(await registry.status('mc')).toMatchObject({ state: 'running', browseHeld: true, uploadHolders: 1 });
  });

  it('should launch over TLS with the browse run id and pass tags only to the launching acquire', async () => {
    const { registry, fm } = harness();
    const tags = [{ key: 'Purpose', value: 'upload' }];

    await Promise.all([registry.acquire('mc', 'upload:r1', { runId: 'r1', tags }), registry.acquire('mc', 'browse', { runId: 'other' })]);
    const second = harness();
    await second.registry.acquire('mc', 'browse');

    expect(fm.launchHelper).toHaveBeenCalledWith('mc', expect.objectContaining({ runId: 'r1', tls: true, tags }));
    expect(second.fm.launchHelper).toHaveBeenCalledWith('mc', expect.objectContaining({ runId: 'browse', tls: true }));
  });

  it('should connect a backend built from the launch credentials and the configured port', async () => {
    const { registry, create, backend } = harness();
    registry.timings.helperPort = 9443;

    await registry.acquire('mc', 'browse');

    expect(create).toHaveBeenCalledWith({
      host: '127.0.0.1',
      port: 9443,
      username: 'admin',
      password: 'pw-secret',
      certPem: 'CERT-PEM',
      fingerprint256: 'AA:BB',
    });
    expect(backend.connect).toHaveBeenCalledTimes(1);
  });

  it('should keep the helper while another holder remains', async () => {
    const { registry, fm } = harness();
    await Promise.all([registry.acquire('mc', 'browse'), registry.acquire('mc', 'upload:r1')]);

    registry.release('mc', 'upload:r1');
    await vi.advanceTimersByTimeAsync(GRACE_MS * 2);

    expect(fm.stop).not.toHaveBeenCalled();
  });

  it('should stop the helper after the browse grace period', async () => {
    const { registry, fm } = harness();
    await registry.acquire('mc', 'browse');

    registry.release('mc', 'browse');
    await vi.advanceTimersByTimeAsync(GRACE_MS - 1);
    expect(fm.stop).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(fm.stop).toHaveBeenCalledTimes(1);
    expect(fm.stop).toHaveBeenCalledWith('mc');
    expect(await registry.status('mc')).toMatchObject({ state: 'stopped' });
  });

  it('should cancel the grace timer when the page re-attaches', async () => {
    const { registry, fm } = harness();
    await registry.acquire('mc', 'browse');

    registry.release('mc', 'browse');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(registry.attach('mc')).toBe(true);
    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(fm.stop).not.toHaveBeenCalled();
    expect(await registry.status('mc')).toMatchObject({ state: 'running', browseHeld: true });
  });

  it('should not attach when no session exists', () => {
    expect(harness().registry.attach('mc')).toBe(false);
  });

  it('should stop an upload-only session as soon as the upload releases', async () => {
    const { registry, fm } = harness();
    await registry.acquire('mc', 'upload:r1');

    registry.release('mc', 'upload:r1');
    await vi.advanceTimersByTimeAsync(0);

    expect(fm.stop).toHaveBeenCalledTimes(1);
  });

  it('should ignore a release for an unknown holder or game', async () => {
    const { registry, fm } = harness();
    await registry.acquire('mc', 'browse');

    expect(() => registry.release('other', 'browse')).not.toThrow();
    expect(() => registry.release('mc', 'upload:ghost')).not.toThrow();
    await vi.advanceTimersByTimeAsync(GRACE_MS * 2);

    expect(fm.stop).not.toHaveBeenCalled();
  });

  it('should not let a stale grace timer stop a newer session', async () => {
    const { registry, fm } = harness();
    await registry.acquire('mc', 'browse');
    registry.release('mc', 'browse');
    await registry.stop('mc');
    await registry.acquire('mc', 'upload:r1');
    fm.stop.mockClear();

    await vi.advanceTimersByTimeAsync(GRACE_MS * 2);

    expect(fm.stop).not.toHaveBeenCalled();
    expect(await registry.status('mc')).toMatchObject({ state: 'running' });
  });

  it('should run beforeStop listeners before tearing down', async () => {
    const { registry, fm, backend } = harness();
    const order: string[] = [];
    registry.onBeforeStop(() => {
      order.push('listener');
    });
    fm.stop.mockImplementation(async () => {
      order.push('stop');
      return { success: true, message: 'ok' };
    });
    vi.mocked(backend.close).mockImplementation(async () => {
      order.push('close');
    });
    await registry.acquire('mc', 'browse');

    await registry.stop('mc');

    expect(order).toEqual(['listener', 'close', 'stop']);
  });

  it('should still tear down when a beforeStop listener throws', async () => {
    const { registry, fm } = harness();
    registry.onBeforeStop(() => {
      throw new Error('boom');
    });
    await registry.acquire('mc', 'browse');

    const result = await registry.stop('mc');

    expect(result).toEqual({ success: true, message: 'stopping' });
    expect(fm.stop).toHaveBeenCalledTimes(1);
  });

  it('should report orphaned when ECS has a helper the registry does not own', async () => {
    const { registry, fm, ecs } = harness();
    ecs.add('mc');

    expect(await registry.status('mc')).toMatchObject({ state: 'orphaned' });
    expect(await registry.acquire('mc', 'browse')).toMatchObject({ ok: false, code: 'orphaned' });
    expect(fm.launchHelper).not.toHaveBeenCalled();
    expect(registry.ownedGames().has('mc')).toBe(false);
  });

  it('should stop an orphan on stop()', async () => {
    const { registry, fm, ecs } = harness();
    ecs.add('mc');

    const result = await registry.stop('mc');

    expect(result.success).toBe(true);
    expect(fm.stop).toHaveBeenCalledWith('mc');
  });

  it('should restart an orphan by stopping it and launching a fresh session', async () => {
    const { registry, fm, ecs } = harness();
    ecs.add('mc');

    expect(await registry.restart('mc')).toEqual({ ok: true });

    expect(fm.stop.mock.invocationCallOrder[0]).toBeLessThan(fm.launchHelper.mock.invocationCallOrder[0] as number);
    expect(await registry.status('mc')).toMatchObject({ state: 'running', browseHeld: true });
  });

  it('should report not_deployed with no volumes when the stack has no outputs', async () => {
    const { registry, fm } = harness();
    fm.planHelperLayout.mockResolvedValue(null);

    expect(await registry.status('mc')).toMatchObject({ state: 'not_deployed', volumes: [] });
    expect(await registry.acquire('mc', 'browse')).toMatchObject({ ok: false, code: 'not_deployed' });
    expect(fm.launchHelper).not.toHaveBeenCalled();
  });

  it('should report failed when the session task disappears from ECS', async () => {
    const { registry, fm, ecs, backend } = harness();
    await registry.acquire('mc', 'browse');
    ecs.delete('mc');
    fm.getHelperStopReason.mockResolvedValue('Essential container exited');
    fm.stop.mockClear();

    const snapshot = await registry.status('mc');

    expect(snapshot).toMatchObject({ state: 'failed', error: expect.stringContaining('Essential container exited') });
    expect(fm.getHelperStopReason).toHaveBeenCalledWith(TASK_ARN);
    expect(backend.close).toHaveBeenCalledTimes(1);
    expect(fm.stop).toHaveBeenCalledWith('mc');
    expect(registry.ownedGames().has('mc')).toBe(false);
  });

  it('should keep reporting failed until the next acquire', async () => {
    const { registry, fm, ecs } = harness();
    await registry.acquire('mc', 'browse');
    ecs.delete('mc');
    fm.getHelperStopReason.mockResolvedValue('OOM');
    await registry.status('mc');

    expect(await registry.status('mc')).toMatchObject({ state: 'failed', error: expect.stringContaining('OOM') });
    expect(await registry.status('mc')).toMatchObject({ state: 'failed' });

    await registry.acquire('mc', 'browse');
    expect(await registry.status('mc')).toMatchObject({ state: 'running' });
  });

  it('should drop the entry, keep the error and emit failed when the launch fails', async () => {
    const { registry, fm } = harness();
    fm.launchHelper.mockResolvedValue({ ok: false, code: 'failed', message: 'No EFS access point' });
    const states: string[] = [];
    registry.onState((s) => states.push(s.state));

    expect(await registry.acquire('mc', 'browse')).toEqual({ ok: false, code: 'failed', message: 'No EFS access point' });

    expect(states).toEqual(['starting', 'failed']);
    expect(registry.ownedGames().has('mc')).toBe(false);
    expect(await registry.status('mc')).toMatchObject({ state: 'failed', error: 'No EFS access point' });
    expect(await registry.status('mc')).toMatchObject({ state: 'failed' });
  });

  it('should stop a launched helper when it never becomes reachable', async () => {
    const { registry, fm, backend } = harness();
    vi.mocked(backend.connect).mockRejectedValue(new VolumeFileError('unreachable', 'connect refused'));

    expect(await registry.acquire('mc', 'browse')).toMatchObject({ ok: false, code: 'failed', message: 'connect refused' });

    expect(fm.stop).toHaveBeenCalledWith('mc');
    expect(backend.close).toHaveBeenCalledTimes(1);
    expect(await registry.status('mc')).toMatchObject({ state: 'failed', error: 'connect refused' });
  });

  it('should wait for an in-flight teardown before launching a fresh session', async () => {
    const { registry, fm, ecs } = harness();
    await registry.acquire('mc', 'browse');
    let releaseStop!: () => void;
    fm.stop.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseStop = () => {
            ecs.delete('mc');
            resolve({ success: true, message: 'ok' });
          };
        }),
    );

    const stopping = registry.stop('mc');
    await vi.advanceTimersByTimeAsync(0);
    const reacquire = registry.acquire('mc', 'browse');
    await vi.advanceTimersByTimeAsync(0);
    expect(fm.launchHelper).toHaveBeenCalledTimes(1);

    releaseStop();
    await stopping;

    expect(await reacquire).toEqual({ ok: true });
    expect(fm.launchHelper).toHaveBeenCalledTimes(2);
  });

  it('should stop every owned game without throwing', async () => {
    const { registry, fm } = harness();
    await registry.acquire('mc', 'browse');
    await registry.acquire('pw', 'upload:r1');
    fm.stop.mockRejectedValueOnce(new Error('aws down'));

    await expect(registry.stopAll()).resolves.toBeUndefined();

    expect(fm.stop).toHaveBeenCalledTimes(2);
    expect(registry.ownedGames().size).toBe(0);
  });

  it('should report every declared volume with its mounted flag', async () => {
    const { registry } = harness();
    await registry.acquire('mc', 'browse');

    const { volumes } = await registry.status('mc');

    expect(volumes).toEqual([
      { name: 'config', containerPath: '/data/config', mounted: true },
      { name: 'saves', containerPath: '/data/saves', mounted: false },
    ]);
  });

  it('should report archive support from the backend', async () => {
    const { registry, backend } = harness();
    await registry.acquire('mc', 'browse');
    expect((await registry.status('mc')).supportsArchive).toBe(false);

    backend.archiveStream = vi.fn();
    expect((await registry.status('mc')).supportsArchive).toBe(true);
  });

  it('should emit a snapshot on each state change and survive a throwing listener', async () => {
    const { registry } = harness();
    const seen: HelperSessionSnapshot[] = [];
    registry.onState(() => {
      throw new Error('bad listener');
    });
    registry.onState((s) => seen.push(s));

    await registry.acquire('mc', 'browse');
    await registry.stop('mc');

    expect(seen.map((s) => s.state)).toEqual(['starting', 'running', 'stopping', 'stopped']);
  });

  it('should run an operation against the live backend and refuse without a session', async () => {
    const { registry, backend } = harness();
    await expect(registry.withBackend('mc', async () => 1)).rejects.toMatchObject({ code: 'unreachable' });

    await registry.acquire('mc', 'browse');

    await expect(registry.withBackend('mc', async (b, layout) => [b === backend, layout === LAYOUT])).resolves.toEqual([true, true]);
  });

  it('should not expose credentials, cert or address in a snapshot', async () => {
    const { registry } = harness();
    const seen: HelperSessionSnapshot[] = [];
    registry.onState((s) => seen.push(s));
    await registry.acquire('mc', 'browse');

    const text = JSON.stringify([await registry.status('mc'), ...seen]);

    expect(text).not.toMatch(/password|credential|cert|fingerprint|127\.0\.0\.1|203\.0\.113\.7|https?:/i);
  });
});
