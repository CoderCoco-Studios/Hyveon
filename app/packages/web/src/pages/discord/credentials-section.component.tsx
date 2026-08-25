import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Eye, EyeOff, Check, AlertCircle, Copy } from 'lucide-react';
import { Button } from '@/components/ui/button.component';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card.component';
import { Input } from '@/components/ui/input.component';
import { Label } from '@/components/ui/label.component';
import type { DiscordConfigRedacted } from '../../api.service.js';
import { isSnowflake } from './snowflake.utils.js';

/**
 * Credentials editor — Application (Client) ID, Bot Token, Public Key, plus the
 * read-only Interactions Endpoint URL the operator pastes back into Discord.
 * Token and public key are write-only: leaving the field blank when one is
 * already set preserves the existing value.
 */
export function CredentialsSection({
  cfg,
  busy,
  onSave,
}: {
  cfg: DiscordConfigRedacted;
  busy: boolean;
  onSave: (body: { botToken?: string; clientId?: string; publicKey?: string }) => void;
}) {
  const [clientId, setClientId] = useState(cfg.clientId);
  const [clientIdError, setClientIdError] = useState<string | null>(null);
  const [token, setToken] = useState('');
  const [publicKey, setPublicKey] = useState('');
  const [copied, setCopied] = useState(false);
  const copiedTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clear the "Copied" reset timer on unmount so switching tabs within 1.5s of
  // a copy doesn't call setCopied on an unmounted component.
  useEffect(() => () => { if (copiedTimeoutRef.current) clearTimeout(copiedTimeoutRef.current); }, []);

  /**
   * Validate Client ID as a Discord snowflake before submit. Empty is allowed
   * so operators can save token/public-key updates without retyping the ID,
   * but a non-empty value must match the snowflake shape — `DiscordCommandRegistrar`
   * silently fails to register commands when the stored Client ID is malformed.
   */
  function handleSave() {
    const trimmed = clientId.trim();
    if (trimmed && !isSnowflake(trimmed)) {
      setClientIdError('Client ID must be a 17–20 digit Discord snowflake.');
      return;
    }
    setClientIdError(null);
    onSave({
      ...(trimmed ? { clientId: trimmed } : {}),
      ...(token ? { botToken: token } : {}),
      ...(publicKey ? { publicKey } : {}),
    });
    setToken('');
    setPublicKey('');
  }

  /** Copy the interactions URL to the clipboard with a brief "Copied" state. */
  function handleCopyUrl() {
    if (!cfg.interactionsEndpointUrl) return;
    void navigator.clipboard.writeText(cfg.interactionsEndpointUrl);
    setCopied(true);
    if (copiedTimeoutRef.current) clearTimeout(copiedTimeoutRef.current);
    copiedTimeoutRef.current = setTimeout(() => setCopied(false), 1500);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Credentials</CardTitle>
        <CardDescription>
          Stored in AWS Secrets Manager. The token and public key are never sent back to this
          page.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="space-y-2">
          <Label htmlFor="client-id">Application (Client) ID</Label>
          <Input
            id="client-id"
            value={clientId}
            onChange={(e) => {
              setClientId(e.target.value);
              if (clientIdError) setClientIdError(null);
            }}
            placeholder="000000000000000000"
            aria-invalid={clientIdError ? 'true' : 'false'}
          />
          {clientIdError && (
            <p className="text-xs text-[var(--color-red)] flex items-center gap-1">
              <AlertCircle className="size-3.5" />
              {clientIdError}
            </p>
          )}
        </div>

        <SecretField
          id="bot-token"
          label="Bot Token"
          alreadySet={cfg.botTokenSet}
          value={token}
          onChange={setToken}
        />

        <SecretField
          id="public-key"
          label="Application Public Key"
          alreadySet={cfg.publicKeySet}
          value={publicKey}
          onChange={setPublicKey}
        />

        <div className="space-y-2">
          <Label>Interactions Endpoint URL</Label>
          {cfg.interactionsEndpointUrl ? (
            <div className="flex items-center gap-2">
              <code className="flex-1 px-3 py-2 rounded-[var(--radius-sm)] bg-[var(--color-surface-2)] border border-[var(--color-border)] text-xs font-[var(--font-mono)] break-all">
                {cfg.interactionsEndpointUrl}
              </code>
              <Button variant="secondary" size="sm" onClick={handleCopyUrl}>
                {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                {copied ? 'Copied' : 'Copy'}
              </Button>
            </div>
          ) : (
            <p className="text-xs text-[var(--color-muted-foreground)]">
              Run a plan and apply from the{' '}
              <Link to="/iac" className="underline underline-offset-2">
                Infrastructure
              </Link>{' '}
              page to provision the Lambda and surface this URL.
            </p>
          )}
        </div>

        <div className="flex justify-end pt-2">
          <Button disabled={busy} onClick={handleSave}>
            Save credentials
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Password-style input with a show/hide eye toggle and a green check next to
 * the label when the secret is already configured server-side. The empty value
 * is treated as "leave existing secret untouched".
 */
function SecretField({
  id,
  label,
  alreadySet,
  value,
  onChange,
}: {
  id: string;
  label: string;
  alreadySet: boolean;
  value: string;
  onChange: (v: string) => void;
}) {
  const [reveal, setReveal] = useState(false);
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Label htmlFor={id}>{label}</Label>
        {alreadySet && (
          <span
            className="inline-flex items-center gap-1 text-xs text-[var(--color-green)]"
            aria-label="Already set"
          >
            <Check className="size-3.5" />
            set
          </span>
        )}
      </div>
      <div className="relative">
        <Input
          id={id}
          type={reveal ? 'text' : 'password'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={alreadySet ? 'Leave blank to keep existing' : 'Paste new value'}
          className="pr-9"
        />
        <button
          type="button"
          onClick={() => setReveal((r) => !r)}
          aria-label={reveal ? 'Hide value' : 'Show value'}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)] rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]"
        >
          {reveal ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
        </button>
      </div>
      {alreadySet && (
        <p className="text-xs text-[var(--color-muted-foreground)]">
          Already set — leave blank to keep.
        </p>
      )}
    </div>
  );
}
