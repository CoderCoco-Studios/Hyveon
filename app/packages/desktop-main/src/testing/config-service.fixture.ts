/**
 * Shared `ConfigService` test stub for `@hyveon/desktop-main` specs. `makeConfig(): ConfigService`
 * was redefined in ~18 files across four different styles — including an `as unknown as T` cast,
 * banned by this repo's TypeScript conventions — each exposing the same three methods (issue #557
 * finding 63). Centralizes it here, paired with {@link stackOutputs} for its default return value.
 */

import { vi } from 'vitest';
import type { StackOutputs } from '@hyveon/shared';
import type { ConfigService } from '../services/ConfigService.js';
import { stackOutputs } from './stack-outputs.fixture.js';

/**
 * Builds a minimal {@link ConfigService} stub exposing just `getStackOutputs`, `getRegion`, and
 * `invalidateCache` — the methods desktop-main specs actually call.
 *
 * @param options - `outputs` is the value `getStackOutputs()` resolves to (defaults to
 *   {@link stackOutputs}(); pass `null` to simulate "nothing has been deployed yet").
 *   `region` is the value `getRegion()` returns (defaults to `'us-east-1'`).
 * @returns A `Partial<ConfigService>` cast to `ConfigService`.
 */
export function configServiceStub({
  outputs = stackOutputs(),
  region = 'us-east-1',
}: { outputs?: StackOutputs | null; region?: string } = {}): ConfigService {
  const stub: Partial<ConfigService> = {
    getRegion: () => region,
    getStackOutputs: async () => outputs,
    invalidateCache: vi.fn(),
  };
  return stub as ConfigService;
}
