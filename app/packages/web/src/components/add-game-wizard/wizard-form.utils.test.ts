import { describe, it, expect } from 'vitest';
import {
  createEmptyWizardDraft,
  draftFromGameServer,
  draftToPayload,
  stepForIssuePath,
  validateWizardDraft,
  validateIdentityStep,
  validateResourcesStep,
  validateNetworkingStep,
  validateStorageStep,
  validateReviewStep,
  canAdvance,
  type WizardDraft,
  type WizardDraftHealthCheck,
} from './wizard-form.utils.js';
import type { RedactedGameServer } from '../../api.service.js';

/** Builds a fully-valid draft; override any fields per test. */
function makeValidDraft(overrides: Partial<WizardDraft> = {}): WizardDraft {
  return {
    ...createEmptyWizardDraft(),
    name: 'minecraft',
    image: 'itzg/minecraft-server',
    cpu: 1024,
    memory: 2048,
    ports: [{ container: 25565, protocol: 'tcp', visibility: 'public' }],
    volumes: [{ name: 'data', container_path: '/data' }],
    ...overrides,
  };
}

/** Builds a minimal existing declared GameServer entry (redacted, as read back from the IPC boundary); override any fields per test. */
function makeExistingGame(overrides: Partial<RedactedGameServer> = {}): RedactedGameServer {
  return {
    name: 'valheim',
    image: 'lloesche/valheim-server',
    cpu: 1024,
    memory: 2048,
    ports: [{ container: 2456, protocol: 'udp' }],
    volumes: [{ name: 'data', container_path: '/data' }],
    ...overrides,
  };
}

describe('createEmptyWizardDraft', () => {
  it('should return a blank draft with empty strings, null cpu/memory, and empty arrays', () => {
    expect(createEmptyWizardDraft()).toEqual({
      name: '',
      image: '',
      connect_message: '',
      cpu: null,
      memory: null,
      ports: [],
      volumes: [],
      file_seeds: [],
      environment: [],
      https: false,
      healthCheck: {
        enabled: false,
        scheme: 'http',
        port: null,
        path: '',
        method: 'GET',
        timeoutMs: 2000,
        jsonPath: '',
        operator: 'equals',
        value: '',
        authType: 'none',
        secretArn: '',
        username: '',
        password: '',
        token: '',
        secretSet: false,
      },
    });
  });
});

describe('stepForIssuePath', () => {
  it.each([
    ['name', 'identity'],
    ['image', 'identity'],
    ['connect_message', 'identity'],
    ['cpu', 'resources'],
    ['memory', 'resources'],
    ['ports', 'networking'],
    ['ports[0]', 'networking'],
    ['ports[1]', 'networking'],
    ['ports[1].protocol', 'networking'],
    ['volumes', 'storage'],
    ['volumes[0].container_path', 'storage'],
    ['file_seeds', 'storage'],
    ['file_seeds[0].path', 'storage'],
  ] as const)('should map path %s to the %s step', (path, step) => {
    expect(stepForIssuePath(path)).toBe(step);
  });

  it('should fall back to the review step for an unrecognized field family', () => {
    expect(stepForIssuePath('somethingUnknown')).toBe('review');
  });

  it('should route an environment[0].name issue to the environment step', () => {
    expect(stepForIssuePath('environment[0].name')).toBe('environment');
  });
});

describe('validateWizardDraft', () => {
  it('should return no issues for a fully valid draft', () => {
    expect(validateWizardDraft(makeValidDraft(), [])).toEqual([]);
  });
});

describe('validateIdentityStep', () => {
  it('should flag a blank name as required', () => {
    const issues = validateIdentityStep(makeValidDraft({ name: '' }), []);
    expect(issues).toContainEqual({ path: 'name', message: 'Name is required.' });
  });

  it('should flag a name containing invalid characters', () => {
    const issues = validateIdentityStep(makeValidDraft({ name: 'my game!' }), []);
    expect(issues.some((issue) => issue.path === 'name')).toBe(true);
  });

  it('should flag a name that collides with an already-declared game', () => {
    const issues = validateIdentityStep(makeValidDraft({ name: 'valheim' }), [makeExistingGame({ name: 'valheim' })]);
    expect(issues.some((issue) => issue.path === 'name' && issue.message.includes('already exists'))).toBe(true);
  });

  it("should NOT flag a legacy, non-DNS-safe name (e.g. containing an underscore) in 'edit' mode", () => {
    // Regression test for the client/server validation-rule divergence: an
    // already-declared game's name is immutable (edit forms render it
    // read-only), so 'edit' mode must skip name validation entirely rather
    // than re-running the create-time DNS-safe pattern against a legacy
    // name that predates it.
    const issues = validateIdentityStep(makeValidDraft({ name: 'My_Legacy_Server' }), [], 'edit');
    expect(issues.some((issue) => issue.path === 'name')).toBe(false);
  });

  it("should still flag the same invalid name in the default 'create' mode", () => {
    const issues = validateIdentityStep(makeValidDraft({ name: 'My_Legacy_Server' }), []);
    expect(issues.some((issue) => issue.path === 'name')).toBe(true);
  });

  it('should flag a blank image', () => {
    const issues = validateIdentityStep(makeValidDraft({ image: '' }), []);
    expect(issues.some((issue) => issue.path === 'image')).toBe(true);
  });

  it('should flag an unknown connect_message placeholder', () => {
    const issues = validateIdentityStep(makeValidDraft({ connect_message: 'Connect via {password}' }), []);
    expect(issues.some((issue) => issue.path === 'connect_message')).toBe(true);
  });

  it('should flag an unknown connect_message placeholder even when cpu/memory/volumes are still unset', () => {
    // Regression test: on a fresh Identity step, cpu/memory are null and
    // volumes is empty, so validateGameServer's structural schema parse
    // fails before it ever reaches its own connect_message check. The
    // wizard must still catch a bad placeholder here rather than letting
    // Next stay enabled and only surfacing (or not surfacing) the problem
    // at Review.
    const issues = validateIdentityStep(
      makeValidDraft({ connect_message: 'Connect via {password}', cpu: null, memory: null, volumes: [] }),
      [],
    );
    expect(issues.some((issue) => issue.path === 'connect_message')).toBe(true);
  });

  it('should pass a clean identity step', () => {
    expect(validateIdentityStep(makeValidDraft(), [])).toEqual([]);
  });

  it('should not report resources/networking/storage issues even when those fields are invalid', () => {
    const issues = validateIdentityStep(makeValidDraft({ cpu: null, ports: [], volumes: [] }), []);
    expect(issues).toEqual([]);
  });
});

describe('validateResourcesStep', () => {
  it('should flag a missing cpu', () => {
    const issues = validateResourcesStep(makeValidDraft({ cpu: null }), []);
    expect(issues.some((issue) => issue.path === 'cpu')).toBe(true);
  });

  it('should flag a missing memory', () => {
    const issues = validateResourcesStep(makeValidDraft({ memory: null }), []);
    expect(issues.some((issue) => issue.path === 'memory')).toBe(true);
  });

  it('should flag a memory value that is not a valid Fargate pairing for the chosen cpu', () => {
    const issues = validateResourcesStep(makeValidDraft({ cpu: 256, memory: 1536 }), []);
    expect(issues.some((issue) => issue.path === 'memory')).toBe(true);
  });

  it('should flag a cpu value outside the supported Fargate tiers', () => {
    const issues = validateResourcesStep(makeValidDraft({ cpu: 100, memory: 512 }), []);
    expect(issues.some((issue) => issue.path === 'cpu')).toBe(true);
  });

  it('should pass a clean resources step', () => {
    expect(validateResourcesStep(makeValidDraft(), [])).toEqual([]);
  });
});

describe('validateNetworkingStep', () => {
  it('should flag two ports within the draft that collide on container/protocol', () => {
    const issues = validateNetworkingStep(
      makeValidDraft({
        ports: [
          { container: 25565, protocol: 'tcp', visibility: 'public' },
          { container: 25565, protocol: 'TCP', visibility: 'public' },
        ],
      }),
      [],
    );
    expect(issues.some((issue) => issue.path === 'ports[1]')).toBe(true);
  });

  it('should flag a port that collides with an already-declared game (cross-game collision)', () => {
    const existing = makeExistingGame({ name: 'valheim', ports: [{ container: 25565, protocol: 'tcp' }] });
    const issues = validateNetworkingStep(
      makeValidDraft({ name: 'minecraft', ports: [{ container: 25565, protocol: 'tcp', visibility: 'public' }] }),
      [existing],
    );
    expect(issues.some((issue) => issue.path === 'ports[0]' && issue.message.includes('valheim'))).toBe(true);
  });

  it('should not flag a self-collision when re-validating an already-declared game under its own name', () => {
    const existing = makeExistingGame({ name: 'minecraft', ports: [{ container: 25565, protocol: 'tcp' }] });
    const issues = validateNetworkingStep(
      makeValidDraft({ name: 'minecraft', ports: [{ container: 25565, protocol: 'tcp', visibility: 'public' }] }),
      [existing],
    );
    expect(issues).toEqual([]);
  });

  it('should pass a clean networking step', () => {
    expect(validateNetworkingStep(makeValidDraft(), [])).toEqual([]);
  });

  it('should not report identity/resources/storage issues even when those fields are invalid', () => {
    const issues = validateNetworkingStep(makeValidDraft({ name: '', cpu: null, volumes: [] }), []);
    expect(issues).toEqual([]);
  });

  it('should flag an https first port that is not tcp even while volumes is still empty (wizard Networking-before-Storage ordering)', () => {
    // Regression: on a fresh wizard, Networking is reached before Storage
    // supplies `volumes`, so the structural schema parse always fails on
    // the empty volumes array. The HTTPS rules must not be silently
    // skipped as a result — they only depend on `ports`/`https`.
    const issues = validateNetworkingStep(
      makeValidDraft({ https: true, ports: [{ container: 8080, protocol: 'udp', visibility: 'public' }], volumes: [] }),
      [],
    );
    expect(issues.some((issue) => issue.path === 'ports[0]')).toBe(true);
  });

  it('should flag an https game with no ports even while volumes is still empty', () => {
    const issues = validateNetworkingStep(makeValidDraft({ https: true, ports: [], volumes: [] }), []);
    expect(
      issues.some((issue) => issue.path === 'ports' && issue.message.includes('at least one port')),
    ).toBe(true);
  });
});

describe('validateStorageStep', () => {
  it('should flag an empty volumes array (volumes-min-1 rule)', () => {
    const issues = validateStorageStep(makeValidDraft({ volumes: [] }), []);
    expect(issues.some((issue) => issue.path === 'volumes')).toBe(true);
  });

  it('should flag a relative volumes[].container_path', () => {
    const issues = validateStorageStep(makeValidDraft({ volumes: [{ name: 'data', container_path: 'data' }] }), []);
    expect(issues.some((issue) => issue.path === 'volumes[0].container_path')).toBe(true);
  });

  it('should flag a relative file_seeds[].path', () => {
    const issues = validateStorageStep(
      makeValidDraft({ file_seeds: [{ path: 'config.yml', content: 'foo: bar', content_base64: '', mode: '' }] }),
      [],
    );
    expect(issues.some((issue) => issue.path === 'file_seeds[0].path')).toBe(true);
  });

  it('should pass a clean storage step', () => {
    expect(validateStorageStep(makeValidDraft(), [])).toEqual([]);
  });
});

describe('validateReviewStep', () => {
  it('should aggregate issues from every step', () => {
    // `name` (checked outside the shared schema) and `volumes` (a zod
    // structural failure) are both evaluated regardless of whether the rest
    // of the entry parses, so combining them here proves aggregation works
    // across the "always runs" and "schema-gated" halves of validateWizardDraft.
    const issues = validateReviewStep(makeValidDraft({ name: '', volumes: [] }), []);
    expect(issues.some((issue) => issue.path === 'name')).toBe(true);
    expect(issues.some((issue) => issue.path === 'volumes')).toBe(true);
  });

  it('should pass a clean review step', () => {
    expect(validateReviewStep(makeValidDraft(), [])).toEqual([]);
  });
});

describe('draftFromGameServer / draftToPayload round-trip', () => {
  it('should round-trip a fully-populated GameServer through draftFromGameServer and back through draftToPayload', () => {
    const game = makeExistingGame({
      name: 'minecraft',
      image: 'itzg/minecraft-server',
      cpu: 1024,
      memory: 2048,
      ports: [{ container: 25565, protocol: 'tcp' }],
      volumes: [{ name: 'data', container_path: '/data' }],
      connect_message: 'Connect at {ip}:{port}',
      file_seeds: [{ path: '/data/config.yml', content: 'foo: bar', content_base64: 'Zm9v', mode: '0644' }],
      https: true,
    });

    const draft = draftFromGameServer(game);
    const payload = draftToPayload(draft);

    expect(payload).toEqual({
      name: game.name,
      config: {
        image: game.image,
        cpu: game.cpu,
        memory: game.memory,
        ports: game.ports,
        volumes: game.volumes,
        connect_message: game.connect_message,
        file_seeds: game.file_seeds,
        https: true,
      },
    });
  });

  it('should round-trip a minimal GameServer (no connect_message/file_seeds) with those fields left undefined', () => {
    const game = makeExistingGame({ name: 'valheim' });

    const draft = draftFromGameServer(game);
    const payload = draftToPayload(draft);

    expect(payload).toEqual({
      name: game.name,
      config: {
        image: game.image,
        cpu: game.cpu,
        memory: game.memory,
        ports: game.ports,
        volumes: game.volumes,
        connect_message: undefined,
        file_seeds: undefined,
        https: false,
      },
    });
  });

  it('should produce a draft with empty-string fallbacks for optional GameServer fields that are unset', () => {
    const game = makeExistingGame({ name: 'valheim', connect_message: undefined, file_seeds: undefined });

    expect(draftFromGameServer(game)).toEqual({
      name: game.name,
      image: game.image,
      connect_message: '',
      cpu: game.cpu,
      memory: game.memory,
      ports: game.ports.map((port) => ({ ...port, visibility: 'public' })),
      volumes: game.volumes,
      file_seeds: [],
      environment: [],
      https: false,
      healthCheck: {
        enabled: false,
        scheme: 'http',
        port: null,
        path: '',
        method: 'GET',
        timeoutMs: 2000,
        jsonPath: '',
        operator: 'equals',
        value: '',
        authType: 'none',
        secretArn: '',
        username: '',
        password: '',
        token: '',
        secretSet: false,
      },
    });
  });

  it.each([
    ['raw' as const, 'raw' as const],
    ['basic' as const, 'basic' as const],
    ['bearer' as const, 'bearer' as const],
  ])('should restore authType %s from the redacted authType on a configured credential', (persistedType, expectedAuthType) => {
    const game = makeExistingGame({
      name: 'palworld',
      healthCheck: {
        kind: 'http',
        scheme: 'http',
        port: 8211,
        path: '/status',
        method: 'GET',
        timeoutMs: 2000,
        jsonPath: '',
        operator: 'equals',
        activeWhen: { jsonPath: '', operator: 'equals' },
        secretSet: true,
        authType: persistedType,
      } as unknown as RedactedGameServer['healthCheck'],
    });

    const draft = draftFromGameServer(game);

    expect(draft.healthCheck.authType).toBe(expectedAuthType);
  });

  it('should fall back to "raw" authType when secretSet but no authType is present (legacy redacted shape)', () => {
    const game = makeExistingGame({
      name: 'palworld',
      healthCheck: {
        kind: 'http',
        scheme: 'http',
        port: 8211,
        path: '/status',
        method: 'GET',
        timeoutMs: 2000,
        activeWhen: { jsonPath: '', operator: 'equals' },
        secretSet: true,
      } as unknown as RedactedGameServer['healthCheck'],
    });

    const draft = draftFromGameServer(game);

    expect(draft.healthCheck.authType).toBe('raw');
  });

  it('should map environment rows from a GameServer onto the draft', () => {
    const draft = draftFromGameServer({
      name: 'mygame',
      image: 'itzg/minecraft-server',
      cpu: 1024,
      memory: 2048,
      ports: [],
      volumes: [{ name: 'data', container_path: '/data' }],
      environment: [{ name: 'EULA', value: 'TRUE' }],
    });
    expect(draft.environment).toEqual([{ name: 'EULA', value: 'TRUE' }]);
  });

  it('should default environment to an empty array when the GameServer has none declared', () => {
    const draft = draftFromGameServer({
      name: 'mygame',
      image: 'itzg/minecraft-server',
      cpu: 1024,
      memory: 2048,
      ports: [],
      volumes: [{ name: 'data', container_path: '/data' }],
    });
    expect(draft.environment).toEqual([]);
  });

  it('should include environment rows in the create payload when present', () => {
    const draft = { ...createEmptyWizardDraft(), environment: [{ name: 'EULA', value: 'TRUE' }] };
    expect(draftToPayload(draft).config.environment).toEqual([{ name: 'EULA', value: 'TRUE' }]);
  });

  it('should omit environment from the create payload when empty', () => {
    const draft = createEmptyWizardDraft();
    expect(draftToPayload(draft).config.environment).toBeUndefined();
  });

  it('should default https to false when the declared GameServer omits the flag', () => {
    const game = makeExistingGame({ name: 'valheim', https: undefined });

    const draft = draftFromGameServer(game);
    expect(draft.https).toBe(false);

    const payload = draftToPayload(draft);
    expect(payload.config.https).toBe(false);
  });

  it('should coerce a non-boolean parsed https value (an unevaluated hcl2json expression) to false', () => {
    // `@cdktf/hcl2json` doesn't evaluate expressions, so a hand-written
    // `https = length(x) > 0 ? true : false` parses back as a string. The
    // draft must show false rather than a truthy checkbox (design D6).
    const game = makeExistingGame({
      name: 'valheim',
      https: 'length(x) > 0 ? true : false',
    } as unknown as Partial<RedactedGameServer>);

    const draft = draftFromGameServer(game);
    expect(draft.https).toBe(false);
  });
});

describe('port visibility round-trip', () => {
  it('should read visibility "internal" from a declared game via draftFromGameServer', () => {
    const game = {
      name: 'palworld',
      image: 'example/palworld:latest',
      cpu: 1024,
      memory: 2048,
      ports: [
        { container: 8211, protocol: 'udp', visibility: 'public' as const },
        { container: 8212, protocol: 'tcp', visibility: 'internal' as const },
      ],
      volumes: [{ name: 'saves', container_path: '/data' }],
    } as Partial<RedactedGameServer> as RedactedGameServer;
    const draft = draftFromGameServer(game);
    expect(draft.ports).toEqual([
      { container: 8211, protocol: 'udp', visibility: 'public' },
      { container: 8212, protocol: 'tcp', visibility: 'internal' },
    ]);
  });

  it('should default visibility to "public" when reading a declared port with visibility omitted', () => {
    const game = {
      name: 'palworld',
      image: 'example/palworld:latest',
      cpu: 1024,
      memory: 2048,
      ports: [{ container: 8211, protocol: 'udp' }],
      volumes: [{ name: 'saves', container_path: '/data' }],
    } as Partial<RedactedGameServer> as RedactedGameServer;
    const draft = draftFromGameServer(game);
    expect(draft.ports).toEqual([{ container: 8211, protocol: 'udp', visibility: 'public' }]);
  });

  it('should submit visibility "internal" as-is and omit visibility entirely for "public" ports in draftToPayload', () => {
    const draft = {
      ...createEmptyWizardDraft(),
      name: 'palworld',
      image: 'example/palworld:latest',
      cpu: 1024,
      memory: 2048,
      ports: [
        { container: 8211, protocol: 'udp', visibility: 'public' as const },
        { container: 8212, protocol: 'tcp', visibility: 'internal' as const },
      ],
      volumes: [{ name: 'saves', container_path: '/data' }],
    };
    const payload = draftToPayload(draft);
    expect(payload.config.ports).toEqual([
      { container: 8211, protocol: 'udp' },
      { container: 8212, protocol: 'tcp', visibility: 'internal' },
    ]);
  });
});

describe('health-check auth draft conversion', () => {
  /** Builds a draft with an enabled health check; override any `healthCheck` field per test. */
  function draftWithHealthCheck(overrides: Partial<WizardDraftHealthCheck> = {}): WizardDraft {
    const draft = createEmptyWizardDraft();
    return {
      ...draft,
      ports: [{ container: 25565, protocol: 'tcp', visibility: 'public' as const }],
      healthCheck: {
        ...draft.healthCheck,
        enabled: true,
        port: 25565,
        path: '/status',
        jsonPath: 'players.online',
        operator: 'exists',
        authType: 'none',
        username: '',
        password: '',
        token: '',
        ...overrides,
      },
    };
  }

  it('should submit auth: undefined when authType is "none" and no credential was previously set', () => {
    const payload = draftToPayload(draftWithHealthCheck());
    expect(payload.config.healthCheck?.auth).toBeUndefined();
  });

  it('should submit auth: null when authType is "none" and a credential was previously set (explicit clear)', () => {
    const payload = draftToPayload(draftWithHealthCheck({ secretSet: true }));
    expect(payload.config.healthCheck?.auth).toBeNull();
  });

  it('should submit a raw auth write-input when authType is "raw" with a non-blank secretArn', () => {
    const payload = draftToPayload(
      draftWithHealthCheck({ authType: 'raw', secretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:foo-AbCdEf' }),
    );
    expect(payload.config.healthCheck?.auth).toEqual({
      type: 'raw',
      secretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:foo-AbCdEf',
    });
  });

  it('should submit a basic auth write-input when authType is "basic" with username and password', () => {
    const payload = draftToPayload(draftWithHealthCheck({ authType: 'basic', username: 'admin', password: 'hunter2' }));
    expect(payload.config.healthCheck?.auth).toEqual({ type: 'basic', username: 'admin', password: 'hunter2' });
  });

  it('should submit a bearer auth write-input when authType is "bearer" with a token', () => {
    const payload = draftToPayload(draftWithHealthCheck({ authType: 'bearer', token: 'sk-abc123' }));
    expect(payload.config.healthCheck?.auth).toEqual({ type: 'bearer', token: 'sk-abc123' });
  });

  it('should submit auth: undefined when authType is "basic" but both fields are blank (edit, unchanged)', () => {
    const payload = draftToPayload(draftWithHealthCheck({ authType: 'basic', username: '', password: '', secretSet: true }));
    expect(payload.config.healthCheck?.auth).toBeUndefined();
  });

  it('should flag a missing password on the networking step when authType is "basic" with only a username', () => {
    const issues = validateNetworkingStep(draftWithHealthCheck({ authType: 'basic', username: 'admin' }), []);
    expect(issues.some((i) => i.path === 'healthCheck.auth.password')).toBe(true);
  });

  it('should raise no networking-step issues when authType is "none" and a credential was previously set (explicit clear)', () => {
    // Regression test: toStructuralHealthCheckPreview must strip a `null`
    // auth (explicit clear) the same way it strips `basic`/`bearer`, not
    // just treat it as "keep as-is" alongside `undefined`. Before the fix,
    // the structural preview kept `auth: null` attached, which
    // validateGameServer's schema (auth as an optional object) rejects —
    // silently blocking the wizard's Next/Submit button for this case.
    const issues = validateNetworkingStep(draftWithHealthCheck({ authType: 'none', secretSet: true }), []);
    expect(issues).toEqual([]);
  });
});

describe('canAdvance', () => {
  it('should return true for a step with no outstanding issues', () => {
    expect(canAdvance('resources', makeValidDraft(), [])).toBe(true);
  });

  it('should return false for a step with an outstanding issue', () => {
    expect(canAdvance('resources', makeValidDraft({ cpu: null }), [])).toBe(false);
  });
});
