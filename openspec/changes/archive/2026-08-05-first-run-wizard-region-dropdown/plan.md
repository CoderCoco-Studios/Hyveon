# First-Run Wizard AWS Region Dropdown Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the first-run wizard's guided-IAM region screen's free-text input with a continent-grouped dropdown of AWS regions (human-readable location + code), backed by a committed generated data set, with a manual-entry fallback for any region not yet in that data set.

**Architecture:** A standalone Node script (`build/generate-aws-regions.mjs`) fetches AWS's public region-location JSON and writes a committed TypeScript data file (`app/packages/shared/src/awsRegions.ts`) — no runtime network call. `guided-iam-step.component.tsx`'s `phase === 'region'` screen renders that data through the repo's existing (currently unused) shadcn/Radix `Select` primitives, grouped by continent, with a final "Other (enter manually)" item that swaps back to the original text `<Input>`.

**Tech Stack:** TypeScript, React, `@radix-ui/react-select` (via `ui/select.component.tsx`), Vitest + Testing Library (jsdom), Node's built-in `fetch`.

## Global Constraints

- TSDoc comments (all new exported functions/types/constants) must use only TSDoc-spec tags, `@param name - description` form, structured summary → `@remarks` → `@param`s → `@returns` (per `.claude/rules/tsdoc-tags.md`).
- Test names read as full "should ..." sentences (per `CLAUDE.md`).
- No `as unknown as T` casts in tests; prefer `vi.mocked(fn)` / `Partial<T> as T`.
- `npm run app:lint` and `npm run app:typecheck` must stay clean after every task.
- This change is small enough to ship as a single PR (per `.claude/rules/pr-stacking.md` — well under its ~5-6-file/multi-concern threshold).

---

### Task 1: Static AWS region data set

**Files:**
- Create: `build/generate-aws-regions.mjs`
- Create (generated, committed): `app/packages/shared/src/awsRegions.ts`
- Modify: `app/packages/shared/src/index.ts`
- Modify: `package.json` (root)

**Interfaces:**
- Produces: `AwsRegionInfo` (`{ code: string; name: string; continent: string }`) and `AWS_REGIONS: AwsRegionInfo[]`, exported from `@hyveon/shared`. Task 2 imports both by name.

This task has no dedicated unit test — `awsRegions.ts` is generated data, treated the same as the repo's generated icon assets (per `design.md`'s Risks/Trade-offs and `proposal.md`'s Impact section). Verification is build-level (Steps 4-5 below), not a Vitest spec.

- [ ] **Step 1: Write the generator script**

Create `build/generate-aws-regions.mjs`:

```js
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
```

- [ ] **Step 2: Add the npm command and run the generator**

In root `package.json`, add a script next to `icons:generate`:

```json
    "icons:generate": "node build/generate-icons.mjs",
    "aws-regions:generate": "node build/generate-aws-regions.mjs",
```

Run:

```bash
npm run aws-regions:generate
```

Expected: console output `Wrote NN regions to .../awsRegions.ts` (NN in the mid-30s), and `app/packages/shared/src/awsRegions.ts` now exists with real region data (spot-check that it contains an entry for `us-east-1` and does **not** contain `us-gov-` or `cn-` codes).

- [ ] **Step 3: Export the new module from `@hyveon/shared`**

In `app/packages/shared/src/index.ts`, add a line (anywhere in the existing `export * from './X.js';` list — alphabetical placement isn't enforced by the existing file, so add it near the other flat data/type modules):

```ts
export * from './awsRegions.js';
```

- [ ] **Step 4: Build `@hyveon/shared` to verify the generated file type-checks**

```bash
npm run build -w @hyveon/shared
```

Expected: clean build, no TypeScript errors, `app/packages/shared/dist/awsRegions.js` and `.d.ts` produced.

- [ ] **Step 5: Commit**

```bash
git add build/generate-aws-regions.mjs app/packages/shared/src/awsRegions.ts app/packages/shared/src/index.ts package.json
git commit -m "feat(shared): add generated AWS region location data set"
```

---

### Task 2: Guided-IAM region dropdown

**Files:**
- Modify: `app/packages/web/src/components/first-run-wizard/guided-iam-step.component.tsx:1-9` (imports), `:99-106` (state), `:461-499` (region-phase JSX)
- Modify: `app/packages/web/src/components/first-run-wizard/guided-iam-step.component.test.tsx`

**Interfaces:**
- Consumes: `AWS_REGIONS: AwsRegionInfo[]` from `@hyveon/shared` (Task 1).
- Produces: no new exports — this task only changes `GuidedIamStep`'s internal rendering. `region: string` state and the component's public props (`GuidedIamStepProps`) are unchanged, so nothing downstream (the wizard shell, other steps) needs to change.

This task touches many existing tests because `guided-iam-step.component.test.tsx`'s `advanceToIntake()` helper and several inline test bodies drive the region-phase screen by typing into what is currently a plain `<Input>`. Steps 1-3 update the test file to match the target UI *before* the component changes (so Step 4's failing run demonstrates exactly what Step 5 needs to implement); Step 5 implements; Step 6 confirms green.

- [ ] **Step 1: Add jsdom polyfills and a `chooseRegion` test helper**

In `guided-iam-step.component.test.tsx`, right after the existing imports (after line 3, before the `hyveonMock` declaration), add:

```ts
// Radix Select's pointer-capture and scroll handling aren't implemented in
// jsdom — without these no-op stubs, opening/selecting from the dropdown
// throws "target.hasPointerCapture is not a function" mid-test.
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}
```

Then, right after the existing `advanceToIntake` helper (after its closing `}` — currently ending the function that types into `'AWS region'` and clicks through to `'Access key ID'`), add a new helper:

```ts
/** Opens the region dropdown and selects the option with the given accessible label (e.g. `"US East (N. Virginia) — us-east-1"`). */
async function chooseRegion(label: string) {
  await userEvent.click(screen.getByLabelText('AWS region'));
  await userEvent.click(await screen.findByRole('option', { name: label }));
}
```

- [ ] **Step 2: Update `advanceToIntake` and every region-phase test call site to use `chooseRegion`**

The literal line `await userEvent.type(screen.getByLabelText('AWS region'), 'us-east-1');` appears exactly 9 times in this file — once inside `advanceToIntake` and 8 more times across the `'region and choice screen'` and `'template screen'` describe blocks (each of those blocks first types a region before clicking "Continue with guided setup"). All 9 occurrences target the region-*phase* screen (never the separate intake-phase region field, which is untouched by this change and uses a different literal, e.g. `'ap-southeast-2'`, at the resume test around line 466).

Replace every occurrence of:

```ts
await userEvent.type(screen.getByLabelText('AWS region'), 'us-east-1');
```

with:

```ts
await chooseRegion('US East (N. Virginia) — us-east-1');
```

This is safe as a global find-and-replace of that exact literal within this file — no other test uses that exact string.

- [ ] **Step 3: Add new tests for continent grouping and the manual-entry fallback**

At the end of the `'region and choice screen'` describe block (after its last existing test), add:

```ts
    it('should render regions grouped by continent with location labels', async () => {
      render(<GuidedIamStep onComplete={vi.fn()} onSkipToManual={vi.fn()} />);

      await userEvent.click(screen.getByLabelText('AWS region'));

      expect(await screen.findByRole('option', { name: 'US East (N. Virginia) — us-east-1' })).toBeInTheDocument();
      expect(screen.getByText('North America')).toBeInTheDocument();
      expect(screen.getByText('Europe')).toBeInTheDocument();
      expect(screen.getByRole('option', { name: 'Other (enter manually)' })).toBeInTheDocument();
    });

    it('should set the region and enable continuing once a dropdown option is selected', async () => {
      stubHappyPathDefaults();
      render(<GuidedIamStep onComplete={vi.fn()} onSkipToManual={vi.fn()} />);

      await chooseRegion('EU (Ireland) — eu-west-1');
      await userEvent.click(screen.getByRole('button', { name: /continue with guided setup/i }));

      await waitFor(() =>
        expect(hyveonMock.wizard.saveProgress).toHaveBeenCalledWith({
          step: 'guided-iam',
          guidedIam: { subState: 'not-started', hasBootstrapKey: false },
        }),
      );
      await waitFor(() => expect(hyveonMock.wizard.guidedIamPrepareTemplate).toHaveBeenCalledTimes(1));
    });

    it('should fall back to free-text entry for a region not in the static list, and accept it', async () => {
      stubHappyPathDefaults();
      render(<GuidedIamStep onComplete={vi.fn()} onSkipToManual={vi.fn()} />);

      await userEvent.click(screen.getByLabelText('AWS region'));
      await userEvent.click(await screen.findByRole('option', { name: 'Other (enter manually)' }));
      await userEvent.type(screen.getByLabelText('AWS region'), 'xx-newregion-1');
      await userEvent.click(screen.getByRole('button', { name: /continue with guided setup/i }));

      await waitFor(() => expect(hyveonMock.wizard.guidedIamPrepareTemplate).toHaveBeenCalledTimes(1));
      expect(await screen.findByLabelText('Template path')).toBeInTheDocument();
    });
```

- [ ] **Step 4: Run the test file and confirm it fails**

```bash
npm run app:test -- guided-iam-step.component.test.tsx
```

Expected: FAIL — `getByLabelText('AWS region')` still resolves to the plain `<Input>`, so `chooseRegion`'s click-then-find-option sequence times out, and the three new tests fail to find any `role="option"` elements. This confirms the test file now describes the target behavior and the component hasn't caught up yet.

- [ ] **Step 5: Implement the dropdown in `guided-iam-step.component.tsx`**

Update the import block (lines 1-9) to:

```tsx
import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Copy, ExternalLink, Loader2, RotateCcw } from 'lucide-react';
import type { WizardProgress } from '@hyveon/desktop-preload';
import { AWS_REGIONS, type AwsRegionInfo } from '@hyveon/shared';
import { Button } from '@/components/ui/button.component';
import { Input } from '@/components/ui/input.component';
import { Label } from '@/components/ui/label.component';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select.component';
```

Add, at module scope, after the `BRIDGE_UNAVAILABLE` constant (after line 9's original position, i.e. right after the new imports):

```tsx
/** Sentinel `SelectItem` value for "enter a region manually" — Radix Select forbids an empty-string item value. */
const OTHER_REGION_VALUE = '__other__';

/** {@link AWS_REGIONS} grouped by continent, preserving the generated file's continent-then-name sort order. Computed once at module load since the source data is static. */
const REGIONS_BY_CONTINENT: Array<[string, AwsRegionInfo[]]> = (() => {
  const groups = new Map<string, AwsRegionInfo[]>();
  for (const region of AWS_REGIONS) {
    const list = groups.get(region.continent) ?? [];
    list.push(region);
    groups.set(region.continent, list);
  }
  return [...groups.entries()];
})();
```

Add new state alongside the existing `region`/`regionError` state (after line 106's original position):

```tsx
  const [manualRegionEntry, setManualRegionEntry] = useState(false);
```

Replace the `phase === 'region'` block's region field (originally lines 474-487, the `<div className="space-y-2">...</div>` wrapping the `Label` + `Input` + `regionError`) with:

```tsx
        <div className="space-y-2">
          <Label htmlFor="wizard-guided-iam-region">AWS region</Label>
          {manualRegionEntry ? (
            <Input
              id="wizard-guided-iam-region"
              value={region}
              placeholder="us-east-1"
              onChange={(e) => setRegion(e.target.value)}
              autoFocus
            />
          ) : (
            <Select
              value={region}
              onValueChange={(value) => {
                if (value === OTHER_REGION_VALUE) {
                  setManualRegionEntry(true);
                  setRegion('');
                  return;
                }
                setRegion(value);
              }}
            >
              <SelectTrigger id="wizard-guided-iam-region">
                <SelectValue placeholder="Select a region…" />
              </SelectTrigger>
              <SelectContent>
                {REGIONS_BY_CONTINENT.map(([continent, regions]) => (
                  <SelectGroup key={continent}>
                    <SelectLabel>{continent}</SelectLabel>
                    {regions.map((r) => (
                      <SelectItem key={r.code} value={r.code}>
                        {r.name} — {r.code}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                ))}
                <SelectItem value={OTHER_REGION_VALUE}>Other (enter manually)</SelectItem>
              </SelectContent>
            </Select>
          )}
          {regionError && (
            <p role="alert" className="text-sm text-[var(--color-red)]">
              {regionError}
            </p>
          )}
        </div>
```

No other function in the file changes — `handleChooseGuided`, `handleOpenConsole`, `handleSubmitKey`, and every IPC call site keep reading `region` as a plain string, unaware of whether it came from the Select or the fallback `Input`.

- [ ] **Step 6: Run the test file and confirm it passes**

```bash
npm run app:test -- guided-iam-step.component.test.tsx
```

Expected: PASS — all pre-existing tests (now using `chooseRegion`) and the 3 new tests from Step 3 succeed.

- [ ] **Step 7: Type-check the web package**

```bash
npm run typecheck:full -w @hyveon/web
```

Expected: clean — no type errors from the new `@hyveon/shared` import or the `Select` JSX.

- [ ] **Step 8: Commit**

```bash
git add app/packages/web/src/components/first-run-wizard/guided-iam-step.component.tsx app/packages/web/src/components/first-run-wizard/guided-iam-step.component.test.tsx
git commit -m "feat(web): render guided-IAM region step as a grouped dropdown"
```

---

### Task 3: Full verification pass

**Files:** none (verification only)

- [ ] **Step 1: Lint**

```bash
npm run app:lint
```

Expected: clean.

- [ ] **Step 2: Full typecheck**

```bash
npm run app:typecheck
```

Expected: clean.

- [ ] **Step 3: Full unit suite**

```bash
npm run app:test
```

Expected: all green, including the updated `guided-iam-step.component.test.tsx`.

- [ ] **Step 4: Manual smoke test** *(marked `- [~]` — see below)*

- [~] Launch `npm run desktop:dev`, drive the first-run wizard to "I already have credentials" → back, or directly to the guided-IAM path, reach the region screen, confirm: the dropdown opens grouped by continent, selecting "US East (N. Virginia) — us-east-1" and clicking "Continue with guided setup" advances to the template screen, and re-entering the region screen (fresh mount) then selecting "Other (enter manually)" reveals a working text input.

This manual check has no automated equivalent beyond Task 2's component tests (Task 2 Steps 3/6) and Task 3 Step 3 — it exists to catch real-browser/Electron rendering issues (Radix `Portal` positioning, `SelectContent` z-index/overflow against the wizard's actual layout) that jsdom cannot exercise. If skipped this cycle, record it as a coverage gap rather than silently marking the task done.

- [ ] **Step 5: Commit any fixes found during manual verification, if applicable**

Only if Step 4 surfaces an issue — otherwise no commit needed for this task.
