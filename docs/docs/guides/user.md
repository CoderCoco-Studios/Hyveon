---
title: User guide
sidebar_position: 2
---

# User guide

You're an operator — you want to play a game, or let your friends play. The
infrastructure has already been provisioned, the dashboard is running, and the
Discord bot is registered. This page covers everyday use.

If any of those assumptions isn't true yet, start at the
[setup guide](/setup).

## Two ways to drive it

| From | What you get | Who can do it |
|---|---|---|
| **Desktop app dashboard** | Full control: start/stop, edit watchdog knobs, view cost estimates, read live logs, manage Discord permissions. | Whoever can launch the app on your machine — there's no separate login, it's a local desktop app. |
| **Discord slash commands** | `/server-start`, `/server-stop`, `/server-status`, `/server-list`. Replies are ephemeral, so the channel doesn't get spammy. | Whoever is in the admin list or the relevant per-game entry. |

Both talk to the same AWS resources. You can start a server from Discord and
stop it from the dashboard, or vice versa. Status always reflects reality.

## The dashboard

### Opening it

Launch the packaged Electron app (or `npm run app:dev` for a dev build) —
there's no separate login or token to paste. The renderer talks to the
app's own backend process over Electron IPC, not over the network.

### Game cards

Each game from `terraform.tfvars` shows up as a card with:

- A state emoji and label — `stopped`, `pending`, `running`, `error`.
- The resolved hostname (`{game}.yourdomain.com`) and public IP once running.
- **Start** / **Stop** buttons. Start kicks off `ecs.runTask`; the dashboard
  polls game status every 20 s so you'll see the state transition
  automatically.

Two caveats:

- A fresh start takes **2–5 minutes** — Fargate pulls the image, mounts the
  EFS access point, waits for ENI attachment, then the game itself starts.
- DNS propagation is bounded by `dns_ttl` in Terraform (default 30 s). Your
  local resolver may cache longer; `dig +nocache` or wait it out.

### Cost panel

Two numbers per game:

- **Estimate** — Fargate CPU/memory unit price × your task size. Shown as
  hourly, daily (24 h), and "4 hours a day × 30 days" figures.
- **Actual** — Cost Explorer grouped by the `Project` tag over the last
  7 days. Only populated if you activated the `Project` tag for cost
  allocation (Billing → Cost allocation tags → activate). Allow up to 24 h
  the first time.

### Server Config (watchdog)

Edits the `watchdog_interval_minutes`, `watchdog_idle_checks`, and
`watchdog_min_packets` values that get baked into the watchdog Lambda's
environment. **Changes take effect on the next `terraform apply`**, not
immediately — the dashboard saves them to `server_config.json` but the
Lambda reads them from its env vars.

| Knob | What it does | Raise it when… |
|---|---|---|
| `watchdog_interval_minutes` | How often the Lambda checks. | You want faster shutdown (down to 1 min). |
| `watchdog_idle_checks` | Consecutive idle windows before stop. | Your game has legitimate quiet periods. |
| `watchdog_min_packets` | Packets/window below which it's "idle". | Your game's idle floor is higher than 100. |

Total grace before auto-stop = `interval × idle_checks` minutes. The default
(15 × 4) is 60 min.

### Live Logs

Pick a game; the panel fetches the last N events (default 50) from the
game's CloudWatch log group `/ecs/{game}-server`. It reads from the most
recent task only — if you stopped + restarted recently, switch back to the
game once the new task is RUNNING.

### Discord Bot panel

Four tabs. Everything here writes to the DynamoDB table and the two Secrets
Manager secrets created by Terraform:

1. **Credentials** — Application ID, Bot Token, Application Public Key.
   Saving writes the App ID to DynamoDB (`CONFIG#discord` row) and the
   two sensitive values to Secrets Manager. The **Interactions Endpoint
   URL** shown here is the `interactions_invoke_url` Terraform output —
   copy it to the Discord Developer Portal.
2. **Guilds** — allowlist of Discord server IDs. The interactions Lambda
   rejects any command from a guild not on the list. **Register commands**
   next to a guild ID PUTs the four slash commands into it — Discord
   needs ~30 s for them to appear in clients.
3. **Admins** — user IDs and role IDs that can run every command on every
   game. Overrides per-game permissions.
4. **Per-Game Permissions** — for each game, which user/role IDs can run
   which actions (`start` / `stop` / `status`). Save per game.

The resolution order is always: **guild allowlist → admin → per-game +
action**. A user who is neither an admin nor listed for a game sees
"You don't have permission …".

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

Runs `ecs.stopTask`. The update-dns Lambda cleans the Route 53 record (or
deregisters the ALB target for HTTPS games) when the STOPPED event fires.
Confirmation edit usually within a few seconds.

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
- Ports: whatever you configured in `terraform.tfvars` under `ports`. UDP
  is open directly to the internet on game tasks (`https = false`); HTTPS
  games go through an ALB on 443.
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
   reason `Watchdog: idle for N minutes` and cleans up DNS/ALB.
4. If there's activity, resets the counter to 0.

So a burst of actual traffic resets the clock; an empty server shuts down
after `interval × idle_checks` minutes (default 60). If you need the server
up longer with no players (e.g. running a backup), temporarily bump
`watchdog_idle_checks` in the Server Config panel and re-apply.

## Cost, quickly

The three numbers that matter:

- **Fargate**: ~$0.12 / hour for 2 vCPU + 8 GB. Charged while the task is
  running, per-second (1-minute minimum).
- **EFS**: ~$0.30 / GB-month standard. Save files are small; this is pennies.
- **Lambda / EventBridge / DynamoDB / Secrets Manager**: effectively free at
  personal-use scale.

Running four hours a day, five days a week, on a 2 vCPU / 8 GB task is
roughly **$10–12 / month**. Compare a t3.large running 24/7 at ~$60/month.

The dashboard's Cost panel shows both the hourly estimate and the last 7
days of actual spend from Cost Explorer (once you've activated the
`Project` tag in **Billing → Cost allocation tags**).

## Recipes

### Add a second game

1. Append a new key to `game_servers` in `terraform/terraform.tfvars`.
2. `cd app && npm run build:lambdas`.
3. `cd ../terraform && terraform apply`.
4. Refresh the dashboard — the new card appears because the backend
   re-reads `terraform.tfstate` on the next game list/status request.
5. Grant yourself permission in the Discord Bot → Per-Game Permissions tab
   if you want to drive it from Discord.

### Reset a stuck game

If a card shows `error` or a task is hung in `PENDING`:

1. Dashboard → Stop (or `aws ecs stop-task --cluster … --task …`).
2. Wait ~30 s for EventBridge → update-dns to clean up the DNS record.
3. Check the CloudWatch log group `/ecs/{game}-server` for the underlying
   error — image pull failure, EFS mount failure, OOM, etc.
4. Fix the tfvars entry, `terraform apply`, Start again.

### Revoke a Discord user

Remove their user ID from the admin list and from any per-game entry.
Their existing slash commands will fail on the next invocation — nothing
to invalidate server-side.

### Take a save backup

Start the **File Manager** modal for the game; it launches a short-lived
FileBrowser task with the same EFS access point mounted at `/data`.
Browse/download/upload there, then stop it. The game server itself can
remain stopped during this.

## Further reading

- [Architecture](/architecture) — the full diagram
  and the `/server-start` sequence, end to end.
- [Lambdas](/components/lambdas) — what each
  Lambda does on every invocation.
- [Management app](/components/management-app) — the
  IPC channels backing the dashboard you're using.
