import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { HelperSessionRegistry, NoSessionError, type HelperSessionSnapshot } from './HelperSessionRegistry.js';
import type { FileManagerService, HelperLaunchOutcome } from '../FileManagerService.js';
import { PinMismatchError, type FileBrowserClientFactory } from '../folderUpload/FileBrowserClient.js';
import type { PublicIpService } from '../PublicIpService.js';
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
    reauthorizeOperatorIp: ReturnType<typeof vi.fn<FileManagerService['reauthorizeOperatorIp']>>;
  };
  publicIp: { detect: ReturnType<typeof vi.fn<PublicIpService['detect']>> };
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
    reauthorizeOperatorIp: vi.fn(async () => undefined),
  };
  const publicIp: Harness['publicIp'] = { detect: vi.fn(async () => '203.0.113.7') };
  const create = vi.fn().mockReturnValue(backend);
  const registry = new HelperSessionRegistry(
    fm as Partial<FileManagerService> as FileManagerService,
    { create } as Partial<FileBrowserClientFactory> as FileBrowserClientFactory,
    publicIp as Partial<PublicIpService> as PublicIpService,
  );
  return { registry, fm, publicIp, backend, create, ecs };
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

  it('should keep the helper for the browse grace period when an upload releases after the page left', async () => {
    const { registry, fm } = harness();
    await Promise.all([registry.acquire('mc', 'browse'), registry.acquire('mc', 'upload:r1')]);

    registry.release('mc', 'browse');
    await vi.advanceTimersByTimeAsync(60_000);
    registry.release('mc', 'upload:r1');
    await vi.advanceTimersByTimeAsync(0);

    expect(fm.stop).not.toHaveBeenCalled();
    expect(registry.attach('mc')).toBe(true);
    await vi.advanceTimersByTimeAsync(GRACE_MS * 2);
    expect(fm.stop).not.toHaveBeenCalled();
    expect(await registry.status('mc')).toMatchObject({ state: 'running', browseHeld: true });
  });

  it('should stop once the remaining browse grace elapses after an upload releases', async () => {
    const { registry, fm } = harness();
    await Promise.all([registry.acquire('mc', 'browse'), registry.acquire('mc', 'upload:r1')]);

    registry.release('mc', 'browse');
    await vi.advanceTimersByTimeAsync(60_000);
    registry.release('mc', 'upload:r1');
    await vi.advanceTimersByTimeAsync(GRACE_MS - 60_000 - 1);
    expect(fm.stop).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(fm.stop).toHaveBeenCalledTimes(1);
  });

  it('should keep the browse grace running when an upload joins and leaves within it', async () => {
    const { registry, fm } = harness();
    await registry.acquire('mc', 'browse');

    registry.release('mc', 'browse');
    await vi.advanceTimersByTimeAsync(60_000);
    await registry.acquire('mc', 'upload:r1');
    registry.release('mc', 'upload:r1');
    await vi.advanceTimersByTimeAsync(GRACE_MS - 60_000 - 1);

    expect(fm.stop).not.toHaveBeenCalled();
    expect(registry.attach('mc')).toBe(true);
    await vi.advanceTimersByTimeAsync(GRACE_MS * 2);
    expect(fm.stop).not.toHaveBeenCalled();
  });

  it('should stop once the original grace elapses after an upload joined and left within it', async () => {
    const { registry, fm } = harness();
    await registry.acquire('mc', 'browse');

    registry.release('mc', 'browse');
    await vi.advanceTimersByTimeAsync(60_000);
    await registry.acquire('mc', 'upload:r1');
    registry.release('mc', 'upload:r1');
    await vi.advanceTimersByTimeAsync(GRACE_MS - 60_000 - 1);
    expect(fm.stop).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(fm.stop).toHaveBeenCalledTimes(1);
  });

  it('should stop immediately when the upload releases after the grace period already lapsed', async () => {
    const { registry, fm } = harness();
    await Promise.all([registry.acquire('mc', 'browse'), registry.acquire('mc', 'upload:r1')]);

    registry.release('mc', 'browse');
    await vi.advanceTimersByTimeAsync(GRACE_MS + 1);
    expect(fm.stop).not.toHaveBeenCalled();
    registry.release('mc', 'upload:r1');
    await vi.advanceTimersByTimeAsync(0);

    expect(fm.stop).toHaveBeenCalledTimes(1);
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

  it('should not call beforeStop listeners when the last holder releases or the grace timer expires', async () => {
    const { registry, fm } = harness();
    const listener = vi.fn();
    registry.onBeforeStop(listener);

    await registry.acquire('mc', 'upload:r1');
    registry.release('mc', 'upload:r1');
    await vi.waitFor(() => expect(fm.stop).toHaveBeenCalledTimes(1));

    await registry.acquire('mc', 'browse');
    registry.release('mc', 'browse');
    await vi.advanceTimersByTimeAsync(GRACE_MS + 1);
    await vi.waitFor(() => expect(fm.stop).toHaveBeenCalledTimes(2));

    expect(listener).not.toHaveBeenCalled();
  });

  it('should call beforeStop listeners before a starting session finishes launching when stop() is explicit', async () => {
    const { registry, fm } = harness();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const order: string[] = [];
    const launch = fm.launchHelper.getMockImplementation()!;
    fm.launchHelper.mockImplementation(async (game, options) => {
      await gate;
      order.push('launch-done');
      return launch(game, options);
    });
    registry.onBeforeStop(() => {
      order.push('listener');
    });

    const acquiring = registry.acquire('mc', 'browse');
    await vi.waitFor(() => expect(fm.launchHelper).toHaveBeenCalled());
    const stopping = registry.stop('mc');
    await vi.waitFor(() => expect(order).toEqual(['listener']));
    release();
    await Promise.all([acquiring, stopping]);

    expect(order).toEqual(['listener', 'launch-done']);
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

  it('should not stop a foreign helper that replaced the session task', async () => {
    const { registry, fm, backend } = harness();
    await registry.acquire('mc', 'browse');
    fm.listHelperTask.mockResolvedValue({ taskArn: 'arn:foreign' });
    fm.getHelperStopReason.mockResolvedValue('Essential container exited');
    fm.stop.mockClear();

    expect(await registry.status('mc')).toMatchObject({ state: 'failed', error: expect.stringContaining('Essential container exited') });

    expect(fm.stop).not.toHaveBeenCalled();
    expect(backend.close).toHaveBeenCalledTimes(1);
    expect(registry.ownedGames().has('mc')).toBe(false);
    expect(await registry.status('mc')).toMatchObject({ state: 'orphaned' });
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

    const acquiring = registry.acquire('mc', 'browse');
    await vi.advanceTimersByTimeAsync(registry.timings.loginTimeoutMs + registry.timings.pollMs);

    expect(await acquiring).toMatchObject({ ok: false, code: 'failed', message: 'connect refused' });

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
    await expect(registry.withBackend('mc', async () => 1)).rejects.toThrow(new NoSessionError('mc'));
    await expect(registry.withBackend('mc', async () => 1)).rejects.toMatchObject({
      code: 'unreachable',
      message: "No file manager session is running for 'mc'.",
    });

    await registry.acquire('mc', 'browse');

    await expect(registry.withBackend('mc', async (b, layout) => [b === backend, layout === LAYOUT])).resolves.toEqual([true, true]);
  });

  describe('readiness', () => {
    it('should stay starting until the backend accepts the login', async () => {
      const { registry, backend } = harness();
      vi.mocked(backend.connect)
        .mockRejectedValueOnce(new VolumeFileError('unreachable', 'booting'))
        .mockRejectedValueOnce(new VolumeFileError('unreachable', 'booting'))
        .mockResolvedValue(undefined);

      const acquiring = registry.acquire('mc', 'browse');
      await vi.advanceTimersByTimeAsync(registry.timings.pollMs);
      expect(await registry.status('mc')).toMatchObject({ state: 'starting' });
      await vi.advanceTimersByTimeAsync(registry.timings.pollMs);

      expect(await acquiring).toEqual({ ok: true });
      expect(backend.connect).toHaveBeenCalledTimes(3);
      expect(await registry.status('mc')).toMatchObject({ state: 'running' });
    });

    it('should stay starting while the task has no public IP', async () => {
      const { registry, fm, create } = harness();
      fm.getHelperPublicIp.mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValue('127.0.0.1');

      const acquiring = registry.acquire('mc', 'browse');
      await vi.advanceTimersByTimeAsync(registry.timings.pollMs);
      expect(await registry.status('mc')).toMatchObject({ state: 'starting' });
      expect(create).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(registry.timings.pollMs);

      expect(await acquiring).toEqual({ ok: true });
      expect(fm.getHelperPublicIp).toHaveBeenCalledTimes(3);
    });

    it('should fail when the task never gets a public IP in time', async () => {
      const { registry, fm } = harness();
      fm.getHelperPublicIp.mockResolvedValue(null);
      fm.getHelperStopReason.mockResolvedValue('OutOfMemoryError: container killed');

      const acquiring = registry.acquire('mc', 'browse');
      await vi.advanceTimersByTimeAsync(registry.timings.helperIpTimeoutMs + registry.timings.pollMs);

      expect(await acquiring).toEqual({
        ok: false,
        code: 'failed',
        message: 'The file manager helper did not get a public IP in time. (helper task stopped: OutOfMemoryError: container killed)',
      });
      expect(fm.getHelperStopReason).toHaveBeenCalledWith(TASK_ARN);
      expect(fm.stop).toHaveBeenCalledWith('mc');
    });

    it('should fail with the stop reason when the task exits during start', async () => {
      const { registry, fm } = harness();
      fm.getHelperPublicIp.mockRejectedValue(new Error('The file manager helper stopped before it was reachable: CannotPullContainerError'));

      expect(await registry.acquire('mc', 'browse')).toEqual({
        ok: false,
        code: 'failed',
        message: expect.stringContaining('CannotPullContainerError'),
      });

      expect(fm.getHelperStopReason).not.toHaveBeenCalled();
      expect(await registry.status('mc')).toMatchObject({ state: 'failed', error: expect.stringContaining('CannotPullContainerError') });
    });

    it('should fail closed on a pin mismatch without retrying login', async () => {
      const { registry, fm, backend } = harness();
      vi.mocked(backend.connect).mockRejectedValue(new PinMismatchError());

      expect(await registry.acquire('mc', 'browse')).toMatchObject({ ok: false, code: 'failed' });

      expect(backend.connect).toHaveBeenCalledTimes(1);
      expect(backend.close).toHaveBeenCalledTimes(1);
      expect(fm.stop).toHaveBeenCalledWith('mc');
      expect(await registry.status('mc')).toMatchObject({ state: 'failed' });
    });

    it('should stop promptly when stop() arrives while the task has no public IP', async () => {
      const { registry, fm } = harness();
      fm.getHelperPublicIp.mockResolvedValue(null);
      const acquiring = registry.acquire('mc', 'browse');
      await vi.advanceTimersByTimeAsync(0);

      const stopping = registry.stop('mc');
      await vi.advanceTimersByTimeAsync(registry.timings.pollMs);

      expect(await stopping).toEqual({ success: true, message: 'stopping' });
      expect(await acquiring).toEqual({ ok: false, code: 'failed', message: 'The file manager session was stopped before it was ready.' });
      expect(fm.getHelperPublicIp.mock.calls.length).toBeLessThanOrEqual(2);
    });

    it('should stop promptly when stop() arrives while the login keeps failing', async () => {
      const { registry, backend } = harness();
      vi.mocked(backend.connect).mockRejectedValue(new VolumeFileError('unreachable', 'booting'));
      const acquiring = registry.acquire('mc', 'browse');
      await vi.advanceTimersByTimeAsync(0);

      const stopping = registry.stop('mc');
      await vi.advanceTimersByTimeAsync(registry.timings.pollMs);

      expect(await stopping).toMatchObject({ success: true });
      expect(await acquiring).toMatchObject({ ok: false, code: 'failed' });
      expect(backend.close).toHaveBeenCalled();
    });
  });

  describe('operator IP recovery', () => {
    const unreachable = () => new VolumeFileError('unreachable', 'timed out');

    it('should re-authorize and retry once when the operator IP changed', async () => {
      const { registry, fm, publicIp } = harness();
      await registry.acquire('mc', 'browse');
      publicIp.detect.mockResolvedValue('198.51.100.9');
      const op = vi.fn().mockRejectedValueOnce(unreachable()).mockResolvedValue('listed');

      await expect(registry.withBackend('mc', op)).resolves.toBe('listed');

      expect(fm.reauthorizeOperatorIp).toHaveBeenCalledWith('mc', 'browse', TASK_ARN, '198.51.100.9');
      expect(op).toHaveBeenCalledTimes(2);
    });

    it('should not retry when the IP is unchanged', async () => {
      const { registry, fm } = harness();
      await registry.acquire('mc', 'browse');
      const op = vi.fn().mockRejectedValue(unreachable());

      await expect(registry.withBackend('mc', op)).rejects.toMatchObject({ code: 'unreachable' });

      expect(op).toHaveBeenCalledTimes(1);
      expect(fm.reauthorizeOperatorIp).not.toHaveBeenCalled();
    });

    it('should retry only once and rethrow the second failure', async () => {
      const { registry, publicIp } = harness();
      await registry.acquire('mc', 'browse');
      publicIp.detect.mockResolvedValue('198.51.100.9');
      const op = vi.fn().mockRejectedValue(unreachable());

      await expect(registry.withBackend('mc', op)).rejects.toMatchObject({ code: 'unreachable' });

      expect(op).toHaveBeenCalledTimes(2);
    });

    it('should not detect the IP for an error other than unreachable', async () => {
      const { registry, publicIp } = harness();
      await registry.acquire('mc', 'browse');
      const op = vi.fn().mockRejectedValue(new VolumeFileError('not-found', 'nope'));

      await expect(registry.withBackend('mc', op)).rejects.toMatchObject({ code: 'not-found' });

      expect(publicIp.detect).not.toHaveBeenCalled();
    });

    it('should rethrow the original error when the IP cannot be detected', async () => {
      const { registry, fm, publicIp } = harness();
      await registry.acquire('mc', 'browse');
      publicIp.detect.mockRejectedValue(new Error('offline'));
      const original = unreachable();
      const op = vi.fn().mockRejectedValue(original);

      await expect(registry.withBackend('mc', op)).rejects.toBe(original);

      expect(fm.reauthorizeOperatorIp).not.toHaveBeenCalled();
      expect(op).toHaveBeenCalledTimes(1);
    });

    it('should rethrow the original error when re-authorization fails', async () => {
      const { registry, fm, publicIp } = harness();
      await registry.acquire('mc', 'browse');
      publicIp.detect.mockResolvedValue('198.51.100.9');
      fm.reauthorizeOperatorIp.mockRejectedValue(new Error('AuthorizeSecurityGroupIngress denied'));
      const original = unreachable();
      const op = vi.fn().mockRejectedValue(original);

      await expect(registry.withBackend('mc', op)).rejects.toBe(original);

      expect(op).toHaveBeenCalledTimes(1);
    });

    it('should share one re-authorization between concurrent operations', async () => {
      const { registry, fm, publicIp } = harness();
      await registry.acquire('mc', 'browse');
      publicIp.detect.mockResolvedValue('198.51.100.9');
      const op = () => {
        let calls = 0;
        return vi.fn(async () => {
          if (calls++ === 0) throw unreachable();
          return 'ok';
        });
      };

      const results = await Promise.all([registry.withBackend('mc', op()), registry.withBackend('mc', op())]);

      expect(results).toEqual(['ok', 'ok']);
      expect(fm.reauthorizeOperatorIp).toHaveBeenCalledTimes(1);
    });

    it('should remember the new IP so a later failure does not re-authorize again', async () => {
      const { registry, fm, publicIp } = harness();
      await registry.acquire('mc', 'browse');
      publicIp.detect.mockResolvedValue('198.51.100.9');
      await registry.withBackend('mc', vi.fn().mockRejectedValueOnce(unreachable()).mockResolvedValue(1));

      await expect(registry.withBackend('mc', vi.fn().mockRejectedValue(unreachable()))).rejects.toMatchObject({ code: 'unreachable' });

      expect(fm.reauthorizeOperatorIp).toHaveBeenCalledTimes(1);
    });

    it('should not recover the operator IP for a session that is stopping', async () => {
      const { registry, fm, publicIp } = harness();
      await registry.acquire('mc', 'browse');
      publicIp.detect.mockResolvedValue('198.51.100.9');
      let release!: () => void;
      fm.stop.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve({ success: true, message: 'stopping' }); }));
      const stopping = registry.stop('mc');
      await vi.advanceTimersByTimeAsync(0);
      const op = vi.fn();

      await expect(registry.withBackend('mc', op)).rejects.toBeInstanceOf(NoSessionError);
      release();
      await stopping;

      expect(op).not.toHaveBeenCalled();
      expect(publicIp.detect).not.toHaveBeenCalled();
      expect(fm.reauthorizeOperatorIp).not.toHaveBeenCalled();
    });

    it('should not re-authorize when the session is dropped while the IP is being detected', async () => {
      const { registry, fm, publicIp } = harness();
      await registry.acquire('mc', 'browse');
      let resolveDetect!: (ip: string) => void;
      publicIp.detect.mockImplementation(() => new Promise<string>((resolve) => { resolveDetect = resolve; }));
      const original = unreachable();
      const op = vi.fn().mockRejectedValue(original);

      const running = registry.withBackend('mc', op);
      await vi.advanceTimersByTimeAsync(0);
      await registry.stop('mc');
      resolveDetect('198.51.100.9');

      await expect(running).rejects.toBe(original);
      expect(fm.reauthorizeOperatorIp).not.toHaveBeenCalled();
      expect(op).toHaveBeenCalledTimes(1);
    });

    it('should fail the session closed when an operation hits a pin mismatch', async () => {
      const { registry, fm, backend, publicIp } = harness();
      await registry.acquire('mc', 'browse');
      const op = vi.fn().mockRejectedValue(new PinMismatchError());

      await expect(registry.withBackend('mc', op)).rejects.toBeInstanceOf(PinMismatchError);

      expect(op).toHaveBeenCalledTimes(1);
      expect(publicIp.detect).not.toHaveBeenCalled();
      expect(backend.close).toHaveBeenCalledTimes(1);
      expect(fm.stop).toHaveBeenCalledWith('mc');
      expect(registry.ownedGames().has('mc')).toBe(false);
      expect(await registry.status('mc')).toMatchObject({ state: 'failed' });
    });

    it('should stop the helper once when concurrent operations all hit a pin mismatch', async () => {
      const { registry, fm } = harness();
      await registry.acquire('mc', 'browse');
      const op = () => vi.fn().mockRejectedValue(new PinMismatchError());

      await Promise.allSettled([registry.withBackend('mc', op()), registry.withBackend('mc', op())]);

      expect(fm.stop).toHaveBeenCalledTimes(1);
    });
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
