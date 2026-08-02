import { useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { AppLayout } from './components/app-layout.component.js';
import { DashboardPage } from './pages/dashboard.page.js';
import { CostsPage } from './pages/costs.page.js';
import { DiscordPage } from './pages/discord.page.js';
import { LogsPage } from './pages/logs.page.js';
import { IacPage } from './pages/iac.page.js';
import { IacHistoryPage } from './pages/iac-history.page.js';
import { IacRunDetailPage } from './pages/iac-run-detail.page.js';
import { SettingsPage } from './pages/settings.page.js';
import { GamesPage } from './pages/games.page.js';
import { GameDetailPage } from './pages/game-detail.page.js';
import { AuditPage } from './pages/audit.page.js';
import { PollingProvider } from './polling/polling-provider.component.js';
import { GameStatusProvider } from './polling/game-status-provider.component.js';
import { Toaster } from './components/ui/sonner.component.js';
import { FirstRunWizard } from './components/first-run-wizard/first-run-wizard.component.js';

/**
 * Fetches the wizard's completion flag once on mount. Defaults to `true`
 * (i.e. skip the wizard) on any failure — a missing `window.hyveon` bridge or a
 * failed IPC call must never lock an otherwise-working install out of its
 * own dashboard. Returns `null` while the check is in flight.
 */
function useWizardCompleted(): boolean | null {
  // The "no bridge" answer is known before the first paint, so it is the
  // lazy initial value rather than a `setWizardCompleted(true)` inside the
  // effect — settling it synchronously avoids both the throwaway render and
  // the `react-hooks/set-state-in-effect` violation.
  //
  // Optional chaining matters here, not just the `window.hyveon` presence
  // check: a `window.hyveon` stub built before this namespace existed (e.g.
  // the chromium e2e tier's stub bridge) has no `.wizard` property, and
  // `window.hyveon.wizard.getState()` would throw synchronously — before
  // there's even a promise to `.catch()` — permanently stalling this
  // component at `wizardCompleted === null` (renders nothing, forever).
  const [wizardCompleted, setWizardCompleted] = useState<boolean | null>(() =>
    window.hyveon?.wizard ? null : true,
  );

  useEffect(() => {
    let cancelled = false;
    if (!window.hyveon?.wizard) return;
    window.hyveon.wizard
      .getState()
      .then((state) => {
        if (!cancelled) setWizardCompleted(state.wizardCompleted);
      })
      .catch(() => {
        if (!cancelled) setWizardCompleted(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return wizardCompleted;
}

/**
 * Root component.
 *
 * Gates the whole app behind the first-run wizard: while
 * `wizardCompleted` is `false`, renders only {@link FirstRunWizard} (no
 * routing, no polling providers — there's nothing to poll before AWS is
 * bootstrapped). The wizard's stack-init step calls `onComplete` once
 * `wizard.complete` succeeds, which flips this component straight to the
 * routed dashboard shell below without waiting on another `wizard.state.get`
 * round-trip. Once complete, renders the routed dashboard shell:
 *   - `/` → Dashboard (game cards + panels)
 *   - `/costs` → Cost analysis placeholder
 *   - `/discord` → Discord settings placeholder
 *   - `/logs` → Logs placeholder
 *   - `/iac` → Terraform plan/apply
 *   - `/iac/history` → Terraform run history
 *   - `/iac/history/:runId` → Read-only run detail
 *   - `/settings` → Watchdog + general settings
 *   - `/games` → Games list (read-only settings)
 *   - `/games/:name` → Per-game settings detail (read-only)
 *   - `/audit` → Audit log
 */
export default function App() {
  const fetchedWizardCompleted = useWizardCompleted();
  // Set directly once the wizard's Finish step succeeds, rather than
  // re-fetching `wizard.state.get` — the wizard already knows the outcome,
  // and this avoids a redundant IPC round-trip on the completion path.
  const [wizardJustCompleted, setWizardJustCompleted] = useState(false);
  const wizardCompleted = wizardJustCompleted ? true : fetchedWizardCompleted;

  if (wizardCompleted === null) return null;
  if (!wizardCompleted) return <FirstRunWizard onComplete={() => setWizardJustCompleted(true)} />;

  return (
    <PollingProvider>
      <GameStatusProvider>
        <BrowserRouter>
          <Toaster position="bottom-right" />
          <AppLayout>
            <Routes>
              <Route path="/" element={<DashboardPage />} />
              <Route path="/costs" element={<CostsPage />} />
              <Route path="/discord" element={<DiscordPage />} />
              <Route path="/logs" element={<LogsPage />} />
              <Route path="/iac" element={<IacPage />} />
              <Route path="/iac/history" element={<IacHistoryPage />} />
              <Route path="/iac/history/:runId" element={<IacRunDetailPage />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="/games" element={<GamesPage />} />
              <Route path="/games/:name" element={<GameDetailPage />} />
              <Route path="/audit" element={<AuditPage />} />
            </Routes>
          </AppLayout>
        </BrowserRouter>
      </GameStatusProvider>
    </PollingProvider>
  );
}
