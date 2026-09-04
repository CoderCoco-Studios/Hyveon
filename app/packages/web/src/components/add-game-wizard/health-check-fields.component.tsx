/**
 * "Health check" subsection of the add-game wizard's Networking step:
 * the authoritative-health-check declaration (`scheme`/`port`/`method`/
 * `timeoutMs`/`path`/`jsonPath`/`activeWhen`) plus its optional credential,
 * extracted from `networking-step.component.tsx` since it is a
 * self-contained subtree that only reads `ports` from its parent (to
 * populate the port dropdown).
 *
 * Purely presentational, mirroring the rest of the wizard's "lift state up
 * to the draft" pattern: every edit is expressed as a partial
 * `WizardDraftHealthCheck` patch passed to `onChange`. Validation issues are
 * supplied by the caller (typically `validateNetworkingStep()`) and matched
 * back to the field they belong to by exact `healthCheck.*` path.
 */

import type { GameServerValidationIssue } from '@hyveon/shared/gameServerValidator';
import { FormField } from '@/components/ui/form-field.component';
import { Input } from '@/components/ui/input.component';
import { NativeSelect } from '@/components/ui/native-select.component';
import { messageFor, type WizardDraftHealthCheck, type WizardDraftPort } from './wizard-form.utils.js';

/** `healthCheck.scheme` options. */
const HEALTH_CHECK_SCHEME_OPTIONS = ['http', 'https'] as const;

/** `healthCheck.method` options. */
const HEALTH_CHECK_METHOD_OPTIONS = ['GET', 'POST', 'PUT', 'PATCH', 'HEAD'] as const;

/** `healthCheck.activeWhen.operator` options. */
const HEALTH_CHECK_OPERATOR_OPTIONS = ['equals', 'notEquals', 'greaterThan', 'lessThan', 'contains', 'exists'] as const;

/** `healthCheck.authType` options. */
const HEALTH_CHECK_AUTH_TYPE_OPTIONS: { value: WizardDraftHealthCheck['authType']; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'raw', label: 'Raw ARN' },
  { value: 'basic', label: 'Basic' },
  { value: 'bearer', label: 'Bearer' },
];

/** Props for {@link HealthCheckFields}. */
export interface HealthCheckFieldsProps {
  /** Current draft value of the optional `healthCheck` declaration. */
  healthCheck: WizardDraftHealthCheck;
  /** Current draft port rows, read-only — used to populate the port dropdown. */
  ports: WizardDraftPort[];
  /** Validation issues for this step, positioned via `healthCheck.*` paths. */
  issues: GameServerValidationIssue[];
  /** Called with a partial patch whenever a health-check field changes. */
  onChange: (patch: Partial<WizardDraftHealthCheck>) => void;
}

/**
 * Renders the enabled health-check's fields: scheme/port/method/timeout,
 * request path, response-matching condition, and (via
 * {@link HealthCheckAuthFields}) the optional credential.
 */
export function HealthCheckFields({ healthCheck, ports, issues, onChange }: HealthCheckFieldsProps) {
  return (
    <div className="space-y-3 rounded-[var(--radius-sm)] border border-[var(--color-border)] p-3">
      <div className="flex flex-wrap gap-3">
        <FormField id="health-check-scheme" label="Scheme" className="w-24">
          {(fieldProps) => (
            <NativeSelect
              {...fieldProps}
              value={healthCheck.scheme}
              onChange={(event) => onChange({ scheme: event.target.value })}
            >
              {HEALTH_CHECK_SCHEME_OPTIONS.map((scheme) => (
                <option key={scheme} value={scheme}>
                  {scheme}
                </option>
              ))}
            </NativeSelect>
          )}
        </FormField>

        <FormField
          id="health-check-port"
          label="Port"
          errors={messageFor(issues, 'healthCheck.port')}
          className="flex-1"
        >
          {(fieldProps) => (
            <NativeSelect
              {...fieldProps}
              value={healthCheck.port ?? ''}
              onChange={(event) => onChange({ port: event.target.value === '' ? null : Number(event.target.value) })}
            >
              <option value="">Select a declared port…</option>
              {ports
                .filter((port) => port.container !== null)
                .map((port, index) => (
                  <option key={index} value={port.container ?? ''}>
                    {port.container}/{port.protocol}
                  </option>
                ))}
            </NativeSelect>
          )}
        </FormField>

        <FormField id="health-check-method" label="Method" className="w-28">
          {(fieldProps) => (
            <NativeSelect
              {...fieldProps}
              value={healthCheck.method}
              onChange={(event) => onChange({ method: event.target.value })}
            >
              {HEALTH_CHECK_METHOD_OPTIONS.map((method) => (
                <option key={method} value={method}>
                  {method}
                </option>
              ))}
            </NativeSelect>
          )}
        </FormField>

        <FormField id="health-check-timeout" label="Timeout (ms)" className="w-32">
          {(fieldProps) => (
            <Input
              {...fieldProps}
              type="number"
              value={healthCheck.timeoutMs ?? ''}
              aria-invalid={Boolean(messageFor(issues, 'healthCheck.timeoutMs'))}
              onChange={(event) => {
                const raw = event.target.value;
                onChange({ timeoutMs: raw === '' ? null : Number(raw) });
              }}
            />
          )}
        </FormField>
      </div>

      <FormField id="health-check-path" label="Request path" errors={messageFor(issues, 'healthCheck.path')}>
        {(fieldProps) => (
          <Input
            {...fieldProps}
            value={healthCheck.path}
            placeholder="/status"
            onChange={(event) => onChange({ path: event.target.value })}
          />
        )}
      </FormField>

      <div className="flex flex-wrap items-end gap-3">
        <FormField id="health-check-json-path" label="Response JSON path" className="flex-1">
          {(fieldProps) => (
            <Input
              {...fieldProps}
              value={healthCheck.jsonPath}
              placeholder="players.online"
              onChange={(event) => onChange({ jsonPath: event.target.value })}
            />
          )}
        </FormField>

        <FormField id="health-check-operator" label="Operator" className="w-40">
          {(fieldProps) => (
            <NativeSelect
              {...fieldProps}
              value={healthCheck.operator}
              onChange={(event) => onChange({ operator: event.target.value })}
            >
              {HEALTH_CHECK_OPERATOR_OPTIONS.map((operator) => (
                <option key={operator} value={operator}>
                  {operator}
                </option>
              ))}
            </NativeSelect>
          )}
        </FormField>

        {healthCheck.operator !== 'exists' && (
          <FormField id="health-check-value" label="Comparison value" className="flex-1">
            {(fieldProps) => (
              <Input
                {...fieldProps}
                value={healthCheck.value}
                aria-invalid={Boolean(messageFor(issues, 'healthCheck.activeWhen.value'))}
                onChange={(event) => onChange({ value: event.target.value })}
              />
            )}
          </FormField>
        )}
      </div>
      {messageFor(issues, 'healthCheck.activeWhen.value') && (
        <p role="alert" className="text-xs text-[var(--color-red)]">
          {messageFor(issues, 'healthCheck.activeWhen.value')}
        </p>
      )}

      <div className="space-y-3 border-t border-[var(--color-border)] pt-3">
        <FormField id="health-check-auth-type" label="Credential type" className="w-40">
          {(fieldProps) => (
            <NativeSelect
              {...fieldProps}
              value={healthCheck.authType}
              onChange={(event) => onChange({ authType: event.target.value as WizardDraftHealthCheck['authType'] })}
            >
              {HEALTH_CHECK_AUTH_TYPE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </NativeSelect>
          )}
        </FormField>

        {healthCheck.secretSet && (
          <p className="text-xs text-[var(--color-muted-foreground)]">A credential is already set.</p>
        )}

        <HealthCheckAuthFields authType={healthCheck.authType} values={healthCheck} issues={issues} onChange={onChange} />

        <p className="text-xs text-[var(--color-muted-foreground)]">
          Injected as the request&apos;s <code>Authorization</code> header. The credential value itself never appears
          here — only whether one is configured.
        </p>
      </div>
    </div>
  );
}

/** Props for {@link HealthCheckAuthFields}. */
export interface HealthCheckAuthFieldsProps {
  /** Which credential shape to render fields for. */
  authType: WizardDraftHealthCheck['authType'];
  /** Current draft credential values and `secretSet` flag, read from the parent `healthCheck` draft. */
  values: Pick<WizardDraftHealthCheck, 'secretArn' | 'username' | 'password' | 'token' | 'secretSet'>;
  /** Validation issues for this step, positioned via `healthCheck.auth.*` paths. */
  issues: GameServerValidationIssue[];
  /** Called with a partial `healthCheck` patch whenever a credential field changes. */
  onChange: (patch: Partial<WizardDraftHealthCheck>) => void;
}

/**
 * Renders the credential fields matching `authType` — nothing for `"none"`,
 * a single ARN field for `"raw"`, username+password for `"basic"`, or a
 * token field for `"bearer"` — each with its Secrets-Manager-backed hint.
 */
function HealthCheckAuthFields({ authType, values, issues, onChange }: HealthCheckAuthFieldsProps) {
  if (authType === 'raw') {
    return (
      <div>
        <FormField
          id="health-check-secret-arn"
          label="Secrets Manager ARN"
          errors={messageFor(issues, 'healthCheck.auth.secretArn')}
        >
          {(fieldProps) => (
            <Input
              {...fieldProps}
              value={values.secretArn}
              placeholder={values.secretSet ? 'Leave blank to keep the existing credential' : 'arn:aws:secretsmanager:...'}
              onChange={(event) => onChange({ secretArn: event.target.value })}
            />
          )}
        </FormField>
        <p className="text-xs text-[var(--color-muted-foreground)]">
          You manage this secret&apos;s lifecycle yourself — the app only reads its value.
        </p>
      </div>
    );
  }

  if (authType === 'basic') {
    return (
      <div className="flex flex-wrap gap-3">
        <FormField
          id="health-check-username"
          label="Username"
          errors={messageFor(issues, 'healthCheck.auth.username')}
          className="flex-1"
        >
          {(fieldProps) => (
            <Input
              {...fieldProps}
              value={values.username}
              placeholder={values.secretSet ? 'Re-enter to change' : ''}
              onChange={(event) => onChange({ username: event.target.value })}
            />
          )}
        </FormField>
        <FormField
          id="health-check-password"
          label="Password"
          errors={messageFor(issues, 'healthCheck.auth.password')}
          className="flex-1"
        >
          {(fieldProps) => (
            <Input
              {...fieldProps}
              type="password"
              value={values.password}
              placeholder={values.secretSet ? 'Re-enter to change' : ''}
              onChange={(event) => onChange({ password: event.target.value })}
            />
          )}
        </FormField>
        <p className="w-full text-xs text-[var(--color-muted-foreground)]">
          The app stores this as a Secrets Manager secret it creates and manages for you.
        </p>
      </div>
    );
  }

  if (authType === 'bearer') {
    return (
      <div>
        <FormField id="health-check-token" label="Token" errors={messageFor(issues, 'healthCheck.auth.token')}>
          {(fieldProps) => (
            <Input
              {...fieldProps}
              type="password"
              value={values.token}
              placeholder={values.secretSet ? 'Re-enter to change' : ''}
              onChange={(event) => onChange({ token: event.target.value })}
            />
          )}
        </FormField>
        <p className="text-xs text-[var(--color-muted-foreground)]">
          The app stores this as a Secrets Manager secret it creates and manages for you.
        </p>
      </div>
    );
  }

  return null;
}
