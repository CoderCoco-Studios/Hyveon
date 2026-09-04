import { useEffect, useState } from 'react';
import { PULUMI_ENGINE_VERSION } from '@hyveon/shared';
import type { ManualUpdateCheckResult } from '@hyveon/shared';
import { DiagnosticsPanel } from '../components/DiagnosticsPanel.js';
import { DeploymentSettingsForm } from '../components/deployment-settings-form.component.js';
import { PageHeader } from '../components/page-header.component.js';
import { WatchdogPanel } from '../components/watchdog-panel.component.js';
import { PollingIndicator } from '../polling/polling-indicator.component.js';
import { FirstRunWizard } from '../components/first-run-wizard/first-run-wizard.component.js';
import { Button } from '../components/ui/button.component.js';
import { CloudHealthSection } from '../components/cloud-health-section.component.js';
import { SettingsRow } from '../components/settings-row.component.js';

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
 * same "genuine failure vs. an expected value" distinction: bare `'error'`
 * means the *initial read* failed and no value is known at all. Once a value
 * is known, a *write* failure stays in the `ready` shape with
 * `writeError: true` — the checkbox keeps showing the last confirmed
 * `enabled` value rather than dropping to the no-known-value error state.
 */
type AutoUpdateState = 'loading' | { status: 'ready'; enabled: boolean; writeError?: boolean } | 'error';

/**
 * Client-side state for the Updates section's on-demand "Check for Updates"
 * button — independent of {@link AutoUpdateState}, since the manual check
 * works regardless of the `enableAutoUpdate` flag's value.
 */
type ManualCheckState = 'idle' | 'checking' | { status: 'done'; result: ManualUpdateCheckResult };

/** Renders {@link ManualCheckState} as the manual-check row's status text. */
function manualCheckLabel(state: ManualCheckState): string | null {
  if (state === 'idle') return null;
  if (state === 'checking') return 'Checking for updates…';
  const result = state.result;
  if (!result.ok) return result.message;
  return result.updateAvailable ? `Update available: v${result.version}` : "You're up to date.";
}

/**
 * Settings route (`/settings`) — watchdog config + the deployment-settings
 * form (`DeploymentSettingsForm`) for every top-level `DeploymentConfig`
 * field except `gameServers`.
 *
 * While `reconfiguring` is true, this page renders only
 * {@link FirstRunWizard} in `mode: 'reconfigure'` — mirroring how
 * `app.component.tsx` swaps the whole routed shell out for the first-run
 * wizard while `wizardCompleted` is false. Both `onComplete` and `onCancel`
 * just flip `reconfiguring` back to `false`; nothing about the surrounding
 * page (route, layout) needs to change either way.
 */
export function SettingsPage() {
  const [reconfiguring, setReconfiguring] = useState(false);
  const [engineVersion, setEngineVersion] = useState<EngineVersionState>('loading');
  const [autoUpdate, setAutoUpdate] = useState<AutoUpdateState>('loading');
  const [manualCheck, setManualCheck] = useState<ManualCheckState>('idle');

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
   * Flips `enableAutoUpdate` via the `autoUpdateUpdate` IPC channel. On
   * success, replaces the confirmed `enabled` value. On failure, uses a
   * functional update so the last confirmed `enabled` value survives —
   * the checkbox keeps reflecting what's actually persisted, with
   * `writeError: true` surfaced as inline copy, rather than dropping to the
   * no-known-value error state a failed write shouldn't imply.
   */
  function handleAutoUpdateToggle(next: boolean) {
    const settings = window.hyveon?.iac?.settings;
    const write = settings ? settings.autoUpdateUpdate({ enableAutoUpdate: next }) : Promise.reject(new Error('hyveon IPC bridge unavailable'));
    write
      .then((result) => {
        if (result.ok) {
          setAutoUpdate({ status: 'ready', enabled: result.enableAutoUpdate });
        } else {
          setAutoUpdate((prev) => (typeof prev === 'object' ? { ...prev, writeError: true } : 'error'));
        }
      })
      .catch(() => setAutoUpdate((prev) => (typeof prev === 'object' ? { ...prev, writeError: true } : 'error')));
  }

  /**
   * Runs an on-demand update check via the `autoUpdateCheck` IPC bridge —
   * independent of `enableAutoUpdate`/`autoUpdate` state above, so it works
   * whether or not the toggle is on.
   */
  function handleManualCheck() {
    setManualCheck('checking');
    const settings = window.hyveon?.iac?.settings;
    const check = settings ? settings.autoUpdateCheck() : Promise.reject(new Error('hyveon IPC bridge unavailable'));
    check
      .then((result) => setManualCheck({ status: 'done', result }))
      .catch(() =>
        setManualCheck({ status: 'done', result: { ok: false, message: 'Unable to reach the update service.' } }),
      );
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
      <div className="mb-6">
        <PageHeader title="Settings">
          <PollingIndicator />
        </PageHeader>
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
        <SettingsRow label="Pulumi Engine" description={engineVersionLabel(engineVersion)}>
          <Button type="button" variant="outline" onClick={() => setReconfiguring(true)}>
            Reconfigure
          </Button>
        </SettingsRow>
      </div>

      {/*
        Updates section: toggles the `enableAutoUpdate` electron-store flag
        that gates `desktop-main/src/updater.ts`'s `electron-updater` checks.
        Applies on next app start, not the running session (`initUpdater`
        only runs once at Electron boot) — the description text says so.
      */}
      <div className="mb-8">
        <h3 className="text-lg font-medium mb-4">Updates</h3>
        <SettingsRow
          label="Automatic Updates"
          description={
            autoUpdate === 'loading'
              ? 'Checking update setting…'
              : autoUpdate === 'error'
                ? 'Unable to read the update setting.'
                : autoUpdate.writeError
                  ? 'Failed to save — still showing the last saved value.'
                  : 'Check GitHub Releases for updates on app start. Applies on next app start.'
          }
        >
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input
              type="checkbox"
              aria-label="Automatic updates"
              checked={autoUpdate !== 'loading' && autoUpdate !== 'error' && autoUpdate.enabled}
              disabled={autoUpdate === 'loading' || autoUpdate === 'error'}
              onChange={(e) => handleAutoUpdateToggle(e.target.checked)}
              className="size-4 rounded border-[var(--color-border)] bg-[var(--color-surface-2)] accent-[var(--color-primary)]"
            />
          </label>
        </SettingsRow>

        {/*
          Manual check row: triggers `iac.settings.autoUpdate.check`
          independent of the `enableAutoUpdate` toggle above — the flag only
          gates the automatic boot-time check.
        */}
        <div className="mt-3">
          <SettingsRow
            label="Check Now"
            description={manualCheckLabel(manualCheck) ?? 'Check GitHub Releases for a newer version right now.'}
          >
            <Button type="button" variant="outline" onClick={handleManualCheck} disabled={manualCheck === 'checking'}>
              Check for Updates
            </Button>
          </SettingsRow>
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
