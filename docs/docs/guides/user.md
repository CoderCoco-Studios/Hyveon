---
title: User guide
sidebar_position: 2
---

# User guide

You're a player — you want to play a game, or let your friends play. The
infrastructure has already been provisioned, the desktop app is running, and
the Discord bot is registered. This page covers the Discord slash commands
and what you experience as a player connecting to a server.

For everything about running and operating the desktop app itself
(dashboard, starting/stopping, watchdog config, cost view, logs, Discord
bot setup, adding a game) see [Using the app](/app).

If none of those assumptions is true yet, start at the
[setup guide](/setup).

## Two ways to drive it

| From | What you get | Who can do it |
|---|---|---|
| **Desktop app** | Full control: start/stop, edit watchdog knobs, view cost estimates, read live logs, manage Discord permissions. See [Using the app](/app). | Whoever can launch the app on your machine — there's no separate login, it's a local desktop app. |
| **Discord slash commands** | `/server-start`, `/server-stop`, `/server-status`, `/server-list`. Replies are ephemeral, so the channel doesn't get spammy. | Whoever is in the admin list or the relevant per-game entry. |

Both talk to the same AWS resources. You can start a server from Discord and
stop it from the app, or vice versa. Status always reflects reality.

## Discord slash commands

All four are `/server-*`. Replies are ephemeral (only the invoker sees
them).

### `/server-start <game>`

Autocomplete filters the game list by what you've typed and by what you're
allowed to run. Press enter and you'll see a deferred ack within 3 s, then
an edit to "starting …", and finally (1–5 min later) a green
"running — `{game}.yourdomain.com`".

Behind the scenes: interactions Lambda verifies the signature and kicks off
the followup Lambda; followup runs ECS `RunTask` and writes a 15-minute
`PENDING#{taskArn}` row to DynamoDB; when EventBridge sees the task
transition to RUNNING, the update-dns Lambda upserts the A record and PATCHes
your original Discord message with the resolved hostname.

### `/server-stop <game>`

Runs `ecs.stopTask`. The update-dns Lambda deletes the Route 53 record —
the same path for every game, HTTPS or not — when the resulting STOPPED
event fires. Confirmation edit usually within a few seconds.

### `/server-status [game]`

One game if specified, otherwise every game you have `status` permission
on. The followup Lambda calls `ListTasks` + `DescribeTasks` and resolves
the ENI public IP if running.

### `/server-list`

Same as `/server-status` with no game argument — shows everything you can
see.

## Playing on a server

Once a game is RUNNING:

- DNS: `{game}.yourdomain.com` resolves to the task's public IP after up to
  `dns_ttl` seconds (default 30).
- Ports: whatever the operator configured under `ports`. UDP/TCP games
  connect directly to that port on the resolved hostname. HTTPS games
  (`https = true`) connect over 443 — TLS terminates in-task via a Caddy
  sidecar with an automatically-issued Let's Encrypt certificate; there is
  no load balancer involved anywhere in the path.
- Reconnect if the task restarts: the new task has a different public IP,
  but the DNS record is re-UPSERTed within seconds of RUNNING. Use the
  hostname, not the IP.

## When the watchdog will stop you

The watchdog runs on an EventBridge schedule — default every 15 minutes —
and for every running task it:

1. Reads `NetworkPacketsIn` for the task's ENI over the last window.
2. If it's below `watchdog_min_packets`, increments the `idle_checks` tag on
   the task.
3. If the counter reaches `watchdog_idle_checks`, issues `StopTask` with
   reason `Watchdog: idle for N minutes`. The watchdog **only** stops the
   task — it never touches DNS or any load balancer itself. The task
   stopping triggers an ECS state-change event that a separate Lambda
   (update-dns) reacts to by deleting the DNS record.
4. If there's activity, resets the counter to 0.

So a burst of actual traffic resets the clock; an empty server shuts down
after `interval × idle_checks` minutes (default 60, tunable by whoever
operates the app — see [Using the app](/app/settings)).

## Managing the app

Everything about running the desktop app itself — the dashboard, starting
and stopping servers from it, editing watchdog knobs, viewing cost
estimates, reading live logs, configuring the Discord bot, and adding a
second game — is covered in [Using the app](/app), with one page per
screen: [Dashboard](/app/dashboard), [Games](/app/games),
[Discord](/app/discord), [Logs](/app/logs), [Costs](/app/costs),
[Audit](/app/audit), and [Settings](/app/settings).

## Further reading

- [Architecture](/architecture) — the full diagram
  and the `/server-start` sequence, end to end.
- [Lambdas](/components/lambdas) — what each
  Lambda does on every invocation.
- [Using the app](/app) — the desktop app you (or whoever
  operates your deployment) use to drive everything above.
