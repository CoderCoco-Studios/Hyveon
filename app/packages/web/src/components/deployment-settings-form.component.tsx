/**
 * Deployment-settings editor for the Settings page's "General" section.
 * Field layout only — the load/save state machine (draft, validation,
 * optimistic-locked save, reload) lives in `useDeploymentSettings`
 * (`../hooks/use-deployment-settings.hook.js`); see that module's doc for
 * the full contract, including the "Optimistic locking" section.
 */

import { useState } from 'react';
import { AlertTriangle, Loader2, X } from 'lucide-react';
import type { DeploymentSettingsValidationIssue } from '@hyveon/shared';
import { Button } from './ui/button.component.js';
import { Badge } from './ui/badge.component.js';
import { FormField } from './ui/form-field.component.js';
import { Input } from './ui/input.component.js';
import { Label } from './ui/label.component.js';
import { useDeploymentSettings } from '../hooks/use-deployment-settings.hook.js';

/** Every issue in `issues` whose `path` is exactly `field` or a `field[N]` array-index entry, mapped to just its message. */
function messagesForField(issues: DeploymentSettingsValidationIssue[], field: string): string[] {
  return issues.filter((issue) => issue.path === field || issue.path.startsWith(`${field}[`)).map((issue) => issue.message);
}

/** Self-contained deployment-settings form — see the module doc for the full contract. */
export function DeploymentSettingsForm() {
  const {
    draft,
    loadState,
    loadMessage,
    issues,
    submitting,
    submitError,
    conflictMessage,
    saveDisabled,
    patchDraft,
    save,
    reload,
  } = useDeploymentSettings();

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

  if (loadState === 'error' || !draft) {
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
        <FormField id="settings-project-name" label="Project name" errors={messagesForField(issues, 'projectName')}>
          {(fieldProps) => (
            <Input {...fieldProps} value={draft.projectName} onChange={(e) => patchDraft({ projectName: e.target.value })} />
          )}
        </FormField>
        <FormField id="settings-aws-region" label="AWS region" errors={messagesForField(issues, 'awsRegion')}>
          {(fieldProps) => (
            <Input {...fieldProps} value={draft.awsRegion} onChange={(e) => patchDraft({ awsRegion: e.target.value })} />
          )}
        </FormField>
        <FormField id="settings-vpc-cidr" label="VPC CIDR" errors={messagesForField(issues, 'vpcCidr')}>
          {(fieldProps) => (
            <Input
              {...fieldProps}
              value={draft.vpcCidr}
              placeholder="10.0.0.0/16"
              onChange={(e) => patchDraft({ vpcCidr: e.target.value })}
            />
          )}
        </FormField>
        <FormField id="settings-hosted-zone-name" label="Hosted zone name" errors={messagesForField(issues, 'hostedZoneName')}>
          {(fieldProps) => (
            <Input
              {...fieldProps}
              value={draft.hostedZoneName}
              placeholder="example.com"
              onChange={(e) => patchDraft({ hostedZoneName: e.target.value })}
            />
          )}
        </FormField>
        <FormField id="settings-dns-ttl" label="DNS TTL (seconds)" errors={messagesForField(issues, 'dnsTtl')}>
          {(fieldProps) => (
            <Input
              {...fieldProps}
              type="number"
              value={draft.dnsTtl}
              onChange={(e) => patchDraft({ dnsTtl: e.target.value })}
            />
          )}
        </FormField>
        <FormField
          id="settings-discord-application-id"
          label="Discord application ID"
          errors={messagesForField(issues, 'discordApplicationId')}
        >
          {(fieldProps) => (
            <Input
              {...fieldProps}
              value={draft.discordApplicationId}
              placeholder="Optional — set here or via the Discord Credentials tab"
              onChange={(e) => patchDraft({ discordApplicationId: e.target.value })}
            />
          )}
        </FormField>
      </div>

      <div className="space-y-1">
        <h4 className="text-sm font-medium">Watchdog tuning</h4>
        <p className="text-xs text-[var(--color-muted-foreground)]">
          Baked into the watchdog Lambda at deploy time — a change here only takes effect after
          the next apply.
        </p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <FormField
          id="settings-watchdog-interval"
          label="Check interval (minutes)"
          errors={messagesForField(issues, 'watchdogIntervalMinutes')}
        >
          {(fieldProps) => (
            <Input
              {...fieldProps}
              type="number"
              value={draft.watchdogIntervalMinutes}
              onChange={(e) => patchDraft({ watchdogIntervalMinutes: e.target.value })}
            />
          )}
        </FormField>
        <FormField
          id="settings-watchdog-idle-checks"
          label="Idle checks before shutdown"
          errors={messagesForField(issues, 'watchdogIdleChecks')}
        >
          {(fieldProps) => (
            <Input
              {...fieldProps}
              type="number"
              value={draft.watchdogIdleChecks}
              onChange={(e) => patchDraft({ watchdogIdleChecks: e.target.value })}
            />
          )}
        </FormField>
        <FormField
          id="settings-watchdog-min-packets"
          label="Min packets (activity threshold)"
          errors={messagesForField(issues, 'watchdogMinPackets')}
        >
          {(fieldProps) => (
            <Input
              {...fieldProps}
              type="number"
              value={draft.watchdogMinPackets}
              onChange={(e) => patchDraft({ watchdogMinPackets: e.target.value })}
            />
          )}
        </FormField>
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
        <FormField id="settings-audit-table-name" label="Audit table name" errors={messagesForField(issues, 'auditTableName')}>
          {(fieldProps) => (
            <Input
              {...fieldProps}
              value={draft.auditTableName}
              placeholder={`auto (${draft.projectName || 'hyveon'}-audit)`}
              onChange={(e) => patchDraft({ auditTableName: e.target.value })}
            />
          )}
        </FormField>
        <FormField id="settings-runs-table-name" label="Runs table name" errors={messagesForField(issues, 'runsTableName')}>
          {(fieldProps) => (
            <Input
              {...fieldProps}
              value={draft.runsTableName}
              placeholder={`auto (${draft.projectName || 'hyveon'}-runs)`}
              onChange={(e) => patchDraft({ runsTableName: e.target.value })}
            />
          )}
        </FormField>
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
        <Button type="button" onClick={() => void save()} disabled={saveDisabled}>
          {submitting && <Loader2 className="size-4 animate-spin" />}
          Save settings
        </Button>
      </div>
    </div>
  );
}

/**
 * Chip-style editor for a Discord snowflake ID list — a smaller,
 * form-local counterpart to `discord.page.tsx`'s `SnowflakeChipsInput`
 * (not reused directly: that component is private to the Discord page).
 * Tokens commit on Enter, comma, or blur; Backspace on an empty draft
 * removes the last chip.
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
