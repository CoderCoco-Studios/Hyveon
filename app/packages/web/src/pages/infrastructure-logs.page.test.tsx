import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderPage } from '../test-utils/render-page.utils.js';
import { toStreamHandleMock } from '../test-utils/stream-handle.test-utils.js';

// Mock the API client so the component drives off canned data instead of real
// fetch calls. `vi.mock` is hoisted above the import so InfrastructureLogsPage
// picks up the stub. `games`/`status`/`costsEstimate` are stubbed because
// `renderPage()` wraps every render in `GameStatusProvider`, which calls all
// three on mount even though this page itself never touches games.
const apiMock = vi.hoisted(() => ({
  games: vi.fn(),
  status: vi.fn(),
  costsEstimate: vi.fn(),
}));
vi.mock('../api.service.js', () => ({
  api: apiMock,
}));

// Stub window.hyveon.logs.lambda so the component can open IPC streams
// without a real Electron main process. `stream(functionKey)` returns a
// `HyveonStreamHandle` (see `toStreamHandleMock`); the default stub (set in
// beforeEach) yields nothing so tests drive off the seeded `get` snapshot.
const hyveonMock = {
  logs: { lambda: { get: vi.fn(), stream: vi.fn() } },
};
vi.stubGlobal('hyveon', hyveonMock);

import { InfrastructureLogsPage } from './infrastructure-logs.page.js';

describe('InfrastructureLogsPage', () => {
  beforeEach(() => {
    apiMock.games.mockResolvedValue({ games: [] });
    apiMock.status.mockResolvedValue([]);
    apiMock.costsEstimate.mockResolvedValue({ games: {}, totalPerHourIfAllOn: 0 });
    hyveonMock.logs.lambda.get.mockResolvedValue({ functionKey: 'watchdog', lines: ['seeded'] });
    hyveonMock.logs.lambda.stream.mockImplementation(toStreamHandleMock(async function* () {}));
  });

  it('should render a heading and all 5 function options in the picker', async () => {
    renderPage(<InfrastructureLogsPage />);

    expect(await screen.findByRole('heading', { name: /infrastructure logs/i })).toBeInTheDocument();
    for (const label of ['watchdog', 'health-check', 'dns-updater', 'interactions', 'followup']) {
      expect(screen.getByRole('button', { name: new RegExp(label, 'i') })).toBeInTheDocument();
    }
  });

  it('should default to watchdog and call logs.lambda.get on mount', async () => {
    renderPage(<InfrastructureLogsPage />);

    await waitFor(() => expect(hyveonMock.logs.lambda.get).toHaveBeenCalledWith('watchdog'));
  });

  it('should call logs.lambda.get with the newly picked function after switching', async () => {
    renderPage(<InfrastructureLogsPage />);
    await waitFor(() => expect(hyveonMock.logs.lambda.get).toHaveBeenCalledWith('watchdog'));

    await userEvent.setup().click(screen.getByRole('button', { name: /health-check/i }));

    await waitFor(() => expect(hyveonMock.logs.lambda.get).toHaveBeenCalledWith('health-check'));
  });

  it('should cancel the previous stream handle when switching functions', async () => {
    const handle1 = {
      next: vi.fn(),
      cancel: vi.fn(),
      [Symbol.asyncIterator]: function () {
        return this;
      },
    };
    hyveonMock.logs.lambda.stream.mockReturnValueOnce(handle1);
    renderPage(<InfrastructureLogsPage />);
    await waitFor(() => expect(hyveonMock.logs.lambda.stream).toHaveBeenCalledWith('watchdog'));

    await userEvent.setup().click(screen.getByRole('button', { name: /followup/i }));

    await waitFor(() => expect(handle1.cancel).toHaveBeenCalled());
  });
});
