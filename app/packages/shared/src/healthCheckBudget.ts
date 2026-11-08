/** Largest `healthCheck.timeoutMs` the validator accepts, in milliseconds. */
export const HEALTH_CHECK_TIMEOUT_MAX_MS = 10_000;

/** Overall deadline for the health-check Lambda's `GetSecretValue` call, retries included, in milliseconds. */
export const HEALTH_CHECK_SECRET_DEADLINE_MS = 5_000;

/** Total time one watchdog run may spend on health-check invokes before it skips the rest, in milliseconds. */
export const HEALTH_CHECK_RUN_BUDGET_MS = 40_000;
