import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type * as Shared from '@hyveon/shared';
import type * as Preload from './hyveon-api.js';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;

/** One assertion per shared shape; each fails `typecheck:tests` if the preload type stops being the shared type. */
export type SharedTypeContract = [
  Assert<Equal<Preload.GameServerPort, Shared.GameServerPort>>,
  Assert<Equal<Preload.GameServer, Shared.GameServer>>,
  Assert<Equal<Preload.GameStatus, Shared.GameStatus>>,
  Assert<Equal<Preload.StartResult, Shared.StartResult>>,
  Assert<Equal<Preload.CostEstimates, Shared.CostEstimates>>,
  Assert<Equal<Preload.GameEstimate, Shared.GameEstimate>>,
  Assert<Equal<Preload.GameWizardDraft, Shared.GameWizardDraft>>,
  Assert<Equal<Preload.StoredGameWizardDraft, Shared.StoredGameWizardDraft>>,
  Assert<Equal<Preload.StoredResolvedGameWizardDraft, Shared.StoredResolvedGameWizardDraft>>,
  Assert<Equal<Preload.DiscordAdmins, Shared.DiscordAdmins>>,
  Assert<Equal<Preload.DiscordGamePermission, Shared.DiscordGamePermission>>,
  Assert<Equal<Preload.GameServerEnvironmentVariable, Shared.GameServerEnvironmentVariable>>,
  Assert<Equal<Preload.GameServerVolume, Shared.GameServerVolume>>,
  Assert<Equal<Preload.GameServerFileSeed, Shared.GameServerFileSeed>>,
  Assert<Equal<Preload.GameServerHealthCheckAuthWriteInput, Shared.GameServerHealthCheckAuthWriteInput>>,
  Assert<Equal<Preload.GameServerHealthCheckCondition, Shared.GameServerHealthCheckCondition>>,
  Assert<Equal<Preload.GameServerHealthCheck, Shared.GameServerHealthCheck>>,
  Assert<Equal<Preload.RedactedGameServerHealthCheck, Shared.RedactedGameServerHealthCheck>>,
  Assert<Equal<Preload.GameServerHealthCheckWriteInput, Shared.GameServerHealthCheckWriteInput>>,
  Assert<Equal<Preload.RedactedGameServer, Shared.RedactedGameServer>>,
  Assert<Equal<Preload.GameServerWriteConfig, Shared.GameServerWriteConfig>>,
  Assert<Equal<Preload.GameListEntry, Shared.GameListEntry>>,
  Assert<Equal<Preload.GameServerValidationIssue, Shared.GameServerValidationIssue>>,
  Assert<Equal<Preload.GameWriteSuccess, Shared.GameWriteSuccess>>,
  Assert<Equal<Preload.GameWriteConflict, Shared.GameWriteConflict>>,
  Assert<Equal<Preload.GameWriteValidationFailure, Shared.GameWriteValidationFailure>>,
  Assert<Equal<Preload.GameWriteNotFound, Shared.GameWriteNotFound>>,
  Assert<Equal<Preload.GameWriteSetupIncomplete, Shared.GameWriteSetupIncomplete>>,
  Assert<Equal<Preload.GameWriteFailure, Shared.GameWriteFailure>>,
  Assert<Equal<Preload.GameWriteResult, Shared.GameWriteResult>>,
  Assert<Equal<Preload.CreateGamePayload, Shared.CreateGamePayload>>,
  Assert<Equal<Preload.UpdateGamePayload, Shared.UpdateGamePayload>>,
  Assert<Equal<Preload.DeleteGamePayload, Shared.DeleteGamePayload>>,
  Assert<Equal<Preload.DriftKind, Shared.DriftKind>>,
  Assert<Equal<Preload.DriftChangedField, Shared.DriftChangedField>>,
  Assert<Equal<Preload.DriftEntry, Shared.DriftEntry>>,
  Assert<Equal<Preload.DriftReport, Shared.DriftReport>>,
  Assert<Equal<Preload.AuditAction, Shared.AuditAction>>,
  Assert<Equal<Preload.AuditEntry, Shared.AuditEntry>>,
  Assert<Equal<Preload.AuditPageResult, Shared.AuditPageResult>>,
  Assert<Equal<Preload.RunDetailStatus, Shared.RunDetailStatus>>,
  Assert<Equal<Preload.RunHistoryStatus, Shared.RunStatus>>,
  Assert<Equal<Preload.RunHistoryRecord, Shared.RunRecord>>,
  Assert<Equal<Preload.RunHistoryPageResult, Shared.RunPageResult>>,
  Assert<Equal<Preload.IacRunKind, Shared.RunKind>>,
  Assert<Equal<Preload.WizardStepName, Shared.WizardStep>>,
  Assert<Equal<Preload.RunLock, Shared.RunLock>>,
  Assert<Equal<Preload.AutoUpdateSettingGetResult, Shared.AutoUpdateSettingGetResult>>,
  Assert<Equal<Preload.AutoUpdateSettingUpdatePayload, Shared.AutoUpdateSettingUpdatePayload>>,
  Assert<Equal<Preload.AutoUpdateSettingWriteResult, Shared.AutoUpdateSettingWriteResult>>,
  Assert<Equal<Preload.ChangeSummary, Shared.ChangeSummary>>,
  Assert<Equal<Preload.DeploymentConfigDiff, Shared.DeploymentConfigDiff>>,
  Assert<Equal<Preload.DeploymentSettingsGetResult, Shared.DeploymentSettingsGetResult>>,
  Assert<Equal<Preload.DeploymentSettingsWriteResult, Shared.DeploymentSettingsWriteResult>>,
  Assert<Equal<Preload.ExportDiagnosticsBundleResult, Shared.ExportDiagnosticsBundleResult>>,
  Assert<Equal<Preload.GameServerHealthCheckAuth, Shared.GameServerHealthCheckAuth>>,
  Assert<Equal<Preload.LambdaFunctionKey, Shared.LambdaFunctionKey>>,
  Assert<Equal<Preload.ManualUpdateCheckResult, Shared.ManualUpdateCheckResult>>,
  Assert<Equal<Preload.UpdateDownloadProgress, Shared.UpdateDownloadProgress>>,
  Assert<Equal<Preload.UpdateDownloadResult, Shared.UpdateDownloadResult>>,
  Assert<Equal<Preload.UpdateInstallResult, Shared.UpdateInstallResult>>,
  Assert<Equal<Preload.OpType, Shared.OpType>>,
  Assert<Equal<Preload.PulumiEngineVersionResult, Shared.PulumiEngineVersionResult>>,
  Assert<Equal<Preload.RendererConsoleLevel, Shared.RendererConsoleLevel>>,
  Assert<Equal<Preload.RendererLogEntry, Shared.RendererLogEntry>>,
  Assert<Equal<Preload.TopLevelDeploymentSettings, Shared.TopLevelDeploymentSettings>>,
  Assert<Equal<Preload.UpdateDeploymentSettingsPayload, Shared.UpdateDeploymentSettingsPayload>>,
];

describe('preload contract uses @hyveon/shared types', () => {
  // @spec APP-IPC-CONTRACT-003
  it('should equal the shared type for every shared shape that crosses the bridge', () => {
    const contract: SharedTypeContract | undefined = undefined;
    expect(contract).toBeUndefined();
  });

  // @spec APP-IPC-CONTRACT-003
  it('should assert equality for every type hyveon-api.ts re-exports from @hyveon/shared', () => {
    const api = readFileSync(new URL('./hyveon-api.ts', import.meta.url), 'utf8');
    const block = /export type \{([^}]*AutoUpdateSettingGetResult[^}]*)\};/.exec(api)?.[1] ?? '';
    const reexported = [...block.matchAll(/^\s*([A-Za-z]+),?\s*$/gm)].map((m) => m[1]);
    const asserted = readFileSync(new URL('./shared-types.test.ts', import.meta.url), 'utf8');

    expect(reexported.length).toBeGreaterThan(40);
    const missing = reexported.filter((name) => !asserted.includes(`Assert<Equal<Preload.${name},`));
    expect(missing).toEqual([]);
  });
});
