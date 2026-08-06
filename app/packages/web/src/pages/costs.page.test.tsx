import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';

const apiMock = vi.hoisted(() => ({
  status: vi.fn(),
  costsEstimate: vi.fn(),
}));
vi.mock('../api.service.js', () => ({ api: apiMock }));

import { CostsPage } from './costs.page.js';
import { renderPage } from '../test-utils/render-page.utils.js';

const ESTIMATES = {
  games: {
    minecraft: { vcpu: 1, memoryGb: 2, costPerHour: 0.08, costPerDay24h: 1.92, costPerMonth4hpd: 9.6 },
    valheim:   { vcpu: 1, memoryGb: 2, costPerHour: 0.04, costPerDay24h: 0.96, costPerMonth4hpd: 4.8 },
  },
  totalPerHourIfAllOn: 0.12,
};

describe('CostsPage', () => {
  beforeEach(() => {
    apiMock.status.mockResolvedValue([]);
    apiMock.costsEstimate.mockResolvedValue(ESTIMATES);
  });

  it('should render the Cost Analysis heading and the polling indicator wired to the status poll', async () => {
    renderPage(<CostsPage />, { initialEntries: ['/costs'] });

    expect(screen.getByRole('heading', { name: 'Cost Analysis' })).toBeInTheDocument();
    expect(await screen.findByText(/^Updated\b/)).toBeInTheDocument();
  });

  it('should render every configured game in the estimates table once the data resolves', async () => {
    renderPage(<CostsPage />, { initialEntries: ['/costs'] });

    expect(await screen.findByRole('cell', { name: 'minecraft' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'valheim' })).toBeInTheDocument();
  });

  it('should render no actual-spend total, delta pill, or stacked chart', async () => {
    renderPage(<CostsPage />, { initialEntries: ['/costs'] });

    await screen.findByRole('cell', { name: 'minecraft' });

    expect(screen.queryByText(/Total spend/)).not.toBeInTheDocument();
    expect(screen.queryByText(/vs prior|no prior period/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Daily spend, stacked by game/)).not.toBeInTheDocument();
  });
});
