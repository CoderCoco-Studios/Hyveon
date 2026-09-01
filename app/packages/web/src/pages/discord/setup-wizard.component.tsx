import { CheckCircle2, ExternalLink, Sparkles } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card.component';
import type { DiscordConfigRedacted } from '../../api.service.js';

/**
 * Setup wizard shown when no guilds are allowlisted. Walks the operator through
 * Discord developer-portal steps with live green checks as each precondition
 * is satisfied (credentials saved, URL copied, guild added).
 */
export function SetupWizard({ cfg }: { cfg: DiscordConfigRedacted }) {
  const steps: { label: React.ReactNode; done: boolean }[] = [
    {
      label: (
        <>
          Create an application at{' '}
          <a
            href="https://discord.com/developers/applications"
            target="_blank"
            rel="noreferrer"
            className="text-[var(--color-primary-light)] underline-offset-4 hover:underline inline-flex items-center gap-1"
          >
            discord.com/developers/applications
            <ExternalLink className="size-3" />
          </a>
          , add a Bot, and copy the Application ID, Bot Token, and Public Key.
        </>
      ),
      done: !!cfg.clientId,
    },
    {
      label: (
        <>
          Paste those values into the <strong>Credentials</strong> tab below and save. The tokens
          are stored in AWS Secrets Manager — they&apos;re never echoed back.
        </>
      ),
      done: cfg.botTokenSet && cfg.publicKeySet,
    },
    {
      label: (
        <>
          Copy the <strong>Interactions Endpoint URL</strong> from the Credentials tab into the
          same Discord developer portal page.
        </>
      ),
      done: !!cfg.interactionsEndpointUrl,
    },
    {
      label: (
        <>
          Add your server (guild) ID under <strong>Guilds</strong>, then click{' '}
          <em>Register commands</em> on that row.
        </>
      ),
      done: cfg.allowedGuilds.length > 0,
    },
  ];

  return (
    <Card className="border-[var(--color-primary)]/30 bg-gradient-to-br from-[var(--color-primary)]/5 to-transparent">
      <CardHeader>
        <div className="flex items-center gap-2">
          <Sparkles className="size-5 text-[var(--color-primary-light)]" />
          <CardTitle>Get started</CardTitle>
        </div>
        <CardDescription>
          The bot isn&apos;t configured yet. Follow these steps to wire it up.
        </CardDescription>
      </CardHeader>
      <CardContent className="pb-6">
        <ol className="divide-y divide-[var(--color-border)]">
          {steps.map((step, i) => (
            <li key={i} className="flex items-start gap-3 text-sm py-3 first:pt-0 last:pb-0">
              {step.done ? (
                <CheckCircle2 className="size-4 mt-0.5 shrink-0 text-[var(--color-green)]" />
              ) : (
                <span className="size-4 mt-0.5 shrink-0 rounded-full border border-[var(--color-border)] flex items-center justify-center text-[10px] text-[var(--color-muted-foreground)] leading-none">
                  {i + 1}
                </span>
              )}
              <span className={step.done ? 'text-[var(--color-muted-foreground)] line-through' : 'text-[var(--color-foreground)]'}>
                {step.label}
              </span>
            </li>
          ))}
        </ol>
        <p className="text-xs text-[var(--color-muted-foreground)] border-t border-[var(--color-border)] mt-4 pt-4">
          Full walkthrough:{' '}
          <a
            href="https://codercoco.github.io/Hyveon/setup"
            target="_blank"
            rel="noreferrer"
            className="text-[var(--color-primary-light)] underline-offset-4 hover:underline"
          >
            docs/docs/setup.md
          </a>
          .
        </p>
      </CardContent>
    </Card>
  );
}
