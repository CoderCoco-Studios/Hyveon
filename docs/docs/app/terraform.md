---
title: Terraform
sidebar_position: 5
---

# Terraform

The Terraform screen (route `/terraform`) is where declarations become real
infrastructure. Every change you make on the [Games](/app/games) page sits
inert in `terraform.tfvars` until you run a plan here, approve it, and apply
it.

> Plan, review, and apply infrastructure changes directly from the app.

![The Terraform page with a Run plan button and an empty log viewer waiting for output](/img/app/terraform.png)

The workflow is a strict sequence, and each stage only unlocks the next:

```text
Run plan → Approve plan → Apply
```

Destroy is a separate, deliberately isolated path at the bottom of the page.

## Run plan

**Run plan** runs `terraform plan` with your tfvars, writing the resulting
plan artifact to disk so it can be applied later without re-planning. Output
streams into the log viewer live (`Waiting for plan output…` until the first
line arrives). ANSI colours from Terraform are rendered; the viewer auto-scrolls
unless you scroll up, and re-pins when you scroll back to the bottom.

Only one Terraform subcommand can run at a time. If something else is already
running, the plan is refused — see [Workspace busy](#the-workspace-busy-banner).

### The change-summary badges

Once Terraform prints its summary line, three badges appear next to the
section heading:

| Badge | Colour |
|---|---|
| `3 to add` | cyan |
| `1 to change` | amber |
| `0 to destroy` | red |

These are parsed straight out of Terraform's own `Plan: 3 to add, 1 to change,
0 to destroy.` line. If Terraform prints no summary — for instance when there
is nothing to do — **no badges appear at all**. Read the log body in that
case.

The same badges are reused for the Apply section, where they reflect
Terraform's `Apply complete! Resources: …` counts.

If the plan fails you get a red banner (`terraform plan failed — see the log
above for details.`) and a **Start over** button.

## The approval gate

A successful plan does not apply itself. Instead an **Approve plan** button
appears. Approval is a separate, recorded act — the approver's name is taken
from the operating-system user running the app, never supplied by the page —
so run history shows who signed off on what.

![The Terraform page after a successful plan, showing the change-summary badges and an Approve plan button](/img/app/terraform-awaiting-approval.png)

Approving shows a `Plan approved` toast and replaces the button with a panel:

> Approved by **chris** at 26/07/2026, 14:03:11 — expires 14:18:11

### The 15-minute expiry

**An approval is valid for 15 minutes.** After that the panel changes to:

> Approved by **chris** at 26/07/2026, 14:03:11 — *approval expired,
> re-approve to apply*

and **Apply** greys out. A **Re-approve** button appears alongside it.

Re-approving is a single click and does **not** require a new plan — the same
plan artifact is re-stamped with a fresh approval timestamp and the 15-minute
clock restarts. The expiry exists so a plan cannot sit approved indefinitely
while the world changes underneath it, not to force you to re-plan.

The countdown is re-evaluated roughly every 30 seconds, so the display can lag
reality by up to half a minute.

## Apply

**Apply** is gated on the plan hash. Before anything runs, the backend checks,
in order, that:

1. the run exists and is a plan run,
2. it has been approved,
3. the approval has not expired,
4. the hash the page supplied matches the hash recorded at approval time,
5. re-hashing the `.tfplan` file on disk *right now* still produces that same
   hash.

That last check is the important one: it means the exact plan you looked at
and approved is the exact plan that gets applied. If the artifact were
modified or replaced between approval and apply, you get:

> Plan artifact hash mismatch for run "…": the on-disk .tfplan artifact does
> not match the approved plan hash

and nothing runs. If the page's hash disagrees with the stored one you get the
matching `Plan hash mismatch for run "…"` error instead.

Apply reuses the plan's own run ID, so a plan and its apply share one lineage
in run history. Output streams the same way.

On success you get a green panel reading **Apply complete.** with a **View
dashboard** link, plus a `terraform apply complete` toast.

![The Terraform page after a successful apply, showing streamed apply output in the log viewer, the resources-added change summary, and a green Apply complete banner with a View dashboard link](/img/app/terraform-apply.png)

## The workspace-busy banner

Only one `terraform` subcommand can hold the workspace at a time. When a
submission is refused for that reason you get an amber banner:

> Workspace busy — a `terraform apply` run is already in progress. Try again
> once it finishes.

It appears under whichever action you attempted (plan, apply or destroy), with
the raw backend error stacked below it. Wait for the in-flight run to finish
and try again.

Apply additionally takes a durable lock that self-releases after one hour, so
a crashed apply cannot wedge the workspace permanently.

## Start over

**Start over** appears after a failed plan, or once an apply reaches any
terminal state. It resets the page back to its initial "Run plan" state.

It is purely a UI reset. It does not cancel anything, delete any run record,
revoke an approval, or remove the plan artifact — those all persist in run
history. It also leaves the Destroy section untouched.

## Destroy

An always-visible red-bordered panel at the bottom of the page:

> **Destroy infrastructure**
>
> Runs `terraform destroy`, tearing down every resource this app manages. This
> cannot be undone from here — game servers, storage, and networking are all
> removed.

Pressing **Destroy infrastructure** opens a confirmation dialog:

> ### Destroy all managed infrastructure?
> This runs terraform destroy and tears down every resource this app manages —
> game servers, storage, and networking. It cannot be undone from here. Type
> "destroy infrastructure" to confirm.

You must type exactly:

```text
destroy infrastructure
```

The match is case-sensitive and exact. Only then does the **Destroy** button
become clickable.

Behind the scenes there is a second gate: confirming mints a single-use token
that expires after **five minutes**. If the destroy is somehow submitted
without a fresh token it is refused outright. There is **no plan/approve cycle
for destroy** — the typed phrase plus that token is the whole gate.

The destroy run streams into its own log viewer, shows a `7 destroyed` badge
when Terraform reports its summary, and ends with a green **Destroy complete.**
panel. There is no "Start over" for destroy — reload the page to reset the
section.

## Run history

The **View history** link in the page header opens `/terraform/history`.

![The Terraform run history table listing past plan, apply and destroy runs with status badges, timestamps and approver, plus Kind and Status filters](/img/app/terraform-history.png)

> Past `terraform` plan, apply, and destroy runs.

| Column | Contents |
|---|---|
| **Kind** | `Plan`, `Apply` or `Destroy`, linked to the run's detail page. Rollback-triggered plans carry an extra cyan `rollback` badge |
| **Status** | `Success` (green), `Failed` (red) or `Aborted` (grey) |
| **Started** | Local timestamp |
| **Completed** | Local timestamp |
| **Approver** | The OS username that approved it, or `—` |
| *(unlabelled)* | The [Rollback](#rollback) button, on apply rows only |

`Aborted` means the run was cancelled or never reported an exit code;
`Failed` means it exited non-zero. There is no `Running` status in history —
records are only written once a run has finished.

Two filters:

| Filter | Options | Applied |
|---|---|---|
| **Kind** | All, Plan, Apply, Destroy | Client-side, to rows already fetched |
| **Status** | All, Success, Failed, Aborted | Server-side — changing it re-queries and resets the list |

Because Kind filtering happens after fetching, a kind-filtered view can show
fewer than a full page of rows while more still exist. Press **Load more**.

Pagination is cursor-based: 25 runs per page, appended by the **Load more**
button, which disappears when there is nothing left. Only the Kind cell is a
link — clicking elsewhere in a row does nothing.

| State | Copy |
|---|---|
| Loading | `Loading…` |
| Initial fetch failed | `Could not load the run history.` |
| Nothing matches | `No runs match the current filters.` |
| A **Load more** failed | `Could not load more run history.` below the table |

## Run detail

Clicking a run's kind opens `/terraform/history/:runId`.

This page is **strictly read-only**. It shows the run's kind, status,
start/completion times, the approver, any rollback provenance, and the
captured log — and it **never offers Approve or Apply**. Every record in
history describes a run that has already finished, so there is nothing to
approve.

The log is resolved from whichever source still has it: the run's log file on
this machine, an inline copy stored on the run record, or a link to an
offloaded copy in S3. If none of those exist you see:

> This run has no replayable, inline, or offloaded log.

### Why an old run can 404

> No run history record was found for "…".

This page finds its record by searching the most recent runs rather than
looking it up by ID, and that search is capped at the **100 most recent
runs**. A run older than that will 404 when you open (or refresh) its detail
page directly, even though it is still reachable by paging through the history
list.

The records themselves are not being deleted — they live in DynamoDB with no
expiry. The other cause of a 404 is that the runs table has not been deployed
at all, in which case *every* run detail page 404s.

## Rollback

Apply rows that recorded which tfvars version they were built from get a
**Rollback** button. Rollback restores the `terraform.tfvars` that was live
*before* that apply.

It is a two-step flow.

**Step 1 — Resolve.** Pressing **Rollback** looks up the target version. This
is read-only; nothing is written. If it cannot find one you get an inline
error such as `Could not resolve a rollback target.`, or a specific reason:

| Message | Meaning |
|---|---|
| `Apply run "…" has no recorded tfvarsVersionId — nothing to roll back.` | That apply predates version tracking |
| `Historic tfvars version "…" no longer exists — it may have expired. Nothing was written.` | The old S3 version has aged out |

**Step 2 — Confirm.** A dialog appears:

> ### Roll back tfvars?
> This restores tfvars version `abc123` (last modified 24/07/2026, 09:12:44)
> as the new head, then queues a plan against it. The current head is not
> deleted — history is append-only.

There is no type-to-confirm here; **Roll back** is enabled immediately.

**Rollback is append-only.** The historic tfvars content is written as a *new*
version at the head of the file's history. Nothing is deleted or reverted, so
you can always roll forward again by rolling back the rollback.

**A rollback does not change your infrastructure by itself.** Confirming
restores the tfvars and then drops you on the Terraform page with a plan
already running against the restored file — but that plan goes through the
normal gates. **You must still approve it and apply it.** Until you do, your
tfvars and your deployed infrastructure disagree.

The resulting plan is tagged: it shows `Rollback of apply run <id>` on the
Terraform page, and its row in run history carries the cyan `rollback` badge.

## Related reading

- [Terraform reference](/components/terraform) — every variable, and what each resource does.
- [S3 tfvars storage](/guides/s3-tfvars) — required for rollback and for version tracking.
- [Audit](/app/audit) — plan, approve, apply, destroy and rollback all leave audit entries.
