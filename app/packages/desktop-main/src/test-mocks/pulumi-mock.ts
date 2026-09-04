import type {
  PulumiDestroyResult,
  PulumiPreviewResult,
  PulumiRunChunk,
  PulumiRunRecord,
  PulumiUpResult,
} from '../services/PulumiService.js';
import type { DeploymentConfigDiff, StackOutputs } from '@hyveon/shared';

/** Which long-running Pulumi operation a stub reports as in flight — mirrors `PulumiService.getOperationInFlight()`'s return type exactly. */
export type PulumiOperationName = 'preview' | 'up' | 'destroy' | 'rollback';

/**
 * A scripted outcome for one `preview()`/`apply()`/`destroy()` run driven
 * through {@link PulumiServiceStub} — the chunks yielded (in order) before
 * the run settles, then either a success `result` or a `failure` thrown
 * instead. Mirrors the two ways a real `PulumiService` operation actually
 * settles: `result`/`failure` are mutually exclusive, exactly like a real
 * async generator either `return`s or `throw`s, never both.
 */
export interface ScriptedPulumiRun<TResult> {
  /** Lines yielded, in order, before the run settles. Defaults to no chunks. */
  chunks?: PulumiRunChunk[];
  /** The value the generator returns once the run succeeds. Ignored if `failure` is also set. */
  result?: TResult;
  /** If set, the generator throws this once every chunk has been yielded, instead of returning `result`. */
  failure?: unknown;
}

/** The zero-chunks, no-result, no-failure default every `script*` run setter starts from — an empty generator, exactly like `iac.controller.test.ts`'s `makePulumi()` default. */
const EMPTY_RUN: ScriptedPulumiRun<never> = {};

/**
 * Drives one {@link ScriptedPulumiRun}: yields its chunks in order, then
 * either throws `failure` or returns `result`. Shared by every
 * {@link PulumiServiceStub} generator method so `preview`/`apply`/`destroy`
 * only need to supply which scripted run to play back.
 */
async function* playScriptedRun<TResult>(
  run: ScriptedPulumiRun<TResult>,
): AsyncGenerator<PulumiRunChunk, TResult | undefined> {
  for (const chunk of run.chunks ?? []) {
    yield chunk;
  }
  if (run.failure !== undefined) {
    throw run.failure;
  }
  return run.result;
}

/**
 * In-process stand-in for `PulumiService`, substituted at the DI seam via
 * `ipc-harness.ts`'s `createIpcHarness()` — the `orchestrator-integration-coverage`
 * delta spec's "In-process engine stub injected via DI" requirement.
 *
 * Every method is a plain in-memory implementation: no subprocess is ever
 * spawned, no real Pulumi engine binary is ever downloaded, and no real AWS
 * call is ever issued — so any integration spec dispatched through a harness
 * built with this stub is structurally incapable of reaching real infra.
 *
 * `getStackOutputs()`/`preview()`/`apply()`/`destroy()`/
 * `getOperationInFlight()`/`mintDestroyConfirmationToken()` are scriptable via
 * the `script*` setters below; other methods have no setter yet and resolve
 * fixed placeholder values. `reset()` re-arms a fresh default mid-test.
 */
export class PulumiServiceStub {
  private stackOutputs: StackOutputs | null = null;
  private operationInFlight: PulumiOperationName | null = null;
  private destroyToken = 'stub-destroy-confirmation-token';
  private previewRun: ScriptedPulumiRun<PulumiPreviewResult> = EMPTY_RUN;
  private applyRun: ScriptedPulumiRun<PulumiUpResult> = EMPTY_RUN;
  private destroyRun: ScriptedPulumiRun<PulumiDestroyResult> = EMPTY_RUN;

  // Scripting API (spec-facing)

  /** Scripts `getStackOutputs()`'s next resolution — `null` models a never-deployed stack. */
  scriptStackOutputs(outputs: StackOutputs | null): void {
    this.stackOutputs = outputs;
  }

  /** Scripts `getOperationInFlight()`'s next return value — `null` (the default) means the workspace is free. */
  scriptOperationInFlight(op: PulumiOperationName | null): void {
    this.operationInFlight = op;
  }

  /** Scripts the token `mintDestroyConfirmationToken()` returns next. */
  scriptDestroyToken(token: string): void {
    this.destroyToken = token;
  }

  /** Scripts `preview()`'s next run — chunks yielded, then either `result` or `failure`. */
  scriptPreview(run: ScriptedPulumiRun<PulumiPreviewResult>): void {
    this.previewRun = run;
  }

  /** Scripts `apply()`'s next run — chunks yielded, then either `result` or `failure`. */
  scriptApply(run: ScriptedPulumiRun<PulumiUpResult>): void {
    this.applyRun = run;
  }

  /** Scripts `destroy()`'s next run — chunks yielded, then either `result` or `failure`. */
  scriptDestroy(run: ScriptedPulumiRun<PulumiDestroyResult>): void {
    this.destroyRun = run;
  }

  /** Restores every scripted response to its default (never-deployed / workspace-free / empty-run) shape. */
  reset(): void {
    this.stackOutputs = null;
    this.operationInFlight = null;
    this.destroyToken = 'stub-destroy-confirmation-token';
    this.previewRun = EMPTY_RUN;
    this.applyRun = EMPTY_RUN;
    this.destroyRun = EMPTY_RUN;
  }

  // `PulumiService`-shaped surface (consumer-facing)

  /** @see PulumiService.getStackOutputs */
  async getStackOutputs(): Promise<StackOutputs | null> {
    return this.stackOutputs;
  }

  /** @see PulumiService.getOperationInFlight */
  getOperationInFlight(): PulumiOperationName | null {
    return this.operationInFlight;
  }

  /** @see PulumiService.mintDestroyConfirmationToken */
  mintDestroyConfirmationToken(): string {
    return this.destroyToken;
  }

  /** @see PulumiService.initializeStack — no-op; there is no real workspace to provision against an in-memory stub. */
  async initializeStack(): Promise<void> {
    /* no-op */
  }

  /** @see PulumiService.preview */
  async *preview(): AsyncGenerator<PulumiRunChunk, PulumiPreviewResult | undefined> {
    return yield* playScriptedRun(this.previewRun);
  }

  /** @see PulumiService.apply */
  async *apply(): AsyncGenerator<PulumiRunChunk, PulumiUpResult | undefined> {
    return yield* playScriptedRun(this.applyRun);
  }

  /** @see PulumiService.destroy */
  async *destroy(): AsyncGenerator<PulumiRunChunk, PulumiDestroyResult | undefined> {
    return yield* playScriptedRun(this.destroyRun);
  }

  /** @see PulumiService.confirmRollback — empty generator; no `script*` setter yet. */
  async *confirmRollback(): AsyncGenerator<PulumiRunChunk, PulumiPreviewResult | undefined> {
    return yield* playScriptedRun(EMPTY_RUN as ScriptedPulumiRun<PulumiPreviewResult>);
  }

  /** @see PulumiService.resolveRollbackTarget — fixed placeholder; no `script*` setter yet. */
  async resolveRollbackTarget(): Promise<{ versionId: string; lastModified: Date }> {
    return { versionId: 'stub-prior-version', lastModified: new Date(0) };
  }

  /** @see PulumiService.computeRollbackDiff — resolves "no diff available"; no `script*` setter yet. */
  async computeRollbackDiff(): Promise<DeploymentConfigDiff | undefined> {
    return undefined;
  }

  /** @see PulumiService.clearStaleLock — resolves immediately ("cleared successfully"); no `script*` setter yet. */
  async clearStaleLock(): Promise<void> {
    /* no-op */
  }

  /** @see PulumiService.computePlanHash — fixed placeholder hash; no `script*` setter yet. */
  computePlanHash(): string {
    return 'stub-plan-hash';
  }

  /** @see PulumiService.readRunRecord — no persisted record; no `script*` setter yet. */
  readRunRecord(): PulumiRunRecord | null {
    return null;
  }

  /** @see PulumiService.hasPlanArtifact — no persisted artifact; no `script*` setter yet. */
  hasPlanArtifact(): boolean {
    return false;
  }

  /** @see PulumiService.streamRunOutput — empty generator; no `script*` setter yet. */
  async *streamRunOutput(): AsyncGenerator<PulumiRunChunk, void> {
    /* empty */
  }
}
