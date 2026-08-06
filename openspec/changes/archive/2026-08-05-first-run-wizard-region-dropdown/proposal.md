## Why

The first-run wizard's guided-IAM region screen is a free-text input with
emptiness-only validation — a user must already know the exact AWS region
code (e.g. `eu-west-1`) to proceed, with no in-app way to see what regions
exist or where they're physically located. This is the first AWS-facing
screen most users hit, before any credentials exist, so a wrong or unknown
region code silently blocks the rest of setup. A grouped dropdown with
human-readable location labels removes that guesswork for the common case
while still allowing any region code via a manual-entry fallback.

## What Changes

**Guided-IAM region screen**
- From: `guided-iam-step.component.tsx`'s `phase === 'region'` screen
  renders a free-text `<Input>` with a `"us-east-1"` placeholder and no
  format guidance.
- To: the same screen renders a Select grouped by continent, each item
  showing `"{friendly name} — {region code}"` (e.g.
  `"US East (N. Virginia) — us-east-1"`), sorted alphabetically within
  each continent group. A final `"Other (enter manually)"` item swaps the
  Select for the original text `<Input>` (pre-focused), preserving
  today's exact free-text behavior for any region absent from the list.
- Reason: removes the need to already know an exact region code, without
  removing the ability to enter one manually if the bundled list hasn't
  caught up with a newly-launched AWS region.
- Impact: non-breaking. `region: string` state shape, its local emptiness
  validation (`handleChooseGuided`), and how downstream IPC calls consume
  it are unchanged.

**New region data source**
- A generator script (`build/generate-aws-regions.mjs`,
  run via a new `aws-regions:generate` npm command) fetches AWS's
  public, unauthenticated region-location JSON and writes a committed
  static file, `app/packages/shared/src/awsRegions.ts`, exporting
  `AWS_REGIONS: AwsRegionInfo[]` (`{ code, name, continent }`).
- Reason: no AWS API returns human-readable physical-location names
  (city-level) without credentials that don't exist yet at this wizard
  step — `EC2 DescribeRegions` needs credentials and returns country
  names only; SSM's public region parameters need credentials plus a new
  IAM grant and N+1 calls. AWS's own static location JSON needs neither.
- Impact: new build-time-only script and generated file; no runtime
  network dependency added to the shipped app.

## Capabilities

### New Capabilities
- `guided-region-selection`: the guided-IAM wizard step's region-selection
  behavior — a continent-grouped dropdown of AWS regions with
  human-readable location labels, backed by a static generated data set,
  with a manual-entry fallback for regions not yet in that data set. (No
  existing capability spec currently owns the guided-IAM step's region
  screen — `aws-credentials` covers only the separate pick-or-paste
  credentials step, and `wizard-flow` covers overall wizard sequencing,
  not this screen's field-level behavior.)

### Modified Capabilities
(none — no existing capability's requirements change)

## Impact

- `app/packages/shared/src/awsRegions.ts` (new, generated) and
  `app/packages/shared/src/index.ts` (new export).
- `build/generate-aws-regions.mjs` (new).
- `package.json` — new `aws-regions:generate` script.
- `app/packages/web/src/components/first-run-wizard/guided-iam-step.component.tsx`
  — region-phase JSX and local state.
- `app/packages/web/src/components/ui/select.component.tsx` — first real
  usage in the app (already present, currently unused).
- Test coverage: `guided-iam-step.component.tsx`'s jsdom component spec.
- No IPC, IAM policy, DeploymentConfig, or infra changes.
