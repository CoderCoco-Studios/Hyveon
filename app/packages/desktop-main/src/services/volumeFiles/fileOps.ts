import { errMessage } from '@hyveon/shared';
import { normalizeVolumePath, VolumePathError, type VolumeEntryInfo, type VolumeRef, type VolumeResult } from '@hyveon/shared/volumeFiles';
import { logger } from '../../logger.js';
import { ConfigService } from '../ConfigService.js';
import { EcsService } from '../EcsService.js';
import { isVolumeMounted, toHelperPath, type HelperVolumeLayout } from './helperVolumeLayout.js';
import { HelperSessionRegistry } from './HelperSessionRegistry.js';
import type { VolumeFileBackend } from './VolumeFileBackend.js';
import { fail, logRefusal, toVolumeResult, type OpNames, type VolumeFailure } from './volumeFileErrors.js';

/** How long one metadata operation (list, stat, mkdir, move, remove, small text read or write) may take. */
export const METADATA_OP_TIMEOUT_MS = 30_000;

/** The pieces of an open session a file operation works with. */
export interface FileIo {
  backend: VolumeFileBackend;
  /** Aborts the operation after {@link METADATA_OP_TIMEOUT_MS}; created per attempt. */
  signal: AbortSignal;
  /** Maps a clean volume path to the helper's path for this request's volume. */
  helperPath: (volumePath: string) => string;
}

/**
 * Normalizes `path` and rejects the volume root, which no operation may remove or rename.
 *
 * @param path - Volume path to validate.
 * @param what - What the root is called in the message.
 * @throws {@link VolumePathError} for the root or an invalid path.
 */
export function requireNotRoot(path: string, what: string): string {
  const clean = normalizeVolumePath(path);
  if (clean === '/') throw new VolumePathError(`${what} can't be changed.`);
  return clean;
}

/** Stats a path just written; `fallback` stands in (modification time 0 = unknown) when the stat fails. */
export async function entryAt(io: FileIo, volumePath: string, fallback: VolumeEntryInfo): Promise<VolumeEntryInfo> {
  try {
    const { isDir, size, modifiedMs } = await io.backend.stat(io.helperPath(volumePath), io.signal);
    return { name: fallback.name, isDir, size, modifiedMs };
  } catch {
    return fallback;
  }
}

/**
 * The checks and session plumbing shared by every file operation: validate, check the server and the volume, run
 * inside the helper session, and map failures to a {@link VolumeResult}.
 */
export class FileOps {
  constructor(
    private readonly registry: HelperSessionRegistry,
    private readonly config: ConfigService,
    private readonly ecs: EcsService,
  ) {}

  /**
   * Runs one file operation: validate, check the server, run inside the session, map failures.
   *
   * @param ref - Game and volume.
   * @param spec - Whether it mutates, the raw path (for logs), and a validator that throws {@link VolumePathError}.
   * @param run - The work, given the session and the validated parameters; may return a modeled refusal.
   */
  async run<P extends { names: OpNames | undefined }, T>(
    ref: VolumeRef,
    spec: { mutates: boolean; path: string; validate: () => P },
    run: (io: FileIo, params: P) => Promise<VolumeResult<T>>,
  ): Promise<VolumeResult<T>> {
    let names: OpNames = { missing: spec.path, existing: spec.path };
    let result: VolumeResult<T>;
    try {
      const params = spec.validate();
      names = params.names ?? { missing: spec.path, existing: spec.path };
      const refusal = spec.mutates ? await this.assertWritable(ref.game) : null;
      result =
        refusal ??
        (await this.registry.withBackend(ref.game, async (backend, layout) => {
          const volumeRefusal = this.checkVolume(ref, layout, spec.mutates);
          if (volumeRefusal) return volumeRefusal;
          const io: FileIo = {
            backend,
            signal: AbortSignal.timeout(METADATA_OP_TIMEOUT_MS),
            helperPath: (volumePath) => toHelperPath(layout, ref.volume, volumePath),
          };
          return run(io, params);
        }));
    } catch (err) {
      return toVolumeResult(err, ref, spec.path, names);
    }
    return result.ok ? result : logRefusal(ref, spec.path, result);
  }

  /** Refuses a volume the session did not mount, and mutations of a legacy fallback layout. */
  private checkVolume(ref: VolumeRef, layout: HelperVolumeLayout, mutates: boolean): VolumeFailure | null {
    if (!isVolumeMounted(layout, ref.volume)) {
      const unapplied = layout.unmounted.some((u) => u.volume === ref.volume);
      return fail(
        'unknown-volume',
        unapplied ? `Apply the infrastructure to browse '${ref.volume}'.` : `'${ref.volume}' is not a volume of '${ref.game}'.`,
      );
    }
    if (mutates && layout.usedFallback) return fail('apply-needed', 'Apply the infrastructure to change files in this volume.');
    return null;
  }

  /**
   * Refuses a change while the game's server task exists or its state can't be confirmed (fail closed).
   *
   * @param game - Game whose server must be stopped.
   * @returns A refusal, or `null` when the server is confirmed stopped.
   */
  async assertWritable(game: string): Promise<VolumeFailure | null> {
    try {
      const outputs = await this.config.getStackOutputs();
      if (!outputs) throw new Error('The infrastructure outputs are not available.');
      const task = await this.ecs.findRunningTaskOrThrow(outputs.ecsClusterName, game);
      return task ? fail('server-running', `'${game}' is running. Stop the server to change files.`) : null;
    } catch (err) {
      logger.warn('VolumeFilesService: server state unconfirmed, refusing change', { game, error: errMessage(err) });
      return fail('server-check-failed', "Couldn't confirm the server is stopped.");
    }
  }
}
