/**
 * Bottom-of-page Settings panel that used to read and write the three
 * watchdog tuning knobs (check interval, idle checks, min packets) via a
 * local `server_config.json`, through `api.config()` / `api.saveConfig()`.
 * That save flow was dead on arrival: the deployed watchdog Lambda never
 * reads `server_config.json` — its real tunables come from `DeploymentConfig`
 * (`app/packages/infra/src/lambdas.ts`), which is the same data
 * `DeploymentSettingsForm`'s "Watchdog tuning" section already edits
 * correctly (#348).
 *
 * Rather than duplicate that editor with a second, read-only fetch of the
 * same values, this panel is now a static pointer to it — no IPC call, no
 * inputs, no Save button.
 */
export function WatchdogPanel() {
  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: '12px', padding: '1.25rem' }}>
      <p style={{ fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-dim)', marginBottom: '0.6rem' }}>
        Watchdog Settings
      </p>
      <p style={{ fontSize: '0.82rem', color: 'var(--text)' }}>
        Check interval, idle checks, and the min-packets activity threshold are configured in the{' '}
        <strong>General</strong> section below (&ldquo;Watchdog tuning&rdquo;) and take effect on the
        next apply from the Infrastructure page.
      </p>
    </div>
  );
}
