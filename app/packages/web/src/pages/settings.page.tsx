import { useEffect, useState } from 'react';
import { PULUMI_ENGINE_VERSION } from '@hyveon/shared';
import { DiagnosticsPanel } from '../components/DiagnosticsPanel.js';
import { DeploymentSettingsForm } from '../components/deployment-settings-form.component.js';
import { WatchdogPanel } from '../components/watchdog-panel.component.js';
import { PollingIndicator } from '../polling/polling-indicator.component.js';
import { FirstRunWizard } from '../components/first-run-wizard/first-run-wizard.component.js';
import { Button } from '../components/ui/button.component.js';

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
