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
  TerraformPlanPayload,
  TerraformApplyPayload,
  TerraformApproveAck,
  TerraformDestroyPayload,
  TerraformDestroyMintAck,
  TerraformRollbackResolveAck,
  TerraformRollbackConfirmAck,
  PrerequisiteCheckResult,
  TerraformPrerequisiteCheckResult,
  PrerequisitesReport,
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
