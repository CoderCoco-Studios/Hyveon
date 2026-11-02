# Arrow: program

The description of every AWS resource Hyveon creates (network, cluster, task definitions, Lambdas, tables, DNS for Discord) and the stack outputs it hands back to the app.

## Status

**MAPPED** — mapped 2026-10-30 (git SHA `5c55a380`), not yet audited.

Inline Pulumi program in `@hyveon/infra` is well-tested per module, but the conditional health-check Lambda is deployed without an env var its handler requires at init, and several specs and doc comments have drifted from the code.

## References

### HLD
- `docs/high-level-design.md`
- `docs/intent/iac/iac-design.md` (sub-HLD)

### LLD
- `docs/intent/iac/program/program-design.md`

### EARS
- `docs/intent/iac/program/program-specs.md` (133 specs)

### Tests
- `app/packages/infra/src/discordDomain.test.ts`
- `app/packages/infra/src/dynamodb.test.ts`
- `app/packages/infra/src/ecs.test.ts`
- `app/packages/infra/src/efs.test.ts`
- `app/packages/infra/src/envTokenWrapper.test.ts`
- `app/packages/infra/src/escapes.test.ts`
- `app/packages/infra/src/hostedZoneName.test.ts`
- `app/packages/infra/src/hostnameShim.test.ts`
- `app/packages/infra/src/iam.test.ts`
- `app/packages/infra/src/index.test.ts`
- `app/packages/infra/src/lambdas.test.ts`
- `app/packages/infra/src/network.test.ts`
- `app/packages/infra/src/program.test.ts`
- `app/packages/infra/src/route53.test.ts`
- `app/packages/infra/src/secrets.test.ts`
- `app/packages/infra/src/securityGroups.test.ts`
- `app/packages/shared/src/env.test.ts`
- `app/packages/shared/src/envJson.test.ts`

### Code

**infra** (`@hyveon/infra`)
- `app/packages/infra/package.json`
- `app/packages/infra/tsconfig.json`
- `app/packages/infra/src/index.ts`
- `app/packages/infra/src/program.ts`
- `app/packages/infra/src/network.ts`
- `app/packages/infra/src/securityGroups.ts`
- `app/packages/infra/src/iam.ts`
- `app/packages/infra/src/efs.ts`
- `app/packages/infra/src/ecs.ts`
- `app/packages/infra/src/envTokenWrapper.ts`
- `app/packages/infra/src/hostnameShim.ts`
- `app/packages/infra/src/logGroups.ts`
- `app/packages/infra/src/lambdas.ts`
- `app/packages/infra/src/dynamodb.ts`
- `app/packages/infra/src/secrets.ts`
- `app/packages/infra/src/escapes.ts`
- `app/packages/infra/src/route53.ts`
- `app/packages/infra/src/discordDomain.ts`
- `app/packages/infra/src/hostedZoneName.ts`
- `app/packages/infra/src/testing/fixtures.ts`
- `app/packages/infra/src/testing/pulumiMocks.ts`

**lambda** (build plumbing)
- `app/packages/lambda/buildLambda.mjs`
- `app/packages/lambda/tsconfig.lambda.json`

**shared** (`@hyveon/shared`)
- `app/packages/shared/src/stackOutputs.ts`
- `app/packages/shared/src/env.ts`
- `app/packages/shared/src/envJson.ts`

**desktop-main**
- `app/packages/desktop-main/src/testing/stack-outputs.fixture.ts`

### Cited from other leaves
- `iac/engine`: `app/packages/desktop-main/src/services/PulumiService.ts` (calls `createInfraProgram` at `:1619`, `:2278` and supplies `lambdaBundlesDir`), `app/packages/desktop-main/src/services/ConfigService.ts` (caches `StackOutputs`).
- `deployment-config`: `app/packages/shared/src/deploymentConfig.ts` (the `DeploymentConfig` the program consumes, `resolveRunsTableName`), `DeploymentConfigService` read-time normaliser that `ecs.ts:140-145` relies on for `webPort`.
- `game-server`: `app/packages/shared/src/gameServerConfig.ts`, `gameServerPorts.ts` (`ingressPorts`, `isIcmpProtocol`), `envTokens.ts` (token catalogue used by `ecs.ts` and `envTokenWrapper.ts`).
- `operator-app/wizard-and-bootstrap`: `BootstrapService.ensureRunsTable` (runs table is created outside Pulumi; schema documented in `dynamodb.ts:6-28`).
- `helper-task`: `app/packages/lambda/efs-seeder/**` (invoked synchronously by `escapes.ts`), `FileManagerService` (registers FileBrowser task definitions at runtime against log groups and SGs declared here).
- `discord-bot`, `game-runtime/task-and-dns`, `game-runtime/watchdog`, `game-runtime/health-check`: the Lambda handlers whose env, roles and triggers `lambdas.ts`/`iam.ts`/`securityGroups.ts` declare.

### OpenSpec sources
- `pulumi-infra-program` (program half; config-persistence requirement is carried with `deployment-config`).
- `lambda-runtime-currency`.
- `in-task-tls-termination` (infra half; DNS lifecycle half sits with `game-runtime/task-and-dns`).
- Active changes touching this leaf (primary owner elsewhere): `add-pluggable-health-checks` (shipped + synced, unarchived; its `lambda-runtime-currency` delta must not be re-applied), `add-scripted-health-checks` (not started), `add-icmp-ingress` (shipped + synced, unarchived; `securityGroups.ts`), `https-explicit-web-port` (shipped + synced, unarchived; Caddy and SG), `add-pinned-hostname` (shipped, not synced; `hostnameShim.ts`), `add-vpc-flow-logs` (not started; would add a flow log and IAM role here), `embed-file-browser` (shipped, synced and archived at `5c55a380`; added the `efsVolumeAccessPoints` output).

## Architecture

**Purpose:** A single in-process Pulumi Automation API inline program that turns one `DeploymentConfig` into every AWS resource Hyveon owns, and returns the `StackOutputs` the desktop app reads to find them. It does not run anything itself; `iac/engine` and `iac/run` drive it.

**Key Components:**
1. `app/packages/infra/src/program.ts`: composition root. `createInfraProgram` (`:556`) returns the `PulumiFn`; `defineAll` (`:155`) calls every definer in a load-bearing order with a regional provider plus a `us-east-1` provider used only for the Discord ACM certificate; `buildStackOutputs` (`:475`) maps resources to outputs.
2. `app/packages/infra/src/network.ts` and `app/packages/infra/src/securityGroups.ts`: VPC with two public subnets and no NAT, and the game-servers, file-manager, EFS, efs-seeder and conditional health-check security groups, including visibility, ICMP and HTTPS 443/80 rules (`securityGroups.ts:269-279`).
3. `app/packages/infra/src/iam.ts`: task-execution role, per-Lambda roles, per-game seeder roles, FileBrowser scheduler role and conditional health-check role, split into `defineIamRoles` and `defineIamPolicies` so policies can reference function ARNs declared later.
4. `app/packages/infra/src/ecs.ts` (with `envTokenWrapper.ts`, `hostnameShim.ts`): the ECS cluster, `/ecs/{game}-server` and FileBrowser log groups, and one `{game}-server` Fargate task definition per game with the optional Caddy sidecar, ipv4 boot wrapper and pinned-hostname init container. Never declares an ECS Service.
5. `app/packages/infra/src/efs.ts`: shared EFS file system, mount targets, one access point per `(game, volume)` and a `{game}-certs` access point per HTTPS game.
6. `app/packages/infra/src/lambdas.ts`: four always-on Lambdas (interactions, followup, watchdog, dns-updater), the conditional health-check Lambda and per-game efs-seeder Lambdas, their env maps (`GAME_PORTS`, `CONNECT_MESSAGES`, `HEALTH_CHECKS`), the interactions Function URL and the EventBridge rules. Runtime pinned at `LAMBDA_RUNTIME` (`:58`).
7. `app/packages/infra/src/dynamodb.ts`, `secrets.ts`, `escapes.ts`: Discord and audit tables, placeholder secrets with create-only values, the BASE#/CONFIG# Discord seed rows and synchronous efs-seeder invocations during apply.
8. `app/packages/infra/src/route53.ts` and `app/packages/infra/src/discordDomain.ts`: hosted-zone lookup only for games; the `discord.{zone}` ACM certificate, CloudFront distribution and A/AAAA aliases in front of the interactions Function URL.
9. `app/packages/shared/src/stackOutputs.ts`: the typed `StackOutputs` contract read by every outputs consumer; `app/packages/desktop-main/src/testing/stack-outputs.fixture.ts` is the shared test double.
10. `app/packages/shared/src/env.ts`, `app/packages/shared/src/envJson.ts`: the Lambda-side parsers (`requireEnv`, `gameNamesFromEnv`, `parseGameMapEnv`, `familyToGameMap`, `parseJsonEnv`) for the env wire format this program bakes.
11. `lambda/buildLambda.mjs`: shared esbuild bundler producing `dist/handler.cjs` (CJS, `node24`) that `lambdas.ts:230-242` zips.

## Spec Coverage

| OpenSpec capability | requirements | scenarios | notes |
|---|---|---|---|
| `pulumi-infra-program` | 7 | 26 | Program half. "Configuration persisted as versioned JSON" (4 scenarios) is `deployment-config` behaviour. Passphrase "machine-bound" wording contradicts `pulumi-engine-runtime` (owned by `iac/engine`). Preservation-test scenario only partly met (finding 6). |
| `lambda-runtime-currency` | 3 | 5 | Lists efs-seeder as always-provisioned; code makes it per-game conditional (finding 4). Scenario expects `target` in each `esbuild.config.mjs`; it lives in `buildLambda.mjs:20`. |
| `in-task-tls-termination` | 6 | 14 | Infra half (sidecar, cert AP, SG, no ELB/ACM). "version-pinned" Caddy image not met (finding 3); "no ACM certificate" sits awkwardly with the Discord ACM cert (finding 5). |

**OpenSpec summary:** 16 requirements and 45 scenarios carried across 3 capabilities.

| Category | Spec IDs | Implemented | Deferred | Gaps |
|---|---|---|---|---|
| Workspace and Packaging | `IAC-PROGRAM-WS-001` to `IAC-PROGRAM-WS-006` | 5 | 0 | 1 |
| Composition and Providers | `IAC-PROGRAM-COMP-001` to `IAC-PROGRAM-COMP-005` | 5 | 0 | 0 |
| Per-Game Fan-Out | `IAC-PROGRAM-FANOUT-001` to `IAC-PROGRAM-FANOUT-004` | 4 | 0 | 0 |
| Network | `IAC-PROGRAM-NET-001` to `IAC-PROGRAM-NET-002` | 2 | 0 | 0 |
| Security Groups | `IAC-PROGRAM-SG-001` to `IAC-PROGRAM-SG-013` | 13 | 0 | 0 |
| IAM | `IAC-PROGRAM-IAM-001` to `IAC-PROGRAM-IAM-010` | 10 | 0 | 0 |
| EFS | `IAC-PROGRAM-EFS-001` to `IAC-PROGRAM-EFS-004` | 3 | 0 | 1 |
| ECS Task Definitions | `IAC-PROGRAM-ECS-001` to `IAC-PROGRAM-ECS-008` | 8 | 0 | 0 |
| In-Task TLS (Caddy Sidecar) | `IAC-PROGRAM-TLS-001` to `IAC-PROGRAM-TLS-010` | 9 | 0 | 1 |
| Environment Tokens and Boot Wrapper | `IAC-PROGRAM-TOKEN-001` to `IAC-PROGRAM-TOKEN-007` | 6 | 0 | 1 |
| Pinned Hostname | `IAC-PROGRAM-HOST-001` to `IAC-PROGRAM-HOST-008` | 8 | 0 | 0 |
| Lambda Wiring | `IAC-PROGRAM-LAMBDA-001` to `IAC-PROGRAM-LAMBDA-016` | 13 | 0 | 3 |
| Lambda Environment Wire Format | `IAC-PROGRAM-ENV-001` to `IAC-PROGRAM-ENV-007` | 7 | 0 | 0 |
| Data Tables and Discord Seed Rows | `IAC-PROGRAM-DATA-001` to `IAC-PROGRAM-DATA-005` | 5 | 0 | 0 |
| Secrets | `IAC-PROGRAM-SECRET-001` to `IAC-PROGRAM-SECRET-005` | 4 | 0 | 1 |
| DNS and Discord Domain | `IAC-PROGRAM-DNS-001` to `IAC-PROGRAM-DNS-004` | 3 | 0 | 1 |
| Stack Outputs | `IAC-PROGRAM-OUT-001` to `IAC-PROGRAM-OUT-008` | 8 | 0 | 0 |
| EFS Seeding During Apply | `IAC-PROGRAM-SEED-001` to `IAC-PROGRAM-SEED-005` | 3 | 0 | 2 |
| Lambda Runtime and Bundling | `IAC-PROGRAM-RUNTIME-001` to `IAC-PROGRAM-RUNTIME-006` | 4 | 0 | 2 |

**Summary:** 120 of 133 active specs implemented; 0 deferred; 13 gaps.

## Key Findings

1. **Health-check Lambda cannot initialise**: `app/packages/infra/src/lambdas.ts:568` gives the function only `{ AWS_REGION_ }`, but `lambda/health-check/src/handler.ts:40` calls `requireEnv('ECS_CLUSTER')` at module load, which throws (`app/packages/shared/src/env.ts:16`). `app/packages/infra/src/lambdas.test.ts:792` pins the env to exactly `{ AWS_REGION_ }`, locking the bug in. Sweep-8 also reports the health-check SG has only per-port egress to the game SG (`securityGroups.ts:430-446`), so even with the env fixed it has no path to the ECS or Secrets Manager APIs from a public subnet without a public IP (verified the egress rules; reachability is `[inferred]`). The watchdog treats invoke failures as active, so the symptom is "games with a health check never idle out".
2. **Stack outputs now cover every volume; the efs-seeder still does not**: `buildStackOutputs` builds a per-game, per-volume map from `efs.gameAccessPoints["${game}-${volume.name}"]` and exports it as `efsVolumeAccessPoints` (`program.ts:477-494,511`; typed at `shared/src/stackOutputs.ts:79-83`, projected with a `{}` default by `iac/engine` at `PulumiService.ts:1042`). The older `efsAccessPoints` is kept and still carries only `volumes[0]` (`program.ts:493,510`). The helper task mounts every volume from the new map; the efs-seeder Lambda still mounts only the first volume (`lambdas.ts:718-745`), so deploy-time seeding remains first-volume-only.
3. **Caddy image is a floating tag**: `ecs.ts:305` uses `caddy:2-alpine`, while `in-task-tls-termination` requires a version-pinned image and `hostnameShim.ts` pins busybox exactly.
4. **efs-seeder is conditional, spec says always-on**: `lambdas.ts:398` iterates `roles.efsSeederRoles`, which only exist for games with `file_seeds` (`iam.ts:222-226`). `lambda-runtime-currency` lists efs-seeder among "always-provisioned functions". CLAUDE.md ("four always-on, two conditional") matches the code.
5. **ACM certificate exists despite "no ACM certificate anywhere"**: `discordDomain.ts:117-150` declares an ACM certificate and validation, unconditionally (`discordDomain.ts:14-15`). CLAUDE.md's TLS invariant and `in-task-tls-termination` say no ACM certificate exists; the spec scopes this to "the game-servers stack", which this single stack also is. Needs an explicit carve-out in the invariant.
6. **Secret-preservation spec scenario is only unit-tested by option shape**: `pulumi-infra-program` requires a test that writes real values through the app path, re-deploys and asserts survival. `secrets.test.ts:125-152` only asserts `ignoreChanges: ['secretString']` is passed via `secretResourceOptions.forVersion`.
7. **`domainName` output uses the untrimmed zone name**: `defineAll` trims `hostedZoneName` (`program.ts:163`) but `buildStackOutputs` echoes `config.hostedZoneName` (`program.ts:512`). `route53.ts:65` gets the trimmed but not dot-stripped name, while `ecs.ts`, `lambdas.ts` and `discordDomain.ts` use `stripTrailingDots`. Three normalisations of one value.
8. **Four Lambda log groups are declared after their functions with no `dependsOn`**: `lambdas.ts:443,471,588,657`; only health-check (`:555`) and efs-seeder (`:754`) depend on their group. An early invocation could let Lambda auto-create the group without 7-day retention `[inferred]`.
9. **Unused and inconsistent Lambda wiring**: interactions gets `HOSTED_ZONE_NAME` (`lambdas.ts:463`) but its handler never reads it; CloudFront allows PUT/PATCH/DELETE (`discordDomain.ts:178`) while the Function URL CORS lists POST only (`lambdas.ts:480`).
10. **efs-seeder rerun trigger ignores `container_path`**: `escapes.ts:248-257` hashes only `file_seeds` into `triggers`, while `input` also carries `volumes[0].container_path`. Whether a path-only change re-invokes depends on provider diffing of `input` `[unverified]`.
11. **Stale doc comments**: `program.ts:106,109` say "five Lambda functions" and "five inline IAM policies"; `secrets.ts:95` says "the two Discord secrets" (three are declared); `lambdas.ts:63`, `escapes.ts:35` and `iam.ts:29` point to an "HCL→Pulumi address table" or "full resource table" that does not exist; `secrets.ts:61-63` cross-references a `dynamodb.ts` doc section that is absent. 43 non-test references to HCL/Terraform/"legacy tool" remain in `app/packages/infra/src`.
12. **Test helpers ship in `dist/`**: `app/packages/infra/tsconfig.json` excludes only `*.test.ts`, so `testing/fixtures.ts` and `testing/pulumiMocks.ts` compile into the package output. `testing/fixtures.ts:58-81` also hard-codes defaults instead of importing `DEPLOYMENT_CONFIG_DEFAULTS` `[unverified]`.
13. **Build plumbing drift**: `buildLambda.mjs:13,16-17` uses cwd-relative paths and emits a sourcemap that is never shipped (only `handler.cjs` is zipped, `lambdas.ts:242`); efs-seeder bundles the SDK (`efs-seeder/esbuild.config.mjs:3`) and its `tsconfig.json` does not extend `tsconfig.lambda.json` (sweep-8).
14. **Implicit `${game}-${volume}` key contract**: the access-point key is re-derived in `efs.ts`, `ecs.ts`, `lambdas.ts:721` and `program.ts:484`; game `a-b` volume `c` collides with game `a` volume `b-c` (sweep-8, key derivation verified at `lambdas.ts:721` and `program.ts:484`).
15. **Sweep disagreement: "five vs six Lambdas"**: code comments here say five (`program.ts:106`); packages and CLAUDE.md say six. Primary owner is `operator-app/infra-logs`. `stack-outputs.fixture.ts:1-8` also carries issue-number history in its header.

## Work Required

Spec IDs cite the open (`[ ]`) gap specs in `docs/intent/iac/program/program-specs.md`; items with no matching gap spec carry none.

### Must Fix
1. Give the health-check Lambda `ECS_CLUSTER` (and fix the test pinning its env), and give its SG/subnet a route to the ECS and Secrets Manager APIs (finding 1). (specs: `IAC-PROGRAM-LAMBDA-011`, `IAC-PROGRAM-LAMBDA-012`)
2. Let the efs-seeder target any volume, or document first-volume-only seeding as a hard limit; per-volume access points are already in the stack outputs (finding 2). (specs: `IAC-PROGRAM-SEED-004`)

### Should Fix
3. Pin the Caddy image to an exact version (finding 3). (specs: `IAC-PROGRAM-TLS-002`)
4. Reconcile `lambda-runtime-currency` (efs-seeder conditional; target lives in `buildLambda.mjs`) and the ACM invariant wording in CLAUDE.md and `in-task-tls-termination` with the code (findings 4, 5). (specs: `IAC-PROGRAM-RUNTIME-003`)
5. Add a real secret-preservation test or relax the spec scenario (finding 6). (specs: `IAC-PROGRAM-SECRET-005`)
6. Normalise `hostedZoneName` once and use it for outputs and the zone lookup (finding 7). (specs: `IAC-PROGRAM-DNS-004`)
7. Make every Lambda depend on its log group (finding 8). (specs: `IAC-PROGRAM-LAMBDA-016`)
8. Include `container_path` in the efs-seeder trigger hash (finding 10). (specs: `IAC-PROGRAM-SEED-003`)

### Nice to Have
9. Remove `HOSTED_ZONE_NAME` from interactions, restrict CloudFront methods (finding 9).
10. Sweep stale doc comments and HCL references (finding 11).
11. Exclude `app/packages/web/src/testing/` from the infra build; drop or ship the Lambda sourcemap; anchor `buildLambda.mjs` paths (findings 12, 13). (specs: `IAC-PROGRAM-WS-006`, `IAC-PROGRAM-RUNTIME-006`)
12. Centralise the access-point key derivation behind one helper (finding 14). (specs: `IAC-PROGRAM-EFS-004`)
