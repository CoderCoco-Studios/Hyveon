/**
 * Hostname pinning for Node.js game servers whose license is bound to the hostname (e.g. Foundry VTT).
 *
 * An init container writes a CommonJS preload that replaces `os.hostname()` into a task-ephemeral volume; the game
 * container loads it through `NODE_OPTIONS=--require=…`. This file owns the shim bytes, the init-container definition,
 * and the `NODE_OPTIONS` merge — {@link defineEcs} only wires them into the task definition.
 */

import { HOSTNAME_SHIM_MOUNT_PATH, HOSTNAME_SHIM_RESERVED_NAME, type GameServerEnvironmentVariable } from '@hyveon/shared';

/**
 * Init-container image. Exact tag so task definitions stay reproducible; ECR Public mirror avoids Docker Hub anonymous
 * pull-rate limits. Re-check the registry for the newest release whenever this is touched.
 */
export const HOSTNAME_SHIM_IMAGE = 'public.ecr.aws/docker/library/busybox:1.38.0';

/** Name of the init container, also its `dependsOn` target and `awslogs` stream prefix. */
export const HOSTNAME_SHIM_CONTAINER_NAME = HOSTNAME_SHIM_RESERVED_NAME;

/** Container path of the generated shim file inside the shared volume. */
const HOSTNAME_SHIM_FILE_PATH = `${HOSTNAME_SHIM_MOUNT_PATH}/hostname-shim.js`;

/** The `NODE_OPTIONS` fragment that preloads the shim. */
const HOSTNAME_SHIM_REQUIRE_FLAG = `--require=${HOSTNAME_SHIM_FILE_PATH}`;

/**
 * Names the task-ephemeral volume that carries the shim from the init container to the game container.
 *
 * @param game - The game name.
 * @returns The task-definition volume name, `${game}-hostname-shim`.
 */
export function hostnameShimVolumeName(game: string): string {
  return `${game}-hostname-shim`;
}

/**
 * Generates the CommonJS preload that makes `os.hostname()` return a fixed value.
 *
 * @param hostname - The value to return; embedded with `JSON.stringify`, so it is a plain JS string literal.
 * @returns The shim file contents.
 */
export function buildHostnameShimSource(hostname: string): string {
  return `const os = require('node:os');\nos.hostname = () => ${JSON.stringify(hostname)};\n`;
}

/**
 * Builds the non-essential init container that writes the shim into the shared volume and exits.
 *
 * @remarks
 * The shim travels base64-encoded, so no shell quoting is involved whatever the hostname holds.
 *
 * @param args - The game, the hostname to pin, and the pre-built `logConfiguration` (stream prefix
 *   {@link HOSTNAME_SHIM_CONTAINER_NAME}).
 * @returns The container definition, ready to embed in `containerDefinitions`.
 */
export function buildHostnameShimContainer(args: {
  game: string;
  hostname: string;
  logConfiguration: Record<string, unknown>;
}): Record<string, unknown> {
  const encoded = Buffer.from(buildHostnameShimSource(args.hostname), 'utf8').toString('base64');
  return {
    name: HOSTNAME_SHIM_CONTAINER_NAME,
    image: HOSTNAME_SHIM_IMAGE,
    essential: false,
    command: ['/bin/sh', '-c', `echo ${encoded} | base64 -d > ${HOSTNAME_SHIM_FILE_PATH}`],
    mountPoints: [
      { sourceVolume: hostnameShimVolumeName(args.game), containerPath: HOSTNAME_SHIM_MOUNT_PATH, readOnly: false },
    ],
    logConfiguration: args.logConfiguration,
  };
}

/**
 * Ensures exactly one `NODE_OPTIONS` entry that loads the shim first.
 *
 * @remarks
 * An existing entry keeps its position and its value follows the shim flag, so tokens in the operator's value (such as
 * the ipv4 token the boot wrapper substitutes) survive. Call after token resolution and before the wrapper is built.
 *
 * @param environment - The game's resolved environment variables.
 * @returns A new array; the input is not mutated.
 */
export function mergeNodeOptions(environment: GameServerEnvironmentVariable[]): GameServerEnvironmentVariable[] {
  if (!environment.some((variable) => variable.name === 'NODE_OPTIONS')) {
    return [...environment, { name: 'NODE_OPTIONS', value: HOSTNAME_SHIM_REQUIRE_FLAG }];
  }
  return environment.map((variable) =>
    variable.name === 'NODE_OPTIONS'
      ? { ...variable, value: `${HOSTNAME_SHIM_REQUIRE_FLAG} ${variable.value}` }
      : variable,
  );
}
