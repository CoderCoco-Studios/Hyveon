## 1. Shared configuration and validation

- [x] 1.1 Add `GameServerHealthCheck` and its nested `activeWhen` / `auth` interfaces to `app/packages/shared/src/gameServerConfig.ts`, with TSDoc stating that omitting `healthCheck` keeps the network-traffic heuristic; add `healthCheck?: GameServerHealthCheck` to `GameServer`
- [x] 1.2 Add `gameServerHealthCheckSchema` to `app/packages/shared/src/gameServerValidator.ts` covering structure only — `kind` literal, `scheme` / `method` / `operator` enums, `path` rooted at `/`, `timeoutMs` bounds, ARN pattern on `auth.secretArn` — and wire it as `healthCheck: gameServerHealthCheckSchema.optional()` in `gameServerSchema`
- [x] 1.3 Add `checkHealthCheckRules` to `validateGameServer`, gated on `healthCheck` presence, returning `GameServerValidationIssue[]` for: declared port absent from the game's `ports`, and a comparison operator declared without a `value`
- [x] 1.4 Write validator specs covering port-not-in-`ports`, missing `value` for each comparison operator, `exists` correctly requiring no value, out-of-range `timeoutMs`, unrooted `path`, and malformed `secretArn`
- [x] 1.5 Export a `gamesWithHealthChecks(gameServers)` helper alongside the existing `gamesWithFileSeeds`, so the infra program derives the participating set exactly once

## 2. Check engine

- [x] 2.1 Create the `@hyveon/lambda-health-check` package mirroring `efs-seeder`'s four files — `package.json`, `esbuild.config.mjs` (target `node24`, `external: ['@aws-sdk/*']`), `tsconfig.json` referencing shared, `src/`
- [x] 2.2 Implement the pure engine: `(config, status, rawBody) => { active, reason }` — JSON parse, JSONPath resolve, operator comparison — with every failure path returning `active: true` and a reason naming the failure
- [x] 2.3 Table-test the engine across all six operators, JSONPath hit and miss, a value the operator cannot compare, a non-2xx status, and an unparseable body — asserting fail-active in every failure case and that no response value appears in the reason

## 3. Health-check Lambda handler

- [ ] 3.1 Implement the handler: accept `{ game, taskArn, healthCheck }`, resolve the task's private address from the ECS `DescribeTasks` attachment details, fetch the credential from Secrets Manager only when `auth` is present, issue the request with the declared timeout, and delegate the verdict to the engine
- [ ] 3.2 Return fail-active for transport and credential failures — timeout, refused connection, unavailable secret — with the normalized `err instanceof Error ? err.message : String(err)` message in the reason
- [ ] 3.3 Log `debug` on entry with `{ game, kind, port }` and the verdict with `{ game, kind, active, reason }`; log a failure-derived verdict at `warn`; never log the credential or the response body
- [ ] 3.4 Test the handler with `aws-sdk-client-mock` for ECS and Secrets Manager and a mocked fetch seam: assert the host comes from the ECS attachment and never from config, the secret is fetched only when `auth` is present, and no secret value reaches the logger
- [ ] 3.5 Add `@hyveon/lambda-health-check` to the explicit enumeration in `build:lambdas` in `app/package.json`

## 4. Watchdog routing

- [ ] 4.1 Read the new env var mapping opted-in game names, and branch per task: no entry keeps the existing CloudWatch path unchanged; an entry invokes the health-check function synchronously instead
- [ ] 4.2 Treat a failed invoke — throttled, absent, timed out — as fail-active, and carry the returned `reason` into the existing per-task log line so one stream explains verdict, idle count, and shutdown
- [ ] 4.3 Test both branches: a game without a check calls CloudWatch and never invokes the function; a game with one does the inverse; a failing invoke does not increment the idle counter

## 5. Infrastructure

- [ ] 5.1 Derive the participating set once in `iam.ts` from `gamesWithHealthChecks` and create the health-check role only when it is non-empty, following the `efsSeederRoles` pattern
- [ ] 5.2 Write the role's policy: the standard log statement, the three `ec2:*NetworkInterface` actions required by any `vpcConfig` Lambda, `ecs:DescribeTasks` scoped to the cluster, and `secretsmanager:GetSecretValue` scoped to exactly the `auth.secretArn` values opted-in games reference
- [ ] 5.3 Add the conditional `healthCheckSg` in `securityGroups.ts` following `efsSeederSg` — `namePrefix`, no inline egress — plus a standalone egress rule per declared health-check port toward `gameServersSg`, and the matching ingress on `gameServersSg`
- [ ] 5.4 Declare the function in `lambdas.ts` gated on the roles map being non-empty: shared bundle, `vpcConfig` on the public subnets with the new security group, `AWS_REGION_`, its log group, and the invoke permission for the watchdog role only — no Function URL
- [ ] 5.5 Add the opted-in-games env var to the watchdog's existing `environment.variables`, built by a sorted-key helper alongside `connectMessagesByGame` and `firstPortByGame`
- [ ] 5.6 Assert the zero-footprint property in the infra tests: a `DeploymentConfig` where no game declares `healthCheck` yields no health-check role, policy, security group, rule, log group, or function
- [ ] 5.7 Assert in infra tests that the health-check Lambda's `vpcConfig` places it on the same public subnets, with the same internet-gateway route, as every other Lambda — confirming its `ecs:DescribeTasks` and `secretsmanager:GetSecretValue` calls need no NAT gateway or VPC endpoint, only the IAM statements from 5.2

## 6. Operator interface

- [ ] 6.1 Surface health-check configuration in the add/edit-game wizard in `@hyveon/web`, including the port selector constrained to the game's declared ports
- [ ] 6.2 Expose the credential as a `secretSet` boolean in the redacted shape, never the value, and cover it with a spec asserting no secret value reaches the renderer

## 7. Documentation and gates

- [ ] 7.1 Update `docs/docs/components/lambdas.md` — the new function, its conditional provisioning, and the watchdog's verdict routing
- [ ] 7.2 Update `docs/docs/components/infra.md` — the conditional resources, the security-group rules, and the port-level confinement caveat
- [ ] 7.3 Update the add/edit-game wizard page under `docs/docs/app/`
- [ ] 7.4 Run `npm run app:lint`, `npm run app:typecheck`, `npm run app:test`, and `npm run app:test:integration`, and confirm each exits zero
