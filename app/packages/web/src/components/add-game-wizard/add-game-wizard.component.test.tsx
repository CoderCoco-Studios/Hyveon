import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AddGameWizard } from './add-game-wizard.component.js';
import { getFargateCpuOptions, getFargateMemoryOptions } from '@hyveon/shared/gameServerValidator';

/**
 * Stub for the `@/api.service.js` module: `games()` backs the existing-games
 * fetch the wizard fires whenever it opens (used for client-side collision
 * checks), and `createGame()` backs the Review step's Submit button. Both
 * are reset to a "happy" default in `beforeEach` and overridden per test.
 */
const apiMock = vi.hoisted(() => ({
  games: vi.fn(),
  createGame: vi.fn(),
}));
vi.mock('../../api.service.js', () => ({ api: apiMock }));

/** Stub for `sonner`'s `toast`, so success/failure toasts can be asserted without a real toaster mounted. */
const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast: toastMock }));

/**
 * Stub for `react-router-dom`'s `useNavigate` — the wizard only ever calls
 * this one hook from the module, so a full mock (no real `MemoryRouter`
 * needed) keeps the test setup minimal.
 */
const navigateMock = vi.hoisted(() => vi.fn());
vi.mock('react-router-dom', () => ({ useNavigate: () => navigateMock }));

/** Opens the wizard dialog via its trigger button and waits for the first step to render. */
async function openWizard() {
  render(<AddGameWizard />);
  await userEvent.click(screen.getByRole('button', { name: /add game/i }));
  await screen.findByRole('heading', { name: 'Add a game server' });
}

/** Fills the Identity step's required fields (`name`, `image`) with valid values. */
async function fillIdentityStep(name = 'mygame', image = 'some/image') {
  await userEvent.type(screen.getByLabelText('Name'), name);
  await userEvent.type(screen.getByLabelText('Image'), image);
}

/** Clicks the dialog footer's "Next" button. */
async function goNext() {
  await userEvent.click(screen.getByRole('button', { name: 'Next' }));
}

/**
 * Selects a valid Fargate cpu/memory pairing on the Resources step. Both
 * sliders render index 0 while unset, and 256/512 (the 0.25 vCPU tier's
 * lowest memory option) are index 0 of their respective option lists, so a
 * plain `change` event would be a same-value no-op against the unset
 * fallback — `pointerUp` exercises the commit-on-interaction handler
 * instead, matching how a real drag landing on the fallback position
 * behaves.
 */
function fillResourcesStep() {
  const cpuOptions = getFargateCpuOptions();
  fireEvent.pointerUp(screen.getByLabelText('vCPU'), { target: { value: String(cpuOptions.indexOf(256)) } });
  const memoryOptions = getFargateMemoryOptions(256);
  fireEvent.pointerUp(screen.getByLabelText('Memory'), { target: { value: String(memoryOptions.indexOf(512)) } });
}

/** Adds and fills a single volume row on the Storage step (the server requires at least one). */
async function fillStorageStep() {
  await userEvent.click(screen.getByRole('button', { name: 'Add volume' }));
  await userEvent.type(screen.getByLabelText('Volume name'), 'data');
  await userEvent.type(screen.getByLabelText('Container path'), '/data');
}

/**
 * Drives the wizard from a freshly-opened dialog through every step up to
 * (and including landing on) Review, filling in the minimum set of fields
 * needed to pass client-side validation at each step. Leaves the dialog
 * open on the Review step, ready for the caller to click Submit.
 */
async function fillHappyPathToReview() {
  await fillIdentityStep();
  await goNext(); // -> resources
  fillResourcesStep();
  await goNext(); // -> networking (no ports required)
  await goNext(); // -> storage
  await fillStorageStep();
  await goNext(); // -> environment (no rows required)
  await goNext(); // -> review
  await screen.findByText('Step 6 of 6: Review');
}

describe('AddGameWizard — blocked-advance validation', () => {
  beforeEach(() => {
    apiMock.games.mockResolvedValue({ games: [] });
    apiMock.createGame.mockReset();
    navigateMock.mockClear();
    toastMock.success.mockClear();
    toastMock.error.mockClear();
  });

  it('should disable Next on the Identity step while name and image are blank', async () => {
    await openWizard();

    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  });

  it('should enable Next on the Identity step once name and image are filled in', async () => {
    await openWizard();

    await fillIdentityStep();

    expect(screen.getByRole('button', { name: 'Next' })).not.toBeDisabled();
  });

  it('should keep Next disabled when the name does not match the required identifier pattern', async () => {
    await openWizard();

    await fillIdentityStep('1nvalid name', 'some/image');

    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  });
});

describe('AddGameWizard — step body scroll reset', () => {
  beforeEach(() => {
    apiMock.games.mockResolvedValue({ games: [] });
    apiMock.createGame.mockReset();
    navigateMock.mockClear();
    toastMock.success.mockClear();
    toastMock.error.mockClear();
  });

  it('should reset the step body scroll position when advancing to the next step', async () => {
    await openWizard();
    await fillIdentityStep();

    const stepBody = screen.getByText('Name').closest('div.overflow-y-auto');
    expect(stepBody).not.toBeNull();
    if (stepBody) stepBody.scrollTop = 200;

    await goNext();

    await screen.findByText('Step 2 of 6: Resources');
    expect(stepBody?.scrollTop).toBe(0);
  });
});

describe('AddGameWizard — submit success path', () => {
  beforeEach(() => {
    apiMock.games.mockResolvedValue({ games: [] });
    apiMock.createGame.mockReset();
    navigateMock.mockClear();
    toastMock.success.mockClear();
    toastMock.error.mockClear();
  });

  it('should show a success toast telling the operator to plan/apply, redirect to the new game page, and close the dialog', async () => {
    apiMock.createGame.mockResolvedValue({ ok: true, games: [] });
    await openWizard();
    await fillHappyPathToReview();

    await userEvent.click(screen.getByRole('button', { name: 'Submit' }));

    await waitFor(() =>
      expect(toastMock.success).toHaveBeenCalledWith('mygame created', {
        description: 'Run plan and apply on the Infrastructure page to deploy it.',
      }),
    );
    expect(navigateMock).toHaveBeenCalledWith('/games/mygame');
    expect(screen.queryByRole('heading', { name: 'Add a game server' })).not.toBeInTheDocument();
  });
});

describe('AddGameWizard — submit failure paths', () => {
  beforeEach(() => {
    apiMock.games.mockResolvedValue({ games: [] });
    apiMock.createGame.mockReset();
    navigateMock.mockClear();
    toastMock.success.mockClear();
    toastMock.error.mockClear();
  });

  it('should leave the dialog open, jump to the offending step, and highlight the field on a validation failure', async () => {
    apiMock.createGame.mockResolvedValue({
      ok: false,
      code: 'validation',
      issues: [{ path: 'name', message: 'A game named "mygame" already exists.' }],
    });
    await openWizard();
    await fillHappyPathToReview();

    await userEvent.click(screen.getByRole('button', { name: 'Submit' }));

    await screen.findByText('Step 1 of 6: Identity');
    expect(screen.getByText('A game named "mygame" already exists.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Add a game server' })).toBeInTheDocument();
    expect(navigateMock).not.toHaveBeenCalled();
    expect(toastMock.success).not.toHaveBeenCalled();
  });

  it('should leave the dialog open on the Review step and surface the server message on a conflict/error failure', async () => {
    apiMock.createGame.mockResolvedValue({
      ok: false,
      code: 'conflict',
      message: 'deployment config changed since this draft was loaded.',
    });
    await openWizard();
    await fillHappyPathToReview();

    await userEvent.click(screen.getByRole('button', { name: 'Submit' }));

    await screen.findByRole('alert');
    expect(screen.getByRole('alert')).toHaveTextContent('deployment config changed since this draft was loaded.');
    expect(screen.getByText('Step 6 of 6: Review')).toBeInTheDocument();
    expect(navigateMock).not.toHaveBeenCalled();
    expect(toastMock.success).not.toHaveBeenCalled();
  });
});
