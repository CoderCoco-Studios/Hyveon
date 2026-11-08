import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const apiMock = vi.hoisted(() => ({ rotateAwsKey: vi.fn(), canRotateAwsKey: vi.fn() }));
vi.mock('../api.service.js', () => ({ api: apiMock }));

import { RotateAccessKeyRow } from './rotate-access-key-row.component.js';

beforeEach(() => {
  apiMock.rotateAwsKey.mockReset();
  apiMock.canRotateAwsKey.mockReset().mockResolvedValue(true);
});

async function clickRotate() {
  await userEvent.click(await screen.findByRole('button', { name: /rotate key/i }));
}

describe('RotateAccessKeyRow', () => {
  // @spec APP-WIZARD-ROTKEY-005
  it('should call rotateAwsKey when the operator presses Rotate key and report success', async () => {
    apiMock.rotateAwsKey.mockResolvedValue({ status: 'complete' });
    render(<RotateAccessKeyRow />);

    await clickRotate();

    expect(await screen.findByText(/rotated.*old key has been revoked/i)).toBeInTheDocument();
    expect(apiMock.rotateAwsKey).toHaveBeenCalledTimes(1);
  });

  // @spec APP-WIZARD-ROTKEY-005
  it('should disable the button while a rotation is in flight', async () => {
    let release!: (value: { status: 'complete' }) => void;
    apiMock.rotateAwsKey.mockReturnValue(new Promise((resolve) => (release = resolve)));
    render(<RotateAccessKeyRow />);

    await clickRotate();

    expect(screen.getByRole('button', { name: /rotating/i })).toBeDisabled();
    release({ status: 'complete' });
    await waitFor(() => expect(screen.getByRole('button', { name: /rotate key/i })).toBeEnabled());
  });

  // @spec APP-WIZARD-ROTKEY-005
  it('should tell the operator the previous key is still active when verification fails', async () => {
    apiMock.rotateAwsKey.mockResolvedValue({ status: 'verification-failed', error: 'InvalidClientTokenId' });
    render(<RotateAccessKeyRow />);

    await clickRotate();

    expect(await screen.findByText(/previous key is still active/i)).toBeInTheDocument();
    expect(screen.getByText(/InvalidClientTokenId/)).toBeInTheDocument();
  });

  // @spec APP-WIZARD-ROTKEY-005
  it('should show the console URL to revoke the old key manually when its deletion fails', async () => {
    apiMock.rotateAwsKey.mockResolvedValue({ status: 'delete-failed', consoleUrl: 'https://console.aws.amazon.com/iam/x' });
    render(<RotateAccessKeyRow />);

    await clickRotate();

    expect(await screen.findByText(/new key is active/i)).toBeInTheDocument();
    expect(screen.getByDisplayValue('https://console.aws.amazon.com/iam/x')).toBeInTheDocument();
  });

  // @spec APP-WIZARD-ROTKEY-005
  it.each([
    [{ status: 'keychain-unavailable' }, /keychain/i],
    [{ status: 'busy' }, /operation is running/i],
    [{ status: 'unsupported', message: 'Rotation is only supported for pasted or guided credential sources' }, /only supported/i],
    [{ status: 'failed', message: 'LimitExceeded' }, /LimitExceeded/],
  ])('should show a refusal for %j', async (result, pattern) => {
    apiMock.rotateAwsKey.mockResolvedValue(result);
    render(<RotateAccessKeyRow />);

    await clickRotate();

    expect(await screen.findByRole('alert')).toHaveTextContent(pattern);
  });

  // @spec APP-WIZARD-ROTKEY-005
  it('should render no row for an install whose credential source is a ~/.aws profile', async () => {
    apiMock.canRotateAwsKey.mockResolvedValue(false);
    render(<RotateAccessKeyRow />);

    await waitFor(() => expect(apiMock.canRotateAwsKey).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: /rotate key/i })).not.toBeInTheDocument();
  });

  // @spec APP-WIZARD-ROTKEY-005
  it('should show an error when the IPC call itself rejects', async () => {
    apiMock.rotateAwsKey.mockRejectedValue(new Error('bridge down'));
    render(<RotateAccessKeyRow />);

    await clickRotate();

    expect(await screen.findByRole('alert')).toHaveTextContent(/bridge down/);
  });
});
