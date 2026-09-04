const DISCORD_API = 'https://discord.com/api/v10';

/**
 * PATCH a deferred Discord interaction's original message with `content`.
 *
 * Uses only the global `fetch` — no `discord.js`, per the "Discord is fully
 * serverless" invariant (root `CLAUDE.md`). Authenticates via the interaction
 * token embedded in the URL, so no bot token or Secrets Manager access is
 * required. Swallows and logs failures rather than throwing — callers treat
 * this as a best-effort notification, not a step whose failure should abort
 * the surrounding handler.
 *
 * @param applicationId - The Discord application ID from the original interaction.
 * @param interactionToken - The interaction token from the original interaction (valid up to 15 minutes).
 * @param content - The message content to PATCH onto `@original`.
 */
export async function patchInteractionOriginal(
  applicationId: string,
  interactionToken: string,
  content: string,
): Promise<void> {
  const url = `${DISCORD_API}/webhooks/${applicationId}/${interactionToken}/messages/@original`;
  const resp = await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    console.error('Discord PATCH failed', { status: resp.status, body });
  }
}
