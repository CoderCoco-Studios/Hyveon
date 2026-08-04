import { IacController } from '@hyveon/desktop-main/dist/controllers/iac.controller.js';
import { test, expect, DEFAULT_STACK_OUTPUTS } from './index.js';

/**
 * Verifies the `orchestrator-integration-coverage` delta spec's "Stack
 * outputs integration coverage" requirement: the `iac.output` IPC channel
 * (`IacController.output`), dispatched through the real controller wiring,
 * reads outputs via the stubbed `PulumiService.getStackOutputs()` and
 * returns them verbatim — degrading to a "not deployed yet" `null` result,
 * rather than throwing, for a stack that has never been deployed.
 */
test.describe('Stack outputs — iac.output channel', () => {
  test('should return the scripted stack outputs verbatim', async ({ ipc, serverMocks: _reset }) => {
    ipc.mocks.pulumi.scriptStackOutputs(DEFAULT_STACK_OUTPUTS);

    const outputs = await ipc.dispatch(IacController, 'output', {});

    expect(outputs).toEqual(DEFAULT_STACK_OUTPUTS);
  });

  test('should resolve null rather than throwing for a never-deployed stack', async ({ ipc, serverMocks: _reset }) => {
    // The stub's default (no `scriptStackOutputs` call) already models a
    // never-deployed stack — scripted explicitly here so the test's intent
    // doesn't depend on remembering that default.
    ipc.mocks.pulumi.scriptStackOutputs(null);

    const outputs = await ipc.dispatch(IacController, 'output', {});

    expect(outputs).toBeNull();
  });
});
