---
title: Setup guide
sidebar_position: 3
---

# Setup guide

This is the end-to-end walkthrough, from a blank AWS account to a running
Fargate task you can connect to from your game client, plus the optional
Discord bot. Allow ~30 minutes the first time; most of that is waiting for
`terraform apply`.

The [submodule guide](/guides/submodule) covers the
alternative workflow of vendoring this repo inside a private parent that
holds `terraform.tfvars` and state. Come back here afterwards for the
per-step detail.

## Prerequisites

On the machine that will run `terraform apply` and the management app:

| Tool | Version | Notes |
|------|---------|-------|
| Node.js | 20+ | Enforced by the Nest backend boot. |
| npm | 10+ | Ships with Node 20. |
| Terraform | 1.5+ | Install manually (or let the in-app setup wizard drive `terraform init` for you once credentials are configured). |
| AWS CLI | v2 | Optional — the desktop app talks to AWS directly via the SDK, but the CLI is handy for `aws configure` and manual troubleshooting. |

On the AWS side you need:

- An AWS account you control (pure personal use is fine).
- **A Route 53 hosted zone you already own** — e.g. `yourdomain.com`.
  Terraform looks it up as a data source and will not create it for you.
  If you use an external registrar, delegate the zone's NS records to
  Route 53 before running Terraform or DNS updates will go nowhere.

## 1. Create and authorise an IAM user

1. In the **[AWS IAM console](https://console.aws.amazon.com/iam/)** →
   **Users → Create user**, give it a name like `hyveon`.
2. On the permissions step, choose **Attach policies directly** and skip
   through without selecting any managed policy. Create the user.
3. Open the new user → **Permissions → Add permissions → Create inline
   policy → JSON**. Paste the policy below, name it `GameServerDeployAll`,
   and save.
4. **Security credentials → Create access key → Command Line Interface (CLI)**.
   Copy the Access Key ID and Secret Access Key. Treat the secret like a
   password — AWS will not show it again.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "GameServerDeploy",
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
        "cloudfront:*"
      ],
      "Resource": "*"
    },
    {
      "Sid": "GameServerIAM",
      "Effect": "Allow",
      "Action": "iam:*",
      "Resource": [
        "arn:aws:iam::*:role/hyveon-*",
        "arn:aws:iam::*:policy/hyveon-*"
      ]
    },
    {
      "Sid": "GameServerTfvarsBucket",
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
> prefix matches the default `project_name`. If you change `project_name` in
> `terraform.tfvars`, update the two ARN patterns in `GameServerIAM` to match.

> **`GameServerTfvarsBucket` scopes access to the tfvars-bucket storage**
> created by the [bootstrap module](#3-clone-install-and-bootstrap-aws-resources) (see the
> "Bootstrap the tfvars bucket" step below) — the dedicated, versioned S3
> bucket (default name `${project_name}-tfvars`) that holds `terraform.tfvars`
> outside source control. It grants object read/write/list/versioning access
> plus the bucket-config actions (`PutLifecycleConfiguration`,
> `PutEncryptionConfiguration`, `PutBucketPublicAccessBlock`,
> `PutBucketVersioning`/`GetBucketVersioning`, `GetBucketLocation`) the
> bootstrap module needs to configure the bucket's lifecycle rule,
> encryption, public-access block, and versioning. Although `s3:*` in
> `GameServerDeploy` already covers these actions on every bucket, this
> statement documents the specific permissions the tfvars-bucket workflow
> depends on and scopes them to just the two tfvars ARNs. If you change
> `project_name` or `tfvars_bucket_name`, update the two ARN patterns in
> `GameServerTfvarsBucket` to match.

Two permission areas used by Terraform are **not** covered by any AWS managed policy and are explicitly included above to avoid `AccessDenied` during `terraform apply`:

- **EventBridge tag operations** — the AWS provider tags EventBridge rules on creation, which requires `events:TagResource`, `events:UntagResource`, and `events:ListTagsForResource`. `events:*` above already grants these — if you tighten the policy later, keep those three actions in.
- **CloudFront** — the Discord interactions endpoint is fronted by a CloudFront distribution. `cloudfront:*` above covers creation, updates, tagging, and deletion of distributions.

This policy is the **single source of truth** for IAM permissions. If you need to add or remove permissions, edit it here — do not create separate inline policies or update the README independently.

## 2. Configure the AWS CLI

```bash
aws configure
#   AWS Access Key ID:     AKIA...
#   AWS Secret Access Key: ****
#   Default region name:   us-east-1          # must match terraform.tfvars
#   Default output format: json

aws sts get-caller-identity                   # verify
```

Both Terraform and the management app read `~/.aws/credentials` and
`~/.aws/config` automatically. If you prefer environment variables, export
`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and `AWS_DEFAULT_REGION`
instead — the management app will pick them up too.

## 3. Clone, install, and bootstrap AWS resources

```bash
git clone https://github.com/CoderCoco/Hyveon.git
cd Hyveon
npm install
```

Then launch the Electron app in dev mode and follow the **in-app setup
wizard**:

```bash
npm run app:dev
```

The wizard walks you through picking a cloud provider, choosing (or pasting)
AWS credentials, running an IAM permission simulation, and bootstrapping the
AWS resources the root Terraform config needs before its first `apply`:

- The S3 state bucket (`{project_name}-tf-state`) and DynamoDB lock table
  (`{project_name}-tf-locks`) used as the Terraform backend.
- The versioned tfvars bucket (`{project_name}-tfvars`, provisioned by the
  `terraform/bootstrap/` module — see
  [Bootstrap the tfvars bucket](#bootstrap-the-tfvars-bucket-required-before-the-first-terraform-apply)
  below) that holds `terraform.tfvars` outside of source control.
- `terraform init` against the resulting backend.

Names are editable in the wizard; if you skip it or need to redo a step
later, Settings has a "Reconfigure" flow that re-runs `terraform init`
against whatever resources you point it at.

### tfvars storage: local vs S3

`terraform.tfvars` can live purely as a local file — the default, and all
you need for a single operator on a single machine, with no `tfvars-sync`
commands to run. Switch to the optional **S3 backend** once any of these
apply: more than one person (or a CI job) needs to run `terraform
plan`/`apply`, you want version history/recoverability for tfvars edits
independent of git, you want `terraform apply` to refuse to run against a
stale local copy, or you want the desktop app's remote tfvars editing
(`RemoteTfvarsStore`'s pull/push/diff/lock flow) to be able to read and write
`terraform.tfvars` without SSH/file-share access to whichever machine last
ran `terraform apply`. If none of that applies to you, stay on `local` and
skip ahead to [step 4](#4-configure-your-servers) once you've completed the
[one-time bucket bootstrap](#bootstrap-the-tfvars-bucket-required-before-the-first-terraform-apply)
below — `local` mode skips the day-to-day S3 sync workflow, **not** the
bucket itself: the root module reads it unconditionally, so it must exist
before the first `terraform apply` no matter which mode you choose.

For the full day-to-day S3 workflow — the `tfvars-sync` CLI, migrating an
existing parent repo between `local` and `s3`, and a troubleshooting table —
see the dedicated [S3 tfvars storage guide](/guides/s3-tfvars). The rest of
this section covers only the one-time bootstrap step.

> **IAM warning:** the S3 backend needs bucket access on top of the core
> deploy policy. Confirm the `GameServerTfvarsBucket` statement from
> [step 1](#1-create-and-authorise-an-iam-user) is attached to whatever
> IAM user/role bootstraps the bucket and runs `terraform apply` — without
> it, bootstrapping the bucket and every subsequent `pull`/`push`/`plan`/`apply`
> against it will fail with an S3 `AccessDenied` error.

### Bootstrap the tfvars bucket (required before the first `terraform apply`)

`terraform/bootstrap/` is a separate, standalone Terraform module that
provisions a **second, distinct S3 bucket** whose only job is to hold your
`terraform.tfvars` outside of source control. This is unrelated to the
`{project_name}-tf-state` bucket used for the Terraform backend. The root
module's `data "aws_s3_bucket" "tfvars"` (in `terraform/main.tf`) reads this
bucket, so it **must already exist before you run `terraform apply` in the
root `terraform/` directory** — skipping this step makes the root
`terraform plan`/`terraform apply` fail at plan time with a "bucket not
found" error.

**The setup wizard bootstraps this bucket for you** as part of step 3 above.
Use the manual steps below if you skipped the wizard, want to re-run the
bootstrap standalone, or are pre-creating the bucket outside the app:

```bash
cd terraform/bootstrap
terraform init
terraform apply
```

The bucket it creates (default name `{project_name}-tfvars`) has:

- **Versioning enabled** — every write to `terraform.tfvars` is recoverable.
- **AES-256 server-side encryption** and a **public-access block** (all four
  block-public settings on).
- A **lifecycle rule** that expires noncurrent object versions after 90 days,
  so old revisions don't accumulate forever.

> **This module's own state stays local and is never committed.** It can't
> use the S3 backend it's bootstrapping (chicken-and-egg), so `terraform
> apply` writes a local `terraform.tfstate` under `terraform/bootstrap/` —
> already covered by `.gitignore` (`terraform/**/*.tfstate`). Keep a personal
> backup of that file; without it, a future `terraform apply` in this
> directory won't recognize the bucket it already created.

If you accept the default bucket name, no further action is needed — the
root config's `tfvars_bucket_name` variable defaults to the same
`{project_name}-tfvars` convention. If you pass a custom
`-var="tfvars_bucket_name=..."` (or `project_name`) when applying this
module, set the **same** value for `tfvars_bucket_name` in
`terraform/terraform.tfvars` (see step 4 below) so the root module's
`data "aws_s3_bucket" "tfvars"` resolves to the bucket you actually created.

## 4. Configure your servers

Open `terraform/terraform.tfvars` in your editor and fill in:

```hcl
aws_region       = "us-east-1"
project_name     = "hyveon"
hosted_zone_name = "yourdomain.com"    # must already exist in Route 53

# Watchdog knobs (defaults shown)
watchdog_interval_minutes = 15
watchdog_idle_checks      = 4          # 15 × 4 = 60 min grace before auto-stop
watchdog_min_packets      = 100

# One entry per game. Everything downstream iterates over this map.
game_servers = {
  palworld = {
    image  = "thijsvanloef/palworld-server-docker:latest"
    cpu    = 2048
    memory = 8192
    ports = [
      { container = 8211,  protocol = "udp" },
      { container = 27015, protocol = "udp" },
    ]
    environment = [
      { name = "PLAYERS",        value = "8" },
      { name = "SERVER_NAME",    value = "My Palworld Server" },
      { name = "ADMIN_PASSWORD", value = "CHANGE_ME" },
    ]
    volumes = [
      { name = "saves", container_path = "/palworld" },
    ]
    https = false
    # Optional: Discord message shown when the server reaches RUNNING.
    # Supports {host}, {ip}, {port} (first port), and {game} placeholders.
    # connect_message = "connect in game at {host}:{port}"
  }
}
```

Rules worth knowing before you save:

- **`volumes`** is a list of EFS mount points for the game. Each entry creates
  a dedicated EFS access point rooted at `/${game}/${name}` and mounts it at
  `container_path` inside the container. Most games need one entry; add more
  if the image expects multiple distinct paths. All access points use UID/GID
  1000 ownership — game images that run as a different UID will fail to mount.
- **`file_seeds`** (optional) pre-populates files on the EFS volume during
  `terraform apply`. Each seed needs an in-container `path` and either `content`
  (UTF-8 text) or `content_base64` (binary, e.g. mod `.pak` files — encode
  with `base64 -w0 MyMod.pak`). An optional `mode` sets the file permissions
  (default `"0644"`). The seeder runs once per unique seed content and is a
  no-op on re-apply when nothing changes. Removed entries are **not** deleted
  from EFS. **Do not put secrets in `file_seeds`** — content is stored in
  Terraform state.

  ```hcl
  file_seeds = [
    {
      path    = "/palworld/Pal/Saved/Config/LinuxServer/PalWorldSettings.ini"
      content = <<-INI
        [/Script/Pal.PalGameWorldSettings]
        OptionSettings=(Difficulty=None,DayTimeSpeedRate=1.0,NightTimeSpeedRate=1.0)
      INI
    },
    {
      path           = "/palworld/Pal/Content/Paks/MyMod.pak"
      content_base64 = "UEsDBBQAAAAI..."  # base64 -w0 MyMod.pak
    },
  ]
  ```

- **`https = true`** adds an in-task Caddy reverse-proxy sidecar that
  terminates TLS for the game via Let's Encrypt automatic HTTPS, opening
  443/tcp and 80/tcp publicly on the game's security group (80 is required
  for the ACME HTTP-01 challenge and the HTTP→HTTPS redirect). Only set it
  on games that actually serve HTTP(S); UDP games (most game servers) must
  stay `false`. On a game's first-ever boot, expect the sidecar to take a
  couple of minutes after the server reaches RUNNING before HTTPS is live —
  it can't request a certificate until the update-dns Lambda's DNS record
  for the game propagates, and it retries with backoff. Certificates persist
  on EFS, so this delay does not recur on subsequent restarts.
- **CPU / memory** must be a valid Fargate pair (see the
  [Fargate task size table](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task_definition_parameters.html#task_size)).
- **Do not write `aws_route53_record` resources** — the update-dns Lambda
  owns that.

Optionally seed Discord credentials here too. If you leave them out, you can
paste them into the dashboard later:

```hcl
discord_application_id = "123456789012345678"
discord_bot_token      = "xxxx.yyyy.zzzz"          # sensitive
discord_public_key     = "abcd...ef01"             # sensitive
```

`terraform.tfvars` is gitignored, so these stay on your machine. Rotation
after the first apply takes one `terraform taint`; see the
[submodule guide](/guides/submodule) for the pattern
that puts this file in a private parent repo.

## 5. Apply the infrastructure

**If you're upgrading an existing deployment that has an HTTPS game running
behind the old ALB** (i.e. applying this for the first time after the
Caddy-sidecar migration), **stop that game first.** This one-time apply
deletes the ALB/ACM certificate and static DNS alias while changing public
ingress — applying with the game still running can cause downtime or a
partial migration. This warning does not apply to a fresh install, which has
no ALB to migrate away from.

```bash
cd terraform
terraform plan
terraform apply
```

`apply` takes 5–10 minutes end-to-end. It creates the VPC, two public
subnets, an ECS cluster, one task definition + EFS access point +
CloudWatch log group **per game** (HTTPS games get a second, Caddy sidecar
container plus a dedicated cert-storage EFS access point in the same task
definition — no separate load balancer or ACM certificate resource), the
four Lambdas, three DynamoDB tables (Discord config/state, the audit log,
and the Terraform-runs history — see
[step 7](#7-optional-wire-up-the-discord-bot)), two Secrets Manager secrets,
and the EventBridge rule + schedule. The deploy IAM policy's existing
`dynamodb:*` statement (see [step 1](#1-create-and-authorise-an-iam-user))
already covers all three tables — no policy change was needed for the runs
table.

When it finishes, note two outputs:

- `interactions_invoke_url` — the Lambda Function URL you'll paste into the
  Discord Developer Portal for the bot.
- `ecs_cluster_name` / `game_names` — used by the dashboard (it reads
  `terraform.tfstate` directly, so you normally don't need to copy these
  by hand).

## 6. Run the management app

Hyveon is a packaged Electron desktop app — there's no HTTP server or bearer
token to configure. Pick one of the two ways to run it:

### Option A — dev mode

```bash
npm run app:dev
```

Launches the Electron app with hot-reload on renderer saves. This is the
same wizard-driven flow used in [step 3](#3-clone-install-and-bootstrap-aws-resources)
above.

### Option B — packaged Electron app (distributable installer)

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
asar archive. Only `terraform/terraform.tfstate` (the single state file — not
the `.tf` source files) is embedded via `extraResources` and lands outside the
asar at `process.resourcesPath` inside the installed app. At runtime the main
process reads `<resourcesPath>/terraform/aws/terraform.tfstate` — the
`to: terraform/aws` mapping in `electron-builder.yml` is why the sub-path
includes `aws/`, and this is the same data `ConfigService` requires in dev
mode. Lambda bundles are deployed to AWS via Terraform and are not packaged
into the installer.

## 7. (Optional) Wire up the Discord bot

The serverless bot is two Lambdas, one DynamoDB table (`discord_table_name`,
CONFIG + PENDING rows), and two Secrets Manager secrets — all created by
`terraform apply` in step 5. You now connect it to a Discord application.

> **Two more DynamoDB tables, `audit_table_name` and `runs_table_name`, are
> created unconditionally** in the same `terraform apply` — neither is part
> of the Discord bot and neither requires any of the setup below.
> `audit_table_name` records structured audit log entries (who did what and
> when) for game-server configuration changes (add/edit/remove) made via the
> management app's UI; it does not record Discord bot actions, server
> start/stop, or credential edits. `runs_table_name` records one row per
> Terraform plan/apply run — `id`, `kind` (`plan` | `apply`), `status`,
> `initiator`, `approver`, `approvedAt`, `planHash`, `tfvarsVersion`, and a
> plan-diff `summary` — for the dashboard's apply-history view. Both tables are
> covered by the existing `dynamodb:*` action in the deploy IAM policy — no
> policy change is needed. See
> [`audit_table_name` and `runs_table_name`](/components/terraform#variables)
> to override either name.

1. **Create a Discord application** at
   [discord.com/developers/applications](https://discord.com/developers/applications) → **New Application** →
   add a **Bot**. Copy three values from **General Information**:

   | Value | Where it goes | Used for |
   |---|---|---|
   | **Application ID** (Client ID) | DynamoDB `CONFIG#discord` row | Needed when the server registers slash commands for a guild. Public, not a secret. |
   | **Bot Token** | Secrets Manager `${project_name}/discord/bot-token` | `Authorization: Bot <token>` for the REST call that registers commands. Treat like a password. |
   | **Application Public Key** | Secrets Manager `${project_name}/discord/public-key` | The interactions Lambda verifies every incoming interaction against this Ed25519 key. |

   You do **not** need any Privileged Gateway Intents — HTTP interactions
   deliver the invoker's role IDs directly in the request body.

2. **Seed the credentials.** Either:
   - Set `discord_application_id`, `discord_bot_token`, and
     `discord_public_key` in `terraform.tfvars` and re-apply. Terraform
     writes them once and then `ignore_changes` lets the dashboard edit
     them without being overwritten on subsequent applies. To rotate via
     tfvars later, `terraform taint` the relevant resource first.
   - Or leave them empty and open the **Credentials** tab in the dashboard;
     paste and Save. The dashboard writes directly to DynamoDB and Secrets
     Manager.

   Optionally set a **base allowlist and admins** in `terraform.tfvars`.
   These are written to a separate `BASE#discord` DynamoDB row on every
   `terraform apply` and cannot be removed via the dashboard UI — only a
   tfvars edit + re-apply can change them. Useful for locking in your own
   guild and user ID before handing the dashboard to others:

   ```hcl
   base_allowed_guilds = ["123456789012345678"]
   base_admin_user_ids = ["987654321098765432"]
   base_admin_role_ids = []
   ```

   When `discord_bot_token`, `discord_application_id`, **and** at least one
   entry in `base_allowed_guilds` are all set, `terraform apply` also
   registers the slash commands in each base guild automatically — no manual
   "Register commands" click needed for those guilds.

3. **Copy the interactions endpoint URL** (the `interactions_invoke_url`
   Terraform output, also shown in the dashboard Credentials tab) into the
   Discord Developer Portal under **General Information → Interactions
   Endpoint URL → Save**. Discord sends a PING on save; the Lambda replies
   PONG and Discord accepts the URL.

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
   - **Guilds tab**: guilds in `base_allowed_guilds` have their slash commands
     registered automatically by `terraform apply` (provided the bot token and
     application ID were set in tfvars). For any guild added via the UI, click
     **Register commands** to install `/server-start`, `/server-stop`,
     `/server-status`, `/server-list`. This is always a per-guild REST call;
     there are no global commands.
   - **Admins tab**: user IDs and/or role IDs that can run everything on
     everything.
   - **Per-Game Permissions tab**: for each game, which users/roles can
     invoke which subset of `start` / `stop` / `status`.

The [user guide](/guides/user) has the day-to-day
command reference; the
[interactions/followup Lambda docs](/components/lambdas)
have the wire-level detail.

## 8. Smoke test

With infra applied, the app running, and (optionally) a Discord guild
configured:

1. Open the dashboard → the game you configured should appear as
   **stopped**.
2. Click **Start**. Watch the card transition through `PROVISIONING` →
   `PENDING` → `RUNNING`. DNS is updated by the update-dns Lambda as soon
   as the task reaches RUNNING.
3. `dig {game}.yourdomain.com` should return the task's public IP within
   `dns_ttl` seconds (default 30). Connect your game client.
4. Click **Stop**, or type `/server-stop {game}` in Discord, or do nothing
   for `watchdog_interval_minutes × watchdog_idle_checks` minutes — any of
   the three stops the task and removes the DNS record.

## 9. Tear it down

Stop every server from the dashboard first (so the DNS updater gets a clean
STOPPED event and removes records), then:

```bash
cd terraform
terraform destroy
```

The two Secrets Manager secrets use `recovery_window_in_days = 0`, so they
are deleted immediately — you can `terraform apply` again tomorrow without
hitting "already scheduled for deletion".

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `terraform apply` fails with "data source not found for zone" | `hosted_zone_name` doesn't exist in Route 53 | Create the hosted zone first (or delegate your registrar's NS records). |
| `archive_file` fails during `terraform apply` | You didn't run `npm run build:lambdas` | `cd app && npm run build:lambdas`, then re-apply. |
| EFS seeder Lambda times out or returns `EFS mount failed` | Mount targets not ready or security group misconfigured | Ensure `terraform apply` completed fully (mount targets take ~30 s); check the seeder Lambda's CloudWatch log group `/aws/lambda/${project_name}-efs-seeder-{game}`. |
| `file_seeds` path error: "does not start with container_path" | Seed path doesn't share the first volume's `container_path` prefix | Check that `path` begins with `volumes[0].container_path` (e.g. `/palworld/…`). |
| Dashboard says **terraform not applied** in the Discord panel | `interactions_invoke_url` output missing | Re-run `cd app && npm run build:lambdas && cd ../terraform && terraform apply`. |
| Dashboard says **awaiting credentials** | Secrets still contain the Terraform `"placeholder"` seed | Paste the real bot token + public key in the Credentials tab and Save. |
| Discord rejects the interactions URL with "invalid interactions endpoint URL" | Public key in Secrets Manager doesn't match Discord's | Re-copy the Application Public Key from the Developer Portal and Save. |
| `/server-*` slash commands don't appear in Discord | Per-guild registration not done | For base guilds: ensure `discord_bot_token`, `discord_application_id`, and `base_allowed_guilds` are all set in tfvars, then re-run `terraform apply`. For UI-added guilds: Guilds tab → **Register commands** next to the guild ID. |
| `/server-start` says "You don't have permission" | Your user/role isn't in admins or per-game permissions, or the `start` action isn't ticked | Admins tab or Per-Game Permissions tab, then retry. |
| Task reaches RUNNING but DNS never updates | update-dns Lambda errored; EventBridge rule might be disabled | Check the Lambda's CloudWatch logs; verify the EventBridge rule is enabled. |
| Watchdog stops tasks too aggressively | Low `watchdog_min_packets`, short `watchdog_interval_minutes`, or low `watchdog_idle_checks` | Tune the three knobs via the dashboard **Server Config** panel and re-apply. |
