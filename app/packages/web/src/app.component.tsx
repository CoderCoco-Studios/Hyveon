import { useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { AppLayout } from './components/app-layout.component.js';
import { DashboardPage } from './pages/dashboard.page.js';
import { CostsPage } from './pages/costs.page.js';
import { DiscordPage } from './pages/discord.page.js';
import { LogsPage } from './pages/logs.page.js';
import { TerraformPage } from './pages/terraform.page.js';
import { TerraformHistoryPage } from './pages/terraform-history.page.js';
import { TerraformRunDetailPage } from './pages/terraform-run-detail.page.js';
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
 * (i.e. skip the wizard) on any failure — a missing `window.gsd` bridge or a
 * failed IPC call must never lock an otherwise-working install out of its
 * own dashboard. Returns `null` while the check is in flight.
 */
function useWizardCompleted(): boolean | null {
  const [wizardCompleted, setWizardCompleted] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!window.gsd) {
      setWizardCompleted(true);
      return;
    }
    window.gsd.wizard
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
 * bootstrapped). Once complete, renders the routed dashboard shell:
 *   - `/` → Dashboard (game cards + panels)
 *   - `/costs` → Cost analysis placeholder
 *   - `/discord` → Discord settings placeholder
 *   - `/logs` → Logs placeholder
 *   - `/terraform` → Terraform plan/apply
 *   - `/terraform/history` → Terraform run history
 *   - `/terraform/history/:runId` → Read-only run detail
 *   - `/settings` → Watchdog + general settings
 *   - `/games` → Games list (read-only settings)
 *   - `/games/:name` → Per-game settings detail (read-only)
 *   - `/audit` → Audit log
 */
export default function App() {
  const wizardCompleted = useWizardCompleted();

  if (wizardCompleted === null) return null;
  if (!wizardCompleted) return <FirstRunWizard />;

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
              <Route path="/terraform" element={<TerraformPage />} />
              <Route path="/terraform/history" element={<TerraformHistoryPage />} />
              <Route path="/terraform/history/:runId" element={<TerraformRunDetailPage />} />
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
