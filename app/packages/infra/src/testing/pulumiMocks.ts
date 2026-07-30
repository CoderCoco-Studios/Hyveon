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
  /**
   * Opaque identifier of the explicit `aws.Provider` instance this resource
   * was declared against (`MockResourceArgs.provider` — the SDK's own
   * "`<providerUrn>::<providerId>`" encoding), or `undefined` if none was
   * passed. Two resources sharing this exact string were declared with the
   * SAME provider instance; added specifically so a spec (e.g.
   * `discordDomain.test.ts`) can assert two resources register with
   * DIFFERENT provider instances (the us-east-1 pinning) without needing to
   * decode the string's internal shape — an equality/inequality comparison
   * between two recorded resources' `provider` values is enough.
   */
  provider: string | undefined;
}

/**
 * One data-source invocation (`aws.getX(...)`/`aws.getXOutput(...)`)
 * recorded by the mock `call` handler — added alongside {@link RecordedResource}
 * specifically so a spec can assert on the *arguments* a lookup was invoked
 * with (e.g. `route53.test.ts` asserting `defineRoute53` calls
 * `aws.route53.getZoneOutput` with the configured `hostedZoneName` and
 * `privateZone: false`), not just on the fixed result {@link CALL_MOCKS}
 * returns for it.
 */
export interface RecordedCall {
  /** Invoke token, e.g. `"aws:route53/getZone:getZone"`. */
  token: string;
  /** The resolved input arguments passed to the invoke. */
  inputs: Record<string, unknown>;
}

/** What {@link installPulumiMocks} returns: a live handle onto every resource constructed and every data-source call made since it was called. */
export interface PulumiMockHandle {
  /**
   * Every resource constructed since {@link installPulumiMocks} was called,
   * in construction order. The same array reference is mutated in place, so
   * holding onto it before running the code under test is sufficient — no
   * need to re-fetch it afterward.
   */
  resources: RecordedResource[];
  /**
   * Every data-source invocation made since {@link installPulumiMocks} was
   * called, in call order — same "same array reference, mutated in place"
   * contract as {@link resources}. See {@link RecordedCall}'s doc for why
   * this exists alongside {@link resources}.
   */
  calls: RecordedCall[];
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
  // `route53.ts`'s `defineRoute53` (task 3.9) — a fixed result regardless of
  // the queried `name`, matching every other entry in this table.
  'aws:route53/getZone:getZone': {
    zoneId: 'Z1234567890ABC',
    name: 'example.com',
    arn: 'arn:aws:route53:::hostedzone/Z1234567890ABC',
    id: 'Z1234567890ABC',
    callerReference: 'mock-caller-reference',
    comment: '',
    linkedServiceDescription: '',
    linkedServicePrincipal: '',
    nameServers: ['ns-1.awsdns-mock.com'],
    primaryNameServer: 'ns-1.awsdns-mock.com',
    resourceRecordSetCount: 0,
    tags: {},
  },
};

/**
 * Extra computed-only output fields to merge into a resource's mocked state,
 * keyed by Pulumi resource type token — the `newResource` analogue of
 * {@link CALL_MOCKS} for regular (non-data-source) resources. Every other
 * `defineX` module in this package only ever reads a mocked resource's `id`
 * downstream (always present — {@link installPulumiMocks} synthesizes it for
 * every resource), so this table stayed empty until `discordDomain.ts` (task
 * 3.x) needed to read `aws.acm.Certificate.domainValidationOptions` and
 * `aws.cloudfront.Distribution.domainName`/`hostedZoneId` — none of which are
 * INPUT properties, so the generic `state: mockArgs.inputs` echo below never
 * populates them, and code that reads them (e.g.
 * `certificate.domainValidationOptions[0].resourceRecordName`) would
 * otherwise resolve to `undefined` under test. Extend this table — not the
 * `newResource` handler in {@link installPulumiMocks} — the same way
 * {@link CALL_MOCKS} is extended for a new data-source token.
 */
const RESOURCE_STATE_MOCKS: Record<string, (inputs: Record<string, unknown>) => Record<string, unknown>> = {
  // `discordDomain.ts`'s `defineDiscordDomain` — a single-domain certificate
  // (no `subjectAlternativeNames`), so exactly one validation option is
  // enough to exercise `certificate.domainValidationOptions[0]`.
  'aws:acm/certificate:Certificate': (inputs) => ({
    domainValidationOptions: [
      {
        domainName: inputs.domainName,
        resourceRecordName: `_acme-challenge.${inputs.domainName as string}.`,
        resourceRecordType: 'CNAME',
        resourceRecordValue: `_acme-challenge-target.${inputs.domainName as string}.acm-validations.aws.`,
      },
    ],
  }),
  // `discordDomain.ts`'s `defineDiscordDomain` — fixed values, since a real
  // CloudFront distribution's `domainName` is AWS-assigned at create time and
  // `hostedZoneId` is CloudFront's own well-known, fixed Route 53 zone ID
  // (`Z2FDTNDATAQYW2`) shared by every distribution.
  'aws:cloudfront/distribution:Distribution': () => ({
    domainName: 'mock-distribution.cloudfront.net',
    hostedZoneId: 'Z2FDTNDATAQYW2',
  }),
  // `discordDomain.ts`'s `defineDiscordDomain` — `fqdn` is AWS's
  // fully-qualified form of `name` (a real Route 53 record's `fqdn` always
  // ends with a trailing `.`); `certificateValidation`'s
  // `validationRecordFqdns` input reads this field off the validation record.
  'aws:route53/record:Record': (inputs) => ({
    fqdn: typeof inputs.name === 'string' && inputs.name.endsWith('.') ? inputs.name : `${inputs.name as string}.`,
  }),
  // `lambdas.ts`'s `defineLambdas` (tasks 3.6/3.7) — `functionUrl` is
  // AWS-assigned at create time, and `discordDomain.ts`'s `defineDiscordDomain`
  // (task 3.x) reads it to derive the CloudFront origin domain.
  'aws:lambda/functionUrl:FunctionUrl': () => ({
    functionUrl: 'https://mock-function-url.lambda-url.us-east-1.on.aws/',
  }),
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
  const calls: RecordedCall[] = [];

  pulumi.runtime.setMocks(
    {
      newResource(mockArgs) {
        resources.push({ type: mockArgs.type, name: mockArgs.name, inputs: mockArgs.inputs, provider: mockArgs.provider });
        const extraState = RESOURCE_STATE_MOCKS[mockArgs.type]?.(mockArgs.inputs) ?? {};
        return { id: `${mockArgs.name}-id`, state: { ...mockArgs.inputs, ...extraState } };
      },
      call(mockArgs) {
        calls.push({ token: mockArgs.token, inputs: mockArgs.inputs });
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

  return { resources, calls };
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
