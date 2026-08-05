# Hyveon

A cost-efficient multi-game dedicated server platform on **AWS Fargate** with a
local management UI and a fully serverless Discord bot. Servers only run — and
only cost money — while someone is playing.

> 📚 Full documentation lives at **[codercoco.github.io/Hyveon](https://codercoco.github.io/Hyveon/)**
> (built from [`docs/`](./docs) by GitHub Pages). The rest of this README is a
> quick tour; deep-dives, setup steps, and architecture diagrams are on the
> site.

## What you get

- **AWS Fargate** — runs game server containers on-demand via `RunTask` (no
  persistent ECS Service, no idle costs).
- **EFS** — persists world saves across server restarts, one access point
  per game.
- **Route 53** — a Lambda auto-UPSERTs `{game}.yourdomain.com` on task start
  and DELETEs it on stop.
- **In-task Caddy sidecar** — for any game marked `https = true`, TLS
  terminates in-task via Let's Encrypt automatic HTTPS. No load balancer.
- **Watchdog Lambda** — automatically shuts down idle servers based on
  `NetworkPacketsIn`.
- **Pulumi** (Automation API, TypeScript) — provisions every AWS resource,
  driven entirely from inside the packaged app. No host-installed CLI.
- **Nest.js + React management app** — local dashboard to start/stop servers,
  edit config, monitor costs, stream logs, and manage Discord credentials.
- **Serverless Discord bot** — two Node.js Lambdas + DynamoDB + Secrets
  Manager serve Discord HTTP interactions. Permitted Discord users/roles
  can `/server-start`, `/server-stop`, `/server-status`, and `/server-list`
  from chat without any 24/7 process running.

## Documentation

The [docs site](https://codercoco.github.io/Hyveon/) is
organised around three roles. Pick the one that matches what you need to do.

| Guide | You are… |
|---|---|
| [**Install**](https://codercoco.github.io/Hyveon/install/) | Just want to download and run the packaged app. |
| [**Setup guide**](https://codercoco.github.io/Hyveon/setup/) | Going from a blank AWS account to a running Fargate task. |
| [**User guide**](https://codercoco.github.io/Hyveon/guides/user/) | Driving an already-provisioned deployment — the dashboard, Discord commands, day-to-day ops. |
| [**Maintainer guide**](https://codercoco.github.io/Hyveon/guides/maintainer/) | Working on this codebase. |

Component deep-dives:

- [**Architecture**](https://codercoco.github.io/Hyveon/architecture/) — full diagram + `/server-start` sequence.
- [**Infra program**](https://codercoco.github.io/Hyveon/components/infra/) — the Pulumi Automation API program: every file, resource, and AWS service touched.
- [**Management app**](https://codercoco.github.io/Hyveon/components/management-app/) — Nest.js API, React dashboard, `@hyveon/shared`.
- [**Lambdas**](https://codercoco.github.io/Hyveon/components/lambdas/) — interactions, followup, update-dns, watchdog.

## Quick start

```bash
# 1. Install dependencies
npm install

# 2. Build and launch the Electron app, then follow the in-app setup wizard
#    (AWS credentials, S3 bucket bootstrap, Pulumi stack init)
npm run desktop:run

# 3. In the app: Games → Add game, then Infrastructure → Run plan →
#    Approve plan → Apply. No CLI step — the wizard and the Infrastructure
#    page do everything above.
```

See the [setup guide](https://codercoco.github.io/Hyveon/setup/)
for the full walkthrough, including the IAM policy, Discord bot setup, and
troubleshooting.

## Configuration at a glance

Add and edit games from the app's **Games** page. Every write updates a
single versioned JSON configuration object (`deployment-config.json`, in
your S3 configuration bucket) — task definitions, EFS access points, DNS,
watchdog config, and Discord command autocomplete all derive from it. There
is no configuration file to hand-edit.

```json
{
  "awsRegion": "us-east-1",
  "projectName": "hyveon",
  "hostedZoneName": "yourdomain.com",
  "gameServers": {
    "palworld": {
      "image": "thijsvanloef/palworld-server-docker:latest",
      "cpu": 2048,
      "memory": 8192,
      "ports": [
        { "container": 8211, "protocol": "udp" },
        { "container": 27015, "protocol": "udp" }
      ],
      "environment": [
        { "name": "PLAYERS", "value": "8" },
        { "name": "SERVER_NAME", "value": "My Palworld Server" }
      ],
      "volumes": [{ "name": "saves", "container_path": "/palworld" }],
      "https": false
    }
  }
}
```

Cost ballpark: **Fargate 2 vCPU / 8 GB ≈ $0.12/hr** while running; EFS is
pennies/month. Playing 4 hours/day, 5 days/week ≈ **$10–12/month**, vs.
~$60/month for a 24/7 t3.large.

## Repository structure

```text
Hyveon/                        # npm-workspaces root — one `npm install` installs everything below
├── app/                       # Electron desktop app (Nest.js + React)
│   └── packages/
│       ├── shared/             # @hyveon/shared
│       ├── cloud-aws/          # @hyveon/cloud-aws — AWS implementations of the cloud-agnostic contracts
│       ├── desktop-main/       # @hyveon/desktop-main (Nest.js IPC microservice)
│       ├── desktop-preload/    # @hyveon/desktop-preload — contextBridge preload script
│       ├── infra/              # @hyveon/infra — Pulumi Automation API program (all AWS resources)
│       ├── web/                # @hyveon/web   (React + Vite)
│       └── lambda/
│           ├── interactions/  # Discord Function URL entry point
│           ├── followup/      # Async ECS work + Discord PATCH
│           ├── update-dns/    # Route 53 on task state change
│           ├── watchdog/      # Idle detection + auto-stop
│           └── efs-seeder/    # Conditional, per game with file_seeds
├── docs/                      # Documentation site (published via GH Pages)
├── CLAUDE.md                  # Project instructions + invariants
├── CONTRIBUTING.md            # PR conventions, local checks
└── README.md                  # this file
```

## Tearing it down

Stop every server from the dashboard first (so the update-dns Lambda cleans
its records), then use the **Destroy infrastructure** panel on the
[Infrastructure](https://codercoco.github.io/Hyveon/app/iac/#destroy) page —
type `destroy infrastructure` to confirm.

The two Discord Secrets Manager secrets use a zero-day recovery window, so
they are deleted immediately and a later apply is clean.

## License

See [LICENSE](./LICENSE).
