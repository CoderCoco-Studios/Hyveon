// @spec APP-IPC-NAME-004
export type {
  HyveonApi,
  HyveonTestApi,
  HyveonMockNamespaces,
  HyveonStreamHandle,
  LogChunk,
  HyveonLambdaLogsApi,
  LambdaLogs,
  LogEventLine,
  OlderLogsPage,
  NewerLogsPage,
  IacRunChunk,
  IacRunKind,
  IacRunRecord,
  StackInitPhase,
  StackInitPhaseStatus,
  StackInitPhaseEvent,
  RunDetailStatus,
  IacRunsGetResult,
  IacRunsListOpts,
  IacRunsRecordResult,
  RunHistoryRecord,
  RunHistoryPageResult,
  RunHistoryStatus,
  IacPlanAck,
  IacCancelAck,
  IacStaleLockHolder,
  IacStaleLockInfo,
  IacPlanPayload,
  IacApplyPayload,
  IacApproveAck,
  IacDestroyPayload,
  IacDestroyMintAck,
  IacRollbackResolveAck,
  IacRollbackConfirmAck,
  IacLockClearAck,
  RunLock,
  ChangeSummary,
  OpType,
  AwsProfileSummary,
  AwsKeyRotateResult,
  IamCheckResult,
  IamCheckOrigin,
  WizardState,
  WizardDeployPrincipal,
  SaveWizardStateInput,
  WizardStepName,
  GuidedIamSubState,
  WizardProgress,
  SaveWizardProgressInput,
  RendererConsoleLevel,
  RendererLogEntry,
  CloudHealthCheckStatus,
  CloudHealthCheckSummary,
  CloudHealthFixOutcome,
  CloudHealthFixResult,
  OpenConsoleResult,
  RedactedDiscordConfig,
} from './hyveon-api.js';

export { GUIDED_PROFILE_NAME } from './hyveon-api.js';

// @spec APP-IPC-NAME-005, APP-IPC-NAME-007
declare global {
  interface Window {
    hyveon?: import('./hyveon-api.js').HyveonApi;
  }
}

export {};
