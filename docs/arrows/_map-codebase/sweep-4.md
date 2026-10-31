# Sweep 4: desktop-main services (top-level files A–L)

Scope: `git ls-files app/packages/desktop-main/src/services | awk -F/ '$6 ~ /^[A-L]/'` — 53 files, all top-level `.ts` files directly under `services/` (no subdirectory names start with A–L; `folderUpload/` and `__fixtures__/` belong to the other worker).

## app/packages/desktop-main/src/services

```yaml
- path: app/packages/desktop-main/src/services/AuditService.ts
  purpose: Best-effort write / paged read facade over the cloud-agnostic AuditLogStore for game_servers mutation audit entries.
  exports: AuditService (record, list), RecordAuditEntryParams, ListAuditEntriesOpts
  dependencies: "@hyveon/shared (buildAuditSk, AuditAction, AuditEntry, AuditLogStore, AuditPageResult, RedactedGameServer); ./ConfigService (getStackOutputs); ../modules/cloud-provider.tokens (AUDIT_LOG_STORE); ../logger; node:os; @nestjs/common"
  data_shapes: "AuditEntry {sk, timestamp, actor, action, game, before, after, versionId?}; AuditPageResult {entries, ...cursor}; list limit clamped [1,100], default 25"
  side_effects: "DynamoDB writes/reads via injected store; reads os.userInfo().username; winston logs"
  role: Nest service
  observations:
    - "record() never throws: missing auditTableName -> warn+return (AuditService.ts:91-97); putEntry rejection -> warn (113-119)"
    - "Gate is stack output auditTableName, but the table name is never passed to store.putEntry/listEntries (112, 140) — store must resolve the table itself; the check is only a deployed-or-not proxy"
    - "list() does not catch store.listEntries rejections (140) — unlike record(), an SDK error propagates (logging.md rule 2 gap)"
    - "logger.warn passes raw `err` object, not a normalized message (114-118)"
    - "clampLimit floors fractional limits (55)"
- path: app/packages/desktop-main/src/services/AuditService.test.ts
  purpose: Unit tests for AuditService with a stub AuditLogStore and ConfigService.
  exports: none
  dependencies: "vitest; ../testing/stack-outputs.fixture (stackOutputs); mocked node:os, ../logger"
  data_shapes: StackOutputs fixture with auditTableName 'test-audit'; GameServer fixture
  side_effects: none
  role: test
  observations:
    - "Pins: entry built with actor/sk/timestamp/versionId; putEntry failure swallowed; no-table no-op for record and list (empty page); limit default 25, >100 clamped, 0 -> 25; debug log on entry (AuditService.test.ts:82-191)"
    - "No test for list() when store.listEntries rejects"
- path: app/packages/desktop-main/src/services/AwsProfileService.ts
  purpose: Lists AWS CLI profiles from ~/.aws, saves pasted credentials into the encrypted store, and rotates the active pasted access key pair.
  exports: "AwsProfileService (listProfiles, savePastedCredentials, rotateActiveCredentials; protected createStsClient, createIamClient, sleep, buildIamSecurityCredentialsConsoleUrl, parseFiles, homeDir), AwsProfileSummary, DEFAULT_PASTED_PROFILE_NAME ('hyveon-pasted'), SavePastedCredentialsInput, SafeStorageUnavailableError, InvalidPastedCredentialsError, UnsupportedCredentialSourceError, AwsProfileRotationResult"
  dependencies: "@smithy/shared-ini-file-loader (parseKnownFiles); @aws-sdk/client-sts (GetCallerIdentity); @aws-sdk/client-iam (CreateAccessKey, DeleteAccessKey); ./SafeStorageService; ./ElectronStoreService (get, setPastedCredentials); ./awsCredentialSource (resolveAwsCredentialSource); ./verifyAccessKeyWithRetry; ./sleep; @hyveon/shared errMessage"
  data_shapes: "AwsProfileSummary {profileName, region?}; pasted creds {accessKeyId, secretAccessKey, region?} stored under creds.aws.<profile>; AwsProfileRotationResult = complete | verification-failed{error} | delete-failed{consoleUrl}"
  side_effects: "reads ~/.aws/credentials + ~/.aws/config (ignoreCache); electron-store writes (encrypted pasted creds); IAM CreateAccessKey/DeleteAccessKey; STS GetCallerIdentity; logs (never secrets)"
  role: Nest service
  observations:
    - "Rotation order is CreateAccessKey(current) -> verify(new, retry) -> store overwrite -> DeleteAccessKey(old, via new client) (AwsProfileService.ts:290-368); orphan new key deleted on verification failure (335-343)"
    - "Duplication flagged by its own comments: createStsClient/createIamClient/sleep/buildIamSecurityCredentialsConsoleUrl 'mirror GuidedIamService ... exactly' and are 'kept as a separate copy' (377, 391, 413, 429-431) — duplication.md rule 4 trigger"
    - "Step 2 iam:CreateAccessKey raw SDK error propagates uncaught by design (264-265, 291) — conflicts with logging.md rule 2"
    - "UnsupportedCredentialSourceError message says 'pasted or guided credential sources' (90) but only kind 'pasted' is accepted (274); guided sources appear to be stored as pasted"
    - "savePastedCredentials has no entry debug log (181), unlike the other two methods"
    - "TSDoc {@link VERIFY_ACCESS_KEY_RETRY_DELAYS_MS} and {@link AwsPastedCredentialDecryptError} reference symbols not imported here (111, 226, 254)"
    - "Region resolution aws.region || creds.aws.<profile>.region, truthy-checked (278)"
    - "rotateActiveCredentials has no production caller in desktop-main controllers; only referenced from a doc comment at IamCheckService.ts:119 — appears unwired ('future Settings rotate key affordance', 198-200)"
- path: app/packages/desktop-main/src/services/AwsProfileService.test.ts
  purpose: Unit tests for profile listing (fixture ~/.aws dir), pasted-credential save, and rotation via aws-sdk-client-mock.
  exports: none
  dependencies: "vitest; aws-sdk-client-mock; ./__fixtures__/aws-profile fixture dir; Testable/Fixture/FailingParse subclasses overriding protected seams"
  data_shapes: fixture profiles default/dev/prod/noregion
  side_effects: reads fixture files on disk
  role: test
  observations:
    - "Pins: merged sorted profiles, [profile x] normalization, no secret fields, empty on missing files, warn+plain-Error rethrow on parse failure (AwsProfileService.test.ts:88-150); keychain/blank-field gates and default profile name (152-232); exact rotation call order, client-key pairing, 6 verify attempts with backoff [1000,2000,4000,8000,8000], orphan cleanup with current client, delete-failed keeps new key, no secrets in any log (286-717)"
    - "Backoff schedule is asserted here (539) but defined in verifyAccessKeyWithRetry, out of this file"
- path: app/packages/desktop-main/src/services/BootstrapService.ts
  purpose: First-run wizard SDK-direct idempotent provisioning of the Pulumi state bucket, configuration bucket, seed deployment-config.json, and run-history DynamoDB table.
  exports: "BootstrapService (ensureStateBucket, ensureConfigurationBucket, ensureDeploymentConfig, ensureRunsTable; protected createDynamoDbClient, createS3Client, sleep), BootstrapResourceStatus, BootstrapResult, BootstrapCredentialsNotConfiguredError"
  dependencies: "@aws-sdk/client-s3 (CreateBucket, HeadBucket, HeadObject, PutBucketVersioning/Encryption/LifecycleConfiguration, PutObject, PutPublicAccessBlock); @aws-sdk/client-dynamodb (CreateTable, DescribeTable, UpdateContinuousBackups, waitUntilTableExists, ContinuousBackupsUnavailableException, ResourceInUseException); @aws-sdk/credential-providers fromIni; @hyveon/shared (CONFIGURATION_OBJECT_KEY, errMessage, withDeploymentConfigDefaults); ./ElectronStoreService; ./awsCredentialSource; ./sleep"
  data_shapes: "BootstrapResult {status: created|exists|failed, message?}; runs table pk/sk + status-index GSI(status, startedAt), PAY_PER_REQUEST, tags Name/Project=hyveon; seed doc withDeploymentConfigDefaults({hostedZoneName:'', gameServers:{}})"
  side_effects: "S3 bucket create/configure, S3 PutObject, DynamoDB CreateTable/UpdateContinuousBackups, waits up to 60s; reads electron-store aws + pasted creds; ~/.aws via fromIni; logs"
  role: Nest service
  observations:
    - "Versioning + AES256 encryption blocks duplicated verbatim between ensureStateBucket and ensureConfigurationBucket (BootstrapService.ts:139-158 vs 201-242) — ≥2 non-trivial copies (duplication.md)"
    - "createS3Client/createDynamoDbClient called outside try (125, 187, 315, 410) so BootstrapCredentialsNotConfiguredError (708) escapes as a throw rather than {status:'failed'}"
    - "HeadBucket pre-check only for us-east-1 / no region (606); other regions rely on BucketAlreadyOwnedByYou"
    - "deploymentConfigExists treats only 404/NotFound/NoSuchKey as absent; other errors propagate to avoid overwriting (352-366); bucketExists/runsTableExists swallow all errors as 'absent' (563, 651)"
    - "UpdateContinuousBackups retried only on ContinuousBackupsUnavailableException, delays [2000,4000,8000,15000] (58, 463-490); PITR + public-access-block re-applied on exists path"
    - "S3 buckets get no Project=hyveon tag (no PutBucketTagging) while the DynamoDB table does (530-533)"
    - "WizardAwsClientConfig doc says 'currently S3Client only' (62) but DynamoDBClient also uses it (576) — stale comment"
    - "History/task narrative in doc comments: '#208' (121), 'Critical bootstrap gap this migration's final review round uncovered' (265), 'Critical bootstrap deadlock' (377)"
    - "Seed document bypasses validateDeploymentSettingsPatch, leaving hostedZoneName '' (291-303)"
- path: app/packages/desktop-main/src/services/BootstrapService.test.ts
  purpose: Unit tests for every BootstrapService ensureX method with mocked S3/DynamoDB clients.
  exports: none
  dependencies: "vitest; aws-sdk-client-mock; TestableBootstrapService exposing sleep"
  data_shapes: n/a
  side_effects: none
  role: test
  observations:
    - "Pins: LocationConstraint omitted for us-east-1, HeadBucket skip, BucketAlreadyOwnedByYou=exists, BucketAlreadyExists='already taken by another AWS account', PAB applied on exists path, credential-source selection (BootstrapService.test.ts:82-256); 90-day lifecycle rule (258-395); seed doc only when HeadObject NotFound, AccessDenied -> failed without PutObject (408-465); concurrent state/config isolation (467-523); exact runs-table schema+tags, ResourceInUse race=exists, PITR retry schedule, info logs w/ elapsedMs (533-709)"
    - "No-region case asserted to reject (throw), not to return failed (205-211, 388-394, 448-454, 683-687)"
- path: app/packages/desktop-main/src/services/CloudHealthService.ts
  purpose: Settings-page Cloud Health checklist; currently one check/fix for the AWSServiceRoleForECS service-linked role, plus policy download/console helpers.
  exports: "CloudHealthService (getChecks, writePolicyToDisk, openPolicyConsole; protected readIsElectron, openExternalUrl, readIsPackaged, readUserDataPath, getPolicyDownloadPath), CloudHealthCheck, CloudHealthCheckResult, CloudHealthCheckStatus, CloudHealthFixResult, CloudHealthFixOutcome"
  dependencies: "@aws-sdk/client-iam (GetRole, CreateServiceLinkedRole); @aws-sdk/client-sts; @hyveon/shared (DEPLOYMENT_CONFIG_DEFAULTS, errMessage, generateHyveonDeployAllPolicy); ./ConfigService getRegion; ./DeploymentConfigService getTopLevelSettings; ./ElectronStoreService; ./electronRuntime readIsPackaged; ./awsCredentialSource resolveAwsClientCredentialsWithSignature; type OpenConsoleResult from ./GuidedIamService; electron (lazy require)"
  data_shapes: "check -> {status: ok|missing|error, message?}; fix -> {outcome: fixed|needsPolicyUpdate|failed, policyJson?, policyConsoleUrl?, message?}"
  side_effects: "IAM GetRole/CreateServiceLinkedRole, STS GetCallerIdentity; writes hyveon-deploy-all-policy.json to userData (packaged) or cwd; shell.openExternal; logs"
  role: Nest service
  observations:
    - "'Already exists' detected via InvalidInputException + /already exists/i message match (CloudHealthService.ts:141-145); AccessDenied matched as both AccessDeniedException and AccessDenied (148)"
    - "On access denied, returns generated HyveonDeployAll policy JSON for the operator's projectName (falls back to default on read failure) and console URL arn:aws:iam::<acct>:policy/HyveonDeployAll (122-131, 152-157, 182)"
    - "openPolicyConsole/readIsElectron/openExternalUrl/readUserDataPath/getPolicyDownloadPath each documented as 'Mirrors GuidedIamService.X exactly' with an intentional own copy (193-196, 209-212, 240, 250, 273, 291) — duplication.md rule 4 trigger"
    - "getIamClient/getStsClient duplicate each other except for client class (82-92)"
    - "writePolicyToDisk uses writeFileSync with no try/catch and no log (200-204); openPolicyConsole has no entry log (216)"
    - "Doc for readIsPackaged says it returns process.resourcesPath but returns boolean (261-268) — stale"
    - "Dev-mode policy file written to process.cwd() (300)"
- path: app/packages/desktop-main/src/services/CloudHealthService.test.ts
  purpose: Unit tests for CloudHealthService check/fix outcomes and file/console helpers.
  exports: none
  dependencies: "vitest; aws-sdk-client-mock; mocked fs.writeFileSync; ../testing/config-service.fixture (configServiceStub); ../testing/deployment-config.fixture (deploymentConfigStub)"
  data_shapes: n/a
  side_effects: none
  role: test
  observations:
    - "Pins: exactly one check id 'ecs-service-linked-role'; ok/missing/error mapping; fixed on success or 'already exists'; needsPolicyUpdate w/ policy containing 'HyveonServiceLinkedRoles' and console URL, URL omitted when STS fails; failed otherwise; writePolicyToDisk path; non-https and non-Electron refuse to open (CloudHealthService.test.ts:59-196)"
    - "No test for openExternalUrl rejection path or getPolicyDownloadPath packaged/dev resolution"
- path: app/packages/desktop-main/src/services/ConfigService.ts
  purpose: Central runtime-config source: memoised Pulumi stack outputs, region, configuration bucket, env overrides, active cloud.
  exports: "ConfigService (invalidateCache, getStackOutputs, readEnvRegion, readEnvConfigCacheTtlMs, getConfigurationBucket, readEnvConfigBucketOverride, getRegion, getActiveCloud; protected readResourcesPath), ActiveCloud ('aws')"
  dependencies: "./ElectronStoreService (get 'aws', 'bootstrap'); ./PulumiService getStackOutputs; ./electronRuntime readResourcesPath; @hyveon/shared (StackOutputs, errMessage); ../logger"
  data_shapes: "StackOutputs | null cached as Promise; env AWS_DEFAULT_REGION, CONFIG_CACHE_TTL_MS (default 30000), HYVEON_CONFIG_BUCKET"
  side_effects: "reads process.env; electron-store reads; triggers Pulumi stack-output reads (S3 backend) via PulumiService; logs"
  role: Nest service
  observations:
    - "getStackOutputs caches the in-flight promise; StackOutputs cached indefinitely, null cached 20s TTL, rejections not cached and rethrown as plain Error (ConfigService.ts:76-99, 130-174)"
    - "Stale-null flag cleared before refetch to coalesce concurrent callers (137-145)"
    - "invalidateCache doc says it's called from '/api/games and /api/status handlers' (102-104) — stale HTTP-era reference; app has no HTTP transport"
    - "protected readResourcesPath (213-215) has no caller anywhere in desktop-main — appears dead"
    - "DEFAULT_CONFIG_CACHE_TTL_MS documented as DeploymentConfigService's cache TTL (9-13) but lives here; class doc lists only AWS_DEFAULT_REGION env var (27) though CONFIG_CACHE_TTL_MS and HYVEON_CONFIG_BUCKET are also read"
    - "getRegion uses ?? so an empty-string aws.region is returned as-is (264), unlike AwsProfileService's truthy check"
    - "getActiveCloud hardcoded 'aws' (276-278)"
- path: app/packages/desktop-main/src/services/ConfigService.test.ts
  purpose: Unit tests for ConfigService caching, region/bucket resolution and env TTL parsing.
  exports: none
  dependencies: "vitest; real ElectronStoreService + SafeStorageService (in-memory outside Electron); PulumiService stub"
  data_shapes: n/a
  side_effects: mutates process.env CONFIG_CACHE_TTL_MS / HYVEON_CONFIG_BUCKET (cleaned in afterEach)
  role: test
  observations:
    - "Pins: delegation, coalescing, invalidate, rejection not cached + plain Error + error log, debug hit/miss lines, 20s null TTL edges (19.999s vs 20.001s), real value no TTL, coalesced refetch after expiry (ConfigService.test.ts:54-232); region precedence store>env>us-east-1; TTL env parsing; bucket env>store>null"
    - "Test titled 'should default to 30000 and warn' never asserts the warn (279-283)"
- path: app/packages/desktop-main/src/services/CostService.ts
  purpose: Pure Fargate cost-estimate arithmetic from task CPU/memory for the Costs page.
  exports: CostService (estimateForSpec), GameEstimate, CostEstimates
  dependencies: "@hyveon/cloud-aws (FARGATE_VCPU_PER_HOUR, FARGATE_GB_PER_HOUR); @nestjs/common"
  data_shapes: "GameEstimate {vcpu, memoryGb, costPerHour (4dp), costPerDay24h (2dp), costPerMonth4hpd (2dp, 4h/day x 30)}; CostEstimates {games, totalPerHourIfAllOn}"
  side_effects: none
  role: Nest service
  observations:
    - "No Cost Explorer calls by design (CostService.ts:20-23)"
    - "CostEstimates exported here (14-17) but unused in desktop-main (costs.controller.ts uses ReturnType<CostService['estimateForSpec']>); a separate CostEstimates is declared in desktop-preload/src/hyveon-api.ts:118 — duplicated type"
    - "Imports @hyveon/cloud-aws pricing constants directly — an AWS-specific dependency in a service with no cloud-provider abstraction (2)"
- path: app/packages/desktop-main/src/services/CostService.test.ts
  purpose: Unit tests for estimateForSpec arithmetic.
  exports: none
  dependencies: vitest
  data_shapes: n/a
  side_effects: none
  role: test
  observations:
    - "Pins 1 vCPU/2 GiB -> 0.0494/h, 1.18/day, 5.92/month (rates 0.04048 vCPU-h, 0.004445 GB-h per comment), linear scaling, <=4 decimals, and absence of getActualCosts (CostService.test.ts:12-41)"
- path: app/packages/desktop-main/src/services/DeploymentConfigService.ts
  purpose: Reads/parses/writes the operator's `deployment-config.json` (DeploymentConfig) in the S3 configuration bucket via RemoteFileStore; flattens gameServers to GameServer[]; TTL cache; optimistic-locked writes.
  exports: DeploymentConfigService (getGameServers, getRawConfig, restoreRawConfig, getTopLevelSettings, updateTopLevelSettings, addGameServer, updateGameServer, removeGameServer, isConfigured, invalidateCache); GameServerEntryError + GameServerEntryErrorReason ('invalid-name'|'duplicate-name'|'not-found'|'structural'); ConfigurationNotConfiguredError; RunsTableRenameError
  dependencies: "@hyveon/shared (CONFIGURATION_OBJECT_KEY, DEPLOYMENT_CONFIG_DEFAULTS, errMessage, GAME_NAME_PATTERN(+_DESCRIPTION), normalizeGameServer, OptimisticLockError, RemoteFileConflictError, resolveRunsTableName, withDeploymentConfigDefaults, types DeploymentConfig/GameServer/GameServerConfig/RemoteFileStore); ./ConfigService (getConfigurationBucket, readEnvConfigCacheTtlMs); ../modules/cloud-provider.tokens REMOTE_FILE_STORE; ../logger; @nestjs/common"
  data_shapes: "Raw JSON text <-> DeploymentConfig; GameServer[] = gameServers map entries with key as `name`; write returns {etag, versionId?}; read returns {config, etag?}; CachedGameServers {value, cachedAt, failed}"
  side_effects: "S3 get/put through injected RemoteFileStore (key CONFIGURATION_OBJECT_KEY); winston logs; in-memory cache"
  role: Nest service
  observations: |
    - getGameServers never rejects; failures (incl. unconfigured bucket) negatively cached for TTL — DeploymentConfigService.ts:300-333.
    - Generation counter prevents a stale in-flight fetch repopulating cache after invalidateCache — :239, :309, :314, :328.
    - Unconfigured bucket throws ConfigurationNotConfiguredError before touching the store; empty-string bucket counts as unconfigured — :283-285, :563-567, :620-623.
    - Missing S3 object surfaces as plain Error, not typed — :570-572.
    - RemoteFileConflictError -> OptimisticLockError with best-effort currentEtag via follow-up get — :632-637.
    - Parameter named `expectedVersionId` is actually an etag used as ifMatch (naming mismatch acknowledged in doc) — :336-341, :630.
    - updateTopLevelSettings discards any `gameServers` key smuggled in the IPC patch at runtime — :731-739.
    - RunsTableRenameError guard on projectName/runsTableName changes, applied to settings patches and restoreRawConfig — :756-779, :381-390.
    - restoreRawConfig always unconditional (no ifMatch) — :381-390.
    - Game-name validation only on add (insert), never update/remove — :664-665 vs :683, :697.
    - Read-time legacy https normalisation via normalizeGameServer; writes keep raw shape — :828-835.
    - Stale doc wording: class doc says "Local-vs-S3 deployment-config reader" though there is no local fallback — :222-223; "from disk/S3" — :263-264, :782.
    - Serialization is 2-space pretty JSON + trailing newline; comment references retired HCL format — :782-789.
    - getTopLevelSettings runs withDeploymentConfigDefaults so older docs missing fields don't crash Settings form — :418-423.
- path: app/packages/desktop-main/src/services/DeploymentConfigService.test.ts
  purpose: Unit tests for DeploymentConfigService read path with a stubbed RemoteFileStore.
  exports: none
  dependencies: "vitest; mocked fs + node:fs and ../logger; ../testing/config-service.fixture configServiceStub; TestableDeploymentConfigService subclass overriding now()"
  data_shapes: inline DeploymentConfig fixtures (single, multi, omitted-optionals, rich entry with file_seeds/base64)
  side_effects: none (all mocked)
  role: test
  observations: |
    - Pins: isConfigured truthiness incl. empty string (:339-354); unconfigured never touches fs/store for every method (:356-433); getRawConfig etag + reject on missing (:435-456); fixed CONFIGURATION_OBJECT_KEY (:472); malformed/non-object JSON -> [] (:494-518); negative caching + TTL retry (:519-583); legacy https normalisation and debug logging (:646-710); cache hit/miss/TTL/invalidate (:711-772).
    - Both `fs` and `node:fs` mocked to catch reintroduced disk fallback — :17-37.
- path: app/packages/desktop-main/src/services/DeploymentConfigService.freshInstall.test.ts
  purpose: End-to-end test that BootstrapService.ensureDeploymentConfig seeds deployment-config.json so later DeploymentConfigService writes succeed, using real AwsRemoteFileStore over aws-sdk-client-mock S3.
  exports: none
  dependencies: "aws-sdk-client-mock; @aws-sdk/client-s3 (eslint-disabled restricted import, :31-32); @hyveon/cloud-aws AwsRemoteFileStore; ./BootstrapService; configServiceStub"
  data_shapes: in-memory single-object store {body, etag}
  side_effects: none (mocked S3)
  role: test
  observations: |
    - Pins: write paths fail before seed (getRawConfig rejects /not found/) and succeed after seed; seed returns {status:'created'} then {status:'exists'} without overwriting operator edits — :98-155.
    - Describe title carries review-history label "final-review round 2, finding 1" — :72.
- path: app/packages/desktop-main/src/services/DeploymentConfigService.s3.test.ts
  purpose: Wiring test of DeploymentConfigService against real AwsRemoteFileStore with mocked S3Client.
  exports: none
  dependencies: "aws-sdk-client-mock; @aws-sdk/client-s3 (eslint-disabled, :22); @hyveon/cloud-aws AwsRemoteFileStore; configServiceStub"
  data_shapes: DeploymentConfig fixture with one palworld entry
  side_effects: none
  role: test
  observations: |
    - Pins: GetObjectCommand with Bucket=configured, Key='deployment-config.json' (:90-122); missing Body -> [] not throw (:124-132); PutObjectCommand VersionId propagated through updateGameServer (:134-159).
- path: app/packages/desktop-main/src/services/DeploymentConfigService.write.test.ts
  purpose: Write-path tests (add/update/remove, top-level settings, restore, locking, rename guard, round trip).
  exports: none
  dependencies: "vitest; mocked fs/node:fs/logger; @hyveon/shared DEPLOYMENT_CONFIG_DEFAULTS, OptimisticLockError, RemoteFileConflictError; configServiceStub"
  data_shapes: two-game DeploymentConfig fixture; NEW_ENTRY_CONFIG/UPDATED_ENTRY_CONFIG
  side_effects: none
  role: test
  observations: |
    - Pins: sibling preservation (:188-240); legacy https round trip byte-identical on repeat save (:242-279); https boolean serialization (:281-334); DNS-safe name validation and duplicate-name reason (:336-402); not-found reason (:404-424); legacy non-DNS names still updatable/removable (:426-479); restoreRawConfig unconditional + cache invalidation + rename guard (:481-525); concurrent writes -> OptimisticLockError with expected/current etags (:527-640); top-level settings defaults, gameServers smuggle protection, ifMatch, cache invalidation (:642-837); runs-table rename guard cases (:839-916); full-field round trip (:918+).
    - Comments explicitly note reason codes are "pinned for GamesWriteService's coupling" — :386, :405, :416.
- path: app/packages/desktop-main/src/services/DiagnosticsBundleService.ts
  purpose: Builds a diagnostics .zip (logs.txt, config-summary.json, metadata.json, aws-snapshot.json, errors.json) with best-effort per-section gathering.
  exports: DiagnosticsBundleService (writeBundle); interfaces DiagnosticsBundleErrorEntry, DiagnosticsBundleMetadata, DiagnosticsBundleAwsSnapshot, DiagnosticsBundleWriteResult
  dependencies: "archiver ZipArchive; node:fs createWriteStream, fs/promises rm/rename; node:crypto randomUUID; node:os; @hyveon/shared errMessage/GameStatus; ../app-version readAppVersion; ./DiagnosticsService; ./DeploymentConfigService; ./ConfigService (getStackOutputs); ./EcsService (getStatus); ./ElectronStoreService (get('enableAutoUpdate')); ./diagnosticsBundleAllowlist buildDiagnosticsConfigSummary; ./diagnosticsLogScrubber scrubSecrets"
  data_shapes: "sections {logs?, config?, metadata?, aws?}; errors [{section, message}]; aws snapshot {stackOutputs|null, games: GameStatus[]}"
  side_effects: "writes temp file `${dest}.<uuid>.tmp` then renames; rm temp on failure; reads log tail; AWS ECS calls via EcsService; logs"
  role: Nest service
  observations: |
    - Promise.allSettled across four sections; failures recorded in errors.json (scrubbed) — DiagnosticsBundleService.ts:108-126, :139-152.
    - Log section requests 2000 lines but readTail byte cap (~200KB) may yield fewer (documented) — :18-27.
    - Per-game ECS failure modeled inline as {state:'error'}; does not go to errors.json — :187-199.
    - Atomic write via temp+rename; destroys stream before rm for Windows EBUSY — :232-273.
    - Doc refers to "concurrent `exportBundle` calls" while the method is writeBundle — :229.
    - Metadata reads process.versions directly (electron may be null) — :167-176.
- path: app/packages/desktop-main/src/services/DiagnosticsBundleService.test.ts
  purpose: Tests writeBundle zip contents using real temp dirs and unzipper.
  exports: none
  dependencies: "unzipper; node:fs/os/path; ../testing/stack-outputs.fixture, config-service.fixture, deployment-config.fixture (deploymentConfigStub)"
  data_shapes: zip entry map
  side_effects: real temp-dir filesystem writes
  role: test
  observations: |
    - Pins: all four sections + empty errors.json (:90); AWS failure keeps others (:114); all-fail -> only errors.json (:132); secret scrubbing in logs.txt (:159); per-game snapshot (:175); no partial file on failure (:198-207); per-game rejection inline, errors.json empty (:209-250).
- path: app/packages/desktop-main/src/services/DiagnosticsService.ts
  purpose: Reads today's winston daily-rotate log tail and logs renderer errors/console batches into winston.
  exports: DiagnosticsService (getTodayLogPath, readTail, logRendererError, logRendererConsoleBatch); DIAGNOSTICS_LOG_DIR injection token
  dependencies: "node:fs/promises open; node:path; ../logger; @hyveon/shared errMessage, RendererConsoleLevel, RendererLogEntry"
  data_shapes: "string[] of log entries (multi-line metadata merged); RendererLogEntry {level, message}"
  side_effects: "reads log file; writes winston log lines"
  role: Nest service
  observations: |
    - Log path main-YYYY-MM-DD.log using local date — DiagnosticsService.ts:86-93.
    - Reads fixed 200KB tail (TAIL_READ_BYTES), peeks one byte earlier to safely drop partial first line — :9, :116-127.
    - Merges pretty-printed meta continuation lines (regex /^\s|^[{}[\]]$/) so maxLines counts entries; drops orphan leading continuations — :48, :59-69, :128-138.
    - ENOENT -> []; other errors logged warn and rethrown as plain Error — :139-146.
    - Null-prototype level map guards against __proto__/constructor levels; unknown -> debug — :26-34, :178.
    - Server-side batch cap 200 entries; overflow + droppedCount reported in one warn — :16, :173-186.
    - Renderer console messages logged verbatim (no secret scrubbing at ingest) — :179.
    - Class doc says "Used by the diagnostics API endpoint" (stale HTTP wording; app is IPC-only) — :72-74.
- path: app/packages/desktop-main/src/services/DiagnosticsService.test.ts
  purpose: Tests log path, tail reading, meta-line merging, renderer log ingestion.
  exports: none
  dependencies: "mocked node:fs/promises open and ../logger"
  data_shapes: mock FileHandle serving buffer content
  side_effects: none
  role: test
  observations: |
    - Duplicates TAIL_READ_BYTES constant locally — DiagnosticsService.test.ts:17-18.
    - Pins: ENOENT [], rethrow+warn (:75-101); maxLines/default 500 (:103-129); partial-line/boundary handling (:139-166); metadata merging and entry-based cap (:168-220); renderer error/console level mapping, drop warnings, batch cap, prototype-key fallback (:222-318).
- path: app/packages/desktop-main/src/services/DiscordCommandRegistrar.ts
  purpose: PUTs COMMAND_DESCRIPTORS to Discord REST bulk-overwrite-guild-commands for one guild.
  exports: DiscordCommandRegistrar (registerForGuild); RegisterResult {success, message}
  dependencies: "./DiscordConfigService (getConfig, getEffectiveToken); @hyveon/shared COMMAND_DESCRIPTORS, errMessage; global fetch; ../logger"
  data_shapes: RegisterResult
  side_effects: "HTTPS PUT https://discord.com/api/v10/applications/{clientId}/guilds/{guildId}/commands with Bot token; logs"
  role: Nest service
  observations: |
    - Per-guild only, never global — DiscordCommandRegistrar.ts:38-43, :88.
    - Snowflake regex /^\d{17,20}$/ on both guildId and stored clientId (SSRF guard, CodeQL) — :23-27, :68-79.
    - Never throws; returns {success:false} for missing config, non-2xx (body passed through), network errors — :63-109.
    - Header doc hard-codes "four slash commands" rather than deriving from COMMAND_DESCRIPTORS — :2, :49.
    - Logs Discord error response body on non-2xx — :100.
- path: app/packages/desktop-main/src/services/DiscordCommandRegistrar.test.ts
  purpose: Tests registerForGuild with mocked global fetch and stubbed DiscordConfigService.
  exports: none
  dependencies: "vitest; mocked ../logger; globalThis.fetch replaced"
  data_shapes: none
  side_effects: none (overwrites globalThis.fetch for the file — :16-17)
  role: test
  observations: |
    - Pins: empty guildId early return (:46); missing clientId/token messages (:53-79); PUT with Bot auth header (:80); non-2xx and thrown errors surfaced (:97-122); warn on non-2xx (:124); Snowflake rejection for guildId and malformed stored clientId (:135-168).
    - Header references the retired always-on `DiscordBotService.registerCommandsForGuild()` — :1-4.
- path: app/packages/desktop-main/src/services/DiscordConfigService.ts
  purpose: Management-side read/write of the Discord DynamoDB config row (dynamic + BASE#discord) and the bot-token/public-key Secrets Manager secrets, with a redacted view.
  exports: DiscordConfigService (getConfig, getBaseConfig, getEffectiveToken, getRedacted, setCredentials, setAllowedGuilds, addAllowedGuild, removeAllowedGuild, setAdmins, setGamePermission, deleteGamePermission, invalidateCache); re-export type DiscordAction
  dependencies: "./ConfigService getStackOutputs (discordTableName, discordBotTokenSecretArn, discordPublicKeySecretArn); ../modules/cloud-provider.tokens SECRETS_STORE, DISCORD_CONFIG_STORE; @hyveon/shared asStringArray, isSafeGameKey, errMessage, types BaseDiscordConfig/DiscordConfig/DiscordConfigStore/RedactedDiscordConfig/SecretsStore"
  data_shapes: "DiscordConfig {clientId, allowedGuilds, admins{userIds,roleIds}, gamePermissions{[game]:{userIds,roleIds,actions}}}; BaseDiscordConfig {allowedGuilds, admins}; RedactedDiscordConfig with botTokenSet/publicKeySet booleans"
  side_effects: "DynamoDB via injected DiscordConfigStore; Secrets Manager via injected SecretsStore; logs; in-memory caches"
  role: Nest service
  observations: |
    - Secrets never returned except getEffectiveToken (used by registrar); redacted view exposes booleans — DiscordConfigService.ts:49-53, :217-220, :257-274.
    - Uses injected DiscordConfigStore instead of shared getDocClient() to avoid ambient-credential CredentialsProviderError bug (documented) — :71-91.
    - load()/loadBase() coalesce concurrent reads via inflight promise; failures cached as empty config until invalidateCache — :119-140, :149-174.
    - Risk: a transient DDB read failure caches emptyConfig; subsequent mutations (setAllowedGuilds etc.) would save over the real row from that empty base — :129-134 with :322-326.
    - Mutations modify the cached object in place before save(); if save throws, cache retains unsaved mutations — :184-194 with :323-325, :396-397.
    - invalidateCache does not clear inflight promises — :415-418.
    - setCredentials writes clientId to DDB before secrets; ARN resolution (`await this.botTokenSecretArn()`) happens outside the try so a missing-ARN error escapes un-logged — :298-305, :309-316.
    - Empty/whitespace clientId and empty token strings are ignored (no wipe) — :297-300, :303-307.
    - Game-permission actions filtered to start/stop/status; unsafe game keys rejected via isSafeGameKey — :378-393, :404-407.
    - removeAllowedGuild refuses base-config guilds — :342-354.
    - Header doc references `/api/discord/config` HTTP route (stale; app is IPC-only) — :8-9; also says "web UI" — :45-47.
- path: app/packages/desktop-main/src/services/DiscordConfigService.test.ts
  purpose: Tests DiscordConfigService wiring over stubbed DiscordConfigStore/SecretsStore.
  exports: none
  dependencies: "vitest; mocked ../logger; ../testing/stack-outputs.fixture"
  data_shapes: StackOutputs fixture incl. discord ARNs and fileBrowser fields
  side_effects: none
  role: test
  observations: |
    - Pins: empty config when stack outputs missing (:111); degrade on DDB read failure (:126); redacted booleans, base lists, negative caching of empty fallbacks (:145-242); setCredentials routing, type rejection, no-wipe, trim, error rethrow (:244-305); allowlist add idempotency/remove/base-refusal/dedupe/write error (:307-367); game-permission sanitization and unsafe-key rejection (:369-415).
    - Test title says "warning-level" but asserts logger.error — DiscordConfigService.test.ts:126, :139.
    - "placeholder" test actually stubs undefined, not a placeholder value — :173-178.
- path: app/packages/desktop-main/src/services/DriftService.ts
  purpose: Computes declared-vs-applied deployment drift (pending_create / pending_delete / config_drift) per game.
  exports: computeDrift(declared, applied, deployedNames), computeDriftFromOutputs(declared, outputs), class DriftService (getDrift)
  dependencies: "@nestjs/common Injectable; @hyveon/shared (DriftChangedField, DriftEntry, DriftReport, GameServer, StackOutputs types; errMessage, normalizeGameServer); ../logger.js; ./ConfigService (getStackOutputs); ./DeploymentConfigService (invalidateCache, getGameServers)"
  data_shapes: "in: GameServer[], Record<string, Omit<GameServer,'name'>> | null (StackOutputs.appliedGameServers), string[] deployed names; out: DriftReport { entries: DriftEntry[] } where DriftEntry = {game, kind, changedFields?}"
  side_effects: "getDrift: invalidates DeploymentConfigService cache, reads S3 deployment-config (via service) and Pulumi stack outputs (via ConfigService); logs debug/warn. computeDrift* pure."
  role: Nest service (plus pure exported functions)
  observations:
    - "Compared fields fixed list image/cpu/memory/ports/volumes; webPort folded into the 'ports' value as a marker entry {webPort} rather than its own DriftChangedField — DriftService.ts:13-20 (line 18)."
    - "Both sides run through normalizeGameServer() so a legacy https snapshot (ports[0] as upstream) doesn't register drift — DriftService.ts:80-82."
    - "ports/volumes compared order-insensitively via canonical key-sorted stringify + sort; scalars via JSON.stringify — DriftService.ts:27-29, 38-48, 62-67."
    - "Fields not in COMPARED_FIELDS (environment, command, healthCheck, https, file_seeds, pinnedHostname, connect_message, etc.) never produce drift — DriftService.ts:13-20."
    - "Declared + deployed but missing from applied map → silently no entry (no config_drift possible) — DriftService.ts:139-142."
    - "deployedNames = keys(appliedGameServers) when present, else outputs.gameNames fallback — DriftService.ts:167-171."
    - "Deliberately does NOT invalidate ConfigService stack-outputs cache (only DeploymentConfigService) because of a 30s poll — DriftService.ts:191-209."
    - "Doc comment references stale HTTP route 'GET /api/drift' though the app has no HTTP transport — DriftService.ts:196."
    - "Errors normalized via errMessage, logged warn, rethrown as plain Error — DriftService.ts:213-217."

- path: app/packages/desktop-main/src/services/DriftService.test.ts
  purpose: Unit tests for computeDrift and DriftService.getDrift.
  exports: none
  dependencies: "vitest; ./DriftService; ../testing/stack-outputs.fixture, config-service.fixture, deployment-config.fixture (gameServer, deploymentConfigStub)"
  data_shapes: GameServer fixtures, Partial<StackOutputs>
  side_effects: none (logger mocked)
  role: test
  observations:
    - "Pins: pending_create/pending_delete classification, exact changedFields set, in-sync games omitted, gameNames fallback when appliedGameServers null, order-insensitive ports/volumes, legacy https snapshot = no drift, webPort-only change → ['ports'], deterministic ordering (declared then deployed-only), per-field it.each — DriftService.test.ts:48-231."
    - "Pins getDrift does NOT call ConfigService.invalidateCache but DOES call DeploymentConfigService.invalidateCache once; failures logged warn and rethrown with message only — DriftService.test.ts:235-346."
    - "computeDriftFromOutputs is only exercised indirectly through getDrift — no direct test."

- path: app/packages/desktop-main/src/services/Ec2Service.ts
  purpose: Thin EC2 wrapper for ENI IP resolution and app-managed security-group ingress rules.
  exports: class Ec2Service (getPublicIp, getPrivateIp, authorizeIngress, listIngressRulesByDescriptionPrefix, revokeIngressRules)
  dependencies: "@aws-sdk/client-ec2 (EC2Client, DescribeNetworkInterfaces, AuthorizeSecurityGroupIngress, DescribeSecurityGroupRules, RevokeSecurityGroupIngress); @hyveon/shared (errMessage, resolveEniPublicIp); ./ConfigService (getRegion); ./ElectronStoreService; ./awsCredentialSource (resolveAwsClientCredentialsWithSignature); ./awsClientCache (createCachedAwsClient)"
  data_shapes: "ENI id → string|null IP; ingress rules {ruleId, description, cidr}[]"
  side_effects: "AWS EC2 API calls (describe/authorize/revoke SG rules); logs."
  role: Nest service (AWS facade)
  observations:
    - "Client cached per region + credentials signature; region from ConfigService.getRegion() (wizard region) — Ec2Service.ts:24-27, 40-44."
    - "getPublicIp/getPrivateIp swallow errors and return null; logger.error is passed the raw err object ({ err, eniId }) rather than a normalized message, contrary to logging.md rule 2 — Ec2Service.ts:59-62, 78-81."
    - "authorizeIngress is tcp single-port; 'InvalidPermission.Duplicate' treated as success (warn) — Ec2Service.ts:90-115 (108-111)."
    - "listIngressRulesByDescriptionPrefix paginates NextToken, skips egress / missing id / non-prefix; cidr defaults to '' when CidrIpv4 absent; returns [] on failure (best-effort) — Ec2Service.ts:121-151."
    - "revokeIngressRules short-circuits true for empty list; returns false on failure — Ec2Service.ts:154-166."
    - "getPublicIp has no entry debug log, unlike the SG methods — Ec2Service.ts:51-63."

- path: app/packages/desktop-main/src/services/Ec2Service.test.ts
  purpose: Unit tests for Ec2Service via aws-sdk-client-mock.
  exports: none
  dependencies: "vitest; aws-sdk-client-mock; @aws-sdk/client-ec2; ../testing/config-service.fixture"
  data_shapes: mocked SDK responses
  side_effects: none
  role: test
  observations:
    - "Pins: public/private IP null on missing association/empty/API error, ENI id passthrough, client built with store-resolved pasted credentials, authorizeIngress payload shape + duplicate-as-success + plain Error rethrow, prefix/egress filtering, [] on error, empty revoke makes no call, false on revoke error — Ec2Service.test.ts:43-173."
    - "No test of DescribeSecurityGroupRules pagination (NextToken loop)."

- path: app/packages/desktop-main/src/services/EcsService.ts
  purpose: ECS facade — game start/stop/status delegated to the injected CloudProvider, plus raw ECS helpers for task defs and FileBrowser helper tasks.
  exports: "buildProviderConfig(config, store), awsCloudProviderLogger, createAwsCloudProvider(config, store), interface GameStatus, interface StartResult, class EcsService (extractEniId, findRunningTask, getStatus, start, stop, getTaskDefinition, registerTaskDefinition, runTask, describeStoppedReason, listTasksByStartedBy, stopTask, listTasksByStartedByPrefix, deregisterTaskDefinition)"
  dependencies: "@aws-sdk/client-ecs; @hyveon/cloud-aws (AwsCloudProvider, WorkloadGuardError, WorkloadLaunchError, AwsCloudProviderConfig, AwsCloudProviderLogger); @hyveon/shared (getTaskEniId, CloudProvider, errMessage); ./ConfigService; ./Ec2Service; ./ElectronStoreService; ./awsCredentialSource; ./awsClientCache; ../modules/cloud-provider.tokens (CLOUD_PROVIDER)"
  data_shapes: "GameStatus {game, state: running|starting|stopped|not_deployed|error, publicIp?, hostname?, taskArn?, message?}; StartResult {success, message, taskArn?}; AwsCloudProviderConfig {region, credentials, credentialsSignature, ecsClusterName, subnetIds (comma-joined), securityGroupId, domainName, gameNames}"
  side_effects: "AWS ECS ListTasks/DescribeTasks/RunTask/StopTask/Register/Deregister/DescribeTaskDefinition; reads stack outputs and electron-store credentials; logs."
  role: Nest service (AWS facade / CloudProvider adapter)
  observations:
    - "Invariant restated: no persistent ECS Service; start/stop are on-demand RunTask/StopTask against {game}-server — EcsService.ts:174-176."
    - "buildProviderConfig uses outputs.awsRegion (deployed stack region) while EcsService.getClient uses ConfigService.getRegion() (wizard region) — raw-client helpers (FileBrowser path) and provider can target different regions if they diverge — EcsService.ts:71 vs 213."
    - "subnetIds joined into a comma string for the provider config — EcsService.ts:75."
    - "Constructor keeps an unused `_ec2: Ec2Service` parameter purely for DI-signature compatibility — EcsService.ts:196-199."
    - "describeError returns WorkloadGuardError/WorkloadLaunchError messages unprefixed; anything else String(err) → '<name>: <message>' — EcsService.ts:121-124."
    - "Guard refusals logged warn, other failures error (with raw err object) — EcsService.ts:292-296, 314-318."
    - "start success message hard-codes '2–5 minutes' — EcsService.ts:288."
    - "registerTaskDefinition has a convoluted conditional parameter type and dynamically imports RegisterTaskDefinitionCommand although the module is already statically imported — EcsService.ts:353-355."
    - "runTask deliberately never logs full params (containerOverrides env may carry secrets) — EcsService.ts:382-391."
    - "getTaskDefinition defaults cpu 1024 / memory 2048 when absent — EcsService.ts:337-338."
    - "findRunningTask/listTasksByStartedBy/getTaskDefinition/registerTaskDefinition swallow errors (null/[]); listTasksByStartedByPrefix throws so callers can't mistake failure for 'no tasks' — EcsService.ts:248-251, 441-444, 494-497."
    - "listTasksByStartedByPrefix pages ListTasks and describes in batches of 100 (DESCRIBE_TASKS_BATCH) with include TAGS, filtering locally since ListTasks startedBy is exact-match — EcsService.ts:31, 473-498."
    - "stopTask rethrows a plain Error preserving err.name — EcsService.ts:456-464."
    - "describeStoppedReason joins task.stoppedReason + container reasons with '; ', fallback 'stopped with no reason reported' — EcsService.ts:406-419."
    - "findRunningTask appears unused by getStatus/start/stop now (provider handles lookup) — EcsService.ts:232."

- path: app/packages/desktop-main/src/services/EcsService.test.ts
  purpose: Unit tests for EcsService and buildProviderConfig using aws-sdk-client-mock on ECSClient and EC2Client with a real AwsCloudProvider.
  exports: none
  dependencies: "vitest; aws-sdk-client-mock; @aws-sdk/client-ecs, client-ec2; ./EcsService (EcsService, createAwsCloudProvider, buildProviderConfig); ../testing fixtures"
  data_shapes: StackOutputs fixture, Task literals
  side_effects: none
  role: test
  observations:
    - "Pins: ENI extraction, findRunningTask family/desiredStatus scoping and STOPPED/DEPROVISIONING filtering, getStatus not_deployed/running+hostname/starting/stopped/no-hostname-without-domain, start launches {game}-server with game SG + assignPublicIp ENABLED, exact unprefixed 'Failed to start minecraft: CAPACITY', SDK exception name surfaced, stop paths, task-def defaults, runTask never logs containerOverrides env, prefix listing pagination + 100-batch describe + throw on error, credential rotation rebuilds client, buildProviderConfig prefers outputs.awsRegion — EcsService.test.ts:116-673."
    - "Comments reference historical 'removed Ec2Service plumbing' / 'constructor default before CLOUD_PROVIDER token' — EcsService.test.ts:33-39, 102-110."
    - "No test for describeStoppedReason."

- path: app/packages/desktop-main/src/services/ElectronStoreService.ts
  purpose: Typed wrapper over electron-store (Map fallback outside Electron) with SafeStorage encryption of secret fields and helpers for Pulumi lock/rollback bookkeeping and folder-upload state.
  exports: "interfaces PastedAwsCredentials, PulumiLockOwnershipRecord, OrphanedRollbackRecord, GameWizardDraft, StoredGameWizardDraft, AppStoreSchema; class ElectronStoreService (isElectron, isSafeStorageAvailable, get, set, delete, get/setSecretAccessKeyId, get/setSecretAccessKey, get/set/deletePastedCredentials, get/setPulumiPassphrase, recordPulumiLockAttempt, clearPulumiLockAttempt, listPulumiLockAttempts, recordOrphanedRollback, getOrphanedRollback, clearOrphanedRollback, getFolderUploadState, setFolderUploadSelection, clearFolderUploadState, setFolderUploadLastRun; protected createStore, readIsElectron)"
  dependencies: "electron-store (dynamic ESM import, Electron-only); node:crypto randomUUID; node:os hostname/userInfo; @hyveon/shared/folderUpload (FolderUploadLastRun, FolderUploadStoredState); ./SafeStorageService; ../logger"
  data_shapes: "AppStoreSchema {wizardCompleted, activeCloud:'aws', enableAutoUpdate?, aws{region,profile,accessKeyId(enc),secretAccessKey(enc)}, bootstrap?{stateBucket, configurationBucket}, creds{aws: Record<profile, PastedAwsCredentials>}, pulumi?{stackInitialized, passphrase(deprecated, enc), lockOwnership: Record<runId, record>, orphanedRollback}, addGameWizardDraft?, folderUpload?: Record<game, FolderUploadStoredState>}"
  side_effects: "Writes electron-store JSON file in userData ('electron-store' name) inside Electron; in-memory Map otherwise; encrypt/decrypt via SafeStorageService; debug logs (identifiers only)."
  role: Nest service (persistence)
  observations:
    - "Top-level await dynamic import of electron-store gated on process.versions.electron (ESM-only package) — ElectronStoreService.ts:9-15."
    - "Non-Electron mode silently uses a non-persistent Map — ElectronStoreService.ts:296-316."
    - "GameWizardDraft is a manual copy of WizardDraft in @hyveon/web with a 'keep this copy in sync' comment — duplication.md flags this as a bug report — ElectronStoreService.ts:99-107."
    - "Wizard draft stored plaintext; redaction of env values / file_seed content happens only on read in GameWizardDraftService — ElectronStoreService.ts:157-167."
    - "Pulumi passphrase is now derived from AWS account id; stored passphrase is deprecated, setPulumiPassphrase marked @deprecated and kept only for tests — ElectronStoreService.ts:233-264, 532-537."
    - "SafeStorageService.encrypt degrades to plaintext outside Electron; callers must check availability themselves — ElectronStoreService.ts:519-528."
    - "Lock-ownership records keyed by randomUUID run id with stackName/startedAt/username/hostname; clear is no-op if absent — ElectronStoreService.ts:559-587."
    - "getOrphanedRollback/clearOrphanedRollback documented as having no controller caller — ElectronStoreService.ts:626-650."
    - "Comment cites a task number ('Task 4.7') contrary to comment-verbosity rules — ElectronStoreService.ts:577-578."
    - "Pasted-credential log line interpolates profileName (identifier, not secret) — ElectronStoreService.ts:476, 489."
    - "setFolderUploadLastRun is a no-op when no selection was stored — ElectronStoreService.ts:676-681."
    - "All nested writes are read-modify-write of the whole top-level key (not atomic across concurrent writers) — e.g. ElectronStoreService.ts:561-568, 663-664."

- path: app/packages/desktop-main/src/services/ElectronStoreService.test.ts
  purpose: Unit tests for ElectronStoreService in Map mode, mocked-Store Electron mode, and a disk-backed store double.
  exports: none
  dependencies: "vitest; electron-store (vi.mock); node:fs/os/path; ./ElectronStoreService; ./SafeStorageService"
  data_shapes: AppStoreSchema values, StoredGameWizardDraft sample
  side_effects: "Writes/removes a temp dir file in os.tmpdir() for the plaintext-leak test — ElectronStoreService.test.ts:571-578."
  role: test
  observations:
    - "Pins: Map fallback get/set/delete, Electron path delegates to store, encrypt-on-write/decrypt-on-read for aws keys, pasted creds, passphrase; lock-attempt record/list/clear semantics with OS identity; relaunch persistence for activeCloud and enableAutoUpdate; persisted file never contains plaintext keys/passphrase; orphaned-rollback single slot preserving other pulumi fields; wizard draft round-trip; per-game folder-upload state — ElectronStoreService.test.ts:56-751."
    - "Uses `as unknown as` double casts (forbidden by testing-conventions rule 2) for prototype spies and store doubles — ElectronStoreService.test.ts:51, 113, 117, 400, 600."
    - "No test for deletePastedCredentials."

- path: app/packages/desktop-main/src/services/FileManagerService.ts
  purpose: Launches/stops per-game on-demand FileBrowser helper tasks on Fargate (browse and TLS upload variants), with per-launch credential, operator-IP SG rule, auto-stop schedule, and stray-helper sweep.
  exports: "interfaces FileMgrStatus, FileMgrCredentials, UploadHelperSession, FileMgrResult; type UploadHelperLaunch; class FileManagerService (getStatus, getHelperPublicIp, getHelperStopReason, start, startForUpload, stop, sweepStrayHelpers)"
  dependencies: "bcryptjs hash; node:crypto randomBytes; @aws-sdk/client-ecs Task type; @hyveon/shared (errMessage, fileManagerLogGroupName, SecretsStore, StackOutputs); @hyveon/shared/folderUpload (StrayHelperReport); ./ConfigService; ./EcsService; ./Ec2Service; ./SchedulerService (createStopSchedule, deleteSchedule); ./PublicIpService (detect); ./folderUpload/ephemeralCert (generateEphemeralCert); ./folderUpload/tlsLaunch (buildTlsContainerSettings); ../modules/cloud-provider.tokens (SECRETS_STORE)"
  data_shapes: "FileMgrStatus {game, state, url?, taskArn?}; FileMgrResult {success, message, taskArn?, credentials?}; UploadHelperSession {taskArn, runId, credentials, cert}; StrayHelperReport {stopped[{game,taskArn,ageMinutes}], skipped, revokedRules, errors[]}"
  side_effects: "ECS RegisterTaskDefinition/RunTask/StopTask/Deregister; EC2 SG authorize/revoke; Secrets Manager put (bcrypt hash audit record); EventBridge Scheduler one-time schedule create/delete; public-IP detection network call; logs."
  role: Nest service
  observations:
    - "FileBrowser image unpinned 'filebrowser/filebrowser:latest' — FileManagerService.ts:17."
    - "Constants: port 8080, startedBy 'filemgr-{game}', username 'admin', 18-byte base64url password, bcrypt cost 10, 2h auto-stop, schedule name 'filemgr-stop-{game}', SG rule description 'hyveon-filemgr:{game}:{runId}', run id 'browse' for dashboard sessions, task tag OperatorIp — FileManagerService.ts:17-48."
    - "Comments carry issue-number history (#350, #346) — FileManagerService.ts:30, 111-112."
    - "Password hashed with bcrypt and passed via --password flag (hash, never plaintext); plaintext returned once in start()/startForUpload() result; getStatus never returns credentials — FileManagerService.ts:55-59, 367-372, 405-412."
    - "Secrets Manager write of the hash is best-effort audit only; failure logged with raw err and launch continues — FileManagerService.ts:374-383."
    - "Operator /32 SG rule authorized before task-def registration; rules reference-counted by CIDR from remaining helpers' OperatorIp tags; any remaining helper lacking the tag aborts revocation entirely — FileManagerService.ts:169-204, 385-397."
    - "If generateEphemeralCert throws after authorizeIngress the opened rule is not cleaned up (no try around cert generation) — appears to leak until next stop/sweep — FileManagerService.ts:393-414."
    - "Failure cleanup revokes orphaned rules (excluding this game's helpers) and deregisters the registered task def — FileManagerService.ts:399-403, 461-488."
    - "Throwaway task def per launch: family 'filebrowser-{game}', 256 CPU / 512 MiB, game's execution role reused, EFS access point with transit encryption, awslogs to fileManagerLogGroupName(game) without create-group — FileManagerService.ts:363-365, 418-459."
    - "Upload variant gets UPLOAD_TAGS and TLS container settings (sh -c wrapper); browse variant gets command flags only — FileManagerService.ts:413-414, 444, 475."
    - "getStatus always builds an http:// URL even though upload helpers serve TLS — FileManagerService.ts:240."
    - "Only one helper per game (existing-task guard returns code 'helper-open') — FileManagerService.ts:343-352."
    - "Auto-stop schedule missing role or creation failure → launch still succeeds with a ' Warning: …' message suffix — FileManagerService.ts:498-515."
    - "stop() always revokes orphaned rules in finally, even when no task found; failure message is String(err) ('Error: …') — FileManagerService.ts:538-564 (559)."
    - "sweepStrayHelpers skips active games and tasks younger than minAgeMs; task age falls back to createdAt, then +Infinity — FileManagerService.ts:574-617 (591-592)."
    - "logger.error on missing access point logs the whole efsAccessPoints map — FileManagerService.ts:334."

- path: app/packages/desktop-main/src/services/FileManagerService.test.ts
  purpose: Unit tests for FileManagerService with hand-built stubs for ECS, EC2, Scheduler, SecretsStore, PublicIp.
  exports: none
  dependencies: "vitest; ./FileManagerService; ../testing/stack-outputs.fixture, config-service.fixture"
  data_shapes: StackOutputs fixture, Task literals, SG rule objects
  side_effects: "none (real bcrypt hashing and real ephemeral cert generation run in-process)"
  role: test
  observations:
    - "Pins: status states and http://IP:8080 URL with no credentials field; start failure guards (not deployed, no EFS AP, no SG, already running, no exec role); task-def shape incl. bcrypt hash in --password, no --noauth, no awslogs-create-group; fresh password per launch; secret hash write and best-effort failure; auto-stop schedule creation/warnings — FileManagerService.test.ts:196-455."
    - "Pins CIDR reference-counted rule revocation across stop/start-failure/sweep paths, including shared rules, IP changes, untagged helper keeps all, lookup failure keeps all — FileManagerService.test.ts:494-657, 804-874."
    - "Pins upload helper: tags Purpose/Project/OperatorIp, TLS sh -c wrapper with FB_TLS_CERT_B64/KEY_B64 env, run id in rule description, helper-open refusal, plaintext never in task def — FileManagerService.test.ts:660-718."
    - "Pins getHelperPublicIp stop-reason throw and sweep age/active-game filtering — FileManagerService.test.ts:720-879."
    - "sgRule/ruleFor helpers lack TSDoc for ruleFor (inline const) — FileManagerService.test.ts:620."
- path: app/packages/desktop-main/src/services/FirstRunWizardService.ts
  purpose: Owns the first-run wizard's resumable step-progress file (userData/wizard-state.json) plus complete/reset of wizard answers in ElectronStoreService.
  exports: FirstRunWizardService (Nest @Injectable; getProgress, recordStep, complete, reset, protected stateFilePath/userDataPath); types WizardStepName (= WizardStep), GuidedIamSubState, WizardProgress
  dependencies: "@hyveon/shared WIZARD_STEPS/WizardStep; ./ElectronStoreService; ../logger; node fs/promises (mkdir/readFile/rm/writeFile), path, os.tmpdir, module.createRequire (dynamic electron require)"
  data_shapes: "WizardProgress { step; guidedIam?: { subState: 'not-started'|'template-written'|'awaiting-key-intake'|'rotation-pending'|'complete'; hasBootstrapKey: boolean } } (21-41); DEFAULT_PROGRESS { step: 'pick-cloud' } (44)"
  side_effects: "filesystem read/write/rm of wizard-state.json (70,122,132,176,201); electron-store set wizardCompleted / delete activeCloud,aws,bootstrap,creds (177,202-206); winston debug/info/warn (117,133,178,207)"
  role: Nest service
  observations:
    - "getProgress swallows every read/parse error silently (no log) and returns DEFAULT_PROGRESS — FirstRunWizardService.ts:77-79"
    - "recordStep validates step, subState enum, and hasBootstrapKey type at runtime because IPC erases types; rebuilds the persisted object field-by-field to drop excess props — FirstRunWizardService.ts:103-132"
    - "hasBootstrapKey value deliberately never echoed into the thrown error (anti secret-smuggling) — FirstRunWizardService.ts:110-116"
    - "complete() removes the resume file BEFORE setting wizardCompleted so a failed rm leaves wizard genuinely incomplete — FirstRunWizardService.ts:166-179"
    - "reset() deliberately does not touch pulumi.* (legacy passphrase / lock records); also does not clear addGameWizardDraft or folder-upload state — FirstRunWizardService.ts:189-208"
    - "userDataPath 'Mirrors ConfigService.readUserDataPath' dynamic-require seam — duplication marker per repo duplication rule — FirstRunWizardService.ts:215-240"
    - "tmpdir fallback namespaced under hyveon-wizard to avoid symlink pre-creation risk — FirstRunWizardService.ts:222-239"
    - "comment references issue #211 Settings 'Reconfigure' flow — FirstRunWizardService.ts:161-162"

- path: app/packages/desktop-main/src/services/FirstRunWizardService.test.ts
  purpose: Unit tests for FirstRunWizardService against a real scratch dir.
  exports: none
  dependencies: "vitest; fs/os/path; FirstRunWizardService; mocked ../logger"
  data_shapes: "TestableFirstRunWizardService subclass exposing protected seams (15-22); stub store with set/delete vi.fn (25-28)"
  side_effects: "creates/removes mkdtemp scratch dirs"
  role: test
  observations:
    - "Pins: degrade-to-pick-cloud on missing/invalid/unknown step (54-75); guidedIam dropped when malformed (87-117); write-side allowlist drops smuggled props (174-192); non-boolean hasBootstrapKey rejected without echo (226-247); complete clears file + sets flag (250-274); reset deletes activeCloud/aws/bootstrap/creds and never touches pulumi (277-312); tmpdir fallback path hyveon-wizard (323-327)"

- path: app/packages/desktop-main/src/services/FolderScanService.ts
  purpose: Native folder picker + recursive local folder scan into a FolderScanNode tree held in main by scanId.
  exports: FolderScanService (pickDirectory, pickAndScan, scan, get); interface HeldScan
  dependencies: "@hyveon/shared errMessage; @hyveon/shared/folderUpload FolderScanNode/FolderScanResult types; ../logger; node:crypto randomUUID; node:fs/promises lstat/readdir; dynamic import('electron') dialog"
  data_shapes: "HeldScan { scanId, rootPath, tree, mtimes: Map<relPath, mtimeMs> } (10-16); FolderScanResult { scanId, rootName, tree, fileCount, totalBytes, skippedLinks } (64)"
  side_effects: "Electron dialog.showOpenDialog (39); filesystem readdir/lstat (84,93); logs info on success / warn on failure (63,67); in-memory scan map"
  role: Nest service
  observations:
    - "pickDirectory returns null outside Electron (process.versions.electron guard) — FolderScanService.ts:35"
    - "Scan retention MAX_HELD_SCANS=8, FIFO eviction by Map insertion order; get() does not refresh recency — FolderScanService.ts:19,62,73-75"
    - "Symlinks skipped and counted; entries that are neither file/dir/symlink (fifo, socket) silently dropped, not counted — FolderScanService.ts:88-98"
    - "Any unreadable subdirectory throws for the whole scan (no per-entry try) — FolderScanService.ts:84,91"
    - "Success log carries only rootName, but failure log includes the full local rootPath — FolderScanService.ts:63,67"
    - "Directories sorted before files, then localeCompare; dir size is rolled-up sum — FolderScanService.ts:99-100"
    - "relPaths are POSIX '/'-joined regardless of platform — FolderScanService.ts:87"

- path: app/packages/desktop-main/src/services/FolderScanService.test.ts
  purpose: Unit tests for FolderScanService over a real temp tree with symlinks.
  exports: none
  dependencies: "vitest; node fs/promises (symlink); FolderScanService; mocked ../logger"
  data_shapes: "temp tree Config/options.json, Data/worlds/a.db, readme.txt + 2 symlinks (14-22)"
  side_effects: "creates/removes temp dirs and symlinks"
  role: test
  observations:
    - "Pins: POSIX relPaths, rolled-up sizes, 3 files/107 bytes, dir-first ordering (27-35); 2 symlinks skipped (37-41); absolute path never in result (43-50); eviction after 8 newer scans (52-57); normalized 'Could not scan folder' error (59-61); null picker outside Electron (63-65)"

- path: app/packages/desktop-main/src/services/FolderUpload.integration.test.ts
  purpose: End-to-end FolderUploadService run through the real FileBrowserClientFactory against an in-process HTTPS fake FileBrowser.
  exports: none
  dependencies: "FolderUploadService, FolderScanService, ElectronStoreService, SafeStorageService, folderUpload/FileBrowserClient (FileBrowserClientFactory), folderUpload/ephemeralCert generateEphemeralCert, ../testing/{config-service,deployment-config,stack-outputs}.fixture, ../testing/fake-filebrowser-server startFakeFileBrowser"
  data_shapes: "run() harness options { presentedCert, seed, onUpload, answer } (45-51)"
  side_effects: "starts local HTTPS server; temp dirs; real ElectronStoreService instance"
  role: test (integration)
  observations:
    - "Pins: streaming over pinned TLS + verify + helper stop (89-95); resume skips identical files, re-sends size-mismatched ones with ?override=true after confirmation (97-104); dropped-connection retry (106-110); persistent drops → failed + stop (112-116); cert mismatch → zero requests sent (118-124); decline → nothing written (126-132); no prompt when no differing files (134-138)"
    - "Uses a real ElectronStoreService(new SafeStorageService()) outside Electron — FolderUpload.integration.test.ts:70"

- path: app/packages/desktop-main/src/services/FolderUploadService.ts
  purpose: Orchestrates folder-to-EFS-volume uploads via an ephemeral FileBrowser helper task — guards, helper lifecycle, overwrite confirmation, streamed upload with resume, verification, progress and last-run persistence.
  exports: FolderUploadService (OnApplicationBootstrap; onProgress, getProgress, getSelection, setSelection, clearSelection, rescanSelection, cancel, confirmOverwrite, cleanupStrayHelpers, startUpload; public mutable timings/engine); interface FolderUploadTimings
  dependencies: "@hyveon/shared errMessage; @hyveon/shared/folderUpload planUpload/toRemotePath/validateDestination + types; ConfigService.getStackOutputs; DeploymentConfigService.getGameServers; EcsService.findRunningTask; ElectronStoreService folder-upload state methods; FileManagerService (startForUpload, stop, getStatus, getHelperPublicIp, getHelperStopReason, sweepStrayHelpers); FolderScanService; folderUpload/FileBrowserClient (FileBrowserClientFactory, PinMismatchError, FileBrowserApi); folderUpload/ProgressAggregator; folderUpload/uploadEngine (abortableSleep, classifyUpload, ConfirmationTimeoutError, DEFAULT_ENGINE_OPTIONS, ensureDirs, listPlannedDirs, remoteSizesOf, uploadAll, UploadCancelledError, verifyUpload)"
  data_shapes: "FolderUploadTimings { helperPort 8080, pollMs 3000, helperIpTimeoutMs 3m, loginTimeoutMs 2m, confirmationTimeoutMs 10m } (48-59,90); ActiveRun { runId, controller } (62-65); PreparedRun { game, scan, request, items, bytesTotal, resumesOwnRun } (68-76); UploadItem { relPath, localPath, remotePath, size, mtimeMs } (251-257)"
  side_effects: "ECS helper task start/stop via FileManagerService (310,439); HTTPS to helper via FileBrowserApi (323-333); electron-store selection + lastRun writes (143,152,418); progress listener emissions (294-297); logs throughout; startup stray-helper sweep (113-118)"
  role: Nest service
  observations:
    - "Synchronous per-game 'preparing' reservation closes the race between guard and active.set — FolderUploadService.ts:193-217"
    - "Run body is fire-and-forget (void this.execute) after startUpload returns {started:true} — FolderUploadService.ts:219"
    - "Selection is persisted only after every guard passes, yet the not-deployed refusal says 'your selection is kept' — FolderUploadService.ts:209,240"
    - "Guard order: request shape → already-running → scan held → stack outputs/efsAccessPoints → known game → destination → plan non-empty → ECS task not running → helper not open — FolderUploadService.ts:230-265"
    - "Overwrite prompt skipped when resuming this app's own cut-short run and conflicts <= engine.concurrency — FolderUploadService.ts:369-371,281-291"
    - "Confirmation wait rejects with ConfirmationTimeoutError after confirmationTimeoutMs; cancelled phase carries that message — FolderUploadService.ts:390-412,341-342"
    - "Helper stopped in finally only if this run launched it; failure to stop is logged not thrown — FolderUploadService.ts:345-347,431-444"
    - "withStopReason skips enrichment by string-matching 'stopped before it was reachable' — couples to FileManagerService message text — FolderUploadService.ts:448"
    - "PinMismatchError aborts login retry immediately (fail closed) — FolderUploadService.ts:486"
    - "Verification failure message lists at most 5 paths then 'and N more' — FolderUploadService.ts:45,334-338"
    - "cancel() while still in prepare returns {cancelled:false} since active not yet set — FolderUploadService.ts:162-166,214"
    - "Helper credential handed only to FileBrowserApi client, never returned/logged (class remarks) — FolderUploadService.ts:82-85,315-322"
    - "latest snapshots map never cleared per game — FolderUploadService.ts:99,295"

- path: app/packages/desktop-main/src/services/FolderUploadService.test.ts
  purpose: Unit tests for FolderUploadService using fake FileBrowser client and stubbed FileManager/ECS.
  exports: none
  dependencies: "FolderUploadService, FolderScanService, ElectronStoreService, SafeStorageService, folderUpload/FileBrowserClient PinMismatchError, folderUpload/ephemeralCert, ../testing/{config-service,deployment-config,stack-outputs}.fixture, ../testing/fake-filebrowser-client"
  data_shapes: "Harness { svc, client, fm, ecs, store, progress, create } (41-49)"
  side_effects: "temp dirs; mutates process.versions.electron via defineProperty (528-533)"
  role: test
  observations:
    - "Pins guards (not deployed, server running, helper open, overlapping start, destination, path traversal 'Invalid relative path', empty/expired scan, concurrent run) (100-178); run outcomes incl. 100% only after stop (193-204), resume skip, failure path in error, ECONNREFUSED resumable, verification missing, cancel mid-run/boot, pin mismatch no retry, stop reason appended, login retry, launch failure not stopping helper, credential never published (180-357); overwrite confirm/decline/timeout/own-partial resume (366-505); selection persistence + sweep ages 0 / 15 min Electron-only (507-536)"
    - "'keep the selection' test name not asserted against store — FolderUploadService.test.ts:101-106"
    - "vi.stubEnv('x','y') appears unused/no-op — FolderUploadService.test.ts:527"

- path: app/packages/desktop-main/src/services/GameWizardDraftService.ts
  purpose: Owns the single add-game wizard draft slot (addGameWizardDraft) in ElectronStoreService with shape validation, legacy backfills, and secret redaction on read.
  exports: GameWizardDraftService (get, save, updateStepIndex, clear)
  dependencies: "@hyveon/shared ADD_GAME_WIZARD_STEPS, errMessage, normalizeGameServer; ElectronStoreService (GameWizardDraft, StoredGameWizardDraft types); ../logger"
  data_shapes: "StoredGameWizardDraft { draft: GameWizardDraft, stepIndex, savedAt ISO }; DEFAULT_HEALTH_CHECK_DRAFT (248-264)"
  side_effects: "electron-store get/set/delete addGameWizardDraft (37,63,88,90,99); warn/debug logs"
  role: Nest service
  observations:
    - "get() pipeline: validate → backfillLegacyHttpsWebPort → backfillPortVisibility → backfillHealthCheck → backfillCommand → redactSecretFields — GameWizardDraftService.ts:44-46"
    - "save/updateStepIndex/clear swallow and log all errors (autosave best-effort) — GameWizardDraftService.ts:61-103"
    - "updateStepIndex exists so a resumed (redacted) draft never round-trips through save and overwrites real secrets — GameWizardDraftService.ts:69-94"
    - "Orphaned doc comment for redactSecretFields sits above DEFAULT_HEALTH_CHECK_DRAFT's own doc — GameWizardDraftService.ts:231-247"
    - "DEFAULT_HEALTH_CHECK_DRAFT 'kept in sync manually' with emptyHealthCheckDraft() in @hyveon/web wizard-form.utils.ts — duplication marker — GameWizardDraftService.ts:242-248"
    - "Class doc lists only healthCheck.secretArn redaction; code also blanks username/password/token — GameWizardDraftService.ts:14-15 vs 351-357"
    - "Legacy healthCheck without authType backfilled to 'raw' if secretSet else 'none' — GameWizardDraftService.ts:275-290"
    - "errorMessage is a one-line wrapper around errMessage — GameWizardDraftService.ts:362-365"
    - "Validator tolerates optional later-added fields (command, pinnedHostname, healthCheck, port visibility, health auth fields) — GameWizardDraftService.ts:147-154,172-185,201"

- path: app/packages/desktop-main/src/services/GameWizardDraftService.test.ts
  purpose: Unit tests for GameWizardDraftService with a stateful store stub.
  exports: none
  dependencies: "GameWizardDraftService; ElectronStoreService types; mocked ../logger"
  data_shapes: "sampleDraft GameWizardDraft fixture (26-55)"
  side_effects: none
  role: test
  observations:
    - "Pins: null on missing/malformed/throwing/out-of-range stepIndex (>=6)/bad savedAt/non-finite cpu/bad array rows (63-177); env value + file-seed content redaction (179-196); command backfill (198-208); pinnedHostname optional string (210-228); legacy https → webPort normalisation (230-263); secretArn blanked, secretSet kept (265-278); save stamps savedAt and swallows failures (281-304); clear (306-326)"
    - "No coverage for updateStepIndex, port-visibility backfill, or healthCheck username/password/token redaction"

- path: app/packages/desktop-main/src/services/GamesWriteService.ts
  purpose: Write-side orchestrator for games create/update/delete — validation, health-check credential secret lifecycle, DeploymentConfigService mutation, error→GameWriteResult mapping, cache invalidation, audit, refreshed games list.
  exports: GamesWriteService (createGame, updateGame, deleteGame)
  dependencies: "@hyveon/shared OptimisticLockError, errMessage, redactGameServer, validateGameServer + types; @hyveon/shared/gameServerValidator validateHealthCheckAuthInput; @hyveon/shared/secrets/secretsStore upsertHealthCheckAuthSecret/deleteHealthCheckAuthSecret; AuditService.record; ConfigService (invalidateCache, getStackOutputs); DeploymentConfigService (getGameServers, add/update/removeGameServer, invalidateCache, ConfigurationNotConfiguredError, GameServerEntryError); DriftService computeDriftFromOutputs; mergeGameLists"
  data_shapes: "GameWriteResult variants ok/validation/conflict/not_found/setup_incomplete/error; AUDIT_ACTION_BY_WRITE_ACTION create→add, update→edit, delete→remove (56-60); STRUCTURAL_PREVIEW_SECRET_ARN placeholder (53)"
  side_effects: "Secrets Manager upsert/delete (516,530); S3 config write via DeploymentConfigService (157,231,274); cache invalidation (314-315); AuditService.record (323-329); logs"
  role: Nest service
  observations:
    - "File doc says 'and their HTTP equivalents' though desktop app has no HTTP transport — GamesWriteService.ts:3"
    - "createGame rejects duplicate name up front before any Secrets Manager mutation — GamesWriteService.ts:130-136"
    - "Two-pass validation: structural preview with placeholder ARN, then real resolve + revalidate — GamesWriteService.ts:142-152,215-226"
    - "Secret upsert happens before the config write; an OptimisticLockError/other write failure after it leaves the secret mutated — GamesWriteService.ts:148 vs 157, 221 vs 231"
    - "upsertAppOwnedSecret rethrows a plain Error that createGame/updateGame do not catch — escapes as a throw rather than a GameWriteResult — GamesWriteService.ts:148,221,514-525"
    - "updateGame on a non-existent name still resolves (and may upsert) a credential before updateGameServer throws not_found — GamesWriteService.ts:204,221,231-237"
    - "previewResolvedHealthCheckAuth 'Mirrors resolveHealthCheckAuthSecret's branching exactly' — duplication marker — GamesWriteService.ts:394,411-433 vs 474-511"
    - "basic||bearer app-owned predicate repeated 4x — GamesWriteService.ts:288,480,494,502"
    - "Auth-input validation ordering differs: before sibling fetch in create, after in update — GamesWriteService.ts:116-121 vs 203-209"
    - "deleteGame deletes app-owned secret only after config removal succeeds; delete failures logged not thrown — GamesWriteService.ts:288-290,528-539"
    - "deleteAppOwnedSecret takes secretArn only for logging; delete keyed by gameId — GamesWriteService.ts:528-537"
    - "errorResult logs the raw err object ({ err }) rather than a normalized message — GamesWriteService.ts:383"
    - "mode: 's3' hardcoded in success log — GamesWriteService.ts:317-321"
    - "update/delete map any GameServerEntryError to not_found regardless of reason; create maps invalid/duplicate-name to validation, structural to error — GamesWriteService.ts:162-168,236-238,279-281"

- path: app/packages/desktop-main/src/services/GamesWriteService.test.ts
  purpose: Unit tests for GamesWriteService with stubbed config/deployment-config/audit and mocked secretsStore.
  exports: none
  dependencies: "vitest; @hyveon/shared OptimisticLockError; mocked @hyveon/shared/secrets/secretsStore; DeploymentConfigService errors; ../testing/{stack-outputs,config-service,deployment-config}.fixture"
  data_shapes: "makeHealthCheck/makeConfig/makeExistingGame builders (89-119)"
  side_effects: none
  role: test
  observations:
    - "Pins: success writes + both cache invalidations + merged list (145-161); redacted secretSet never ARN (163-189); audit once with before/after/versionId per action (191-206,375-391,488-503); s3-mode log line (208-214); failure mapping validation/conflict/duplicate-name/structural→error/setup_incomplete/not_found (227-354,393-456,526-567); credential lifecycle: basic create, bearer update-in-place, delete on clear/game delete, raw untouched, duplicate name never upserts, structural failure never touches Secrets Manager (570-755)"
    - "No test for upsert failure propagation or for a secret mutated before a conflicting write"

- path: app/packages/desktop-main/src/services/LockClearConfirmationGate.ts
  purpose: Generic single-slot mint/assert/consume confirmation-token gate for lock-clear operations, shared by PulumiService and RunService.
  exports: LockClearConfirmationGate<TBinding> (mint, assertFresh); type LockClearAssertResult<TBinding>
  dependencies: "node:crypto randomUUID"
  data_shapes: "PendingLockClearConfirmation { token, binding, expiresAt } (32-39); LockClearAssertResult { ok: true, binding } | { ok: false, reason: 'no-token-minted'|'token-mismatch'|'expired'|'binding-mismatch' } (49-51)"
  side_effects: none (in-memory state only)
  role: utility class (not @Injectable)
  observations:
    - "File-level doc (with @typeParam) placed above the import statement, not on the class — LockClearConfirmationGate.ts:1-29"
    - "Only the most recent mint is valid; minting supersedes any pending token — LockClearConfirmationGate.ts:82-86"
    - "Failed assert never mutates pending state; success consumes (pending=null) — LockClearConfirmationGate.ts:101-108"
    - "Check order token-mismatch before expired, so an expired wrong token reports token-mismatch; expiry uses '>' so valid at exactly expiresAt — LockClearConfirmationGate.ts:104-105"
    - "current===null always binding-mismatch — LockClearConfirmationGate.ts:106"
    - "No co-located test file in this directory"
- path: app/packages/desktop-main/src/services/GuidedIamService.ts
  purpose: First-run guided IAM bootstrap flow — renders the iam-bootstrap.yaml CloudFormation template, opens the CFN console, validates a pasted bootstrap key, rotates onto a freshly minted key, and revokes the bootstrap key.
  exports: GuidedIamService (Nest @Injectable; methods renderTemplate, buildCloudFormationConsoleUrl, openConsole, intakeBootstrapKey, rotate, revokeBootstrapKey; protected seams createStsClient, createIamClient, sleep, buildIamSecurityCredentialsConsoleUrl, readIsElectron, openExternalUrl, readIsPackaged, readUserDataPath, getRenderedTemplatePath); const GUIDED_PROFILE_NAME = 'hyveon-guided'; types RenderedTemplateResult, OpenConsoleResult, BootstrapKeyIntakeInput, BootstrapKeyIntakeResult, RotationInput, RotationResult, RevokeBootstrapKeyInput, RevokeBootstrapKeyResult
  dependencies: "@hyveon/shared (errMessage, generateHyveonDeployAllPolicy, generateHyveonSelfRotatePolicy); ../cloudformationTemplate.js (resolveCloudFormationTemplatePath); ../logger.js; ./ElectronStoreService (setPastedCredentials, deletePastedCredentials, get/set 'aws'); ./SafeStorageService (isAvailable); ./AwsProfileService (SafeStorageUnavailableError); ./awsCredentialSource (resolveAwsCredentialSource, AwsCredentialSource); ./verifyAccessKeyWithRetry; ./sleep; ./electronRuntime (readIsPackaged); external @aws-sdk/client-sts (GetCallerIdentity), @aws-sdk/client-iam (CreateAccessKey, DeleteAccessKey), electron (lazy createRequire: shell.openExternal, app.getPath('userData')), fs, @nestjs/common"
  data_shapes: "RotationResult discriminated union {status:'complete'} | {status:'verification-failed', error} | {status:'delete-failed', consoleUrl}; OpenConsoleResult {opened:true} | {opened:false,url}; RevokeBootstrapKeyResult {revoked, message?}; BootstrapKeyIntakeResult {accountId}; rendered template = YAML with two placeholder tokens replaced by single-line JSON policy docs"
  side_effects: "Filesystem read of iam-bootstrap.yaml and write of rendered copy (<userData>/iam-bootstrap-rendered.yaml packaged, <APP_ROOT>/.iam-bootstrap-dev dev); AWS STS GetCallerIdentity, IAM CreateAccessKey/DeleteAccessKey; electron-store writes (creds.aws.hyveon-guided staged, aws.profile activated, staged entry deleted on cleanup); OS browser launch via shell.openExternal; winston logs (key IDs only)"
  role: Nest service (first-run wizard backend)
  observations:
    - "Module-scope _APP_ROOT probe with two compiled shapes (out/main vs dist/services) mirrors cloudformationTemplate.ts's own resolver — comment admits duplication of the shape handling (GuidedIamService.ts:32-50)."
    - "renderTemplate uses String.replace (first occurrence only) for each placeholder token (GuidedIamService.ts:210-212)."
    - "readIsPackaged TSDoc says it returns process.resourcesPath or undefined, but signature returns boolean (GuidedIamService.ts:691-700)."
    - "History/task narrative in comments: 'Group 1', 'a later group' (GuidedIamService.ts:60, 90, 154, 233-236, 268-270, 731)."
    - "rotate step-1 CreateAccessKey errors are deliberately not caught — raw SDK errors (e.g. LimitExceededException) propagate (GuidedIamService.ts:404-412, 426)."
    - "Orphan-cleanup delete and deletePastedCredentials share one try/catch; failure swallowed with warn (GuidedIamService.ts:476-485)."
    - "Activation spreads existing aws object and overwrites profile+region (GuidedIamService.ts:490-491)."
    - "rotate logs bootstrapAccessKeyId (GuidedIamService.ts:503, 511), while revokeBootstrapKey's debug line deliberately omits it (GuidedIamService.ts:568) — inconsistent identifier-logging policy."
    - "revokeBootstrapKey refusal branches (resolve failure, wrong source kind) return without any log line (GuidedIamService.ts:572-585)."
    - "Two protected seams (readIsElectron, readUserDataPath) each say they 'mirror X exactly' — SafeStorageService.readIsElectron and CloudHealthService.readUserDataPath (GuidedIamService.ts:668-669, 708) — duplication flagged by .claude/rules/duplication.md #4."
    - "openConsole rejects non-https/unparseable URLs and never throws (GuidedIamService.ts:275-294); region validated by /^[a-z0-9-]+$/ (GuidedIamService.ts:239)."

- path: app/packages/desktop-main/src/services/GuidedIamService.test.ts
  purpose: Vitest unit tests for GuidedIamService.
  exports: none
  dependencies: "vitest, aws-sdk-client-mock (STSClient, IAMClient), mocked fs and ../cloudformationTemplate.js, @hyveon/shared policy generators, ../logger.js (spied), ./AwsProfileService SafeStorageUnavailableError; TestableGuidedIamService subclass re-exposing protected seams"
  data_shapes: "FIXTURE_TEMPLATE YAML with both placeholder tokens and '!Ref UserName'; store/safeStorage partial stubs"
  side_effects: "mutates process.versions.electron per test (restored in afterEach)"
  role: test
  observations:
    - "Pins: exact CFN console URL shape, no templateURL (GuidedIamService.test.ts:149-175); single-line substitution + UserName untouched (185-207); openConsole electron/no-electron/rejection paths (210-249); rendered path resolution (251-297); intake error propagated unchanged and secret never logged (299-360); rotate exact call order CreateAccessKey→setPastedCredentials→GetCallerIdentity→store.set→DeleteAccessKey (413-483); 6 verification attempts and backoff [1000,2000,4000,8000,8000] (541-565); orphan cleanup uses bootstrap client and targets new key (596-619); delete-failed leaves new key active (649-665); no secret in any log (674-734); revokeBootstrapKey refusal for none/profile/other-pasted/decrypt-failure and success/failure paths (736-893)."
    - "Decrypt-failure test expects message /Cannot decrypt the stored pasted-credentials entry/ — text comes from awsCredentialSource/ElectronStoreService, not this service (GuidedIamService.test.ts:813-834)."

- path: app/packages/desktop-main/src/services/IamCheckService.ts
  purpose: Wizard's best-effort IAM permission dry-run — resolves caller ARN via STS then batches iam:SimulatePrincipalPolicy across HYVEON_DEPLOY_ALL_ACTIONS, returning passed/missing/warning plus origin and blocking.
  exports: IamCheckService (Nest @Injectable; checkPermissions; protected actionsToCheck, createStsClient, createIamClient); types IamCheckStatus, IamCheckOrigin, IamCheckResult
  dependencies: "@hyveon/shared (HYVEON_DEPLOY_ALL_ACTIONS, errMessage); ./ElectronStoreService (get 'aws'); ./awsCredentialSource (resolveAwsCredentialSource, AwsCredentialSource); ./GuidedIamService (GUIDED_PROFILE_NAME); ../logger.js; external @aws-sdk/client-sts, @aws-sdk/client-iam (SimulatePrincipalPolicyCommand), @aws-sdk/credential-providers (fromIni)"
  data_shapes: "IamCheckResult {status:'passed'|'missing'|'warning', policyJson?, message?, origin:'guided'|'pasted'|'profile'|'none', blocking}; policyJson = pretty-printed {Version:'2012-10-17', Statement:[{Effect:'Allow', Action:[denied], Resource:'*'}]}"
  side_effects: "AWS STS GetCallerIdentity, IAM SimulatePrincipalPolicy (read-only); electron-store reads; winston logs"
  role: Nest service (first-run wizard backend)
  observations:
    - "Credential source + region resolved once as a snapshot to avoid mid-call store mutation (IamCheckService.ts:113-124, 129, 137)."
    - "resolveAwsCredentialSource failure returns warning with origin 'none' without logging (IamCheckService.ts:128-134)."
    - "Context entry iam:AWSServiceName=ecs.amazonaws.com sent on every batch (IamCheckService.ts:29-31, 276)."
    - "iam:CreateServiceLinkedRole and iam:GetRole simulated separately against the AWSServiceRoleForECS ARN (IamCheckService.ts:45, 160-176, 297-304)."
    - "buildPolicyJson emits Resource '*' for all denied actions, including the two resource-scoped ones — the suggested pasteable policy is broader than HyveonDeployAll's actual scoping (IamCheckService.ts:306-315)."
    - "Assumed-role STS ARN normalized to IAM role ARN, preserving partition and role path (IamCheckService.ts:248-255)."
    - "blocking is true only for missing + guided (IamCheckService.ts:196); doc references openspec/changes/add-first-run-wizard (IamCheckService.ts:98)."
    - "kind 'none' builds clients with region only → SDK default credential chain (IamCheckService.ts:352-353)."
    - "Imports GUIDED_PROFILE_NAME from GuidedIamService → service-to-service coupling on a constant (IamCheckService.ts:9)."

- path: app/packages/desktop-main/src/services/IamCheckService.test.ts
  purpose: Vitest unit tests for IamCheckService.
  exports: none
  dependencies: "vitest, aws-sdk-client-mock, mocked ../logger.js, @hyveon/shared HYVEON_DEPLOY_ALL_ACTIONS, GUIDED_PROFILE_NAME; TestableIamCheckService (custom action list) and ClientCapturingIamCheckService subclasses"
  data_shapes: "ElectronStoreService stub with get/getPastedCredentials"
  side_effects: none
  role: test
  observations:
    - "Pins: passed/missing outcomes and policyJson shape (IamCheckService.test.ts:76-110); 50-per-request batching (112-125); context entry (127-138); resource-scoped split with SLR ARN (140-159); assumed-role and GovCloud path normalization (173-199); warning degrade + log lines (201-264); snapshot consistency under concurrent rotation (281-305); origin/blocking matrix (308-460)."
    - "Final test asserts content of the shared policy (secretsmanager:* coverage for GamesWriteService health-check secret lifecycle) and never exercises IamCheckService — misplaced policy-content test (IamCheckService.test.ts:463-482)."

- path: app/packages/desktop-main/src/services/LogsService.ts
  purpose: CloudWatch Logs reader for game ECS task logs (/ecs/{game}-server) and Lambda logs (/aws/lambda/{projectName}-{functionKey}) — recent snapshots, backward/forward multi-stream paging, and live tails.
  exports: LogsService (Nest @Injectable; streamLogs, getRecentLogs, getOlderLogs, getNewerLogs, getRecentLambdaLogs, getOlderLambdaLogs, getNewerLambdaLogs, streamLambdaLogs); interfaces LogEventLine, RecentLogsPage, OlderLogsPage, NewerLogsPage
  dependencies: "@hyveon/shared (CloudProvider, LambdaFunctionKey, LogChunk, DEPLOYMENT_CONFIG_DEFAULTS, errMessage); ./ConfigService (getRegion); ./DeploymentConfigService (getTopLevelSettings); ./ElectronStoreService; ./awsCredentialSource (resolveAwsClientCredentialsWithSignature); ./awsClientCache (createCachedAwsClient); ../modules/cloud-provider.tokens.js (CLOUD_PROVIDER); ../logger.js; external @aws-sdk/client-cloudwatch-logs (DescribeLogStreams, GetLogEvents, FilterLogEvents)"
  data_shapes: "LogEventLine {message, timestamp, eventId=`${timestamp}:${message}`}; RecentLogsPage {lines}; OlderLogsPage {lines, atOldest}; NewerLogsPage {lines, hasMore}; streams yield plain strings"
  side_effects: "AWS CloudWatch Logs reads; cached CloudWatchLogsClient rebuilt on region/credential-signature change; electron-store reads (credentials); deployment-config reads (projectName); winston logs; setTimeout poll loop in streamLambdaLogs"
  role: Nest service
  observations:
    - "Local type widening CloudProviderWithPollInterval adds pollInterval to CloudProvider.streamWorkloadLogs without changing the shared interface (LogsService.ts:18-32)."
    - "streamLogs delegates to injected CLOUD_PROVIDER.streamWorkloadLogs and yields only chunk.message (LogsService.ts:199-208); streamLambdaLogs re-implements the same FilterLogEvents poll loop, comment cites 'design.md D1' as justification (LogsService.ts:705-768) — duplication.md #4 trigger."
    - "withLogGroup shared shell for six get methods: 'recent' never throws (synthetic line), 'paging' rethrows plain Error, optional notFound hook for ResourceNotFoundException (LogsService.ts:237-264)."
    - "eventId synthesis inconsistent: getRecentFromLogGroup uses `e.message ?? ''` (LogsService.ts:326) but fetchAcrossStreams uses raw `${e.message}` yielding 'undefined' for missing messages (LogsService.ts:519) — an excludeEventIds seed taken from a recent page would not match."
    - "Comment references 'fetchRange' which does not exist in the file (LogsService.ts:518)."
    - "History narrative in comments: 'Bug 1', 'pre-extraction', 'pre-dedup', 'the bug this replaced' (LogsService.ts:41, 218-219, 298-299, 478)."
    - "listStreams page limit 50 equals MAX_STREAMS_SCANNED 50, so the cap is hit on the first full page; exhausted = !nextToken at cap (LogsService.ts:148, 568, 574-576)."
    - "'newer' walks the newest-50 stream list in reverse and over-fetches by excludeEventIds.length (LogsService.ts:487, 507); exclusion is multiset-counted (LogsService.ts:479-482, 520-526)."
    - "resolveLambdaLogGroup doc says 'one of the app's 5 Lambda functions' while repo has six Lambda packages (LogsService.ts:585)."
    - "streamLambdaLogs: unbounded `seen` Set growth over a long tail (LogsService.ts:734); generic poll errors yield '[stream error]' sentinel without any logger call (LogsService.ts:762-763); post-poll setTimeout is not abort-aware, so abort latency up to pollInterval (LogsService.ts:766)."
    - "Two different no-streams messages: 'No log streams found for {label}.' (recent) vs 'No log streams found in {logGroup}.' (paging) (LogsService.ts:313, 475); withLogGroup matches only the former by exact string (LogsService.ts:256)."

- path: app/packages/desktop-main/src/services/LogsService.test.ts
  purpose: Vitest unit tests for LogsService covering game and Lambda recent/older/newer/stream paths.
  exports: none
  dependencies: "vitest, aws-sdk-client-mock (CloudWatchLogsClient), mocked ../logger.js, ./EcsService createAwsCloudProvider (real provider wired in), ../testing/stack-outputs.fixture, ../testing/config-service.fixture, ../testing/deployment-config.fixture"
  data_shapes: "streamsResponse helper; store stub get→undefined"
  side_effects: none
  role: test
  observations:
    - "Pins: /ecs/{game}-server group + newest-stream query and default limit 50 (LogsService.test.ts:93-126); error folded into synthetic line + logger.error (148-165); older paging endTime, atOldest semantics, cross-stream accumulation/trimming, early stop, scan cap, nextToken pagination (179-311); newer paging startTime inclusive, hasMore, exclusion, cross-stream eventId collision regression, oldest-stream-first ordering (313-487); streamLogs via real AwsCloudProvider: abort, dedupe, sentinel on error (489-614); Lambda group naming default 'hyveon' and custom projectName, ResourceNotFound informational line/throw/stop-polling (616-851)."
    - "Test title says 'warning-level failure via logger.error' — level wording mismatch (LogsService.test.ts:156)."
    - "makeService comment narrates a removed constructor default (LogsService.test.ts:58-66)."
    - "No test for streamLambdaLogs generic-error sentinel path or the recent→newer eventId mismatch for missing messages."
```

## Observed behaviours

- Audit writes never block the game_servers mutation: missing `auditTableName` or a `putEntry` rejection only logs a warning — app/packages/desktop-main/src/services/AuditService.ts:91-119
- Audit log page renders empty (not error) before the audit table is deployed; page size clamped to [1,100], default 25 — AuditService.ts:51-56, 132-141
- Audit actor is the local OS username (`os.userInfo().username`), not an AWS principal — AuditService.ts:104
- AWS profile discovery uses the SDK's own `parseKnownFiles` with `ignoreCache: true`, so newly added profiles show without restart; only `profileName`/`region` leave the service — AwsProfileService.ts:164-169, 444-451
- Pasted AWS keys are refused (SafeStorageUnavailableError) when the OS keychain is unavailable — never stored in plaintext — AwsProfileService.ts:181-184
- Key rotation is gated on keychain availability and `kind: 'pasted'` before any AWS call; the new key is verified via STS with retries before the store is overwritten; orphaned new key is deleted on verify failure; old-key delete failure returns `delete-failed` with an IAM console URL and the new key stays active — AwsProfileService.ts:267-368
- Bootstrap provisions state/config buckets via the S3 SDK directly (not Pulumi) with versioning, AES256, all four public-access-block flags, re-applied on the already-exists path — BootstrapService.ts:123-169, 673-687
- Config bucket gets a 90-day noncurrent-version expiration lifecycle rule — BootstrapService.ts:36, 212-228
- `deployment-config.json` is seeded only when HeadObject returns a genuine not-found; any other HeadObject error fails the step rather than risk overwrite — BootstrapService.ts:313-366
- Run-history DynamoDB table (pk/sk, status-index GSI, PAY_PER_REQUEST, Project=hyveon tag) is created by Bootstrap, not Pulumi, waits up to 60s for ACTIVE, then enables PITR with retries on ContinuousBackupsUnavailableException — BootstrapService.ts:46, 58, 408-490, 500-547
- In us-east-1 a HeadBucket pre-check avoids CreateBucket's 200-OK ACL-reset behaviour; LocationConstraint omitted for us-east-1 — BootstrapService.ts:604-621
- Bootstrap credential resolution: pasted creds win, else `fromIni(profile)`, else default chain; missing `aws.region` throws BootstrapCredentialsNotConfiguredError — BootstrapService.ts:705-723
- The S3 configuration bucket is the only deployment-config source; with no bucket, every read/write except getGameServers throws ConfigurationNotConfiguredError before touching the store — DeploymentConfigService.ts:563-567, :620-623.
- getGameServers never rejects: failures resolve to `[]` and are negatively cached for `readEnvConfigCacheTtlMs()` — DeploymentConfigService.ts:300-333.
- Config writes are conditional S3 puts with `ifMatch` = last-read etag; a conflict surfaces only as OptimisticLockError — DeploymentConfigService.ts:616-639.
- Every write invalidates the gameServers cache; a generation counter blocks stale in-flight reads from repopulating it — DeploymentConfigService.ts:267-270, :309-316, :597.
- projectName/runsTableName become effectively immutable once the bootstrap runs: a change that alters the resolved runs-table name throws RunsTableRenameError (settings patch and rollback restore) — DeploymentConfigService.ts:756-779, :385.
- The settings patch can never modify gameServers, even when a `gameServers` key arrives over IPC — DeploymentConfigService.ts:731-739.
- New game names must match GAME_NAME_PATTERN (DNS-safe); existing legacy names are never revalidated on update/remove — DeploymentConfigService.ts:207-215, :664-665; DeploymentConfigService.write.test.ts:426-479.
- Legacy https entries are normalised at read time only (ports[0] becomes webPort) — DeploymentConfigService.ts:828-835.
- Persisted config is pretty-printed JSON with a trailing newline under the fixed CONFIGURATION_OBJECT_KEY — DeploymentConfigService.ts:569, :787-789.
- The diagnostics bundle is best-effort per section, written atomically through a uuid temp file and rename; failure messages are scrubbed of secrets — DiagnosticsBundleService.ts:108-152, :232-273.
- The log tail reads at most 200KB from the end of today's `main-YYYY-MM-DD.log` and merges multi-line metadata into single entries — DiagnosticsService.ts:9, :86-93, :109-138.
- Renderer console batches are capped at 200 entries; level lookup is safe against prototype keys and falls back to debug — DiagnosticsService.ts:16, :26-34, :173-186.
- Drift only compares image/cpu/memory/ports(+webPort)/volumes; changes to env, command, healthCheck, https, pinnedHostname never surface as drift — app/packages/desktop-main/src/services/DriftService.ts:13-20
- Drift deployed-set falls back to `outputs.gameNames` when `appliedGameServers` is absent — app/packages/desktop-main/src/services/DriftService.ts:167-171
- getDrift invalidates only the deployment-config cache, never the stack-outputs cache (30s poll cost) — app/packages/desktop-main/src/services/DriftService.ts:206-212
- EC2/ECS SDK clients are rebuilt when region or credentials signature changes (credential rotation without restart) — app/packages/desktop-main/src/services/EcsService.ts:212-216, app/packages/desktop-main/src/services/Ec2Service.ts:40-44
- AwsCloudProvider config targets the deployed stack's region, while raw EcsService/Ec2Service clients use the wizard region — app/packages/desktop-main/src/services/EcsService.ts:71 vs :213
- Game start/stop/status go through the CLOUD_PROVIDER-injected CloudProvider; guard refusals logged warn and returned as `{success:false}` with unprefixed message — app/packages/desktop-main/src/services/EcsService.ts:260-321
- RunTask failure logging omits params to avoid leaking containerOverrides env secrets — app/packages/desktop-main/src/services/EcsService.ts:382-391
- Prefix task listing pages through all RUNNING tasks and describes in batches of 100, throwing on failure — app/packages/desktop-main/src/services/EcsService.ts:473-498
- Duplicate SG ingress rule is treated as success — app/packages/desktop-main/src/services/Ec2Service.ts:108-111
- Secret store fields (aws keys, pasted creds, legacy passphrase) are encrypted via SafeStorageService; outside Electron the store is an in-memory Map — app/packages/desktop-main/src/services/ElectronStoreService.ts:303-316, 397-477
- Pulumi lock attempts recorded with randomUUID run id + OS username/hostname before engine runs, cleared on normal completion — app/packages/desktop-main/src/services/ElectronStoreService.ts:559-587
- FileBrowser helper is a per-launch throwaway task def (`filebrowser-{game}`, 256/512, `:latest` image) tagged `startedBy=filemgr-{game}` — app/packages/desktop-main/src/services/FileManagerService.ts:17-19, 418-483
- Wizard resume file corruption/missing always degrades to step `pick-cloud`, never throws — app/packages/desktop-main/src/services/FirstRunWizardService.ts:68-79
- Wizard completion clears `wizard-state.json` before setting `wizardCompleted: true` (failure leaves wizard incomplete) — app/packages/desktop-main/src/services/FirstRunWizardService.ts:175-179
- Wizard reset deletes `activeCloud`/`aws`/`bootstrap`/`creds`, sets `wizardCompleted=false`, never touches `pulumi.*` — app/packages/desktop-main/src/services/FirstRunWizardService.ts:200-208
- Folder scans are held in main (max 8, FIFO eviction); renderer only sees `scanId` and `rootName`, never the absolute path — app/packages/desktop-main/src/services/FolderScanService.ts:19,60-64
- Symlinks are skipped and counted during scan; contents never read — app/packages/desktop-main/src/services/FolderScanService.ts:88-89
- Folder upload refuses if the game isn't deployed (no efsAccessPoint), server task is running, or a file-manager helper is already open — app/packages/desktop-main/src/services/FolderUploadService.ts:238-265
- Upload pauses in `awaiting-confirmation` before writing anything when files would be overwritten; 10-min unanswered timeout cancels — app/packages/desktop-main/src/services/FolderUploadService.ts:90,361-412
- Helper task is always stopped in `finally` (revoking the operator-IP rule), only if this run launched it — app/packages/desktop-main/src/services/FolderUploadService.ts:345-347,431-444
- Startup sweep stops stray helpers older than 15 minutes, Electron only; manual cleanup sweeps with age 0 — app/packages/desktop-main/src/services/FolderUploadService.ts:43,113-118,181-183
- Certificate-pin mismatch on helper login fails closed with no retry — app/packages/desktop-main/src/services/FolderUploadService.ts:478-490
- Add-game draft reads blank `environment[].value`, `file_seeds[].content/content_base64`, and health-check `secretArn/username/password/token` before reaching the renderer — app/packages/desktop-main/src/services/GameWizardDraftService.ts:344-360
- Duplicate-name createGame is rejected before any Secrets Manager mutation — app/packages/desktop-main/src/services/GamesWriteService.ts:130-136
- Guided rotation order is fixed: CreateAccessKey (bootstrap creds) → stage under `hyveon-guided` → verify new key via STS with retry → activate `aws.profile` → DeleteAccessKey of bootstrap key using the new key — app/packages/desktop-main/src/services/GuidedIamService.ts:414-514.
- Rotation refuses to start (throws SafeStorageUnavailableError) when the OS keychain is unavailable; no AWS call or store write happens — GuidedIamService.ts:416-418.
- New-key verification tries 6 times with sleeps [1000,2000,4000,8000,8000] ms (via verifyAccessKeyWithRetry); on exhaustion the orphan new key is deleted with the bootstrap client and the staged entry cleared — GuidedIamService.ts:446-487; GuidedIamService.test.ts:541-565.
- delete-failed leaves the new key active and returns an account-agnostic IAM console URL `https://console.aws.amazon.com/iam/home#/security_credentials` — GuidedIamService.ts:496-507, 660-662.
- revokeBootstrapKey only acts when the active source is `kind:'pasted'` with profile `hyveon-guided`; every other shape returns `{revoked:false,message}` without throwing — GuidedIamService.ts:567-602.
- Rendered IAM template is written to `<userData>/iam-bootstrap-rendered.yaml` when packaged, else `<APP_ROOT>/.iam-bootstrap-dev` — GuidedIamService.ts:733-742.
- Policy documents are substituted as single-line JSON so the YAML stays valid; UserName stays a CFN parameter — GuidedIamService.ts:210-212.
- openConsole returns `{opened:false,url}` (never throws) for non-https URLs, non-Electron runtime, or shell.openExternal rejection — GuidedIamService.ts:275-294.
- IAM dry-run resolves credential source and region once per call and threads that snapshot through STS, IAM, and origin classification — IamCheckService.ts:125-198.
- Dry-run never errors: STS/IAM/source-resolution/no-region failures all degrade to `status:'warning', blocking:false` — IamCheckService.ts:128-157, 177-184.
- `blocking` is true only when status is `missing` and origin is `guided` — IamCheckService.ts:192-197.
- SimulatePrincipalPolicy is batched at 50 actions, always carries `iam:AWSServiceName=ecs.amazonaws.com`, and resource-scoped SLR actions are simulated against `arn:<partition>:iam::<acct>:role/aws-service-role/ecs.amazonaws.com/AWSServiceRoleForECS` — IamCheckService.ts:15, 29-31, 160-176, 297-304.

## Cross-scope references

- `@hyveon/shared`: `buildAuditSk`, `AuditEntry`/`AuditLogStore`/`AuditPageResult`/`RedactedGameServer`, `errMessage`, `CONFIGURATION_OBJECT_KEY`, `withDeploymentConfigDefaults`, `DEPLOYMENT_CONFIG_DEFAULTS`, `generateHyveonDeployAllPolicy`, `StackOutputs`
- `@hyveon/cloud-aws`: `FARGATE_VCPU_PER_HOUR`, `FARGATE_GB_PER_HOUR` (CostService); `AwsAuditLogStore` is the concrete AuditLogStore (per AuditService.test.ts doc)
- `app/packages/desktop-main/src/modules/cloud-provider.tokens.ts` `AUDIT_LOG_STORE`; `cloud-provider.module.ts` calls `ConfigService.getActiveCloud()`/`getRegion()`
- Sibling services outside this part: `ElectronStoreService` (get, setPastedCredentials, getPastedCredentials), `SafeStorageService`, `PulumiService.getStackOutputs`, `DeploymentConfigService.getTopLevelSettings` (and it reads `ConfigService.readEnvConfigCacheTtlMs`), `GuidedIamService` (`OpenConsoleResult` type; mirrored helpers), `IamCheckService` (doc reference to `rotateActiveCredentials`), `RunRecordService` (depends on table from `ensureRunsTable`)
- Helpers: `./awsCredentialSource` (`resolveAwsCredentialSource`, `resolveAwsClientCredentialsWithSignature`), `./verifyAccessKeyWithRetry`, `./sleep`, `./electronRuntime` (`readIsPackaged`, `readResourcesPath`), `../logger`
- Controllers: `controllers/wizard.controller.ts` (ensureDeploymentConfig, ensureRunsTable with `resolveRunsTableName(DEPLOYMENT_CONFIG_DEFAULTS.projectName, '')`), `controllers/cloud-health.controller.ts` (writePolicyToDisk, `cloudHealth.openPolicyConsole`), `controllers/costs.controller.ts` (estimateForSpec, defaults cpu 2048/mem 8192), `controllers/audit.controller.ts`
- Renderer/preload: `desktop-preload/src/hyveon-api.ts:118` duplicate `CostEstimates`; `web` first-run wizard bootstrap step (`first-run-wizard.component.tsx` runBootstrap, `use-bootstrap-resources.hook.ts`) invokes bootstrap concurrently
- Infra: `app/packages/infra/src/dynamodb.ts` documents the runs-table schema Bootstrap creates and the audit table AuditService reads
- Test fixtures: `../testing/stack-outputs.fixture`, `../testing/config-service.fixture`, `../testing/deployment-config.fixture`, `./__fixtures__/aws-profile`
- External libs: `@aws-sdk/client-s3`, `client-dynamodb`, `client-iam`, `client-sts`, `credential-providers`, `@smithy/shared-ini-file-loader`, `aws-sdk-client-mock`, `electron` (lazy require)
- `@hyveon/shared`: CONFIGURATION_OBJECT_KEY, DEPLOYMENT_CONFIG_DEFAULTS, withDeploymentConfigDefaults, normalizeGameServer, GAME_NAME_PATTERN(+_DESCRIPTION) (gameServerValidator.ts), resolveRunsTableName, OptimisticLockError, RemoteFileConflictError, RemoteFileStore, DiscordConfigStore, SecretsStore, COMMAND_DESCRIPTORS (shared/src/commands.ts), asStringArray, isSafeGameKey, errMessage, RendererLogEntry/RendererConsoleLevel, GameStatus, StackOutputs.
- `app/packages/desktop-main/src/modules/cloud-provider.tokens.ts`: REMOTE_FILE_STORE, SECRETS_STORE, DISCORD_CONFIG_STORE (bound by CloudProviderModule).
- `@hyveon/cloud-aws`: AwsRemoteFileStore (used directly in s3/freshInstall tests); AwsDiscordConfigStore/AwsSecretsStore named as production bindings.
- `app/packages/desktop-main/src/logger.ts` (winston; devPrintf meta format that DiagnosticsService parses), `app-version.ts` readAppVersion.
- `app/packages/desktop-main/src/testing/`: config-service.fixture (configServiceStub), stack-outputs.fixture, deployment-config.fixture (deploymentConfigStub).
- In-scope consumers named in docs: GamesWriteService (GameServerEntryError reasons), IacSettingsController.update (RunsTableRenameError mapping), WizardController.bootstrapRunsTable, BootstrapService.ensureRunsTable/ensureDeploymentConfig, RunRecordService, DiagnosticsController, GamesController.listStatus, AuditService.record, discord.controller.
- Renderer: `deployment-settings-form.component.tsx` (messagesForField per-field issues).
- Lambdas: interactions/followup Lambdas read the same Discord DDB row/secrets through `@hyveon/shared`.
- External: Discord REST API v10 (discord.com), S3 (via RemoteFileStore), DynamoDB, Secrets Manager, ECS (via EcsService), archiver, unzipper (tests), aws-sdk-client-mock (tests).
- OpenSpec references: desktop-only-operator-surface, pulumi-infra-program, changes/add-diagnostics-export.
- `@hyveon/shared`: `normalizeGameServer`, `errMessage`, `DriftReport`/`DriftEntry`/`DriftChangedField`, `GameServer`, `StackOutputs`, `resolveEniPublicIp`, `getTaskEniId`, `CloudProvider`, `SecretsStore`, `fileManagerLogGroupName`; `@hyveon/shared/folderUpload` (`FolderUploadStoredState`, `FolderUploadLastRun`, `StrayHelperReport`); `@hyveon/shared/drift.ts` contract referenced in DriftService doc.
- `@hyveon/cloud-aws`: `AwsCloudProvider`, `WorkloadGuardError`, `WorkloadLaunchError`, `AwsCloudProviderConfig`, `AwsCloudProviderLogger` (EcsService builds the shared provider via `createAwsCloudProvider`).
- `../modules/cloud-provider.tokens.js`: `CLOUD_PROVIDER`, `SECRETS_STORE`; `AwsModule` / `CloudProviderModule` `useFactory` reuse `buildProviderConfig`/`createAwsCloudProvider`/`awsCloudProviderLogger`.
- `../logger.js` (winston logger) used by all five services.
- `../testing/*.fixture.js` (`stackOutputs`, `configServiceStub`, `gameServer`, `deploymentConfigStub`) in tests.
- `@hyveon/web` `add-game-wizard/wizard-form.utils.ts` `WizardDraft` — manually mirrored by `GameWizardDraft` in ElectronStoreService.
- Renderer `PendingChangesBanner` 30s drift poll (named in DriftService doc) — consumer of getDrift via an IPC controller.
- `updater.ts` / `IacSettingsController` (`iac.settings.autoUpdate.*`) read `enableAutoUpdate`; `WizardController.saveCredentials`, `AwsProfileService`, `PulumiService`, `PulumiWorkspaceService`, `PulumiLockRecovery.classifyStackLockConflict`, `GameWizardDraftService` consume ElectronStoreService APIs.
- Lambda `@hyveon/lambda-update-dns` handles DNS on RUNNING/STOPPED (EcsService start/stop rely on it); watchdog Lambda only covers `{game}-server`, hence the FileBrowser schedule.
- `app/packages/infra/src/ecs.ts` owns `{game}-server` task defs; infra pre-creates the FileBrowser log group, file-manager SG, scheduler role, and `fileBrowserCredentialSecretArn` (stack outputs consumed).
- External: AWS ECS, EC2, Secrets Manager (via SecretsStore), EventBridge Scheduler (via SchedulerService), Electron safeStorage (via SafeStorageService), electron-store, bcryptjs.
- `folderUpload/` subdirectory (other worker): `FileBrowserClientFactory`, `PinMismatchError`, `FileBrowserApi` (folderUpload/FileBrowserClient.ts); `ProgressAggregator`; `uploadEngine` exports `abortableSleep`, `classifyUpload`, `ConfirmationTimeoutError`, `DEFAULT_ENGINE_OPTIONS`, `ensureDirs`, `listPlannedDirs`, `remoteSizesOf`, `uploadAll`, `UploadCancelledError`, `verifyUpload`; `ephemeralCert.generateEphemeralCert` (tests) — FolderUploadService.ts:25-40
- `@hyveon/shared`: `WIZARD_STEPS`, `ADD_GAME_WIZARD_STEPS`, `normalizeGameServer`, `errMessage`, `validateGameServer`, `redactGameServer`, `OptimisticLockError`; `@hyveon/shared/folderUpload` (`planUpload`, `toRemotePath`, `validateDestination`, types); `@hyveon/shared/gameServerValidator.validateHealthCheckAuthInput`; `@hyveon/shared/secrets/secretsStore.upsertHealthCheckAuthSecret/deleteHealthCheckAuthSecret`
- Sibling services (same dir, other parts): `ElectronStoreService` (wizard keys, `addGameWizardDraft`, folder-upload state methods), `ConfigService` (`getStackOutputs`, `invalidateCache`, `readUserDataPath` mirrored), `DeploymentConfigService` (game-server CRUD, `ConfigurationNotConfiguredError`, `GameServerEntryError`), `EcsService.findRunningTask`, `FileManagerService` (helper lifecycle, `UploadHelperSession`), `AuditService.record`, `DriftService.computeDriftFromOutputs`, `mergeGameLists`, `SafeStorageService` (tests), `PulumiService` + `RunService` (consumers of `LockClearConfirmationGate`), `PulumiWorkspaceService` (passphrase migration referenced in reset doc)
- Callers: `controllers/wizard.controller.ts` (FirstRunWizardService, GameWizardDraftService), `controllers/games.controller.ts` (GamesWriteService), `controllers/folder-upload.controller.ts` (FolderUploadService/FolderScanService), `controllers/iac-settings.controller.ts`, `modules/wizard.module.ts`, `modules/folder-upload.module.ts`, `app.module.ts`
- `@hyveon/web` `wizard-form.utils.ts` `emptyHealthCheckDraft()` / `WIZARD_STEPS` — manually mirrored by `DEFAULT_HEALTH_CHECK_DRAFT` — GameWizardDraftService.ts:242-248
- Test fixtures: `../testing/config-service.fixture`, `deployment-config.fixture`, `stack-outputs.fixture`, `fake-filebrowser-client`, `fake-filebrowser-server`
- `../logger` (winston) used by all services
- `@hyveon/shared`: `generateHyveonDeployAllPolicy`, `generateHyveonSelfRotatePolicy`, `HYVEON_DEPLOY_ALL_ACTIONS` (iamPolicy.ts; `HyveonServiceLinkedRoles` statement referenced in comments), `errMessage`, `DEPLOYMENT_CONFIG_DEFAULTS`, `CloudProvider`, `LogChunk`, `LambdaFunctionKey`.
- `app/packages/desktop-main/src/cloudformationTemplate.ts` — `resolveCloudFormationTemplatePath` (locates `iam-bootstrap.yaml` in packaged resources or dev tree).
- `app/packages/desktop-main/src/logger.ts` — winston `logger`.
- `app/packages/desktop-main/src/modules/cloud-provider.tokens.ts` — `CLOUD_PROVIDER` DI token, bound by `CloudProviderModule`; at runtime resolves to `@hyveon/cloud-aws` `AwsCloudProvider.streamWorkloadLogs`.
- `app/packages/desktop-main/src/testing/*.fixture.ts` — `stackOutputs`, `configServiceStub`, `deploymentConfigStub` (used by LogsService.test.ts).
- Sibling services outside this part's file list (same directory, other parts): `ElectronStoreService`, `SafeStorageService`, `AwsProfileService` (`SafeStorageUnavailableError`, `DEFAULT_PASTED_PROFILE_NAME`, `rotateActiveCredentials`), `awsCredentialSource` (`resolveAwsCredentialSource`, `resolveAwsClientCredentialsWithSignature`, `AwsPastedCredentialDecryptError`), `awsClientCache.createCachedAwsClient`, `verifyAccessKeyWithRetry`, `sleep`, `electronRuntime.readIsPackaged`, `ConfigService.getRegion`, `DeploymentConfigService.getTopLevelSettings`, `EcsService.createAwsCloudProvider`/`getClient`, `CloudHealthService.readUserDataPath`/`getProjectName`, `GamesWriteService` (health-check secret lifecycle cited in IamCheckService.test.ts).
- Renderer: `useLogTail` hook in `@hyveon/web` consumes `LogEventLine`/page shapes for scroll-backfill paging (LogsService.ts:37).
- Callers (not read here): wizard IPC controller(s) in `app/packages/desktop-main/src/controllers/` drive GuidedIamService/IamCheckService; logs controller drives LogsService.
- Infra: `app/packages/infra/src/lambdas.ts` (conditional `health-check` Lambda whose log group may not exist) and the Pulumi-provisioned `/ecs/{game}-server` log groups.
- Docs/specs: `openspec/changes/add-first-run-wizard` ("IAM permission simulation"), `docs/docs/setup.md` (HyveonDeployAll), a design.md "D1"/"D6" and "scroll-backfill forward-cursor fix" referenced in comments.
- AWS: STS, IAM, CloudWatch Logs APIs; CloudFormation console; electron `shell.openExternal`, `app.getPath('userData')`.
