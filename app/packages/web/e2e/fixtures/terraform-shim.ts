import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test as base } from './server-mocks.js';
import { createIpcHarness } from './ipc-harness.js';
import type { IpcHarness } from './ipc-harness.js';

export { expect } from '@playwright/test';
export type { MockResponse, ServerMocks } from './server-mocks.js';

/**
 * Absolute path to `app/test/fake-terraform.mjs`, resolved relative to this
 * file (`app/packages/web/e2e/fixtures/`) rather than `process.cwd()`, so it
 * still resolves regardless of which directory the Playwright integration
 * config is invoked from.
 */
const FAKE_TERRAFORM_SCRIPT_PATH = fileURLToPath(
  new URL('../../../../test/fake-terraform.mjs', import.meta.url),
);

/**
 * Env vars {@link terraformFixture} mutates for the duration of a spec.
 * Snapshotted before mutation and restored verbatim in teardown so no
 * orchestrator spec's env leaks into an unrelated spec that happens to run
 * afterward in the same worker process.
 */
const MANAGED_ENV_KEYS = ['PATH', 'FAKE_TERRAFORM_SCRIPT', 'TF_DIR', 'RUNS_DIR_PATH', 'HYVEON_TFVARS_BUCKET'] as const;

/**
 * Fixed bucket name {@link terraformFixture} sets `HYVEON_TFVARS_BUCKET` to,
 * so `ConfigService.getConfigurationBucket()` resolves non-`null` and
 * `TerraformService.plan()`'s `pullVarFile()` (which requires a configured
 * bucket — there is no local-file fallback any more, see the
 * `migrate-iac-to-pulumi` change's Phase 6) can pull a configuration snapshot
 * through `ipc-harness.ts`'s installed `S3Client` mock
 * (`installRemoteFileStoreMock()`) instead of hitting real AWS.
 */
const TEST_CONFIGURATION_BUCKET = 'integration-test-config-bucket';

/**
 * Directories and paths a spec can use once {@link terraformFixture} has
 * prepended the `terraform` PATH shim and pointed `TerraformService`'s env
 * seams (`TF_DIR`/`RUNS_DIR_PATH`/`HYVEON_TFVARS_BUCKET`/`FAKE_TERRAFORM_SCRIPT`)
 * at fresh per-spec temp locations/values.
 */
export interface TerraformFixtureEnv {
  /** Directory `TerraformService` spawns `terraform` from (`TF_DIR`) — left empty; the fake binary ignores cwd contents entirely. */
  tfDir: string;
  /** Per-spec run-artifacts directory (`RUNS_DIR_PATH`) `plan`/`apply`/`destroy` write `.tfplan`/`run.json`/`terraform.log` into. */
  runsDir: string;
  /**
   * Absolute path to the JSON fixture `fake-terraform.mjs` reads via
   * `FAKE_TERRAFORM_SCRIPT` — write the scripted per-subcommand responses
   * here (see `fake-terraform.mjs`'s own TSDoc for the fixture shape) before
   * driving a run through this spec's `ipc` harness.
   */
  scriptPath: string;
}

type TerraformFixtures = {
  terraformFixture: TerraformFixtureEnv;
  ipc: IpcHarness;
};

/**
 * Playwright `test` for orchestrator integration specs — extends the shared
 * integration `test` (`ipc`/`serverMocks`) with {@link terraformFixture},
 * and overrides `ipc` so its `createIpcHarness()` call only runs *after*
 * {@link terraformFixture} has prepended the PATH shim and set the
 * `TF_DIR`/`RUNS_DIR_PATH`/`HYVEON_TFVARS_BUCKET`/`FAKE_TERRAFORM_SCRIPT` env
 * vars — `TerraformService` resolves its binary path (and reads those env
 * seams) lazily on first use, but the shim must already be in place by the
 * time anything in the built container could trigger that resolution.
 */
export const test = base.extend<TerraformFixtures>({
  // eslint-disable-next-line no-empty-pattern -- Playwright fixture signature requires the deps param even when unused.
  terraformFixture: async ({}, use) => {
    const shimDir = mkdtempSync(join(tmpdir(), 'fake-terraform-shim-'));
    const tfDir = mkdtempSync(join(tmpdir(), 'fake-terraform-tfdir-'));
    const runsDir = mkdtempSync(join(tmpdir(), 'fake-terraform-runs-'));
    const scriptPath = join(shimDir, 'fixture.json');

    // Seeded empty; specs overwrite this with their own scripted fixture
    // before driving a run.
    writeFileSync(scriptPath, JSON.stringify({}));

    const wrapperPath = join(shimDir, 'terraform');
    writeFileSync(wrapperPath, `#!/bin/sh\nexec node "${FAKE_TERRAFORM_SCRIPT_PATH}" "$@"\n`);
    chmodSync(wrapperPath, 0o755);

    const prior: Partial<Record<(typeof MANAGED_ENV_KEYS)[number], string | undefined>> = {};
    for (const key of MANAGED_ENV_KEYS) {
      prior[key] = process.env[key];
    }

    process.env['PATH'] = `${shimDir}${delimiter}${process.env['PATH'] ?? ''}`;
    process.env['FAKE_TERRAFORM_SCRIPT'] = scriptPath;
    process.env['TF_DIR'] = tfDir;
    process.env['RUNS_DIR_PATH'] = runsDir;
    // `TerraformService.plan()`'s pullVarFile() requires a configured
    // configuration bucket (no local-file fallback any more) — the pulled
    // content is never applied for real (fake-terraform ignores it), and
    // `ipc-harness.ts`'s installed S3Client mock (`remoteFileStoreMockStore`)
    // seeds a valid placeholder object under this bucket name regardless of
    // what's actually set here, so any non-empty string works.
    process.env['HYVEON_TFVARS_BUCKET'] = TEST_CONFIGURATION_BUCKET;

    await use({ tfDir, runsDir, scriptPath });

    for (const key of MANAGED_ENV_KEYS) {
      const value = prior[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    rmSync(shimDir, { recursive: true, force: true });
    rmSync(tfDir, { recursive: true, force: true });
    rmSync(runsDir, { recursive: true, force: true });
  },

  // `terraformFixture` is depended on purely for setup ordering (its own
  // value is unused here) — see this module's TSDoc for why `ipc` must not
  // build the harness until the PATH shim is in place.
  ipc: async ({ terraformFixture }, use) => {
    void terraformFixture;
    const harness = await createIpcHarness();
    await use(harness);
    await harness.close();
  },
});
