import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { familyToGameMap, gameNamesFromEnv, parseGameMapEnv, requireEnv } from './env.js';

const ENV_KEYS = ['REQUIRE_ENV_TEST', 'GAME_NAMES', 'GAME_MAP_TEST'] as const;

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const key of ENV_KEYS) delete process.env[key];
});

describe('requireEnv', () => {
  it('should return the value when the env var is set', () => {
    process.env['REQUIRE_ENV_TEST'] = 'value';
    expect(requireEnv('REQUIRE_ENV_TEST')).toBe('value');
  });

  it('should throw when the env var is unset', () => {
    expect(() => requireEnv('REQUIRE_ENV_TEST')).toThrow('Missing required env var REQUIRE_ENV_TEST');
  });

  it('should throw when the env var is an empty string', () => {
    process.env['REQUIRE_ENV_TEST'] = '';
    expect(() => requireEnv('REQUIRE_ENV_TEST')).toThrow('Missing required env var REQUIRE_ENV_TEST');
  });
});

describe('gameNamesFromEnv', () => {
  it('should split, trim, and drop empty entries from GAME_NAMES', () => {
    process.env['GAME_NAMES'] = ' palworld ,, satisfactory ';
    expect(gameNamesFromEnv()).toEqual(['palworld', 'satisfactory']);
  });

  it('should return an empty array when GAME_NAMES is unset', () => {
    expect(gameNamesFromEnv()).toEqual([]);
  });
});

describe('parseGameMapEnv', () => {
  it('should parse a valid JSON object env var', () => {
    process.env['GAME_MAP_TEST'] = '{"palworld":"hi"}';
    expect(parseGameMapEnv('GAME_MAP_TEST')).toEqual({ palworld: 'hi' });
  });

  it('should fall back to an empty object without throwing when the env var is malformed', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env['GAME_MAP_TEST'] = '{not json';

    expect(parseGameMapEnv('GAME_MAP_TEST')).toEqual({});
    expect(warn).toHaveBeenCalled();
  });

  it('should fall back to an empty object when the env var is unset', () => {
    expect(parseGameMapEnv('GAME_MAP_TEST')).toEqual({});
  });
});

describe('familyToGameMap', () => {
  it('should map each {game}-server family to its game name', () => {
    expect(familyToGameMap(['palworld', 'satisfactory'])).toEqual({
      'palworld-server': 'palworld',
      'satisfactory-server': 'satisfactory',
    });
  });

  it('should return an empty object for an empty game list', () => {
    expect(familyToGameMap([])).toEqual({});
  });
});
