/**
 * Deployment-settings editor for the Settings page's "General" section
 * (task 9.7, `migrate-iac-to-pulumi`). Reads and writes every top-level
 * `DeploymentConfig` field EXCEPT `gameServers` — region, hosted zone, DNS
 * TTL, watchdog tuning, Discord admin allowlists, Discord application ID,
 * and the audit/runs table name overrides. `gameServers` keeps its own
 * dedicated add-game-wizard/edit-game-form flow and is never reachable from
 * this component.
 *
 * Mirrors `EditGameForm`'s (`edit-game-form.component.tsx`) established
 * shape rather than inventing a new one:
 *  - A draft is loaded from the server on mount, edited locally, and
 *    submitted as a single patch.
 *  - Client-side validation runs live against the shared
 *    `validateDeploymentSettingsPatch` (`@hyveon/shared`) — the SAME
 *    function `IacSettingsController.update` runs server-side, so the two
 *    can never phrase a rule differently (mirrors `wizard-form.utils.ts`'s
 *    `validateWizardDraft` delegating to the shared `validateGameServer`).
 *  - A `code: 'validation'` server rejection re-renders the same fields with
 *    the server-reported issues instead of a generic failure banner.
 *
 * ## Optimistic locking
 *
 * Unlike the game-server CRUD flow (where `expectedVersionId` is an
 * opt-in caller convenience), this form ALWAYS sends the etag it last read
 * as `expectedVersionId` — task 9.7's brief calls this out explicitly:
 * silently clobbering a concurrent edit is exactly what optimistic locking
 * exists to prevent for a live settings form. A `code: 'conflict'` result
 * surfaces a "this setting was changed elsewhere since you loaded this page
 * — reload and try again" message and does NOT silently retry or overwrite
 * — mirroring how `EditGameForm`'s `handleSave` routes every
 * `GameWriteResult` failure branch to an inline, non-destructive UI
 * reaction rather than a silent retry.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, Loader2, X } from 'lucide-react';
import { toast } from 'sonner';
import {
  DEPLOYMENT_CONFIG_DEFAULTS,
  validateDeploymentSettingsPatch,
  type DeploymentSettingsGetResult,
  type DeploymentSettingsValidationIssue,
  type TopLevelDeploymentSettings,
} from '@hyveon/shared';
import { Button } from './ui/button.component.js';
import { Badge } from './ui/badge.component.js';
import { Input } from './ui/input.component.js';
import { Label } from './ui/label.component.js';

/**
 * Draft form of {@link TopLevelDeploymentSettings}: every field held as a
 * raw string (scalars) or `string[]` (the three Discord ID lists) so an
 * in-progress or cleared field can be represented and re-parsed on submit —
 * mirrors `WatchdogPanel`'s own raw-string draft convention
 * (`watchdog-panel.component.tsx`).
 */
interface SettingsDraft {
  projectName: string;
  awsRegion: string;
  vpcCidr: string;
  hostedZoneName: string;
  dnsTtl: string;
  watchdogIntervalMinutes: string;
  watchdogIdleChecks: string;
  watchdogMinPackets: string;
  baseAllowedGuilds: string[];
  baseAdminUserIds: string[];
  baseAdminRoleIds: string[];
  discordApplicationId: string;
  auditTableName: string;
  runsTableName: string;
}

/**
 * Builds a {@link SettingsDraft} from the server-loaded settings — the
 * inverse of {@link draftToPatch}.
 *
 * Every field falls back to `DEPLOYMENT_CONFIG_DEFAULTS` (or `[]` for the
 * three array fields, `''` for `hostedZoneName`, which has no default) when
 * absent — defense in depth on top of `TfvarsService.getTopLevelSettings()`
 * already running the parsed document through `withDeploymentConfigDefaults`
 * server-side (task 9.7 review round 1, finding I2): `window.hyveon.iac.settings.get()`'s
 * declared return type is exactly that, a TYPE, not a
 * runtime guarantee — a stale preload build, an intercepted/mocked IPC
 * response in a test, or a future regression in the server-side defaulting
 * could all still hand this function an incomplete object. Without this,
 * `SnowflakeListField`'s `value.map(...)` below would throw on an `undefined`
 * array field and white-screen the whole `/settings` route, and the numeric
 * fields would render the literal string `"undefined"` via a bare
 * `String(undefined)`.
 */
function draftFromSettings(settings: TopLevelDeploymentSettings): SettingsDraft {
  return {
    projectName: settings.projectName ?? DEPLOYMENT_CONFIG_DEFAULTS.projectName,
    awsRegion: settings.awsRegion ?? DEPLOYMENT_CONFIG_DEFAULTS.awsRegion,
    vpcCidr: settings.vpcCidr ?? DEPLOYMENT_CONFIG_DEFAULTS.vpcCidr,
    // hostedZoneName has no default in DEPLOYMENT_CONFIG_DEFAULTS (required in
    // every real deployment) — an absent value falls back to '', which the form's own
    // "must not be empty" validation then correctly flags rather than this
    // function inventing a fake placeholder domain.
    hostedZoneName: settings.hostedZoneName ?? '',
    dnsTtl: String(settings.dnsTtl ?? DEPLOYMENT_CONFIG_DEFAULTS.dnsTtl),
    watchdogIntervalMinutes: String(
      settings.watchdogIntervalMinutes ?? DEPLOYMENT_CONFIG_DEFAULTS.watchdogIntervalMinutes,
    ),
    watchdogIdleChecks: String(settings.watchdogIdleChecks ?? DEPLOYMENT_CONFIG_DEFAULTS.watchdogIdleChecks),
    watchdogMinPackets: String(settings.watchdogMinPackets ?? DEPLOYMENT_CONFIG_DEFAULTS.watchdogMinPackets),
    baseAllowedGuilds: settings.baseAllowedGuilds ?? [],
    baseAdminUserIds: settings.baseAdminUserIds ?? [],
    baseAdminRoleIds: settings.baseAdminRoleIds ?? [],
    discordApplicationId: settings.discordApplicationId ?? DEPLOYMENT_CONFIG_DEFAULTS.discordApplicationId,
    auditTableName: settings.auditTableName ?? DEPLOYMENT_CONFIG_DEFAULTS.auditTableName,
    runsTableName: settings.runsTableName ?? DEPLOYMENT_CONFIG_DEFAULTS.runsTableName,
  };
}

/**
 * Converts a {@link SettingsDraft} into the `Partial<TopLevelDeploymentSettings>`
 * patch submitted to `iac.settings.update` — the inverse of
 * {@link draftFromSettings}. Numeric fields parse via `Number(...)`;
 * non-numeric or blank input parses to `NaN`/`0`, which
 * {@link validateDeploymentSettingsPatch}'s positive-integer check then
 * rejects as a normal field issue rather than this function silently
 * coercing it. `auditTableName`/`runsTableName` are submitted as-is
 * (including empty) — see the module doc's "empty-string-means-
 * computed-default" handling.
 */
function draftToPatch(draft: SettingsDraft): Partial<TopLevelDeploymentSettings> {
  return {
    projectName: draft.projectName.trim(),
    awsRegion: draft.awsRegion.trim(),
    vpcCidr: draft.vpcCidr.trim(),
    hostedZoneName: draft.hostedZoneName.trim(),
    dnsTtl: Number(draft.dnsTtl),
    watchdogIntervalMinutes: Number(draft.watchdogIntervalMinutes),
    watchdogIdleChecks: Number(draft.watchdogIdleChecks),
    watchdogMinPackets: Number(draft.watchdogMinPackets),
    baseAllowedGuilds: draft.baseAllowedGuilds,
    baseAdminUserIds: draft.baseAdminUserIds,
    baseAdminRoleIds: draft.baseAdminRoleIds,
    discordApplicationId: draft.discordApplicationId.trim(),
    auditTableName: draft.auditTableName.trim(),
    runsTableName: draft.runsTableName.trim(),
  };
}

/** Every issue in `issues` whose `path` is exactly `field` or a `field[N]` array-index entry, mapped to just its message. */
function messagesForField(issues: DeploymentSettingsValidationIssue[], field: string): string[] {
  return issues.filter((issue) => issue.path === field || issue.path.startsWith(`${field}[`)).map((issue) => issue.message);
}

type LoadState = 'loading' | 'loaded' | 'setup_incomplete' | 'error';

/**
 * Whether `window.hyveon.iac.settings` is reachable. Guards every access to
 * that namespace (lazy initial state, the mount effect, and {@link reload})
 * with the SAME check, since `window.hyveon` itself can exist without
 * `.iac.settings` on it — e.g. the chromium Playwright tier's
 * `installHyveonHttpBridge()` shim (`e2e/fixtures/hyveon-http-bridge.ts`)
 * installs `window.hyveon` with no `iac` namespace at all. Checking only
 * `!window.hyveon` and then unconditionally accessing
 * `window.hyveon.iac.settings.get()` would throw synchronously on that
 * namespace-less stub.
 */
function hasSettingsBridge(): boolean {
  return !!window.hyveon?.iac?.settings;
}

/** Self-contained deployment-settings form — see the module doc for the full contract. */
export function DeploymentSettingsForm() {
  const [settings, setSettings] = useState<TopLevelDeploymentSettings | null>(null);
  const [etag, setEtag] = useState<string | undefined>(undefined);
  const [draft, setDraft] = useState<SettingsDraft | null>(null);
  // The "no bridge" case is settled synchronously via the lazy initial
  // value, rather than a `setLoadState('error')` call inside the mount
  // effect below — this avoids both a throwaway render and the
  // `react-hooks/set-state-in-effect` violation that a synchronous setState
  // call from inside an effect body triggers (mirrors `useWizardCompleted`'s
  // identical `useState(() => ...)` pattern in `app.component.tsx`).
  const [loadState, setLoadState] = useState<LoadState>(() => (hasSettingsBridge() ? 'loading' : 'error'));
  const [loadMessage, setLoadMessage] = useState<string | null>(() =>
    hasSettingsBridge() ? null : 'IPC bridge (window.hyveon) is not available in this context.',
  );
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [conflictMessage, setConflictMessage] = useState<string | null>(null);
  const [serverIssues, setServerIssues] = useState<DeploymentSettingsValidationIssue[] | null>(null);

  // Guards against setting state from a stale `iac.settings.get`/`.update()`
  // response after this form has unmounted (e.g. the operator navigated
  // away mid-request) — mirrors `EditGameForm`'s own `mountedRef`.
  const mountedRef = useRef(true);
  useEffect(
    () => () => {
      mountedRef.current = false;
    },
    [],
  );

  /**
   * Applies a fetched `iac.settings.get()` result to state. Called only from
   * a promise `.then()` callback (the mount effect below, and
   * {@link reload}'s own fetch) — never synchronously from inside an effect
   * body itself, which is what keeps this clear of
   * `react-hooks/set-state-in-effect`.
   */
  const applyGetResult = useCallback((result: DeploymentSettingsGetResult) => {
    if (!mountedRef.current) return;
    if (result.ok) {
      setSettings(result.settings);
      setEtag(result.etag);
      setDraft(draftFromSettings(result.settings));
      setLoadState('loaded');
      setConflictMessage(null);
      setServerIssues(null);
      setSubmitError(null);
    } else {
      setLoadState(result.code === 'setup_incomplete' ? 'setup_incomplete' : 'error');
      setLoadMessage(result.message);
    }
  }, []);

  /** Applies a rejected `iac.settings.get()` promise to state — the `.catch()` counterpart to {@link applyGetResult}. */
  const applyGetError = useCallback((err: unknown) => {
    if (!mountedRef.current) return;
    setLoadState('error');
    setLoadMessage(err instanceof Error ? err.message : 'Failed to load deployment settings.');
  }, []);

  // Initial load. No synchronous setState in the effect body itself — only
  // inside the `.then()`/`.catch()` callbacks below, which run as a later
  // microtask once the promise settles, not as part of the effect's own
  // synchronous execution.
  useEffect(() => {
    if (!hasSettingsBridge()) return;
    let cancelled = false;
    window.hyveon!.iac.settings
      .get()
      .then((result) => {
        if (!cancelled) applyGetResult(result);
      })
      .catch((err: unknown) => {
        if (!cancelled) applyGetError(err);
      });
    return () => {
      cancelled = true;
    };
  }, [applyGetResult, applyGetError]);

  /**
   * Re-fetches settings for the "Retry"/"Reload" actions. Setting
   * `loadState` to `'loading'` synchronously here is safe — this function is
   * only ever invoked from a `<Button onClick>` handler, never from inside
   * an effect body, so it isn't subject to `react-hooks/set-state-in-effect`.
   */
  function reload() {
    if (!hasSettingsBridge()) {
      setLoadState('error');
      setLoadMessage('IPC bridge (window.hyveon) is not available in this context.');
      return;
    }
    setLoadState('loading');
    window.hyveon!.iac.settings.get().then(applyGetResult).catch(applyGetError);
  }

  /** Applies a partial patch to the draft, clearing any stale server-reported error state since the operator is actively editing. */
  function patchDraft(patch: Partial<SettingsDraft>) {
    setServerIssues(null);
    setSubmitError(null);
    setConflictMessage(null);
    setDraft((prev) => (prev ? { ...prev, ...patch } : prev));
  }

  const liveIssues = draft ? validateDeploymentSettingsPatch(draftToPatch(draft)) : [];
  const issues = serverIssues ?? liveIssues;
  const saveDisabled = !draft || issues.length > 0 || submitting;

  /**
   * Submits the draft via `iac.settings.update`, always forwarding `etag`
   * (the last-read version) as `expectedVersionId` — see the module doc's
   * "Optimistic locking" section for why this is unconditional rather than
   * opt-in. Routes every `DeploymentSettingsWriteResult` branch to its own
   * UI reaction; on any failure branch the draft is left untouched so the
   * operator doesn't lose their edits.
   *
   * Refuses to save outright when `etag` is falsy (review round 1, M1):
   * `TfvarsService.putRawConfig()` omits the conditional-put `ifMatch` guard
   * entirely when `expectedVersionId` is falsy, turning the write into a
   * SILENT unconditional overwrite — exactly what "optimistic locking is
   * mandatory for this form" (the module doc's own words) exists to
   * prevent. In practice `iac.settings.get()` always returns an etag (every
   * `RemoteFileStore` implementation sets one on `get()`), so this path is
   * defensive rather than expected to fire — but degrading to an
   * unconditional write silently would be worse than refusing loudly.
   */
  async function handleSave() {
    if (!draft || !hasSettingsBridge()) return;
    if (!etag) {
      setSubmitError(
        'No version tag for the current settings — reload the page before saving, so a concurrent edit cannot be silently overwritten.',
      );
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    setServerIssues(null);
    setConflictMessage(null);

    try {
      const patch = draftToPatch(draft);
      const result = await window.hyveon!.iac.settings.update({ patch, expectedVersionId: etag });
      if (!mountedRef.current) return;

      if (result.ok) {
        setSettings(result.settings);
        setEtag(result.etag);
        setDraft(draftFromSettings(result.settings));
        toast.success('Deployment settings saved');
        return;
      }

      switch (result.code) {
        case 'validation':
          setServerIssues(result.issues);
          break;
        case 'conflict':
          setConflictMessage(
            'This setting was changed elsewhere since you loaded this page — reload and try again.',
          );
          break;
        case 'setup_incomplete':
        case 'error':
          setSubmitError(result.message);
          break;
      }
    } catch (err) {
      if (!mountedRef.current) return;
      setSubmitError(err instanceof Error ? err.message : 'Failed to save deployment settings.');
    } finally {
      if (mountedRef.current) setSubmitting(false);
    }
  }

  if (loadState === 'loading') {
    return <p className="text-sm text-muted-foreground">Loading deployment settings…</p>;
  }

  if (loadState === 'setup_incomplete') {
    return (
      <p className="text-sm text-muted-foreground">
        {loadMessage ?? 'Finish the First-Run Wizard before editing deployment settings.'}
      </p>
    );
  }

  if (loadState === 'error' || !settings || !draft) {
    return (
      <div className="space-y-2">
        <div
          role="alert"
          className="flex items-center gap-2 rounded-[var(--radius-sm)] border border-[var(--color-red)] bg-[var(--color-red)]/10 px-3 py-2 text-sm text-[var(--color-red)]"
        >
          <AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
          {loadMessage ?? 'Failed to load deployment settings.'}
        </div>
        <Button type="button" variant="outline" size="sm" onClick={reload}>
          Retry
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {conflictMessage && (
        <div
          role="alert"
          className="flex items-center justify-between gap-3 rounded-[var(--radius-sm)] border border-[var(--color-red)] bg-[var(--color-red)]/10 px-3 py-2 text-sm text-[var(--color-red)]"
        >
          <span className="flex items-center gap-2">
            <AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
            {conflictMessage}
          </span>
          <Button type="button" variant="outline" size="sm" onClick={reload}>
            Reload
          </Button>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <TextField
          id="settings-project-name"
          label="Project name"
          value={draft.projectName}
          onChange={(v) => patchDraft({ projectName: v })}
          issues={messagesForField(issues, 'projectName')}
        />
        <TextField
          id="settings-aws-region"
          label="AWS region"
          value={draft.awsRegion}
          onChange={(v) => patchDraft({ awsRegion: v })}
          issues={messagesForField(issues, 'awsRegion')}
        />
        <TextField
          id="settings-vpc-cidr"
          label="VPC CIDR"
          value={draft.vpcCidr}
          onChange={(v) => patchDraft({ vpcCidr: v })}
          issues={messagesForField(issues, 'vpcCidr')}
          placeholder="10.0.0.0/16"
        />
        <TextField
          id="settings-hosted-zone-name"
          label="Hosted zone name"
          value={draft.hostedZoneName}
          onChange={(v) => patchDraft({ hostedZoneName: v })}
          issues={messagesForField(issues, 'hostedZoneName')}
          placeholder="example.com"
        />
        <TextField
          id="settings-dns-ttl"
          label="DNS TTL (seconds)"
          value={draft.dnsTtl}
          onChange={(v) => patchDraft({ dnsTtl: v })}
          issues={messagesForField(issues, 'dnsTtl')}
          type="number"
        />
        <TextField
          id="settings-discord-application-id"
          label="Discord application ID"
          value={draft.discordApplicationId}
          onChange={(v) => patchDraft({ discordApplicationId: v })}
          issues={messagesForField(issues, 'discordApplicationId')}
          placeholder="Optional — set here or via the Discord Credentials tab"
        />
      </div>

      <div className="space-y-1">
        <h4 className="text-sm font-medium">Watchdog tuning</h4>
        <p className="text-xs text-[var(--color-muted-foreground)]">
          Baked into the watchdog Lambda at deploy time — a change here only takes effect after
          the next apply. Day-to-day tuning of the in-app-only behaviour lives in the Watchdog
          Configuration section above.
        </p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <TextField
          id="settings-watchdog-interval"
          label="Check interval (minutes)"
          value={draft.watchdogIntervalMinutes}
          onChange={(v) => patchDraft({ watchdogIntervalMinutes: v })}
          issues={messagesForField(issues, 'watchdogIntervalMinutes')}
          type="number"
        />
        <TextField
          id="settings-watchdog-idle-checks"
          label="Idle checks before shutdown"
          value={draft.watchdogIdleChecks}
          onChange={(v) => patchDraft({ watchdogIdleChecks: v })}
          issues={messagesForField(issues, 'watchdogIdleChecks')}
          type="number"
        />
        <TextField
          id="settings-watchdog-min-packets"
          label="Min packets (activity threshold)"
          value={draft.watchdogMinPackets}
          onChange={(v) => patchDraft({ watchdogMinPackets: v })}
          issues={messagesForField(issues, 'watchdogMinPackets')}
          type="number"
        />
      </div>

      <div className="space-y-1">
        <h4 className="text-sm font-medium">Discord admin allowlists</h4>
        <p className="text-xs text-[var(--color-muted-foreground)]">
          Permanent, Pulumi-applied floor written to the <code>BASE#discord</code> row
          on every deploy — the operator can only add to or remove from what they themselves
          added here, not the app-managed allowlist under the Discord page.
        </p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <SnowflakeListField
          id="settings-base-allowed-guilds"
          label="Base allowed guild IDs"
          value={draft.baseAllowedGuilds}
          onChange={(next) => patchDraft({ baseAllowedGuilds: next })}
          issues={messagesForField(issues, 'baseAllowedGuilds')}
        />
        <SnowflakeListField
          id="settings-base-admin-user-ids"
          label="Base admin user IDs"
          value={draft.baseAdminUserIds}
          onChange={(next) => patchDraft({ baseAdminUserIds: next })}
          issues={messagesForField(issues, 'baseAdminUserIds')}
        />
        <SnowflakeListField
          id="settings-base-admin-role-ids"
          label="Base admin role IDs"
          value={draft.baseAdminRoleIds}
          onChange={(next) => patchDraft({ baseAdminRoleIds: next })}
          issues={messagesForField(issues, 'baseAdminRoleIds')}
        />
      </div>

      <div className="space-y-1">
        <h4 className="text-sm font-medium">Advanced table naming</h4>
        <p className="text-xs text-[var(--color-muted-foreground)]">
          Leave blank to use the computed default derived from the project name.
        </p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <TextField
          id="settings-audit-table-name"
          label="Audit table name"
          value={draft.auditTableName}
          onChange={(v) => patchDraft({ auditTableName: v })}
          issues={messagesForField(issues, 'auditTableName')}
          placeholder={`auto (${draft.projectName || 'hyveon'}-audit)`}
        />
        <TextField
          id="settings-runs-table-name"
          label="Runs table name"
          value={draft.runsTableName}
          onChange={(v) => patchDraft({ runsTableName: v })}
          issues={messagesForField(issues, 'runsTableName')}
          placeholder={`auto (${draft.projectName || 'hyveon'}-runs)`}
        />
      </div>

      {submitError && (
        <div
          role="alert"
          className="flex items-center gap-2 rounded-[var(--radius-sm)] border border-[var(--color-red)] bg-[var(--color-red)]/10 px-3 py-2 text-sm text-[var(--color-red)]"
        >
          <AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
          {submitError}
        </div>
      )}

      <div className="flex justify-end">
        <Button type="button" onClick={() => void handleSave()} disabled={saveDisabled}>
          {submitting && <Loader2 className="size-4 animate-spin" />}
          Save settings
        </Button>
      </div>
    </div>
  );
}

/** Labeled text/number input with per-field validation-issue messages beneath it. */
function TextField({
  id,
  label,
  value,
  onChange,
  issues,
  placeholder,
  type = 'text',
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  issues: string[];
  placeholder?: string;
  type?: 'text' | 'number';
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-invalid={issues.length > 0}
      />
      {issues.map((message, index) => (
        <p key={index} role="alert" className="text-xs text-[var(--color-red)] flex items-center gap-1">
          <AlertTriangle className="size-3.5 shrink-0" aria-hidden="true" />
          {message}
        </p>
      ))}
    </div>
  );
}

/**
 * Chip-style editor for a Discord snowflake ID list — a smaller,
 * form-local counterpart to `discord.page.tsx`'s `SnowflakeChipsInput`
 * (not reused directly: that component is private to the Discord page and
 * out of scope for task 9.7 to refactor into a shared export). Tokens
 * commit on Enter, comma, or blur; Backspace on an empty draft removes the
 * last chip.
 */
function SnowflakeListField({
  id,
  label,
  value,
  onChange,
  issues,
}: {
  id: string;
  label: string;
  value: string[];
  onChange: (next: string[]) => void;
  issues: string[];
}) {
  const [draftValue, setDraftValue] = useState('');

  function commit() {
    const trimmed = draftValue.trim();
    if (!trimmed) return;
    onChange([...value, trimmed]);
    setDraftValue('');
  }

  function removeAt(index: number) {
    onChange(value.filter((_, i) => i !== index));
  }

  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <div className="flex flex-wrap gap-1.5 p-2 min-h-9 rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface-2)] focus-within:ring-1 focus-within:ring-[var(--color-primary)]">
        {value.map((entry, index) => (
          <Badge key={`${entry}-${index}`} variant="secondary" className="font-[var(--font-mono)] gap-1">
            {entry}
            <button
              type="button"
              onClick={() => removeAt(index)}
              aria-label={`Remove ${entry}`}
              className="hover:text-[var(--color-red)]"
            >
              <X className="size-3" />
            </button>
          </Badge>
        ))}
        <input
          id={id}
          className="flex-1 min-w-[140px] bg-transparent outline-none text-sm font-[var(--font-mono)] placeholder:text-[var(--color-muted-foreground)]"
          value={draftValue}
          onChange={(e) => setDraftValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ',') {
              e.preventDefault();
              commit();
            } else if (e.key === 'Backspace' && !draftValue && value.length > 0) {
              removeAt(value.length - 1);
            }
          }}
          onBlur={commit}
          placeholder="Paste or type an ID, then press Enter"
        />
      </div>
      {issues.map((message, index) => (
        <p key={index} role="alert" className="text-xs text-[var(--color-red)] flex items-center gap-1">
          <AlertTriangle className="size-3.5 shrink-0" aria-hidden="true" />
          {message}
        </p>
      ))}
    </div>
  );
}
