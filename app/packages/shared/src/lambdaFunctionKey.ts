/**
 * The 5 Lambda functions the app provisions (`app/packages/infra/src/lambdas.ts`),
 * identified by the exact suffix each one's log group is named with:
 * `/aws/lambda/${projectName}-${functionKey}`.
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
