import type { VolumeRef } from '@hyveon/shared/volumeFiles';

/** The outcome of {@link UploadReservations.tryReserve}. */
export type ReserveResult = { ok: true; release: () => void } | { ok: false; conflict: string };

/**
 * An in-process, per-game set of volume paths that one operation is about to create or rewrite.
 *
 * @remarks
 * FileBrowser's `overwrite=false` is a check followed by a truncating open, not an atomic create, and this app is the
 * only client of the helper, so reserving a target here is what keeps two of its own operations from interleaving on
 * it. Reservations never block: a taken path is reported at once.
 */
export class UploadReservations {
  private readonly held = new Map<string, Set<string>>();

  // @spec HELPER-RSV-001
  /**
   * Reserves every path of `paths` for `ref`'s volume, or none of them.
   *
   * @param ref - Game and volume the paths belong to.
   * @param paths - Normalized volume paths to reserve.
   * @returns A one-shot `release` on success, or the first `conflict` path that is already reserved.
   */
  tryReserve(ref: VolumeRef, paths: string[]): ReserveResult {
    const keys = paths.map((path) => `${ref.volume}\0${path}`);
    const taken = this.held.get(ref.game) ?? new Set<string>();
    const clash = keys.findIndex((key) => taken.has(key));
    if (clash !== -1) return { ok: false, conflict: paths[clash]! };
    for (const key of keys) taken.add(key);
    this.held.set(ref.game, taken);
    let released = false;
    return {
      ok: true,
      release: () => {
        if (released) return;
        released = true;
        for (const key of keys) taken.delete(key);
        if (taken.size === 0 && this.held.get(ref.game) === taken) this.held.delete(ref.game);
      },
    };
  }
}
