import type { DeploymentConfigDiff } from '@hyveon/shared';

/**
 * Formats a {@link DeploymentConfigDiff} into a single readable sentence
 * appended to the rollback confirmation dialog's description —
 * e.g. "3 game servers added (foo, bar, baz), 1 removed (qux), 2 changed
 * (corn, potato); other settings also changed: awsRegion, dnsTtl." Never
 * called when `diff` itself is absent — see `RollbackAction`'s own doc
 * comment for the graceful-degradation contract that keeps this function's
 * caller optional.
 *
 * Returns a fixed "No configuration differences detected." sentence when
 * every field compares equal (the edge case where the resolved target
 * version happens to be byte-identical to the current head in every
 * `DeploymentConfig` field) rather than an empty/blank line, so the
 * confirmation dialog never renders a diff section that looks broken or
 * unfinished for a legitimately empty diff.
 *
 * @param diff - The rollback target's computed diff against the current configuration head.
 * @returns A single sentence summarizing the diff, or the fixed no-differences sentence.
 */
export function formatDiffSummary(diff: DeploymentConfigDiff): string {
  const gameServerParts: string[] = [];
  if (diff.gameServers.added.length > 0) {
    const n = diff.gameServers.added.length;
    gameServerParts.push(`${n} game server${n === 1 ? '' : 's'} added (${diff.gameServers.added.join(', ')})`);
  }
  if (diff.gameServers.removed.length > 0) {
    gameServerParts.push(`${diff.gameServers.removed.length} removed (${diff.gameServers.removed.join(', ')})`);
  }
  if (diff.gameServers.changed.length > 0) {
    gameServerParts.push(`${diff.gameServers.changed.length} changed (${diff.gameServers.changed.join(', ')})`);
  }

  const sentenceParts: string[] = [];
  if (gameServerParts.length > 0) {
    sentenceParts.push(gameServerParts.join(', '));
  }
  if (diff.changedFields.length > 0) {
    sentenceParts.push(`other settings also changed: ${diff.changedFields.join(', ')}`);
  }

  if (sentenceParts.length === 0) {
    return 'No configuration differences detected.';
  }
  return `${sentenceParts.join('; ')}.`;
}
