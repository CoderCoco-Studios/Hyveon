---
title: Logs
sidebar_position: 7
---

# Logs

The Logs screen (route `/logs`) tails one game server's CloudWatch logs live.
It is the first place to look when a server will not start, or when players
report something odd.

> CloudWatch tail for the selected game. Pause to inspect; resume to flush the
> buffer.

![The Logs screen with a game selected, a search box, a Levels filter, an Autoscroll checkbox, a Pause button, and a stream of colour-coded log lines](/img/app/logs.png)

In the sidebar, **Logs** (under Monitoring) is a group with two always-visible
children: **Game Logs**, this page, and **Infra Logs**, which tails the app's
Lambda functions instead — see [Infrastructure logs](#infrastructure-logs)
below.

## Where the logs come from

Logs are read from CloudWatch Logs, from the log group **`/ecs/{game}-server`**
— the group the Pulumi infra program creates for each entry in `gameServers`
(`defineEcs` in `@hyveon/infra`).

Opening the page does two things: it fetches a snapshot of the most recent
lines from the newest log stream, then it opens a live tail that polls
CloudWatch every two seconds for anything new.

The live tail starts from the moment you subscribe, so it only shows lines
produced from then on. Everything before that comes from the snapshot.

If infrastructure has not been deployed, the live tail fails immediately and
the error banner reads `Stream ended with error: Infrastructure is not
deployed. Run Apply on the IaC page first.` If the game has never run (the log
group exists but has no streams yet), the snapshot comes back as a single
line reading `No log streams found for minecraft.` — rendered as an ordinary
log line, not as an error.

## Choosing a game

The combobox at the top left shows the selected game, or `Select a game…`.
Opening it focuses a search field (`Search games…`) so you can type straight
away; matching is a case-insensitive substring on the game name. If nothing
matches you get `No games found.`

Pick an option with the mouse, or Tab to it and press Enter. Press `Escape` or
click outside to close without changing anything.

**Selecting a game restarts the stream.** Specifically, switching games:

- clears the visible buffer,
- discards anything buffered while paused,
- **resets Pause back to Live**,
- clears any error,
- re-fetches the snapshot and reopens the tail.

Your search text, hidden levels and autoscroll setting are *not* reset.

Arriving here via a game card's **Logs** button pre-selects that game. If you
open the page directly, the first game in the list is selected for you.

## Log levels

Each incoming line is scanned for a level token:

```js
/\b(INFO|WARN(?:ING)?|ERROR|ERR|DEBUG|DBG)\b/i
```

The match is case-insensitive and word-boundary anchored, and the **first**
match in the line wins. Aliases collapse: `WARNING` → `WARN`, `ERR` → `ERROR`,
`DBG` → `DEBUG`.

Matched lines get a coloured badge — `INFO` cyan, `WARN` amber, `ERROR` red,
`DEBUG` grey. Lines with no recognisable level get a blank space where the
badge would be, so the text stays column-aligned.

ANSI colour escape codes in a line (the 16 standard terminal foreground
colours plus bold) are rendered as coloured text rather than shown as raw
escape characters. Level detection strips those codes first, so a colourised
`ERROR` line is still classified correctly regardless of what colour the
source process wrapped it in.

### The Levels filter

The **Levels** button shows how many are visible, e.g. `Levels (4/4)`. Opening
it reveals a **Show levels** menu with a checkbox for each of `INFO`, `WARN`,
`ERROR`, `DEBUG` — all checked by default. The menu stays open as you toggle,
so you can turn several off in one go.

Unchecking a level hides those lines from the view. Two things to note:

- **Lines with no detected level are never hidden by this filter.** They
  always show, whatever you have unchecked.
- Hiding is a view filter — hidden lines still count against the buffer cap
  described below.

The footer summarises the state, e.g. `142 lines · oldest 3m ago · 2 levels
hidden`.

## Search highlights, it does not filter

The search box (`Search visible buffer…`) **highlights matches in place**. It
does not remove non-matching lines, and it does not change how many lines are
shown.

Matching is case-insensitive, and every occurrence in a line is highlighted,
not just the first. Clearing the box removes the highlighting.

This is deliberate: when you are reading a stack trace, filtering a log to
matching lines destroys the context you needed the search for. Use **Levels**
when you want to narrow, and **Search** when you want to find.

## Autoscroll

The **Autoscroll** checkbox is on by default: every new line jumps the view to
the bottom. Unchecking it freezes the scroll position so you can read
something while the stream continues.

Autoscroll is also suppressed while the stream is paused.

## Pause and Resume

The button on the right toggles between **Pause** and **Resume**, and the pill
in the page header switches between `LIVE` and `PAUSED`.

**Pausing does not stop the stream.** New lines keep arriving; they are held
in a buffer instead of being appended to the view. While paused, the footer
shows how many are waiting:

```text
buffered 37
```

Pressing **Resume** flushes that buffer into the view in one go and returns to
live tailing. Switching games while paused discards the buffer and returns to
Live.

If you pause while already scrolled up into historical mode, resuming does
*not* splice the buffered live lines into the middle of the historical window
you are looking at — they stay held until you explicitly click **Jump to
latest** (see [The 300-line window, and scrolling up for
history](#the-300-line-window-and-scrolling-up-for-history)). Pause/Resume
and historical mode buffer independently but never fight over the same
buffer.

## The 300-line window, and scrolling up for history

The viewport holds at most **300 lines** at a time (`WINDOW_SIZE` in
`useLogTail`). In normal tailing this works the same as before: once the
window is full, the oldest visible line is dropped as a new one arrives.

What changed is that this is no longer a hard ceiling on how far back you can
see. Scroll near the top of the log box and the viewer switches into
**historical mode** and fetches an older page of CloudWatch log events
automatically, prepending it above what is already loaded. Keep scrolling up
and it keeps paging backward, one `WINDOW_SIZE` page at a time.

While a backward fetch is in flight, a small `Loading older logs…` line shows
at the top of the box. When a backward fetch comes back empty — you have
reached the real start of what CloudWatch has retained for that log group —
the viewer shows `— Beginning of log retention —` at the top and stops
issuing further backward fetches for the current target.

**While you are in historical mode, the live tail does not stop** — new lines
keep arriving, but they are held in a buffer instead of being spliced into
the historical window you are reading, exactly like the pause buffer
described above. A **Jump to latest** button appears, floating at the bottom
of the log box, for as long as you are in historical mode.

Scrolling back down toward the bottom of a loaded historical window fetches
the gap between the newest line you have loaded and now, so continuing to
scroll down eventually catches you back up to the present without losing
anything in between — but it does not by itself return you to live-tail mode.

Clicking **Jump to latest** (or pressing Resume while paused, see below) is
what actually leaves historical mode: it discards the historical window,
flushes any buffered live lines into the view, and returns to live tailing
with autoscroll re-enabled.

This is a view window, not a log retention setting — nothing is deleted from
CloudWatch either way, and how far back you can page is bounded by CloudWatch's
own retention for that log group, not by anything the app enforces.

The pause buffer itself is *not* capped, so a long pause can accumulate more
than 300 lines; the cap is applied when you press Resume, keeping the newest
300. Note that the footer's `buffered N` count (see [Pause and
Resume](#pause-and-resume)) only appears while paused — lines buffered purely
because you are in historical mode (not paused) are not surfaced there; the
presence of the **Jump to latest** button is the signal that live lines are
being held back.

## On a narrow window

Below a certain width the search box, the Levels menu and the Autoscroll
checkbox collapse behind a **Filters** button. When levels are hidden, the
button annotates itself, e.g. `Filters (2 hidden)`. Expanding it reveals the
same three controls stacked vertically.

The game combobox and the Pause/Resume button stay visible at every width.

## Empty and error states

Inside the log box:

| Situation | Copy |
|---|---|
| No game selected | `Select a game to start tailing.` |
| Game selected, nothing to show | `Waiting for log lines…` |

That second message also appears when every line you have received has been
hidden by the Levels filter — if a busy server looks silent, check whether you
left a level unchecked.

Errors appear in a red banner above the log box:

| Copy | Meaning |
|---|---|
| `Could not load games.` | The games list failed to load, so there is nothing to select |
| `Could not load initial logs; trying live stream.` | The snapshot failed; the live tail is still being attempted |
| `Stream ended with error: …` | The live tail died |
| `Could not load older logs: …` | A scroll-up backfill fetch (`getOlder`) failed |
| `Could not load newer logs: …` | A scroll-down gap-fill fetch (`getRange`) failed |
| `IPC bridge (window.hyveon) is not available in this context.` | The renderer lost its connection to the app's backend |

Transient CloudWatch hiccups during the tail are surfaced *inline as a log
line* rather than in the banner, prefixed `[stream error]`.

## Infrastructure logs

The **Infra Logs** page (route `/logs/infrastructure`) is this page's sibling: it tails one of the app's 5 Lambda functions instead of a game server.

Both pages are thin wrappers around the same `useLogTail` hook, so tail/pause, the Levels filter, search highlighting, autoscroll, and the 300-line window with scroll-up history backfill all behave exactly as described above in [Log levels](#log-levels), [Search highlights](#search-highlights-it-does-not-filter), [Autoscroll](#autoscroll), [Pause and Resume](#pause-and-resume) and [The 300-line window, and scrolling up for history](#the-300-line-window-and-scrolling-up-for-history) — nothing about that behaviour differs between the two pages.

What's different is where the logs come from and how you pick a target:

- Instead of a game combobox, a row of 5 buttons picks the function: `watchdog`, `health-check`, `dns-updater`, `interactions`, `followup`. `watchdog` is selected by default. Like the game combobox on this page, this picker stays visible at every width — it is not one of the controls that collapses behind the narrow-window **Filters** button.
- Each function's logs come from the CloudWatch log group `/aws/lambda/{projectName}-{functionKey}`, where `projectName` is the operator's configured project name (falling back to `hyveon` if it can't be read). For the default project name, that means log groups like `/aws/lambda/hyveon-watchdog`.
- As on this page, opening it fetches a snapshot of the most recent lines and then opens a live tail; the Lambda tail polls every two seconds, same as the game-logs tail.
- `health-check` is conditionally provisioned: its CloudWatch log group only exists once at least one game in the deployment declares a `healthCheck`. Picking it before that's configured shows an informational "no log group yet" message instead of an error, and the live tail stops after that single message rather than polling forever.

## What this page is not

- It does not show the Hyveon app's own logs. Those are on
  [Settings → Diagnostics](/app/settings#diagnostics).
- It does not show Infrastructure (Pulumi) output. That lives on the
  [Infrastructure](/app/iac) page and in run history.
- It does not show Lambda logs. Those are on the sibling **Infra Logs** page
  — see [Infrastructure logs](#infrastructure-logs) above.
