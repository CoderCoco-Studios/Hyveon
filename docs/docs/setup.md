---
title: Setup guide
sidebar_position: 3
---

# Setup guide

This is the end-to-end walkthrough, from a blank AWS account to a running
Fargate task you can connect to from your game client, plus the optional
Discord bot. Allow ~15–20 minutes the first time; most of that is waiting
for the infrastructure apply.

Every step after creating the IAM user happens **inside the app** — there is
no separate CLI tool to install, configure, or run. The in-app setup wizard
bootstraps AWS resources and initializes the Pulumi stack; the Infrastructure
page then plans and applies the actual game-server infrastructure.

## Prerequisites

| Tool | Version | Notes |
|------|---------|-------|
| Node.js | 24+ | Matches `engines.node` in the root `package.json`, `docs/package.json`, and `scripts/package.json`, and the version every CI workflow runs. Not enforced at boot — the backend does not check the Node version — but nothing is tested below 24. |
| npm | 10+ | Ships with Node 24. |

There is no Terraform or AWS CLI prerequisite. The desktop app talks to AWS
directly via the SDK, and Pulumi's engine is provisioned automatically by
the app itself (see [step 2](#2-clone-install-and-launch-the-wizard)) — there
is nothing to install manually.

On the AWS side you need:

- An AWS account you control (pure personal use is fine).
- **A Route 53 hosted zone you already own** — e.g. `yourdomain.com`.
  The infra program looks it up as a data source and will not create it for
  you. If you use an external registrar, delegate the zone's NS records to
  Route 53 before your first apply or DNS updates will go nowhere.

## 1. Create and authorise an IAM user

1. In the **[AWS IAM console](https://console.aws.amazon.com/iam/)** →
   **Users → Create user**, give it a name like `hyveon`.
2. On the permissions step, choose **Attach policies directly** and skip
   through without selecting any managed policy. Create the user.
3. Open the new user → **Permissions → Add permissions → Create inline
   policy → JSON**. Paste the policy below, name it `HyveonDeployAll`,
   and save.
4. **Security credentials → Create access key → Command Line Interface (CLI)**.
   Copy the Access Key ID and Secret Access Key. Treat the secret like a
   password — AWS will not show it again. You'll paste these into the
   in-app setup wizard in the next step (or point the wizard at an existing
   AWS CLI profile instead, if you already have one).

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "HyveonDeploy",
      "Effect": "Allow",
      "Action": [
        "ecs:*",
        "elasticfilesystem:*",
        "ec2:*",
        "lambda:*",
        "logs:*",
        "cloudwatch:*",
        "events:*",
        "route53:*",
        "ce:*",
        "dynamodb:*",
        "secretsmanager:*",
        "s3:*",
        "cloudfront:*",
        "acm:*"
      ],
      "Resource": "*"
    },
    {
      "Sid": "HyveonIAM",
      "Effect": "Allow",
      "Action": "iam:*",
      "Resource": [
        "arn:aws:iam::*:role/hyveon-*",
        "arn:aws:iam::*:policy/hyveon-*"
      ]
    },
    {
      "Sid": "HyveonConfigurationBucket",
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:PutObject",
        "s3:DeleteObject",
        "s3:ListBucket",
        "s3:GetObjectVersion",
        "s3:GetBucketVersioning",
        "s3:PutBucketVersioning",
        "s3:GetBucketLocation",
        "s3:PutLifecycleConfiguration",
        "s3:PutEncryptionConfiguration",
        "s3:PutBucketPublicAccessBlock"
      ],
      "Resource": [
        "arn:aws:s3:::${project_name}-tfvars",
        "arn:aws:s3:::${project_name}-tfvars/*"
      ]
    },
    {
      "Sid": "HyveonStateBucket",
      "Effect": "Allow",
      "Action": [
        "s3:ListBucket",
        "s3:GetObject",
        "s3:PutObject",
        "s3:DeleteObject",
        "s3:PutBucketVersioning",
        "s3:PutEncryptionConfiguration",
        "s3:PutBucketPublicAccessBlock"
      ],
      "Resource": [
        "arn:aws:s3:::${project_name}-tfstate",
        "arn:aws:s3:::${project_name}-tfstate/*"
      ]
    }
  ]
}
```

> **Why one inline policy instead of stacking managed policies?** AWS caps
> each user at 10 directly-attached managed policies, and this stack touches
> ~14 services. One inline policy also keeps the full blast radius visible
> in one place. Trade-off: you lose AWS's auto-maintenance of action lists,
> but since everything is `{service}:*` there is nothing to maintain.

> **`iam:*` is scoped to project-prefixed ARNs**, not `Resource: *`, to avoid
> granting `iam:PassRole` on every role in the account. The `hyveon-*`
> prefix matches the default project name. If you change the project name
> in the wizard, update the two ARN patterns in `HyveonIAM` to match.

> **`HyveonConfigurationBucket` scopes access to the JSON configuration
> bucket** the setup wizard's bootstrap step creates (default name
> `${project_name}-tfvars` — the name predates this migration and is kept
> for continuity; it holds the versioned `deployment-config.json` object,
> not a `.tfvars` file). It grants object read/write/list/versioning access
> plus the bucket-config actions (`PutLifecycleConfiguration`,
> `PutEncryptionConfiguration`, `PutBucketPublicAccessBlock`,
> `PutBucketVersioning`/`GetBucketVersioning`, `GetBucketLocation`) the
> bootstrap step needs to configure the bucket's lifecycle rule (expiring
> noncurrent versions after 90 days), public-access block, and versioning.
> Although `s3:*` in `HyveonDeploy` already covers these actions on every
> bucket, this statement documents the specific dependency and scopes it to
> just the two configuration-bucket ARNs. If you rename this bucket, update
> the two ARN patterns in `HyveonConfigurationBucket` to match.

> **`HyveonStateBucket` scopes the specific permissions Pulumi's
> self-managed S3 state backend needs** on `${project_name}-tfstate` — the
> bucket the setup wizard's bootstrap step creates to hold Pulumi state.
> `s3:ListBucket` (bucket-level) plus `s3:GetObject`/`s3:PutObject`/
> `s3:DeleteObject` (object-level) are exactly what Pulumi's DIY S3 backend
> needs to read and write state objects and its own lock objects — **there
> is no DynamoDB lock table**, unlike the project's earlier Terraform
> backend. `s3:PutBucketVersioning` and `s3:PutEncryptionConfiguration` are
> what the bootstrap step's `ensureStateBucket` call uses to enable
> versioning and default (AES256) encryption on this bucket;
> `s3:PutBucketPublicAccessBlock` lets it harden the bucket against public
> access, the same as it already does for the configuration bucket. As with
> `HyveonConfigurationBucket`, `s3:*` in `HyveonDeploy` already covers all
> of this on every bucket — this statement documents the specific
> dependency and scopes it to just the two state-bucket ARNs. If you rename
> this bucket, update the two ARN patterns in `HyveonStateBucket` to match.

Two permission areas are **not** covered by any AWS managed policy and are
explicitly included above to avoid `AccessDenied` during an apply:

- **EventBridge tag operations** — the AWS provider tags EventBridge rules on creation, which requires `events:TagResource`, `events:UntagResource`, and `events:ListTagsForResource`. `events:*` above already grants these — if you tighten the policy later, keep those three actions in.
- **CloudFront** — the Discord interactions endpoint is fronted by a CloudFront distribution. `cloudfront:*` above covers creation, updates, tagging, and deletion of distributions.
- **ACM (Certificate Manager)** — CloudFront's custom domain (`discord.{hosted_zone_name}`) needs a DNS-validated ACM certificate, always provisioned in `us-east-1` regardless of your chosen region. This needs `acm:RequestCertificate`, `acm:DescribeCertificate`, `acm:AddTagsToCertificate`, and `acm:DeleteCertificate` at minimum; `acm:*` above covers all of it. ACM certificate ARNs aren't predictable before creation (unlike the project-prefixed IAM roles/policies in `HyveonIAM`), so this is scoped like `cloudfront:*`/`route53:*` above — `Resource: "*"` within the `HyveonDeploy` statement, not a separate ARN-scoped statement.

This policy is the **single source of truth** for IAM permissions. If you
need to add or remove permissions, edit it here — do not create separate
inline policies or update the README independently. The in-app setup
wizard's IAM permission check (see [step 2](#2-clone-install-and-launch-the-wizard))
simulates against this exact action list, so keeping the two in sync is
covered by an automated test.

## 2. Clone, install, and launch the wizard

```bash
git clone https://github.com/CoderCoco/Hyveon.git
cd Hyveon
npm install
npm run desktop:build
npm run app:start
```

:::note
`npm run desktop:dev` (hot-reload dev mode) has a known outstanding bundling
bug unrelated to this migration and shouldn't be used right now — build once
with `desktop:build`, then launch with `app:start`; re-run both after pulling
new code.
:::

The first launch replaces the entire window with the **first-run setup
wizard** — there is no dashboard, no sidebar, and no way to skip it. Four
steps, none of them a CLI command:

1. **Choose your cloud** — AWS is the only option today.
2. **AWS credentials** — pick an existing AWS CLI profile, or paste the
   access key you created in [step 1](#1-create-and-authorise-an-iam-user)
   directly; either way the keys (if pasted) are encrypted with your OS
   keychain, never stored in plaintext.
3. **Bootstrap AWS resources** — creates the state bucket, the
   configuration bucket, and the run-history table directly via the AWS SDK
   (no CLI, no Terraform, and none of the three is Pulumi-managed): a
   **state bucket** (default `hyveon-tfstate`, versioned, AES-256 encrypted)
   that Pulumi's self-managed S3 backend reads and writes state to; a
   **configuration bucket** (default `hyveon-tfvars`, versioned, 90-day
   noncurrent-version expiry) that holds the JSON configuration object your
   game servers are declared in; and a **run-history table** (default
   `hyveon-runs`) that records every plan/apply/destroy run. All three names
   can be selected during this bootstrap step; the run-history table name
   cannot change afterward without a migration, since it names an
   already-created physical table. This step also seeds the configuration
   object with an
   initial, empty document (`gameServers: {}`, every other field at its
   default) if one doesn't already exist — without this seed, nothing else
   in the app ever creates that first object, so Settings saves, Games-page
   adds, and Pulumi previews would otherwise fail immediately after the
   wizard finishes. Finally, this step has an advisory **IAM permission
   check** — it simulates the `HyveonDeployAll` policy's actions against
   your credentials and tells you exactly which are missing, but never
   blocks you from continuing.
4. **Finish setup** — resolves and installs the pinned Pulumi engine,
   installs the AWS provider plugin, and initializes the Pulumi stack
   against the bucket you just created. Runs automatically on arrival; no
   configuration needed beyond what you already entered.

Progress is saved on every step change, so you can close the app and pick up
where you left off. Full detail, screenshot-by-screenshot, is in
[First-run wizard](/app/first-run-wizard). Settings has a "Reconfigure" flow
that re-runs this wizard later if you need to switch AWS profiles, regions,
or bucket names.

Finishing the wizard only creates the **backend** — the buckets Pulumi
stores state and configuration in. Your actual game-server infrastructure
(the ECS cluster, EFS filesystem, Lambdas, DynamoDB tables, Route 53 wiring)
does not exist yet; that's [step 4](#4-plan-and-apply-the-infrastructure).

## 3. Add your first game

Open the **Games** page and click **Add game**. A five-step wizard collects
the container image, the Fargate CPU/memory pair, the ports it listens on,
and the EFS volumes it needs:

```text
Image:  thijsvanloef/palworld-server-docker:latest
CPU / Memory: 2048 / 8192
Ports: 8211/udp, 27015/udp
Environment: PLAYERS=8, SERVER_NAME=My Palworld Server
EFS volume: name "saves", container path /palworld
```

Submitting the wizard writes one entry into the versioned JSON configuration
object (`deployment-config.json`, in the configuration bucket from
[step 2](#2-clone-install-and-launch-the-wizard)) and **nothing else** — no
AWS resource exists yet. See [Games](/app/games) for every field, including
the optional ones the wizard doesn't cover (`https`, `environment` beyond
the basics, `file_seeds`) that you can add by editing the game afterwards.

Rules worth knowing before you save:

- **Volumes** — each entry creates a dedicated EFS access point rooted at
  `/${game}/${name}` and mounts it at the container path you give it. Most
  games need one entry. All access points use UID/GID 1000 ownership —
  game images that run as a different UID will fail to mount.
- **`file_seeds`** (optional, edit-only — not in the Add-game wizard)
  pre-populates files on the EFS volume during apply. Each seed needs an
  in-container path and either UTF-8 `content` or base64 `content_base64`
  (for binary files, e.g. mod `.pak` files). The seeder runs once per unique
  seed content and is a no-op on re-apply when nothing changes. Removed
  entries are **not** deleted from EFS. **Do not put secrets in
  `file_seeds`** — content is written into the JSON configuration object.
- **`https = true`** (optional, edit-only) adds an in-task Caddy
  reverse-proxy sidecar that terminates TLS via Let's Encrypt automatic
  HTTPS, opening 443/tcp and 80/tcp publicly on the game's security group.
  Only set it on games that actually serve HTTP(S); UDP games (most game
  servers) must stay `false`. On a game's first-ever boot, expect the
  sidecar to take a couple of minutes after the server reaches RUNNING
  before HTTPS is live — it can't request a certificate until the
  update-dns Lambda's DNS record for the game propagates. Certificates
  persist on EFS, so this delay does not recur on subsequent restarts.
- **CPU / memory** must be a valid Fargate pair (see the
  [Fargate task size table](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task_definition_parameters.html#task_size)).
- There is no way to declare a per-game DNS record from the app — the
  update-dns Lambda owns that entirely.

## 4. Plan and apply the infrastructure

Go to **Infrastructure**, click **Run plan**, read the change summary
(`N to create` / `N to update` / `N to delete`), click **Approve plan**,
then **Apply**. Full mechanics — the approval expiry, the plan-hash check,
run history, rollback — are in [Infrastructure](/app/iac).

The first apply takes a few minutes end-to-end. It creates the VPC, two
public subnets, an ECS cluster, one task definition + EFS access point +
CloudWatch log group **per game** (HTTPS games get a second, Caddy sidecar
container plus a dedicated cert-storage EFS access point in the same task
definition — no separate load balancer or ACM certificate resource), the
four always-on Lambdas (interactions, followup, update-dns, watchdog) plus a
conditional per-game `efs-seeder` Lambda for any game with `file_seeds`,
three DynamoDB tables (Discord config/state, the audit log, and the
plan/apply run history), two Secrets Manager secrets, and the EventBridge
rule + schedule. The deploy IAM policy's existing `dynamodb:*` statement
(see [step 1](#1-create-and-authorise-an-iam-user)) already covers all
three tables — no policy change is needed.

When it finishes, the interactions Lambda's Function URL is available from
the [Discord](/app/discord) page's Credentials tab — you'll need it in
[step 6](#6-optional-wire-up-the-discord-bot).

## 5. Run the management app

Hyveon is a packaged Electron desktop app — there's no HTTP server or bearer
token to configure. Pick one of the two ways to run it:

### Option A — build and launch

```bash
npm run desktop:build
npm run app:start
```

Same flow used in [step 2](#2-clone-install-and-launch-the-wizard) above.
`npm run desktop:dev` normally adds hot-reload on renderer saves, but has a
known outstanding bundling bug right now — use the build-and-launch sequence
above instead until that's fixed.

### Option B — packaged Electron app (distributable installer)

Prefer to just download and run the app instead of building it? See
[Install](./install.md) for per-OS steps to get past the unsigned-build
warning — the plan to remove that warning entirely lives in the
[code-signing roadmap](./code-signing-roadmap.md).

`npm run desktop:package` produces a platform-native installer via
electron-builder (config: `electron-builder.yml`). Run it from the repo root:

```bash
# Build the Electron bundle and package into an installer
npm run desktop:package
```

This runs `desktop:build` (electron-vite) first, then electron-builder,
which produces one output per platform in `release/`:

| Platform | Output |
|---|---|
| Windows | `release/Hyveon Setup *.exe` (NSIS installer) |
| macOS | `release/Hyveon-*.dmg` (DMG image) |
| Linux | `release/Hyveon-*.AppImage` (AppImage) |

By default electron-builder targets only the host platform. To cross-compile,
pass `--win`, `--mac`, or `--linux` explicitly:
`npx electron-builder --config electron-builder.yml --linux`.

**What gets bundled**: the Electron sources under `out/` are packed into an
asar archive. Lambda bundles are deployed to AWS by the Pulumi program and
are not packaged into the installer.

#### App icon

The icon is authored as vector art in `build/` and rasterised into the formats
each packager expects. All of the generated files are committed, so packaging
works from a clean checkout without extra steps.

Every asset is transparent — there is no background tile — so the mark sits
directly on the taskbar, dock or installer chrome the way a native app icon
does. That constrains the artwork: the cells are solid shapes rather than thin
outlines, because outlines only hold up against a known dark background and go
lacy on a light one.

| File | Source | Used by |
|---|---|---|
| `build/icon.svg` | hand-authored master | everything at 32px and above |
| `build/icon-small.svg` | hand-authored 16–24px variant | the two smallest `.ico` entries, browser tab |
| `build/icon.png` | generated, 1024×1024 | Linux AppImage, and the runtime window icon via `extraResources` |
| `build/icon.ico` | generated, 16–256px | NSIS installer, Windows Explorer, taskbar |
| `build/icon.icns` | generated | macOS DMG and dock |
| `app/packages/web/public/favicon.svg` + `favicon-32.png` + `apple-touch-icon.png` | generated | browser tab in `desktop:dev` and Vite preview |

To change the artwork, edit `build/icon.svg` (and `build/icon-small.svg`, which
carries a simplified version of the same mark for the 16px and 24px slots, where
the seven-cell honeycomb blurs together), then regenerate:

```bash
npm run icons:generate
```

The generator lives at `build/generate-icons.mjs` and uses `sharp` to rasterise
plus `png2icons` to assemble the macOS `.icns`; both are root devDependencies.
Commit the regenerated binaries alongside the SVG change.

## 6. (Optional) Wire up the Discord bot

The serverless bot is two Lambdas, one DynamoDB table (Discord config/state),
and two Secrets Manager secrets — all created by the apply in
[step 4](#4-plan-and-apply-the-infrastructure). You now connect it to a
Discord application.

> **Two more DynamoDB tables are created unconditionally** in the same
> apply — neither is part of the Discord bot and neither requires any of
> the setup below. The **audit log** table records structured audit log
> entries (who did what and when) for game-server configuration changes
> (add/edit/remove) made via the management app's UI; it does not record
> Discord bot actions, server start/stop, or credential edits. The **run
> history** table records one row per plan/apply run — status, initiator,
> approver, approval time, plan hash, configuration version, and a
> plan-diff summary — for the [Infrastructure](/app/iac) page's run
> history. Both tables are covered by the existing `dynamodb:*` action in
> the deploy IAM policy — no policy change is needed.

1. **Create a Discord application** at
   [discord.com/developers/applications](https://discord.com/developers/applications) → **New Application** →
   add a **Bot**. Copy three values from **General Information**:

   | Value | Where it goes | Used for |
   |---|---|---|
   | **Application ID** (Client ID) | DynamoDB Discord config row | Needed when the server registers slash commands for a guild. Public, not a secret. |
   | **Bot Token** | Secrets Manager `${project_name}/discord/bot-token` | `Authorization: Bot <token>` for the REST call that registers commands. Treat like a password. |
   | **Application Public Key** | Secrets Manager `${project_name}/discord/public-key` | The interactions Lambda verifies every incoming interaction against this Ed25519 key. |

   You do **not** need any Privileged Gateway Intents — HTTP interactions
   deliver the invoker's role IDs directly in the request body.

2. **Seed the credentials.** Open the **Discord** page's **Credentials**
   tab, paste the Application ID, Bot Token, and Application Public Key,
   and Save. The dashboard writes directly to DynamoDB and Secrets Manager
   — no infrastructure apply is needed for this step.

3. **Copy the interactions endpoint URL** (shown in the dashboard
   Credentials tab) into the Discord Developer Portal under **General
   Information → Interactions Endpoint URL → Save**. Discord sends a PING
   on save; the Lambda replies PONG and Discord accepts the URL.

4. **Invite the bot to your server.** In the Developer Portal:
   - **Installation → Installation Contexts**: enable **Guild Install**,
     disable **User Install**.
   - **OAuth2 → URL Generator**: tick scopes `bot` and
     `applications.commands`; under **Bot Permissions**, tick
     **Send Messages** and **Use Slash Commands** (Discord's UI name for
     the `USE_APPLICATION_COMMANDS` permission).
   - Open the generated URL and add the bot to your server.

5. **Enable Developer Mode in Discord** (User Settings → Advanced →
   Developer Mode) so you can right-click servers/users/roles and
   **Copy ID**.

6. **In the dashboard's Discord Bot panel:**
   - **Guilds tab**: click **Register commands** next to a guild to install
     `/server-start`, `/server-stop`, `/server-status`, `/server-list`. This
     is always a per-guild REST call; there are no global commands.
   - **Admins tab**: user IDs and/or role IDs that can run everything on
     everything.
   - **Per-Game Permissions tab**: for each game, which users/roles can
     invoke which subset of `start` / `stop` / `status`.

The [user guide](/guides/user) has the day-to-day
command reference; the
[interactions/followup Lambda docs](/components/lambdas)
have the wire-level detail.

## 7. Smoke test

With infra applied, the app running, and (optionally) a Discord guild
configured:

1. Open the dashboard → the game you configured should appear as
   **stopped**.
2. Click **Start**. Watch the card transition through `PROVISIONING` →
   `PENDING` → `RUNNING`. DNS is updated by the update-dns Lambda as soon
   as the task reaches RUNNING.
3. `dig {game}.yourdomain.com` should return the task's public IP within
   a few seconds. Connect your game client.
4. Click **Stop**, or type `/server-stop {game}` in Discord, or do nothing
   for the configured watchdog window — any of the three stops the task and
   removes the DNS record.

## 8. Tear it down

Stop every server from the dashboard first (so the update-dns Lambda gets a
clean STOPPED event and removes records), then go to **Infrastructure** and
use the **Destroy infrastructure** panel at the bottom of the page — type
`destroy infrastructure` to confirm. See [Destroy](/app/iac#destroy) for the
full confirmation flow.

The two Secrets Manager secrets use a zero-day recovery window, so they are
deleted immediately — you can apply again tomorrow without hitting "already
scheduled for deletion".

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Plan fails with "no such hosted zone" / a Route 53 lookup error | `hosted_zone_name` doesn't exist in Route 53 | Create the hosted zone first (or delegate your registrar's NS records). |
| Apply fails partway through with a Lambda-bundle error | Lambda bundles weren't built | `npm run app:build:lambdas`, then re-apply from the Infrastructure page. |
| EFS seeder Lambda times out or returns `EFS mount failed` | Mount targets not ready or security group misconfigured | Ensure the apply completed fully (mount targets take ~30 s); check the seeder Lambda's CloudWatch log group `/aws/lambda/${project_name}-efs-seeder-{game}`. |
| `file_seeds` path error: "does not start with container_path" | Seed path doesn't share the first volume's container path prefix | Check that the seed's path begins with the first volume's container path (e.g. `/palworld/…`). |
| Discord panel says infrastructure not yet applied | The interactions Lambda's Function URL output is missing | Re-run the apply from the Infrastructure page. |
| Dashboard says **awaiting credentials** | Secrets still contain the infra program's `"placeholder"` seed | Paste the real bot token + public key in the Credentials tab and Save. |
| Discord rejects the interactions URL with "invalid interactions endpoint URL" | Public key in Secrets Manager doesn't match Discord's | Re-copy the Application Public Key from the Developer Portal and Save. |
| `/server-*` slash commands don't appear in Discord | Per-guild registration not done | Guilds tab → **Register commands** next to the guild ID. |
| `/server-start` says "You don't have permission" | Your user/role isn't in admins or per-game permissions, or the `start` action isn't ticked | Admins tab or Per-Game Permissions tab, then retry. |
| Task reaches RUNNING but DNS never updates | update-dns Lambda errored; EventBridge rule might be disabled | Check the Lambda's CloudWatch logs; verify the EventBridge rule is enabled. |
| Watchdog stops tasks too aggressively | Low idle-packet threshold, short check interval, or few idle checks configured | Tune the three knobs via the dashboard **Server Config** panel and re-apply. |
