// @spec APP-SHELL-CHROME-007, APP-SHELL-CHROME-013
/**
 * Reserves leading space for the macOS traffic-light cluster, which
 * `platformWindowChromeOptions()` positions at `x: 252, y: 20` — inside the
 * header, not the sidebar (D2). The cluster's three ~12px circles plus
 * spacing span roughly 52px, starting 12px past the sidebar's 240px width
 * (240 + 12 = 252); ~80px gives a small safety margin past that so the
 * header's own "Hyveon" heading/env pill don't render underneath it. Fixed
 * at build time like {@link TitlebarOverlaySpacer}, but note the sidebar can
 * be hidden below the `md` breakpoint (768px) — see the `electron-entry.ts`
 * `resize` listener, which switches `trafficLightPosition` itself between
 * the sidebar-offset and a no-sidebar position so the traffic lights stay
 * aligned with wherever this reserved space actually starts. Renders
 * nothing outside darwin.
 */
export function TrafficLightSpacer() {
  if (window.hyveon?.window?.platform !== 'darwin') return null;
  return <div data-traffic-light-spacer="" aria-hidden="true" className="w-20 shrink-0" />;
}

// @spec APP-SHELL-CHROME-009, APP-SHELL-CHROME-012, APP-SHELL-CHROME-013
/**
 * Reserves the region the native `titleBarOverlay` (Windows and Linux) draws
 * its overlay buttons into (top-right, per Electron's docs) — DOM elements there cannot receive
 * clicks. `env(titlebar-area-width)` is an absolute length (the draggable
 * region's width, measured from the window's left edge), not a percentage —
 * so it must be subtracted from the *viewport* width (`100vw`), not from
 * `100%` of this spacer's own containing block (the trailing flex group,
 * which is only a few hundred px wide and would make the formula always
 * resolve negative → clamp to 0px, reserving nothing). `env(...)` only has a
 * real value inside a WCO-enabled window (falls back to `100vw` elsewhere, so
 * the whole expression evaluates to 0 outside win32/linux, which is fine since
 * this component renders nothing there anyway). `flexShrink: 0`
 * keeps it from being squeezed to 0 under space pressure from its sibling
 * content.
 */
export function TitlebarOverlaySpacer() {
  const platform = window.hyveon?.window?.platform;
  if (platform !== 'win32' && platform !== 'linux') return null;
  return (
    <div
      data-titlebar-overlay-spacer=""
      aria-hidden="true"
      style={{ width: 'calc(100vw - env(titlebar-area-width, 100vw))', flexShrink: 0 }}
    />
  );
}
