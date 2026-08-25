import { Badge } from '@/components/ui/badge.component';
import type { DiscordConfigRedacted } from '../../api.service.js';

/**
 * Compact header indicator showing whether the serverless bot is fully wired
 * up (both secrets configured + an interactions endpoint URL exists).
 */
export function ServerlessBadge({ cfg }: { cfg: DiscordConfigRedacted }) {
  const ready = cfg.botTokenSet && cfg.publicKeySet && !!cfg.interactionsEndpointUrl;
  if (ready) {
    return <Badge variant="success">serverless · ready</Badge>;
  }
  const label = !cfg.interactionsEndpointUrl
    ? 'not applied yet'
    : !cfg.botTokenSet || !cfg.publicKeySet
      ? 'awaiting credentials'
      : 'incomplete';
  return <Badge variant="warning">{label}</Badge>;
}
