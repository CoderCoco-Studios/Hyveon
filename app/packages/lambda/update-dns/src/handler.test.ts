/**
 * Tests for the update-dns Lambda — TypeScript port of update_dns.py.
 *
 * Covers DNS upsert/delete (including HTTPS-flagged games, which now follow
 * the same plain A-record path since TLS terminates in-task via a Caddy
 * sidecar) and the Discord follow-up that PATCHes the original interaction
 * message when a task reaches RUNNING with a pending row in DynamoDB.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  DescribeTasksCommand,
  ECSClient,
} from '@aws-sdk/client-ecs';
import {
  DescribeNetworkInterfacesCommand,
  EC2Client,
} from '@aws-sdk/client-ec2';
import {
  Route53Client,
  ChangeResourceRecordSetsCommand,
  ListResourceRecordSetsCommand,
} from '@aws-sdk/client-route-53';

const getPendingMock = vi.fn();
const deletePendingMock = vi.fn();
vi.mock('@hyveon/shared', async () => {
  const actual = await vi.importActual<typeof import('@hyveon/shared')>('@hyveon/shared');
  return {
    ...actual,
    getPending: (...args: unknown[]) => getPendingMock(...args),
    deletePending: (...args: unknown[]) => deletePendingMock(...args),
  };
});

const ecsMock = mockClient(ECSClient);
const ec2Mock = mockClient(EC2Client);
const route53Mock = mockClient(Route53Client);

process.env['HOSTED_ZONE_ID'] = 'Z123';
process.env['DOMAIN_NAME'] = 'example.com';
process.env['GAME_NAMES'] = 'palworld,foundryvtt';
process.env['TABLE_NAME'] = 'test-discord';
process.env['DNS_TTL'] = '30';
process.env['AWS_REGION_'] = 'us-east-1';

const { handler } = await import('./handler.js');

const fetchMock = vi.fn();
(globalThis as unknown as { fetch: unknown }).fetch = fetchMock;

function stateChange(opts: {
  game: string;
  lastStatus: 'RUNNING' | 'STOPPED';
  taskArn?: string;
  clusterArn?: string;
}) {
  return {
    detail: {
      lastStatus: opts.lastStatus,
      taskArn: opts.taskArn ?? 'arn:task/abc',
      clusterArn: opts.clusterArn ?? 'arn:cluster',
      group: `family:${opts.game}-server`,
    },
  };
}

function stubTaskWithEni(eniId = 'eni-xyz') {
  ecsMock.on(DescribeTasksCommand).resolves({
    tasks: [
      {
        attachments: [
          {
            type: 'ElasticNetworkInterface',
            details: [{ name: 'networkInterfaceId', value: eniId }],
          },
        ],
      },
    ],
  });
}

beforeEach(() => {
  ecsMock.reset();
  ec2Mock.reset();
  route53Mock.reset();
  fetchMock.mockReset();
  getPendingMock.mockReset();
  deletePendingMock.mockReset();
  getPendingMock.mockResolvedValue(null);
  fetchMock.mockResolvedValue({ ok: true, text: async () => '' });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('update-dns handler: unknown families', () => {
  it('should skip tasks whose family is not a known game', async () => {
    const result = await handler({
      detail: { lastStatus: 'RUNNING', group: 'family:stranger-server' },
    });
    expect(result).toMatchObject({ status: 'skipped' });
    expect(ecsMock.commandCalls(DescribeTasksCommand)).toHaveLength(0);
  });
});

describe('update-dns handler: direct (non-HTTPS) game', () => {
  it('should upsert a Route 53 A record pointing at the resolved public IP on RUNNING', async () => {
    stubTaskWithEni();
    ec2Mock.on(DescribeNetworkInterfacesCommand).resolves({
      NetworkInterfaces: [{ Association: { PublicIp: '1.2.3.4' } }],
    });
    route53Mock.on(ChangeResourceRecordSetsCommand).resolves({});

    const result = await handler(stateChange({ game: 'palworld', lastStatus: 'RUNNING' }));

    expect(result).toMatchObject({ status: 'upserted', game: 'palworld', ip: '1.2.3.4' });
    const changes = route53Mock.commandCalls(ChangeResourceRecordSetsCommand);
    expect(changes).toHaveLength(1);
    const change = changes[0]!.args[0]!.input.ChangeBatch!.Changes![0]!;
    expect(change.Action).toBe('UPSERT');
    expect(change.ResourceRecordSet!.Name).toBe('palworld.example.com');
    expect(change.ResourceRecordSet!.ResourceRecords![0]!.Value).toBe('1.2.3.4');
  });

  it('should delete the existing A record on STOPPED', async () => {
    route53Mock.on(ListResourceRecordSetsCommand).resolves({
      ResourceRecordSets: [
        { Name: 'palworld.example.com.', Type: 'A', ResourceRecords: [{ Value: '9.9.9.9' }], TTL: 30 },
      ],
    });
    route53Mock.on(ChangeResourceRecordSetsCommand).resolves({});

    const result = await handler(stateChange({ game: 'palworld', lastStatus: 'STOPPED' }));

    expect(result).toMatchObject({ status: 'deleted', game: 'palworld' });
    const changes = route53Mock.commandCalls(ChangeResourceRecordSetsCommand);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.args[0]!.input.ChangeBatch!.Changes![0]!.Action).toBe('DELETE');
  });
});

describe('update-dns handler: HTTPS-flagged game', () => {
  it('should follow the plain A-record path like any other game on RUNNING', async () => {
    stubTaskWithEni();
    ec2Mock.on(DescribeNetworkInterfacesCommand).resolves({
      NetworkInterfaces: [{ Association: { PublicIp: '5.6.7.8' } }],
    });
    route53Mock.on(ChangeResourceRecordSetsCommand).resolves({});

    const result = await handler(stateChange({ game: 'foundryvtt', lastStatus: 'RUNNING' }));

    expect(result).toMatchObject({ status: 'upserted', game: 'foundryvtt', ip: '5.6.7.8' });
    const changes = route53Mock.commandCalls(ChangeResourceRecordSetsCommand);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.args[0]!.input.ChangeBatch!.Changes![0]!.ResourceRecordSet!.Name).toBe(
      'foundryvtt.example.com',
    );
  });

  it('should delete the A record on STOPPED', async () => {
    route53Mock.on(ListResourceRecordSetsCommand).resolves({
      ResourceRecordSets: [
        { Name: 'foundryvtt.example.com.', Type: 'A', ResourceRecords: [{ Value: '5.6.7.8' }], TTL: 30 },
      ],
    });
    route53Mock.on(ChangeResourceRecordSetsCommand).resolves({});

    const result = await handler(stateChange({ game: 'foundryvtt', lastStatus: 'STOPPED' }));

    expect(result).toMatchObject({ status: 'deleted', game: 'foundryvtt' });
  });
});

describe('update-dns handler: Discord follow-up', () => {
  it('should PATCH the original interaction and delete the pending row when a pending record exists', async () => {
    stubTaskWithEni();
    ec2Mock.on(DescribeNetworkInterfacesCommand).resolves({
      NetworkInterfaces: [{ Association: { PublicIp: '1.2.3.4' } }],
    });
    route53Mock.on(ChangeResourceRecordSetsCommand).resolves({});
    getPendingMock.mockResolvedValue({
      taskArn: 'arn:task/abc',
      applicationId: 'app',
      interactionToken: 'tok1',
      userId: 'U1',
      guildId: 'G1',
      game: 'palworld',
      action: 'start',
      expiresAt: Math.floor(Date.now() / 1000) + 600,
    });

    await handler(stateChange({ game: 'palworld', lastStatus: 'RUNNING' }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://discord.com/api/v10/webhooks/app/tok1/messages/@original');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body).content).toContain('palworld');
    expect(deletePendingMock).toHaveBeenCalledWith('test-discord', 'arn:task/abc');
  });

  it('should not PATCH or delete anything when no pending row exists', async () => {
    stubTaskWithEni();
    ec2Mock.on(DescribeNetworkInterfacesCommand).resolves({
      NetworkInterfaces: [{ Association: { PublicIp: '1.2.3.4' } }],
    });
    route53Mock.on(ChangeResourceRecordSetsCommand).resolves({});
    getPendingMock.mockResolvedValue(null);

    await handler(stateChange({ game: 'palworld', lastStatus: 'RUNNING' }));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(deletePendingMock).not.toHaveBeenCalled();
  });
});
