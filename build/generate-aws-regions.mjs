/**
 * Fetches AWS's published region/location data and writes a committed,
 * typed region list to app/packages/shared/src/awsRegions.ts. Run with
 * `npm run aws-regions:generate` after AWS launches a new region — the
 * output is committed so nothing needs to be regenerated at build time.
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BUILD_DIR = dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = join(BUILD_DIR, '..', 'app', 'packages', 'shared', 'src', 'awsRegions.ts');

const LOCATIONS_URL = 'https://b0.p.awsstatic.com/locations/1.0/aws/current/locations.json';

/**
 * Region-code prefixes excluded from the commercial-partition data set —
 * GovCloud regions are published under `type: "AWS Region"` in AWS's feed
 * alongside commercial regions, but are unreachable through Hyveon's guided
 * IAM bootstrap flow. China-partition regions use these same prefixes and
 * are excluded for the same reason (though AWS's public feed does not
 * currently list any).
 */
const EXCLUDED_PREFIXES = ['us-gov-', 'cn-'];

async function main() {
  const response = await fetch(LOCATIONS_URL);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${LOCATIONS_URL}: ${response.status} ${response.statusText}`);
  }
  /** @type {Record<string, { name: string; code: string; type: string; label: string; continent: string }>} */
  const locations = await response.json();

  const regions = Object.values(locations)
    .filter((entry) => entry.type === 'AWS Region')
    .filter((entry) => !EXCLUDED_PREFIXES.some((prefix) => entry.code.startsWith(prefix)))
    .map((entry) => ({ code: entry.code, name: entry.name, continent: entry.continent }))
    .sort((a, b) => a.continent.localeCompare(b.continent) || a.name.localeCompare(b.name));

  if (regions.length === 0) {
    throw new Error('No AWS Region entries found in the fetched location data — refusing to write an empty file.');
  }

  const entries = regions
    .map((r) => `  { code: '${r.code}', name: ${JSON.stringify(r.name)}, continent: ${JSON.stringify(r.continent)} },`)
    .join('\n');

  const output = `/**
 * Commercial-partition AWS regions with human-readable location labels,
 * generated from AWS's published region/location data. Regenerate with
 * \`npm run aws-regions:generate\` after AWS launches a new region — do not
 * hand-edit this file.
 *
 * @remarks
 * GovCloud and China-partition regions are excluded: they are unreachable
 * through Hyveon's guided IAM bootstrap flow.
 */

/** A single AWS region's code, human-readable location name, and continent grouping. */
export interface AwsRegionInfo {
  code: string;
  name: string;
  continent: string;
}

/** Commercial-partition AWS regions, sorted by continent then region name. */
export const AWS_REGIONS: AwsRegionInfo[] = [
${entries}
];
`;

  writeFileSync(OUTPUT_PATH, output);
  console.log(`Wrote ${regions.length} regions to ${OUTPUT_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
