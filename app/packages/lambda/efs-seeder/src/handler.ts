import { writeFileSync, mkdirSync } from 'fs';
import { dirname, resolve, join } from 'path';

interface FileSeed {
  path: string;
  content?: string;
  content_base64?: string;
  mode?: string;
}

/** Payload sent by the `aws.lambda.Invocation` resource the infra program declares per game (`app/packages/infra/src/escapes.ts`'s `defineEfsSeederInvocations`). */
interface SeederEvent {
  game: string;
  seeds: FileSeed[];
  /** The first volume's `container_path`, used to resolve in-container paths to EFS-relative paths. */
  container_path: string;
}

// Must stay identical to `infra/src/lambdas.ts`'s `localMountPath: '/mnt/efs'` — changing one without the other breaks the mount.
const MOUNT_POINT = '/mnt/efs';

/**
 * Strips the container_path prefix from a seed path and resolves it to an
 * absolute destination under MOUNT_POINT.  Throws on path-traversal attempts
 * or if the path resolves to the mount root (i.e. no file name was given).
 */
function resolveDestination(seedPath: string, containerPath: string): string {
  const normalizedContainer = containerPath.replace(/\/$/, '');

  if (seedPath === normalizedContainer) {
    throw new Error(`Seed path "${seedPath}" has no file component after container_path`);
  }

  if (!seedPath.startsWith(normalizedContainer + '/')) {
    throw new Error(
      `Seed path "${seedPath}" does not start with container_path "${normalizedContainer}"`,
    );
  }

  const relative = seedPath.slice(normalizedContainer.length).replace(/^\//, '');

  const dest = resolve(join(MOUNT_POINT, relative));

  if (!dest.startsWith(MOUNT_POINT + '/')) {
    throw new Error(`Path traversal detected: "${seedPath}" resolves outside mount point`);
  }

  return dest;
}

/**
 * Writes each `file_seeds` entry to the EFS access point mounted at
 * `/mnt/efs`.  Invoked synchronously by the `aws.lambda.Invocation` resource
 * during the infra program's Pulumi apply (run through `PulumiService`);
 * throws on any error so the apply surfaces the failure.
 */
export const handler = async (event: SeederEvent): Promise<void> => {
  const { game, seeds, container_path: containerPath } = event;

  console.log(`Seeding ${seeds.length} file(s) for game "${game}" (mount: ${MOUNT_POINT})`);

  for (const seed of seeds) {
    const dest = resolveDestination(seed.path, containerPath);

    if (seed.content !== undefined && seed.content_base64 !== undefined) {
      throw new Error(
        `Seed at path "${seed.path}" sets both content and content_base64 — use one or the other`,
      );
    }

    let content: Buffer;
    if (seed.content_base64 !== undefined) {
      content = Buffer.from(seed.content_base64, 'base64');
    } else if (seed.content !== undefined) {
      content = Buffer.from(seed.content, 'utf8');
    } else {
      throw new Error(`Seed at path "${seed.path}" has neither content nor content_base64`);
    }

    const modeStr = seed.mode ?? '0644';
    if (!/^0?[0-7]{3,4}$/.test(modeStr)) {
      throw new Error(`Seed at path "${seed.path}" has invalid mode "${modeStr}" — expected an octal string such as "0644"`);
    }
    const mode = parseInt(modeStr, 8);

    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, content, { flag: 'w', mode });

    console.log(`Wrote ${dest} (${content.length} bytes, mode ${seed.mode ?? '0644'})`);
  }

  console.log(`Done — ${seeds.length} file(s) seeded for game "${game}"`);
};
