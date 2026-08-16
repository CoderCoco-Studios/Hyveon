# Implementation Plan: add-infra-log-viewer

For agentic workers: see `superpowers:subagent-driven-development` for how to execute this
plan task-by-task with review checkpoints.

## Goal

Let an operator view recent and live-tailed CloudWatch logs for any of the app's 5 Lambda
functions from a new `/logs/infrastructure` page, without leaving the app for the AWS
Console.

## Architecture

`LogsService` (desktop-main) gains two AWS-specific methods —
`getRecentLambdaLogs`/`streamLambdaLogs` — that resolve `/aws/lambda/${projectName}-${functionKey}`
via `DeploymentConfigService` and poll `CloudWatchLogsClient` directly, mirroring the existing
`getRecentLogs`/`streamLogs` game-log methods rather than going through `CloudProvider`. A new
`logs.lambda.get` / `logs.lambda.stream` IPC pair (the latter self-bridged, following
`logs.stream`'s pattern) exposes these on `window.hyveon.logs.lambda`, consumed by a new
`/logs/infrastructure` routed page that adds a 5-option function picker and reuses the existing
log-line rendering/highlighting/level-filter building blocks from `logs.page.tsx`. The sidebar's
flat `Logs` entry becomes a small always-expanded group with `Games` and `Infrastructure`
children.

## Tech Stack

TypeScript, NestJS (desktop-main, `@MessagePattern`/IPC transport), Electron `contextBridge`
preload, React 18 + react-router-dom (`@hyveon/web`), `@aws-sdk/client-cloudwatch-logs`,
Vitest (+ `aws-sdk-client-mock`, `@testing-library/react`), Playwright (chromium + electron
projects).

## Spec

- `openspec/changes/add-infra-log-viewer/design.md`
- `openspec/changes/add-infra-log-viewer/specs/infra-log-viewer/spec.md`

## Global Constraints

Apply to every task below, not repeated per-step:

- **TSDoc** (`.claude/rules/tsdoc-tags.md`): summary → `@remarks` → `@example` →
  `@typeParam` → `@param` → `@returns` → `@throws` → modifiers, in that order, on every
  non-trivial function/class/interface/notable constant, including test-helper comments.
  `@param name - description` (hyphen), inline tags as `{@link Symbol}`. Run `npm run app:lint`
  after any TSDoc edit.
- **IPC handler logging** (`.claude/rules/logging.md`): every `@MessagePattern` handler's first
  line is `logger.debug('<ControllerName>: <pattern> invoked', { ...safeIdentifiers })` — no
  secrets, no raw payloads. Every AWS SDK call site that can fail: catch, normalize via
  `err instanceof Error ? err.message : String(err)`, `logger.warn`/`logger.error`, return a
  modeled result or throw a plain `Error` with just `.message` — never let a raw SDK error
  escape uncaught.
- **No `as unknown as T` casts in tests.** Use `vi.mocked(fn)` for mocked modules and
  `Partial<T>` + a single `as T` for service-shaped stubs (matches every existing stub factory
  read above, e.g. `makeConfig()`, `makeDeploymentConfig()`).
- **Test names** are "should …" sentences (`it('should return …')`), not
  `it('returns …')`.
- Run `npm run app:lint` and `npm run app:typecheck` after each task before committing; they
  must stay clean throughout, not just at the end.

---

### Task 1: `LambdaFunctionKey` shared type

Adds the fixed 5-value union both desktop-main and web consume, per design D2.

**Files**

- Create: `app/packages/shared/src/lambdaFunctionKey.ts`
- Modify: `app/packages/shared/src/index.ts` (add `export * from './lambdaFunctionKey.js';`
  after the `cloud.js` re-exports, alphabetically near the other single-concept type files)

**Interfaces produced**

```ts
/**
 * The 5 Lambda functions the app provisions (`app/packages/infra/src/lambdas.ts`),
 * identified by the exact suffix each one's log group is named with:
 * `/aws/lambda/${projectName}-${functionKey}`.
 */
export type LambdaFunctionKey =
  | 'watchdog'
  | 'health-check'
  | 'dns-updater'
  | 'interactions'
  | 'followup';

/**
 * Every {@link LambdaFunctionKey} value, in the fixed order the Infrastructure
 * logs page's function picker renders them. Single source of truth so the
 * union and the iterable list can never drift.
 */
export const LAMBDA_FUNCTION_KEYS: readonly LambdaFunctionKey[] = [
  'watchdog',
  'health-check',
  'dns-updater',
  'interactions',
  'followup',
];
```

**Steps**

- [ ] **Step 1:** Create `app/packages/shared/src/lambdaFunctionKey.ts` with the type and
  const above (no test file needed — mirrors `stackOutputs.ts`, a types-only file with no
  dedicated `.test.ts`).
- [ ] **Step 2:** Add the re-export line to `app/packages/shared/src/index.ts`.
- [ ] **Step 3:** Run `npm run app:typecheck` (from repo root, after `npm install` if this is
  a fresh worktree per `.claude/rules/worktree.md`) — clean pass confirms the export resolves
  from `@hyveon/shared` in every workspace. Commit: `feat(shared): add LambdaFunctionKey union`.

---

### Task 2: `LogsService` Lambda log methods

Implements spec's "Lambda log group resolution", "Recent Lambda logs fetch", and "Live Lambda
log tail" requirements.

**Files**

- Modify: `app/packages/desktop-main/src/services/LogsService.ts` (current content read in
  full above — lines 1–129)
- Modify: `app/packages/desktop-main/src/services/LogsService.test.ts` (current content read
  in full above — lines 1–341)
- Modify: `app/packages/desktop-main/src/modules/aws.module.ts` (add `DeploymentConfigModule`
  import so `LogsService` can inject `DeploymentConfigService`)

**Interfaces produced**

```ts
// LogsService.ts additions
private async resolveLambdaLogGroup(functionKey: LambdaFunctionKey): Promise<string>;
async getRecentLambdaLogs(functionKey: LambdaFunctionKey, limit = 50): Promise<string[]>;
async *streamLambdaLogs(
  functionKey: LambdaFunctionKey,
  signal: AbortSignal,
  pollInterval = 2000,
): AsyncGenerator<string>;
```

**Interfaces consumed**

```ts
// DeploymentConfigService (existing, app/packages/desktop-main/src/services/DeploymentConfigService.ts:419)
async getTopLevelSettings(): Promise<{ settings: Omit<DeploymentConfig, 'gameServers'>; etag?: string }>;
// DEPLOYMENT_CONFIG_DEFAULTS.projectName === 'hyveon' (@hyveon/shared, deploymentConfig.ts:292)
```

`streamLambdaLogs` polls `FilterLogEvents` directly against the resolved log group — it does
**not** go through `CloudProvider.streamWorkloadLogs` (design D1). Since `CloudProvider`'s
polling/de-dup/abort logic lives in `AwsCloudProvider.streamWorkloadLogs` and is not otherwise
exposed as a reusable helper, this method duplicates that poll-loop shape (dedupe by `eventId`,
sorted by timestamp, `[stream error]`-prefixed sentinel on a poll failure, clean exit on
`signal.aborted`) inline, scoped to the resolved Lambda log group instead of `/ecs/{game}-server`.

**Steps**

- [ ] **Step 1 (test, resolver — default projectName):** In `LogsService.test.ts`, add a new
  `describe('LogsService — Lambda log methods')` block. First test:
  ```ts
  it('should resolve the default project name to /aws/lambda/hyveon-watchdog for functionKey "watchdog"', async () => {
    cwMock.on(DescribeLogStreamsCommand).resolves({ logStreams: [] });
    await service.getRecentLambdaLogs('watchdog');
    const input = cwMock.commandCalls(DescribeLogStreamsCommand)[0]!.args[0].input;
    expect(input.logGroupName).toBe('/aws/lambda/hyveon-watchdog');
  });
  ```
  This will need a `makeConfig()` extended with a `deploymentConfig` stub — extend
  `makeService` to accept an optional `DeploymentConfigService` stub (default: resolves
  `{ settings: {} }`, i.e. no `projectName` override, exercising the `hyveon` default), per the
  `makeDeploymentConfig()` pattern in `CloudHealthService.test.ts`. Run `npm run app:test -- LogsService` — fails (method doesn't exist yet).
- [ ] **Step 2 (impl, resolver + getRecentLambdaLogs):** In `LogsService.ts`:
  1. Add `import type { LambdaFunctionKey } from '@hyveon/shared';` to the existing
     `import type { CloudProvider, LogChunk } from '@hyveon/shared';` line (combine into one
     import).
  2. Add `import { DEPLOYMENT_CONFIG_DEFAULTS } from '@hyveon/shared';` (or fold into the
     combined `@hyveon/shared` import).
  3. Add `import { DeploymentConfigService } from './DeploymentConfigService.js';`.
  4. Add `deploymentConfig: DeploymentConfigService` as a 4th constructor param (after `store`),
     matching `CloudHealthService`'s injection order/style.
  5. Add:
     ```ts
     /**
      * Resolves the CloudWatch log group for one of the app's 5 Lambda
      * functions, using the operator's configured `projectName` (falling back
      * to {@link DEPLOYMENT_CONFIG_DEFAULTS}'s project name on any read
      * failure, matching {@link CloudHealthService.getProjectName}'s
      * fallback rationale).
      *
      * @param functionKey - Which Lambda function's log group to resolve.
      * @returns The resolved log group name, e.g. `/aws/lambda/hyveon-watchdog`.
      */
     private async resolveLambdaLogGroup(functionKey: LambdaFunctionKey): Promise<string> {
       let projectName = DEPLOYMENT_CONFIG_DEFAULTS.projectName;
       try {
         const { settings } = await this.deploymentConfig.getTopLevelSettings();
         projectName = settings.projectName ?? DEPLOYMENT_CONFIG_DEFAULTS.projectName;
       } catch (err) {
         const message = err instanceof Error ? err.message : String(err);
         logger.warn('LogsService.resolveLambdaLogGroup: falling back to the default project name', { functionKey, error: message });
       }
       return `/aws/lambda/${projectName}-${functionKey}`;
     }

     /**
      * Return up to `limit` recent messages from the most recently written log
      * stream in the resolved Lambda log group. Errors and a missing log
      * group/stream are folded into a single-element array, mirroring
      * {@link getRecentLogs}'s no-throw contract.
      */
     async getRecentLambdaLogs(functionKey: LambdaFunctionKey, limit = 50): Promise<string[]> {
       const logGroup = await this.resolveLambdaLogGroup(functionKey);
       logger.debug('LogsService.getRecentLambdaLogs: fetching recent logs', { functionKey, limit, logGroup });
       try {
         const streams = await this.getClient().send(
           new DescribeLogStreamsCommand({
             logGroupName: logGroup,
             orderBy: 'LastEventTime',
             descending: true,
             limit: 1,
           }),
         );
         if (!streams.logStreams?.length) {
           return [`No log streams found for ${functionKey}.`];
         }
         const streamName = streams.logStreams[0]!.logStreamName!;
         const events = await this.getClient().send(
           new GetLogEventsCommand({
             logGroupName: logGroup,
             logStreamName: streamName,
             limit,
             startFromHead: false,
           }),
         );
         return events.events?.map((e) => e.message ?? '') ?? [];
       } catch (err) {
         const message = err instanceof Error ? err.message : String(err);
         logger.error('LogsService.getRecentLambdaLogs: failed to fetch logs', { functionKey, logGroup, error: message });
         return [`Error fetching logs for ${functionKey}: ${String(err)}`];
       }
     }
     ```
  Run `npm run app:test -- LogsService` — Step 1's test passes.
- [ ] **Step 3 (test, custom projectName):**
  ```ts
  it('should resolve a custom project name to /aws/lambda/acme-health-check for functionKey "health-check"', async () => {
    const deploymentConfig = makeDeploymentConfig('acme');
    service = makeService(makeConfig(), deploymentConfig);
    cwMock.on(DescribeLogStreamsCommand).resolves({ logStreams: [] });
    await service.getRecentLambdaLogs('health-check');
    const input = cwMock.commandCalls(DescribeLogStreamsCommand)[0]!.args[0].input;
    expect(input.logGroupName).toBe('/aws/lambda/acme-health-check');
  });
  ```
  Add the `makeDeploymentConfig(projectName = 'hyveon')` helper (mirrors
  `CloudHealthService.test.ts`'s helper of the same name):
  ```ts
  function makeDeploymentConfig(projectName = 'hyveon'): DeploymentConfigService {
    return {
      getTopLevelSettings: vi.fn().mockResolvedValue({ settings: { projectName } }),
    } as Partial<DeploymentConfigService> as DeploymentConfigService;
  }
  ```
  and thread it through `makeService`:
  ```ts
  function makeService(config: ConfigService, deploymentConfig: DeploymentConfigService = makeDeploymentConfig()): LogsService {
    const store = makeStore();
    return new LogsService(config, createAwsCloudProvider(config, store), store, deploymentConfig);
  }
  ```
  Run — passes given Step 2's `resolveLambdaLogGroup`.
- [ ] **Step 4 (test, no-streams-yet fallback):**
  ```ts
  it('should return a "no log streams" message when the Lambda log group has no streams', async () => {
    cwMock.on(DescribeLogStreamsCommand).resolves({ logStreams: [] });
    const lines = await service.getRecentLambdaLogs('followup');
    expect(lines).toEqual(['No log streams found for followup.']);
  });
  ```
  Already passes (covered by Step 2's implementation) — run to confirm green, no impl change.
- [ ] **Step 5 (test, error fallback):**
  ```ts
  it('should return an error message and log via logger.error when the CloudWatch call throws', async () => {
    cwMock.on(DescribeLogStreamsCommand).rejects(new Error('denied'));
    const lines = await service.getRecentLambdaLogs('interactions');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/error fetching logs for interactions/i);
    expect(loggerMock.error).toHaveBeenCalledWith(
      'LogsService.getRecentLambdaLogs: failed to fetch logs',
      expect.objectContaining({ functionKey: 'interactions', error: 'denied' }),
    );
  });
  ```
  Already passes — confirm green.
- [ ] **Step 6 (test, streamLambdaLogs — new events, no duplicates):** Add a second
  `describe('LogsService.streamLambdaLogs')` block:
  ```ts
  it('should yield new log lines for the resolved Lambda log group without duplicating events', async () => {
    cwMock
      .on(FilterLogEventsCommand)
      .resolvesOnce({ events: [{ eventId: 'e1', timestamp: 1000, message: 'first' }] })
      .resolves({
        events: [
          { eventId: 'e1', timestamp: 1000, message: 'first' }, // already seen
          { eventId: 'e2', timestamp: 2000, message: 'second' }, // new
        ],
      });
    const ac = new AbortController();
    const gen = service.streamLambdaLogs('dns-updater', ac.signal, 0);
    const { value: l1 } = await gen.next();
    const { value: l2 } = await gen.next();
    ac.abort();
    await gen.return(undefined);
    expect(l1).toBe('first');
    expect(l2).toBe('second');
    expect(cwMock.commandCalls(FilterLogEventsCommand)[0]!.args[0].input.logGroupName).toBe('/aws/lambda/hyveon-dns-updater');
  });
  ```
  Run — fails (`streamLambdaLogs` doesn't exist yet).
- [ ] **Step 7 (impl, streamLambdaLogs):** Add to `LogsService.ts`, right after
  `getRecentLambdaLogs`:
  ```ts
  /**
   * Async generator that yields new log lines as they arrive for the resolved
   * Lambda log group. Polls `FilterLogEvents` every `pollInterval` ms,
   * de-duplicating by `eventId` and exiting cleanly when `signal` is aborted —
   * the same poll-loop shape `AwsCloudProvider.streamWorkloadLogs` uses for
   * game logs (see design.md D1 for why this duplicates rather than shares
   * that implementation). A poll failure yields a `[stream error]`-prefixed
   * sentinel line and the loop continues, matching `streamLogs`'s resilience
   * to a transient CloudWatch hiccup.
   */
  async *streamLambdaLogs(
    functionKey: LambdaFunctionKey,
    signal: AbortSignal,
    pollInterval = 2000,
  ): AsyncGenerator<string> {
    const logGroup = await this.resolveLambdaLogGroup(functionKey);
    logger.debug('LogsService.streamLambdaLogs: starting log stream', { functionKey, logGroup, pollInterval });
    const seen = new Set<string>();
    let startTime: number | undefined;
    while (!signal.aborted) {
      try {
        const result = await this.getClient().send(
          new FilterLogEventsCommand({ logGroupName: logGroup, startTime }),
        );
        for (const event of result.events ?? []) {
          const id = event.eventId ?? `${event.timestamp}:${event.message}`;
          if (seen.has(id)) continue;
          seen.add(id);
          if (event.timestamp !== undefined) {
            startTime = startTime === undefined ? event.timestamp : Math.max(startTime, event.timestamp);
          }
          if (signal.aborted) return;
          yield event.message ?? '';
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (signal.aborted) return;
        yield `[stream error] ${message}`;
      }
      if (signal.aborted) return;
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }
  }
  ```
  Add `FilterLogEventsCommand` to the `@aws-sdk/client-cloudwatch-logs` import.
  Run `npm run app:test -- LogsService` — Step 6 passes.
- [ ] **Step 8 (test, abort mid-stream + de-dupe across the "already seen" case
  from Step 6, already covered):** Add:
  ```ts
  it('should exit cleanly with no further FilterLogEvents calls once the signal is aborted', async () => {
    cwMock.on(FilterLogEventsCommand).resolves({ events: [] });
    const ac = new AbortController();
    ac.abort();
    const lines: string[] = [];
    for await (const line of service.streamLambdaLogs('watchdog', ac.signal, 0)) lines.push(line);
    expect(lines).toEqual([]);
    expect(cwMock.commandCalls(FilterLogEventsCommand)).toHaveLength(0);
  });
  ```
  Already passes given Step 7's `while (!signal.aborted)` guard — run to confirm green.
- [ ] **Step 9 (impl, module wiring):** In `app/packages/desktop-main/src/modules/aws.module.ts`,
  add `import { DeploymentConfigModule } from './deployment-config.module.js';` and add
  `DeploymentConfigModule` to the `@Module({ imports: [...] })` array (alongside
  `ConfigModule, CloudProviderModule, ElectronStoreModule`) — this is safe because
  `DeploymentConfigModule` only imports `ConfigModule`/`CloudProviderModule` itself (verified:
  no import edge back to `AwsModule`), so no cycle is introduced. `DeploymentConfigService`
  is then injectable into `LogsService` via Nest DI without any provider list changes (it's
  already a provider of `DeploymentConfigModule`, just newly reachable from `AwsModule`'s
  container).
- [ ] **Step 10:** `npm run app:test -- LogsService`, `npm run app:typecheck`, `npm run app:lint`
  — all clean. Commit: `feat(desktop-main): add LogsService Lambda log methods`.

---

### Task 3: IPC controller + preload bridge

Implements the `logs.lambda.get` / `logs.lambda.stream` IPC surface and its preload exposure.

**Files**

- Modify: `app/packages/desktop-main/src/controllers/logs.controller.ts` (full content read
  above — lines 1–141)
- Modify: `app/packages/desktop-main/src/controllers/logs.controller.test.ts` (full content
  read above — lines 1–341)
- Modify: `app/packages/desktop-main/src/ipc-main-bridge.ts` (add `'logs.lambda.stream'` to
  `SELF_BRIDGED_PATTERNS`)
- Modify: `app/packages/desktop-preload/src/hyveon-api.ts` (add `LambdaLogs` type,
  `HyveonLambdaLogsApi` interface, `lambda: HyveonLambdaLogsApi` field on `HyveonLogsApi`)
- Modify: `app/packages/desktop-preload/src/preload.ts` (add `streamLambdaLogs` internal
  generator, `openLambdaLogsStream` wrapper, `logs.lambda` field on the exported `api`)

**Interfaces produced**

```ts
// LogsController additions
@MessagePattern('logs.lambda.get')
async getRecentLambdaLogs(
  @Payload() payload: { functionKey: LambdaFunctionKey; limit?: number },
): Promise<{ functionKey: LambdaFunctionKey; lines: string[] }>;

@MessagePattern('logs.lambda.stream')
async streamLambdaLogs(
  @Payload() functionKey: LambdaFunctionKey,
  ctx: { evt: IpcMainInvokeEvent },
): Promise<{ streamId: string }>;
```

```ts
// hyveon-api.ts additions
export interface LambdaLogs {
  functionKey: LambdaFunctionKey;
  lines: string[];
}

/** CloudWatch log endpoints for the app's 5 Lambda functions — see {@link HyveonLogsApi}. */
export interface HyveonLambdaLogsApi {
  get: (functionKey: LambdaFunctionKey, limit?: number) => Promise<LambdaLogs>;
  stream: (functionKey: LambdaFunctionKey) => HyveonStreamHandle<LogChunk>;
}

export interface HyveonLogsApi {
  get: (game: string, limit?: number) => Promise<GameLogs>;
  stream: (game: string) => HyveonStreamHandle<LogChunk>;
  lambda: HyveonLambdaLogsApi;
}
```

**Interfaces consumed**

```ts
// LogsService (Task 2)
getRecentLambdaLogs(functionKey: LambdaFunctionKey, limit?: number): Promise<string[]>;
streamLambdaLogs(functionKey: LambdaFunctionKey, signal: AbortSignal, pollInterval?: number): AsyncGenerator<string>;
```

**Steps**

- [ ] **Step 1 (test, controller channel registration):** In `logs.controller.test.ts`, add to
  the `describe('@MessagePattern channel names')` block:
  ```ts
  it('should register getRecentLambdaLogs on the "logs.lambda.get" IPC channel', () => {
    const pattern = Reflect.getMetadata(PATTERN_METADATA_KEY, LogsController.prototype.getRecentLambdaLogs);
    expect(pattern).toEqual(['logs.lambda.get']);
  });

  it('should register streamLambdaLogs on the "logs.lambda.stream" IPC channel', () => {
    const pattern = Reflect.getMetadata(PATTERN_METADATA_KEY, LogsController.prototype.streamLambdaLogs);
    expect(pattern).toEqual(['logs.lambda.stream']);
  });
  ```
  Extend `makeLogs()` to also stub `getRecentLambdaLogs`/`streamLambdaLogs`:
  ```ts
  function makeLogs(): LogsService {
    return {
      getRecentLogs: vi.fn().mockResolvedValue(['line1', 'line2']),
      streamLogs: vi.fn().mockImplementation(async function* () { /* empty */ }),
      getRecentLambdaLogs: vi.fn().mockResolvedValue(['lambda-line1']),
      streamLambdaLogs: vi.fn().mockImplementation(async function* () { /* empty */ }),
    } as unknown as LogsService;
  }
  ```
  Run `npm run app:test -- logs.controller` — fails (methods undefined).
- [ ] **Step 2 (impl, getRecentLambdaLogs handler):** In `logs.controller.ts`, add
  `import type { LambdaFunctionKey } from '@hyveon/shared';` and, after `getRecentLogs`:
  ```ts
  /**
   * Returns the most recent `limit` (default 50) log lines for one of the
   * app's 5 Lambda functions.
   *
   * Reachable via the Electron IPC transport (`logs.lambda.get`).
   */
  @MessagePattern('logs.lambda.get')
  async getRecentLambdaLogs(
    @Payload() payload: { functionKey: LambdaFunctionKey; limit?: number },
  ): Promise<{ functionKey: LambdaFunctionKey; lines: string[] }> {
    const { functionKey, limit = 50 } = payload;
    logger.debug('LogsController: logs.lambda.get invoked', { functionKey });
    const lines = await this.logs.getRecentLambdaLogs(functionKey, limit);
    return { functionKey, lines };
  }
  ```
  Run — Step 1's `logs.lambda.get` registration test passes; add and pass the two behavioural
  tests from `getRecentLogs`'s own `describe` block, adapted:
  ```ts
  it('should return the functionKey and log lines from LogsService.getRecentLambdaLogs', async () => {
    const result = await new LogsController(makeLogs()).getRecentLambdaLogs({ functionKey: 'watchdog' });
    expect(result).toEqual({ functionKey: 'watchdog', lines: ['lambda-line1'] });
  });

  it('should default to 50 log lines when no limit is provided in the payload', async () => {
    const logs = makeLogs();
    await new LogsController(logs).getRecentLambdaLogs({ functionKey: 'followup' });
    expect(logs.getRecentLambdaLogs).toHaveBeenCalledWith('followup', 50);
  });
  ```
- [ ] **Step 3 (impl, streamLambdaLogs handler + onModuleInit bridge):** Add the
  `logs.lambda.stream` channel constants and handler, following `streamLogs`'s exact shape
  (own `AbortController`, per-stream `logs.lambda.stream.<id>.chunk`/`.end`/`.cancel`
  channels):
  ```ts
  /**
   * Opens a live log stream for `functionKey` and returns an opaque
   * `streamId` immediately, following {@link streamLogs}'s exact shape
   * (its own `AbortController`, per-stream chunk/end/cancel side channels)
   * but delegating to {@link LogsService.streamLambdaLogs} instead. Uses a
   * distinct `logs.lambda.stream.<id>.*` channel namespace so it can never
   * collide with `logs.stream.<id>.*`.
   *
   * Reachable via the Electron IPC transport (`logs.lambda.stream`).
   */
  @MessagePattern('logs.lambda.stream')
  async streamLambdaLogs(
    @Payload() functionKey: LambdaFunctionKey,
    ctx: { evt: IpcMainInvokeEvent },
  ): Promise<{ streamId: string }> {
    logger.debug('LogsController: logs.lambda.stream invoked', { functionKey });
    const streamId = randomUUID();
    const ac = new AbortController();
    const sender: WebContents = ctx.evt.sender;
    const chunkChannel = `logs.lambda.stream.${streamId}.chunk`;
    const endChannel = `logs.lambda.stream.${streamId}.end`;
    const cancelChannel = `logs.lambda.stream.${streamId}.cancel`;

    const { ipcMain } = await import('electron') as unknown as { ipcMain: IpcMain };
    ipcMain.once(cancelChannel, () => { ac.abort(); });

    void (async () => {
      try {
        for await (const line of this.logs.streamLambdaLogs(functionKey, ac.signal)) {
          if (sender.isDestroyed()) { ac.abort(); break; }
          sender.send(chunkChannel, line);
        }
        if (!sender.isDestroyed()) sender.send(endChannel, {});
      } catch (err) {
        if ((err as Error).name === 'AbortError') {
          if (!sender.isDestroyed()) sender.send(endChannel, {});
        } else {
          const message = err instanceof Error ? err.message : String(err);
          logger.error('Lambda log stream error', { message, functionKey, streamId });
          if (!sender.isDestroyed()) sender.send(endChannel, { error: String(err) });
        }
      } finally {
        ipcMain.removeAllListeners(cancelChannel);
      }
    })();

    return { streamId };
  }
  ```
  Update `onModuleInit` to also bridge `logs.lambda.stream`, mirroring the existing
  `logs.stream` bridge (remove-then-handle):
  ```ts
  ipcMain.removeHandler('logs.stream');
  ipcMain.handle('logs.stream', (evt, game: string) =>
    this.streamLogs(game, { evt: evt as IpcMainInvokeEvent }),
  );
  ipcMain.removeHandler('logs.lambda.stream');
  ipcMain.handle('logs.lambda.stream', (evt, functionKey: LambdaFunctionKey) =>
    this.streamLambdaLogs(functionKey, { evt: evt as IpcMainInvokeEvent }),
  );
  ```
  In `ipc-main-bridge.ts`, add `'logs.lambda.stream'` to the `SELF_BRIDGED_PATTERNS` set
  (alongside `'logs.stream'`) so the generic bridge helper skips it too.
  Run `npm run app:test -- logs.controller` — Step 1's `logs.lambda.stream` registration test
  passes. Add and pass the streamLambdaLogs behavioural tests, copying each of `streamLogs`'s
  own tests (return streamId, register cancel listener, send chunks, send end on exhaustion,
  send end on AbortError with no `error` field, send end with `error` on a non-abort throw,
  pass an `AbortSignal` to `LogsService.streamLambdaLogs`, abort on cancel, remove cancel
  listener after natural end, never send to a destroyed WebContents) with
  `logs.lambda.stream.${streamId}.*` channel names and `logs.streamLambdaLogs` in place of
  `logs.streamLogs`.
- [ ] **Step 4 (test, onModuleInit bridges both channels):** Add:
  ```ts
  it('should register ipcMain.handle for "logs.lambda.stream" so ipcRenderer.invoke can resolve', async () => {
    await new LogsController(makeLogs()).onModuleInit();
    expect(mockIpcMainHandle).toHaveBeenCalledWith('logs.lambda.stream', expect.any(Function));
  });

  it('should remove any existing "logs.lambda.stream" handler before registering', async () => {
    await new LogsController(makeLogs()).onModuleInit();
    expect(mockIpcMainRemoveHandler).toHaveBeenCalledWith('logs.lambda.stream');
  });
  ```
  Already passes given Step 3's `onModuleInit` edit — run to confirm green.
- [ ] **Step 5:** `npm run app:test -- logs.controller`, `npm run app:typecheck`,
  `npm run app:lint` — clean. Commit: `feat(desktop-main): add logs.lambda IPC channels`.
- [ ] **Step 6 (preload types):** In `hyveon-api.ts`, add `LambdaLogs`/`HyveonLambdaLogsApi`
  (shown above under "Interfaces produced") right after `HyveonLogsApi`, add
  `import type { LambdaFunctionKey } from '@hyveon/shared';` to the existing `@hyveon/shared`
  type-only import block, and add the `lambda: HyveonLambdaLogsApi;` field to `HyveonLogsApi`.
  Run `npm run app:typecheck` — will now fail in `preload.ts` (missing `lambda` field on the
  `logs` object) until Step 7 below.
- [ ] **Step 7 (preload impl):** In `preload.ts`:
  1. Add `LambdaFunctionKey`, `LambdaLogs` to the `hyveon-api.js` type import block.
  2. After the `streamLogs` internal generator (before `streamStackInitialize`), add a mirror
     generator:
     ```ts
     /**
      * Preload-internal — never exposed to the renderer directly (see
      * {@link openLambdaLogsStream}). Bridges the per-stream chunk/end/cancel
      * `logs.lambda.stream.<id>.*` channels into an {@link AsyncIterable} of
      * log chunks, mirroring {@link streamLogs} exactly but against
      * `logs.lambda.stream`/`logs.lambda.stream.<id>.cancel`.
      *
      * When a mock is registered for the `'logs.lambda.stream'` channel (test
      * mode only), the mock handler is called with `(functionKey, signal)` —
      * same convention as {@link streamLogs}'s `'logs.stream'` mock.
      */
     async function* streamLambdaLogs(functionKey: LambdaFunctionKey, signal?: AbortSignal): AsyncGenerator<LogChunk> {
       const streamMock = mockRegistry.get('logs.lambda.stream');
       if (streamMock !== undefined) {
         const mockIterable = streamMock(functionKey, signal) as AsyncIterable<LogChunk>;
         yield* mockIterable;
         return;
       }
       const { streamId } = (await invoke('logs.lambda.stream', functionKey)) as { streamId: string };
       const chunkChannel = `logs.lambda.stream.${streamId}.chunk`;
       const endChannel = `logs.lambda.stream.${streamId}.end`;
       const sendCancel = () => ipcRenderer.send(`logs.lambda.stream.${streamId}.cancel`);
       const buffer: LogChunk[] = [];
       let ended = false;
       let endError: string | undefined;
       let wake: (() => void) | null = null;
       const signalWake = () => { if (wake) { const fn = wake; wake = null; fn(); } };
       const onChunk = (_evt: IpcRendererEvent, chunk: LogChunk) => { buffer.push(chunk); signalWake(); };
       const onEnd = (_evt: IpcRendererEvent, data: { error?: string }) => { ended = true; endError = data?.error; signalWake(); };
       const onAbort = () => sendCancel();
       ipcRenderer.on(chunkChannel, onChunk);
       ipcRenderer.once(endChannel, onEnd);
       if (signal) {
         if (signal.aborted) sendCancel();
         else signal.addEventListener('abort', onAbort, { once: true });
       }
       try {
         while (true) {
           while (buffer.length > 0) yield buffer.shift()!;
           if (ended) { if (endError) throw new Error(endError); return; }
           await new Promise<void>((resolve) => { wake = resolve; });
         }
       } finally {
         ipcRenderer.removeListener(chunkChannel, onChunk);
         ipcRenderer.removeListener(endChannel, onEnd);
         signal?.removeEventListener('abort', onAbort);
         if (!ended) sendCancel();
       }
     }
     ```
  3. Add a bridge-facing wrapper next to `openLogsStream`:
     ```ts
     /**
      * Bridge-facing wrapper for {@link streamLambdaLogs}. Mints an
      * `AbortController` that never leaves preload and returns a
      * {@link HyveonStreamHandle} in place of the raw async generator — see
      * {@link bridgeStream}.
      */
     function openLambdaLogsStream(functionKey: LambdaFunctionKey): HyveonStreamHandle<LogChunk> {
       const controller = new AbortController();
       return bridgeStream(streamLambdaLogs(functionKey, controller.signal), controller);
     }
     ```
  4. Update the `api.logs` object:
     ```ts
     logs: {
       get: (game: string, limit?: number) => invoke('logs.get', { game, limit }),
       stream: openLogsStream,
       lambda: {
         get: (functionKey: LambdaFunctionKey, limit?: number) =>
           invoke<LambdaLogs>('logs.lambda.get', { functionKey, limit }),
         stream: openLambdaLogsStream,
       },
     },
     ```
  Run `npm run app:typecheck` — clean.
- [ ] **Step 8:** `npm run app:lint`. Commit:
  `feat(desktop-preload): expose logs.lambda.get/stream on window.hyveon`.

---

### Task 4: Sidebar navigation

Implements the "Nested Logs sidebar navigation" requirement.

**Files**

- Modify: `app/packages/web/src/components/app-layout.component.tsx` (full content read
  above — lines 1–318)
- Modify: `app/packages/web/src/components/app-layout.component.test.tsx` (full content read
  above — lines 1–251)
- Modify: `app/packages/web/e2e/specs/polling.spec.ts` (its `layout.navigateTo('Logs', '/logs')`
  call breaks once `Logs` stops being a clickable link — needs updating to the new child link)

**Interfaces produced**

```tsx
// app-layout.component.tsx — replaces the flat `monitoringItems` Logs entry
interface NavGroup {
  label: string;
  icon: typeof ScrollText;
  children: NavItem[];
}
```

**Steps**

- [ ] **Step 1 (test, group renders both children):** In
  `app-layout.component.test.tsx`, replace the existing
  `'should mark the active route link with aria-current="page"'` test (it currently asserts
  `getByRole('link', { name: 'Logs' })`, which will no longer exist as a link) with:
  ```ts
  it('should render a Logs group with Games and Infrastructure child links', () => {
    render(
      <PollingProvider>
        <MemoryRouter>
          <AppLayout>content</AppLayout>
        </MemoryRouter>
      </PollingProvider>,
    );
    expect(screen.getByText('Logs')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Games' })).toHaveAttribute('href', '/logs');
    expect(screen.getByRole('link', { name: 'Infrastructure' })).toHaveAttribute('href', '/logs/infrastructure');
  });

  it('should mark only the Games child link active on /logs', () => {
    render(
      <PollingProvider>
        <MemoryRouter initialEntries={['/logs']}>
          <AppLayout>content</AppLayout>
        </MemoryRouter>
      </PollingProvider>,
    );
    expect(screen.getByRole('link', { name: 'Games' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Infrastructure' })).not.toHaveAttribute('aria-current');
  });

  it('should mark only the Infrastructure child link active on /logs/infrastructure', () => {
    render(
      <PollingProvider>
        <MemoryRouter initialEntries={['/logs/infrastructure']}>
          <AppLayout>content</AppLayout>
        </MemoryRouter>
      </PollingProvider>,
    );
    expect(screen.getByRole('link', { name: 'Infrastructure' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Games' })).not.toHaveAttribute('aria-current');
  });
  ```
  Also fix the mobile-nav test at line 247 (`within(...).getByRole('link', { name: 'Logs' })`)
  to click the `Games` child link instead:
  ```ts
  await user.click(within(document.getElementById('mobile-nav')!).getByRole('link', { name: 'Games' }));
  ```
  Run `npm run app:test -- app-layout.component` — new tests fail (component not yet changed);
  the mobile-nav test also fails until the component change lands.
- [ ] **Step 2 (impl):** In `app-layout.component.tsx`:
  1. Remove `{ to: '/logs', icon: ScrollText, label: 'Logs' }` from `monitoringItems`.
  2. Add, above `monitoringItems`:
     ```tsx
     const logsGroup = {
       label: 'Logs',
       icon: ScrollText,
       children: [
         { to: '/logs', icon: ScrollText, label: 'Games' },
         { to: '/logs/infrastructure', icon: ScrollText, label: 'Infrastructure' },
       ] as NavItem[],
     };
     ```
  3. In `NavSections`, render the group inline in the Monitoring `<ul>`, between Dashboard and
     Costs (i.e. replace the removed Logs `<li>` with a nested block, not a new top-level
     section — keeps `Logs` positioned where it was):
     ```tsx
     <li key="logs-group">
       <p className="px-3 pt-1 pb-1 text-sm font-medium text-muted-foreground flex items-center gap-3">
         <logsGroup.icon className="w-4 h-4" aria-hidden="true" />
         {logsGroup.label}
       </p>
       <ul className="ml-4 space-y-1 list-none border-l border-border pl-2">
         {logsGroup.children.map((item) => (
           <li key={item.to}>
             <NavLink item={item} active={currentPath === item.to} onNavigate={onNavigate} />
           </li>
         ))}
       </ul>
     </li>
     ```
     Note: active-match uses exact `currentPath === item.to` (not the `startsWith` prefix match
     the other top-level items use) so `/logs` and `/logs/infrastructure` never both light up —
     this satisfies the spec's "only one child active at a time" scenario directly, since the
     two routes don't nest under each other.
  4. Update `monitoringItems.map(...)` in `NavSections` to render before/after the new
     `<li key="logs-group">` entry in the same position `Logs` previously occupied (Dashboard,
     then Logs group, then Costs) — either keep `monitoringItems` as `[Dashboard, Costs]` and
     hand-place the `<li>` between them, or restructure the render loop; the former is the
     smaller diff.
- [ ] **Step 3:** Run `npm run app:test -- app-layout.component` — all tests (new + existing)
  pass, including the "should not render the top-bar search input" and "should not render any
  disabled nav entries" tests which are unaffected.
- [ ] **Step 4 (fix polling.spec.ts):** In `app/packages/web/e2e/specs/polling.spec.ts`, change
  `await layout.navigateTo('Logs', '/logs');` to
  `await layout.navigateTo('Games', '/logs');` (the sidebar link labelled `Logs` no longer
  exists — `Games` is its replacement child link routing to the same `/logs` path this test
  actually cares about).
- [ ] **Step 5:** `npm run app:lint`, `npm run app:typecheck`. Commit:
  `feat(web): nest Logs sidebar entry into Games/Infrastructure group`.

---

### Task 5: Extract shared `useLogTail` hook

Implements design D6: pulls `logs.page.tsx`'s buffering/pause/resume/stream/level-filter/
autoscroll/age-footer state machine out into a standalone hook both `/logs` and
`/logs/infrastructure` consume, then refactors `logs.page.tsx` onto it behavior-preservingly.

**Files**

- Create: `app/packages/web/src/hooks/use-log-tail.hook.ts`
- Create: `app/packages/web/src/hooks/use-log-tail.hook.test.ts`
- Modify: `app/packages/web/src/pages/logs.page.tsx` (full content read above — lines 1–450)
- Verify unchanged: `app/packages/web/src/pages/logs.page.test.tsx` (full content read above —
  lines 1–214) — this file must pass with **zero edits**, per D6's regression-gate trade-off

**Interfaces produced**

```ts
// use-log-tail.hook.ts
export interface LogLine {
  text: string;
  level: LogLevel | null;
  receivedAt: number;
}

/** The `get`/`stream` pair a caller wires to either `window.hyveon.logs` (game logs) or `window.hyveon.logs.lambda` (Lambda logs). */
export interface LogTailApi {
  get: (target: string, limit?: number) => Promise<{ lines: string[] }>;
  stream: (target: string) => HyveonStreamHandle<LogChunk>;
}

export interface UseLogTailResult {
  lines: LogLine[];
  visibleLines: LogLine[];
  paused: boolean;
  autoscroll: boolean;
  setAutoscroll: (value: boolean) => void;
  search: string;
  setSearch: (value: string) => void;
  hiddenLevels: Set<LogLevel>;
  toggleLevel: (level: LogLevel) => void;
  error: string | null;
  bufferedCount: number;
  ageLabel: string | null;
  boxRef: React.RefObject<HTMLDivElement>;
  handlePauseToggle: () => void;
}

export function useLogTail(target: string, api: LogTailApi): UseLogTailResult;
```

**Interfaces consumed**

```ts
// @hyveon/desktop-preload
import type { HyveonStreamHandle, LogChunk } from '@hyveon/desktop-preload';
// ../lib/log-level.utils.js (existing, unchanged)
import { detectLogLevel, type LogLevel } from '../lib/log-level.utils.js';
```

**Steps**

- [ ] **Step 1 (test, initial fetch + stream start):** Create `use-log-tail.hook.test.ts`,
  structured like `use-file-manager.hook.test.ts` (`renderHook`/`act`/`waitFor` from
  `@testing-library/react`, `vi.stubGlobal('hyveon', ...)` since the hook checks
  `window.hyveon`):
  ```ts
  import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
  import { renderHook, act, waitFor, cleanup } from '@testing-library/react';
  import { useLogTail, type LogTailApi } from './use-log-tail.hook.js';
  import { toStreamHandleMock } from '../test-utils/stream-handle.test-utils.js';

  function makeApi(overrides: Partial<LogTailApi> = {}): LogTailApi {
    return {
      get: vi.fn().mockResolvedValue({ lines: [] }),
      stream: vi.fn().mockImplementation(toStreamHandleMock(async function* () {})),
      ...overrides,
    };
  }

  beforeEach(() => {
    vi.stubGlobal('hyveon', {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  describe('useLogTail', () => {
    it('should seed lines from api.get and call api.stream on mount for a non-empty target', async () => {
      const api = makeApi({ get: vi.fn().mockResolvedValue({ lines: ['line one', 'line two'] }) });
      const { result } = renderHook(() => useLogTail('watchdog', api));
      await waitFor(() => expect(result.current.lines).toHaveLength(2));
      expect(result.current.lines.map((l) => l.text)).toEqual(['line one', 'line two']);
      expect(api.get).toHaveBeenCalledWith('watchdog');
      expect(api.stream).toHaveBeenCalledWith('watchdog');
    });

    it('should not call api.get/api.stream when target is an empty string', () => {
      const api = makeApi();
      renderHook(() => useLogTail('', api));
      expect(api.get).not.toHaveBeenCalled();
      expect(api.stream).not.toHaveBeenCalled();
    });
  });
  ```
  Run `npm run app:test -- use-log-tail` — fails (module doesn't exist yet).
- [ ] **Step 2 (impl, hook skeleton — mount fetch/stream, no pause/filter yet):** Create
  `use-log-tail.hook.ts` with the fetch-on-mount/target-change effect and `startStream`,
  extracted verbatim from `logs.page.tsx`'s `startStream`/second `useEffect`, generalized
  from `game`/`selectedGame` to `target`/`api`:
  ```ts
  import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
  import type { HyveonStreamHandle, LogChunk } from '@hyveon/desktop-preload';
  import { detectLogLevel, type LogLevel } from '../lib/log-level.utils.js';

  const MAX_LINES = 1000;
  const AGE_TICK_MS = 10_000;

  export interface LogLine {
    text: string;
    level: LogLevel | null;
    receivedAt: number;
  }

  export interface LogTailApi {
    get: (target: string, limit?: number) => Promise<{ lines: string[] }>;
    stream: (target: string) => HyveonStreamHandle<LogChunk>;
  }

  export interface UseLogTailResult {
    lines: LogLine[];
    visibleLines: LogLine[];
    paused: boolean;
    autoscroll: boolean;
    setAutoscroll: (value: boolean) => void;
    search: string;
    setSearch: (value: string) => void;
    hiddenLevels: Set<LogLevel>;
    toggleLevel: (level: LogLevel) => void;
    error: string | null;
    bufferedCount: number;
    ageLabel: string | null;
    boxRef: React.RefObject<HTMLDivElement>;
    handlePauseToggle: () => void;
  }

  /** Format a millisecond age as a compact "Xs ago" / "Xm ago" / "Xh ago" string. */
  function formatAge(ms: number): string {
    if (ms < 1000) return 'just now';
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    return `${h}h ago`;
  }

  /**
   * Shared live-tail engine behind both `/logs` (game servers) and
   * `/logs/infrastructure` (Lambda functions) — see design.md D6. Owns the
   * initial-snapshot fetch and live IPC stream subscription for a single
   * `target`, the pause/buffer/resume model, the level filter, the
   * in-buffer search string, autoscroll, and the "oldest line age" footer
   * clock. Fully resets and re-subscribes whenever `target` changes —
   * callers do not reset state themselves before switching targets.
   *
   * @param target - The game name or `LambdaFunctionKey` to tail. An empty
   *   string means "nothing selected yet" — no fetch/stream starts.
   * @param api - The `get`/`stream` pair to call. Pass a stable reference
   *   (e.g. `window.hyveon.logs` or `window.hyveon.logs.lambda`) — an
   *   internal ref means a new object identity each render is tolerated,
   *   but a stable reference keeps the intent obvious.
   * @returns The live-tail state and handlers a log-viewer page renders.
   */
  export function useLogTail(target: string, api: LogTailApi): UseLogTailResult {
    const apiRef = useRef(api);
    apiRef.current = api;

    const [lines, setLines] = useState<LogLine[]>([]);
    const [paused, setPaused] = useState(false);
    const [autoscroll, setAutoscroll] = useState(true);
    const [search, setSearch] = useState('');
    const [hiddenLevels, setHiddenLevels] = useState<Set<LogLevel>>(new Set());
    const [error, setError] = useState<string | null>(null);
    const [now, setNow] = useState(() => Date.now());
    const [bufferedCount, setBufferedCount] = useState(0);

    const boxRef = useRef<HTMLDivElement>(null);
    const streamRef = useRef<HyveonStreamHandle<LogChunk> | null>(null);
    const pausedRef = useRef(false);
    const bufferRef = useRef<LogLine[]>([]);

    const appendLine = useCallback((text: string) => {
      const entry: LogLine = { text, level: detectLogLevel(text), receivedAt: Date.now() };
      if (pausedRef.current) {
        bufferRef.current.push(entry);
        setBufferedCount(bufferRef.current.length);
        return;
      }
      setLines((prev) => {
        const next = [...prev, entry];
        return next.length > MAX_LINES ? next.slice(-MAX_LINES) : next;
      });
    }, []);

    const stopStream = useCallback(() => {
      streamRef.current?.cancel();
      streamRef.current = null;
    }, []);

    const startStream = useCallback(
      (t: string) => {
        if (!window.hyveon) {
          setError('IPC bridge (window.hyveon) is not available in this context.');
          return;
        }
        stopStream();
        const handle = apiRef.current.stream(t);
        streamRef.current = handle;

        void (async () => {
          try {
            for await (const chunk of handle) {
              appendLine(chunk);
            }
          } catch (err: unknown) {
            if (streamRef.current !== handle) return;
            const message = err instanceof Error ? err.message : String(err);
            setError(`Stream ended with error: ${message}`);
          }
        })();
      },
      [stopStream, appendLine],
    );

    // Reset everything that described the previous target, then fetch the
    // new target's snapshot and (re)subscribe. Runs on mount and on every
    // `target` change — callers only change `target`, they don't reset
    // state first (that responsibility moved here from `LogsPage.selectGame`).
    useEffect(() => {
      setLines([]);
      bufferRef.current = [];
      setBufferedCount(0);
      pausedRef.current = false;
      setPaused(false);
      setError(null);

      if (!target) return;

      let cancelled = false;
      void (async () => {
        if (!window.hyveon) {
          if (!cancelled) setError('IPC bridge (window.hyveon) is not available in this context.');
          return;
        }
        try {
          const data = await apiRef.current.get(target);
          if (cancelled) return;
          setLines(data.lines.map((text) => ({ text, level: detectLogLevel(text), receivedAt: Date.now() })));
          startStream(target);
        } catch {
          if (!cancelled) {
            setError('Could not load initial logs; trying live stream.');
            startStream(target);
          }
        }
      })();

      return () => {
        cancelled = true;
        stopStream();
      };
    }, [target, startStream, stopStream]);

    useEffect(() => {
      const id = setInterval(() => setNow(Date.now()), AGE_TICK_MS);
      return () => clearInterval(id);
    }, []);

    useEffect(() => {
      if (autoscroll && !paused && boxRef.current) {
        boxRef.current.scrollTop = boxRef.current.scrollHeight;
      }
    }, [lines, autoscroll, paused]);

    const visibleLines = useMemo(
      () => lines.filter((l) => !(l.level && hiddenLevels.has(l.level))),
      [lines, hiddenLevels],
    );

    const oldest = visibleLines[0];
    const ageLabel = oldest ? formatAge(now - oldest.receivedAt) : null;

    const handlePauseToggle = useCallback(() => {
      const nowPaused = !pausedRef.current;
      pausedRef.current = nowPaused;
      setPaused(nowPaused);
      if (!nowPaused && bufferRef.current.length > 0) {
        const buffered = bufferRef.current;
        bufferRef.current = [];
        setBufferedCount(0);
        setLines((prev) => {
          const next = [...prev, ...buffered];
          return next.length > MAX_LINES ? next.slice(-MAX_LINES) : next;
        });
      }
    }, []);

    const toggleLevel = useCallback((lvl: LogLevel) => {
      setHiddenLevels((prev) => {
        const next = new Set(prev);
        if (next.has(lvl)) next.delete(lvl);
        else next.add(lvl);
        return next;
      });
    }, []);

    return {
      lines,
      visibleLines,
      paused,
      autoscroll,
      setAutoscroll,
      search,
      setSearch,
      hiddenLevels,
      toggleLevel,
      error,
      bufferedCount,
      ageLabel,
      boxRef,
      handlePauseToggle,
    };
  }
  ```
  Run `npm run app:test -- use-log-tail` — Step 1's two tests pass.
- [ ] **Step 3 (test, pause/resume + level filter):**
  ```ts
  it('should buffer incoming lines while paused and flush them into lines on resume', async () => {
    let push: ((line: string) => void) | undefined;
    const api = makeApi({
      stream: vi.fn().mockImplementation(
        toStreamHandleMock(async function* () {
          yield await new Promise<string>((resolve) => { push = resolve; });
        }),
      ),
    });
    const { result } = renderHook(() => useLogTail('watchdog', api));
    await waitFor(() => expect(api.stream).toHaveBeenCalled());
    act(() => result.current.handlePauseToggle());
    expect(result.current.paused).toBe(true);
    act(() => push?.('buffered line'));
    await waitFor(() => expect(result.current.bufferedCount).toBe(1));
    expect(result.current.lines).toHaveLength(0);
    act(() => result.current.handlePauseToggle());
    expect(result.current.paused).toBe(false);
    expect(result.current.lines.map((l) => l.text)).toEqual(['buffered line']);
    expect(result.current.bufferedCount).toBe(0);
  });

  it('should exclude lines whose level is hidden from visibleLines without removing them from lines', async () => {
    const api = makeApi({ get: vi.fn().mockResolvedValue({ lines: ['INFO up', 'ERROR down'] }) });
    const { result } = renderHook(() => useLogTail('watchdog', api));
    await waitFor(() => expect(result.current.lines).toHaveLength(2));
    act(() => result.current.toggleLevel('error'));
    expect(result.current.visibleLines.map((l) => l.text)).toEqual(['INFO up']);
    expect(result.current.lines).toHaveLength(2);
  });
  ```
  Run — both pass given Step 2's implementation (adjust the `toggleLevel` level literal to
  match whatever `LogLevel` union `log-level.utils.ts` actually exports, read at Step 2 time).
- [ ] **Step 4 (test, target switch resets and re-subscribes):**
  ```ts
  it('should reset lines/paused/error and cancel the previous stream when target changes', async () => {
    const cancel1 = vi.fn();
    const handle1 = toStreamHandleMock(async function* () {})();
    handle1.cancel = cancel1;
    const api = makeApi({
      get: vi.fn().mockResolvedValue({ lines: ['first-target line'] }),
      stream: vi.fn().mockReturnValueOnce(handle1).mockImplementation(toStreamHandleMock(async function* () {})),
    });
    const { result, rerender } = renderHook(({ target }) => useLogTail(target, api), {
      initialProps: { target: 'watchdog' },
    });
    await waitFor(() => expect(result.current.lines).toHaveLength(1));
    act(() => result.current.handlePauseToggle());
    rerender({ target: 'health-check' });
    await waitFor(() => expect(cancel1).toHaveBeenCalled());
    expect(result.current.paused).toBe(false);
    expect(api.get).toHaveBeenCalledWith('health-check');
  });
  ```
  Run — passes given Step 2's target-keyed effect (its cleanup calls `stopStream`, and the
  effect body resets `paused`/`lines` unconditionally on every run).
- [ ] **Step 5 (test, get/stream failure surfaces error):**
  ```ts
  it('should set error and still start the stream when api.get rejects', async () => {
    const api = makeApi({ get: vi.fn().mockRejectedValue(new Error('denied')) });
    const { result } = renderHook(() => useLogTail('watchdog', api));
    await waitFor(() => expect(result.current.error).toBe('Could not load initial logs; trying live stream.'));
    expect(api.stream).toHaveBeenCalledWith('watchdog');
  });

  it('should set an error message when the stream throws', async () => {
    const api = makeApi({
      stream: vi.fn().mockImplementation(
        toStreamHandleMock(async function* () {
          throw new Error('boom');
        }),
      ),
    });
    const { result } = renderHook(() => useLogTail('watchdog', api));
    await waitFor(() => expect(result.current.error).toBe('Stream ended with error: boom'));
  });
  ```
  Run `npm run app:test -- use-log-tail` — all tests pass. `npm run app:typecheck`,
  `npm run app:lint` — clean. Commit: `feat(web): extract useLogTail hook from logs.page.tsx`.
- [ ] **Step 6 (impl, refactor `logs.page.tsx` onto the hook):** Rewrite `logs.page.tsx`'s
  state to delegate to `useLogTail`, keeping only what's genuinely game-specific (games
  list, `GameCombobox`, navigation-state preselection, the `LiveBadge`, and the JSX shell —
  which stays byte-for-byte the same, since every prop it reads is still named the same
  thing, just sourced from the hook's return value instead of local `useState`s).

  A `LogTailApi` is a required, non-optional parameter, but `window.hyveon` can be
  `undefined` outside Electron. Add a module-level constant so the hook call site never
  needs an unsafe cast — `useLogTail`'s own internal `!window.hyveon` guard already
  short-circuits before either method would run, so this fallback's bodies are dead code
  in practice, but they still need a real, type-correct implementation:
  ```ts
  const NO_HYVEON_STREAM_HANDLE: HyveonStreamHandle<LogChunk> = {
    next: () => Promise.resolve({ done: true }),
    cancel: () => {},
    [Symbol.asyncIterator]: () => NO_HYVEON_STREAM_HANDLE,
  };

  /** Used only when `window.hyveon` is absent (non-Electron context); `useLogTail`'s own guard means neither method here actually runs. */
  const NO_HYVEON_LOG_TAIL_API: LogTailApi = {
    get: () => Promise.resolve({ lines: [] }),
    stream: () => NO_HYVEON_STREAM_HANDLE,
  };
  ```
  Full rewritten file:
  ```tsx
  import { useEffect, useRef, useState } from 'react';
  import { useLocation } from 'react-router-dom';
  import { Filter, Pause, Play, Search } from 'lucide-react';
  import type { HyveonStreamHandle, LogChunk } from '@hyveon/desktop-preload';
  import { api } from '../api.service.js';
  import { Badge } from '../components/ui/badge.component.js';
  import { Button } from '../components/ui/button.component.js';
  import { Input } from '../components/ui/input.component.js';
  import { HighlightedLine, LevelFilterMenu } from '../components/log-line-display.component.js';
  import { GameCombobox } from '../components/game-combobox.component.js';
  import { cn } from '../lib/utils.utils.js';
  import { PollingIndicator } from '../polling/polling-indicator.component.js';
  import { LOG_LEVEL_BADGE } from '../lib/log-level.utils.js';
  import { useLogTail, type LogTailApi } from '../hooks/use-log-tail.hook.js';

  /** Shape of the react-router navigation state `GameCard` passes via `<Link to="/logs" state={{ game }}>`. */
  interface LogsNavState {
    game?: string;
  }

  /** Reads the `game` field off a react-router `location.state` value, if present and a string. */
  function gameFromLocationState(state: unknown): string | null {
    if (!state || typeof state !== 'object') return null;
    const game = (state as LogsNavState).game;
    return typeof game === 'string' ? game : null;
  }

  const NO_HYVEON_STREAM_HANDLE: HyveonStreamHandle<LogChunk> = {
    next: () => Promise.resolve({ done: true }),
    cancel: () => {},
    [Symbol.asyncIterator]: () => NO_HYVEON_STREAM_HANDLE,
  };

  /** Used only when `window.hyveon` is absent (non-Electron context); `useLogTail`'s own guard means neither method here actually runs. */
  const NO_HYVEON_LOG_TAIL_API: LogTailApi = {
    get: () => Promise.resolve({ lines: [] }),
    stream: () => NO_HYVEON_STREAM_HANDLE,
  };

  /**
   * Logs route (`/logs`) — full-page tailing of CloudWatch logs for a single
   * game. Owns game selection (list load, `GameCombobox`, navigation-state
   * preselection); the fetch/stream/pause/filter/autoscroll engine itself is
   * {@link useLogTail} (design.md D6), shared with `/logs/infrastructure`.
   */
  export function LogsPage() {
    const location = useLocation();
    const preselectedGameRef = useRef(gameFromLocationState(location.state));
    const [games, setGames] = useState<string[]>([]);
    const [selectedGame, setSelectedGame] = useState<string>('');
    const [filtersOpen, setFiltersOpen] = useState(false);
    const [loadGamesError, setLoadGamesError] = useState<string | null>(null);

    const {
      visibleLines,
      paused,
      autoscroll,
      setAutoscroll,
      search,
      setSearch,
      hiddenLevels,
      toggleLevel,
      error: tailError,
      bufferedCount,
      ageLabel,
      boxRef,
      handlePauseToggle,
    } = useLogTail(selectedGame, window.hyveon ? window.hyveon.logs : NO_HYVEON_LOG_TAIL_API);

    // Load the games list once (this page is reachable independently of the dashboard).
    useEffect(() => {
      let cancelled = false;
      void (async () => {
        try {
          const res = await api.games();
          if (cancelled) return;
          const names = res.games.map((g) => g.name);
          setGames(names);
          if (names.length > 0) {
            const preselected = preselectedGameRef.current;
            const initial = preselected && names.includes(preselected) ? preselected : names[0]!;
            setSelectedGame((cur) => cur || initial);
          }
        } catch {
          if (!cancelled) setLoadGamesError('Could not load games.');
        }
      })();
      return () => {
        cancelled = true;
      };
    }, []);

    const error = loadGamesError ?? tailError;

    const toggleLevelHandler = (lvl: Parameters<typeof toggleLevel>[0]) => toggleLevel(lvl);

    // JSX shell below is IDENTICAL to the pre-refactor `logs.page.tsx` body
    // (same header/controls-row/filter-drawer/log-box/footer/LiveBadge JSX),
    // with two changes only: `GameCombobox`'s `onChange` now passes
    // `setSelectedGame` directly (no more `selectGame` wrapper — the reset
    // that wrapper used to do by hand now lives inside `useLogTail`), and
    // `toggleLevel`'s call sites read `toggleLevelHandler` in place of the
    // old inline `toggleLevel` closure. Every other identifier
    // (`visibleLines`, `paused`, `autoscroll`, `setAutoscroll`, `search`,
    // `setSearch`, `hiddenLevels`, `error`, `bufferedCount`, `ageLabel`,
    // `boxRef`, `handlePauseToggle`, `filtersOpen`, `setFiltersOpen`, `games`,
    // `selectedGame`) keeps its exact pre-refactor name, so the JSX itself —
    // header, controls row (`GameCombobox`, filter toggle, search input,
    // `LevelFilterMenu`, autoscroll checkbox, pause/resume button), mobile
    // filter drawer, error banner, log box (`visibleLines.map` with
    // `HighlightedLine`), footer, and the module-scope `LiveBadge` function —
    // is copied verbatim from the pre-refactor file read in full above
    // (lines 274–449), with `onChange={selectGame}` → `onChange={setSelectedGame}`
    // as the only textual diff inside that JSX.
    // [`return (...)` continues here — see note below]
  }
  ```
  **Note for the implementer:** the snippet above is deliberately cut off before the JSX
  `return` — everything shown (imports, constants, state, the `useLogTail` call, the
  games-list effect, `toggleLevelHandler`) is final code. The `return (...)` itself is
  `logs.page.tsx` lines 274–449 verbatim (already on disk, read in full earlier in this
  plan), with only the single `onChange={selectGame}` → `onChange={setSelectedGame}`
  substitution, and `LiveBadge` left as its own module-scope function exactly as today.
  Reproducing ~175 unchanged lines of JSX in this plan would add bulk without adding
  information; the diff is fully specified by that one substitution plus everything
  above the cut.
  Also delete the now-unused `selectGame` callback (its body — `setSelectedGame`, reset
  `lines`/buffer/`paused`/`error` — moved into `useLogTail`'s target-change effect in
  Task 5 Step 2) and the now-unused `Set`/`useCallback`/`useMemo`/`MAX_LINES`/`AGE_TICK_MS`/
  `LogLine`/`formatAge`/`detectLogLevel` imports and local definitions — all of that logic
  and its imports now live solely in `use-log-tail.hook.ts`.
  Run `npm run app:test -- logs.page` (NOT `logs.page.test.tsx` edited) — must pass with
  the file completely unchanged. If any assertion fails, the refactor introduced a
  behavioral difference — fix `logs.page.tsx`, never the test (per D6's regression-gate
  trade-off).
- [ ] **Step 7:** `npm run app:test -- logs.page use-log-tail`, `npm run app:typecheck`,
  `npm run app:lint` — all clean. Commit: `refactor(web): move logs.page.tsx onto useLogTail`.

---

### Task 6: Infrastructure logs page

Implements the "Infrastructure logs page" requirement, built directly on `useLogTail` (Task 5)
per design D6 — not a parallel re-implementation of the same state machine.

**Files**

- Create: `app/packages/web/src/pages/infrastructure-logs.page.tsx`
- Create: `app/packages/web/src/pages/infrastructure-logs.page.test.tsx`
- Modify: `app/packages/web/src/app.component.tsx` (register the route)
- Create: `app/packages/web/e2e/pages/InfrastructureLogsPage.ts`
- Modify: `app/packages/web/e2e/pages/index.ts` (export it)

**Interfaces produced**

```tsx
export function InfrastructureLogsPage(): JSX.Element;
```

Consumes `useLogTail(selectedFunction, window.hyveon.logs.lambda)` (Task 5), which itself calls
`window.hyveon.logs.lambda.get(functionKey, limit?)` and
`window.hyveon.logs.lambda.stream(functionKey)` (Task 3).

**Steps**

- [ ] **Step 1 (test, page renders picker + calls lambda.get on mount):** Create
  `infrastructure-logs.page.test.tsx`, structured like `logs.page.test.tsx` (mock
  `../api.service.js` for `games`/`status`/`costsEstimate` since `renderPage()` wraps every
  render in `GameStatusProvider`; `vi.stubGlobal('hyveon', hyveonMock)` with
  `logs: { lambda: { get: vi.fn(), stream: vi.fn() } }`):
  ```ts
  const hyveonMock = {
    logs: { lambda: { get: vi.fn(), stream: vi.fn() } },
  };
  vi.stubGlobal('hyveon', hyveonMock);
  import { InfrastructureLogsPage } from './infrastructure-logs.page.js';

  beforeEach(() => {
    apiMock.games.mockResolvedValue({ games: [] });
    apiMock.status.mockResolvedValue([]);
    apiMock.costsEstimate.mockResolvedValue({ games: {}, totalPerHourIfAllOn: 0 });
    hyveonMock.logs.lambda.get.mockResolvedValue({ functionKey: 'watchdog', lines: ['seeded'] });
    hyveonMock.logs.lambda.stream.mockImplementation(toStreamHandleMock(async function* () {}));
  });

  it('should render a heading and all 5 function options in the picker', async () => {
    renderPage(<InfrastructureLogsPage />);
    expect(await screen.findByRole('heading', { name: /infrastructure logs/i })).toBeInTheDocument();
    for (const label of ['watchdog', 'health-check', 'dns-updater', 'interactions', 'followup']) {
      expect(screen.getByRole('button', { name: new RegExp(label, 'i') })).toBeInTheDocument();
    }
  });

  it('should default to watchdog and call logs.lambda.get on mount', async () => {
    renderPage(<InfrastructureLogsPage />);
    await waitFor(() => expect(hyveonMock.logs.lambda.get).toHaveBeenCalledWith('watchdog'));
  });
  ```
  Run `npm run app:test -- infrastructure-logs.page` — fails (page doesn't exist).
- [ ] **Step 2 (impl, page — picker + `useLogTail`):** Create `infrastructure-logs.page.tsx`.
  All buffering/pause/stream/level-filter/autoscroll state comes from `useLogTail` (Task 5) —
  this page owns only `selectedFunction` and the JSX:
  ```tsx
  import { useState } from 'react';
  import { Filter, Pause, Play, Search } from 'lucide-react';
  import { LAMBDA_FUNCTION_KEYS, type LambdaFunctionKey } from '@hyveon/shared';
  import { Badge } from '../components/ui/badge.component.js';
  import { Button } from '../components/ui/button.component.js';
  import { Input } from '../components/ui/input.component.js';
  import { HighlightedLine, LevelFilterMenu } from '../components/log-line-display.component.js';
  import { cn } from '../lib/utils.utils.js';
  import { PollingIndicator } from '../polling/polling-indicator.component.js';
  import { LOG_LEVEL_BADGE } from '../lib/log-level.utils.js';
  import { useLogTail } from '../hooks/use-log-tail.hook.js';

  /**
   * Infrastructure Logs route (`/logs/infrastructure`) — live-tails CloudWatch
   * logs for a picked Lambda function. The tail engine itself is
   * {@link useLogTail} (design.md D6), the same hook `LogsPage` (`/logs`)
   * consumes; this page owns only the fixed 5-option
   * {@link LambdaFunctionKey} picker and `window.hyveon.logs.lambda` wiring.
   */
  export function InfrastructureLogsPage() {
    const [selectedFunction, setSelectedFunction] = useState<LambdaFunctionKey>('watchdog');

    const {
      visibleLines,
      paused,
      autoscroll,
      setAutoscroll,
      search,
      setSearch,
      hiddenLevels,
      toggleLevel,
      error,
      bufferedCount,
      ageLabel,
      boxRef,
      handlePauseToggle,
    } = useLogTail(selectedFunction, window.hyveon ? window.hyveon.logs.lambda : NO_HYVEON_LOG_TAIL_API);

    return (
      <div className="mx-auto flex h-full max-w-6xl flex-col gap-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-2xl font-semibold text-[var(--color-foreground)]">Infrastructure Logs</h2>
            <p className="text-sm text-[var(--color-muted-foreground)]">
              CloudWatch tail for the selected Lambda function.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <PollingIndicator />
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          {LAMBDA_FUNCTION_KEYS.map((fn) => (
            <Button
              key={fn}
              variant={selectedFunction === fn ? 'default' : 'secondary'}
              size="sm"
              onClick={() => setSelectedFunction(fn)}
              aria-pressed={selectedFunction === fn}
            >
              {fn}
            </Button>
          ))}
        </div>

        {/* controls row (search input, LevelFilterMenu, autoscroll checkbox,
            pause/resume button), error banner, log box, footer — copied
            verbatim from logs.page.tsx's `return (...)` (lines 290–423 of the
            pre-refactor file), minus the GameCombobox block and mobile
            filter-drawer toggle (this page has no game selector, and its
            fixed 5-button picker never needs to collapse for space the way
            GameCombobox's search input does) */}
      </div>
    );
  }
  ```
  `NO_HYVEON_LOG_TAIL_API` is the same module-level fallback constant Task 5 Step 6 defines
  for `logs.page.tsx` — re-declare the identical `NO_HYVEON_STREAM_HANDLE`/
  `NO_HYVEON_LOG_TAIL_API` pair at the top of this file too (it's a 6-line constant, not
  worth a third shared module for two call sites).
  There is no `location.state` preselection here — `LambdaFunctionKey` isn't navigated to
  from a card the way a game is, so `selectedFunction` always starts at `'watchdog'`, the
  first entry in `LAMBDA_FUNCTION_KEYS`.
  Run `npm run app:test -- infrastructure-logs.page` — Step 1 tests pass.
- [ ] **Step 3 (test, switching functions restarts the stream):**
  ```ts
  it('should call logs.lambda.get with the newly picked function after switching', async () => {
    renderPage(<InfrastructureLogsPage />);
    await waitFor(() => expect(hyveonMock.logs.lambda.get).toHaveBeenCalledWith('watchdog'));
    await userEvent.setup().click(screen.getByRole('button', { name: /health-check/i }));
    await waitFor(() => expect(hyveonMock.logs.lambda.get).toHaveBeenCalledWith('health-check'));
  });

  it('should cancel the previous stream handle when switching functions', async () => {
    const handle1 = { next: vi.fn(), cancel: vi.fn(), [Symbol.asyncIterator]: function () { return this; } };
    hyveonMock.logs.lambda.stream.mockReturnValueOnce(handle1);
    renderPage(<InfrastructureLogsPage />);
    await waitFor(() => expect(hyveonMock.logs.lambda.stream).toHaveBeenCalledWith('watchdog'));
    await userEvent.setup().click(screen.getByRole('button', { name: /followup/i }));
    await waitFor(() => expect(handle1.cancel).toHaveBeenCalled());
  });
  ```
  Already passes — `useLogTail`'s target-change effect (Task 5 Step 2) calls `stopStream()`
  in its cleanup whenever `target` (here, `selectedFunction`) changes, so this is inherited
  hook behavior, not page-specific code. Run to confirm green; this directly covers the
  spec's "Operator switches functions" scenario and tasks.md 6.3.
- [ ] **Step 4 (route registration):** In `app.component.tsx`, add
  `import { InfrastructureLogsPage } from './pages/infrastructure-logs.page.js';` and
  `<Route path="/logs/infrastructure" element={<InfrastructureLogsPage />} />` immediately
  after the existing `<Route path="/logs" element={<LogsPage />} />` line, and add
  `/logs/infrastructure` to the route-list doc comment above `export default function App()`.
- [ ] **Step 5 (Playwright page object):** Create `InfrastructureLogsPage.ts` in
  `app/packages/web/e2e/pages/`, mirroring `LogsPage.ts`'s shape (only the subset of locators
  the new page actually needs — no search/level-filter/autoscroll duplication unless the page
  keeps those controls, per Step 2's "mirrors verbatim" body it does):
  ```ts
  import type { Page, Locator } from '@playwright/test';
  import { gotoHashRoute } from './hashRoute.js';

  /** Page object for the `/logs/infrastructure` route (Lambda log viewer). */
  export class InfrastructureLogsPage {
    constructor(public readonly page: Page) {}

    async goto(): Promise<void> {
      await gotoHashRoute(this.page, '/logs/infrastructure');
    }

    heading(): Locator {
      return this.page.getByRole('heading', { name: 'Infrastructure Logs' });
    }

    /** Function picker button by `LambdaFunctionKey`, e.g. `'watchdog'`, `'health-check'`. */
    functionButton(functionKey: string): Locator {
      return this.page.getByRole('button', { name: functionKey, exact: true });
    }

    async selectFunction(functionKey: string): Promise<void> {
      await this.functionButton(functionKey).click();
    }
  }
  ```
  Export it from `app/packages/web/e2e/pages/index.ts`:
  `export { InfrastructureLogsPage } from './InfrastructureLogsPage.js';`
- [ ] **Step 6:** `npm run app:test -- infrastructure-logs.page`, `npm run app:lint`,
  `npm run app:typecheck` — all clean. Commit:
  `feat(web): add /logs/infrastructure page with Lambda function picker`.

---

### Task 7: E2E coverage (chromium stub tier)

Implements tasks.md 7.1–7.2.

**Files**

- Modify: `app/packages/web/e2e/fixtures/hyveon-http-bridge.ts` (add `logs.lambda` stub to the
  `logs` namespace, mirroring the existing `logs.get`/`logs.stream` shape-completeness stub)
- Modify: `app/packages/web/e2e/fixtures/index.ts` (add `lambdaLogLines` to `StubOptions` and
  the `stubApis` `addInitScript` override, mirroring `logLines`/`opts.logLines`)
- Create: `app/packages/web/e2e/specs/infrastructure-logs.spec.ts`

**Steps**

- [ ] **Step 1 (impl, hyveon-http-bridge.ts):** In the `logs` block, add:
  ```ts
  logs: {
    get: (game: string, limit?: number) =>
      call(`/api/logs/${game}${limit ? `?limit=${limit}` : ''}`),
    stream: async function* () {},
    lambda: {
      get: async (functionKey: string) => ({ functionKey, lines: [] }),
      stream: async function* () {},
    },
  },
  ```
- [ ] **Step 2 (impl, index.ts):** Add to `StubOptions`:
  ```ts
  /**
   * Initial log lines surfaced via `window.hyveon.logs.lambda.get(functionKey)`
   * (used by the Infrastructure Logs page). Maps `LambdaFunctionKey` → seeded
   * lines. Functions not present in the map receive an empty buffer. Same
   * shape and rationale as {@link logLines} for the Games logs page.
   */
  lambdaLogLines?: Record<string, string[]>;
  ```
  Extend the `stubApis` body's `logLines` destructure to also read `lambdaLogLines`, and merge
  a `logs.lambda` stub into the same `page.addInitScript` call that already overrides
  `window.hyveon.logs`:
  ```ts
  const lambdaLogLines = opts.lambdaLogLines ?? {};
  // ...
  await page.addInitScript(
    ({ lines, lambdaLines }: { lines: Record<string, string[]>; lambdaLines: Record<string, string[]> }) => {
      const existing = (window as unknown as Record<string, unknown>)['hyveon'] as Record<string, unknown> | undefined;
      (window as unknown as Record<string, unknown>)['hyveon'] = {
        ...(existing ?? {}),
        logs: {
          get: (game: string) => Promise.resolve({ game, lines: lines[game] ?? [] }),
          stream: async function* (_game: string, _signal?: AbortSignal) {},
          lambda: {
            get: (functionKey: string) => Promise.resolve({ functionKey, lines: lambdaLines[functionKey] ?? [] }),
            stream: async function* (_functionKey: string, _signal?: AbortSignal) {},
          },
        },
      };
    },
    { lines: logLines, lambdaLines: lambdaLogLines },
  );
  ```
- [ ] **Step 3 (spec):** Create `infrastructure-logs.spec.ts` in
  `app/packages/web/e2e/specs/`, mirroring `logs.spec.ts`'s chromium-tier structure but using
  `test`/`stubApis`/`layout`/a new `infraLogs` fixture. Since `infraLogs` isn't yet a fixture
  in `index.ts`'s `E2EFixtures`, either add it there (mirroring the `logs:` fixture entry) or
  construct `new InfrastructureLogsPage(page)` directly in the spec — prefer adding the fixture
  for consistency with every other page object in this file. Add to `E2EFixtures` and
  `test.extend`:
  ```ts
  infraLogs: InfrastructureLogsPage;
  // ...
  infraLogs: async ({ page }, use) => { await use(new InfrastructureLogsPage(page)); },
  ```
  and export `InfrastructureLogsPage` alongside the other page-object re-exports at the top of
  `index.ts`.
  ```ts
  import { test, expect, stubApis } from '../fixtures/index.js';

  test.describe('infrastructure logs page', () => {
    test('should render Games and Infrastructure links in the nested Logs sidebar group', async ({ page, layout }) => {
      await stubApis(page);
      await page.goto('/');
      await expect(layout.sidebarLink('Games')).toBeVisible();
      await expect(layout.sidebarLink('Infrastructure')).toBeVisible();
    });

    test('should show the function picker and seeded logs on navigation', async ({ page, infraLogs }) => {
      await stubApis(page, { lambdaLogLines: { watchdog: ['watchdog seeded line'] } });
      await infraLogs.goto();
      await expect(infraLogs.heading()).toBeVisible();
      await expect(page.getByText('watchdog seeded line')).toBeVisible();
    });

    test('should show a different function\'s seeded lines after switching', async ({ page, infraLogs }) => {
      await stubApis(page, {
        lambdaLogLines: { watchdog: ['watchdog line'], 'health-check': ['health-check line'] },
      });
      await infraLogs.goto();
      await expect(page.getByText('watchdog line')).toBeVisible();
      await infraLogs.selectFunction('health-check');
      await expect(page.getByText('health-check line')).toBeVisible();
      await expect(page.getByText('watchdog line')).not.toBeVisible();
    });
  });
  ```
- [ ] **Step 4:** `npm run app:test:e2e` (full tier-1 run — chromium + electron projects) —
  green. Commit: `test(e2e): add /logs/infrastructure chromium coverage`.

---

### Task 8: Docs

Implements tasks.md 8.1–8.4.

**Files**

- Modify: `docs/docs/app/logs.md` (full content read above — lines 1–190)
- Modify: `docs/docs/components/management-app.md` (IPC channel table, line 189 area)
- Modify: `docs/docs/components/integration-tests.md` (if it names `logs.page.tsx`'s
  buffering/pause/stream logic directly, per tasks.md 8.3 — update it to name
  `useLogTail` as the owner of that behavior instead)

**Steps**

- [ ] **Step 1:** Use the `write-docs` skill for this task rather than hand-editing — it maps
  the diff to owning pages and runs the three `docs-*` evaluator agents automatically. Feed it:
  the new `/logs/infrastructure` route, the `logs.lambda.get`/`logs.lambda.stream` IPC
  channels, the nested sidebar `Logs` group (`Games`/`Infrastructure` children), and the 5
  `LambdaFunctionKey` values.
- [ ] **Step 2 (manual fallback checklist, if not using the skill):**
  - In `docs/docs/app/logs.md`'s "What this page is not" section, replace the
    `- It does not show Lambda logs. …` bullet with a link to the new page:
    `- Lambda logs are shown separately on the [Infrastructure Logs](/app/logs-infrastructure)
    page (\`/logs/infrastructure\`).` — plus a new sibling doc page or a section within this
    same file documenting the function picker, the 5 function names, and the nested sidebar
    (mirror this file's own structure: "Where the logs come from" → resolved log group naming,
    "Choosing a function" → picker behaviour, reuse "Log levels"/"Pause and Resume"/"The
    1000-line buffer" sections verbatim since the new page shares that behaviour exactly).
  - In `docs/docs/components/management-app.md`, extend the `LogsController` row (line 189) to
    list all four channels: `` `logs.get`, `logs.stream`, `logs.lambda.get`, `logs.lambda.stream` ``,
    updating the description to mention the Lambda log-group resolution.
  - In `docs/docs/components/integration-tests.md`, check for any prose naming
    `logs.page.tsx` as the owner of the buffering/pause/level-filter/autoscroll jsdom
    test conventions; if present, update it to name `useLogTail`
    (`app/packages/web/src/hooks/use-log-tail.hook.ts`) as the actual owner, with
    `logs.page.tsx`/`infrastructure-logs.page.tsx` as its two current page-level
    consumers.
- [ ] **Step 3:** Run the `write-docs` skill's evaluator pass (accuracy, coverage, style) over
  every changed docs page before opening the PR, per CLAUDE.md's "Before opening a PR" section
  — do this even if Step 1's skill invocation already ran it, as a final check after any manual
  Step 2 edits.

---

### Task 9: Pre-PR verification

- [ ] **Step 1:** `npm run app:lint` — clean.
- [ ] **Step 2:** `npm run app:typecheck` — clean.
- [ ] **Step 3:** `npm run app:test` — full unit suite green, including the new
  `use-log-tail.hook.test.ts` and `logs.page.test.tsx` passing unchanged (Task 5's
  regression gate).
- [ ] **Step 4:** `npm run app:test:e2e` — green (renderer/preload/IPC surface changed; covers
  both the `chromium` and `electron` projects).
- [ ] **Step 5:** `npm run app:test:integration` — run and confirm green even though no
  controller/service touched here sits on the tier-2 integration harness's direct path; run it
  anyway since `LogsController`/`LogsService` are exercised by the in-process DI container per
  CLAUDE.md's "controllers, services, or the Pulumi orchestration changed" trigger.
- [ ] **Step 6:** `/opsx:sync` to fold `specs/infra-log-viewer/spec.md` into
  `openspec/specs/infra-log-viewer/spec.md` (new capability — first sync creates it), or archive
  per the repo's OpenSpec workflow rules once the PR merges.
- [ ] **Step 7:** Confirm every "Before opening a PR" doc-update requirement in CLAUDE.md is
  satisfied (Task 8) before requesting review.

---

## Self-review notes

- **Spec coverage:** every requirement in `specs/infra-log-viewer/spec.md` maps to at least one
  task — log-group resolution (Task 2), recent-fetch (Task 2), live-tail (Task 2 + 3), the
  routed page's "reuses the same live-tail UI component" requirement (Task 5 extracts that
  component as `useLogTail`; Task 6 consumes it), sidebar nav (Task 4). Every tasks.md
  numbered group (1–9) maps 1:1 to a plan task, with 7.1/7.2 folded into Task 7 and
  8.1–8.4 into Task 8.
- **Type/signature consistency:** `LambdaFunctionKey` (Task 1) is the single type threaded
  through `LogsService` (Task 2), `LogsController`/preload (Task 3), and the page (Task 6) —
  no per-layer re-declaration. IPC payload shapes (`{ functionKey, limit? }` →
  `{ functionKey, lines }` for `.get`; `{ streamId }` for `.stream`) match tasks.md 3.1
  verbatim and mirror the existing `logs.get`/`logs.stream` shapes exactly. `useLogTail`'s
  `(target: string, api: LogTailApi)` signature (Task 5) is identical at both call sites —
  `useLogTail(selectedGame, window.hyveon.logs)` in `logs.page.tsx` (Task 5 Step 6) and
  `useLogTail(selectedFunction, window.hyveon.logs.lambda)` in `infrastructure-logs.page.tsx`
  (Task 6 Step 2) — because `HyveonLogsApi`/`HyveonLambdaLogsApi` (Task 3) both already
  expose a `get(target, limit?)`/`stream(target)` pair with that exact shape, so `LogTailApi`
  is structurally satisfied by either without an adapter.
- **No placeholders:** every code snippet above is real, working TypeScript/TSX derived
  directly from the existing `LogsService`/`LogsController`/`preload.ts`/`logs.page.tsx`
  source read in full before writing this plan — not sketch pseudocode. The one exception is
  explicitly called out inline (Task 5 Step 6's rewritten `logs.page.tsx`): the JSX `return`
  is not reproduced because it is unchanged from the pre-refactor file (already on disk) save
  for one substitution named in that step, and duplicating ~175 unchanged lines here would
  add bulk without adding information — every line of *new or changed* code in that step is
  written out in full.
- **Flagged judgment calls** (see the report handed back to the user): the exact channel-naming
  scheme `logs.lambda.stream.<id>.*` (design.md only said "a distinct streamId/channel
  namespace"); the function-picker UI as a `Button` row rather than the `Select`/`Combobox`
  components (no established Radix `Select` usage/jsdom test pattern exists elsewhere in this
  codebase to mirror, and a 5-item fixed set doesn't need `GameCombobox`'s search affordance);
  and design D6's extraction of `useLogTail` as a state-only hook rather than a full
  `<LogTailPanel>` presentational component, since the two pages' picker UIs genuinely differ
  (searchable combobox vs. fixed button row) while their tail state/effects are identical.
