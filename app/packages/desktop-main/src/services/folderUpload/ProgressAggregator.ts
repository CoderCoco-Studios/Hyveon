import type { FolderUploadPhase, FolderUploadProgress, OverwriteSummary } from '@hyveon/shared/folderUpload';

/** How often a snapshot is emitted while a run is active. */
export const PROGRESS_INTERVAL_MS = 500;
/** Weight given to the newest rate sample in the exponential moving average. */
const RATE_SMOOTHING = 0.3;
/** Samples required before an ETA is reported, so a cold start does not produce a wild estimate. */
const MIN_SAMPLES_FOR_ETA = 3;

// @spec HELPER-PROG-002, HELPER-PROG-003
/**
 * Accumulates byte/file counts from concurrent uploads and emits a {@link FolderUploadProgress} snapshot on a fixed
 * interval with a smoothed transfer rate and ETA.
 *
 * @remarks
 * Bytes are counted as the socket accepts them, so `bytesDone` can run ahead of what has landed; the run only reports
 * the `done` phase after verification confirms the volume's contents.
 */
export class ProgressAggregator {
  private phase: FolderUploadPhase = 'starting-helper';
  private bytesDone = 0;
  private filesDone = 0;
  private currentPath: string | undefined;
  private rate = 0;
  private samples = 0;
  private lastTickBytes = 0;
  private lastTickAt: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private error: string | undefined;
  private overwrite: OverwriteSummary | undefined;

  constructor(
    private readonly game: string,
    private bytesTotal: number,
    private filesTotal: number,
    private readonly emit: (progress: FolderUploadProgress) => void,
    private readonly now: () => number = Date.now,
  ) {
    this.lastTickAt = now();
  }

  /** Begins periodic emission; also emits one snapshot immediately. */
  start(): void {
    this.lastTickAt = this.now();
    this.emit(this.snapshot());
    this.timer = setInterval(() => this.tick(), PROGRESS_INTERVAL_MS);
  }

  /** Stops periodic emission and emits one final snapshot. */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.emit(this.snapshot());
  }

  /** Moves to `phase` (optionally recording a failure message) and emits immediately. */
  setPhase(phase: FolderUploadPhase, error?: string): void {
    this.phase = phase;
    this.error = error;
    if (phase !== 'uploading') this.currentPath = undefined;
    if (phase !== 'awaiting-confirmation') this.overwrite = undefined;
    this.emit(this.snapshot());
  }

  /** Attaches the overwrite summary the next `awaiting-confirmation` snapshot carries; cleared on any other phase. */
  setOverwrite(summary: OverwriteSummary): void {
    this.overwrite = summary;
  }

  /** Adds (or, on a failed attempt, removes with a negative value) uploaded bytes. */
  addBytes(n: number): void {
    this.bytesDone = Math.max(0, this.bytesDone + n);
  }

  /**
   * Counts bytes of a resume-skipped file as done without contributing a rate sample: advances the tick baseline
   * together with `bytesDone`, so the next tick does not read them as one interval's throughput.
   */
  addSkippedBytes(n: number): void {
    this.bytesDone += n;
    this.lastTickBytes += n;
  }

  /** Records a finished (or resume-skipped) file. */
  fileDone(): void {
    this.filesDone += 1;
  }

  /** Sets the file currently in flight. */
  setCurrent(path: string | undefined): void {
    this.currentPath = path;
  }

  /** Current snapshot without emitting it. */
  snapshot(): FolderUploadProgress {
    const remaining = Math.max(0, this.bytesTotal - this.bytesDone);
    const etaSeconds = this.samples >= MIN_SAMPLES_FOR_ETA && this.rate > 0 ? Math.ceil(remaining / this.rate) : undefined;
    return {
      game: this.game,
      phase: this.phase,
      bytesDone: this.bytesDone,
      bytesTotal: this.bytesTotal,
      filesDone: this.filesDone,
      filesTotal: this.filesTotal,
      currentPath: this.currentPath,
      bytesPerSecond: Math.round(this.rate),
      etaSeconds,
      error: this.error,
      overwrite: this.overwrite,
    };
  }

  private tick(): void {
    const at = this.now();
    const seconds = (at - this.lastTickAt) / 1000;
    if (seconds > 0 && this.phase === 'uploading') {
      const instant = Math.max(0, this.bytesDone - this.lastTickBytes) / seconds;
      this.rate = this.samples === 0 ? instant : RATE_SMOOTHING * instant + (1 - RATE_SMOOTHING) * this.rate;
      this.samples += 1;
    }
    this.lastTickBytes = this.bytesDone;
    this.lastTickAt = at;
    this.emit(this.snapshot());
  }
}
