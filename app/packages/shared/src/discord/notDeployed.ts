/** Stable error text a desktop read of the Discord config carries when the infrastructure has not been deployed. */
export const DISCORD_NOT_DEPLOYED_MESSAGE = 'Discord is not deployed yet: the stack has not published the Discord table.';

/**
 * Reports whether an error from a Discord config read means the infrastructure is not deployed.
 *
 * @remarks
 * IPC wraps error text with a transport prefix, so the check is a substring match rather than equality.
 *
 * @param err - The caught value.
 * @returns `true` when the error carries {@link DISCORD_NOT_DEPLOYED_MESSAGE}.
 */
export function isDiscordNotDeployedError(err: unknown): boolean {
  return err instanceof Error && err.message.includes(DISCORD_NOT_DEPLOYED_MESSAGE);
}
