---
title: Home
sidebar_position: 1
slug: /
---

# Hyveon

A cost-efficient, multi-game dedicated server platform on **AWS Fargate** with a
local management UI and a fully serverless Discord bot. Servers only run — and
only cost money — while somebody is playing; the rest of the time the account
is silent except for a handful of near-free Lambdas.

## What you get

- **On-demand Fargate tasks** per game (no persistent ECS service, no idle cost).
- **EFS with per-game access points** so each world is isolated yet persistent.
- **Auto-DNS** — a Lambda UPSERTs `{game}.{yourdomain}` on task start and
  DELETEs it on stop. HTTPS-fronted games terminate TLS via an in-task Caddy
  sidecar (Let's Encrypt automatic HTTPS) — no load balancer or ACM
  certificate for game traffic. (The Discord custom domain is separate: it
  fronts a Lambda Function URL with CloudFront and does use an ACM
  certificate — see [Infra program](/components/infra).)
- **Watchdog Lambda** that stops servers after a configurable idle window.
- **Packaged Electron desktop app** (Nest.js backend + React dashboard) to
  start/stop, edit config, stream logs, and track costs — no HTTP server, the
  renderer talks to the backend over Electron IPC.
- **Serverless Discord bot** — two Node.js Lambdas plus DynamoDB and Secrets
  Manager handle every slash command; no 24/7 bot process.
- **Five Lambda packages, four always running.** `interactions`, `followup`,
  `update-dns`, and `watchdog` are always deployed; a fifth,
  `@hyveon/lambda-efs-seeder`, is deployed **once per game that declares
  `file_seeds`** — zero, one, or many instances, never a fixed fifth
  function.

## Choose your path

The rest of the site is organised around three roles. Pick the one that
matches what you're doing right now:

- **[Setup guide](/setup)** — from a blank AWS account
  to a running game server, in order.
- **[User guide](/guides/user)** — day-to-day
  operation: starting/stopping servers from the dashboard or Discord, reading
  the cost panel, checking logs.
- **[Maintainer guide](/guides/maintainer)** — working
  on the code: monorepo layout, tests, lint, CI, release/deploy mechanics,
  load-bearing invariants not to break.
- **[Submodule guide](/guides/submodule)** — the
  pattern of wrapping this repo as a git submodule inside a private parent
  repo that holds `server_config.json` and anything else secret. There is no
  `terraform.tfvars` any more — Pulumi's state and your deployment
  configuration both live in S3, bootstrapped by the app's own first-run
  wizard, not in a file this pattern needs to vendor.

## Component reference

Deep-dives on each piece, for when the guides hand-wave past something:

- [Architecture overview](/architecture) — the diagram
  below in full, with every arrow annotated.
- [Infra program](/components/infra) — the Pulumi
  Automation API program: every file, resource, and AWS service touched.
- [Management app](/components/management-app) — the
  Nest.js API, React dashboard, and `@hyveon/shared` library.
- [Lambdas](/components/lambdas) — the five Node.js
  Lambda packages (interactions, followup, update-dns, watchdog, efs-seeder —
  the last is conditional, per game).

## High-level architecture

![High-level architecture](/diagrams/context.svg)

The desktop app's first-run wizard bootstraps AWS from a blank account —
no separate CLI tool to install or run. After that, the control plane is
the dashboard, the Discord bot, or EventBridge schedules. No persistent
server process — only the Fargate tasks themselves cost money, and only
while they're running.

For the full breakdown (Discord bot internals, control-loop Lambdas, and
the `/server-start` sequence) see the
[architecture overview](/architecture).

## Repository map

The repository root is the npm-workspaces root — one `package.json` at the
top installs every workspace below in a single `npm install`.

```text
Hyveon/
├── app/                        # Electron desktop app (Nest.js + React)
│   └── packages/
│       ├── shared/             # @hyveon/shared
│       ├── cloud-aws/          # @hyveon/cloud-aws — AWS implementations of the cloud-agnostic contracts
│       ├── desktop-main/       # @hyveon/desktop-main (Nest.js IPC microservice)
│       ├── desktop-preload/    # @hyveon/desktop-preload — contextBridge preload script (window.hyveon)
│       ├── infra/              # @hyveon/infra — Pulumi Automation API program (all AWS resources)
│       ├── web/                # @hyveon/web   (React + Vite renderer)
│       └── lambda/
│           ├── interactions/   # Discord Function URL entry point
│           ├── followup/       # async ECS work + Discord PATCH
│           ├── update-dns/     # Route 53 on task state change
│           ├── watchdog/       # idle detection + auto-stop
│           └── efs-seeder/     # writes declarative file_seeds to a game's EFS volume
├── scripts/                    # @hyveon/scripts — init-parent.ts submodule scaffolder
├── build/                      # icon source art + generator for packaging
├── docs/                       # this site
├── openspec/                   # OpenSpec change proposals/specs for this repo
├── electron.vite.config.ts     # electron-vite build config (main/preload/renderer)
├── electron-builder.yml        # packaged-installer config
└── README.md
```
