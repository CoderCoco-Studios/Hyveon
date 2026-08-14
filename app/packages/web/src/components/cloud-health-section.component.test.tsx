import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

/** Stub {@link api} surface for the Cloud Health section, hoisted so `vi.mock` below can reference it. */
const apiMock = vi.hoisted(() => ({
  cloudHealthList: vi.fn(),
  cloudHealthFix: vi.fn(),
  cloudHealthDownloadPolicy: vi.fn(),
  cloudHealthOpenPolicyConsole: vi.fn(),
}));
vi.mock('../api.service.js', () => ({ api: apiMock }));

import { CloudHealthSection } from './cloud-health-section.component.js';

beforeEach(() => {
  apiMock.cloudHealthList.mockReset();
  apiMock.cloudHealthFix.mockReset();
  apiMock.cloudHealthDownloadPolicy.mockReset();
  apiMock.cloudHealthOpenPolicyConsole.mockReset();
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

  it('should show the copyable policy JSON on needsPolicyUpdate, without any CloudFormation instruction', async () => {
    apiMock.cloudHealthList.mockResolvedValue([
      { id: 'ecs-service-linked-role', label: 'ECS service-linked role', status: 'missing' },
    ]);
    apiMock.cloudHealthFix.mockResolvedValue({
      outcome: 'needsPolicyUpdate',
      policyJson: '{"Sid":"HyveonServiceLinkedRoles"}',
      policyConsoleUrl: 'https://console.aws.amazon.com/iam/home#/policies/arn:aws:iam::123456789012:policy/HyveonDeployAll',
    });
    render(<CloudHealthSection />);

    await userEvent.click(await screen.findByRole('button', { name: /fix/i }));

    expect(await screen.findByText(/HyveonServiceLinkedRoles/)).toBeInTheDocument();
    expect(screen.getByText(/IAM console/i)).toBeInTheDocument();
    expect(screen.queryByText(/CloudFormation/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /open in aws console/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /download json/i })).toBeInTheDocument();
  });

  it('should open the IAM console when "Open in AWS Console" is clicked', async () => {
    apiMock.cloudHealthList.mockResolvedValue([
      { id: 'ecs-service-linked-role', label: 'ECS service-linked role', status: 'missing' },
    ]);
    const consoleUrl = 'https://console.aws.amazon.com/iam/home#/policies/arn:aws:iam::123456789012:policy/HyveonDeployAll';
    apiMock.cloudHealthFix.mockResolvedValue({ outcome: 'needsPolicyUpdate', policyJson: '{}', policyConsoleUrl: consoleUrl });
    apiMock.cloudHealthOpenPolicyConsole.mockResolvedValue({ opened: true });
    render(<CloudHealthSection />);
    await userEvent.click(await screen.findByRole('button', { name: /fix/i }));

    await userEvent.click(await screen.findByRole('button', { name: /open in aws console/i }));

    expect(apiMock.cloudHealthOpenPolicyConsole).toHaveBeenCalledWith(consoleUrl);
    expect(await screen.findByText(/opened in your default browser/i)).toBeInTheDocument();
  });

  it('should fall back to showing the URL when the console cannot be opened automatically', async () => {
    apiMock.cloudHealthList.mockResolvedValue([
      { id: 'ecs-service-linked-role', label: 'ECS service-linked role', status: 'missing' },
    ]);
    const consoleUrl = 'https://console.aws.amazon.com/iam/home#/policies/arn:aws:iam::123456789012:policy/HyveonDeployAll';
    apiMock.cloudHealthFix.mockResolvedValue({ outcome: 'needsPolicyUpdate', policyJson: '{}', policyConsoleUrl: consoleUrl });
    apiMock.cloudHealthOpenPolicyConsole.mockResolvedValue({ opened: false, url: consoleUrl });
    render(<CloudHealthSection />);
    await userEvent.click(await screen.findByRole('button', { name: /fix/i }));

    await userEvent.click(await screen.findByRole('button', { name: /open in aws console/i }));

    expect(await screen.findByDisplayValue(consoleUrl)).toBeInTheDocument();
  });

  it('should download the policy JSON and show the saved path', async () => {
    apiMock.cloudHealthList.mockResolvedValue([
      { id: 'ecs-service-linked-role', label: 'ECS service-linked role', status: 'missing' },
    ]);
    apiMock.cloudHealthFix.mockResolvedValue({ outcome: 'needsPolicyUpdate', policyJson: '{"Sid":"HyveonDeploy"}' });
    apiMock.cloudHealthDownloadPolicy.mockResolvedValue({ path: '/home/operator/hyveon-deploy-all-policy.json' });
    render(<CloudHealthSection />);
    await userEvent.click(await screen.findByRole('button', { name: /fix/i }));

    await userEvent.click(await screen.findByRole('button', { name: /download json/i }));

    expect(apiMock.cloudHealthDownloadPolicy).toHaveBeenCalledWith('{"Sid":"HyveonDeploy"}');
    expect(await screen.findByText(/hyveon-deploy-all-policy\.json/)).toBeInTheDocument();
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

  it('should show an inline error when the cloudHealthList IPC call itself rejects', async () => {
    apiMock.cloudHealthList.mockRejectedValue(new Error('bridge unavailable'));
    render(<CloudHealthSection />);

    expect(await screen.findByText(/unable to load cloud health checks/i)).toBeInTheDocument();
    expect(screen.getByText(/bridge unavailable/)).toBeInTheDocument();
  });

  it('should show an inline row error when the cloudHealthFix IPC call itself rejects', async () => {
    apiMock.cloudHealthList.mockResolvedValue([
      { id: 'ecs-service-linked-role', label: 'ECS service-linked role', status: 'missing' },
    ]);
    apiMock.cloudHealthFix.mockRejectedValue(new Error('bridge unavailable'));
    render(<CloudHealthSection />);

    await userEvent.click(await screen.findByRole('button', { name: /fix/i }));

    expect(await screen.findByText(/unable to reach the app/i)).toBeInTheDocument();
    expect(screen.getByText(/bridge unavailable/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /fix/i })).toBeInTheDocument();
  });
});
