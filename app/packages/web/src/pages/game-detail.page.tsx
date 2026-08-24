import { useEffect, useState } from 'react';
import { Pencil } from 'lucide-react';
import { useParams } from 'react-router-dom';
import { api, type GameListEntry, type GameWriteSuccess } from '../api.service.js';
import { GameStatusBadges } from '../components/game-status-badges.component.js';
import { EditGameForm } from '../components/edit-game-form/edit-game-form.component.js';
import { PageHeader } from '../components/page-header.component.js';
import { RemoveGameButton } from '../components/remove-game-button.component.js';
import { PollingIndicator } from '../polling/polling-indicator.component.js';
import { Button } from '@/components/ui/button.component';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card.component';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table.component';

/** A single labeled field in the "Container" overview grid. */
function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[0.65rem] uppercase tracking-wider text-[var(--color-muted-foreground)] mb-1">
        {label}
      </div>
      <div className="text-sm text-[var(--color-foreground)]">{value}</div>
    </div>
  );
}

/**
 * Game detail route (`/games/:name`) — read-only rendering of the full
 * declared configuration for a single game, sourced from the same merged
 * `games.list` payload the `/games` list page uses (see issue #93).
 *
 * Three renderable states, keyed off the merged `GameListEntry` for
 * `:name`:
 *   - Not found — `:name` doesn't match any entry in the merged list
 *     (neither declared nor deployed). Shows a "no such game" message.
 *   - Ghost — entry exists (`deployed: true`) but has no `config`, i.e. the
 *     game is still live in AWS but has no entry in the JSON configuration
 *     object anymore. Only the header + drift chip render; there is no
 *     declared configuration to show.
 *   - Fully declared — `config` is present. Renders every declared field:
 *     image, CPU/memory, HTTPS flag, ports, volumes, environment variables
 *     (if any), file seeds (collapsed, if any), and the connect message (if
 *     set).
 *
 * Fully-declared entries also get an "Edit" toggle and a {@link
 * RemoveGameButton} (#100) in the header — both are hidden for ghost entries
 * since there's no declared configuration to edit or remove. Toggling "Edit"
 * swaps the read-only cards for a prefilled {@link EditGameForm}; a
 * successful save (`onSaved`) replaces the in-memory merged games list with
 * the server's fresh response and switches back to the read-only view, so
 * the edited fields are visible immediately without a full refetch.
 */
export function GameDetailPage() {
  const { name } = useParams<{ name: string }>();
  const [games, setGames] = useState<GameListEntry[] | null>(null);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void api
      .games()
      .then((res) => {
        if (!cancelled) setGames(res.games);
      })
      .catch(() => {
        if (!cancelled) setGames([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const entry = games?.find((g) => g.name === name);
  const config = entry?.config;

  /** Applies a successful `EditGameForm` save and returns to the read-only view. */
  function handleSaved(result: GameWriteSuccess) {
    setGames(result.games);
    setEditing(false);
  }

  return (
    <div className="max-w-4xl mx-auto">
      <div className="mb-6">
        <PageHeader title={name} titleClassName="capitalize" backTo="/games" backLabel="Back to games">
          <PollingIndicator />
        </PageHeader>
      </div>

      {games === null ? (
        <p className="text-sm text-[var(--color-muted-foreground)]">Loading…</p>
      ) : !entry ? (
        <Card>
          <CardContent className="py-8 text-center text-sm text-[var(--color-muted-foreground)]">
            No game named <span className="font-[var(--font-mono)]">&quot;{name}&quot;</span> was found.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-6">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle className="capitalize">{entry.name}</CardTitle>
              <div className="flex items-center gap-2">
                <GameStatusBadges declared={entry.declared} deployed={entry.deployed} drift={entry.drift} />
                {config && (editing ? (
                  <Button type="button" variant="outline" size="sm" onClick={() => setEditing(false)}>
                    Cancel
                  </Button>
                ) : (
                  <>
                    <Button type="button" variant="outline" size="sm" onClick={() => setEditing(true)}>
                      <Pencil />
                      Edit
                    </Button>
                    <RemoveGameButton game={entry.name} />
                  </>
                ))}
              </div>
            </CardHeader>
            {!config && (
              <CardContent>
                <p className="text-sm text-[var(--color-muted-foreground)]">
                  This game is deployed but has no entry in the configuration object — there is no declared
                  configuration to show.
                </p>
              </CardContent>
            )}
          </Card>

          {config && editing && <EditGameForm key={config.name} game={config} onSaved={handleSaved} />}

          {config && !editing && (
            <>
              {/* Container overview */}
              <Card>
                <CardHeader>
                  <CardTitle>Container</CardTitle>
                </CardHeader>
                <CardContent className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
                  <Field label="Image" value={config.image} />
                  <Field label="CPU" value={String(config.cpu)} />
                  <Field label="Memory" value={String(config.memory)} />
                  <Field label="HTTPS" value={config.https ? 'Enabled' : 'Disabled'} />
                </CardContent>
              </Card>

              {/* Ports */}
              <Card>
                <CardHeader>
                  <CardTitle>Ports</CardTitle>
                </CardHeader>
                <CardContent>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Container port</TableHead>
                        <TableHead>Protocol</TableHead>
                        <TableHead>Visibility</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {config.ports.map((port) => (
                        <TableRow key={`${port.container}-${port.protocol}`}>
                          <TableCell className="font-[var(--font-mono)]">{port.container}</TableCell>
                          <TableCell className="uppercase">{port.protocol}</TableCell>
                          <TableCell>{port.visibility === 'internal' ? 'VPC-only' : 'Public'}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>

              {/* Volumes */}
              <Card>
                <CardHeader>
                  <CardTitle>Volumes</CardTitle>
                </CardHeader>
                <CardContent>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Name</TableHead>
                        <TableHead>Container path</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {config.volumes.map((volume) => (
                        <TableRow key={volume.name}>
                          <TableCell>{volume.name}</TableCell>
                          <TableCell className="font-[var(--font-mono)]">{volume.container_path}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>

              {/* Environment variables (optional) */}
              {config.environment && config.environment.length > 0 && (
                <Card>
                  <CardHeader>
                    <CardTitle>Environment variables</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Name</TableHead>
                          <TableHead>Value</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {config.environment.map((env) => (
                          <TableRow key={env.name}>
                            <TableCell className="font-[var(--font-mono)]">{env.name}</TableCell>
                            <TableCell className="font-[var(--font-mono)]">{env.value}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </CardContent>
                </Card>
              )}

              {/* File seeds (optional, collapsed) */}
              {config.file_seeds && config.file_seeds.length > 0 && (
                <Card>
                  <CardHeader>
                    <CardTitle>File seeds</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <details>
                      <summary className="cursor-pointer text-sm text-[var(--color-foreground)]">
                        {config.file_seeds.length} file{config.file_seeds.length === 1 ? '' : 's'} seeded at task start
                      </summary>
                      <ul className="mt-3 space-y-1">
                        {config.file_seeds.map((seed) => (
                          <li key={seed.path} className="font-[var(--font-mono)] text-xs text-[var(--color-muted-foreground)]">
                            {seed.path}
                            {seed.mode ? ` (mode ${seed.mode})` : ''}
                          </li>
                        ))}
                      </ul>
                    </details>
                  </CardContent>
                </Card>
              )}

              {/* Connect message (optional) */}
              {config.connect_message && (
                <Card>
                  <CardHeader>
                    <CardTitle>Connect message</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-sm text-[var(--color-foreground)] whitespace-pre-wrap">
                      {config.connect_message}
                    </p>
                  </CardContent>
                </Card>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
