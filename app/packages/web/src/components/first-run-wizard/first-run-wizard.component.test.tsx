import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PrerequisitesReport } from '@hyveon/desktop-preload';

const gsdMock = {
  wizard: {
    checkPrereqs: vi.fn(),
    saveState: vi.fn(),
  },
};
vi.stubGlobal('gsd', gsdMock);

import { FirstRunWizard } from './first-run-wizard.component.js';

const SATISFIED: PrerequisitesReport = {
  terraform: { found: true, path: '/usr/local/bin/terraform', version: '1.9.0', minimumVersionSatisfied: true },
  aws: { found: true, path: '/usr/local/bin/aws', version: '2.15.30' },
};

const UNSATISFIED: PrerequisitesReport = {
  terraform: { found: false },
  aws: { found: true, path: '/usr/local/bin/aws', version: '2.15.30' },
};

beforeEach(() => {
  gsdMock.wizard.checkPrereqs.mockReset();
  gsdMock.wizard.saveState.mockReset();
});

/** Advances the wizard from the (satisfied) prerequisites step to pick-cloud. */
async function advanceToPickCloud(): Promise<void> {
  gsdMock.wizard.checkPrereqs.mockResolvedValue(SATISFIED);
  render(<FirstRunWizard />);
  await waitFor(() => expect(screen.getByRole('button', { name: /^next$/i })).toBeEnabled());
  await userEvent.click(screen.getByRole('button', { name: /^next$/i }));
  await screen.findByText(/choose the cloud provider/i);
}

afterEach(() => {
  cleanup();
});

describe('FirstRunWizard', () => {
  it('should check prerequisites on mount and render found tools once resolved', async () => {
    gsdMock.wizard.checkPrereqs.mockResolvedValue(SATISFIED);

    render(<FirstRunWizard />);

    await waitFor(() => expect(gsdMock.wizard.checkPrereqs).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('Found v1.9.0')).toBeInTheDocument();
  });

  it('should disable Next while prerequisites are unsatisfied', async () => {
    gsdMock.wizard.checkPrereqs.mockResolvedValue(UNSATISFIED);

    render(<FirstRunWizard />);

    expect(await screen.findByText('Not found')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^next$/i })).toBeDisabled();
  });

  it('should enable Next once both tools are satisfied', async () => {
    gsdMock.wizard.checkPrereqs.mockResolvedValue(SATISFIED);

    render(<FirstRunWizard />);

    await waitFor(() => expect(screen.getByRole('button', { name: /^next$/i })).toBeEnabled());
  });

  it('should re-invoke the prerequisite check when Re-check is clicked', async () => {
    gsdMock.wizard.checkPrereqs.mockResolvedValue(UNSATISFIED);

    render(<FirstRunWizard />);
    await waitFor(() => expect(gsdMock.wizard.checkPrereqs).toHaveBeenCalledTimes(1));

    gsdMock.wizard.checkPrereqs.mockResolvedValue(SATISFIED);
    await userEvent.click(screen.getByRole('button', { name: /re-check/i }));

    await waitFor(() => expect(gsdMock.wizard.checkPrereqs).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('Found v1.9.0')).toBeInTheDocument();
  });

  it('should disable Back on the first step', async () => {
    gsdMock.wizard.checkPrereqs.mockResolvedValue(SATISFIED);
    render(<FirstRunWizard />);
    await waitFor(() => expect(gsdMock.wizard.checkPrereqs).toHaveBeenCalledTimes(1));

    expect(screen.getByRole('button', { name: /back/i })).toBeDisabled();
  });

  it('should advance to the pick-cloud step once prerequisites are satisfied and Next is clicked', async () => {
    await advanceToPickCloud();
    expect(screen.getByRole('radio', { name: /Amazon Web Services/i })).toBeInTheDocument();
  });

  it('should persist the selected cloud via wizard.state.save when advancing past pick-cloud', async () => {
    gsdMock.wizard.saveState.mockResolvedValue({ wizardCompleted: false, activeCloud: 'aws' });
    await advanceToPickCloud();

    await userEvent.click(screen.getByRole('button', { name: /^next$/i }));

    await waitFor(() => expect(gsdMock.wizard.saveState).toHaveBeenCalledWith({ activeCloud: 'aws' }));
  });

  it('should show an error and stay on pick-cloud when saving the cloud choice fails', async () => {
    gsdMock.wizard.saveState.mockRejectedValue(new Error('disk full'));
    await advanceToPickCloud();

    await userEvent.click(screen.getByRole('button', { name: /^next$/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('disk full');
    // Still on pick-cloud, not advanced further.
    expect(screen.getByRole('radio', { name: /Amazon Web Services/i })).toBeInTheDocument();
  });

  it('should allow going back from pick-cloud to prerequisites', async () => {
    await advanceToPickCloud();

    await userEvent.click(screen.getByRole('button', { name: /back/i }));

    expect(await screen.findByText('Found v1.9.0')).toBeInTheDocument();
  });
});
