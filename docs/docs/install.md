---
title: Install
sidebar_position: 4
---

# Install

Hyveon ships as a packaged Electron desktop app. Download the installer for
your OS from the project's
[GitHub Releases](https://github.com/CoderCoco/Hyveon/releases) page:

| Platform | Artifact |
|---|---|
| Windows | `Hyveon Setup *.exe` |
| macOS | `Hyveon-*.dmg` |
| Linux | `Hyveon-*.AppImage` |

## Why you'll see an "unsigned" warning

Hyveon's v1 builds are **not code-signed** — there's no Apple Developer
certificate or Windows signing certificate behind them yet (see the
[code-signing roadmap](./code-signing-roadmap.md) for the plan to change
that). Every OS treats an unsigned binary as unverified and shows a warning
before it'll run. That's expected — it doesn't mean the build is broken or
tampered with, just that nobody has paid for and configured a signing
certificate yet. The steps below get you past each OS's warning.

## macOS — right-click → Open

1. Double-click the downloaded `.dmg` and drag **Hyveon** into `Applications`.
2. Gatekeeper blocks a plain double-click of an unsigned app the first time —
   instead, **right-click (or Control-click) the app in `Applications` and
   choose "Open"**.
3. A dialog still warns the developer can't be verified, but this time it
   offers an **"Open"** button. Click it. macOS remembers this choice — future
   launches work with a normal double-click.

## Windows — SmartScreen "More info → Run anyway"

1. Run the downloaded `Hyveon Setup *.exe`.
2. Windows SmartScreen will show **"Windows protected your PC"**. This is
   expected for an installer without a Windows signing certificate.
3. Click **"More info"**, then click the **"Run anyway"** button that appears.
4. The NSIS installer runs normally from there.

## Linux — make the AppImage executable

AppImages aren't signed the way `.exe`/`.dmg` installers are, but Linux still
requires the executable bit to be set before it'll run:

```bash
chmod +x Hyveon-*.AppImage
./Hyveon-*.AppImage
```

## What's next

Once installed, launch Hyveon and follow the first-run wizard to connect your
AWS account — see [step 6 of the setup guide](./setup.md#6-run-the-management-app)
if you'd rather run from source in dev mode instead.
