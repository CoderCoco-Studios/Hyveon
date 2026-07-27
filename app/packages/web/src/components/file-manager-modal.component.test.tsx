import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FileManagerModal } from './file-manager-modal.component.js';
import type { FileMgrStatus } from '../api.service.js';

/** Build the callback set every render needs, so specs only name the ones they assert on. */
function callbacks() {
  return { onClose: vi.fn(), onStart: vi.fn(), onStop: vi.fn() };
}

/**
 * Render the modal for `game` with the given status. `status` is given as the
 * fields a spec cares about; the `game` key every `FileMgrStatus` carries is
 * filled in from the rendered game so specs stay readable.
 */
function renderModal(
  status: Omit<FileMgrStatus, 'game'> | null,
  overrides: { game?: string | null; message?: string } = {},
) {
  const cbs = callbacks();
  const { game = 'minecraft', message = '' } = overrides;
  const full: FileMgrStatus | null = status === null ? null : { game: game ?? '', ...status };
  render(<FileManagerModal game={game} status={full} message={message} {...cbs} />);
  return cbs;
}

describe('FileManagerModal', () => {
  it('should render nothing when no game is selected', () => {
    const { container } = render(
      <FileManagerModal game={null} status={null} message="" {...callbacks()} />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it('should show the stopped status text when there is no status yet', () => {
    renderModal(null);

    expect(screen.getByText(/Not running\. Click Launch/)).toBeInTheDocument();
    expect(screen.getByRole('heading')).toHaveTextContent('minecraft');
  });

  it('should show the starting status text while the helper task is coming up', () => {
    renderModal({ state: 'starting' });

    expect(screen.getByText(/Starting…/)).toBeInTheDocument();
  });

  it('should show the running status text when the task is up but has no URL yet', () => {
    renderModal({ state: 'running' });

    expect(screen.getByText(/Running — click the link below/)).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('should prefer an explicit message over the derived status text', () => {
    renderModal({ state: 'starting' }, { message: 'Launching FileBrowser…' });

    expect(screen.getByText('Launching FileBrowser…')).toBeInTheDocument();
    expect(screen.queryByText(/Starting…/)).not.toBeInTheDocument();
  });

  it('should link to FileBrowser once the task is running with a URL', () => {
    renderModal({ state: 'running', url: 'http://10.0.0.5:8080' });

    const link = screen.getByRole('link', { name: /Open FileBrowser/ });
    expect(link).toHaveAttribute('href', 'http://10.0.0.5:8080');
  });

  it('should disable Launch and enable Stop while running', () => {
    renderModal({ state: 'running', url: 'http://10.0.0.5:8080' });

    expect(screen.getByRole('button', { name: 'Launch' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Stop' })).toBeEnabled();
  });

  it('should disable Launch and enable Stop while starting', () => {
    renderModal({ state: 'starting' });

    expect(screen.getByRole('button', { name: 'Launch' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Stop' })).toBeEnabled();
  });

  it('should enable Launch and disable Stop when stopped', () => {
    renderModal({ state: 'stopped' });

    expect(screen.getByRole('button', { name: 'Launch' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Stop' })).toBeDisabled();
  });

  it('should fire onStart when Launch is clicked', async () => {
    const { onStart } = renderModal({ state: 'stopped' });

    await userEvent.click(screen.getByRole('button', { name: 'Launch' }));

    expect(onStart).toHaveBeenCalledOnce();
  });

  it('should fire onStop when Stop is clicked', async () => {
    const { onStop } = renderModal({ state: 'running', url: 'http://10.0.0.5:8080' });

    await userEvent.click(screen.getByRole('button', { name: 'Stop' }));

    expect(onStop).toHaveBeenCalledOnce();
  });

  it('should fire onClose when the Close button is clicked', async () => {
    const { onClose } = renderModal({ state: 'stopped' });

    await userEvent.click(screen.getByRole('button', { name: 'Close' }));

    expect(onClose).toHaveBeenCalledOnce();
  });

  it('should fire onClose when Escape is pressed', async () => {
    const { onClose } = renderModal({ state: 'stopped' });

    await userEvent.keyboard('{Escape}');

    expect(onClose).toHaveBeenCalledOnce();
  });

  it('should not fire onClose for other keys', async () => {
    const { onClose } = renderModal({ state: 'stopped' });

    await userEvent.keyboard('{Enter}');

    expect(onClose).not.toHaveBeenCalled();
  });

  it('should fire onClose when the backdrop itself is clicked', async () => {
    const { onClose } = renderModal({ state: 'stopped' });

    // The overlay is the heading's great-grandparent; clicking the panel
    // inside it must not close, only the backdrop itself.
    const overlay = screen.getByRole('heading').parentElement!.parentElement!;
    await userEvent.click(overlay);

    expect(onClose).toHaveBeenCalledOnce();
  });

  it('should not fire onClose when the panel inside the backdrop is clicked', async () => {
    const { onClose } = renderModal({ state: 'stopped' });

    await userEvent.click(screen.getByRole('heading'));

    expect(onClose).not.toHaveBeenCalled();
  });
});
