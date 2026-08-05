---
title: First-run wizard
sidebar_position: 2
---

# First-run wizard

The first time you launch Hyveon, the app replaces its entire window with a
five-step setup wizard. There is no sidebar, no dashboard, and no way to skip
it — until the wizard finishes, the app has no Pulumi state backend to talk
to and nothing else would work.

The header reads **Welcome to Hyveon**, with a subtitle showing
`Step N of 5: <step title>`.

| # | Step | What it does |
|---|---|---|
| 1 | Choose your cloud | Picks the cloud provider (AWS only, today) |
| 2 | Provision AWS access | Optionally has Hyveon create and rotate an AWS deploy principal for you via a guided CloudFormation flow, or lets you skip straight to supplying your own credentials |
| 3 | AWS credentials | Picks an AWS profile, or stores pasted access keys — skipped over automatically if step 2's guided flow already established a credential |
| 4 | Bootstrap AWS resources | Creates the S3 state bucket, S3 configuration bucket, and DynamoDB run-history table |
| 5 | Finish setup | Initializes the Pulumi stack against that new backend |

At the bottom of every step: **Back** (disabled on step 1) and **Next**. Step 5
has no Next — it has its own **Finish setup** button instead. Step 2 also has
no shared Next button of its own (see that step's walkthrough below) except
when Reconfigure has collapsed it to an already-completed summary.

## Step 1 — Choose your cloud

![The cloud selection step showing a single Amazon Web Services option, pre-selected, with a note that more clouds are coming](/img/app/wizard-pick-cloud.png)

> Choose the cloud provider Hyveon will deploy your game servers to.

One option today — **Amazon Web Services (AWS)**, described as "ECS Fargate,
EFS, Route 53, DynamoDB, Secrets Manager" — and it is pre-selected. A footnote
reads "More clouds are coming in a future release."

Nothing blocks Next. Clicking it saves your choice; if that save fails, an
error appears and you stay on the step so nothing silently drifts.

## Step 2 — Provision AWS access

![The guided AWS access step showing a rendered CloudFormation template path with a copy button, an Open AWS Console action, and a Continue to key entry button](/img/app/wizard-guided-iam.png)

> Hyveon can provision the AWS access it needs for you, or you can supply your
> own credentials.

This step drives its own advancement rather than using the shared **Next**
button — the button is hidden for the entire step, except when Reconfigure
has collapsed it to a completed summary (see [Reconfigure](#reconfigure)
below).

### The initial choice

An AWS region field, plus two buttons:

- **Continue with guided setup** (the default path) — requires a non-empty
  region, then moves to the template screen.
- **I already have credentials** — skips straight to the credentials step
  (step 3) doing nothing else; no progress is recorded for this path since
  there is nothing to resume into.

### Guided setup: template and console handoff

Choosing guided setup renders `iam-bootstrap.yaml`, a CloudFormation template
that provisions a dedicated deploy-principal IAM user, to a path under the
app's `userData` directory, and shows:

| Element | Notes |
|---|---|
| **Template path** | Read-only field with an icon-only copy button, labelled `Copy template path` for screen readers (no visible text) |
| **Open AWS Console** | Opens the region-scoped CloudFormation "Create stack" console page in your default browser. If it can't launch a browser, the URL is shown as selectable text instead |
| **Continue to key entry** | Appears once the template is written; advances to the intake screen |

There is no "reveal in file manager" action here — only the copy-path button.
Upload the file yourself using "Upload a template file" on the console page,
then come back for the access key the stack outputs.

### Key intake and rotation

Paste the **Access key ID** and **Secret access key** from the CloudFormation
stack's outputs and press **Validate and rotate key**. Hyveon then, in order:

1. Verifies the pasted key with `sts:GetCallerIdentity`.
2. Mints a brand-new access key for the same IAM user.
3. Stores the new key in your OS keychain.
4. Verifies the *new* key.
5. Deletes the original (bootstrap) key.

The secret you pasted is held in memory only for this sequence — it is never
written to disk or logged.

### Two ways rotation can fail

| State | What you see | Recovery |
|---|---|---|
| **Verification failed** | An error message and a **Retry rotation** button | Retrying reuses the same in-memory bootstrap key — no need to re-paste anything |
| **Deletion failed** | An amber warning that the new key is already active but the bootstrap key is too, a direct IAM console link, and a **Revoke now** button | The new key is already your active credential; this state only needs the leftover bootstrap key cleaned up. Pressing **Revoke now** finishes the step the same as a clean rotation |

### Resuming mid-flow

If you quit while a bootstrap key had been submitted but rotation had not
settled, relaunching resumes directly onto the key-intake screen with a
banner:

> A bootstrap key was previously submitted, but rotation didn't finish before
> Hyveon closed. Re-enter the access key ID and secret access key from your
> CloudFormation stack's outputs to retry.

This resume *always* lands on the intake screen, whether or not a region was
recoverable from previously-persisted settings — the intake screen has its
own editable region field for exactly that case. This is deliberate: falling
back to the region screen instead would silently regress your persisted
progress back to square one the next time you clicked "Continue with guided
setup."

Quitting at the template or console-handoff point instead resumes onto the
template screen, recovering your region from previously-persisted settings;
if none is recoverable, *this* resume lands back on the region screen with a
note asking you to re-enter it — there is no in-flight bootstrap key yet at
this point, so nothing is lost by starting the region/choice screen over.
Unlike the resume caveat below (which only restores the wizard's *step
pointer*), this step's own progress persistence is granular enough to resume
into the exact sub-screen you left — not just "this step in general."

## Step 3 — AWS credentials

![The credentials step with the Use an existing profile mode selected, a profile dropdown and a region field](/img/app/wizard-credentials.png)

> Choose the AWS credentials Hyveon will use to manage your game servers.

If step 2's guided setup already established a credential, this step skips
its normal form entirely and shows a resolved summary instead:

> ✓ AWS account (guided setup) · `<region>`

with a **Switch to a different source** button that falls back to the normal
picker/paste form below — nothing from guided setup is discarded by pressing
it, it only changes which source your *active* configuration points at.

Otherwise, two modes, chosen with a pair of toggle buttons.

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

The region is mandatory in both modes because Pulumi's self-managed S3 backend
has no region default to fall back on.

## Step 4 — Bootstrap AWS resources

![The bootstrap step showing two editable resource-name fields plus two read-only status rows for the run-history table and deployment-config seed, all with status badges, a Bootstrap AWS resources button, and an IAM permission check section](/img/app/wizard-bootstrap.png)

> Hyveon needs three AWS resources to manage its Pulumi state and run
> history, plus a permission check against your account. The two bucket
> names are editable — the defaults below are usually fine.

| Resource | Default name | What it is |
|---|---|---|
| State bucket | `hyveon-tfstate` | S3 bucket, versioning enabled, AES256 encryption — Pulumi's self-managed backend reads/writes state here directly; there is no separate lock table (the DIY S3 backend locks via objects in this same bucket) |
| Configuration bucket | `hyveon-config` | S3 bucket, versioning enabled, non-current versions expire after 90 days, AES256 encryption |
| Run-history table | `hyveon-runs` | DynamoDB table (`pk`/`sk` keys, `status-index` GSI, point-in-time recovery) recording every plan/apply/destroy run — created here, not by Pulumi, so the very first plan/apply cycle of a fresh install has somewhere to record itself before any deploy has ever succeeded. Not name-editable at this step (see below) |
| Initial configuration | — | Seeds an empty `deployment-config.json` object (empty `gameServers`, no hosted zone) into the Configuration bucket, idempotently — it writes only if the object is absent, never overwriting an existing one. Without this, a fresh install has no config object yet, so Settings saves, adding a game, and Pulumi previews all fail. Not name-editable; it always targets whatever name is in the Configuration bucket field above it |

These are created with the AWS SDK directly — the wizard does not shell out to
any CLI for this step. The run-history table's name is not operator-editable
here: unlike the two buckets, it has no `DeploymentConfig` yet to hold a
custom name override (that only gets configured later, from the Settings
page), so it always uses the project-name default shown above.

Press **Bootstrap AWS resources**. The State bucket and Run-history table are
created concurrently with the rest. The initial-configuration seed is chained
after the Configuration bucket instead — it only starts once that bucket resolves to
**Created** or **Already exists**, since it writes into it, and its row moves
straight to **Failed** if the bucket step fails. A failure on one resource
does not stop the others. Each row's badge moves independently:

| Badge | Meaning |
|---|---|
| **Pending** | Not attempted yet |
| **Creating…** | In flight |
| **Created** | Newly created by this run |
| **Already exists** | Found and left alone (re-configuration applied) |
| **Failed** | With the error message beneath the row |

Once a resource reaches **Created** or **Already exists**, its name field
locks (the run-history table's read-only row has no name field to lock, only
its status badge). The button relabels itself to **Re-run bootstrap**, which
is safe to press repeatedly — every resource's configuration is re-asserted
on every run.

**Common failures and how to recover:**

| Message | Fix |
|---|---|
| `The bucket name "…" is already taken by another AWS account. Choose a different name.` | S3 bucket names are globally unique. Edit the name (failed rows stay editable) and re-run |
| `Cannot bootstrap AWS resources: no region is configured. Complete the credentials step of the wizard first.` | Go **Back** and finish step 3 |

**What blocks Next:** only the two S3 buckets must be **Created** or
**Already exists** — the run-history table's status is informational and
never gates progression (its own bootstrap failure is still surfaced, and is
worth resolving before configuring game servers, since `plan`/`approve`
against that table depend on it existing).

### The IAM permission check is advisory

Below the resources is an **IAM permission check** section with a **Check
permissions** button (it relabels to **Re-check permissions** afterwards).

**This check never blocks Next, and it never runs on its own.** You can
complete the entire wizard without ever pressing it. It exists so you find out
about a missing IAM action now rather than halfway through your first
infrastructure apply.

It resolves your caller identity, then asks IAM to simulate every action in
the `HyveonDeployAll` policy against your principal. Three outcomes:

| Result | What you see |
|---|---|
| **Passed** | "All required permissions are present." |
| **Missing** | "Some permissions are missing. Paste the policy below into your IAM user's inline policy." followed by a ready-to-paste JSON policy containing exactly the denied actions, with a copy button |
| **Warning** | The reason the simulation could not run (for example, your principal cannot call `iam:SimulatePrincipalPolicy`), followed by the full list of actions to check by hand |

The full policy, and where to put it, is documented in the
[setup guide](/setup).

## Step 5 — Finish setup

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

One deliberate exception: **you never resume directly into step 5**. If you
quit while stack initialization was running, the app puts you back on step 4
(Bootstrap AWS resources) instead. Step 5 needs no renderer-supplied
configuration to run — it resolves the state bucket and region it needs from
already-persisted settings — but jumping straight to it on relaunch would
still fire a real, write-side stack-initialization call before you have seen
or confirmed anything on this visit, so the app clamps the jump at step 4
regardless. Landing on step 4 is safe because it reads your region from the
stored settings, and the worst case is that you press **Re-run bootstrap**
once more.

Two other resume caveats worth knowing:

- Only the *step pointer* is restored. Your region, selected profile and
  bootstrap resource names all fall back to their defaults on relaunch, even
  though they were saved. (The Reconfigure flow below *does* restore them.)
  Step 2 (Provision AWS access) is the one exception — see that step's own
  "Resuming mid-flow" section above, since guided setup persists more than
  just the step pointer.
- If saving progress fails, you simply start from step 1 next time. Nothing
  breaks.

Finishing the wizard deletes the resume file.

## Reconfigure

The same wizard is reachable later from **Settings → Cloud Setup →
Reconfigure**. Use it to switch AWS profiles, change region, or re-point
Pulumi at differently-named bootstrap resources.

It behaves differently in a few ways. The header reads **Reconfigure Hyveon**
— otherwise the step count and numbering (`Step 1 of 5` through `Step 5 of
5`) are identical to first-run.

**Most steps start collapsed.** Choose your cloud, AWS credentials, and
Bootstrap AWS resources always start collapsed to a summary box, since
Reconfigure is only reachable once the wizard has completed once and every
one of them already has a real answer on record:

> ✓ AWS credentials is already configured.  **[Edit]**

Press **Edit** to expand that step's real form. Steps you never expand stay
collapsed all the way through. (There is no way to re-collapse a step once
expanded — press **Cancel** and start again if you change your mind.)

**Provision AWS access starts collapsed only conditionally.** Unlike its
three siblings above, this step is pre-marked completed only when your
currently-active AWS credential is the exact profile guided provisioning
produces. A profile you picked manually, or keys you pasted, never
pre-completes it — in that case it renders as a live step, offering guided
setup or "I already have credentials" the same as first-run. Finish setup
(step 5) is never pre-completed or collapsed either way — it has no
standalone "answer" to summarize, and reaching it is itself the explicit
re-run you asked for by clicking through to it.

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
*active* configuration from being pointed at them — since neither of those
two steps writes anything until `commitReconfigureAnswers` fires on Finish,
Cancel skipping that call is what "prevents" means here. Editing a collapsed
Provision AWS access step is the same story, only more consequential and,
unlike its two siblings, **not reversible by Cancel at all**: opening it and
running guided setup creates a real CloudFormation stack and rotates a real
AWS access key the moment you click through them, and the moment rotation's
verification succeeds, the rotated key is written as your active AWS
credential source directly — not through Reconfigure's buffered-save
mechanism, which only covers the other steps' answers. Cancelling afterwards
does not revert that credential switch, and does not delete the stack or
un-rotate the key either — all of it remains exactly as it is.
