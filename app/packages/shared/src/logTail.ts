/**
 * How far before a live log tail's start the first `FilterLogEvents` poll reaches back, in milliseconds.
 *
 * @remarks
 * CloudWatch filters on the event timestamp, not the ingestion time. An event stamped before the tail began but
 * ingested after the snapshot (ingestion lag is often seconds, plus the snapshot to first-poll delay and host clock
 * skew) would otherwise never be shown. Consumers de-duplicate by `eventId`, so the overlap is harmless.
 */
export const LOG_TAIL_LOOKBACK_MS = 30_000;

/**
 * Informational line shown when a game's or Lambda function's log group does not exist yet.
 *
 * @param label - Game name or Lambda `functionKey`.
 * @returns The line to show in place of log output.
 */
export function noLogGroupMessage(label: string): string {
  return `No log group for ${label} yet — it hasn't been provisioned or hasn't logged anything.`;
}
