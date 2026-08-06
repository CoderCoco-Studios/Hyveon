/**
 * Commercial-partition AWS regions with human-readable location labels,
 * generated from AWS's published region/location data. Regenerate with
 * `npm run aws-regions:generate` after AWS launches a new region — do not
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
  { code: 'af-south-1', name: "Africa (Cape Town)", continent: "Africa" },
  { code: 'ap-east-1', name: "Asia Pacific (Hong Kong)", continent: "Asia Pacific" },
  { code: 'ap-south-2', name: "Asia Pacific (Hyderabad)", continent: "Asia Pacific" },
  { code: 'ap-southeast-3', name: "Asia Pacific (Jakarta)", continent: "Asia Pacific" },
  { code: 'ap-southeast-5', name: "Asia Pacific (Malaysia)", continent: "Asia Pacific" },
  { code: 'ap-southeast-4', name: "Asia Pacific (Melbourne)", continent: "Asia Pacific" },
  { code: 'ap-south-1', name: "Asia Pacific (Mumbai)", continent: "Asia Pacific" },
  { code: 'ap-southeast-6', name: "Asia Pacific (New Zealand)", continent: "Asia Pacific" },
  { code: 'ap-northeast-3', name: "Asia Pacific (Osaka)", continent: "Asia Pacific" },
  { code: 'ap-northeast-2', name: "Asia Pacific (Seoul)", continent: "Asia Pacific" },
  { code: 'ap-southeast-1', name: "Asia Pacific (Singapore)", continent: "Asia Pacific" },
  { code: 'ap-southeast-2', name: "Asia Pacific (Sydney)", continent: "Asia Pacific" },
  { code: 'ap-east-2', name: "Asia Pacific (Taipei)", continent: "Asia Pacific" },
  { code: 'ap-southeast-7', name: "Asia Pacific (Thailand)", continent: "Asia Pacific" },
  { code: 'ap-northeast-1', name: "Asia Pacific (Tokyo)", continent: "Asia Pacific" },
  { code: 'eusc-de-east-1', name: "AWS European Sovereign Cloud (Germany)", continent: "Europe" },
  { code: 'eu-central-1', name: "EU (Frankfurt)", continent: "Europe" },
  { code: 'eu-west-1', name: "EU (Ireland)", continent: "Europe" },
  { code: 'eu-west-2', name: "EU (London)", continent: "Europe" },
  { code: 'eu-south-1', name: "EU (Milan)", continent: "Europe" },
  { code: 'eu-west-3', name: "EU (Paris)", continent: "Europe" },
  { code: 'eu-south-2', name: "EU (Spain)", continent: "Europe" },
  { code: 'eu-north-1', name: "EU (Stockholm)", continent: "Europe" },
  { code: 'eu-central-2', name: "EU (Zurich)", continent: "Europe" },
  { code: 'il-central-1', name: "Israel (Tel Aviv)", continent: "Israel" },
  { code: 'me-south-1', name: "Middle East (Bahrain)", continent: "Middle East" },
  { code: 'me-central-1', name: "Middle East (UAE)", continent: "Middle East" },
  { code: 'ca-central-1', name: "Canada (Central)", continent: "North America" },
  { code: 'ca-west-1', name: "Canada West (Calgary)", continent: "North America" },
  { code: 'mx-central-1', name: "Mexico (Central)", continent: "North America" },
  { code: 'us-east-2-mci-1', name: "US East (Kansas City)", continent: "North America" },
  { code: 'us-east-1', name: "US East (N. Virginia)", continent: "North America" },
  { code: 'us-east-2', name: "US East (Ohio)", continent: "North America" },
  { code: 'us-west-1', name: "US West (N. California)", continent: "North America" },
  { code: 'us-west-2', name: "US West (Oregon)", continent: "North America" },
  { code: 'sa-east-1', name: "South America (Sao Paulo)", continent: "South America" },
];
