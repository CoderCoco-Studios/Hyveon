export type {
  HyveonApi,
  HyveonTestApi,
  HyveonMockNamespaces,
  HyveonStreamHandle,
  LogChunk,
  TerraformRunChunk,
  TerraformRunKind,
  TerraformRunRecord,
  StackInitPhase,
  StackInitPhaseStatus,
  StackInitPhaseEvent,
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
  IamCheckOrigin,
  WizardState,
  SaveWizardStateInput,
} from './hyveon-api.js';

declare global {
  interface Window {
    hyveon?: import('./hyveon-api.js').HyveonApi;
  }
}

export {};
