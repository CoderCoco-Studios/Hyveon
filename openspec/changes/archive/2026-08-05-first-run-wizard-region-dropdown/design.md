## Context

The first-run wizard's guided-IAM flow (`guided-iam-step.component.tsx`)
runs before any AWS credentials exist — it's the path where Hyveon
provisions a bootstrap IAM user for the operator via a CloudFormation
template. Its `phase === 'region'` screen
(`app/packages/web/src/components/first-run-wizard/guided-iam-step.component.tsx:461-499`)
is a free-text `<Input>` with a `"us-east-1"` placeholder and its own local
emptiness-only validation (`handleChooseGuided`,
`guided-iam-step.component.tsx:258-270`, setting `regionError`) — the
operator must already know an exact AWS region code.

No region list or region→location mapping exists anywhere in the repo
today. Region state is plain `useState` (`region`, `setRegion`), entirely
local to `GuidedIamStep` — not lifted to the wizard shell. It is never
written via `wizard.saveState`; it flows directly as a parameter into the
step's own IPC calls (`guidedIamOpenConsole`, `guidedIamSubmitBootstrapKey`,
`guidedIamRotate`, `guidedIamRevokeBootstrapKey`), and the durable
`aws.region` config value is only written server-side, inside
`GuidedIamService.rotate()`, once verification succeeds. (This is a
distinct `region` state from the wizard shell's own credentials-step
`region`/`pasteRegion` fields at `first-run-wizard.component.tsx:111-114`,
which are out of scope for this change.)

Because no credentials exist at this screen, any solution using an AWS API
call is unavailable here — this constrains the data-source decision below.

## Goals / Non-Goals

**Goals:**
- Let the operator pick a region from a dropdown showing its physical
  location, without needing to already know the region code.
- Never block a region the operator wants to use, even one launched after
  this feature ships and not yet in the bundled data.
- Keep the change self-contained: no new runtime network dependency, no
  new IAM permission, no change to how region is validated, stored, or
  consumed downstream.

**Non-Goals:**
- Converting the other three free-text region fields
  (`guided-iam-step.component.tsx`'s intake phase,
  `credentials-step.component.tsx`'s profile/paste modes,
  `deployment-settings-form.component.tsx`). Same pattern could be applied
  later; not part of this change.
- Filtering or greying out regions the account hasn't opted into (would
  require a live `DescribeRegions` call, which needs credentials this
  screen doesn't have yet). Possible follow-up once credentials exist
  later in the flow.
- Any live AWS API call at this wizard step.

## Decisions

### D1: Region data source — committed static file, generated at build time

- **Choice**: A manually-triggered script fetches AWS's public
  `locations.json` and writes a committed TypeScript file,
  `app/packages/shared/src/awsRegions.ts`
  (`AWS_REGIONS: AwsRegionInfo[]`, `{ code, name, continent }`),
  regenerated on demand via a new `aws-regions:generate` npm command —
  the same pattern as the existing `icons:generate` command. No network
  call happens at wizard runtime.
- **Rationale**: this is the only option that works with zero credentials
  and zero new IAM surface, which is required since the guided-IAM region
  screen runs before any credentials exist.
- **Alternatives considered**:
  - `EC2 DescribeRegions` — rejected: requires credentials not yet
    available at this screen, and returns country names only
    (`"United States of America"`), not city-level physical locations
    (`"N. Virginia"`).
  - SSM public parameters
    (`/aws/service/global-infrastructure/regions/...`) — rejected:
    confirmed **not** anonymous (unsigned calls fail with
    `MissingAuthenticationTokenException`; the repo's own deploy user
    lacks `ssm:GetParametersByPath`), would need a new `HyveonDeployAll`
    grant, and needs N+1 calls (one per region for `longName`) versus one
    static file.
  - Fetch the static JSON live at wizard runtime instead of generating a
    committed file — rejected: adds a network dependency and a
    loading/failure UI state to a screen that has none today, for data
    that changes on the order of months, not per-session.

### D2: Manual-entry fallback for regions outside the static map

- **Choice**: The dropdown's last item is `"Other (enter manually)"`.
  Selecting it swaps the Select for the original free-text `<Input>`
  (pre-focused), unchanged from today's behavior.
- **Rationale**: directly addresses the Goal that a static, only-updated-
  on-request data file must never block a real region — a newly-launched
  AWS region is usable immediately via manual entry, without waiting on a
  regenerate-and-release cycle. Raised explicitly during brainstorming as
  a condition of approving the static-file approach (see brainstorm.md
  Q2).
- **Alternatives considered**:
  - Always-visible manual-entry link below the dropdown — rejected:
    permanent UI element for a rarely-needed escape hatch; an in-list
    item is more familiar (fits the existing Select affordance) and no
    less discoverable.

### D3: UI primitive — shadcn/Radix `Select`

- **Choice**: Use the already-scaffolded `Select`/`SelectGroup`/
  `SelectLabel`/`SelectItem` family at
  `app/packages/web/src/components/ui/select.component.tsx`
  (`@radix-ui/react-select`, already a dependency).
- **Rationale**: this is exactly the primitive continent-grouping needs
  (`SelectGroup` + `SelectLabel`), and it's already present in the repo —
  just unused. No new dependency.
- **Alternatives considered**:
  - Native `<select>` with `<optgroup>` (the pattern used by the
    adjacent profile picker in `credentials-step.component.tsx:163-175`)
    — rejected: styling `<optgroup>` labels consistently with the rest of
    the wizard's shadcn-styled controls is harder than using the
    component already built for this.

### D4: Data placement — `@hyveon/shared`

- **Choice**: `awsRegions.ts` lives in `@hyveon/shared/src`, exported from
  its `index.ts` barrel.
- **Rationale**: region data isn't web-UI-specific; placing it in the
  shared package keeps it reusable if `desktop-main` or another package
  ever needs region labels, consistent with how cross-cutting logic like
  `canRun()` is placed in `@hyveon/shared`.
- **Alternatives considered**: scoping the file to `@hyveon/web` only —
  rejected as unnecessarily narrow for data that isn't web-specific, per
  user preference during brainstorming (Q6).

### D5: Display format and sort order

- **Choice**: Each item reads `"{name} — {code}"` (e.g.
  `"US East (N. Virginia) — us-east-1"`); items are grouped by continent,
  alphabetical by name within each group; continent groups themselves
  follow the order the source data naturally provides.
- **Rationale**: friendly name first serves the primary goal (find your
  region by location); the code stays visible for operators who already
  know it. Continent grouping is more scannable than a flat 38-item
  alphabetical list for someone who knows their rough geography.
- **Alternatives considered**: code-first display, flat alphabetical
  list, friendly-name-only display — all considered and set aside in
  favor of the chosen combination during brainstorming (Q5, Q7).

## Risks / Trade-offs

- [Risk] The static map goes stale after AWS launches a new region, and
  nobody remembers to regenerate it. → Mitigation: D2's manual-entry
  fallback means staleness degrades to "one extra click," never a hard
  block — the goal that drove this decision.
- [Risk] `locations.json` is an AWS marketing/static-assets URL, not a
  versioned public API — it could change shape or move without notice.
  → Mitigation: the generator script is a manual, on-demand dev-time
  step (not part of CI or the build), so a shape change is caught and
  fixed by a human at generation time, not silently in production.
- [Trade-off] No live opt-in-region filtering means an operator could
  pick a region their account hasn't enabled, and only find out when the
  guided IAM flow's later AWS calls fail. → Accepted: this is no worse
  than today's free-text behavior, and matches the stated Non-Goal of not
  adding a live AWS call to this screen.

## Migration Plan

N/A — this change involves no deployment changes. It's an additive UI +
build-time-generated-data change with no IPC, IAM policy, DeploymentConfig,
or infra impact, and no existing stored data to migrate (`region` remains
a plain string in the same place).

## Open Questions

None outstanding — all decisions were resolved during brainstorming
(brainstorm.md Q1–Q7) and confirmed by the user before this proposal was
written.
