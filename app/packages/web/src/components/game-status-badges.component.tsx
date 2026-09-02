import { Badge, type BadgeProps } from '@/components/ui/badge.component';
import type { DriftChangedField, DriftKind } from '../api.service.js';

/** Drift shape carried on a `GameListEntry` — see `@hyveon/shared`'s `GameListEntry.drift`. */
export interface GameStatusDrift {
  kind: DriftKind;
  changedFields?: DriftChangedField[];
}

/**
 * Props for {@link GameStatusBadges} — the `declared` / `deployed` flags and
 * optional `drift` finding off a `GameListEntry` (`@hyveon/shared`, merged by
 * `mergeGameLists`).
 */
export interface GameStatusBadgesProps {
  /** True when this game has an entry in the declared `gameServers` map. */
  declared: boolean;
  /** True when this game has a deployed ECS task definition in tfstate. */
  deployed: boolean;
  /** Drift finding for this game, from `DriftService.computeDrift`, if any. */
  drift?: GameStatusDrift;
}

/**
 * Renders the drift indicator for a single game row on the Settings →
 * Games panel and the game-detail page: one chip summarizing
 * whether the game is declared in the deployment config, deployed to
 * tfstate, and whether its declared config has drifted from what's deployed
 * (via `DriftService`) — so operators can spot drift at a glance.
 *
 * - declared && deployed, no config_drift → "In sync" (success)
 * - declared && deployed, drift.kind === 'config_drift' → "Config drift" (warning),
 *   with a tooltip listing the changed fields
 * - declared && !deployed → "Pending deploy" (warning)
 * - !declared && deployed → "Undeclared" (destructive)
 *
 * `!declared && !deployed` is not a state `GameListEntry` can produce (a
 * game only appears in the merged list when it's declared, deployed, or
 * both), so it's intentionally not handled here.
 */
export function GameStatusBadges({ declared, deployed, drift }: GameStatusBadgesProps) {
  const { text, variant, changedFields } = describeDriftStatus(declared, deployed, drift);
  const title = changedFields && changedFields.length > 0 ? changedFields.join(', ') : undefined;
  return (
    <Badge variant={variant} title={title}>
      {text}
    </Badge>
  );
}

/**
 * Chip copy, color variant, and tooltip fields for a declared/deployed/drift
 * combination — the single source of truth for whether a finding counts as
 * displayable config drift, so the chip text and its tooltip can never
 * desync.
 */
function describeDriftStatus(
  declared: boolean,
  deployed: boolean,
  drift: GameStatusDrift | undefined,
): { text: string; variant: NonNullable<BadgeProps['variant']>; changedFields?: DriftChangedField[] } {
  if (declared && deployed) {
    if (drift?.kind === 'config_drift') {
      return { text: 'Config drift', variant: 'warning', changedFields: drift.changedFields };
    }
    return { text: 'In sync', variant: 'success' };
  }
  if (declared && !deployed) {
    return { text: 'Pending deploy', variant: 'warning' };
  }
  return { text: 'Undeclared', variant: 'destructive' };
}
