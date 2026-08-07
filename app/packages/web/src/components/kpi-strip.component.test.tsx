import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { CostEstimates, GameStatus } from '../api.service.js';
import { KpiStrip } from './kpi-strip.component.js';

const ESTIMATES: CostEstimates = {
  games: {
    minecraft: { vcpu: 1, memoryGb: 2, costPerHour: 0.08, costPerDay24h: 1.92, costPerMonth4hpd: 9.6 },
    valheim:   { vcpu: 1, memoryGb: 2, costPerHour: 0.04, costPerDay24h: 0.96, costPerMonth4hpd: 4.8 },
  },
  totalPerHourIfAllOn: 0.12,
};

describe('KpiStrip', () => {
  it('should render Current run rate and Est. month cap tile labels instead of Spend today and Forecast MTD', () => {
    const statuses: GameStatus[] = [
      { game: 'minecraft', state: 'running' },
      { game: 'valheim', state: 'stopped' },
    ];
    render(<KpiStrip statuses={statuses} estimates={ESTIMATES} />);

    expect(screen.getByText('Current run rate')).toBeInTheDocument();
    expect(screen.getByText('Est. month cap')).toBeInTheDocument();
    expect(screen.queryByText('Spend today')).not.toBeInTheDocument();
    expect(screen.queryByText('Forecast MTD')).not.toBeInTheDocument();
  });

  it('should show $0.00 for Current run rate when no games are running', () => {
    const statuses: GameStatus[] = [{ game: 'minecraft', state: 'stopped' }];
    render(<KpiStrip statuses={statuses} estimates={ESTIMATES} />);

    expect(screen.getByText('$0.00')).toBeInTheDocument();
  });

  it('should sum costPerHour across running games for Current run rate', () => {
    const statuses: GameStatus[] = [
      { game: 'minecraft', state: 'running' },
      { game: 'valheim', state: 'stopped' },
    ];
    render(<KpiStrip statuses={statuses} estimates={ESTIMATES} />);

    // Only minecraft is running: costPerHour 0.08.
    expect(screen.getByText('$0.08')).toBeInTheDocument();
  });

  it('should compute Est. month cap as totalPerHourIfAllOn times 24 times days in the current month', () => {
    const statuses: GameStatus[] = [{ game: 'minecraft', state: 'stopped' }];
    render(<KpiStrip statuses={statuses} estimates={ESTIMATES} />);

    const now = new Date();
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const expected = `$${(0.12 * 24 * daysInMonth).toFixed(2)}`;
    expect(screen.getByText(expected)).toBeInTheDocument();
  });

  it('should render $0.00 for both cost tiles when estimates is null', () => {
    const statuses: GameStatus[] = [{ game: 'minecraft', state: 'running' }];
    render(<KpiStrip statuses={statuses} estimates={null} />);

    expect(screen.getAllByText('$0.00')).toHaveLength(2);
  });
});
