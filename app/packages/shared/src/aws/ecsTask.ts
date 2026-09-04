/**
 * Structural subset of `@aws-sdk/client-ecs`'s `Task` shape this module needs.
 *
 * @remarks
 * Deliberately hand-rolled rather than imported from `@aws-sdk/client-ecs` — `shared` must
 * stay free of any dependency on that package, runtime or type-only, so every consumer
 * (four Lambdas, `cloud-aws`, `desktop-main`) keeps choosing its own SDK version rather than
 * inheriting one from `shared`. A structural type satisfies the real `Task` type at every
 * call site without importing it.
 */
export interface EcsTaskLike {
  attachments?: Array<{
    type?: string;
    details?: Array<{ name?: string; value?: string }>;
  }>;
}

/**
 * Finds the value of a named field inside a task's `ElasticNetworkInterface` attachment.
 *
 * @remarks
 * ECS surfaces ENI-derived facts (its ID, its private IPv4 address, ...) as loose
 * name/value pairs nested inside `task.attachments[].details[]` rather than as typed
 * fields on the task, so every caller has to walk the same shape to pull one back out.
 *
 * @param task - The ECS task to inspect.
 * @param detailName - The `details[].name` to look up (e.g. `networkInterfaceId`,
 * `privateIPv4Address`).
 * @returns The matching detail's value, or `null` when the task has no
 * `ElasticNetworkInterface` attachment yet (common while a task is still provisioning) or
 * the named detail isn't present on it.
 */
export function getTaskAttachmentDetail(task: EcsTaskLike, detailName: string): string | null {
  for (const attachment of task.attachments ?? []) {
    if (attachment.type !== 'ElasticNetworkInterface') continue;
    for (const detail of attachment.details ?? []) {
      if (detail.name === detailName) return detail.value ?? null;
    }
  }
  return null;
}

/**
 * Dig the ENI ID out of a task's `attachments` array.
 *
 * @remarks
 * Needed because the public/private IP isn't on the task itself — it has to be looked up
 * via EC2 using this ENI. Thin wrapper over {@link getTaskAttachmentDetail}.
 *
 * @param task - The ECS task to inspect.
 * @returns The task's ENI ID, or `null` if it has no ENI attachment yet.
 */
export function getTaskEniId(task: EcsTaskLike): string | null {
  return getTaskAttachmentDetail(task, 'networkInterfaceId');
}

/**
 * Reads the task's private IPv4 address directly off its ENI attachment details,
 * without a separate EC2 `DescribeNetworkInterfaces` call.
 *
 * @param task - The ECS task to inspect.
 * @returns The task's private IPv4 address, or `null` if it has no ENI attachment yet.
 */
export function getTaskPrivateIp(task: EcsTaskLike): string | null {
  return getTaskAttachmentDetail(task, 'privateIPv4Address');
}

/**
 * Structural subset of `@aws-sdk/client-ec2`'s `DescribeNetworkInterfacesCommandOutput`
 * this module needs.
 *
 * @remarks
 * Hand-rolled for the same reason as {@link EcsTaskLike} — `shared` has zero dependency,
 * runtime or type-only, on `@aws-sdk/client-ec2`, enforced by this repo's
 * `no-restricted-imports` ESLint rule banning `@aws-sdk/*` imports outside
 * `packages/cloud-aws` and `packages/lambda`.
 */
export interface DescribeNetworkInterfacesResultLike {
  NetworkInterfaces?: Array<{ Association?: { PublicIp?: string } }>;
}

/**
 * Resolves the public IPv4 of an ENI, given a caller-supplied `DescribeNetworkInterfaces` call.
 *
 * @remarks
 * Takes a callback rather than an `EC2Client` + ENI ID so `shared` never has to construct
 * (or import) an `@aws-sdk/client-ec2` `Command` — the caller, which already owns the client
 * and the SDK dependency, builds and sends the command itself. Error handling is deliberately
 * left to each caller: Lambdas let a failed describe call throw and fail the invocation, while
 * `AwsCloudProvider`/`Ec2Service` catch and log, returning `null` so their UI can show
 * "starting" / "no IP" instead of an error. This helper stays a thin pass-through so both
 * behaviors keep working unmodified.
 *
 * @param describeNetworkInterfaces - Calls `DescribeNetworkInterfaces` for the given ENI ID and
 * returns its result — e.g. `(id) => ec2.send(new DescribeNetworkInterfacesCommand({...}))`.
 * @param eniId - The Elastic Network Interface ID to resolve.
 * @returns The ENI's associated public IPv4, or `null` when it has no public association
 * (e.g. `assignPublicIp: DISABLED`).
 * @throws Whatever `describeNetworkInterfaces` throws — callers decide how to handle it.
 */
export async function resolveEniPublicIp(
  describeNetworkInterfaces: (eniId: string) => Promise<DescribeNetworkInterfacesResultLike>,
  eniId: string,
): Promise<string | null> {
  const resp = await describeNetworkInterfaces(eniId);
  return resp.NetworkInterfaces?.[0]?.Association?.PublicIp ?? null;
}
