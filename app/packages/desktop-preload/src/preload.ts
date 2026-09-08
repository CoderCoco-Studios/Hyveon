/**
 * Electron preload script.
 *
 * Runs in a sandboxed Node context before the renderer loads. Exposes a
 * typed `window.hyveon` bridge via `contextBridge` so the renderer can call
 * into the main process over IPC without any direct access to Node or
 * Electron internals — this is the app's only surface, and it never opens an
 * HTTP transport (see `openspec/specs/desktop-only-operator-surface`).
 *
 * Channel naming convention: `<namespace>.<action>`
 *
 * There is no bearer token, no `fetch`, and no API base URL anywhere in this file — the desktop
 * app has no HTTP transport at all. `desktop-main` is an Electron IPC microservice; every call
 * crosses the `contextBridge` above, never a network socket. See
 * `openspec/specs/desktop-only-operator-surface`.
 *
 * ## Streaming channels and the contextBridge clone boundary
 *
 * `contextBridge.exposeInMainWorld` structured-clones every value crossing
 * the isolated-world boundary. Neither a raw `AsyncGenerator` nor a raw
 * `AbortSignal` survives that clone: a generator throws synchronously
 * (`Uncaught Error: An object could not be cloned.`) the instant a bridged
 * function returns one, and a signal arrives on the other side as an inert
 * object with no own keys (its `aborted` getter and `addEventListener`
 * method live on its prototype, which the clone drops). Every streaming
 * channel below is therefore split into two layers:
 *
 * - A **preload-internal** `async function*` (`streamLogs`, `streamLambdaLogs`,
 *   `streamStackInitialize`, `streamIacRunLogs`) — each built by
 *   {@link createBufferedStream} in `stream-bridge.ts`, which does the real
 *   IPC listener wiring and still accepts a real `AbortSignal` — this signal
 *   is always minted *inside* preload by a `bridgeStream` wrapper, so it
 *   never itself crosses the bridge.
 * - A thin **bridge-facing wrapper** (`openLogsStream`, `openLambdaLogsStream`,
 *   `openStackInitializeStream`, `openIacRunLogsStream`) that mints an
 *   `AbortController`, calls the internal generator with its signal, and
 *   hands the renderer a {@link HyveonStreamHandle} — a plain object with an
 *   own `next()`, an own `cancel()`, and an own `[Symbol.asyncIterator]`
 *   returning itself. This shape was empirically verified to survive the
 *   clone boundary intact and remains directly usable in a renderer-side
 *   `for await` loop over the handle. `cancel()` aborts the wrapper's
 *   internal controller, driving the same cancellation path the internal
 *   generator already had.
 *
 * `createBufferedStream` is called four times, here, to produce those four separately-named
 * generators — it is never used to build the exposed `window.hyveon` object itself, which stays a
 * plain object literal of statically named, own-enumerable properties (see `hyveon-api.ts`'s
 * {@link HyveonStreamHandle} doc for why a Proxy/generated surface can't cross the bridge either).
 * See each `streamX`/`openXStream` function's own doc for its channel names and streamId-filtering
 * details; `iac.plan`/`iac.runs.get`/`iac.runs.list`/`iac.runs.logUrl` are plain `invoke` calls
 * with no streaming involved.
 */

import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';

import { createBufferedStream } from './stream-bridge.js';

import type {
  AutoUpdateSettingGetResult,
  AutoUpdateSettingUpdatePayload,
  AutoUpdateSettingWriteResult,
  CreateGamePayload,
  DeleteGamePayload,
  DeploymentSettingsGetResult,
  DeploymentSettingsWriteResult,
  GameWizardDraft,
  HyveonApi,
  HyveonStreamHandle,
  HyveonTestApi,
  LogChunk,
  ManualUpdateCheckResult,
  PulumiEngineVersionResult,
  IacApplyPayload,
  IacApproveAck,
  IacDestroyMintAck,
  IacDestroyPayload,
  IacLockClearAck,
  IacLockClearMintAck,
  IacLockClearPayload,
  IacPlanAck,
  IacPlanPayload,
  IacRollbackConfirmAck,
  IacRollbackResolveAck,
  IacRunChunk,
  IacRunsGetResult,
  IacRunsListOpts,
  IacRunsLockClearAck,
  IacRunsLockClearPayload,
  IacRunsLockMintAck,
  IacRunsLockMintPayload,
  LambdaFunctionKey,
  LambdaLogs,
  NewerLogsPage,
  OlderLogsPage,
  RunHistoryPageResult,
  StackInitPhaseEvent,
  StoredGameWizardDraft,
  UpdateDeploymentSettingsPayload,
  UpdateGamePayload,
  AwsProfileSummary,
  SavePastedCredentialsInput,
  WizardState,
  SaveWizardStateInput,
  BootstrapStateBucketInput,
  BootstrapConfigurationBucketInput,
  BootstrapDeploymentConfigInput,
  BootstrapResult,
  IamCheckResult,
  WizardProgress,
  SaveWizardProgressInput,
  RenderedTemplateResult,
  OpenGuidedIamConsoleInput,
  OpenConsoleResult,
  BootstrapKeyIntakeInput,
  BootstrapKeyIntakeResult,
  RotationInput,
  RotationResult,
  RevokeBootstrapKeyInput,
  RevokeBootstrapKeyResult,
  RendererLogEntry,
} from './hyveon-api.js';
import type { StackOutputs } from '@hyveon/shared';

/** Fixed side-channel `IacController.initializeStack` pushes streamed phase events on. */
const STACK_INIT_CHUNK_CHANNEL = 'iac.stack.initialize.chunk';

/** Fixed side-channel `IacController.initializeStack` sends its terminal message on. */
const STACK_INIT_END_CHANNEL = 'iac.stack.initialize.end';

/** Fixed side-channel `IacRunsController.logs` pushes streamed run output on. */
const IAC_RUNS_LOGS_CHUNK_CHANNEL = 'iac.runs.logs.chunk';

/** Fixed side-channel `IacRunsController.logs` sends its terminal message on. */
const IAC_RUNS_LOGS_END_CHANNEL = 'iac.runs.logs.end';

/**
 * Per-channel mock registry populated by tests via `window.hyveon.__test.mock(channel, handler)`.
 * Each entry is a function (or a plain value) that replaces the real IPC call
 * for that channel.  A `() => value` handler is treated as the mock; a
 * non-function entry is wrapped so the resolver always returns that value.
 */
const mockRegistry: Map<string, (...args: unknown[]) => unknown> = new Map();

/**
 * Registers a mock for the given IPC channel.  If `handler` is not a
 * function it is wrapped in one so callers always receive a Promise.
 *
 * @param channel - IPC channel name, e.g. `'games.list'`.
 * @param handler - Replacement implementation or a plain return value.
 */
function registerMock(channel: string, handler: unknown): void {
  mockRegistry.set(channel, typeof handler === 'function' ? (handler as (...args: unknown[]) => unknown) : () => handler);
}

/**
 * Mock-aware `ipcRenderer.invoke` wrapper.  If a mock is registered for
 * the channel it is called with the supplied args and its return value
 * (synchronous or Promise) is awaited; otherwise the call is forwarded to
 * the real Electron IPC.
 *
 * @param channel - IPC channel name.
 * @param args    - Arguments forwarded to the handler or IPC channel.
 */
function invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T> {
  const mock = mockRegistry.get(channel);
  if (mock !== undefined) {
    try {
      return Promise.resolve(mock(...args)) as Promise<T>;
    } catch (err) {
      return Promise.reject(err) as Promise<T>;
    }
  }
  return ipcRenderer.invoke(channel, ...args) as Promise<T>;
}

/**
 * Preload-internal — never exposed to the renderer directly (see {@link openLogsStream}). Bridges
 * the per-stream `logs.stream.<id>.{chunk,end,cancel}` IPC channels into an
 * {@link AsyncIterable} of log chunks, via {@link createBufferedStream}'s per-call channel style.
 * When a mock is registered for `'logs.stream'` (test mode only), it is called with
 * `(game, signal)` and its return value is treated as an `AsyncIterable<LogChunk>` instead.
 */
const streamLogs = createBufferedStream<string, LogChunk, LogChunk>(
  {
    invokeChannel: 'logs.stream',
    chunkChannel: (id) => `logs.stream.${id}.chunk`,
    endChannel: (id) => `logs.stream.${id}.end`,
    cancelChannel: (id) => `logs.stream.${id}.cancel`,
    mapChunk: (chunk) => chunk,
    checkAck: (ack) => (ack as { streamId: string }).streamId,
  },
  { invoke, mockRegistry },
);

/**
 * Preload-internal — never exposed to the renderer directly (see {@link openLambdaLogsStream}).
 * Bridges the per-stream `logs.lambda.stream.<id>.{chunk,end,cancel}` IPC channels into an
 * {@link AsyncIterable} of log chunks, mirroring {@link streamLogs} exactly. When a mock is
 * registered for `'logs.lambda.stream'` (test mode only), it is called with
 * `(functionKey, signal)`.
 */
const streamLambdaLogs = createBufferedStream<LambdaFunctionKey, LogChunk, LogChunk>(
  {
    invokeChannel: 'logs.lambda.stream',
    chunkChannel: (id) => `logs.lambda.stream.${id}.chunk`,
    endChannel: (id) => `logs.lambda.stream.${id}.end`,
    cancelChannel: (id) => `logs.lambda.stream.${id}.cancel`,
    mapChunk: (chunk) => chunk,
    checkAck: (ack) => (ack as { streamId: string }).streamId,
  },
  { invoke, mockRegistry },
);

/** Raw `iac.stack.initialize` chunk payload, tagged with the `streamId` it belongs to. */
interface StackInitWireChunk {
  streamId: string;
  phase: StackInitPhaseEvent['phase'];
  status: StackInitPhaseEvent['status'];
}

/**
 * Preload-internal — never exposed to the renderer directly (see {@link openStackInitializeStream}).
 * Bridges `IacController.initializeStack`'s fixed `iac.stack.initialize.chunk` /
 * `iac.stack.initialize.end` side channels into an {@link AsyncIterable} of
 * {@link StackInitPhaseEvent}, via {@link createBufferedStream}'s shared-side-channel style.
 *
 * A `false` `started` ack means the shared workspace was already busy and no run was ever
 * attempted — `checkAck` throws immediately using `error`, since no chunk/end will ever arrive.
 * When a mock is registered for `'iac.stack.initialize'` (test mode only), it is called with just
 * `(signal)`.
 */
const streamStackInitialize = createBufferedStream<undefined, StackInitWireChunk, StackInitPhaseEvent>(
  {
    invokeChannel: 'iac.stack.initialize',
    chunkChannel: STACK_INIT_CHUNK_CHANNEL,
    endChannel: STACK_INIT_END_CHANNEL,
    mapChunk: (data) => ({ phase: data.phase, status: data.status }),
    getStreamId: (data) => data.streamId,
    checkAck: (ack) => {
      const a = ack as { started: boolean; streamId?: string; error?: string };
      if (!a.started || !a.streamId) throw new Error(a.error ?? 'iac.stack.initialize failed to start');
      return a.streamId;
    },
  },
  { invoke, mockRegistry },
);

/** Raw `iac.runs.logs` chunk payload, tagged with the `streamId` it belongs to. */
interface IacRunLogsWireChunk {
  streamId: string;
  chunk: IacRunChunk;
}

/**
 * Preload-internal — never exposed to the renderer directly (see {@link openIacRunLogsStream}).
 * Bridges `IacRunsController.logs`'s fixed `iac.runs.logs.chunk` / `iac.runs.logs.end` side
 * channels into an {@link AsyncIterable} of {@link IacRunChunk} for a single run identified by
 * `runId`, via {@link createBufferedStream}'s shared-side-channel style — mirrors
 * {@link streamStackInitialize}, differing only in channel names and the lack of a `started`
 * check on the ack. When a mock is registered for `'iac.runs.logs'` (test mode only), it is
 * called with `(runId, signal)`.
 */
const streamIacRunLogs = createBufferedStream<string, IacRunLogsWireChunk, IacRunChunk>(
  {
    invokeChannel: 'iac.runs.logs',
    chunkChannel: IAC_RUNS_LOGS_CHUNK_CHANNEL,
    endChannel: IAC_RUNS_LOGS_END_CHANNEL,
    mapChunk: (data) => data.chunk,
    getStreamId: (data) => data.streamId,
    checkAck: (ack) => (ack as { streamId: string }).streamId,
    toInvokeArgs: (runId) => [{ runId }],
  },
  { invoke, mockRegistry },
);

/**
 * Wraps a preload-internal `AsyncGenerator` in a plain, contextBridge-safe
 * {@link HyveonStreamHandle} — see the module doc comment's "Streaming
 * channels and the contextBridge clone boundary" section for why a raw
 * `AsyncGenerator` can't be returned to the renderer directly.
 *
 * `next()` delegates straight to `source.next()`. `cancel()` aborts
 * `controller`, which is the same (real, preload-internal-only)
 * `AbortSignal` source `source` was created with — from `source`'s own
 * perspective this is indistinguishable from the renderer aborting a signal
 * it had been handed directly, so none of the three generators' existing
 * `signal.aborted` / `signal.addEventListener('abort', …)` cancellation
 * logic needed to change.
 *
 * @param source - The preload-internal async generator to wrap.
 * @param controller - The `AbortController` `source` was invoked with; never exposed to the renderer.
 */
function bridgeStream<T>(source: AsyncGenerator<T>, controller: AbortController): HyveonStreamHandle<T> {
  const handle: HyveonStreamHandle<T> = {
    next: () => source.next(),
    cancel: () => controller.abort(),
    [Symbol.asyncIterator]: () => handle,
  };
  return handle;
}

/**
 * Mints an `AbortController` that never leaves preload, invokes `source` with `arg` and its
 * signal, and wraps the result via {@link bridgeStream} — the shared body behind each
 * `open*Stream` bridge-facing wrapper below.
 *
 * @param source - One of the preload-internal stream generators (`streamLogs`, `streamLambdaLogs`, `streamStackInitialize`, `streamIacRunLogs`).
 * @param arg - The generator's single positional argument (`undefined` for a stream that takes none).
 */
function openBufferedStream<TArg, TOut>(
  source: (arg: TArg, signal?: AbortSignal) => AsyncGenerator<TOut>,
  arg: TArg,
): HyveonStreamHandle<TOut> {
  const controller = new AbortController();
  return bridgeStream(source(arg, controller.signal), controller);
}

/** Bridge-facing wrapper for {@link streamLogs} — see {@link openBufferedStream}. */
function openLogsStream(game: string): HyveonStreamHandle<LogChunk> {
  return openBufferedStream(streamLogs, game);
}

/** Bridge-facing wrapper for {@link streamLambdaLogs} — see {@link openBufferedStream}. */
function openLambdaLogsStream(functionKey: LambdaFunctionKey): HyveonStreamHandle<LogChunk> {
  return openBufferedStream(streamLambdaLogs, functionKey);
}

/** Bridge-facing wrapper for {@link streamStackInitialize} — see {@link openBufferedStream}. */
function openStackInitializeStream(): HyveonStreamHandle<StackInitPhaseEvent> {
  return openBufferedStream(streamStackInitialize, undefined);
}

/** Bridge-facing wrapper for {@link streamIacRunLogs} — see {@link openBufferedStream}. */
function openIacRunLogsStream(runId: string): HyveonStreamHandle<IacRunChunk> {
  return openBufferedStream(streamIacRunLogs, runId);
}

const api: HyveonApi = {
  games: {
    list: () => invoke('games.list'),
    status: () => invoke('games.status'),
    getStatus: (game: string) => invoke('games.getStatus', game),
    start: (game: string) => invoke('games.start', game),
    stop: (game: string) => invoke('games.stop', game),
    // Transport note: `nestjs-electron-ipc-transport` only delivers the first
    // argument to `@Payload`, so each write op passes a single payload object
    // rather than separate positional arguments.
    create: (payload: CreateGamePayload) => invoke('games.create', payload),
    update: (payload: UpdateGamePayload) => invoke('games.update', payload),
    delete: (payload: DeleteGamePayload) => invoke('games.delete', payload),
    draft: {
      get: () => invoke<StoredGameWizardDraft | null>('games.draft.get'),
      save: (payload: { draft: GameWizardDraft; stepIndex: number }) => invoke<void>('games.draft.save', payload),
      updateStepIndex: (stepIndex: number) => invoke<void>('games.draft.updateStepIndex', { stepIndex }),
      clear: () => invoke<void>('games.draft.clear'),
    },
  },

  costs: {
    estimate: () => invoke('costs.estimate'),
  },

  cloudHealth: {
    list: () => invoke('cloudHealth.list'),
    fix: (id: string) => invoke('cloudHealth.fix', { id }),
    downloadPolicy: (policyJson: string) => invoke('cloudHealth.downloadPolicy', { policyJson }),
    openPolicyConsole: (url: string) => invoke('cloudHealth.openPolicyConsole', { url }),
  },

  logs: {
    get: (game: string, limit?: number) => invoke('logs.get', { game, limit }),
    stream: openLogsStream,
    getOlder: (game: string, beforeTimestamp: number, limit?: number) =>
      invoke<OlderLogsPage>('logs.getOlder', { game, beforeTimestamp, limit }),
    getNewer: (game: string, afterTimestamp: number, limit?: number, excludeEventIds?: string[]) =>
      invoke<NewerLogsPage>('logs.getNewer', { game, afterTimestamp, limit, excludeEventIds }),
    lambda: {
      get: (functionKey: LambdaFunctionKey, limit?: number) =>
        invoke<LambdaLogs>('logs.lambda.get', { functionKey, limit }),
      stream: openLambdaLogsStream,
      getOlder: (functionKey: LambdaFunctionKey, beforeTimestamp: number, limit?: number) =>
        invoke<OlderLogsPage>('logs.lambda.getOlder', { functionKey, beforeTimestamp, limit }),
      getNewer: (
        functionKey: LambdaFunctionKey,
        afterTimestamp: number,
        limit?: number,
        excludeEventIds?: string[],
      ) => invoke<NewerLogsPage>('logs.lambda.getNewer', { functionKey, afterTimestamp, limit, excludeEventIds }),
    },
  },

  files: {
    list: (game: string) => invoke('files.list', game),
    start: (game: string) => invoke('files.start', game),
    stop: (game: string) => invoke('files.stop', game),
  },

  discord: {
    getConfig: () => invoke('discord.getConfig'),
    putConfig: (body: { botToken?: string; clientId?: string; publicKey?: string }) =>
      invoke('discord.putConfig', body),
    listGuilds: () => invoke('discord.listGuilds'),
    addGuild: (guildId: string) => invoke('discord.addGuild', { guildId }),
    removeGuild: (guildId: string) => invoke('discord.removeGuild', guildId),
    registerCommands: (guildId: string) => invoke('discord.registerCommands', guildId),
    getAdmins: () => invoke('discord.getAdmins'),
    putAdmins: (body: { userIds?: string[]; roleIds?: string[] }) =>
      invoke('discord.putAdmins', body),
    getPermissions: () => invoke('discord.getPermissions'),
    putPermission: (
      game: string,
      body: { userIds?: string[]; roleIds?: string[]; actions?: string[] },
    ) => invoke('discord.putPermission', { game, body }),
    deletePermission: (game: string) => invoke('discord.deletePermission', game),
  },

  env: {
    get: () => invoke('env.get'),
  },

  wizard: {
    listAwsProfiles: () => invoke<AwsProfileSummary[]>('wizard.aws.listProfiles'),
    saveCredentials: (input: SavePastedCredentialsInput) =>
      invoke<{ profileName: string }>('wizard.aws.saveCredentials', input),
    getState: () => invoke<WizardState>('wizard.state.get'),
    saveState: (input: SaveWizardStateInput) => invoke<WizardState>('wizard.state.save', input),
    bootstrapStateBucket: (input: BootstrapStateBucketInput) =>
      invoke<BootstrapResult>('wizard.bootstrap.stateBucket', input),
    bootstrapConfigurationBucket: (input: BootstrapConfigurationBucketInput) =>
      invoke<BootstrapResult>('wizard.bootstrap.configurationBucket', input),
    bootstrapDeploymentConfig: (input: BootstrapDeploymentConfigInput) =>
      invoke<BootstrapResult>('wizard.bootstrap.deploymentConfig', input),
    bootstrapRunsTable: () => invoke<BootstrapResult>('wizard.bootstrap.runsTable'),
    simulateIamPermissions: () => invoke<IamCheckResult>('wizard.iam.simulate'),
    getProgress: () => invoke<WizardProgress>('wizard.progress.get'),
    saveProgress: (input: SaveWizardProgressInput) => invoke<void>('wizard.progress.save', input),
    complete: () => invoke<WizardState>('wizard.complete'),
    reset: () => invoke<WizardState>('wizard.reset'),
    guidedIamPrepareTemplate: () => invoke<RenderedTemplateResult>('wizard.guidedIam.prepareTemplate'),
    guidedIamOpenConsole: (input: OpenGuidedIamConsoleInput) =>
      invoke<OpenConsoleResult>('wizard.guidedIam.openConsole', input),
    guidedIamSubmitBootstrapKey: (input: BootstrapKeyIntakeInput) =>
      invoke<BootstrapKeyIntakeResult>('wizard.guidedIam.submitBootstrapKey', input),
    guidedIamRotate: (input: RotationInput) => invoke<RotationResult>('wizard.guidedIam.rotate', input),
    guidedIamRevokeBootstrapKey: (input: RevokeBootstrapKeyInput) =>
      invoke<RevokeBootstrapKeyResult>('wizard.guidedIam.revokeBootstrapKey', input),
  },

  drift: {
    get: () => invoke('drift.get'),
  },

  diagnostics: {
    tail: () => invoke('diagnostics.tail'),
    path: () => invoke('diagnostics.path'),
    reportError: (message: string, stack: string | undefined, source: 'boundary' | 'window-error' | 'unhandled-rejection') =>
      invoke('diagnostics.reportError', { message, stack, source }),
    reportLog: (entries: RendererLogEntry[], droppedCount?: number) =>
      invoke('diagnostics.reportLog', { entries, droppedCount }),
    exportBundle: () => invoke('diagnostics.exportBundle'),
    showInFolder: (path: string) => invoke('diagnostics.showInFolder', { path }),
  },

  audit: {
    list: (opts?: { limit?: number; before?: string }) => invoke('audit.list', opts),
  },

  iac: {
    stack: {
      initialize: openStackInitializeStream,
    },
    plan: (opts?: IacPlanPayload) => invoke<IacPlanAck>('iac.plan', opts),
    approve: (opts: { planRunId: string }) => invoke<IacApproveAck>('iac.approve', opts),
    apply: (payload: IacApplyPayload) => invoke<IacPlanAck>('iac.apply', payload),
    mintDestroyToken: () => invoke<IacDestroyMintAck>('iac.destroy.mintToken'),
    destroy: (payload: IacDestroyPayload) => invoke<IacPlanAck>('iac.destroy', payload),
    output: (force?: boolean) => invoke<StackOutputs | null>('iac.output', { force }),
    runs: {
      get: (runId: string) => invoke<IacRunsGetResult>('iac.runs.get', { runId }),
      streamLogs: openIacRunLogsStream,
      list: (opts?: IacRunsListOpts) => invoke<RunHistoryPageResult>('iac.runs.list', opts),
      logUrl: (logKey: string, expiresInSeconds?: number) =>
        invoke<{ url: string }>('iac.runs.logUrl', { logKey, expiresInSeconds }).then((r) => r.url),
      lock: {
        mintToken: (payload: IacRunsLockMintPayload) =>
          invoke<IacRunsLockMintAck>('iac.runs.lock.clear.mintToken', payload),
        clear: (payload: IacRunsLockClearPayload) => invoke<IacRunsLockClearAck>('iac.runs.lock.clear', payload),
      },
    },
    rollback: {
      resolve: (opts: { applyRunId: string }) =>
        invoke<IacRollbackResolveAck>('iac.rollback.resolve', opts),
      confirm: (opts: { applyRunId: string }) =>
        invoke<IacRollbackConfirmAck>('iac.rollback.confirm', opts),
    },
    lock: {
      mintToken: () => invoke<IacLockClearMintAck>('iac.lock.clear.mintToken'),
      clear: (payload: IacLockClearPayload) => invoke<IacLockClearAck>('iac.lock.clear', payload),
    },
    settings: {
      get: () => invoke<DeploymentSettingsGetResult>('iac.settings.get'),
      update: (payload: UpdateDeploymentSettingsPayload) =>
        invoke<DeploymentSettingsWriteResult>('iac.settings.update', payload),
      engineVersion: () => invoke<PulumiEngineVersionResult>('iac.settings.engineVersion'),
      autoUpdateGet: () => invoke<AutoUpdateSettingGetResult>('iac.settings.autoUpdate.get'),
      autoUpdateUpdate: (payload: AutoUpdateSettingUpdatePayload) =>
        invoke<AutoUpdateSettingWriteResult>('iac.settings.autoUpdate.update', payload),
      autoUpdateCheck: () => invoke<ManualUpdateCheckResult>('iac.settings.autoUpdate.check'),
    },
  },

  window: {
    platform: process.platform,
    minimize: () => invoke<void>('window.minimize'),
    toggleMaximize: () => invoke<void>('window.toggleMaximize'),
    close: () => invoke<void>('window.close'),
    isMaximized: () => invoke<boolean>('window.isMaximized'),
    onMaximizedChange: (cb: (isMaximized: boolean) => void) => {
      const listener = (_event: IpcRendererEvent, isMaximized: boolean) => cb(isMaximized);
      ipcRenderer.on('window.maximizedChange', listener);
      return () => ipcRenderer.removeListener('window.maximizedChange', listener);
    },
  },
};

/**
 * Returns `true` when this process was started in test mode by the integration
 * test harness (`HYVEON_TEST_MODE=1`).  Extracted as a function so tests can
 * stub the env read via `vi.spyOn` instead of mutating `process.env` directly.
 */
export function isTestModeEnabled(): boolean {
  return process.env['HYVEON_TEST_MODE'] === '1';
}

/** Whether this process was started in test mode by the integration test harness. */
const isTestMode = isTestModeEnabled();

const hyveonBridge: HyveonApi & { __test?: HyveonTestApi } = { ...api };

if (isTestMode) {
  /**
   * Test-only injection surface, present only when `HYVEON_TEST_MODE=1`.
   *
   * Exposes `mock(channel, handler)` so Playwright / Vitest can register
   * per-channel IPC overrides without touching the real Electron IPC layer.
   * `clearMocks` and `reset` both clear the registry so state does not leak
   * between test cases (mirror the {@link HyveonTestApi} contract).
   */
  hyveonBridge.__test = {
    mock: registerMock,
    /** Clears all registered mock handlers from the registry. */
    clearMocks: () => mockRegistry.clear(),
    /** Alias for {@link clearMocks} — symmetry with `vi.resetAllMocks()`. */
    reset: () => mockRegistry.clear(),
  };
}

contextBridge.exposeInMainWorld('hyveon', hyveonBridge);
