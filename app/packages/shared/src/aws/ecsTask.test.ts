import { describe, it, expect, vi } from 'vitest';
import {
  getTaskAttachmentDetail,
  getTaskEniId,
  getTaskPrivateIp,
  resolveEniPublicIp,
  type EcsTaskLike,
} from './ecsTask.js';

const taskWithEni = (details: Array<{ name?: string; value?: string }>): EcsTaskLike => ({
  attachments: [{ type: 'ElasticNetworkInterface', details }],
});

describe('getTaskAttachmentDetail', () => {
  it('should return the named detail value from the ENI attachment', () => {
    const task = taskWithEni([{ name: 'networkInterfaceId', value: 'eni-123' }]);
    expect(getTaskAttachmentDetail(task, 'networkInterfaceId')).toBe('eni-123');
  });

  it('should return null when there is no ElasticNetworkInterface attachment', () => {
    const task: EcsTaskLike = { attachments: [{ type: 'Other', details: [{ name: 'x', value: 'y' }] }] };
    expect(getTaskAttachmentDetail(task, 'x')).toBeNull();
  });

  it('should return null when attachments is absent', () => {
    expect(getTaskAttachmentDetail({}, 'networkInterfaceId')).toBeNull();
  });

  it('should return null when the named detail is not present', () => {
    const task = taskWithEni([{ name: 'other', value: 'y' }]);
    expect(getTaskAttachmentDetail(task, 'networkInterfaceId')).toBeNull();
  });
});

describe('getTaskEniId', () => {
  it('should return the networkInterfaceId detail', () => {
    const task = taskWithEni([{ name: 'networkInterfaceId', value: 'eni-abc' }]);
    expect(getTaskEniId(task)).toBe('eni-abc');
  });
});

describe('getTaskPrivateIp', () => {
  it('should return the privateIPv4Address detail', () => {
    const task = taskWithEni([{ name: 'privateIPv4Address', value: '10.0.0.5' }]);
    expect(getTaskPrivateIp(task)).toBe('10.0.0.5');
  });
});

describe('resolveEniPublicIp', () => {
  it('should return the ENI public IP when present', async () => {
    const describeNetworkInterfaces = vi.fn().mockResolvedValue({
      NetworkInterfaces: [{ Association: { PublicIp: '1.2.3.4' } }],
    });
    await expect(resolveEniPublicIp(describeNetworkInterfaces, 'eni-1')).resolves.toBe('1.2.3.4');
    expect(describeNetworkInterfaces).toHaveBeenCalledWith('eni-1');
  });

  it('should return null when the ENI has no public association', async () => {
    const describeNetworkInterfaces = vi.fn().mockResolvedValue({ NetworkInterfaces: [{}] });
    await expect(resolveEniPublicIp(describeNetworkInterfaces, 'eni-1')).resolves.toBeNull();
  });

  it('should propagate a failed describe call', async () => {
    const describeNetworkInterfaces = vi.fn().mockRejectedValue(new Error('boom'));
    await expect(resolveEniPublicIp(describeNetworkInterfaces, 'eni-1')).rejects.toThrow('boom');
  });
});
