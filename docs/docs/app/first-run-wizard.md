---
title: First-run wizard
sidebar_position: 2
---

# First-run wizard

The first time you launch Hyveon, the app replaces its entire window with a
four-step setup wizard. There is no sidebar, no dashboard, and no way to skip
it — until the wizard finishes, the app has no Pulumi state backend to talk
to and nothing else would work.

The header reads **Welcome to Hyveon**, with a subtitle showing
`Step N of 4: <step title>`.

| # | Step | What it does |
|---|---|---|
| 1 | Choose your cloud | Picks the cloud provider (AWS only, today) |
| 2 | AWS credentials | Picks an AWS profile, or stores pasted access keys |
| 3 | Bootstrap AWS resources | Creates the S3 state bucket and S3 tfvars bucket |
| 4 | Finish setup | Initializes the Pulumi stack against that new backend |

At the bottom of every step: **Back** (disabled on step 1) and **Next**. Step 4
has no Next — it has its own **Finish setup** button instead.

## Step 1 — Choose your cloud

![The cloud selection step showing a single Amazon Web Services option, pre-selected, with a note that more clouds are coming](/img/app/wizard-pick-cloud.png)

> Choose the cloud provider Hyveon will deploy your game servers to.

One option today — **Amazon Web Services (AWS)**, described as "ECS Fargate,
EFS, Route 53, DynamoDB, Secrets Manager" — and it is pre-selected. A footnote
reads "More clouds are coming in a future release."

Nothing blocks Next. Clicking it saves your choice; if that save fails, an
error appears and you stay on the step so nothing silently drifts.

## Step 2 — AWS credentials

![The credentials step with the Use an existing profile mode selected, a profile dropdown and a region field](/img/app/wizard-credentials.png)

> Choose the AWS credentials Hyveon will use to manage your game servers.

Two modes, chosen with a pair of toggle buttons.

### Use an existing profile (default)

The app reads your AWS CLI config and lists the profiles it finds.

| Field | Notes |
|---|---|
| **Profile** | Dropdown, placeholder `Select a profile…` |
| **Region** | Text, placeholder `us-east-1`. Auto-filled from the selected profile's own configured region, and freely editable |

While the profile list loads you see "Loading AWS profiles…". If there are
none:

> No AWS CLI profiles found on this machine. Use "Paste keys instead" below.

### Paste keys instead

| Field | Type |
|---|---|
| **Access key ID** | Text |
| **Secret access key** | Password |
| **Region** | Text, placeholder `us-east-1` |

Press **Save credentials**. The keys are encrypted with your operating
system's keychain and stored under a profile named `hyveon-pasted`; on success
the step shows `Saved as profile "hyveon-pasted"`.

Editing any of the three fields after saving clears that confirmation, so you
must press **Save credentials** again before you can continue. This is
intentional — it stops you advancing with keys you typed but never committed.

If your OS keychain is unavailable, the save is refused rather than falling
back to plaintext:

> Cannot save pasted AWS credentials: the OS keychain (safeStorage) is
> unavailable. Pasted keys are never stored in plaintext — pick an existing
> AWS CLI profile instead.

### What blocks Next

- **Profile mode**: a profile must be selected *and* the region must be
  non-empty.
- **Paste mode**: **Save credentials** must have succeeded *and* the region
  must be non-empty.

The region is mandatory in both modes because the Terraform S3 backend has no
region default to fall back on.

## Step 3 — Bootstrap AWS resources

![The bootstrap step showing two editable resource-name fields with status badges, a Bootstrap AWS resources button, and an IAM permission check section](/img/app/wizard-bootstrap.png)

> Hyveon needs two AWS resources to manage its Pulumi state, plus a
> permission check against your account. Resource names are editable — the
> defaults below are usually fine.

| Resource | Default name | What it is |
|---|---|---|
| State bucket | `hyveon-tfstate` | S3 bucket, versioning enabled, AES256 encryption — Pulumi's self-managed backend reads/writes state here directly; there is no separate lock table (the DIY S3 backend locks via objects in this same bucket) |
| Tfvars bucket | `hyveon-tfvars` | S3 bucket, versioning enabled, non-current versions expire after 90 days |

These are created with the AWS SDK directly — the wizard does not shell out to
any CLI for this step.

Press **Bootstrap AWS resources**. Both are created concurrently, so one
failure does not stop the other. Each row's badge moves independently:

| Badge | Meaning |
|---|---|
| **Pending** | Not attempted yet |
| **Creating…** | In flight |
| **Created** | Newly created by this run |
| **Already exists** | Found and left alone (re-configuration applied) |
| **Failed** | With the error message beneath the row |

Once a resource reaches **Created** or **Already exists**, its name field
locks. The button relabels itself to **Re-run bootstrap**, which is safe to
press repeatedly — versioning, encryption and lifecycle settings are
re-asserted on every run.

**Common failures and how to recover:**

| Message | Fix |
|---|---|
| `The bucket name "…" is already taken by another AWS account. Choose a different name.` | S3 bucket names are globally unique. Edit the name (failed rows stay editable) and re-run |
| `Cannot bootstrap AWS resources: no region is configured. Complete the credentials step of the wizard first.` | Go **Back** and finish step 2 |

**What blocks Next:** both resources must be **Created** or **Already
exists**.

### The IAM permission check is advisory

Below the resources is an **IAM permission check** section with a **Check
permissions** button (it relabels to **Re-check permissions** afterwards).

**This check never blocks Next, and it never runs on its own.** You can
complete the entire wizard without ever pressing it. It exists so you find out
about a missing IAM action now rather than halfway through your first
`terraform apply`.

It resolves your caller identity, then asks IAM to simulate every action in
the `HyveonDeployAll` policy against your principal. Three outcomes:

| Result | What you see |
|---|---|
| **Passed** | "All required permissions are present." |
| **Missing** | "Some permissions are missing. Paste the policy below into your IAM user's inline policy." followed by a ready-to-paste JSON policy containing exactly the denied actions, with a copy button |
| **Warning** | The reason the simulation could not run (for example, your principal cannot call `iam:SimulatePrincipalPolicy`), followed by the full list of actions to check by hand |

The full policy, and where to put it, is documented in the
[setup guide](/setup).

## Step 4 — Finish setup

![The final wizard step showing a three-item checklist — engine resolution, provider plugins, stack creation — with a Finish setup button below](/img/app/wizard-stack-init.png)

> Initializing your Pulumi stack. This resolves the deployment engine,
> installs the required provider plugins, and creates the stack against your
> new backend.

This step **starts automatically on arrival** — there is no Start button. It
calls `PulumiService.initializeStack`, which needs no configuration from
earlier steps — it resolves the state bucket and region it needs from what
you already entered — and reports progress as three phases, rendered as a
checklist rather than a scrolling log (there is no `terraform init`-style
process output to show here):

| Phase | What it does |
|---|---|
| **Resolving the Pulumi engine** | Downloads and verifies the pinned Pulumi CLI engine on first use, and constructs the Automation API workspace against your S3 backend — generating a fresh secrets passphrase the first time |
| **Installing provider plugins** | Explicitly installs the `@pulumi/aws` provider plugin your deployment will need |
| **Creating the stack** | Runs a `pulumi refresh` against the brand-new, still-empty stack to prove the whole round trip — engine, backend, credentials, and plugin — actually works |

Each phase shows a pending circle, then a spinner, then a checkmark (or an ✕
if it failed).

| Outcome | UI |
|---|---|
| Success | Green "Stack initialization complete." |
| Failure | Red alert naming which phase failed and why, plus a **Retry** button |

**Finish setup** is enabled only once every phase succeeds. Clicking it marks
setup complete and drops you straight onto the dashboard.

## Resuming an interrupted setup

Progress is saved on **every step change**, so closing the app mid-wizard is
safe. On relaunch you land back on the step you were on.

One deliberate exception: **you never resume directly into step 4**. If you
quit while stack initialization was running, the app puts you back on step 3
(Bootstrap AWS resources) instead. Step 4 needs no renderer-supplied
configuration to run — it resolves the state bucket and region it needs from
already-persisted settings — but jumping straight to it on relaunch would
still fire a real, write-side stack-initialization call before you have seen
or confirmed anything on this visit, so the app clamps the jump at step 3
regardless. Landing on step 3 is safe because it reads your region from the
stored settings, and the worst case is that you press **Re-run bootstrap**
once more.

Two other resume caveats worth knowing:

- Only the *step pointer* is restored. Your region, selected profile and
  bootstrap resource names all fall back to their defaults on relaunch, even
  though they were saved. (The Reconfigure flow below *does* restore them.)
- If saving progress fails, you simply start from step 1 next time. Nothing
  breaks.

Finishing the wizard deletes the resume file.

## Reconfigure

The same wizard is reachable later from **Settings → Cloud Setup →
Reconfigure**. Use it to switch AWS profiles, change region, or re-point
Pulumi at differently-named bootstrap resources.

It behaves differently in three ways. The header reads **Reconfigure Hyveon**
— otherwise the step count and numbering (`Step 1 of 4` through `Step 4 of
4`) are identical to first-run.

**Every step starts collapsed.** Instead of a form you see a summary box:

> ✓ AWS credentials is already configured.  **[Edit]**

Press **Edit** to expand that step's real form. Steps you never expand stay
collapsed all the way through. (There is no way to re-collapse a step once
expanded — press **Cancel** and start again if you change your mind.)

**Your existing answers are pre-filled.** Unlike the first-run flow, the
Reconfigure wizard reads your stored settings back: your cloud, your profile
and region, and your bootstrap resource names — so the collapsed step
summaries reflect what's actually configured, not first-run defaults. The
final step itself needs none of this prefilled state (it resolves its own
state bucket/region internally, the same way it does on first run) — the
prefill only feeds the earlier steps' summaries and editable forms.

**All edits are buffered into a single save on Finish.** Advancing between
steps persists nothing. Only when you press **Finish setup** are your changes
written, and only for the steps you actually expanded — a step left collapsed
is omitted entirely rather than re-submitted with possibly-stale local values.
There is also a **Cancel** button next to Back, which discards the whole
session.

One thing Cancel cannot undo: the **Save credentials** and **Bootstrap AWS
resources** buttons perform real work the moment you click them, exactly as in
the first-run flow. If you saved a pasted key it is still in your keychain,
and if you created an S3 bucket it still exists. Cancel only prevents your
*active* configuration from being pointed at them.
