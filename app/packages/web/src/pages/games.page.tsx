import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type GameListEntry, type StoredGameWizardDraft } from '../api.service.js';
import { GameStatusBadges } from '../components/game-status-badges.component.js';
import { PageHeader } from '../components/page-header.component.js';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table.component';
import { PollingIndicator } from '../polling/polling-indicator.component.js';
import { AddGameWizard } from '@/components/add-game-wizard/add-game-wizard.component';
import { PendingChangesBanner } from '../components/pending-changes-banner.component.js';
import { Button } from '@/components/ui/button.component';
import { SectionCard } from '../components/section-card.component.js';
import { AsyncContent } from '../components/async-content.component.js';

/** Renders a game's declared ports as a comma-separated `container/protocol` list, or an em dash when undeclared. */
function formatPorts(entry: GameListEntry): string {
  const ports = entry.config?.ports;
  if (!ports || ports.length === 0) return '—';
  return ports.map((p) => `${p.container}/${p.protocol}`).join(', ');
}

/**
 * Games route (`/games`) — read-only table of every game the app knows
 * about, merging the declared deployment config with the deployed
 * tfstate view (see issue #92's `games.list` IPC channel).
 *
 * Rows fall into three shapes:
 *   - declared + deployed → full config, "In sync" chip.
 *   - declared only → full config, "Pending deploy" chip (not yet applied).
 *   - deployed only ("ghost" row) → no `config`, "Undeclared" chip; config
 *     columns render as em dashes since there's no declared entry to read.
 *
 * Each row links to `/games/:name` for the deeper read-only detail view
 * (issue #93's follow-up), still to be implemented.
 *
 * The self-contained {@link AddGameWizard} (#99) is mounted twice: as a
 * persistent header action next to the heading, and as an empty-state CTA
 * shown only while `games` is empty. Both mounts are independent — each owns
 * its own dialog open/close state — so either entry point opens its own copy
 * of the same wizard flow.
 *
 * {@link PendingChangesBanner} (#101) is mounted above the games table and
 * self-manages its own visibility — it renders nothing until
 * `GET /api/drift` reports at least one pending change.
 *
 * On mount, `api.getGameDraft()` checks for an autosaved, unfinished
 * `AddGameWizard` draft (see that component's own doc comment). If one
 * exists, a "Resume / Discard" banner renders above `PendingChangesBanner`:
 * Resume mounts a second `AddGameWizard` pre-populated via its
 * `initialDraft`/`initialStepIndex` props (self-opening) with `hideTrigger`
 * set so this resumed instance never renders its own "Add game" trigger
 * button — it has no business offering a way to *re*-open itself once the
 * operator closes it, and would otherwise sit there as a stray duplicate of
 * the page's real trigger; Discard calls `api.clearGameDraft()` and hides
 * the banner without opening the wizard. While a resumed draft is open
 * (`resuming`), the page's own "Add game" trigger(s) are hidden too, so only
 * one `AddGameWizard` instance can ever be mid-edit at a time — two open
 * instances would both autosave into the single `addGameWizardDraft` slot
 * and race each other. The resumed instance's `onClose` callback flips
 * `resuming` back to `false` once its dialog closes (Escape/overlay/Cancel,
 * or a successful submit) and re-fetches `draft` via `api.getGameDraft()` —
 * the wizard's own close handler already flushed any pending edits to disk
 * by then, so re-fetching (rather than trusting the `draft` state captured
 * back on page mount) is what makes the resume/discard banner reflect the
 * just-saved content instead of a stale pre-edit snapshot if the operator
 * resumes again.
 */
export function GamesPage() {
  const [games, setGames] = useState<GameListEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<StoredGameWizardDraft | null>(null);
  const [resuming, setResuming] = useState(false);

  // Mount-only effect — `loading` starts `true` and `error` starts `null`, so
  // the previous `setLoading(true)` / `setError(null)` preamble was a no-op.
  useEffect(() => {
    let cancelled = false;
    api
      .games()
      .then(({ games: list }) => {
        if (!cancelled) setGames(list);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load games.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Mount-only effect — checks for a saved add-game wizard draft (autosaved
  // by a previous `AddGameWizard` session per issue #99's follow-up) so the
  // resume/discard banner below can offer to pick it back up.
  useEffect(() => {
    let cancelled = false;
    api
      .getGameDraft()
      .then((saved) => {
        if (!cancelled) setDraft(saved);
      })
      .catch(() => {
        if (!cancelled) setDraft(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /** Discards the saved draft and hides the banner, without opening the wizard. */
  async function handleDiscardDraft() {
    await api.clearGameDraft();
    setDraft(null);
  }

  /**
   * Called when the resumed wizard's dialog closes. Re-fetches the saved
   * draft rather than trusting the `draft` state from page mount — the
   * wizard's own close handler already flushed any pending edits to disk by
   * this point, so a stale in-memory snapshot would otherwise mislead the
   * resume/discard banner and silently discard those edits if the operator
   * resumes again.
   */
  async function handleResumedWizardClose() {
    setResuming(false);
    try {
      setDraft(await api.getGameDraft());
    } catch {
      setDraft(null);
    }
  }

  return (
    <div className="max-w-6xl mx-auto">
      <div className="mb-6">
        <PageHeader title="Games">
          <div className="flex items-center gap-4">
            <PollingIndicator />
            {/* Hidden while a resumed draft is open (`resuming`) so only one
                AddGameWizard instance can ever be mid-edit at a time — two
                open instances would both autosave into the single
                `addGameWizardDraft` slot and race each other. */}
            {!resuming && <AddGameWizard />}
          </div>
        </PageHeader>
      </div>

      {draft && !resuming && (
        <div
          role="status"
          className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-md)] border border-[var(--color-orange)]/40 bg-[var(--color-orange)]/10 px-4 py-3 text-sm text-[var(--color-orange)]"
        >
          <span>Unfinished draft: {draft.draft.name || 'untitled'}</span>
          <div className="flex items-center gap-3 shrink-0">
            <Button type="button" variant="outline" onClick={() => setResuming(true)}>
              Resume
            </Button>
            <Button type="button" variant="outline" onClick={() => void handleDiscardDraft()}>
              Discard
            </Button>
          </div>
        </div>
      )}
      {draft && resuming && (
        <AddGameWizard
          initialDraft={draft.draft}
          initialStepIndex={draft.stepIndex}
          hideTrigger
          onClose={() => void handleResumedWizardClose()}
        />
      )}

      <PendingChangesBanner />

      <SectionCard title="Declared game servers">
        <AsyncContent
          loading={loading}
          error={error}
          isEmpty={games.length === 0}
          errorMessage={`Failed to load games: ${error}`}
          emptyMessage={
            <>
              <p>No games declared or deployed yet.</p>
              {!resuming && (
                <div className="mt-4 flex justify-center">
                  <AddGameWizard />
                </div>
              )}
            </>
          }
        >
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Image</TableHead>
                <TableHead>Ports</TableHead>
                <TableHead className="text-right">CPU</TableHead>
                <TableHead className="text-right">Memory</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {games.map((entry) => (
                <TableRow key={entry.name}>
                  <TableCell className="capitalize font-medium">
                    <Link
                      to={`/games/${entry.name}`}
                      className="text-[var(--color-primary-light)] underline-offset-4 hover:underline"
                    >
                      {entry.name}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <GameStatusBadges declared={entry.declared} deployed={entry.deployed} drift={entry.drift} />
                  </TableCell>
                  <TableCell className="font-[var(--font-mono)] text-xs">
                    {entry.config?.image ?? '—'}
                  </TableCell>
                  <TableCell className="font-[var(--font-mono)] text-xs">{formatPorts(entry)}</TableCell>
                  <TableCell className="text-right font-[var(--font-mono)]">
                    {entry.config?.cpu ?? '—'}
                  </TableCell>
                  <TableCell className="text-right font-[var(--font-mono)]">
                    {entry.config?.memory ?? '—'}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </AsyncContent>
      </SectionCard>
    </div>
  );
}
