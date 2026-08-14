import { useEffect, useState } from 'react';
import { PULUMI_ENGINE_VERSION } from '@hyveon/shared';
import { DiagnosticsPanel } from '../components/DiagnosticsPanel.js';
import { DeploymentSettingsForm } from '../components/deployment-settings-form.component.js';
import { WatchdogPanel } from '../components/watchdog-panel.component.js';
import { PollingIndicator } from '../polling/polling-indicator.component.js';
import { FirstRunWizard } from '../components/first-run-wizard/first-run-wizard.component.js';
import { Button } from '../components/ui/button.component.js';
import { CloudHealthSection } from '../components/cloud-health-section.component.js';

/**
 * Client-side state for the Cloud Setup section's Pulumi engine version row —
 * tracks the `iac.settings.engineVersion` IPC round trip separately from its
 * result so a genuine fetch failure (IPC unavailable, an unexpected
 * main-process error) renders distinct copy from `resolvedVersion: null`,
 * which is a real, expected "not yet provisioned" state (a fresh install
 * that hasn't run the engine yet), not a failure.
 *
 *  - `'loading'`: the initial state, before the IPC call has settled.
 *  - `{ status: 'ready', resolvedVersion }`: the call resolved —
 *    `resolvedVersion` is `null` when the engine hasn't been provisioned yet.
 *  - `'error'`: the call itself rejected (or `window.hyveon.iac.settings` is
 *    unavailable) — best-effort fallback.
 */
type EngineVersionState = 'loading' | { status: 'ready'; resolvedVersion: string | null } | 'error';

/**
 * Renders {@link EngineVersionState} as the Cloud Setup row's detail line,
 * always suffixed with the pinned/target version (`PULUMI_ENGINE_VERSION`)
 * regardless of state.
 */
function engineVersionLabel(state: EngineVersionState): string {
  const pinned = `pinned to v${PULUMI_ENGINE_VERSION}`;
  if (state === 'loading') return `Checking engine version… · ${pinned}`;
  if (state === 'error') return `Unable to determine engine version · ${pinned}`;
  return state.resolvedVersion === null
    ? `Not yet provisioned · ${pinned}`
    : `Pulumi engine v${state.resolvedVersion} · ${pinned}`;
}

/**
 * Client-side state for the Updates section's `enableAutoUpdate` toggle —
 * mirrors {@link EngineVersionState}'s loading/ready/error shape, and the
 * same "genuine failure vs. an expected value" distinction: `'error'` means
 * the IPC call itself failed or `window.hyveon.iac.settings` is unavailable,
 * never a real `false` value.
 */
type AutoUpdateState = 'loading' | { status: 'ready'; enabled: boolean } | 'error';

/**
 * Settings route (`/settings`) — watchdog config + the deployment-settings
 * form (`DeploymentSettingsForm`) for every top-level `DeploymentConfig`
 * field except `gameServers`.
 *
 * While `reconfiguring` is true, this page renders only
 * {@link FirstRunWizard} in `mode: 'reconfigure'` (#211) — mirroring how
 * `app.component.tsx` swaps the whole routed shell out for the first-run
 * wizard while `wizardCompleted` is false. Both `onComplete` and `onCancel`
 * just flip `reconfiguring` back to `false`; nothing about the surrounding
 * page (route, layout) needs to change either way.
 */
export function SettingsPage() {
  const [reconfiguring, setReconfiguring] = useState(false);
  const [engineVersion, setEngineVersion] = useState<EngineVersionState>('loading');
  const [autoUpdate, setAutoUpdate] = useState<AutoUpdateState>('loading');

  useEffect(() => {
    // `settings` may be absent (`window.hyveon.iac.settings` unavailable) —
    // routed through the same rejected-promise path as a real IPC failure so
    // every `setEngineVersion` call below happens inside a promise callback,
    // never synchronously in the effect body (react-hooks/set-state-in-effect).
    const settings = window.hyveon?.iac?.settings;
    const read = settings ? settings.engineVersion() : Promise.reject(new Error('hyveon IPC bridge unavailable'));
    read
      .then((result) => setEngineVersion({ status: 'ready', resolvedVersion: result.resolvedVersion }))
      .catch(() => setEngineVersion('error'));
  }, []);

  useEffect(() => {
    // Same pattern as the engine-version effect above: an absent bridge is
    // routed through the rejected-promise path so `setAutoUpdate` only ever
    // runs inside a promise callback.
    const settings = window.hyveon?.iac?.settings;
    const read = settings ? settings.autoUpdateGet() : Promise.reject(new Error('hyveon IPC bridge unavailable'));
    read
      .then((result) => setAutoUpdate(result.ok ? { status: 'ready', enabled: result.enableAutoUpdate } : 'error'))
      .catch(() => setAutoUpdate('error'));
  }, []);

  /**
   * Flips `enableAutoUpdate` via the `autoUpdateUpdate` IPC channel. Only
   * updates displayed state on a successful write — a failed write leaves
   * the toggle showing its last-known-good value rather than optimistically
   * flipping and silently reverting.
   */
  function handleAutoUpdateToggle(next: boolean) {
    const settings = window.hyveon?.iac?.settings;
    const write = settings ? settings.autoUpdateUpdate({ enableAutoUpdate: next }) : Promise.reject(new Error('hyveon IPC bridge unavailable'));
    write
      .then((result) => setAutoUpdate(result.ok ? { status: 'ready', enabled: result.enableAutoUpdate } : 'error'))
      .catch(() => setAutoUpdate('error'));
  }

  if (reconfiguring) {
    return (
      <FirstRunWizard
        mode="reconfigure"
        onComplete={() => setReconfiguring(false)}
        onCancel={() => setReconfiguring(false)}
      />
    );
  }

  return (
    <div className="max-w-5xl mx-auto">
      <div className="mb-6 flex items-center justify-between">
        <h2 className="text-2xl font-semibold">Settings</h2>
        <PollingIndicator />
      </div>

      {/* Watchdog section */}
      <div className="mb-8">
        <h3 className="text-lg font-medium mb-4">Watchdog Configuration</h3>
        <WatchdogPanel />
      </div>

      {/* Cloud Health section: always-visible AWS account-prerequisite checklist. */}
      <div className="mb-8">
        <h3 className="text-lg font-medium mb-4">Cloud Health</h3>
        <CloudHealthSection />
      </div>

      {/*
        Cloud setup section: reports the resolved Pulumi engine version
        (`iac.settings.engineVersion`) alongside the pinned/target version
        (`PULUMI_ENGINE_VERSION`) — see `engineVersionLabel` above for the
        exact copy per state.
      */}
      <div className="mb-8">
        <h3 className="text-lg font-medium mb-4">Cloud Setup</h3>
        <div className="flex items-center justify-between rounded-[var(--radius-md)] border border-[var(--color-border)] p-4">
          <div>
            <p className="text-sm font-medium">Pulumi Engine</p>
            <p className="text-sm text-muted-foreground">{engineVersionLabel(engineVersion)}</p>
          </div>
          <Button type="button" variant="outline" onClick={() => setReconfiguring(true)}>
            Reconfigure
          </Button>
        </div>
      </div>

      {/*
        Updates section: toggles the `enableAutoUpdate` electron-store flag
        that gates `desktop-main/src/updater.ts`'s `electron-updater` checks.
        Applies on next app start, not the running session (`initUpdater`
        only runs once at Electron boot) — the description text says so.
      */}
      <div className="mb-8">
        <h3 className="text-lg font-medium mb-4">Updates</h3>
        <div className="flex items-center justify-between rounded-[var(--radius-md)] border border-[var(--color-border)] p-4">
          <div>
            <p className="text-sm font-medium">Automatic Updates</p>
            <p className="text-sm text-muted-foreground">
              {autoUpdate === 'loading'
                ? 'Checking update setting…'
                : autoUpdate === 'error'
                  ? 'Unable to read the update setting.'
                  : 'Check GitHub Releases for updates on app start. Applies on next app start.'}
            </p>
          </div>
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input
              type="checkbox"
              aria-label="Automatic updates"
              checked={autoUpdate !== 'loading' && autoUpdate !== 'error' && autoUpdate.enabled}
              disabled={autoUpdate === 'loading'}
              onChange={(e) => handleAutoUpdateToggle(e.target.checked)}
              className="size-4 rounded border-[var(--color-border)] bg-[var(--color-surface-2)] accent-[var(--color-primary)]"
            />
          </label>
        </div>
      </div>

      {/* General settings: top-level deployment configuration */}
      <div className="mb-8">
        <h3 className="text-lg font-medium mb-4">General</h3>
        <DeploymentSettingsForm />
      </div>

      {/* Diagnostics section */}
      <div>
        <h3 className="text-lg font-medium mb-4">Diagnostics</h3>
        <DiagnosticsPanel />
      </div>
    </div>
  );
}
