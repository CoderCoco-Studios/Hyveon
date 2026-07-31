import { useState } from 'react';
import { DiagnosticsPanel } from '../components/DiagnosticsPanel.js';
import { DeploymentSettingsForm } from '../components/deployment-settings-form.component.js';
import { WatchdogPanel } from '../components/watchdog-panel.component.js';
import { PollingIndicator } from '../polling/polling-indicator.component.js';
import { FirstRunWizard } from '../components/first-run-wizard/first-run-wizard.component.js';
import { Button } from '../components/ui/button.component.js';

/**
 * Settings route (`/settings`) — watchdog config + the deployment-settings
 * form (`DeploymentSettingsForm`, task 9.7 of `migrate-iac-to-pulumi`) for
 * every top-level `DeploymentConfig` field except `gameServers`. Per the
 * issue spec, the watchdog panel moves here from the dashboard.
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
        Cloud setup section. The version-status row that used to read
        `window.hyveon.wizard.checkPrereqs()` was removed in task 10.1/10.2
        of `migrate-iac-to-pulumi` — that channel probed for a host
        `terraform`/`aws` CLI, which no longer exists now the Pulumi engine
        is app-managed. Task 10.4 replaces this with a row reporting the
        resolved Pulumi engine version instead; until then this is a
        deliberately thinner interim state, not a redesign.
      */}
      <div className="mb-8">
        <h3 className="text-lg font-medium mb-4">Cloud Setup</h3>
        <div className="flex items-center justify-between rounded-[var(--radius-md)] border border-[var(--color-border)] p-4">
          <div>
            <p className="text-sm font-medium">Terraform</p>
          </div>
          <Button type="button" variant="outline" onClick={() => setReconfiguring(true)}>
            Reconfigure
          </Button>
        </div>
      </div>

      {/* General settings: top-level deployment configuration (task 9.7) */}
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
