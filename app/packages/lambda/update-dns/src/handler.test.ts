/**
 * Tests for the update-dns Lambda.
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
  // @spec RT-TASK-DNS-003
  it('should skip tasks whose family is not a known game', async () => {
    const result = await handler({
      detail: { lastStatus: 'RUNNING', group: 'family:stranger-server' },
    });
    expect(result).toMatchObject({ status: 'skipped' });
    expect(ecsMock.commandCalls(DescribeTasksCommand)).toHaveLength(0);
  });
});

describe('update-dns handler: direct (non-HTTPS) game', () => {
  // @spec RT-TASK-DNS-005
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

  // @spec RT-TASK-DNS-007
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
  // @spec RT-TASK-DNS-011
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

  // @spec RT-TASK-DNS-011
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
  // @spec RT-TASK-NOTIFY-001
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

/** A pending `/server-start` row for `arn:task/abc`. */
const pendingRow = {
  taskArn: 'arn:task/abc',
  applicationId: 'app',
  interactionToken: 'tok1',
  userId: 'U1',
  guildId: 'G1',
  game: 'palworld',
  action: 'start',
  expiresAt: Math.floor(Date.now() / 1000) + 600,
};

describe('update-dns handler: stored-record DELETE', () => {
  // @spec RT-TASK-DNS-009
  it('should send the stored TTL and value, not the current DNS_TTL', async () => {
    route53Mock.on(ListResourceRecordSetsCommand).resolves({
      ResourceRecordSets: [
        { Name: 'palworld.example.com.', Type: 'A', ResourceRecords: [{ Value: '9.9.9.9' }], TTL: 300 },
      ],
    });
    route53Mock.on(ChangeResourceRecordSetsCommand).resolves({});

    await handler(stateChange({ game: 'palworld', lastStatus: 'STOPPED' }));

    const rrs = route53Mock.commandCalls(ChangeResourceRecordSetsCommand)[0]!.args[0]!.input.ChangeBatch!.Changes![0]!
      .ResourceRecordSet!;
    expect(rrs.TTL).toBe(300);
    expect(rrs.ResourceRecords).toEqual([{ Value: '9.9.9.9' }]);
  });
});

type ZoneRecord = { Name: string; Type: 'A' | 'TXT'; Value: string; TTL: number };

/** Stub `ListResourceRecordSets` over an in-memory zone, honouring the start name and type like Route 53 does. */
function stubZone(records: ZoneRecord[]) {
  route53Mock.on(ListResourceRecordSetsCommand).callsFake((input) => ({
    ResourceRecordSets: records
      .filter((r) => r.Name === `${input.StartRecordName}.` && r.Type === input.StartRecordType)
      .map((r) => ({ Name: r.Name, Type: r.Type, TTL: r.TTL, ResourceRecords: [{ Value: r.Value }] })),
  }));
}

const aRecord: ZoneRecord = { Name: 'palworld.example.com.', Type: 'A', Value: '9.9.9.9', TTL: 300 };
const ownerOf = (arn: string, ttl = 300): ZoneRecord => ({
  Name: '_hyveon-owner.palworld.example.com.',
  Type: 'TXT',
  Value: `"${arn}"`,
  TTL: ttl,
});

describe('update-dns handler: ownership TXT record', () => {
  // @spec RT-TASK-DNS-016
  it('should UPSERT the A record and the quoted-ARN TXT record in one change batch on RUNNING', async () => {
    stubTaskWithEni();
    ec2Mock.on(DescribeNetworkInterfacesCommand).resolves({
      NetworkInterfaces: [{ Association: { PublicIp: '1.2.3.4' } }],
    });
    route53Mock.on(ChangeResourceRecordSetsCommand).resolves({});

    await handler(stateChange({ game: 'palworld', lastStatus: 'RUNNING' }));

    const changes = route53Mock.commandCalls(ChangeResourceRecordSetsCommand);
    expect(changes).toHaveLength(1);
    const batch = changes[0]!.args[0]!.input.ChangeBatch!.Changes!;
    expect(batch).toHaveLength(2);
    expect(batch[1]).toMatchObject({
      Action: 'UPSERT',
      ResourceRecordSet: {
        Name: '_hyveon-owner.palworld.example.com',
        Type: 'TXT',
        TTL: 30,
        ResourceRecords: [{ Value: '"arn:task/abc"' }],
      },
    });
  });

  // @spec RT-TASK-DNS-007
  it('should DELETE the A and TXT records in one batch, echoing stored TTLs, when the ARN matches', async () => {
    stubZone([aRecord, ownerOf('arn:task/abc', 120)]);
    route53Mock.on(ChangeResourceRecordSetsCommand).resolves({});

    const result = await handler(stateChange({ game: 'palworld', lastStatus: 'STOPPED' }));

    expect(result).toMatchObject({ status: 'deleted', game: 'palworld' });
    const changes = route53Mock.commandCalls(ChangeResourceRecordSetsCommand);
    expect(changes).toHaveLength(1);
    const batch = changes[0]!.args[0]!.input.ChangeBatch!.Changes!;
    expect(batch.map((c) => [c.Action, c.ResourceRecordSet!.Type, c.ResourceRecordSet!.TTL])).toEqual([
      ['DELETE', 'A', 300],
      ['DELETE', 'TXT', 120],
    ]);
    expect(batch[1]!.ResourceRecordSet!.ResourceRecords).toEqual([{ Value: '"arn:task/abc"' }]);
  });

  // @spec RT-TASK-DNS-010
  it('should leave both records and warn with identifiers only when a late STOPPED names another task', async () => {
    stubZone([aRecord, ownerOf('arn:task/new')]);
    route53Mock.on(ChangeResourceRecordSetsCommand).resolves({});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = await handler(stateChange({ game: 'palworld', lastStatus: 'STOPPED', taskArn: 'arn:task/old' }));

    expect(result).toMatchObject({ status: 'skipped', reason: 'not_owner' });
    expect(route53Mock.commandCalls(ChangeResourceRecordSetsCommand)).toHaveLength(0);
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).toContain('arn:task/old');
    expect(logged).not.toContain('9.9.9.9');
    warn.mockRestore();
  });

  // @spec RT-TASK-DNS-010
  it('should let a stop-then-start race resolve safely: late old STOPPED is a no-op, new STOPPED deletes', async () => {
    stubZone([aRecord, ownerOf('arn:task/new')]);
    route53Mock.on(ChangeResourceRecordSetsCommand).resolves({});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await handler(stateChange({ game: 'palworld', lastStatus: 'STOPPED', taskArn: 'arn:task/old' }));
    expect(route53Mock.commandCalls(ChangeResourceRecordSetsCommand)).toHaveLength(0);

    await handler(stateChange({ game: 'palworld', lastStatus: 'STOPPED', taskArn: 'arn:task/new' }));
    expect(route53Mock.commandCalls(ChangeResourceRecordSetsCommand)).toHaveLength(1);
    warn.mockRestore();
  });

  // @spec RT-TASK-DNS-008
  it('should make no change for a duplicate STOPPED event once both records are gone', async () => {
    stubZone([]);
    route53Mock.on(ChangeResourceRecordSetsCommand).resolves({});

    const result = await handler(stateChange({ game: 'palworld', lastStatus: 'STOPPED' }));

    expect(result).toMatchObject({ status: 'deleted', game: 'palworld' });
    expect(route53Mock.commandCalls(ChangeResourceRecordSetsCommand)).toHaveLength(0);
  });

  // @spec RT-TASK-DNS-017
  it('should DELETE a legacy A record that has no ownership TXT record', async () => {
    stubZone([aRecord]);
    route53Mock.on(ChangeResourceRecordSetsCommand).resolves({});

    await handler(stateChange({ game: 'palworld', lastStatus: 'STOPPED' }));

    const batch = route53Mock.commandCalls(ChangeResourceRecordSetsCommand)[0]!.args[0]!.input.ChangeBatch!.Changes!;
    expect(batch).toHaveLength(1);
    expect(batch[0]).toMatchObject({ Action: 'DELETE', ResourceRecordSet: { Type: 'A', TTL: 300 } });
  });

  // @spec RT-TASK-DNS-018
  it('should change nothing and warn when the ownership TXT record cannot be read', async () => {
    route53Mock.on(ListResourceRecordSetsCommand).callsFake((input) => {
      if (input.StartRecordType === 'TXT') throw new Error('throttled');
      return {
        ResourceRecordSets: [
          { Name: aRecord.Name, Type: 'A', TTL: 300, ResourceRecords: [{ Value: aRecord.Value }] },
        ],
      };
    });
    route53Mock.on(ChangeResourceRecordSetsCommand).resolves({});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = await handler(stateChange({ game: 'palworld', lastStatus: 'STOPPED' }));

    expect(result).toMatchObject({ status: 'skipped', reason: 'owner_unreadable' });
    expect(route53Mock.commandCalls(ChangeResourceRecordSetsCommand)).toHaveLength(0);
    expect(JSON.stringify(warn.mock.calls)).toContain('arn:task/abc');
    warn.mockRestore();
  });

  // @spec RT-TASK-DNS-019
  it('should DELETE an orphaned matching TXT record when no A record exists', async () => {
    stubZone([ownerOf('arn:task/abc', 60)]);
    route53Mock.on(ChangeResourceRecordSetsCommand).resolves({});

    await handler(stateChange({ game: 'palworld', lastStatus: 'STOPPED' }));

    const batch = route53Mock.commandCalls(ChangeResourceRecordSetsCommand)[0]!.args[0]!.input.ChangeBatch!.Changes!;
    expect(batch).toHaveLength(1);
    expect(batch[0]).toMatchObject({ Action: 'DELETE', ResourceRecordSet: { Type: 'TXT', TTL: 60 } });
  });
});

describe('update-dns handler: event logging', () => {
  // @spec RT-TASK-DNS-014
  it('should log task identifiers rather than the full event JSON', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const event = { ...stateChange({ game: 'palworld', lastStatus: 'STOPPED' }), secret: 'do-not-log' };
    route53Mock.on(ListResourceRecordSetsCommand).resolves({ ResourceRecordSets: [] });

    await handler(event);

    const logged = JSON.stringify(log.mock.calls);
    expect(logged).toContain('arn:task/abc');
    expect(logged).toContain('palworld-server');
    expect(logged).toContain('STOPPED');
    expect(logged).not.toContain('do-not-log');
    log.mockRestore();
  });
});

describe('update-dns handler: pending interaction on failure paths', () => {
  // @spec RT-TASK-NOTIFY-005
  it('should PATCH an error and delete the row when a task stops before RUNNING', async () => {
    route53Mock.on(ListResourceRecordSetsCommand).resolves({ ResourceRecordSets: [] });
    getPendingMock.mockResolvedValue(pendingRow);

    await handler(stateChange({ game: 'palworld', lastStatus: 'STOPPED' }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body).content).toContain('**palworld**: error');
    expect(deletePendingMock).toHaveBeenCalledWith('test-discord', 'arn:task/abc');
  });

  // @spec RT-TASK-NOTIFY-006
  it('should PATCH an error, keep the row, then fail the invocation when the UPSERT throws', async () => {
    stubTaskWithEni();
    ec2Mock.on(DescribeNetworkInterfacesCommand).resolves({
      NetworkInterfaces: [{ Association: { PublicIp: '1.2.3.4' } }],
    });
    route53Mock.on(ChangeResourceRecordSetsCommand).rejects(new Error('throttled'));
    getPendingMock.mockResolvedValue(pendingRow);
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(handler(stateChange({ game: 'palworld', lastStatus: 'RUNNING' }))).rejects.toThrow('throttled');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body).content).toContain('**palworld**: error');
    expect(deletePendingMock).not.toHaveBeenCalled();
    err.mockRestore();
  });
});
