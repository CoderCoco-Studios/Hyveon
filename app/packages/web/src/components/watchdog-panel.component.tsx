/**
 * Static pointer to `DeploymentSettingsForm`'s "Watchdog tuning" section —
 * no IPC call, no inputs, no Save button. The deployed watchdog Lambda reads
 * its tunables from `DeploymentConfig`, not `server_config.json`, so this
 * panel doesn't duplicate that editor with a second read-only fetch.
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
