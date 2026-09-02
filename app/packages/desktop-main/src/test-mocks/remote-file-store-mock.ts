import { mockClient, type AwsClientStub } from 'aws-sdk-client-mock';
import { GetObjectCommand, PutObjectCommand, ListObjectVersionsCommand, S3Client } from '@aws-sdk/client-s3';
import { CONFIGURATION_OBJECT_KEY, type DeploymentConfig } from '@hyveon/shared';

/**
 * A placeholder, structurally-valid {@link DeploymentConfig} — empty
 * `gameServers`, every other field at a plausible default value — seeded as
 * the configuration object's initial content. `IacController.plan`'s
 * in-process `PulumiServiceStub` (see `pulumi-mock.ts`) never reads this
 * content; it exists purely so `DeploymentConfigService`'s read path (which
 * requires a configuration bucket to be configured — there is no local-file
 * fallback) has a real object to fetch.
 */
const PLACEHOLDER_CONFIG: DeploymentConfig = {
  projectName: 'hyveon-integration-test',
  awsRegion: 'us-east-1',
  vpcCidr: '10.0.0.0/16',
  hostedZoneName: 'integration-test.example.com',
  dnsTtl: 30,
  watchdogIntervalMinutes: 15,
  watchdogIdleChecks: 4,
  watchdogMinPackets: 100,
  baseAllowedGuilds: [],
  baseAdminUserIds: [],
  baseAdminRoleIds: [],
  discordApplicationId: '',
  auditTableName: '',
  runsTableName: '',
  gameServers: {},
};

/** A single stored object version — mirrors the fields `AwsRemoteFileStore` reads off an S3 `ListObjectVersions` entry. */
interface StoredVersion {
  versionId: string;
  lastModified: Date;
  body: Uint8Array;
}

/**
 * In-memory backing store for the configuration-bucket S3 mock installed by
 * {@link installRemoteFileStoreMock} — a single versioned object (keyed by
 * `CONFIGURATION_OBJECT_KEY`), newest version first, mirroring how
 * `AwsRemoteFileStore`/`DeploymentConfigService` only ever read/write one
 * object. Seeded with {@link PLACEHOLDER_CONFIG} so a spec that never
 * calls `DeploymentConfigService`'s write path still gets a valid `get()`.
 *
 * Exposed separately from the SDK interceptor (mirrors `run-record-mock.ts`'s
 * split from its installer) so integration specs can seed custom content via
 * {@link RemoteFileStoreMockStore.seed} before driving a run, or reset
 * between specs via {@link RemoteFileStoreMockStore.reset}.
 */
class RemoteFileStoreMockStore {
  private versions: StoredVersion[] = [];
  private versionCounter = 0;

  constructor() {
    this.reset();
  }

  /** The current (newest) version, or `undefined` if the object has never been written (never the case after {@link reset} reseeds the placeholder). */
  private head(): StoredVersion | undefined {
    return this.versions[0];
  }

  /** Returns the current object's bytes and etag (the version id doubles as the etag here, mirroring how tests never need the two to differ). */
  get(): { body: Uint8Array; etag: string } | undefined {
    const head = this.head();
    if (!head) return undefined;
    return { body: head.body, etag: head.versionId };
  }

  /** Returns the bytes stored under `versionId`, or `undefined` if no such version exists. */
  getVersion(versionId: string): { body: Uint8Array } | undefined {
    const found = this.versions.find((v) => v.versionId === versionId);
    return found ? { body: found.body } : undefined;
  }

  /** Prepends a new head version with `body`, returning its freshly-minted `{ etag, versionId }` — mirrors `PutObjectCommand`'s response shape. */
  put(body: Uint8Array): { etag: string; versionId: string } {
    this.versionCounter += 1;
    const versionId = `mock-version-${this.versionCounter}`;
    this.versions.unshift({ versionId, lastModified: new Date(), body });
    return { etag: versionId, versionId };
  }

  /** Every stored version, newest first — mirrors `AwsRemoteFileStore.listVersions()`'s contract. */
  listVersions(): Array<{ versionId: string; lastModified: Date }> {
    return this.versions.map(({ versionId, lastModified }) => ({ versionId, lastModified }));
  }

  /**
   * Replaces the object's entire version history with a single head version
   * containing `config` (defaulting to {@link PLACEHOLDER_CONFIG}) — lets a
   * spec seed specific configuration content before driving a run. Called
   * with no arguments by {@link reset} to reseed the placeholder between specs.
   */
  seed(config: DeploymentConfig = PLACEHOLDER_CONFIG): void {
    this.versionCounter = 0;
    this.versions = [];
    this.put(new TextEncoder().encode(JSON.stringify(config, null, 2) + '\n'));
  }

  /** Clears all history and reseeds the placeholder — called between specs so state never leaks across the `ipc` harness's fresh app contexts. */
  reset(): void {
    this.seed();
  }
}

/**
 * Shared backing store for {@link installRemoteFileStoreMock}'s interceptors.
 * Integration specs reach for this directly (e.g.
 * `remoteFileStoreMockStore.seed({...})`) to seed specific configuration
 * content before driving an `IacController.plan()`/`DeploymentConfigService` call.
 */
export const remoteFileStoreMockStore = new RemoteFileStoreMockStore();

/**
 * Installs `aws-sdk-client-mock` interceptors on the `S3Client` prototype,
 * wired to the shared {@link remoteFileStoreMockStore} — the configuration-bucket
 * counterpart of `ecs-mock.ts`'s `installEcsMock`/`run-record-mock.ts`'s
 * `installRunRecordDynamoMock`. Every `GetObjectCommand`/`PutObjectCommand`/
 * `ListObjectVersionsCommand` the real `AwsRemoteFileStore` issues (via
 * `DeploymentConfigService`) is intercepted regardless of the
 * `Bucket`/`Key` it was issued against — this mock backs the single
 * configuration object every integration spec cares about, not a
 * general-purpose multi-object S3 double.
 *
 * Prototype patching is sufficient because `AwsRemoteFileStore` builds its
 * `S3Client` lazily; see `ecs-mock.ts`'s {@link installEcsMock} doc comment
 * for the full rationale.
 *
 * @returns the `aws-sdk-client-mock` stub. Specs rarely need it directly
 * since all queued state routes through {@link remoteFileStoreMockStore}, but
 * it's returned so callers can `.reset()` the interceptor itself if ever needed.
 */
export function installRemoteFileStoreMock(): AwsClientStub<S3Client> {
  const s3Mock = mockClient(S3Client);

  s3Mock.on(GetObjectCommand).callsFake(async (input) => {
    if (typeof input.VersionId === 'string') {
      const found = remoteFileStoreMockStore.getVersion(input.VersionId);
      if (!found) return {};
      return { Body: fakeBody(found.body) };
    }
    const current = remoteFileStoreMockStore.get();
    if (!current) return {};
    return { Body: fakeBody(current.body), ETag: `"${current.etag}"` };
  });

  s3Mock.on(PutObjectCommand).callsFake(async (input) => {
    const body = input.Body instanceof Uint8Array ? input.Body : new TextEncoder().encode(String(input.Body ?? ''));
    const { etag, versionId } = remoteFileStoreMockStore.put(body);
    return { ETag: `"${etag}"`, VersionId: versionId };
  });

  s3Mock.on(ListObjectVersionsCommand).callsFake(async () => ({
    Versions: remoteFileStoreMockStore.listVersions().map(({ versionId, lastModified }) => ({
      Key: CONFIGURATION_OBJECT_KEY,
      VersionId: versionId,
      LastModified: lastModified,
    })),
    IsTruncated: false,
  }));

  return s3Mock;
}

/** Builds a fake S3 `Body` stream whose `transformToByteArray()` resolves to the given bytes — mirrors `DeploymentConfigService.s3.test.ts`'s equivalent helper. */
function fakeBody(bytes: Uint8Array): { transformToByteArray: () => Promise<Uint8Array> } {
  return { transformToByteArray: async () => bytes };
}
