import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const apiMock = vi.hoisted(() => ({
  cloudHealthList: vi.fn(),
  cloudHealthFix: vi.fn(),
}));
vi.mock('../api.service.js', () => ({ api: apiMock }));

import { CloudHealthSection } from './cloud-health-section.component.js';

beforeEach(() => {
  apiMock.cloudHealthList.mockReset();
  apiMock.cloudHealthFix.mockReset();
});

describe('CloudHealthSection', () => {
  it('should render an ok row with no Fix button', async () => {
    apiMock.cloudHealthList.mockResolvedValue([
      { id: 'ecs-service-linked-role', label: 'ECS service-linked role', status: 'ok' },
    ]);
    render(<CloudHealthSection />);

    expect(await screen.findByText('ECS service-linked role')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /fix/i })).not.toBeInTheDocument();
  });

  it('should render a missing row with a Fix button', async () => {
    apiMock.cloudHealthList.mockResolvedValue([
      { id: 'ecs-service-linked-role', label: 'ECS service-linked role', status: 'missing', message: 'not found' },
    ]);
    render(<CloudHealthSection />);

    expect(await screen.findByRole('button', { name: /fix/i })).toBeInTheDocument();
    expect(screen.getByText('not found')).toBeInTheDocument();
  });

  it('should re-render green after a successful Fix', async () => {
    apiMock.cloudHealthList
      .mockResolvedValueOnce([{ id: 'ecs-service-linked-role', label: 'ECS service-linked role', status: 'missing' }])
      .mockResolvedValueOnce([{ id: 'ecs-service-linked-role', label: 'ECS service-linked role', status: 'ok' }]);
    apiMock.cloudHealthFix.mockResolvedValue({ outcome: 'fixed' });
    render(<CloudHealthSection />);

    await userEvent.click(await screen.findByRole('button', { name: /fix/i }));

    await waitFor(() => expect(screen.queryByRole('button', { name: /fix/i })).not.toBeInTheDocument());
    expect(apiMock.cloudHealthList).toHaveBeenCalledTimes(2);
  });

  it('should show the copyable policy JSON on needsPolicyUpdate', async () => {
    apiMock.cloudHealthList.mockResolvedValue([
      { id: 'ecs-service-linked-role', label: 'ECS service-linked role', status: 'missing' },
    ]);
    apiMock.cloudHealthFix.mockResolvedValue({ outcome: 'needsPolicyUpdate', policyJson: '{"Sid":"HyveonServiceLinkedRoles"}' });
    render(<CloudHealthSection />);

    await userEvent.click(await screen.findByRole('button', { name: /fix/i }));

    expect(await screen.findByText(/HyveonServiceLinkedRoles/)).toBeInTheDocument();
  });

  it('should show an inline error and keep Fix available on an unexpected failure', async () => {
    apiMock.cloudHealthList.mockResolvedValue([
      { id: 'ecs-service-linked-role', label: 'ECS service-linked role', status: 'missing' },
    ]);
    apiMock.cloudHealthFix.mockResolvedValue({ outcome: 'failed', message: 'boom' });
    render(<CloudHealthSection />);

    await userEvent.click(await screen.findByRole('button', { name: /fix/i }));

    expect(await screen.findByText('boom')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /fix/i })).toBeInTheDocument();
  });
});
