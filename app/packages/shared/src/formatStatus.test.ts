import { describe, it, expect } from 'vitest';
import { formatGameStatus, renderConnectMessage } from './formatStatus.js';
import { HTTPS_CONNECT_PORT } from './gameServerPorts.js';

describe('formatGameStatus https connect target', () => {
  const running = { game: 'foundry', state: 'running', hostname: 'foundry.example.com' } as const;

  it('should render the https URL for a "{host}:{port}" template when the port is the https marker', () => {
    const line = formatGameStatus(running, 'join at {host}:{port}', HTTPS_CONNECT_PORT);
    expect(line).toBe('🟢 **foundry**: running\njoin at https://foundry.example.com');
  });

  it('should render a bare {port} as 443 for an https game', () => {
    const line = formatGameStatus(running, 'host {host} port {port}', HTTPS_CONNECT_PORT);
    expect(line).toBe('🟢 **foundry**: running\nhost foundry.example.com port 443');
  });

  it('should fall back to host:443 when no host is known yet', () => {
    expect(renderConnectMessage('{host}:{port}', { port: HTTPS_CONNECT_PORT, game: 'foundry' })).toBe(':443');
  });

  it('should leave a numeric 443 port on a non-https game untouched', () => {
    const line = formatGameStatus(running, 'join at {host}:{port}', 443);
    expect(line).toBe('🟢 **foundry**: running\njoin at foundry.example.com:443');
  });
});

describe('formatGameStatus', () => {
  it('should render running state with a green emoji and the hostname', () => {
    const line = formatGameStatus({ game: 'palworld', state: 'running', hostname: 'palworld.example.com' });
    expect(line).toBe('🟢 **palworld**: running — `palworld.example.com`');
  });

  it('should fall back to the public IP when no hostname is present', () => {
    const line = formatGameStatus({ game: 'palworld', state: 'running', publicIp: '1.2.3.4' });
    expect(line).toBe('🟢 **palworld**: running — `1.2.3.4`');
  });

  it('should render starting state with a yellow emoji and no address', () => {
    const line = formatGameStatus({ game: 'palworld', state: 'starting' });
    expect(line).toBe('🟡 **palworld**: starting');
  });

  it('should render stopped state with a black emoji and no address', () => {
    const line = formatGameStatus({ game: 'palworld', state: 'stopped' });
    expect(line).toBe('⚫ **palworld**: stopped');
  });

  it('should render error state with a warning emoji', () => {
    const line = formatGameStatus({ game: 'palworld', state: 'error', message: 'boom' });
    expect(line).toBe('⚠️ **palworld**: error');
  });

  it('should render not_deployed with the warning emoji since there is no task to describe', () => {
    const line = formatGameStatus({ game: 'palworld', state: 'not_deployed' });
    expect(line).toBe('⚠️ **palworld**: not_deployed');
  });

  it('should prefer hostname over publicIp when both are present', () => {
    const line = formatGameStatus({
      game: 'palworld',
      state: 'running',
      hostname: 'palworld.example.com',
      publicIp: '1.2.3.4',
    });
    expect(line).toContain('palworld.example.com');
    expect(line).not.toContain('1.2.3.4');
  });

  it('should render a connect message on a second line when provided', () => {
    const line = formatGameStatus(
      { game: 'palworld', state: 'running', hostname: 'palworld.example.com' },
      'connect in game at palworld.example.com:8211',
    );
    expect(line).toBe('🟢 **palworld**: running\nconnect in game at palworld.example.com:8211');
  });

  it('should substitute {host} placeholder with the resolved hostname', () => {
    const line = formatGameStatus(
      { game: 'palworld', state: 'running', hostname: 'palworld.example.com' },
      'connect at {host}:8211',
    );
    expect(line).toBe('🟢 **palworld**: running\nconnect at palworld.example.com:8211');
  });

  it('should substitute {ip} placeholder with the public IP', () => {
    const line = formatGameStatus(
      { game: 'palworld', state: 'running', publicIp: '1.2.3.4' },
      'direct IP: {ip}',
    );
    expect(line).toBe('🟢 **palworld**: running\ndirect IP: 1.2.3.4');
  });

  it('should substitute {port} placeholder when a port is supplied', () => {
    const line = formatGameStatus(
      { game: 'palworld', state: 'running', hostname: 'palworld.example.com' },
      'connect at {host}:{port}',
      8211,
    );
    expect(line).toBe('🟢 **palworld**: running\nconnect at palworld.example.com:8211');
  });

  it('should substitute {game} placeholder with the game name', () => {
    const line = formatGameStatus(
      { game: 'palworld', state: 'running', hostname: 'palworld.example.com' },
      '{game} server at {host}',
    );
    expect(line).toBe('🟢 **palworld**: running\npalworld server at palworld.example.com');
  });

  it('should leave {port} empty when no port is supplied', () => {
    const line = formatGameStatus(
      { game: 'palworld', state: 'running', hostname: 'palworld.example.com' },
      'connect at {host}:{port}',
    );
    expect(line).toBe('🟢 **palworld**: running\nconnect at palworld.example.com:');
  });

  it('should allow multi-line connect messages', () => {
    const line = formatGameStatus(
      { game: 'palworld', state: 'running', hostname: 'palworld.example.com' },
      'host: {host}\nport: 8211',
    );
    expect(line).toBe('🟢 **palworld**: running\nhost: palworld.example.com\nport: 8211');
  });

  it('should fall back to the inline address format when connect message is absent', () => {
    const line = formatGameStatus({ game: 'palworld', state: 'running', hostname: 'palworld.example.com' });
    expect(line).toBe('🟢 **palworld**: running — `palworld.example.com`');
  });

  it('should prefer hostname over publicIp when substituting {host}', () => {
    const line = formatGameStatus(
      { game: 'palworld', state: 'running', hostname: 'palworld.example.com', publicIp: '1.2.3.4' },
      'connect at {host}',
    );
    expect(line).toBe('🟢 **palworld**: running\nconnect at palworld.example.com');
  });

  it('should treat an empty connect message the same as absent and use the fallback format', () => {
    const line = formatGameStatus({ game: 'palworld', state: 'running', hostname: 'palworld.example.com' }, '');
    expect(line).toBe('🟢 **palworld**: running — `palworld.example.com`');
  });

  it('should ignore the connect message when state is not running', () => {
    const stopped = formatGameStatus({ game: 'palworld', state: 'stopped' }, 'connect at {host}:8211');
    expect(stopped).toBe('⚫ **palworld**: stopped');

    const starting = formatGameStatus({ game: 'palworld', state: 'starting' }, 'connect at {host}:8211');
    expect(starting).toBe('🟡 **palworld**: starting');

    const error = formatGameStatus({ game: 'palworld', state: 'error' }, 'connect at {host}:8211');
    expect(error).toBe('⚠️ **palworld**: error');
  });
});
