---
title: Code-signing roadmap
sidebar_position: 7
---

# Code-signing roadmap

Hyveon's v1 packaged builds are unsigned (see [Install](./install.md) for what
that means for end users right now). This page records the path to signed
releases for whoever picks this up next — the cost, the ownership decision,
the config changes required, and what changes once signing lands.

## Why this isn't done yet

Signing costs money and requires an account tied to a person or
organization, which is a maintainer/ownership decision this project hasn't
made yet — not a technical blocker. The wiring below is what's needed once
that decision is made.

## macOS: Apple Developer Program + notarization

- **Cost**: Apple Developer Program membership, **~$99/year**, tied to an
  Apple ID (personal or organization).
- **What it unlocks**: a Developer ID Application certificate, used to sign
  the `.app` bundle, plus notarization (Apple's automated malware scan) so
  Gatekeeper shows no warning at all rather than the current right-click
  workaround.
- **electron-builder config changes** (`electron-builder.yml`):
  - Set `mac.hardenedRuntime: true` — currently `false` (see below).
  - Add `mac.notarize` (or rely on electron-builder's automatic notarization
    when `CSC_LINK`/`CSC_KEY_PASSWORD` and Apple ID credentials are present
    in the signing environment).
  - Supply the exported `.p12` certificate and an app-specific Apple ID
    password (or API key) as CI secrets — never commit them.

### Why `hardenedRuntime: false` today

`electron-builder.yml`'s `mac.hardenedRuntime: false` is **intentional and
must stay `false` until a real signing identity exists**. The hardened
runtime enforces entitlements that only make sense for a properly signed and
notarized app — enabling it without a valid Developer ID certificate produces
a build that's neither hardened-runtime-compliant nor notarizable, and is
strictly worse than the current honestly-unsigned build. Flip this only in
the same change that adds the real signing certificate and notarization
config.

## Windows: Azure Trusted Signing

- **Cost**: **~$10/month** for an Azure Trusted Signing subscription (replaces
  the old EV code-signing-certificate model, which required a hardware token
  and cost hundreds of dollars per year).
- **What it unlocks**: SmartScreen reputation builds up faster with a trusted
  signing identity, and eventually the "Windows protected your PC" warning
  stops appearing for the NSIS installer.
- **electron-builder config changes**:
  - Configure `win.azureSignOptions` (or the equivalent CLI/env-based signing
    hook electron-builder documents for Azure Trusted Signing) pointing at the
    Azure subscription's endpoint, certificate profile, and account name.
  - Store the Azure credentials (tenant ID, client ID/secret, or federated
    identity for GitHub Actions) as CI secrets.

## Linux (AppImage)

AppImages don't have an OS-level signing/notarization gate the way macOS and
Windows do — `chmod +x` is the only friction today (see
[Install](./install.md)), and that stays true regardless of the macOS/Windows
signing work above. No roadmap item needed here.

## Enabling auto-update once signing lands

`electron-updater` is already wired (see the `auto-update-scaffold`
capability) but stays **disabled by default** via the `enableAutoUpdate`
electron-store flag, specifically because an unsigned updater would fail
Gatekeeper checks on macOS regardless of what the update feed says. Once
signing is in place:

1. Confirm the release feed is actually reachable: `.github/workflows/package.yml`'s
   `package` job uploads each platform's `latest*.yml` manifest (`latest.yml`
   for Windows, `latest-mac.yml` for macOS, `latest-linux.yml` for Linux)
   alongside the installer, and the macOS build produces a `zip` target
   in addition to the `dmg` — `electron-updater`'s `MacUpdater` only ever
   looks for a `zip` asset in the release feed and explicitly ignores
   dmg/pkg, so without it macOS auto-update can never resolve an update no
   matter how correct the signing is.
2. Flip the `enableAutoUpdate` default to `true` for new installs, or point
   operators at the **Automatic Updates** toggle on the
   [Settings page](/app/settings#updates) — that toggle already ships; this
   step is just about the default, not the UI.
3. Windows and Linux builds can be flag-on tested as soon as their respective
   signing is done, independently of macOS — only the macOS path is
   Gatekeeper-blocked pending Apple Developer enrollment.
4. Re-verify the "first launch, flag off, zero network calls" behavior still
   holds for anyone who explicitly opts back out.

## Current blockers

- No Apple Developer account has been provisioned for this project.
- No Azure Trusted Signing subscription has been provisioned for this
  project.
- Both require a maintainer/ownership decision (whose name/org the
  certificate is issued to, who holds the renewal billing) before any config
  work above can start.
