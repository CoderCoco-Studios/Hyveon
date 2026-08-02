import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import type { INestApplicationContext, Type } from '@nestjs/common';
import type { StackOutputs } from '@hyveon/shared';
// Deep imports into @hyveon/desktop-main's compiled `dist/` output. The
// package has no `exports` map, so subpath resolution is unrestricted;
// `npm run app:build` must have produced `dist/` before this module loads.
import { AppModule } from '@hyveon/desktop-main/dist/app.module.js';
import { PulumiService } from '@hyveon/desktop-main/dist/services/PulumiService.js';
import { installEcsMock } from '@hyveon/desktop-main/dist/test-mocks/ecs-mock.js';
import { mockStore } from '@hyveon/desktop-main/dist/test-mocks/mock-store.js';
import type { MockResponse } from '@hyveon/desktop-main/dist/test-mocks/mock-store.js';
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
 * container with `PulumiService` substituted for a scripted stub (see the
 * `orchestrator-integration-coverage` delta spec's "In-process engine stub
 * injected via DI" requirement) — no HTTP listener, no Electron IPC
 * microservice transport, no subprocess, and no real Pulumi engine or AWS
 * call involved. `@MessagePattern`-decorated controller methods (e.g.
 * `GamesController.listGames`) are plain class methods, so {@link dispatch}
 * invokes them directly on the container-resolved instance, exercising the
 * exact same providers (`ConfigService`, `EcsService`, ...) the Electron IPC
 * transport would route to at runtime.
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
   * e.g. `harness.get(PulumiService)` — so a spec can drive a service's own
   * methods directly, while still exercising the exact same instance (and its
   * injected `RunRecordService`/`ConfigService`/etc.) the IPC transport would
   * resolve at runtime.
   */
  get<TProvider>(token: Type<TProvider>): TProvider;

  /**
   * Queues mock ECS SDK responses, consumed FIFO by the interceptor installed
   * via `installEcsMock()`. Thin wrapper over the shared `mockStore` so specs
   * never need to know the HTTP-tier's `/api/test/mocks/*` control surface.
   */
  mocks: {
    pushListTasks(response: MockResponse): void;
    pushDescribeTasks(response: MockResponse): void;
    pushRunTask(response: MockResponse): void;
    pushStopTask(response: MockResponse): void;
    reset(): void;
  };

  /** Tears down the Nest application context. */
  close(): Promise<void>;
}

/**
 * Builds the scripted `PulumiService` stub substituted into the DI container.
 * `getStackOutputs` resolves `stackOutputs` (`null` mirrors a never-deployed
 * stack, matching `PulumiService`'s own "never throws, degrades to null"
 * contract); `getOperationInFlight` always reports idle. Every other public
 * method is left unimplemented — a spec that calls one gets a standard,
 * immediately obvious `TypeError: ... is not a function` rather than silently
 * hanging or returning `undefined`. Extend this stub (or build a per-spec one
 * and pass it through {@link createIpcHarness}) when a future spec needs to
 * script `preview`/`apply`/`destroy`/`confirmRollback`.
 */
function makePulumiServiceStub(stackOutputs: StackOutputs | null): PulumiService {
  const stub: Partial<PulumiService> = {
    getStackOutputs: async () => stackOutputs,
    getOperationInFlight: () => null,
  };
  return stub as PulumiService;
}

/**
 * Compiles the in-process IPC test harness. Installs the ECS, run-record
 * DynamoDB, and configuration-bucket S3 mock interceptors, substitutes a
 * scripted `PulumiService` stub (see {@link makePulumiServiceStub}) at its DI
 * seam, and builds the `AppModule` application context via `@nestjs/testing`.
 * The run-record mock's backing store (`runRecordMockStore`) and the
 * configuration-bucket mock's backing store (`remoteFileStoreMockStore`) are
 * both reset first so a prior spec's plan/apply/destroy records, apply lock,
 * and configuration content never leak into a freshly built context.
 *
 * The configuration-bucket mock backs `TfvarsService`'s `RemoteFileStore`
 * reads/writes for specs that configure a bucket — installing it here
 * unconditionally is inert for every spec that doesn't, since
 * `AwsRemoteFileStore` throws its own "bucket not configured" error before
 * ever calling `S3Client.send()` in that case.
 *
 * @param stackOutputs - Scripted return value for `PulumiService.getStackOutputs()`.
 *   Defaults to `null` (never-deployed stack), matching production's default
 *   state; pass a populated {@link StackOutputs} for specs that need a
 *   deployed-stack scenario.
 */
export async function createIpcHarness(stackOutputs: StackOutputs | null = null): Promise<IpcHarness> {
  installEcsMock();
  runRecordMockStore.reset();
  installRunRecordDynamoMock();
  remoteFileStoreMockStore.reset();
  installRemoteFileStoreMock();

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PulumiService)
    .useValue(makePulumiServiceStub(stackOutputs))
    .compile();

  const context: INestApplicationContext = moduleRef;

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
    },
    close: () => context.close(),
  };
}
