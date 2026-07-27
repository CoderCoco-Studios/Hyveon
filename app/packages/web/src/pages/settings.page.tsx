import { useEffect, useState } from 'react';
import { MINIMUM_TERRAFORM_VERSION } from '@hyveon/shared';
import type { PrerequisitesReport } from '@hyveon/desktop-preload';
import { DiagnosticsPanel } from '../components/DiagnosticsPanel.js';
import { WatchdogPanel } from '../components/watchdog-panel.component.js';
import { PollingIndicator } from '../polling/polling-indicator.component.js';
import { FirstRunWizard } from '../components/first-run-wizard/first-run-wizard.component.js';
import { Button } from '../components/ui/button.component.js';

/**
 * Settings route (`/settings`) — watchdog config + general settings skeleton.
 * Per the issue spec, the watchdog panel moves here from the dashboard.
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
  const [prereqs, setPrereqs] = useState<PrerequisitesReport | null>(null);

  useEffect(() => {
    if (!window.hyveon?.wizard) return;
    window.hyveon.wizard.checkPrereqs().then(setPrereqs).catch(() => {
      // Best-effort — the version row just falls back to "Not detected".
    });
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

      {/* Cloud setup section */}
      <div className="mb-8">
        <h3 className="text-lg font-medium mb-4">Cloud Setup</h3>
        <div className="flex items-center justify-between rounded-[var(--radius-md)] border border-[var(--color-border)] p-4">
          <div>
            <p className="text-sm font-medium">Terraform</p>
            <p className="text-sm text-muted-foreground">
              {prereqs?.terraform.version ? `Detected v${prereqs.terraform.version}` : 'Not detected'} · minimum v
              {MINIMUM_TERRAFORM_VERSION}
            </p>
          </div>
          <Button type="button" variant="outline" onClick={() => setReconfiguring(true)}>
            Reconfigure
          </Button>
        </div>
      </div>

      {/* General settings placeholder */}
      <div className="mb-8">
        <h3 className="text-lg font-medium mb-4">General</h3>
        <p className="text-muted-foreground text-sm">
          Additional configuration options will appear here in future updates.
        </p>
      </div>

      {/* Diagnostics section */}
      <div>
        <h3 className="text-lg font-medium mb-4">Diagnostics</h3>
        <DiagnosticsPanel />
      </div>
    </div>
  );
}
