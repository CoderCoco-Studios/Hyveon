import type { StackOutputs } from '@hyveon/shared';
import { normalizeVolumePath, VolumePathError } from '@hyveon/shared/volumeFiles';

/** Directory names that are safe as one path segment under the helper's `/srv` root. */
const SAFE_DIR_NAME = /^[A-Za-z0-9._-]{1,64}$/;
/** The index-based fallback directory shape; a volume named like this would collide with another volume's fallback. */
const INDEX_DIR_NAME = /^volume-\d+$/;

/** One declared volume the helper mounts. */
export interface HelperVolumeMount {
  /** The volume's name in the game's configuration. */
  volume: string;
  /** The volume's mount path inside the game container (`''` for a volume known only from the stack outputs). */
  containerPath: string;
  /** Directory name under the helper's `/srv` root; the volume is mounted at `/srv/<dir>`. */
  dir: string;
  accessPointId: string;
  /** Name of the ECS task-definition volume (`vol-<index>`). */
  taskVolumeName: string;
}

/** Which of a game's volumes a helper mounts, and where. Main-process only; never crosses IPC. */
export interface HelperVolumeLayout {
  mounts: HelperVolumeMount[];
  /** Declared volumes with no exported access point yet (apply needed). */
  unmounted: { volume: string; containerPath: string }[];
  /** True when the per-volume output was missing and only the first volume was mounted via `efsAccessPoints`. */
  usedFallback: boolean;
}

/**
 * Plans which of a game's volumes the file-manager helper mounts and under which directory.
 *
 * @remarks
 * Volume names are free-form, so one is used as the directory only when it is a safe single path segment, is not
 * `.`/`..`, is unique among the game's volumes, and does not look like a fallback name; otherwise the directory is
 * `volume-<index>`, the index being the volume's position among all declared volumes (mounted or not) so it never shifts.
 * When `efsVolumeAccessPoints[game]` is absent (a stack applied by an older build) only the first volume is mounted,
 * through `efsAccessPoints[game]`.
 *
 * @param game - Game the helper is for.
 * @param volumes - The game's declared volumes; when empty (a deployed-only game) the volumes are taken from the keys of
 * `efsVolumeAccessPoints[game]`, with no container path.
 * @param outputs - The deployed stack's access point outputs.
 */
export function buildHelperVolumeLayout(
  game: string,
  volumes: readonly { name: string; container_path: string }[],
  outputs: Pick<StackOutputs, 'efsAccessPoints' | 'efsVolumeAccessPoints'>,
): HelperVolumeLayout {
  const perVolume = outputs.efsVolumeAccessPoints[game];
  const declared =
    volumes.length > 0 ? volumes : Object.keys(perVolume ?? {}).map((name) => ({ name, container_path: '' }));
  const nameCounts = new Map<string, number>();
  for (const { name } of declared) nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
  const isSafeDir = (name: string): boolean =>
    SAFE_DIR_NAME.test(name) && name !== '.' && name !== '..' && !INDEX_DIR_NAME.test(name) && nameCounts.get(name) === 1;

  const accessPointOf = (name: string, index: number): string | undefined => {
    if (perVolume) return perVolume[name];
    return index === 0 ? outputs.efsAccessPoints[game] : undefined;
  };

  const layout: HelperVolumeLayout = { mounts: [], unmounted: [], usedFallback: perVolume === undefined };
  declared.forEach((volume, index) => {
    const accessPointId = accessPointOf(volume.name, index);
    if (!accessPointId) {
      layout.unmounted.push({ volume: volume.name, containerPath: volume.container_path });
      return;
    }
    layout.mounts.push({
      volume: volume.name,
      containerPath: volume.container_path,
      dir: isSafeDir(volume.name) ? volume.name : `volume-${index}`,
      accessPointId,
      taskVolumeName: `vol-${index}`,
    });
  });
  return layout;
}

/** True when `volume` has a mount in `layout`. */
export function isVolumeMounted(layout: HelperVolumeLayout, volume: string): boolean {
  return layout.mounts.some((m) => m.volume === volume);
}

/**
 * Maps a path inside `volume` to its path under the helper's root (`/<dir><path>`).
 *
 * @param layout - The layout the helper was launched with.
 * @param volume - Volume name.
 * @param volumePath - Clean absolute path inside the volume.
 * @throws VolumePathError when the volume is not mounted or `volumePath` is not clean.
 */
export function toHelperPath(layout: HelperVolumeLayout, volume: string, volumePath: string): string {
  const mount = layout.mounts.find((m) => m.volume === volume);
  if (!mount) throw new VolumePathError(`Volume ${JSON.stringify(volume)} is not mounted in the file manager helper`);
  const path = normalizeVolumePath(volumePath);
  return path === '/' ? `/${mount.dir}` : `/${mount.dir}${path}`;
}
