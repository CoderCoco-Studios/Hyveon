---
title: Settings
sidebar_position: 10
---

# Settings

The Settings screen (route `/settings`) holds the watchdog tuning knobs, the
entry point back into the cloud setup wizard, the deployment-settings editor,
and the app's own diagnostic log.

![The Settings page showing the Watchdog Settings panel with three numeric fields, a Cloud Setup row with a Reconfigure button, a General placeholder, and the Diagnostics log viewer](/img/app/settings.png)

:::note Screenshot pending an update
The screenshot above predates the **General** section described below — it
still shows the old placeholder text rather than the deployment-settings
form.
:::

Four sections, in order: **Watchdog Configuration**, **Cloud Setup**,
**General**, **Diagnostics**.

## Watchdog Configuration

The watchdog is a Lambda that runs on a schedule, checks how much network
traffic each running game server is seeing, and stops tasks that have been
idle for long enough. It is what stops you paying for a server everyone forgot
to shut down.

Three fields:

| Field | Unit | Default | What it means |
|---|---|---|---|
| **Check interval (min)** | minutes | `15` | How often the watchdog inspects each running task. Lower means faster shutdown but more Lambda invocations |
| **Idle checks before shutdown** | count | `4` | How many *consecutive* idle checks must pass before the task is stopped |
| **Min packets (activity threshold)** | packets | `100` | A task receiving fewer than this many network packets during an interval counts as idle |

Each field has a `?` icon with a tooltip explaining it.

Below the fields, a derived line updates live as you type:

> Auto-shutdown after 60 minutes idle (15 min × 4 checks). Update Terraform
> vars to change the Lambda schedule.

The formula is simply **interval × idle checks**. With the defaults, a server
with no players stops an hour after the last packet.

### Tuning advice

- **Min packets** is the one to adjust first if servers are being stopped
  while people are still connected. Some games send keepalive traffic even
  when idle; if the baseline chatter exceeds 100 packets per interval the
  server will never look idle, and if a connected-but-quiet player generates
  fewer, they will be cut off.
- **Interval × idle checks** is your grace period. Shortening the interval
  makes shutdown more responsive but also makes a brief network lull more
  likely to trip the counter — which is why the counter requires
  *consecutive* idle checks rather than a single one.

The idle counter is stored as a tag on the ECS task itself, so it resets
naturally whenever a task starts.

### Saving

One **Save** button. Success shows `Watchdog settings saved`.

Each field is validated as you type, and **Save** stays disabled while any of
them is invalid:

| What you typed | Message under the field |
|---|---|
| Nothing — the field is empty | `Required` |
| Anything that is not a whole number | `Whole number required` |
| Below the field's floor | `Must be N or greater` |

The floor is `1` for the check interval and the idle-check count — either at
zero describes no watchdog at all — and `0` for the packet threshold, where
zero is meaningful: it makes every task read as busy. There is no maximum.

While the interval or the idle-check count is invalid, the idle-window summary
under the fields is replaced by `Fix the highlighted fields to see the idle
window.`

:::danger Saving here does not change the watchdog

**These fields tune the app's stored configuration. The watchdog Lambda does
not read that configuration.**

The Lambda gets all three values from Terraform: its EventBridge schedule is
generated as `rate(<interval> minutes)` at apply time, and the idle-check and
packet thresholds are baked into its environment variables. Both come from
your Terraform variables, not from the app's settings file.

So pressing **Save** writes a local file and shows a success toast while
changing nothing in AWS. The panel says as much in its own footnote — *"Update
Terraform vars to change the Lambda schedule."*

**To actually change the watchdog:** set `watchdog_interval_minutes`,
`watchdog_idle_checks` and `watchdog_min_packets` in `terraform.tfvars` (see
the [Terraform reference](/components/terraform)), then run a plan and apply
from the [Terraform](/app/terraform) page.

There is no indication in the UI when the saved values and the applied
Terraform values disagree, so keep them in sync by hand.
:::

## Cloud Setup

A single row showing the app-managed Pulumi engine's version:

> **Pulumi Engine**
> Pulumi engine v3.255.0 · pinned to v3.255.0

The app provisions and runs against exactly one pinned Pulumi engine version
(`PULUMI_ENGINE_VERSION` in `@hyveon/shared`) — unlike the old Terraform
prerequisite check this row replaced, there is no "detected vs. minimum"
comparison to make, because there is no host binary to detect: the engine is
downloaded and cached by the app itself (`PulumiEngineService`), not installed
separately by the operator.

Three possible states for the first line:

| State | When |
|---|---|
| `Pulumi engine v<version>` | The engine has been resolved (downloaded and verified, or reused from cache) at least once this session |
| `Not yet provisioned` | A fresh install that hasn't run the engine yet — first-run setup, the wizard's stack-initialization step, or the first `plan`/`apply` will provision it |
| `Unable to determine engine version` | The read itself failed (e.g. the IPC bridge is unavailable) — distinct from `Not yet provisioned`, which is a real, expected state, not a failure |

The second half of the line (`pinned to v<version>`) is shown in every state —
it is a plain constant, not something the app needs to look up.

### Reconfigure

The **Reconfigure** button relaunches the setup wizard. It swaps out the whole
Settings page immediately, with no confirmation.

Use it to switch AWS profiles, change region, or re-point the deployment at
differently-named bootstrap resources. It runs a shortened, pre-filled variant
of the first-run flow — four steps instead of five, every step collapsed to a
summary with an **Edit** button, and all your edits buffered into a single
save when you press **Finish setup**. There is a **Cancel** button throughout.

See [First-run wizard → Reconfigure](/app/first-run-wizard#reconfigure) for
the full behaviour, including what Cancel can and cannot undo.

Note that this section only reports the Pulumi engine version. Your AWS
profile, region and bootstrap resource names are not shown here — they are
inside the wizard.

## General

Reads and writes every top-level field of the deployment configuration
(`deployment-config.json` in the operator's configuration S3 bucket) EXCEPT
`gameServers` — games have their own dedicated Add-game wizard and edit form
on the [Games page](/app/games). This is the only place to change these
values without hand-editing the JSON object in S3.

| Field | What it is |
|---|---|
| **Project name** | Prefix used to derive default resource names, e.g. `${projectName}-audit` |
| **AWS region** | Region the stack deploys into |
| **VPC CIDR** | CIDR block for the VPC, e.g. `10.0.0.0/16` |
| **Hosted zone name** | The Route 53 hosted zone domain (must already exist). Required — there is no default |
| **DNS TTL (seconds)** | TTL on the per-game DNS A records the watchdog Lambda writes |
| **Discord application ID** | The bot's public Application (Client) ID — can also be set from the Discord page's Credentials tab |
| **Watchdog tuning (3 fields)** | `dnsTtl`'s siblings — check interval, idle checks, min packets — see the callout below |
| **Base allowed guild IDs / admin user IDs / admin role IDs** | See below |
| **Audit table name / Runs table name** | See below |

### Watchdog tuning here vs. the Watchdog Configuration panel above

This section has its own **check interval / idle checks / min packets**
fields, distinct from the **Watchdog Configuration** panel at the top of the
page. They edit different things:

- The **Watchdog Configuration** panel (above) writes to the app's own local
  `server_config.json` — it never reaches the deployed watchdog Lambda (see
  that section's own danger callout).
- The three fields here write into the deployment configuration itself —
  the same values Terraform/Pulumi bakes into the watchdog Lambda's
  EventBridge schedule and environment variables at apply time. Saving here
  only takes effect after the next `apply` from the [Terraform](/app/terraform)
  page, same as any other field in this section.

### Discord admin allowlists

**Base allowed guild IDs**, **base admin user IDs**, and **base admin role
IDs** are a permanent floor written to the `BASE#discord` DynamoDB row on
every deploy — distinct from the dynamic allowlist/admin list managed from
the [Discord page](/app/discord), which the operator can freely add to or
remove from at runtime. What's set here can only be changed by editing it
here and re-applying; the app can only add to or remove from what it itself
added dynamically. Add an ID by typing or pasting it and pressing **Enter** or
**,**; remove one with the **×** on its chip, or **Backspace** on an empty
input to remove the last one. Each entry must look like a Discord snowflake
(17-20 digit numeric string).

### Audit table name / Runs table name

Both default to blank, which the infrastructure program resolves to
`${projectName}-audit` / `${projectName}-runs` at apply time — the field
shows that computed name as placeholder text (e.g. `auto (hyveon-audit)`).
Leaving either field blank is valid; only set a value to override the
computed default.

### Validation and saving

Client-side validation runs on every keystroke and mirrors what the backend
enforces — the same rule can never be phrased differently in the two places.
**Save settings** stays disabled while any field is invalid:

| Field(s) | Rule |
|---|---|
| Hosted zone name, project name, AWS region | Must not be blank |
| VPC CIDR | Must look like an IPv4 CIDR block, e.g. `10.0.0.0/16` |
| DNS TTL, the three watchdog fields | Must be a positive whole number |
| The three Discord ID lists | Each entry must be a 17-20 digit Discord snowflake |
| Audit table name, runs table name | Never flagged — blank is a legitimate "use the computed default" value |

The form loads the current settings (and a version tag) on mount, and always
sends that version tag back on save — if someone else changed the
configuration since this page loaded, **Save settings** is rejected rather
than silently overwriting their change, and the page shows *"This setting was
changed elsewhere since you loaded this page — reload and try again."* with a
**Reload** button. A server-side validation rejection re-renders the same
fields with the reported issues rather than a generic failure banner.

## Diagnostics

The last **500 lines** of the desktop app's own log — the main process's
structured log, not your game servers' CloudWatch logs and not Terraform
output. This is where to look when the app itself misbehaves: a failed IPC
call, an AWS SDK error the UI swallowed, a Discord command registration
Discord rejected.

Above the log box:

> Log file: `/home/you/.config/Hyveon/logs/main-2026-07-26.log`

The exact directory is platform-specific (your user-data directory), but the
filename always follows the pattern **`main-YYYY-MM-DD.log`** using today's
local date. Logs rotate daily, and this panel only ever shows **today's**
file — there is no date picker. To read an earlier day, open the file from
that directory yourself.

The panel refreshes every five seconds and **always scrolls to the bottom**
when it does, with no pin-to-bottom detection. Scrolling up to read something
older will get yanked back within five seconds; copy the path and open the
file in an editor if you need to study it.

There are no buttons — no copy, no open-folder, no export. The path is
selectable text.

| State | Copy |
|---|---|
| Loading | `Loading diagnostics…` |
| No log file yet, or it is empty | `No log lines available.` |
| Read failed | The raw error message, in a red banner replacing the whole panel |

A brand-new install shows the empty state rather than an error, because the
log file does not exist until the first write.
