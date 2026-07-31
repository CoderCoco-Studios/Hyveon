export type {
  HyveonApi,
  HyveonTestApi,
  HyveonMockNamespaces,
  HyveonStreamHandle,
  LogChunk,
  TerraformRunChunk,
  TerraformRunKind,
  TerraformRunRecord,
  TerraformInitConfig,
  RunDetailStatus,
  TerraformRunsGetResult,
  TerraformRunsListOpts,
  RunHistoryRecord,
  RunHistoryPageResult,
  RunHistoryStatus,
  TerraformPlanAck,
  TerraformStaleLockHolder,
  TerraformStaleLockInfo,
  TerraformPlanPayload,
  TerraformApplyPayload,
  TerraformApproveAck,
  TerraformDestroyPayload,
  TerraformDestroyMintAck,
  TerraformRollbackResolveAck,
  TerraformRollbackConfirmAck,
  TerraformLockClearAck,
  ChangeSummary,
  OpType,
  AwsProfileSummary,
  IamCheckResult,
  WizardState,
  SaveWizardStateInput,
} from './hyveon-api.js';

declare global {
  interface Window {
    hyveon?: import('./hyveon-api.js').HyveonApi;
  }
}

export {};
