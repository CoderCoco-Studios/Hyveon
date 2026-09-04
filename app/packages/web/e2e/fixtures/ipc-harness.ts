import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import type { INestApplicationContext, Type } from '@nestjs/common';
// Deep imports into @hyveon/desktop-main's compiled `dist/` output. The
// package has no `exports` map, so subpath resolution is unrestricted;
// `npm run app:build` must have produced `dist/` before this module loads.
import { AppModule } from '@hyveon/desktop-main/dist/app.module.js';
import { PulumiService } from '@hyveon/desktop-main/dist/services/PulumiService.js';
import { installEcsMock } from '@hyveon/desktop-main/dist/test-mocks/ecs-mock.js';
import { mockStore } from '@hyveon/desktop-main/dist/test-mocks/mock-store.js';
import type { MockResponse } from '@hyveon/desktop-main/dist/test-mocks/mock-store.js';
import { PulumiServiceStub } from '@hyveon/desktop-main/dist/test-mocks/pulumi-mock.js';
import {
  installRunRecordDynamoMock,
  runRecordMockStore,
} from '@hyveon/desktop-main/dist/test-mocks/run-record-mock.js';
import {
  installRemoteFileStoreMock,
  remoteFileStoreMockStore,
} from '@hyveon/desktop-main/dist/test-mocks/remote-file-store-mock.js';

/** Extracts the parameter tuple of `TController[TMethod]` when it's a function. */
type HandlerArgs<TController, TMethod extends keyof TController> = TController[TMethod] extends (
  ...args: infer TArgs
) => unknown
  ? TArgs
  : never;

/** Extracts the (awaited) return type of `TController[TMethod]` when it's a function. */
type HandlerResult<TController, TMethod extends keyof TController> = TController[TMethod] extends (
  ...args: never[]
) => infer TResult
  ? Awaited<TResult>
  : never;

/**
 * In-process IPC test harness for tier-2 integration specs.
 *
 * Built by {@link createIpcHarness}, which compiles the real `AppModule` DI
 * container via `@nestjs/testing`'s `Test.createTestingModule().compile()`
 * — no HTTP listener, no Electron IPC microservice transport, and no child
 * process involved. `@MessagePattern`-decorated controller methods (e.g.
 * `GamesController.listGames`) are plain class methods, so {@link dispatch}
 * invokes them directly on the container-resolved instance, exercising the
 * exact same providers (`ConfigService`, `EcsService`, ...) the Electron IPC
 * transport would route to at runtime — except `PulumiService`, which is
 * substituted for a scriptable {@link PulumiServiceStub} at the DI seam (see
 * {@link createIpcHarness}'s own doc comment).
 */
export interface IpcHarness {
  /**
   * Invokes `method` on the container-resolved instance of `controller`,
   * forwarding `args` exactly as an IPC caller would pass a `@Payload()`.
   *
   * @example
   * ```ts
   * const { games } = await harness.dispatch(GamesController, 'listGames');
   * ```
   */
  dispatch<TController extends object, TMethod extends keyof TController>(
    controller: Type<TController>,
    method: TMethod,
    ...args: HandlerArgs<TController, TMethod>
  ): Promise<HandlerResult<TController, TMethod>>;

  /**
   * Resolves `token` directly from the container-built `AppModule` context —
   * e.g. `harness.get(PulumiService)` — so a spec can drive a service's
   * own async generators (`preview`/`apply`/`destroy`) or call methods a
   * controller doesn't expose 1:1, while still exercising the exact same
   * instance (and its injected `RunRecordService`/`ConfigService`/etc.) the
   * IPC transport would resolve at runtime.
   */
  get<TProvider>(token: Type<TProvider>): TProvider;

  /**
   * `pushListTasks`/`pushDescribeTasks`/`pushRunTask`/`pushStopTask`/`reset`
   * queue mock ECS SDK responses, consumed FIFO by the interceptor installed
   * via `installEcsMock()` — thin wrappers over the shared `mockStore` so
   * specs never need to know the HTTP-tier's `/api/test/mocks/*` control
   * surface. `pulumi` is the scriptable `PulumiService` DI-seam stub — see
   * its own doc comment below.
   */
  mocks: {
    pushListTasks(response: MockResponse): void;
    pushDescribeTasks(response: MockResponse): void;
    pushRunTask(response: MockResponse): void;
    pushStopTask(response: MockResponse): void;
    reset(): void;
    /**
     * The scriptable `PulumiService` stub substituted at this harness's DI
     * seam — e.g. `harness.mocks.pulumi.scriptStackOutputs({ ... })` before
     * dispatching a channel that reads `ConfigService.getStackOutputs()`.
     * See {@link PulumiServiceStub}'s own doc comment for the full
     * scripting surface (`scriptPreview`/`scriptApply`/`scriptDestroy`/
     * `scriptOperationInFlight`/`scriptDestroyToken`).
     */
    pulumi: PulumiServiceStub;
  };

  /** Tears down the Nest application context. */
  close(): Promise<void>;
}

/**
 * Compiles the in-process IPC test harness.
 *
 * Builds the real `AppModule` DI container via `@nestjs/testing`'s
 * `Test.createTestingModule({ imports: [AppModule] }).overrideProvider(PulumiService).useValue(pulumiStub).compile()`,
 * not `NestFactory.createApplicationContext()` — a `TestingModule` extends
 * `NestApplicationContext` so it's already a drop-in `INestApplicationContext`
 * once compiled, and `createApplicationContext()` has no provider-override
 * hook at all. `pulumiStub` becomes the container's `PulumiService` for every
 * injecting consumer, so no integration spec built through this harness can
 * reach a real Pulumi engine or real AWS.
 *
 * Also installs the ECS, run-record DynamoDB, and configuration-bucket S3
 * mock interceptors, resetting their backing stores first so a prior spec's
 * records never leak into a freshly built context.
 */
export async function createIpcHarness(): Promise<IpcHarness> {
  installEcsMock();
  runRecordMockStore.reset();
  installRunRecordDynamoMock();
  remoteFileStoreMockStore.reset();
  installRemoteFileStoreMock();

  const pulumiStub = new PulumiServiceStub();

  const testingModule = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PulumiService)
    .useValue(pulumiStub)
    .compile();
  testingModule.useLogger(false);
  const context: INestApplicationContext = testingModule;

  return {
    async dispatch<TController extends object, TMethod extends keyof TController>(
      controller: Type<TController>,
      method: TMethod,
      ...args: HandlerArgs<TController, TMethod>
    ): Promise<HandlerResult<TController, TMethod>> {
      const instance = context.get(controller, { strict: false });
      const handler = instance[method];
      if (typeof handler !== 'function') {
        throw new Error(`${controller.name}.${String(method)} is not a callable IPC handler`);
      }
      const result = await (handler as (...a: unknown[]) => unknown).apply(instance, args);
      return result as HandlerResult<TController, TMethod>;
    },
    get<TProvider>(token: Type<TProvider>): TProvider {
      return context.get(token, { strict: false });
    },
    mocks: {
      pushListTasks: (response) => mockStore.pushListTasks(response),
      pushDescribeTasks: (response) => mockStore.pushDescribeTasks(response),
      pushRunTask: (response) => mockStore.pushRunTask(response),
      pushStopTask: (response) => mockStore.pushStopTask(response),
      reset: () => mockStore.reset(),
      pulumi: pulumiStub,
    },
    close: () => context.close(),
  };
}
