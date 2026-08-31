## 1. Shared config

- [ ] 1.1 Add `vpcFlowLogsEnabled: boolean` (default `true`) to `DeploymentConfig` in `@hyveon/shared`, including its `DEPLOYMENT_CONFIG_DEFAULTS` entry
- [ ] 1.2 Add/extend unit tests for the new field's default and round-trip through the config type

## 2. Infra program

- [ ] 2.1 Add `app/packages/infra/src/flowLogs.ts` declaring the IAM role/policy scoped to the new log group's ARN, the CloudWatch Logs log group (`/vpc/${projectName}-flow-logs`), and the `aws.ec2.FlowLog` (`trafficType: 'ALL'`) scoped to the VPC from `defineNetwork`'s `NetworkResources`
- [ ] 2.2 Gate flow-log resource declaration on `DeploymentConfig.vpcFlowLogsEnabled`, wired from `program.ts`
- [ ] 2.3 Add the flow-log log group name as a new stack output for the desktop app to read
- [ ] 2.4 Unit tests: enabled/disabled preview behavior, IAM policy resource scope, resource naming/tags (`Project=hyveon`)

## 3. Desktop-main service layer

- [ ] 3.1 Add a flow-log log-group resolver (mirrors `LogsService.resolveLambdaLogGroup`, reading the stack output or deriving `/vpc/${projectName}-flow-logs` from `DeploymentConfigService`)
- [ ] 3.2 Add `getRecentFlowLogs`, `getOlderFlowLogs`, `getNewerFlowLogs`, `streamFlowLogs` to `LogsService`, reusing `fetchAcrossStreams`/`listStreams`/`getRecentFromLogGroup` per design.md D5
- [ ] 3.3 Add a pure flow-log record parser (pipe-delimited fields → structured record incl. `action`) used at the controller/renderer boundary, not inside `LogsService`
- [ ] 3.4 Unit tests for the new `LogsService` methods (recent/older/newer/tail) and the record parser, mirroring existing Lambda-log test coverage
- [ ] 3.5 Extend `logs.controller.ts` (or add a sibling controller) with IPC handlers for the new methods, each starting with the required `logger.debug` entry line per `.claude/rules/logging.md`

## 4. Renderer / web UI

- [ ] 4.1 Extend the Infrastructure/Logs page to add a flow-log view (recent/tail/paging) alongside existing game/Lambda log views
- [ ] 4.2 Add the "rejected only" filter control, applying the parsed `action === 'REJECT'` filter client-side
- [ ] 4.3 Component/integration tests for the new view and filter, per `docs/docs/components/integration-tests.md` conventions

## 5. Docs

- [ ] 5.1 Update `docs/docs/components/infra.md`'s resource table with the new log group/IAM role, and note CloudWatch Logs ingestion cost scales with VPC traffic volume
- [ ] 5.2 Update the relevant `docs/docs/app/*` page for the Infrastructure/Logs UI to document the new flow-log view and filter
- [ ] 5.3 Note the toggle in whichever `docs/docs/` settings page documents other `DeploymentConfig` top-level toggles

## 6. Verification

- [ ] 6.1 `npm run app:lint`
- [ ] 6.2 `npm run app:typecheck`
- [ ] 6.3 `npm run app:test`
- [ ] 6.4 `npm run app:test:integration` (controllers/services changed)
- [ ] 6.5 `npm run app:test:e2e` (renderer/IPC surface changed)
