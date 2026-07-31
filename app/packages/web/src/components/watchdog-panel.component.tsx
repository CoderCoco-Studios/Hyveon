import { useState, useEffect, useId } from 'react';
import { HelpCircle } from 'lucide-react';
import { toast } from 'sonner';
import { api, type WatchdogConfig } from '../api.service.js';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip.component';

/**
 * Values shown before `api.config()` resolves. They mirror the
 * `DeploymentConfig` defaults so the panel never renders a nonsensical idle
 * window.
 */
const FALLBACK_CONFIG: WatchdogConfig = {
  watchdog_interval_minutes: 15,
  watchdog_idle_checks: 4,
  watchdog_min_packets: 100,
};

/**
 * Smallest integer each field accepts. An interval or idle-check count below
 * one describes no watchdog at all, whereas a zero packet threshold is
 * meaningful — it makes every task read as busy.
 */
const FIELD_MINIMUMS: Record<keyof WatchdogConfig, number> = {
  watchdog_interval_minutes: 1,
  watchdog_idle_checks: 1,
  watchdog_min_packets: 0,
};

/** The panel's three inputs held as raw strings so a cleared field stays cleared. */
type WatchdogDraft = Record<keyof WatchdogConfig, string>;

/** Renders a loaded config as editable draft text. */
function toDraft(cfg: WatchdogConfig): WatchdogDraft {
  return {
    watchdog_interval_minutes: String(cfg.watchdog_interval_minutes),
    watchdog_idle_checks: String(cfg.watchdog_idle_checks),
    watchdog_min_packets: String(cfg.watchdog_min_packets),
  };
}

/**
 * Parses one raw field value into the integer it denotes, or an error message
 * explaining why it cannot be persisted. Blank, non-numeric, fractional and
 * below-minimum values are all rejected rather than silently coerced to `0`.
 *
 * @param raw - The field's current text.
 * @param min - Smallest accepted value, from {@link FIELD_MINIMUMS}.
 */
function parseField(raw: string, min: number): { value: number | null; error: string | null } {
  const trimmed = raw.trim();
  if (trimmed === '') return { value: null, error: 'Required' };
  if (!/^-?\d+$/.test(trimmed)) return { value: null, error: 'Whole number required' };
  const value = Number(trimmed);
  if (value < min) return { value: null, error: `Must be ${min} or greater` };
  return { value, error: null };
}

/**
 * Bottom-right dashboard panel that reads and writes the three watchdog knobs
 * via `/api/config`. Note these settings tune the in-app behaviour only — the
 * Lambda's EventBridge schedule is instead baked in at apply time, from the
 * separate `DeploymentConfig` watchdog fields in this same page's General
 * section (`DeploymentSettingsForm`).
 */
export function WatchdogPanel() {
  const [draft, setDraft] = useState<WatchdogDraft>(() => toDraft(FALLBACK_CONFIG));
  useEffect(() => {
    void api.config().then((cfg) => setDraft(toDraft(cfg)));
  }, []);

  const interval = parseField(draft.watchdog_interval_minutes, FIELD_MINIMUMS.watchdog_interval_minutes);
  const idleChecks = parseField(draft.watchdog_idle_checks, FIELD_MINIMUMS.watchdog_idle_checks);
  const minPackets = parseField(draft.watchdog_min_packets, FIELD_MINIMUMS.watchdog_min_packets);
  const isValid = interval.value !== null && idleChecks.value !== null && minPackets.value !== null;

  /** Updates one draft field, leaving the others untouched. */
  function setField(key: keyof WatchdogConfig, raw: string) {
    setDraft((d) => ({ ...d, [key]: raw }));
  }

  async function handleSave() {
    if (interval.value === null || idleChecks.value === null || minPackets.value === null) return;
    try {
      await api.saveConfig({
        watchdog_interval_minutes: interval.value,
        watchdog_idle_checks: idleChecks.value,
        watchdog_min_packets: minPackets.value,
      });
      toast.success('Watchdog settings saved');
    } catch (err) {
      toast.error('Failed to save watchdog settings', {
        description: err instanceof Error ? err.message : 'An unknown error occurred',
      });
    }
  }

  return (
    <TooltipProvider delayDuration={150}>
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: '12px', padding: '1.25rem' }}>
        <p style={{ fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-dim)', marginBottom: '1rem' }}>
          Watchdog Settings
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.6rem' }}>
          <Field
            label="Check interval (min)"
            tooltip="How often the watchdog inspects each running task. Lower = faster shutdown, higher = less CPU."
            value={draft.watchdog_interval_minutes}
            min={FIELD_MINIMUMS.watchdog_interval_minutes}
            error={interval.error}
            onChange={(v) => setField('watchdog_interval_minutes', v)}
          />
          <Field
            label="Idle checks before shutdown"
            tooltip="Number of consecutive idle checks before the task stops. With 5 min interval × 5 checks = 25 idle minutes."
            value={draft.watchdog_idle_checks}
            min={FIELD_MINIMUMS.watchdog_idle_checks}
            error={idleChecks.error}
            onChange={(v) => setField('watchdog_idle_checks', v)}
          />
          <Field
            label="Min packets (activity threshold)"
            tooltip="If a task receives fewer than this many network packets in an interval, it counts as idle."
            value={draft.watchdog_min_packets}
            min={FIELD_MINIMUMS.watchdog_min_packets}
            error={minPackets.error}
            onChange={(v) => setField('watchdog_min_packets', v)}
          />
        </div>
        <p style={{ fontSize: '0.72rem', color: 'var(--text-dim)', marginTop: '0.6rem' }}>
          {interval.value !== null && idleChecks.value !== null ? (
            <>
              Auto-shutdown after {interval.value * idleChecks.value} minutes idle ({interval.value} min × {idleChecks.value} checks).
              Update the watchdog fields in the General section below and re-apply to change the Lambda schedule.
            </>
          ) : (
            <>Fix the highlighted fields to see the idle window.</>
          )}
        </p>
        <div style={{ marginTop: '0.75rem' }}>
          <button className="btn-secondary btn-sm" onClick={() => void handleSave()} disabled={!isValid}>
            Save
          </button>
        </div>
      </div>
    </TooltipProvider>
  );
}

function Field({
  label,
  tooltip,
  value,
  min,
  error,
  onChange,
}: {
  label: string;
  tooltip: string;
  value: string;
  min: number;
  error: string | null;
  onChange: (v: string) => void;
}) {
  const id = useId();
  const errorId = `${id}-error`;
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', marginBottom: '0.2rem' }}>
        <label htmlFor={id} style={{ fontSize: '0.72rem', color: 'var(--text-dim)' }}>
          {label}
        </label>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={`${label} help`}
              style={{ display: 'inline-flex', alignItems: 'center', background: 'none', border: 'none', padding: 0, cursor: 'help', color: 'inherit' }}
            >
              <HelpCircle style={{ width: '0.7rem', height: '0.7rem', flexShrink: 0 }} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-56">
            {tooltip}
          </TooltipContent>
        </Tooltip>
      </div>
      <input
        id={id}
        type="number"
        inputMode="numeric"
        step={1}
        min={min}
        value={value}
        aria-invalid={error !== null}
        aria-describedby={error !== null ? errorId : undefined}
        onChange={(e) => onChange(e.target.value)}
        style={{ width: '100%', padding: '0.4rem 0.6rem', background: 'var(--bg)', border: `1px solid ${error !== null ? 'var(--danger, #dc2626)' : 'var(--border)'}`, borderRadius: '6px', color: 'var(--text)', fontSize: '0.82rem' }}
      />
      {error !== null && (
        <p id={errorId} role="alert" style={{ fontSize: '0.68rem', color: 'var(--danger, #dc2626)', marginTop: '0.2rem' }}>
          {error}
        </p>
      )}
    </div>
  );
}
