import { test as base } from '@playwright/test';
// Deep import into @hyveon/desktop-main's compiled `dist/`, mirroring
// `ipc-harness.ts` — the module is a process-wide singleton, so pushing here
// is visible to any `ipc` harness dispatched in the same test process.
import { mockStore } from '@hyveon/desktop-main/dist/test-mocks/mock-store.js';
import type { MockResponse } from '@hyveon/desktop-main/dist/test-mocks/mock-store.js';
import { createIpcHarness } from './ipc-harness.js';
import type { IpcHarness } from './ipc-harness.js';

export type { MockResponse };

/**
 * Playwright-side helper that pushes queued responses directly into the
 * in-process {@link mockStore} singleton — no HTTP round-trip and no
 * BrowserWindow/page involved. Each method maps to one ECS (or, for ENI lookups, EC2) command type.
 * Construct via the `serverMocks` fixture. The store itself is reset by the
 * automatic `resetMockStore` fixture, not by `serverMocks`.
 */
export class ServerMocks {
  /** Clear every queued mock response (the ECS command queues and the EC2 `DescribeNetworkInterfaces` queue) — the automatic `resetMockStore` fixture also calls it before and after each test, so call it explicitly only to clear mid-test. */
  async reset(): Promise<void> { mockStore.reset(); }

  /** Queue a response for the next ListTasksCommand call. */
  async pushListTasks(r: MockResponse): Promise<void> { mockStore.pushListTasks(r); }

  /** Queue a response for the next DescribeTasksCommand call. */
  async pushDescribeTasks(r: MockResponse): Promise<void> { mockStore.pushDescribeTasks(r); }

  /** Queue a response for the next RunTaskCommand call. */
  async pushRunTask(r: MockResponse): Promise<void> { mockStore.pushRunTask(r); }

  /** Queue a response for the next StopTaskCommand call. */
  async pushStopTask(r: MockResponse): Promise<void> { mockStore.pushStopTask(r); }

  /** Queue a response for the next EC2 DescribeNetworkInterfacesCommand call. */
  async pushDescribeNetworkInterfaces(r: MockResponse): Promise<void> { mockStore.pushDescribeNetworkInterfaces(r); }
}

type IntegrationFixtures = {
  /**
   * Automatic (`{ auto: true }`) test-scoped fixture that resets the process-wide MockStore before and after
   * every test. Playwright sets automatic fixtures up before `beforeEach` hooks, so responses a hook queues
   * through `serverMocks` or `ipc.mocks` survive into the test body, while nothing leaks between specs.
   * Never request it by name.
   */
  resetMockStore: void;
  /**
   * In-process IPC test harness — dispatches directly to `AppModule`
   * controller methods (e.g. `ipc.dispatch(GamesController, 'listStatus')`)
   * with no HTTP server and no BrowserWindow. See `./ipc-harness.js`.
   */
  ipc: IpcHarness;
  /**
   * Mock controller that pushes queued AWS SDK responses into the MockStore. It does not reset the store
   * itself — the automatic `resetMockStore` fixture does.
   */
  serverMocks: ServerMocks;
};

export const test = base.extend<IntegrationFixtures>({
  resetMockStore: [
    // eslint-disable-next-line no-empty-pattern -- Playwright fixture signature requires the deps param even when unused.
    async ({}, use) => {
      mockStore.reset();
      await use();
      mockStore.reset();
    },
    { auto: true },
  ],

  // eslint-disable-next-line no-empty-pattern -- Playwright fixture signature requires the deps param even when unused.
  ipc: async ({}, use) => {
    const harness = await createIpcHarness();
    try {
      await use(harness);
    } finally {
      await harness.close();
    }
  },

  // eslint-disable-next-line no-empty-pattern -- Playwright fixture signature requires the deps param even when unused.
  serverMocks: async ({}, use) => {
    await use(new ServerMocks());
  },
});
