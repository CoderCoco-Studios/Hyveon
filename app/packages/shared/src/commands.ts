import type { DiscordAction } from './types.js';

/** Slash-command names this bot exposes. */
export type AppCommandName = 'server-start' | 'server-stop' | 'server-status' | 'server-list';

/**
 * Permission bucket each command consumes from `canRun()`. Matches the value
 * passed to `SlashCommand(name, action)` in the old discord.js implementation.
 */
export function actionForCommand(name: AppCommandName): DiscordAction {
  switch (name) {
    case 'server-start':
      return 'start';
    case 'server-stop':
      return 'stop';
    case 'server-status':
    case 'server-list':
      return 'status';
  }
}

// @spec DISCORD-CMD-013
/**
 * Discord application-command descriptors, flattened to JSON so the shared
 * package doesn't depend on `discord.js`.
 *
 * Option types (see Discord docs "Application Command Object"):
 *   3 = STRING, required+autocomplete for game-option commands.
 */
export const COMMAND_DESCRIPTORS = [
  {
    name: 'server-start',
    description: 'Start a game server',
    options: [
      {
        type: 3,
        name: 'game',
        description: 'Game to start',
        required: true,
        autocomplete: true,
      },
    ],
  },
  {
    name: 'server-stop',
    description: 'Stop a running game server',
    options: [
      {
        type: 3,
        name: 'game',
        description: 'Game to stop',
        required: true,
        autocomplete: true,
      },
    ],
  },
  {
    name: 'server-status',
    description: 'Show status of a game server (or all if omitted)',
    options: [
      {
        type: 3,
        name: 'game',
        description: 'Game to check',
        required: false,
        autocomplete: true,
      },
    ],
  },
  {
    name: 'server-list',
    description: 'List all configured game servers and their state',
  },
] as const;
