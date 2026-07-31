import { IacController } from '@hyveon/desktop-main/dist/controllers/iac.controller.js';
import { PulumiService } from '@hyveon/desktop-main/dist/services/PulumiService.js';
import { test, expect } from './index.js';

/**
 * Verifies the `orchestrator-integration-coverage` delta spec's "In-process
 * engine stub injected via DI" requirement's two DI-seam scenarios —
 * distinct from (and narrower than) the Plan/Apply/Destroy gating, ANSI-
 * preservation, and run-record-persistence coverage tracked as follow-up
 * work under task 7.11: this file only proves the DI substitution itself
 * works, not the full engine-operation surface built on top of it.
 */
test.describe('PulumiService — DI-seam substitution', () => {
  test('should dispatch a real IaC operation to the DI-substituted PulumiService stub, not a real engine', async ({
    ipc,
    serverMocks: _reset,
  }) => {
    // A real `PulumiService.mintDestroyConfirmationToken()` mints a random
    // UUID-shaped token — scripting a fixed, non-UUID-shaped string and
    // asserting the IPC response equals it exactly proves this call
    // resolved to the stub, not the real engine-backed implementation.
    ipc.mocks.pulumi.scriptDestroyToken('stub-scripted-token-for-di-seam-proof');

    const ack = await ipc.dispatch(IacController, 'mintDestroyToken');

    expect(ack).toEqual({ token: 'stub-scripted-token-for-di-seam-proof' });
  });

  test('should resolve PulumiService to the exact stub instance the harness scripts, never a real PulumiService', async ({
    ipc,
    serverMocks: _reset,
  }) => {
    // Reference equality — not just structural/behavioural similarity —
    // proves the DI container's `PulumiService` registration was replaced
    // outright, so every consumer that injects `PulumiService` (`ConfigService`,
    // `IacController`, `IacRunsController`, `DriftService`, ...) resolves this
    // exact in-memory stub. A real `PulumiService` is never constructed by
    // this harness at all, so it can never spawn a subprocess, download the
    // real engine binary, or reach real AWS.
    expect(ipc.get(PulumiService)).toBe(ipc.mocks.pulumi);
  });
});
