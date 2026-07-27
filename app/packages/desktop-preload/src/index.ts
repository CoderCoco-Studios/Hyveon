export type {
  HyveonApi,
  HyveonTestApi,
  HyveonMockNamespaces,
  TerraformRunChunk,
  TerraformRunKind,
  TerraformRunRecord,
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
  WizardState,
  SaveWizardStateInput,
} from './hyveon-api.js';

declare global {
  interface Window {
    hyveon?: import('./hyveon-api.js').HyveonApi;
  }
}

export {};
