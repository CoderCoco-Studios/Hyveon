import { useEffect, useState, type CSSProperties } from 'react';
import { Minus, Square, Copy, X } from 'lucide-react';

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

/**
 * Reserves the region Windows' `titleBarOverlay` draws its overlay buttons
 * into (top-right, per Electron's docs) — DOM elements there cannot receive
 * clicks. `env(titlebar-area-width)` is an absolute length (the draggable
 * region's width, measured from the window's left edge), not a percentage —
 * so it must be subtracted from the *viewport* width (`100vw`), not from
 * `100%` of this spacer's own containing block (the trailing flex group,
 * which is only a few hundred px wide and would make the formula always
 * resolve negative → clamp to 0px, reserving nothing). `env(...)` only has a
 * real value inside a WCO-enabled window (falls back to `100vw` elsewhere, so
 * the whole expression evaluates to 0 outside win32, which is fine since
 * this component renders nothing outside win32 anyway). `flexShrink: 0`
 * keeps it from being squeezed to 0 under space pressure from its sibling
 * content.
 */
export function TitlebarOverlaySpacer() {
  if (window.hyveon?.window?.platform !== 'win32') return null;
  return (
    <div
      data-titlebar-overlay-spacer=""
      aria-hidden="true"
      style={{ width: 'calc(100vw - env(titlebar-area-width, 100vw))', flexShrink: 0 }}
    />
  );
}

/**
 * App-drawn minimize/maximize-or-restore/close buttons for the custom title
 * bar. Renders `null` unless `window.hyveon?.window` is present AND the
 * platform is Linux — macOS keeps native traffic lights and Windows keeps
 * the native `titleBarOverlay`, so this component draws nothing there (the
 * `BrowserWindow` chrome itself, not this component, reserves layout space
 * for those OS-drawn controls).
 */
export function WindowControls() {
  const windowApi = window.hyveon?.window;
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    // Only Linux ever renders this component's buttons (see the doc comment
    // above) — skip the isMaximized() IPC round-trip and the onMaximizedChange
    // subscription entirely on macOS/Windows, where they exist only to drive
    // state a `null` render never uses.
    if (!windowApi || windowApi.platform !== 'linux') return;
    // A live `onMaximizedChange` push always wins over the initial
    // `isMaximized()` seed — if the seed's IPC round-trip resolves after a
    // real change event (e.g. the window is maximized the instant this
    // mounts), applying it unconditionally would clobber the newer state
    // back to stale.
    let receivedLiveUpdate = false;
    windowApi
      .isMaximized()
      .then((maximized) => {
        if (!receivedLiveUpdate) setIsMaximized(maximized);
      })
      .catch(() => undefined);
    const unsubscribe = windowApi.onMaximizedChange((maximized) => {
      receivedLiveUpdate = true;
      setIsMaximized(maximized);
    });
    return unsubscribe;
  }, [windowApi]);

  if (!windowApi || windowApi.platform !== 'linux') return null;

  return (
    <div className="flex items-center gap-1" style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}>
      <button
        type="button"
        onClick={() => void windowApi.minimize()}
        aria-label="Minimize"
        className="min-h-8 min-w-8 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
      >
        <Minus className="w-4 h-4" aria-hidden="true" />
      </button>
      <button
        type="button"
        onClick={() => void windowApi.toggleMaximize()}
        aria-label={isMaximized ? 'Restore' : 'Maximize'}
        className="min-h-8 min-w-8 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
      >
        {isMaximized ? (
          <Copy className="w-3.5 h-3.5" aria-hidden="true" />
        ) : (
          <Square className="w-3.5 h-3.5" aria-hidden="true" />
        )}
      </button>
      <button
        type="button"
        onClick={() => void windowApi.close()}
        aria-label="Close"
        className="min-h-8 min-w-8 flex items-center justify-center rounded-md text-muted-foreground hover:text-red-400 hover:bg-red-500/10 transition-colors"
      >
        <X className="w-4 h-4" aria-hidden="true" />
      </button>
    </div>
  );
}
