/**
 * Shared `DeploymentConfigService`/`GameServer` test fixtures for `@hyveon/desktop-main` specs.
 * `makeDeploymentConfig(): DeploymentConfigService` was redefined 7 times and
 * `buildGameServer(name, overrides)` 4 times, plus 14 files with inline `gameServers: {`
 * literals (issue #557 finding 64) — the same "one new field breaks every call site" exposure
 * as `StackOutputs` (finding 60). Scoped to `@hyveon/desktop-main` only: `@hyveon/infra` keeps
 * its own `testing/fixtures.ts` (a different shape — a full `DeploymentConfig`, not a service
 * stub), and the handful of other packages' inline literals are left as-is.
 */

import { vi } from 'vitest';
import type { GameServer } from '@hyveon/shared';
import type { DeploymentConfigService } from '../services/DeploymentConfigService.js';

/**
 * Builds a minimal, valid {@link GameServer} fixture for a single declared game.
 *
 * @param name - The game's name.
 * @param overrides - Fields to override on top of a representative default configuration.
 * @returns A complete {@link GameServer}.
 */
export function gameServer(name: string, overrides: Partial<GameServer> = {}): GameServer {
  return {
    name,
    image: 'example/image:latest',
    cpu: 1024,
    memory: 2048,
    ports: [{ container: 25565, protocol: 'tcp' }],
    volumes: [{ name: 'saves', container_path: '/data' }],
    ...overrides,
  };
}

/**
 * Builds a {@link DeploymentConfigService} stub. `getGameServers()` and `getTopLevelSettings()`
 * are pre-wired from `declared`/`projectName` since almost every spec needs one or the other;
 * pass `overrides` for any other stubbed method (`addGameServer`, `updateGameServer`,
 * `removeGameServer`, `updateTopLevelSettings`, `invalidateCache`, ...) an individual spec needs.
 *
 * @param options - `declared` is the value `getGameServers()` resolves to (defaults to `[]`).
 *   `projectName` becomes the `projectName` field of `getTopLevelSettings()`'s resolved
 *   `settings`, omitted from `settings` when unset.
 * @param overrides - Additional `DeploymentConfigService` method stubs, merged in last so they
 *   win over the `declared`/`projectName` defaults above.
 * @returns A `Partial<DeploymentConfigService>` cast to `DeploymentConfigService`.
 */
export function deploymentConfigStub(
  { declared = [], projectName }: { declared?: GameServer[]; projectName?: string } = {},
  overrides: Partial<DeploymentConfigService> = {},
): DeploymentConfigService {
  const stub: Partial<DeploymentConfigService> = {
    invalidateCache: vi.fn(),
    getGameServers: vi.fn().mockResolvedValue(declared),
    getTopLevelSettings: vi.fn().mockResolvedValue({ settings: projectName ? { projectName } : {} }),
    ...overrides,
  };
  return stub as DeploymentConfigService;
}
