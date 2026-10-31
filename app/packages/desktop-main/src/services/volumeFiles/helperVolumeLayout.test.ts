import { describe, it, expect } from 'vitest';
import { VolumePathError } from '@hyveon/shared/volumeFiles';
import { buildHelperVolumeLayout, isVolumeMounted, toHelperPath } from './helperVolumeLayout.js';
import { configAndSavesVolumes } from '../../testing/deployment-config.fixture.js';

const CONFIG_AND_SAVES = configAndSavesVolumes();

describe('buildHelperVolumeLayout', () => {
  it('should mount each applied volume under its own directory', () => {
    const layout = buildHelperVolumeLayout('mc', CONFIG_AND_SAVES, {
      efsAccessPoints: { mc: 'fsap-c' },
      efsVolumeAccessPoints: { mc: { config: 'fsap-c', saves: 'fsap-s' } },
    });

    expect(layout.mounts).toEqual([
      { volume: 'config', containerPath: '/data/config', dir: 'config', accessPointId: 'fsap-c', taskVolumeName: 'vol-0' },
      { volume: 'saves', containerPath: '/data/saves', dir: 'saves', accessPointId: 'fsap-s', taskVolumeName: 'vol-1' },
    ]);
    expect(layout.unmounted).toEqual([]);
    expect(layout.usedFallback).toBe(false);
  });

  it('should fall back to an index directory for an unsafe or duplicate volume name', () => {
    const volumes = ['../x', 'a b', 'saves', 'saves'].map((name) => ({ name, container_path: '/data' }));
    const layout = buildHelperVolumeLayout('mc', volumes, {
      efsAccessPoints: {},
      efsVolumeAccessPoints: { mc: { '../x': 'a', 'a b': 'b', saves: 'c' } },
    });

    expect(layout.mounts.map((m) => m.dir)).toEqual(['volume-0', 'volume-1', 'volume-2', 'volume-3']);
  });

  it('should not let a volume named like an index directory collide with a fallback directory', () => {
    const volumes = [
      { name: 'volume-1', container_path: '/a' },
      { name: '../x', container_path: '/b' },
    ];
    const layout = buildHelperVolumeLayout('mc', volumes, {
      efsAccessPoints: {},
      efsVolumeAccessPoints: { mc: { 'volume-1': 'a', '../x': 'b' } },
    });

    expect(layout.mounts.map((m) => m.dir)).toEqual(['volume-0', 'volume-1']);
  });

  it.each(['.', '..', 'a'.repeat(65), ''])('should not use %j as a directory name', (name) => {
    const layout = buildHelperVolumeLayout('mc', [{ name, container_path: '/data' }], {
      efsAccessPoints: {},
      efsVolumeAccessPoints: { mc: { [name]: 'fsap-1' } },
    });

    expect(layout.mounts[0]?.dir).toBe('volume-0');
  });

  it('should mount only the first volume when the per-volume output is missing', () => {
    const layout = buildHelperVolumeLayout('mc', CONFIG_AND_SAVES, {
      efsAccessPoints: { mc: 'fsap-1' },
      efsVolumeAccessPoints: {},
    });

    expect(layout.mounts).toEqual([
      { volume: 'config', containerPath: '/data/config', dir: 'config', accessPointId: 'fsap-1', taskVolumeName: 'vol-0' },
    ]);
    expect(layout.unmounted).toEqual([{ volume: 'saves', containerPath: '/data/saves' }]);
    expect(layout.usedFallback).toBe(true);
  });

  it('should mount nothing on the fallback path when the game has no access point', () => {
    const layout = buildHelperVolumeLayout('mc', CONFIG_AND_SAVES, { efsAccessPoints: {}, efsVolumeAccessPoints: {} });

    expect(layout.mounts).toEqual([]);
    expect(layout.unmounted).toHaveLength(2);
  });

  it('should mount the first access point for a deployed-only game on a stack without the per-volume output', () => {
    const layout = buildHelperVolumeLayout('mc', [], { efsAccessPoints: { mc: 'fsap-1' }, efsVolumeAccessPoints: {} });

    expect(layout.mounts).toEqual([
      { volume: '', containerPath: '', dir: 'volume-0', accessPointId: 'fsap-1', taskVolumeName: 'vol-0' },
    ]);
    expect(layout.unmounted).toEqual([]);
    expect(layout.usedFallback).toBe(true);
  });

  it('should list a declared but unapplied volume as unmounted', () => {
    const volumes = [...CONFIG_AND_SAVES, { name: 'mods', container_path: '/data/mods' }];
    const layout = buildHelperVolumeLayout('mc', volumes, {
      efsAccessPoints: { mc: 'fsap-c' },
      efsVolumeAccessPoints: { mc: { config: 'fsap-c', saves: 'fsap-s' } },
    });

    expect(layout.mounts.map((m) => m.volume)).toEqual(['config', 'saves']);
    expect(layout.unmounted).toEqual([{ volume: 'mods', containerPath: '/data/mods' }]);
    expect(layout.usedFallback).toBe(false);
  });

  it('should keep a volume index stable when an earlier volume is unmounted', () => {
    const layout = buildHelperVolumeLayout('mc', CONFIG_AND_SAVES, {
      efsAccessPoints: {},
      efsVolumeAccessPoints: { mc: { saves: 'fsap-s' } },
    });

    expect(layout.mounts).toEqual([
      { volume: 'saves', containerPath: '/data/saves', dir: 'saves', accessPointId: 'fsap-s', taskVolumeName: 'vol-1' },
    ]);
  });

  it('should derive volumes from the exported access points when the game has no declared volumes', () => {
    const layout = buildHelperVolumeLayout('mc', [], {
      efsAccessPoints: {},
      efsVolumeAccessPoints: { mc: { data: 'fsap-d', logs: 'fsap-l' } },
    });

    expect(layout.mounts.map((m) => [m.volume, m.dir, m.accessPointId])).toEqual([
      ['data', 'data', 'fsap-d'],
      ['logs', 'logs', 'fsap-l'],
    ]);
    expect(layout.unmounted).toEqual([]);
  });
});

describe('toHelperPath / isVolumeMounted', () => {
  const layout = buildHelperVolumeLayout(
    'mc',
    [...CONFIG_AND_SAVES, { name: 'mods', container_path: '/data/mods' }],
    { efsAccessPoints: {}, efsVolumeAccessPoints: { mc: { config: 'fsap-c', saves: 'fsap-s' } } },
  );

  it('should map a volume path to its helper path and refuse an unmounted volume', () => {
    expect(toHelperPath(layout, 'saves', '/worlds')).toBe('/saves/worlds');
    expect(toHelperPath(layout, 'saves', '/')).toBe('/saves');
    expect(toHelperPath(layout, 'config', '/a/b/')).toBe('/config/a/b');
    expect(() => toHelperPath(layout, 'mods', '/')).toThrow(VolumePathError);
    expect(() => toHelperPath(layout, 'nope', '/')).toThrow(VolumePathError);
  });

  it('should refuse an unclean volume path', () => {
    expect(() => toHelperPath(layout, 'saves', '/../config')).toThrow(VolumePathError);
  });

  it('should report which volumes are mounted', () => {
    expect(isVolumeMounted(layout, 'saves')).toBe(true);
    expect(isVolumeMounted(layout, 'mods')).toBe(false);
    expect(isVolumeMounted(layout, 'nope')).toBe(false);
  });
});
