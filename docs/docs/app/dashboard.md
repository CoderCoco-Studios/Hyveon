---
title: Dashboard
sidebar_position: 3
---

# Dashboard

The dashboard is the app's home screen (route `/`). It answers two questions:
what is running right now, and what is it costing? Everything else on the page
is in service of starting or stopping a server.

![The Hyveon dashboard: four KPI tiles across the top, a filter box, and a three-column grid of game cards each showing a status badge, hostname, cost per hour and Start button](/img/app/dashboard.png)

## The KPI strip

Four tiles across the top. Each has a label, a large value, and a small
delta line underneath.

| Tile | Value | Delta line |
|---|---|---|
| **Servers running** | `2/5` — running over total declared | `all idle`, or `2 active` |
| **Current run rate** | Sum of `$/hour` estimates across currently-running games, e.g. `$0.12` | `per hour` |
| **Est. month cap** | `totalPerHourIfAllOn × 24 × days in the current month` — what a full month would cost with every server running 24/7, e.g. `$89.28` | `if every game ran all month` |
| **Active alerts** | Count of games in the `error` state | `all healthy`, or `3 need attention` |

Both cost tiles are computed entirely from the free per-game Fargate estimate
(the `costs.estimate` IPC channel, already fetched for the game cards' `$ per hour` stat)
and the current run state — **the app makes no AWS Cost Explorer API calls,
ever**. There is no "no data" em-dash state for these tiles the way the old
actuals-driven tiles had, because there is no external call that can fail:
the underlying estimate is either available (from `costs.estimate`) or
defaults to `$0.00`.

**Servers running** shows an em-dash when no games are declared at all.
**Active alerts** always shows a real number, including `0`.

For real dollars actually billed to your AWS account, see the
[Costs page](/app/costs)'s link-out to the AWS Cost Explorer console.

## Game cards

One card per declared game. The grid is three columns on a wide window, two on
a medium one, one on a narrow one.

### Status badge

| Badge | Meaning |
|---|---|
| **RUNNING** | An ECS task is running and healthy |
| **STARTING** | `RunTask` has been issued; the task has not reached `RUNNING` yet |
| **STOPPED** | No task running. This is the normal resting state |
| **NOT DEPLOYED** | No infrastructure has been deployed yet — the Pulumi stack has no outputs. Run apply on the [Infrastructure](/app/iac) page |
| **ERROR** | The task or its status lookup failed |

Every state change is also announced to screen readers, e.g. "minecraft server
is now running".

When a card is in the `ERROR` state and the backend supplied a reason, that
reason is shown as a short line of red text under the header, next to a
warning icon — e.g. `Task failed to start: insufficient capacity`. No reason
is shown if the backend didn't supply one.

### Connect string

Under the game name the card shows the server's hostname (`minecraft.example.com`),
falling back to its raw public IP if DNS has not resolved yet, or the muted
text `no hostname` if neither is known.

When there is something to copy, a copy button sits next to it. Pressing it
writes the hostname to your clipboard. **There is no visible confirmation** —
no toast, no icon change — so if nothing seems to happen, the copy most likely
worked. When both a hostname and a public IP are known, the IP is also shown
in parentheses; the button copies the hostname.

### Stat tiles

Three small tiles across the card:

| Label | Shows |
|---|---|
| **Last run** | `Live` while running, `Booting` while starting, `—` otherwise. Despite the label it is a state, not a timestamp |
| **$ per hour** | Estimated Fargate cost for this game's CPU/memory pair, e.g. `$0.049`. `—` if no estimate is available |
| **Task** | The first eight characters of the running task's ID, or `—` |

### Start and Stop

The card shows exactly one of the two buttons:

| Game state | Button | Enabled |
|---|---|---|
| `STOPPED` / `NOT DEPLOYED` | **Start** | Yes |
| `RUNNING` / `STARTING` | **Stop** | Yes |
| `ERROR` | **Start** | Yes — lets you retry starting the server without leaving the dashboard |

After pressing either button the card locks for **three seconds**, then
re-fetches that one game's status and unlocks. The lock applies even if the
call failed, so a transient error never leaves a card stuck.

Starting shows a toast: `minecraft is starting`. Failures show an error toast
with the underlying reason.

Two more buttons sit alongside:

- **Files** opens the [file-manager modal](#the-file-manager) for that game.
- **Logs** jumps to the [Logs](/app/logs) page with this game pre-selected.

## The stop confirmation

Pressing **Stop** opens a dialog:

> ### Stop minecraft?
> Active sessions will end.
>
> `[Cancel]` `[Stop server]`

There is a checkbox: **Don't ask again for this session**. Ticking it and
confirming suppresses the dialog for the rest of the session — subsequent Stop
presses act immediately.

Two things to know about that suppression:

- It is **global, not per-game**. Suppressing it on one card suppresses it for
  every card.
- It lives in memory for the lifetime of the app window. It survives moving
  between screens; it is cleared when you restart or reload the app.

Ticking the box and then pressing **Cancel** does nothing — the suppression is
only recorded if you actually confirm.

## The undo toast

Every successful stop produces a neutral toast reading `minecraft stopped`
with an **Undo** action, visible for five seconds. Pressing **Undo** issues a
start for the same game and schedules a status refresh. It appears whether the
stop went through the dialog or the suppressed fast path.

## The file manager

**Files** on a game card opens a small modal titled `File Manager — Minecraft`:

> Mounts the game's EFS save data — browse, upload, and download files.

The modal itself does not list files. It launches an on-demand
[FileBrowser](https://filebrowser.org/) container on Fargate that mounts *that
game's* EFS access point read-write, then hands you a link to it.

| Button | Behaviour |
|---|---|
| **Launch** | Starts the helper task. Disabled while it is already running or starting |
| **Stop** | Stops it. Disabled when nothing is running |
| **Close** | Dismisses the modal. The helper task keeps running |

The status line tracks the helper:

- `Not running. Click Launch to start FileBrowser.`
- `Starting… checking again in 5 seconds.`
- `Running — click the link below to open FileBrowser.` — followed by an
  `Open FileBrowser at http://<ip>:8080 ↗` link that opens in your browser.

Once launched, all browsing, uploading, downloading, renaming and deleting
happens in FileBrowser's own web UI, not in Hyveon.

**Login.** Each launch generates a random password, bcrypt-hashes it, and
starts the container with that hash instead of `--noauth` — FileBrowser
enforces a real login instead of being wide open on its public port. The
modal shows the username (`admin`) and the one-time plaintext password inline
next to the connection link, right after a successful **Launch** — copy it
now, since Hyveon never displays it again (a fresh, different password is
generated on every launch, including a re-launch of the same game).

Things worth knowing:

- Only **one helper per game** can run at a time.
- **The helper auto-stops after 2 hours** if you don't stop it yourself — an
  EventBridge Scheduler one-time schedule calls `ecs:StopTask` directly the
  moment the task starts. Pressing **Stop** cancels that schedule too, so
  stopping early doesn't leave a stale auto-stop behind. This exists because
  the watchdog Lambda's idle-shutdown logic only ever looks at `{game}-server`
  tasks, never the FileBrowser helper's `filemgr-*` ones — a forgotten session
  used to run (and bill) indefinitely.
- The helper's port is still reachable from the whole internet while it is
  up — only the auth gap is closed here, not the exposure. Narrowing the
  security group to the operator's own IP is a known, separately-tracked
  follow-up.
- The connection is plain `http://`, not `https://` — there is no TLS in
  front of the helper task, so the one-time password (and the FileBrowser
  session it starts) travels in cleartext. Treat the link as you would any
  unencrypted admin panel: fine for a quick trusted-network session, not for
  browsing it over an untrusted network.
- Startup takes roughly 30 seconds; the modal polls every 5 seconds while the
  task is transitioning and stops polling once it settles.
- If infrastructure has not been deployed you get `Infrastructure not
  deployed. Deploy first.` in the status line.

Dismiss the modal with **Close**, by clicking the backdrop, or by pressing
`Escape`.

## The pending-changes banner

When the declared game server configuration (`deployment-config.json`) has
changes that have not been applied to AWS, an orange banner appears at the top
of the dashboard:

> Configuration changed, 3 changes pending — run plan and apply on the
> Infrastructure page to deploy (1 to create, 0 to delete, 2 to update)
> **View pending**

**View pending** links to the [Games](/app/games) page. The banner is checked
every 30 seconds.

### How dismissal works

The `×` button dismisses the banner, but the dismissal is tied to *the exact
set of pending changes*, not to a simple "hide" flag. Concretely:

- Dismissing records a signature of the current drift report (which games,
  which kinds of change, which fields) in session storage.
- The banner stays hidden while the drift report matches that signature. This
  survives moving between screens.
- The banner **comes back** as soon as the pending set changes — a new game
  edited, one removed, different fields touched.
- If a Pulumi apply clears the drift entirely, the stored dismissal is
  wiped, so if the same change reappears later you are told about it again.
- Restarting or reloading the app clears the dismissal.

The banner is also hidden — rather than showing a broken state — if the drift
check itself fails.

## Filtering

A search box above the grid, placeholder `Filter by game or hostname…`.
Matching is a case-insensitive substring against the game name **or** the
hostname (or the public IP, when there is no hostname), so typing part of an
address works.

## Loading and empty states

| Situation | What you see |
|---|---|
| Before the first status poll returns | `Loading servers…` |
| No games declared or deployed | A card headed **No games deployed**, explaining that you declare a game on the [Games](/app/games) page, then run a plan and apply from [Infrastructure](/app/iac) to create its ECS task definition, EFS volume, and CloudWatch log group — with links to the setup guide and to add a game |
| Filter matches nothing | `No games match "abc".` |

If the very first status poll *fails*, the page stays on `Loading servers…` —
the polling indicator next to the filter box is what tells you something is
wrong.

## Polling

Game status is polled every **20 seconds**, app-wide, and keeps running as you
move between screens.

The indicator next to the filter box shows `Updated 12s ago`, spins while a
poll is in flight, and reveals `next refresh in 8s` on hover. If two whole
intervals pass without a successful poll it turns into a red
`Stale · last updated …` pill, which clears itself on the next success.

The **Refresh** button in the top bar forces every poller to run immediately.
The `LIVE` pill next to it summarises the same health across all pollers.

The top bar doubles as the app's window title bar — drag any empty area of it to move the window. On macOS the native traffic-light buttons are repositioned into it; on Windows and Linux the OS-drawn `titleBarOverlay` renders the minimize/maximize/close buttons directly on top of it since the OS title bar is hidden.

Note that the underlying per-game cost estimates (`costs.estimate`) are
fetched once on mount, not part of that 20-second cycle — see
[The KPI strip](#the-kpi-strip) above. The **Current run rate** and
**Est. month cap** tiles still change every poll, though, since they're
recomputed from the current run state each time. The pending-changes banner
has its own separate cadence — see
[The pending-changes banner](#the-pending-changes-banner) above.
