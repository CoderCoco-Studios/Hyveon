import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WatchdogPanel } from './watchdog-panel.component.js';

const apiMock = vi.hoisted(() => ({
  config: vi.fn(),
  saveConfig: vi.fn(),
}));
vi.mock('../api.service.js', () => ({ api: apiMock }));

const toastMock = vi.hoisted(() =>
  Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
);
vi.mock('sonner', () => ({ toast: toastMock }));

/** Default config returned by the mocked `api.config()`. */
const DEFAULT_CONFIG = {
  watchdog_interval_minutes: 15,
  watchdog_idle_checks: 4,
  watchdog_min_packets: 100,
};

describe('WatchdogPanel', () => {
  beforeEach(() => {
    apiMock.config.mockReset().mockResolvedValue(DEFAULT_CONFIG);
    apiMock.saveConfig.mockReset().mockResolvedValue(undefined);
    toastMock.success.mockClear();
    toastMock.error.mockClear();
  });

  it('should render the Watchdog Settings heading', () => {
    render(<WatchdogPanel />);

    expect(screen.getByText('Watchdog Settings')).toBeInTheDocument();
  });

  it('should render the Save button', () => {
    render(<WatchdogPanel />);

    expect(screen.getByRole('button', { name: /save/i })).toBeInTheDocument();
  });

  it('should render an accessible help button for each watchdog field', () => {
    render(<WatchdogPanel />);

    expect(screen.getByRole('button', { name: 'Check interval (min) help' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Idle checks before shutdown help' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Min packets (activity threshold) help' })).toBeInTheDocument();
  });

  it('should show a success toast after saving settings', async () => {
    render(<WatchdogPanel />);

    await userEvent.click(screen.getByRole('button', { name: /save/i }));

    expect(toastMock.success).toHaveBeenCalledWith('Watchdog settings saved');
  });

  it('should show an error toast with the error message when saving fails', async () => {
    apiMock.saveConfig.mockRejectedValueOnce(new Error('network timeout'));
    render(<WatchdogPanel />);

    await userEvent.click(screen.getByRole('button', { name: /save/i }));

    expect(toastMock.error).toHaveBeenCalledWith(
      'Failed to save watchdog settings',
      expect.objectContaining({ description: 'network timeout' }),
    );
  });

  it('should show the fallback description when saving fails with an unknown error', async () => {
    apiMock.saveConfig.mockRejectedValueOnce('not an Error object');
    render(<WatchdogPanel />);

    await userEvent.click(screen.getByRole('button', { name: /save/i }));

    expect(toastMock.error).toHaveBeenCalledWith(
      'Failed to save watchdog settings',
      expect.objectContaining({ description: 'An unknown error occurred' }),
    );
  });

  describe('field validation', () => {
    /**
     * Config deliberately distinct from the component's own fallback values so
     * awaiting one of them proves `api.config()` has resolved — otherwise a
     * late resolution would overwrite whatever the test typed.
     */
    const LOADED_CONFIG = {
      watchdog_interval_minutes: 10,
      watchdog_idle_checks: 3,
      watchdog_min_packets: 50,
    };

    /** Renders the panel and waits for the loaded config to reach the inputs. */
    async function renderLoaded() {
      apiMock.config.mockResolvedValue(LOADED_CONFIG);
      render(<WatchdogPanel />);
      await screen.findByDisplayValue('10');
    }

    it('should disable Save and flag the field as required when the interval is cleared', async () => {
      await renderLoaded();

      await userEvent.clear(screen.getByLabelText('Check interval (min)'));

      expect(screen.getByRole('alert')).toHaveTextContent('Required');
      expect(screen.getByRole('button', { name: /save/i })).toBeDisabled();
      expect(screen.getByText(/fix the highlighted fields/i)).toBeInTheDocument();
    });

    it('should reject a negative idle-check count with the minimum-value message', async () => {
      await renderLoaded();

      const field = screen.getByLabelText('Idle checks before shutdown');
      await userEvent.clear(field);
      await userEvent.type(field, '-5');

      expect(screen.getByRole('alert')).toHaveTextContent('Must be 1 or greater');
      expect(screen.getByRole('button', { name: /save/i })).toBeDisabled();
    });

    it('should not persist anything while a field is invalid', async () => {
      await renderLoaded();

      await userEvent.clear(screen.getByLabelText('Min packets (activity threshold)'));
      await userEvent.click(screen.getByRole('button', { name: /save/i }));

      expect(apiMock.saveConfig).not.toHaveBeenCalled();
      expect(toastMock.success).not.toHaveBeenCalled();
    });

    it('should save the parsed numbers once an invalid field is corrected', async () => {
      await renderLoaded();

      const field = screen.getByLabelText('Check interval (min)');
      await userEvent.clear(field);
      await userEvent.type(field, '20');

      const save = screen.getByRole('button', { name: /save/i });
      expect(save).toBeEnabled();
      await userEvent.click(save);

      expect(apiMock.saveConfig).toHaveBeenCalledWith({
        watchdog_interval_minutes: 20,
        watchdog_idle_checks: 3,
        watchdog_min_packets: 50,
      });
    });

    it('should accept a zero packet threshold', async () => {
      await renderLoaded();

      const field = screen.getByLabelText('Min packets (activity threshold)');
      await userEvent.clear(field);
      await userEvent.type(field, '0');

      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: /save/i })).toBeEnabled();
    });
  });
});
