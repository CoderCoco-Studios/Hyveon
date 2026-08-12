import { describe, it, expect } from 'vitest';
import { evaluateHealthCheck } from './engine.js';
import type { GameServerHealthCheck } from '@hyveon/shared';

/** Build a minimal, valid GameServerHealthCheck targeting `players.online`; override `activeWhen` per test. */
function makeConfig(activeWhen: GameServerHealthCheck['activeWhen']): GameServerHealthCheck {
  return {
    kind: 'http',
    scheme: 'http',
    port: 8211,
    path: '/status',
    method: 'GET',
    timeoutMs: 2000,
    activeWhen,
  };
}

describe('evaluateHealthCheck', () => {
  describe('non-2xx status', () => {
    it.each([100, 199, 300, 400, 404, 500, 503])('should be fail-active for status %i', (status) => {
      const config = makeConfig({ jsonPath: 'players.online', operator: 'exists' });
      const verdict = evaluateHealthCheck(config, status, '{"players":{"online":3}}');
      expect(verdict.active).toBe(true);
    });
  });

  describe('unparseable body', () => {
    it('should be fail-active when the body is not valid JSON', () => {
      const config = makeConfig({ jsonPath: 'players.online', operator: 'exists' });
      const verdict = evaluateHealthCheck(config, 200, 'not json');
      expect(verdict.active).toBe(true);
    });
  });

  describe('jsonPath resolution', () => {
    it('should resolve a nested field path', () => {
      const config = makeConfig({ jsonPath: 'players.online', operator: 'equals', value: 3 });
      const verdict = evaluateHealthCheck(config, 200, '{"players":{"online":3}}');
      expect(verdict.active).toBe(true);
    });

    it('should resolve a numeric array index', () => {
      const config = makeConfig({ jsonPath: 'items[1].name', operator: 'equals', value: 'sword' });
      const verdict = evaluateHealthCheck(config, 200, '{"items":[{"name":"shield"},{"name":"sword"}]}');
      expect(verdict.active).toBe(true);
    });

    it('should be fail-active when the path resolves to nothing', () => {
      const config = makeConfig({ jsonPath: 'players.online', operator: 'equals', value: 3 });
      const verdict = evaluateHealthCheck(config, 200, '{"players":{}}');
      expect(verdict.active).toBe(true);
    });

    it('should be fail-active when the path resolves to a non-scalar object', () => {
      const config = makeConfig({ jsonPath: 'players', operator: 'equals', value: 3 });
      const verdict = evaluateHealthCheck(config, 200, '{"players":{"online":3}}');
      expect(verdict.active).toBe(true);
    });

    it('should be fail-active when the path resolves to a non-scalar array', () => {
      const config = makeConfig({ jsonPath: 'items', operator: 'equals', value: 3 });
      const verdict = evaluateHealthCheck(config, 200, '{"items":[1,2,3]}');
      expect(verdict.active).toBe(true);
    });
  });

  describe('operator "exists"', () => {
    it('should be active when the path resolves to a value', () => {
      const config = makeConfig({ jsonPath: 'players.online', operator: 'exists' });
      const verdict = evaluateHealthCheck(config, 200, '{"players":{"online":0}}');
      expect(verdict.active).toBe(true);
    });

    it('should be idle (not fail-active) when the path resolves to nothing', () => {
      const config = makeConfig({ jsonPath: 'players.online', operator: 'exists' });
      const verdict = evaluateHealthCheck(config, 200, '{"players":{}}');
      expect(verdict.active).toBe(false);
    });
  });

  describe('operator "equals"', () => {
    it('should be active when the resolved value strictly equals the declared value', () => {
      const config = makeConfig({ jsonPath: 'status', operator: 'equals', value: 'running' });
      const verdict = evaluateHealthCheck(config, 200, '{"status":"running"}');
      expect(verdict.active).toBe(true);
    });

    it('should be idle when the resolved value does not equal the declared value', () => {
      const config = makeConfig({ jsonPath: 'status', operator: 'equals', value: 'running' });
      const verdict = evaluateHealthCheck(config, 200, '{"status":"stopped"}');
      expect(verdict.active).toBe(false);
    });

    it('should be fail-active when the resolved value is a different type than the declared value', () => {
      const config = makeConfig({ jsonPath: 'status', operator: 'equals', value: 1 });
      const verdict = evaluateHealthCheck(config, 200, '{"status":"1"}');
      expect(verdict.active).toBe(true);
    });
  });

  describe('operator "notEquals"', () => {
    it('should be active when the resolved value differs from the declared value', () => {
      const config = makeConfig({ jsonPath: 'status', operator: 'notEquals', value: 'stopped' });
      const verdict = evaluateHealthCheck(config, 200, '{"status":"running"}');
      expect(verdict.active).toBe(true);
    });

    it('should be idle when the resolved value equals the declared value', () => {
      const config = makeConfig({ jsonPath: 'status', operator: 'notEquals', value: 'stopped' });
      const verdict = evaluateHealthCheck(config, 200, '{"status":"stopped"}');
      expect(verdict.active).toBe(false);
    });

    it('should be fail-active when the resolved value is a different type than the declared value', () => {
      const config = makeConfig({ jsonPath: 'status', operator: 'notEquals', value: 1 });
      const verdict = evaluateHealthCheck(config, 200, '{"status":"1"}');
      expect(verdict.active).toBe(true);
    });
  });

  describe('operator "greaterThan"', () => {
    it('should be active when the resolved value is numerically greater', () => {
      const config = makeConfig({ jsonPath: 'players.online', operator: 'greaterThan', value: 0 });
      const verdict = evaluateHealthCheck(config, 200, '{"players":{"online":1}}');
      expect(verdict.active).toBe(true);
    });

    it('should be idle when the resolved value is not greater', () => {
      const config = makeConfig({ jsonPath: 'players.online', operator: 'greaterThan', value: 0 });
      const verdict = evaluateHealthCheck(config, 200, '{"players":{"online":0}}');
      expect(verdict.active).toBe(false);
    });

    it('should be fail-active when the resolved value does not parse as a number', () => {
      const config = makeConfig({ jsonPath: 'players.online', operator: 'greaterThan', value: 0 });
      const verdict = evaluateHealthCheck(config, 200, '{"players":{"online":"not-a-number"}}');
      expect(verdict.active).toBe(true);
    });
  });

  describe('operator "lessThan"', () => {
    it('should be active when the resolved value is numerically less', () => {
      const config = makeConfig({ jsonPath: 'players.online', operator: 'lessThan', value: 10 });
      const verdict = evaluateHealthCheck(config, 200, '{"players":{"online":1}}');
      expect(verdict.active).toBe(true);
    });

    it('should be idle when the resolved value is not less', () => {
      const config = makeConfig({ jsonPath: 'players.online', operator: 'lessThan', value: 10 });
      const verdict = evaluateHealthCheck(config, 200, '{"players":{"online":10}}');
      expect(verdict.active).toBe(false);
    });

    it('should be fail-active when the declared value does not parse as a number', () => {
      const config = makeConfig({
        jsonPath: 'players.online',
        operator: 'lessThan',
        value: 'not-a-number' as unknown as number,
      });
      const verdict = evaluateHealthCheck(config, 200, '{"players":{"online":1}}');
      expect(verdict.active).toBe(true);
    });
  });

  describe('operator "contains"', () => {
    it('should be active when the resolved string contains the declared substring', () => {
      const config = makeConfig({ jsonPath: 'motd', operator: 'contains', value: 'welcome' });
      const verdict = evaluateHealthCheck(config, 200, '{"motd":"welcome to the server"}');
      expect(verdict.active).toBe(true);
    });

    it('should be idle when the resolved string does not contain the declared substring', () => {
      const config = makeConfig({ jsonPath: 'motd', operator: 'contains', value: 'welcome' });
      const verdict = evaluateHealthCheck(config, 200, '{"motd":"goodbye"}');
      expect(verdict.active).toBe(false);
    });

    it('should be fail-active when the resolved value is not a string', () => {
      const config = makeConfig({ jsonPath: 'players.online', operator: 'contains', value: 'welcome' });
      const verdict = evaluateHealthCheck(config, 200, '{"players":{"online":3}}');
      expect(verdict.active).toBe(true);
    });
  });

  describe('reason never leaks response content', () => {
    it('should not include the resolved value in the reason for any failure or genuine verdict', () => {
      const secretValue = 'super-secret-player-name-12345';
      const cases: Array<[GameServerHealthCheck['activeWhen'], number, string]> = [
        [{ jsonPath: 'motd', operator: 'contains', value: 'welcome' }, 200, `{"motd":"${secretValue}"}`],
        [{ jsonPath: 'motd', operator: 'equals', value: secretValue }, 200, `{"motd":"${secretValue}"}`],
        [{ jsonPath: 'motd', operator: 'exists' }, 200, `{"motd":"${secretValue}"}`],
        [{ jsonPath: 'motd', operator: 'equals', value: 'other' }, 500, `{"motd":"${secretValue}"}`],
        [{ jsonPath: 'motd', operator: 'equals', value: 'other' }, 200, `not json but has ${secretValue}`],
      ];

      for (const [activeWhen, status, rawBody] of cases) {
        const verdict = evaluateHealthCheck(makeConfig(activeWhen), status, rawBody);
        expect(verdict.reason).not.toContain(secretValue);
      }
    });
  });
});
