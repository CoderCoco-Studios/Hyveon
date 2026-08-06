---
title: Settings
sidebar_position: 10
---

# Settings

The Settings screen (route `/settings`) holds a read-only watchdog summary,
the entry point back into the cloud setup wizard, the deployment-settings
editor, and the app's own diagnostic log.

![The Settings page showing the Watchdog Settings panel, a Cloud Setup row with a Reconfigure button, a General placeholder, and the Diagnostics log viewer](/img/app/settings.png)

:::note Screenshot pending an update
The screenshot above predates both the **General** section described below
(it still shows the old placeholder text rather than the deployment-settings
form) and the read-only Watchdog Configuration panel described next (it
still shows the old three-field editor with a Save button).
:::

Four sections, in order: **Watchdog Configuration**, **Cloud Setup**,
**General**, **Diagnostics**.

## Watchdog Configuration

The watchdog is a Lambda that runs on a schedule, checks how much network
traffic each running game server is seeing, and stops tasks that have been
idle for long enough. It is what stops you paying for a server everyone forgot
to shut down.

This panel is read-only — a pointer, not an editor:

> Check interval, idle checks, and the min-packets activity threshold are
> configured in the **General** section below ("Watchdog tuning") and take
> effect on the next apply from the Infrastructure page.

An earlier version of this panel had its own three input fields and a **Save**
button that wrote to a local `server_config.json` file the deployed watchdog
Lambda never read — pressing **Save** showed a success toast while changing
nothing in AWS. That dead flow was removed (#348); the three real tunables are
now read and written in exactly one place — see
[General → Watchdog tuning](#watchdog-tuning) below for what each field means,
its default, and tuning advice.

## Cloud Setup

A single row showing the app-managed Pulumi engine's version:

> **Pulumi Engine**
> Pulumi engine v3.255.0 · pinned to v3.255.0

The app provisions and runs against exactly one pinned Pulumi engine version
(`PULUMI_ENGINE_VERSION` in `@hyveon/shared`) — unlike the old CLI
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
of the first-run flow — the same five steps, with Choose your cloud, AWS
credentials, and Bootstrap AWS resources always collapsed to a summary with an
**Edit** button. Provision AWS access collapses too, but only conditionally —
it pre-completes only when your currently-active credential is the exact
profile guided provisioning produces, and otherwise renders as a live step.
Edits to Choose your cloud, AWS credentials, and Bootstrap AWS resources are
buffered into a single save when you press **Finish setup** — Cancel discards
them. Provision AWS access is different: completing it writes your active
credential source immediately, not on Finish, so Cancel cannot undo it. There
is a **Cancel** button throughout regardless.

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
| **Watchdog tuning (3 fields)** | `dnsTtl`'s siblings — check interval, idle checks, min packets — see below |
| **Base allowed guild IDs / admin user IDs / admin role IDs** | See below |
| **Audit table name / Runs table name** | See below |

### Watchdog tuning

The three fields that actually reach the deployed watchdog Lambda — the
**Watchdog Configuration** panel at the top of the page only points here, it
has no editable fields of its own (see that section above).

| Field | Unit | Default | What it means |
|---|---|---|---|
| **Check interval (min)** | minutes | `15` | How often the watchdog inspects each running task. Lower means faster shutdown but more Lambda invocations |
| **Idle checks before shutdown** | count | `4` | How many *consecutive* idle checks must pass before the task is stopped |
| **Min packets (activity threshold)** | packets | `100` | A task receiving fewer than this many network packets during an interval counts as idle |

Saving here writes into the deployment configuration itself — the same values
Pulumi bakes into the watchdog Lambda's EventBridge schedule
(`rate(<interval> minutes)`) and environment variables at apply time (see the
[infra program reference](/components/infra)). It only takes effect after the
next `apply` from the [Infrastructure](/app/iac) page, same as any other field
in this section.

**Tuning advice:**

- **Min packets** is the one to adjust first if servers are being stopped
  while people are still connected. Some games send keepalive traffic even
  when idle; if the baseline chatter exceeds 100 packets per interval the
  server will never look idle, and if a connected-but-quiet player generates
  fewer, they will be cut off.
- **Interval × idle checks** is your grace period — with the defaults, a
  server with no players stops an hour after the last packet. Shortening the
  interval makes shutdown more responsive but also makes a brief network lull
  more likely to trip the counter — which is why the counter requires
  *consecutive* idle checks rather than a single one.

The idle counter is stored as a tag on the ECS task itself, so it resets
naturally whenever a task starts.

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
structured log, not your game servers' CloudWatch logs and not Pulumi run
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
