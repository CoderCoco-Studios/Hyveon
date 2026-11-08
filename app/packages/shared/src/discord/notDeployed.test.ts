import { describe, expect, it } from 'vitest';
import { DISCORD_NOT_DEPLOYED_MESSAGE, isDiscordNotDeployedError } from './notDeployed.js';

describe('isDiscordNotDeployedError', () => {
  // @spec DISCORD-UI-008
  it('should match the message with or without an IPC transport prefix', () => {
    expect(isDiscordNotDeployedError(new Error(DISCORD_NOT_DEPLOYED_MESSAGE))).toBe(true);
    expect(
      isDiscordNotDeployedError(
        new Error(`Error invoking remote method 'discord.getConfig': Error: ${DISCORD_NOT_DEPLOYED_MESSAGE}`),
      ),
    ).toBe(true);
  });

  // @spec DISCORD-UI-008
  it('should not match other errors or non-errors', () => {
    expect(isDiscordNotDeployedError(new Error('ResourceNotFoundException'))).toBe(false);
    expect(isDiscordNotDeployedError(DISCORD_NOT_DEPLOYED_MESSAGE)).toBe(false);
  });
});
