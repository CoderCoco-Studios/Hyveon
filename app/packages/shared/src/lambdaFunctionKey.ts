// @spec APP-LOGS-GROUP-005, APP-LOGS-GROUP-007
/**
 * Every {@link LambdaFunctionKey} value, in the fixed order the Infrastructure
 * logs page's function picker renders them. The `LambdaFunctionKey` union is derived from
 * this declaration, so a key cannot be added to one without the other.
 */
export const LAMBDA_FUNCTION_KEYS = Object.freeze([
  'watchdog',
  'health-check',
  'dns-updater',
  'interactions',
  'followup',
] as const);

/**
 * The 5 log-tailable Lambda functions of the 6 the app can provision
 * (`app/packages/infra/src/lambdas.ts`), identified by the exact suffix each
 * one's log group is named with: `/aws/lambda/${projectName}-${functionKey}`.
 * `efs-seeder` is excluded — it's per-game (zero, one, or many instances),
 * not a single fixed function this key type can address.
 */
export type LambdaFunctionKey = (typeof LAMBDA_FUNCTION_KEYS)[number];
