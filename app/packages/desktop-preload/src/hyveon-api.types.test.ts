import { describe, it, expectTypeOf } from 'vitest';
import type {
  GameServer as SharedGameServer,
  GameWizardDraft as SharedGameWizardDraft,
  RedactedGameServer as SharedRedactedGameServer,
} from '@hyveon/shared';
import type { GameServer, GameWizardDraft, RedactedGameServer } from './hyveon-api.js';

// @spec GAME-IPC-005
describe('preload game types', () => {
  it('should be the @hyveon/shared game model, including webPort and command', () => {
    expectTypeOf<GameServer>().toEqualTypeOf<SharedGameServer>();
    expectTypeOf<RedactedGameServer>().toEqualTypeOf<SharedRedactedGameServer>();
    expectTypeOf<GameServer>().toHaveProperty('webPort');
    expectTypeOf<GameServer>().toHaveProperty('command');
  });

  it('should be the shared wizard draft, including webPort and command', () => {
    expectTypeOf<GameWizardDraft>().toEqualTypeOf<SharedGameWizardDraft>();
    expectTypeOf<GameWizardDraft>().toHaveProperty('webPort');
    expectTypeOf<GameWizardDraft>().toHaveProperty('command');
  });
});
