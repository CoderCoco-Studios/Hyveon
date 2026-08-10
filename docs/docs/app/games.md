---
title: Games
sidebar_position: 4
---

# Games

The Games screen (route `/games`) is where you declare what servers exist. It
is the app's editor for `gameServers` in the versioned JSON configuration
object (`deployment-config.json`, in your S3 configuration bucket) — there
is no separate variables file any more.

:::danger The rule that governs this whole screen

**Creating, editing or removing a game only updates the JSON configuration
object. Nothing changes in AWS until a plan/apply run.**

Adding a game does not create a task definition. Removing one does not delete
anything — the deployed task definition, EFS access point and security-group
rules stay live. Editing CPU or ports does not touch the running server.

Every one of those changes is inert until you go to [Infrastructure](/app/iac)
and run plan → approve → apply.
:::

![The Games screen showing a table of declared game servers with name, status chip, image, ports, CPU and memory columns, and an Add game button](/img/app/games.png)

## The games table

The card is titled **Declared game servers**. One row per game, listing
everything declared in the configuration object first, then anything
deployed but no longer declared.

| Column | Contents |
|---|---|
| **Name** | The game name, linked to its detail page |
| **Status** | One chip — see below |
| **Image** | The container image, or `—` |
| **Ports** | `25565/tcp, 25575/tcp`, or `—` |
| **CPU** | Fargate CPU units, or `—` |
| **Memory** | MiB, or `—` |

The table has no sorting and no filter box. Only the name cell is clickable —
clicking elsewhere in the row does nothing.

The page fetches once when you open it. Navigate away and back to refresh it.

### Status chips

Exactly one chip per game.

| Chip | Meaning | Cause |
|---|---|---|
| **In sync** (green) | Declared in the configuration object *and* present in the last-applied Pulumi stack outputs | Normal, healthy |
| **Pending deploy** (amber) | Declared in the configuration object, not yet in the applied outputs | You added or changed it but have not applied yet |
| **Undeclared** (red) | In the applied outputs, but **no longer in the configuration object** | You removed it from the configuration object but have not applied the removal |

**"Undeclared" is the one that surprises people.** It means the game is still
*live in AWS* — its task definition, EFS access point and log group all still
exist and can still be started — but there is no declaration for it any more.
The usual cause is having pressed **Remove game** without running a plan/apply
afterwards.

Because there is no declaration, an undeclared row has no config to show: its
Image, Ports, CPU and Memory columns are all `—`. Applying a plan is what
actually tears it down.

The [pending-changes banner](/app/dashboard#the-pending-changes-banner) sits
above the table and summarises the same drift in counts.

## Adding a game

**Add game** opens a six-step dialog titled **Add a game server**, with the
current step shown as `Step 1 of 6: Identity`.

![The Add game wizard on its Identity step, with Name, Image and Connect message fields and Back/Next buttons](/img/app/games-add-wizard.png)

### Step 1 — Identity

| Field | Example | Rules |
|---|---|---|
| **Name** | `minecraft` | Required. Must start with a letter or underscore and contain only letters, numbers, underscores and hyphens. Must not duplicate an existing declared game |
| **Image** | `itzg/minecraft-server` | Required |
| **Connect message** | `Connect at {ip}:25565` | Optional. Only the placeholders `{host}`, `{ip}`, `{port}` and `{game}` are allowed |

The name becomes the `gameServers` map key, the task-definition family
(`{name}-server`), the log group (`/ecs/{name}-server`) and the DNS label —
which is why it is validated as an identifier and why it cannot be changed
later.

### Step 2 — Resources

Two sliders, no free text: **vCPU** and **Memory**. Each slider snaps to the
valid Fargate tiers below rather than any free value, so the memory slider is
disabled until you pick a vCPU and is then rebuilt from that choice. Changing
the vCPU after the fact resets the memory if the current value is no longer
valid for the new tier.

| CPU units | Valid memory (MiB) |
|---|---|
| 256 | 512, 1024, 2048 |
| 512 | 1024 – 4096, in steps of 1024 |
| 1024 | 2048 – 8192, in steps of 1024 |
| 2048 | 4096 – 16384, in steps of 1024 |
| 4096 | 8192 – 30720, in steps of 1024 |
| 8192 | 16384 – 61440, in steps of 4096 |
| 16384 | 32768 – 122880, in steps of 8192 |

1024 CPU units is 1 vCPU. Because the sliders are generated from this table,
the wizard cannot offer you an invalid pairing. A live estimated hourly cost
(`$X.XXXX/hr while running`) appears below the sliders and recomputes as
either slider moves, so you can see the cost impact of a resource change
before submitting.

### Step 3 — Networking

> Declare every container port the server listens on.

Starts empty. **Add port** appends a row with a **Container port** number
field and a **Protocol** dropdown (`TCP` / `UDP`, defaulting to TCP). Each row
has its own **Remove** button.

Two collision checks run continuously:

- Against the other ports in this same game:
  `Port 25565/tcp collides with ports[0] in the same game server.`
- Against every other declared game:
  `Port 25565/tcp collides with existing game "minecraft".`

Both are hard blocks. Note that zero ports is technically allowed by the
wizard — you can advance without adding any — but a server with no declared
ports will not be reachable.

Below the port rows, an **Enable HTTPS (Caddy sidecar)** checkbox sets the
game's `https` flag. Checking it shows a warning: enabling HTTPS opens ports
443 and 80 to the internet for the **whole stack**, not just this game, and
this game's raw container port loses its public ingress rule — traffic
reaches it through the sidecar instead. Two validations key off this flag:
an `https = true` game must declare at least one port (`An https = true
game server must declare at least one port.`), and its first port must be
`tcp` (`The first port entry of an https = true game server must use
protocol "tcp" (exact, lowercase).`).

### Step 4 — Storage

Two sections.

**Volumes** — "Every game server needs at least one EFS-backed volume for its
save data." Each row has a **Volume name** (e.g. `data`) and a **Container
path** (e.g. `/data`). The path must be absolute. The **Remove** button is
disabled once only one row remains; you cannot go below one volume.

**File seeds** — "Optional — files written into a volume the first time the
server starts." Each row has:

| Field | Purpose |
|---|---|
| **Path** | Absolute path inside the container, e.g. `/data/config.yml` |
| **Content** | Plain-text file contents |
| **Content (base64)** | Base64-encoded contents, for binary files |
| **Mode** | Unix mode, e.g. `0644` |

File seeds can be removed down to zero. Blank fields are dropped entirely
rather than written as empty strings.

### Step 5 — Environment

> Optional — environment variables injected into the container (e.g.
> `EULA=TRUE`).

Starts empty, with `No environment variables configured.` shown until you add
a row. **Add variable** appends a row with a **Variable name** field and a
**Value** field (both plain text). Like ports, there is no minimum — zero
variables is valid, and every row's **Remove** button stays enabled all the
way down to zero.

Two rules apply to the **name** field only — any string value is accepted for
**value**:

- A name must not be empty: `environment[0].name must not be empty.`
- A name must not repeat another row's name in the same entry:
  `environment[1].name "EULA" duplicates an earlier environment variable in
  the same entry.`

There is no character-set or casing restriction on the name (unlike the game
**Name** field in Step 1) — container images vary too much to assume a
universal naming convention.

### Step 6 — Review

A read-only summary in four cards — **Identity**, **Resources**,
**Networking**, **Storage** — showing exactly what will be written. The
Storage card lists file-seed *paths* only (contents are never displayed) and,
underneath, an **Environment variables** list of name/value pairs — both
sub-sections are omitted entirely when empty rather than shown blank.

The footer button reads **Submit**.

On success you get a `minecraft created` toast and are taken straight to the
new game's detail page. The game appears in the table as **Pending deploy**
until you apply.

### How validation behaves

Errors appear **as you type**, not on blur or on submit. **Next** is disabled
whenever the *current* step has any error; problems on other steps do not
block you until you reach them.

On the Review step, Submit is disabled unless the whole draft is clean.

If the server rejects the submission, the dialog stays open with your draft
intact and jumps to whichever step the first problem belongs to, with the
message rendered against the offending field.

## The game detail screen

Clicking a name opens `/games/:name`.

![A game detail page showing the In sync chip, Edit and Remove buttons, and cards for Container, Ports and Volumes](/img/app/games-detail.png)

The header carries the game name, its status chip, and — for declared games —
**Edit** and **Remove game** buttons. Below that:

| Card | Contents | Shown |
|---|---|---|
| **Container** | Image, CPU, Memory, HTTPS (`Enabled` / `Disabled`) | Always |
| **Ports** | Container port and protocol per row | Always |
| **Volumes** | Name and container path per row | Always |
| **Environment variables** | Name/value pairs | Only if any are declared |
| **File seeds** | A collapsed `3 files seeded at task start` summary; expand for the paths (and modes). Contents are never shown | Only if any are declared |
| **Connect message** | The raw message template | Only if set |

### The ghost-entry variant

If you open the detail page for an **Undeclared** game, none of those cards
appear. Instead:

> This game is deployed but has no entry in the configuration object — there
> is no declared configuration to show.

**Edit** and **Remove game** are not rendered at all, because there is nothing
declared left to edit or remove. The way to clean it up is to run a plan and
apply from the [Infrastructure](/app/iac) page, which destroys the orphaned
AWS resources.

If you navigate to a name that exists in neither place you get
`No game named "foo" was found.`

## Editing a game

**Edit** replaces the detail cards with a flat form containing the same five
sections as the wizard — Identity, Resources, Networking, Storage,
Environment — pre-filled from the current declaration. All the same
validation applies, but it applies to the whole form at once rather than step
by step.

**The Name field is disabled.** Renaming a game is a delete-and-recreate, not
an update: the name is the task-definition family, the EFS access-point key,
the log-group name and the DNS label. Remove the old game and add a new one if
you need a different name.

`https` has the same toggle here as in the wizard's Networking step.
`environment` is directly editable here too, in its own **Environment** card —
the same row editor (Variable name / Value, no minimum row count) as the
wizard's Step 5.

Above the save button:

> Saving only updates `deployment-config.json` — visit **Infrastructure** to
> apply this change to the live server.

**Save changes** writes the versioned JSON configuration object
(`deployment-config.json`, in your S3 configuration bucket) and returns you
to the read-only view with the new values — it does **not** touch AWS by
itself. A separate plan/apply run from the [Infrastructure](/app/iac) page
is still required to make the change live, the same as adding a game. Ports
declared in this form are checked against every *other* game, so a game
never collides with itself.

## Removing a game

**Remove game** opens a confirmation dialog:

> ### Remove minecraft?
> This deletes the `minecraft` entry from `deployment-config.json`. The deployed AWS
> resources stay live until an operator applies the change from the
> **Infrastructure** page.

Below the text is a single input whose placeholder is the game's own name. You
must type the game name **exactly** — the match is case-sensitive and
untrimmed — before the **Remove game** button becomes clickable.

On success you get `minecraft removed from deployment-config.json` and are returned
to the games list, where the game now shows as **Undeclared** until you run a
plan and apply.

## Concurrent-edit conflicts

The app stores your deployment configuration as a versioned object in your S3
configuration bucket (there is no local-file mode), and can guard writes with
an optimistic-concurrency check: the write carries the object version the app
last read, and S3 rejects it if someone else has written since. That
surfaces as:

> Optimistic lock failed: expected etag "abc123" but remote is now "def456".

There is no automatic retry. Reload the games list to pick up the newer state
and redo your change.

One honest caveat about this mechanism as it stands:

- **The app's own screens do not currently opt in.** The wizard, the edit form
  and the remove dialog all issue unconditional writes, so in practice you
  will not see this error from the UI today. The plumbing exists end to end
  and is exercised by the test suite; the UI simply does not send the expected
  version yet. If two people are editing the same configuration concurrently,
  treat it as last-write-wins and coordinate out of band.
