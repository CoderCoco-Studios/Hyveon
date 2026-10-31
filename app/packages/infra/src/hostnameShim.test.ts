import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HOSTNAME_SHIM_MOUNT_PATH } from '@hyveon/shared';
import { afterEach, describe, expect, it } from 'vitest';
import {
  HOSTNAME_SHIM_CONTAINER_NAME,
  HOSTNAME_SHIM_IMAGE,
  buildHostnameShimContainer,
  buildHostnameShimSource,
  hostnameShimVolumeName,
  mergeNodeOptions,
} from './hostnameShim.js';

const SHIM_REQUIRE = `--require=${HOSTNAME_SHIM_MOUNT_PATH}/hostname-shim.js`;
const IPV4_TOKEN = '${hyveon.network.public-ipv4}';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Writes the generated shim to a temp file, preloads it into a child Node process, and returns what `os.hostname()` printed. */
function hostnameSeenByNode(hostname: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'hostname-shim-'));
  tempDirs.push(dir);
  const file = join(dir, 'hostname-shim.js');
  writeFileSync(file, buildHostnameShimSource(hostname));
  return execFileSync(
    process.execPath,
    ['--require', file, '-e', "process.stdout.write(require('node:os').hostname())"],
    { encoding: 'utf8' },
  );
}

describe('buildHostnameShimSource', () => {
  // @spec IAC-PROGRAM-HOST-002
  it('should make os.hostname return the value', () => {
    expect(hostnameSeenByNode('foundry')).toBe('foundry');
  });

  it('should return an underscore hostname verbatim', () => {
    expect(hostnameSeenByNode('my_foundry_host')).toBe('my_foundry_host');
  });
});

// @spec GAME-HOST-006
describe('buildHostnameShimContainer', () => {
  const logConfiguration = { logDriver: 'awslogs', options: { 'awslogs-stream-prefix': 'hostname-shim' } };

  // @spec IAC-PROGRAM-HOST-002
  it('should decode to the shim and mount the game volume read-write as a non-essential container', () => {
    const container = buildHostnameShimContainer({ game: 'foundry', hostname: 'my_foundry_host', logConfiguration });

    expect(container.name).toBe(HOSTNAME_SHIM_CONTAINER_NAME);
    expect(container.image).toBe(HOSTNAME_SHIM_IMAGE);
    expect(container.essential).toBe(false);
    expect(container.mountPoints).toEqual([
      { sourceVolume: 'foundry-hostname-shim', containerPath: '/hyveon/hostname-shim', readOnly: false },
    ]);
    expect(container.logConfiguration).toBe(logConfiguration);

    const command = container.command as string[];
    expect(command.slice(0, 2)).toEqual(['/bin/sh', '-c']);
    const match = /^echo ([A-Za-z0-9+/=]+) \| base64 -d > \/hyveon\/hostname-shim\/hostname-shim\.js$/.exec(command[2]);
    expect(match).not.toBeNull();
    expect(Buffer.from(match![1], 'base64').toString('utf8')).toBe(buildHostnameShimSource('my_foundry_host'));
  });
});

describe('hostnameShimVolumeName', () => {
  it('should prefix the game name', () => {
    expect(hostnameShimVolumeName('foundry')).toBe('foundry-hostname-shim');
  });
});

// @spec GAME-HOST-009
describe('mergeNodeOptions', () => {
  // @spec IAC-PROGRAM-HOST-006
  it('should append a shim-only NODE_OPTIONS when absent', () => {
    expect(mergeNodeOptions([{ name: 'EULA', value: 'TRUE' }])).toEqual([
      { name: 'EULA', value: 'TRUE' },
      { name: 'NODE_OPTIONS', value: SHIM_REQUIRE },
    ]);
  });

  // @spec IAC-PROGRAM-HOST-007
  it('should prefix the operator value at its original index', () => {
    const merged = mergeNodeOptions([
      { name: 'A', value: '1' },
      { name: 'NODE_OPTIONS', value: '--max-old-space-size=2048' },
      { name: 'B', value: '2' },
    ]);

    expect(merged).toEqual([
      { name: 'A', value: '1' },
      { name: 'NODE_OPTIONS', value: `${SHIM_REQUIRE} --max-old-space-size=2048` },
      { name: 'B', value: '2' },
    ]);
  });

  it('should keep the ipv4 token in the merged NODE_OPTIONS', () => {
    const [merged] = mergeNodeOptions([{ name: 'NODE_OPTIONS', value: `--title=${IPV4_TOKEN}` }]);

    expect(merged.value).toBe(`${SHIM_REQUIRE} --title=${IPV4_TOKEN}`);
  });

  it('should not mutate its input', () => {
    const input = [{ name: 'NODE_OPTIONS', value: '--x' }];
    mergeNodeOptions(input);
    expect(input).toEqual([{ name: 'NODE_OPTIONS', value: '--x' }]);
  });
});
