import { describe, it, expect } from 'vitest';
import { findWebPortCollisions, normalizeDeploymentConfigGames, normalizeGameServer, ingressPorts, isReservedHttpsPort, HTTPS_RESERVED_PORTS } from './gameServerPorts.js';
import type { DeploymentConfig } from './deploymentConfig.js';
import { withDeploymentConfigDefaults } from './deploymentConfig.js';
import type { GameServerConfig } from './gameServerConfig.js';

/** Builds a minimal valid {@link GameServerConfig}, with `overrides` applied on top. */
function makeGame(overrides: Partial<GameServerConfig> = {}): GameServerConfig {
  return {
    image: 'img',
    cpu: 1024,
    memory: 2048,
    ports: [],
    volumes: [{ name: 'data', container_path: '/data' }],
    ...overrides,
  };
}

/** Builds a complete {@link DeploymentConfig} holding `gameServers`, defaults filling every other field. */
function makeConfig(gameServers: Record<string, GameServerConfig>): DeploymentConfig {
  return withDeploymentConfigDefaults({ hostedZoneName: 'example.com', gameServers });
}

// @spec GAME-HTTPS-015, GAME-HTTPS-016
describe('normalizeGameServer', () => {
  it('should return a malformed https game with no ports array untouched', () => {
    const malformed = { ...makeGame({ https: true }), ports: undefined } as unknown as GameServerConfig;
    expect(normalizeGameServer(malformed)).toBe(malformed);
  });

  it('should leave an https draft with a null webPort alone so its extra port rows survive', () => {
    const draft = { https: true, webPort: null, ports: [{ container: 27015, protocol: 'tcp' }] };

    expect(normalizeGameServer(draft)).toBe(draft);
  });

  it('should promote ports[0] to webPort and keep the rest as extras for a legacy https game', () => {
    const legacy = makeGame({
      https: true,
      ports: [
        { container: 8080, protocol: 'tcp' },
        { container: 27015, protocol: 'udp' },
      ],
    });
    const result = normalizeGameServer(legacy);
    expect(result.webPort).toBe(8080);
    expect(result.ports).toEqual([{ container: 27015, protocol: 'udp' }]);
  });

  it('should leave ports empty when a legacy https game had exactly one port', () => {
    const result = normalizeGameServer(makeGame({ https: true, ports: [{ container: 30000, protocol: 'tcp' }] }));
    expect(result.webPort).toBe(30000);
    expect(result.ports).toEqual([]);
  });

  it('should not mutate its input', () => {
    const legacy = makeGame({ https: true, ports: [{ container: 8080, protocol: 'tcp' }] });
    normalizeGameServer(legacy);
    expect(legacy.webPort).toBeUndefined();
    expect(legacy.ports).toHaveLength(1);
  });

  it('should return an already-normalised https game unchanged', () => {
    const game = makeGame({ https: true, webPort: 30000, ports: [{ container: 27015, protocol: 'udp' }] });
    expect(normalizeGameServer(game)).toBe(game);
  });

  it('should return a non-https game unchanged', () => {
    const game = makeGame({ ports: [{ container: 25565, protocol: 'tcp' }] });
    expect(normalizeGameServer(game)).toBe(game);
  });

  it('should be idempotent', () => {
    const legacy = makeGame({
      https: true,
      ports: [
        { container: 8080, protocol: 'tcp' },
        { container: 27015, protocol: 'udp' },
      ],
    });
    const once = normalizeGameServer(legacy);
    expect(normalizeGameServer(once)).toEqual(once);
  });

  // @spec GAME-HTTPS-017
  it('should leave a legacy https game with a non-tcp ports[0] untouched so the validator reports it', () => {
    const game = makeGame({ https: true, ports: [{ container: 7777, protocol: 'udp' }] });
    expect(normalizeGameServer(game)).toBe(game);
  });

  it('should leave a legacy https game with no ports untouched', () => {
    const game = makeGame({ https: true, ports: [] });
    expect(normalizeGameServer(game)).toBe(game);
  });

  it('should promote a reserved ports[0] (443) without crashing so the validator rejects it on save', () => {
    const result = normalizeGameServer(makeGame({ https: true, ports: [{ container: 443, protocol: 'tcp' }] }));
    expect(result.webPort).toBe(443);
  });

  it('should leave a draft with an unset ports[0] container untouched', () => {
    const draft = { https: true, ports: [{ container: null, protocol: 'tcp' }] };
    expect(normalizeGameServer(draft)).toBe(draft);
  });
});

// @spec GAME-PORT-004
describe('ingressPorts', () => {
  it('should return every port of a non-https game', () => {
    const ports = [
      { container: 25565, protocol: 'tcp' },
      { container: 8, protocol: 'icmp' },
    ];
    expect(ingressPorts(makeGame({ ports }))).toEqual(ports);
  });

  it('should return the https extras and never the webPort', () => {
    const game = makeGame({
      https: true,
      webPort: 30000,
      ports: [
        { container: 27015, protocol: 'udp' },
        { container: 30000, protocol: 'tcp' },
      ],
    });
    expect(ingressPorts(game)).toEqual([{ container: 27015, protocol: 'udp' }]);
  });

  it('should return an empty list for an https game with no extras', () => {
    expect(ingressPorts(makeGame({ https: true, webPort: 30000 }))).toEqual([]);
  });
});

describe('isReservedHttpsPort', () => {
  it('should flag 80 and 443 only', () => {
    expect(HTTPS_RESERVED_PORTS).toEqual([80, 443]);
    expect(isReservedHttpsPort(80)).toBe(true);
    expect(isReservedHttpsPort(443)).toBe(true);
    expect(isReservedHttpsPort(8080)).toBe(false);
  });
});

describe('normalizeDeploymentConfigGames', () => {
  it('should normalise legacy https entries and leave other entries untouched', () => {
    const legacy = makeGame({ https: true, ports: [{ container: 8080, protocol: 'tcp' }, { container: 27015, protocol: 'udp' }] });
    const plain = makeGame({ https: false });
    const config = makeConfig({ a: legacy, b: plain });

    const result = normalizeDeploymentConfigGames(config);

    expect(result.gameServers.a).toMatchObject({ webPort: 8080, ports: [{ container: 27015, protocol: 'udp' }] });
    expect(result.gameServers.b).toBe(plain);
  });

  it('should return the same object when no entry needs normalising', () => {
    const config = makeConfig({ b: makeGame({ https: false }) });

    expect(normalizeDeploymentConfigGames(config)).toBe(config);
  });

  it('should keep a legacy __proto__ game key as an own property', () => {
    const raw = JSON.parse(
      '{"__proto__":{"image":"img","cpu":1,"memory":1,"https":true,"ports":[{"container":8080,"protocol":"tcp"}],"volumes":[]}}',
    ) as DeploymentConfig['gameServers'];

    const result = normalizeDeploymentConfigGames(makeConfig(raw));

    expect(Object.keys(result.gameServers)).toEqual(['__proto__']);
    expect(Object.getOwnPropertyDescriptor(result.gameServers, '__proto__')?.value).toMatchObject({ webPort: 8080, ports: [] });
  });
});

// @spec GAME-HTTPS-010
describe('findWebPortCollisions', () => {
  it('should report an https webPort that is another game\'s extra tcp port', () => {
    const config = makeConfig({
      web: makeGame({ https: true, webPort: 30000 }),
      other: makeGame({ ports: [{ container: 30000, protocol: 'TCP' }] }),
    });

    expect(findWebPortCollisions(config)).toEqual([expect.stringContaining('"web" webPort 30000 collides with tcp port 30000 on game "other"')]);
  });

  it('should ignore udp ports, the same game\'s own ports, and non-colliding configs', () => {
    const config = makeConfig({
      web: makeGame({ https: true, webPort: 30000, ports: [{ container: 30000, protocol: 'tcp' }] }),
      other: makeGame({ ports: [{ container: 30000, protocol: 'udp' }] }),
    });

    expect(findWebPortCollisions(config)).toEqual([]);
  });
});
