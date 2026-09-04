/**
 * Flat edit form for an already-declared `game_servers` entry — reuses the
 * add wizard's step components (`../add-game-wizard/`), all rendered stacked
 * instead of walked one at a time.
 *
 * The `name` field is read-only: renaming a declared game is a
 * delete+recreate, not an update, so it's out of scope for this form.
 * Submits via `api.updateGame`, and the draft is validated against every
 * *other* declared game — the entry being edited is excluded from the
 * collision list by name, mirroring `checkPortCollisions`'s own
 * self-exclusion in `@hyveon/shared/gameServerValidator`.
 */

import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, Loader2 } from 'lucide-react';
import type { GameServerValidationIssue } from '@hyveon/shared/gameServerValidator';
import { Button } from '@/components/ui/button.component';
import { SectionCard } from '@/components/section-card.component';
import { api, type GameWriteSuccess, type RedactedGameServer, type UpdateGamePayload } from '../../api.service.js';
import { IdentityStep } from '../add-game-wizard/identity-step.component.js';
import { ResourcesStep } from '../add-game-wizard/resources-step.component.js';
import { NetworkingStep } from '../add-game-wizard/networking-step.component.js';
import { StorageStep } from '../add-game-wizard/storage-step.component.js';
import { EnvironmentStep } from '../add-game-wizard/environment-step.component.js';
import { draftFromGameServer, draftToPayload, validateStep, type WizardDraft } from '../add-game-wizard/wizard-form.utils.js';

/** Props for {@link EditGameForm}. */
export interface EditGameFormProps {
  /** The declared game to prefill the form from. */
  game: RedactedGameServer;
  /** Called with the successful write result once `api.updateGame` resolves `ok: true`. */
  onSaved?: (result: GameWriteSuccess) => void;
}

/**
 * Self-contained "Edit game" form: prefills a {@link WizardDraft} from
 * `game`, renders every wizard step flattened in one view (name read-only),
 * and owns its own `games.update` submit handler. See the module doc above
 * for the full submit-result contract.
 */
export function EditGameForm({ game, onSaved }: EditGameFormProps) {
  const [draft, setDraft] = useState<WizardDraft>(() => draftFromGameServer(game));
  const [existingGames, setExistingGames] = useState<RedactedGameServer[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [serverIssues, setServerIssues] = useState<GameServerValidationIssue[] | null>(null);

  // Guards stale post-await setState; re-armed at mount so StrictMode's discarded first mount doesn't leave this false forever.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Refreshes the list of every other declared game (used for the
  // cross-game port-collision check) on mount, mirroring the add wizard's
  // own `api.games()` effect. The entry being edited is excluded by name so
  // it never collides with its own, unchanged ports.
  useEffect(() => {
    let cancelled = false;
    api
      .games()
      .then(({ games }) => {
        if (cancelled || !mountedRef.current) return;
        setExistingGames(
          games.flatMap((entry) => (entry.config && entry.config.name !== game.name ? [entry.config] : [])),
        );
      })
      .catch(() => {
        if (!cancelled && mountedRef.current) setExistingGames([]);
      });
    return () => {
      cancelled = true;
    };
  }, [game.name]);

  /**
   * Applies a partial patch to the draft. Any stale server-reported error
   * state is cleared, since the operator is actively fixing the draft that
   * produced it.
   */
  function patchDraft(patch: Partial<WizardDraft>) {
    setServerIssues(null);
    setSubmitError(null);
    setDraft((prev) => ({ ...prev, ...patch }));
  }

  /**
   * Applies a partial patch to just the `healthCheck` sub-object, merging
   * against the latest state via `setDraft`'s functional updater rather than
   * the render-scoped `draft.healthCheck` — two patches dispatched in the
   * same React batch (e.g. from a caller that fires more than one in one
   * handler) would otherwise merge both against the same pre-update
   * snapshot, and the second `setDraft` call would silently discard the
   * first's change.
   */
  function patchHealthCheck(patch: Partial<WizardDraft['healthCheck']>) {
    setServerIssues(null);
    setSubmitError(null);
    setDraft((prev) => ({ ...prev, healthCheck: { ...prev.healthCheck, ...patch } }));
  }

  // 'edit' mode: this form's `name` field is read-only (`IdentityStep`'s
  // `nameDisabled` prop below), so re-running create-time name validation
  // against the unchanged, already-declared name would incorrectly reject a
  // legacy name that predates the current DNS-safe pattern.
  const liveIssues = validateStep('review', draft, existingGames, 'edit');
  const issues = serverIssues ?? liveIssues;
  const saveDisabled = issues.length > 0 || submitting;

  /**
   * Submits the draft via `api.updateGame` and routes every
   * {@link GameWriteResult} branch to the right UI reaction — see the module
   * doc for the full contract. On any failure branch the draft is left
   * untouched so the operator doesn't lose their edits.
   */
  async function handleSave() {
    setSubmitting(true);
    setSubmitError(null);
    setServerIssues(null);

    try {
      const { config } = draftToPayload(draft);
      const payload: UpdateGamePayload = { name: game.name, config };
      const result = await api.updateGame(payload);

      if (!mountedRef.current) return;

      if (result.ok) {
        onSaved?.(result);
        return;
      }

      switch (result.code) {
        case 'validation':
          setServerIssues(result.issues);
          break;
        case 'conflict':
        case 'not_found':
        case 'setup_incomplete':
        case 'error':
          setSubmitError(result.message);
          break;
      }
    } catch (err) {
      if (!mountedRef.current) return;
      setSubmitError(err instanceof Error ? err.message : 'Failed to update game.');
    } finally {
      if (mountedRef.current) setSubmitting(false);
    }
  }

  return (
    <div className="space-y-4">
      <SectionCard title="Identity">
        <IdentityStep draft={draft} issues={issues} onChange={patchDraft} nameDisabled />
      </SectionCard>

      <SectionCard title="Resources">
        <ResourcesStep cpu={draft.cpu} memory={draft.memory} issues={issues} onChange={patchDraft} />
      </SectionCard>

      <SectionCard title="Networking">
        <NetworkingStep
          ports={draft.ports}
          issues={issues}
          onChange={(ports) => patchDraft({ ports })}
          https={draft.https}
          onHttpsChange={(https) => patchDraft({ https })}
          healthCheck={draft.healthCheck}
          onHealthCheckChange={patchHealthCheck}
        />
      </SectionCard>

      <SectionCard title="Storage">
        <StorageStep draft={draft} issues={issues} onChange={patchDraft} />
      </SectionCard>

      <SectionCard title="Environment">
        <EnvironmentStep draft={draft} issues={issues} onChange={patchDraft} />
      </SectionCard>

      {submitError && (
        <div
          role="alert"
          className="flex items-center gap-2 rounded-[var(--radius-sm)] border border-[var(--color-red)] bg-[var(--color-red)]/10 px-3 py-2 text-sm text-[var(--color-red)]"
        >
          <AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
          {submitError}
        </div>
      )}

      <p className="text-xs text-[var(--color-muted-foreground)]">
        Saving only updates <code>deployment-config.json</code> — visit{' '}
        <Link to="/iac" className="underline underline-offset-2">
          Infrastructure
        </Link>{' '}
        to apply this change to the live server.
      </p>

      <Button type="button" onClick={() => void handleSave()} disabled={saveDisabled}>
        {submitting && <Loader2 className="animate-spin" />}
        Save changes
      </Button>
    </div>
  );
}
