/**
 * Shared Pulumi unit-test harness — the pattern every `@hyveon/infra` spec
 * uses to exercise resource-declaring code without an engine, AWS, or the
 * network, via `@pulumi/pulumi`'s `pulumi.runtime.setMocks` (the SDK's
 * standard unit-test seam). Established by task 3.1/3.4 of
 * `migrate-iac-to-pulumi`; every later Phase-3 dispatch (EFS, ECS, IAM,
 * Lambdas, ...) reuses it rather than re-deriving its own mock wiring.
 *
 * Usage: call {@link installPulumiMocks} before constructing any Pulumi
 * resource (typically in a `beforeEach`), then run the code under test and
 * assert against the returned `resources` array — one entry per
 * `new aws.*` resource constructed while the mocks were installed.
 *
 * **Every test MUST fully settle before it ends**: `pulumi.runtime.setMocks`
 * installs a process-global monitor, and `installPulumiMocks` replaces it on
 * every call (each fresh `beforeEach`). If a test constructs a resource and
 * does not await that resource's own output (directly, or transitively via
 * a downstream resource that depends on it — see {@link promiseOf}) before
 * the test body returns, that registration is still in flight when the next
 * test's `beforeEach` reinstalls the mocks. Always await real resource
 * handles for everything a test constructs; never approximate completion
 * with a fixed delay (`setImmediate`, `setTimeout`, a microtask-flush loop,
 * ...) — a fixed flush is a race that happens to pass for a small resource
 * graph and gets flakier as the graph grows across later dispatches (EFS,
 * ECS, IAM, Lambdas, ...). A test that only asserts on a promise's
 * resolution/rejection (not on `resources`) needs no barrier at all, since
 * that outcome does not depend on mock-registration timing.
 */

import * as pulumi from '@pulumi/pulumi';

/** One resource-construction call recorded by the mock `newResource` handler. */
export interface RecordedResource {
  /** Pulumi resource type token, e.g. `"aws:ec2/vpc:Vpc"`. */
  type: string;
  /** The resource's Pulumi logical name (the constructor's first argument). */
  name: string;
  /** The resolved input properties passed to the resource constructor. */
  inputs: Record<string, unknown>;
}

/** What {@link installPulumiMocks} returns: a live handle onto every resource constructed since it was called. */
export interface PulumiMockHandle {
  /**
   * Every resource constructed since {@link installPulumiMocks} was called,
   * in construction order. The same array reference is mutated in place, so
   * holding onto it before running the code under test is sufficient — no
   * need to re-fetch it afterward.
   */
  resources: RecordedResource[];
}

/**
 * Invoke tokens for provider-implemented data-source calls (`aws.getX(...)`)
 * this harness knows how to answer, and the fixed result each one resolves
 * to. Extend this map — not the `call` handler in {@link installPulumiMocks}
 * — when a later dispatch's `defineX(...)` needs a new data source; keeping
 * every token's mock response in one place is what makes the harness reusable
 * without every spec re-implementing `call()`.
 */
const CALL_MOCKS: Record<string, Record<string, unknown>> = {
  'aws:index/getAvailabilityZones:getAvailabilityZones': {
    names: ['us-east-1a', 'us-east-1b', 'us-east-1c'],
  },
};

/**
 * Installs `pulumi.runtime.setMocks` with a resource recorder and the shared
 * {@link CALL_MOCKS} data-source table, replacing whatever mocks (if any)
 * were previously installed. Pulumi's mock runtime is process-global, so
 * call this once per test (e.g. in a `beforeEach`) rather than once per
 * file — each call gets its own fresh {@link RecordedResource} array, so
 * tests never see resources recorded by a previous test.
 *
 * @returns A handle whose `resources` array fills in as the code under test
 *   constructs resources.
 */
export function installPulumiMocks(): PulumiMockHandle {
  const resources: RecordedResource[] = [];

  pulumi.runtime.setMocks(
    {
      newResource(mockArgs) {
        resources.push({ type: mockArgs.type, name: mockArgs.name, inputs: mockArgs.inputs });
        return { id: `${mockArgs.name}-id`, state: mockArgs.inputs };
      },
      call(mockArgs) {
        const result = CALL_MOCKS[mockArgs.token];
        if (!result) {
          throw new Error(`installPulumiMocks: no mock registered for call token "${mockArgs.token}"`);
        }
        return result;
      },
    },
    'hyveon-infra-test',
    'test',
    false,
  );

  return { resources };
}

/**
 * Resolves a Pulumi `Output` to a plain `Promise`, the pattern Pulumi's own
 * unit-testing documentation recommends for asserting against resource
 * properties under `pulumi.runtime.setMocks` (`Output` only exposes
 * `.apply`/`.get()` publicly — `.get()` is deployment-time only, so `.apply`
 * is the sole way to observe a value in a test). Awaiting a resource's
 * output is also how a test knows the mock engine has finished registering
 * that resource — and, transitively, everything it depends on — since
 * `newResource` mock calls resolve asynchronously relative to when a
 * resource is constructed (confirmed empirically: a resource's `id` does
 * not appear in a {@link PulumiMockHandle}'s `resources` array until its
 * output is awaited this way).
 *
 * @param output - The Pulumi `Output` to resolve.
 * @returns A promise for the output's underlying value.
 */
export function promiseOf<T>(output: pulumi.Output<T>): Promise<T> {
  return new Promise((resolve) => {
    output.apply(resolve);
  });
}
