/**
 * The 5 log-tailable Lambda functions of the 6 the app can provision
 * (`app/packages/infra/src/lambdas.ts`), identified by the exact suffix each
 * one's log group is named with: `/aws/lambda/${projectName}-${functionKey}`.
 * `efs-seeder` is excluded — it's per-game (zero, one, or many instances),
 * not a single fixed function this key type can address.
 */
export type LambdaFunctionKey =
  | 'watchdog'
  | 'health-check'
  | 'dns-updater'
  | 'interactions'
  | 'followup';

/**
 * Every {@link LambdaFunctionKey} value, in the fixed order the Infrastructure
 * logs page's function picker renders them. Single source of truth so the
 * union and the iterable list can never drift.
 */
export const LAMBDA_FUNCTION_KEYS: readonly LambdaFunctionKey[] = [
  'watchdog',
  'health-check',
  'dns-updater',
  'interactions',
  'followup',
];
