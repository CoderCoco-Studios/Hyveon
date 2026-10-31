import { describe, it, expect } from 'vitest';
import { actionForCommand, COMMAND_DESCRIPTORS } from './commands.js';

describe('actionForCommand', () => {
  it('should map server-start to the start action bucket', () => {
    expect(actionForCommand('server-start')).toBe('start');
  });
  it('should map server-stop to the stop action bucket', () => {
    expect(actionForCommand('server-stop')).toBe('stop');
  });
  it('should map server-status and server-list to the status action bucket', () => {
    expect(actionForCommand('server-status')).toBe('status');
    expect(actionForCommand('server-list')).toBe('status');
  });
});

// @spec DISCORD-CMD-013
describe('COMMAND_DESCRIPTORS', () => {
  it('should declare exactly the four commands the bot implements', () => {
    const names = COMMAND_DESCRIPTORS.map((d) => d.name).sort();
    expect(names).toEqual(['server-list', 'server-start', 'server-status', 'server-stop']);
  });

  it('should mark game as a required autocomplete string option on start and stop', () => {
    for (const name of ['server-start', 'server-stop'] as const) {
      const d = COMMAND_DESCRIPTORS.find((x) => x.name === name)!;
      expect(d.options).toHaveLength(1);
      const opt = d.options![0]!;
      expect(opt.type).toBe(3);
      expect(opt.required).toBe(true);
      expect(opt.autocomplete).toBe(true);
      expect(opt.name).toBe('game');
    }
  });

  it('should mark game as an optional autocomplete string option on status', () => {
    const d = COMMAND_DESCRIPTORS.find((x) => x.name === 'server-status')!;
    expect(d.options).toHaveLength(1);
    const opt = d.options![0]!;
    expect(opt.required).toBe(false);
    expect(opt.autocomplete).toBe(true);
  });

  it('should have no options on server-list since it takes no arguments', () => {
    const d = COMMAND_DESCRIPTORS.find((x) => x.name === 'server-list')!;
    expect('options' in d).toBe(false);
  });
});
