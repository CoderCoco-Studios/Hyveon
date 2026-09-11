/**
 * Static pointer to `DeploymentSettingsForm`'s "Watchdog tuning" section —
 * no IPC call, no inputs, no Save button. The deployed watchdog Lambda reads
 * its tunables from `DeploymentConfig`, not `server_config.json`, so this
 * panel doesn't duplicate that editor with a second read-only fetch.
 */
export function WatchdogPanel() {
  return (
    <div className="rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
      <p className="mb-2 text-xs uppercase tracking-wider text-[var(--color-muted-foreground)]">
        Watchdog Settings
      </p>
      <p className="text-sm text-[var(--color-foreground)]">
        Check interval, idle checks, and the min-packets activity threshold are configured in the{' '}
        <strong>General</strong> section below (&ldquo;Watchdog tuning&rdquo;) and take effect on the
        next apply from the Infrastructure page.
      </p>
    </div>
  );
}
