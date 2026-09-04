import { Controller } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import type { CreateGamePayload, DeleteGamePayload, GameListEntry, GameWriteResult, UpdateGamePayload } from '@hyveon/shared';
import { ConfigService } from '../services/ConfigService.js';
import { EcsService } from '../services/EcsService.js';
import { GamesWriteService } from '../services/GamesWriteService.js';
import { DeploymentConfigService } from '../services/DeploymentConfigService.js';
import { computeDriftFromOutputs } from '../services/DriftService.js';
import { GameWizardDraftService } from '../services/GameWizardDraftService.js';
import type { GameWizardDraft, StoredGameWizardDraft } from '../services/ElectronStoreService.js';
import { mergeGameLists } from '../services/mergeGameLists.js';
import { logger } from '../logger.js';

/**
 * IPC-only game-server controller. Handles Electron main-process messages via
 * `@MessagePattern` / `@Payload`. It
 * delegates to the {@link ConfigService}, {@link EcsService},
 * {@link DeploymentConfigService}, {@link GamesWriteService}, and
 * {@link GameWizardDraftService} providers.
 */
@Controller()
export class GamesController {
  constructor(
    private readonly config: ConfigService,
    private readonly ecs: EcsService,
    private readonly deploymentConfig: DeploymentConfigService,
    private readonly gamesWrite: GamesWriteService,
    private readonly gameWizardDraft: GameWizardDraftService,
  ) {}

  /**
   * Lists games merged from the declared view (the `deployment-config.json`
   * `gameServers` map, via {@link DeploymentConfigService}), the deployed view
   * (the deployed stack's `gameNames` output, via {@link ConfigService}), and
   * per-game drift findings (computed via {@link computeDriftFromOutputs}) —
   * see {@link mergeGameLists}. This surfaces games that are declared but not
   * yet applied (`declared: true, deployed: false`), games whose declared
   * config has diverged from what's deployed (`drift.kind === 'config_drift'`),
   * alongside live in-sync games, so the renderer can distinguish all three
   * states instead of just presence.
   *
   * Drift is derived locally from the same `declared`/`outputs` pair fetched
   * below via the pure {@link computeDriftFromOutputs} rather than by calling
   * `DriftService.getDrift()`, which would redundantly re-fetch and
   * re-invalidate `DeploymentConfigService` (a second, racing S3 read of
   * `deployment-config.json` on every `games.list` call) and — unlike
   * `getGameServers()`/`getStackOutputs()`, which both degrade every failure
   * to a safe default — reject on internal failure, which would fail the
   * entire games list instead of just omitting drift.
   *
   * Invalidates only the `DeploymentConfigService` cache (cheap — an in-memory S3
   * object cache with its own short TTL), NOT {@link ConfigService}'s stack-
   * outputs cache. `ConfigService.getStackOutputs()` is a genuinely expensive
   * round-trip (Pulumi engine resolution, passphrase, S3 backend), and this
   * channel is called on every visit to pages that show the games list
   * (Discord config, Logs), so eagerly invalidating that cache here would pay
   * that cost far more often than a fresh deploy could plausibly have
   * happened. The stack-outputs cache is invalidated on write instead — when
   * `PulumiService.apply`/`.destroy` persists a successful run, or when
   * `GamesWriteService.successResult()` applies a games.create/update/delete
   * change — not on every read here.
   *
   */
  @MessagePattern('games.list')
  async listGames(): Promise<{ games: GameListEntry[] }> {
    logger.debug('GamesController: games.list invoked');
    this.deploymentConfig.invalidateCache();
    const [declared, outputs] = await Promise.all([this.deploymentConfig.getGameServers(), this.config.getStackOutputs()]);
    const driftReport = computeDriftFromOutputs(declared, outputs);
    return { games: mergeGameLists(declared, outputs?.gameNames ?? [], driftReport.entries) };
  }

  /**
   * Returns the current ECS status of every game in parallel.
   *
   * Invalidates only the `DeploymentConfigService` cache, NOT {@link ConfigService}'s
   * stack-outputs cache — this channel backs the dashboard's 20-second
   * status poller (`GAME_STATUS_INTERVAL_MS`), so eagerly invalidating a
   * cache that now fronts an expensive Pulumi round-trip would turn an idle
   * dashboard into a steady stream of engine-resolution + S3 calls. See
   * {@link listGames}'s doc comment for the full rationale — identical here.
   *
   */
  @MessagePattern('games.status')
  async listStatus() {
    logger.debug('GamesController: games.status invoked');
    this.deploymentConfig.invalidateCache();
    const outputs = await this.config.getStackOutputs();
    if (!outputs) return [];
    return Promise.all(outputs.gameNames.map((g) => this.ecs.getStatus(g)));
  }

  /**
   * Returns status for a single game. Does not invalidate the
   * DeploymentConfigService cache (kept cheap for frequent polling).
   *
   */
  @MessagePattern('games.getStatus')
  getStatus(@Payload() game: string) {
    logger.debug('GamesController: games.getStatus invoked', { game });
    return this.ecs.getStatus(game);
  }

  /**
   * Launches the `{game}-server` task via `ecs.run_task()`. There is no
   * long-running ECS Service by design — this is the only way a game starts.
   *
   */
  @MessagePattern('games.start')
  start(@Payload() game: string) {
    logger.debug('GamesController: games.start invoked', { game });
    return this.ecs.start(game);
  }

  /**
   * Stops the running task for `game`. Triggers the EventBridge → update-dns
   * Lambda path that deletes the Route 53 record.
   *
   */
  @MessagePattern('games.stop')
  stop(@Payload() game: string) {
    logger.debug('GamesController: games.stop invoked', { game });
    return this.ecs.stop(game);
  }

  /**
   * Adds a brand-new `game_servers` entry. Delegates entirely to
   * {@link GamesWriteService.createGame} and returns its `GameWriteResult`
   * verbatim — never throws, since `ipcMain.handle` strips custom error
   * properties during serialization and the renderer needs the full
   * discriminated union (including `code` and `issues`/etags) to react
   * correctly.
   *
   */
  @MessagePattern('games.create')
  createGame(@Payload() payload: CreateGamePayload): Promise<GameWriteResult> {
    logger.debug('GamesController: games.create invoked', { game: payload.name });
    return this.gamesWrite.createGame(payload);
  }

  /**
   * Replaces an existing `game_servers` entry's value in place. Delegates
   * entirely to {@link GamesWriteService.updateGame} and returns its
   * `GameWriteResult` verbatim — never throws, for the same
   * serialization-safety reason as {@link createGame}.
   *
   */
  @MessagePattern('games.update')
  updateGame(@Payload() payload: UpdateGamePayload): Promise<GameWriteResult> {
    logger.debug('GamesController: games.update invoked', { game: payload.name });
    return this.gamesWrite.updateGame(payload);
  }

  /**
   * Removes a `game_servers` entry. Delegates entirely to
   * {@link GamesWriteService.deleteGame} and returns its `GameWriteResult`
   * verbatim — never throws, for the same serialization-safety reason as
   * {@link createGame}.
   *
   */
  @MessagePattern('games.delete')
  deleteGame(@Payload() payload: DeleteGamePayload): Promise<GameWriteResult> {
    logger.debug('GamesController: games.delete invoked', { game: payload.name });
    return this.gamesWrite.deleteGame(payload);
  }

  /**
   * Returns the saved add-game wizard draft, if any.
   *
   */
  @MessagePattern('games.draft.get')
  getDraft(): StoredGameWizardDraft | null {
    logger.debug('GamesController: games.draft.get invoked');
    return this.gameWizardDraft.get();
  }

  /**
   * Saves the current add-game wizard draft and step index.
   *
   */
  @MessagePattern('games.draft.save')
  saveDraft(@Payload() payload: { draft: GameWizardDraft; stepIndex: number }): void {
    logger.debug('GamesController: games.draft.save invoked');
    this.gameWizardDraft.save(payload.draft, payload.stepIndex);
  }

  /**
   * Updates only the `stepIndex` of an already-saved add-game wizard draft,
   * leaving its stored fields (including secret-shaped ones) untouched.
   *
   */
  @MessagePattern('games.draft.updateStepIndex')
  updateDraftStepIndex(@Payload() payload: { stepIndex: number }): void {
    logger.debug('GamesController: games.draft.updateStepIndex invoked');
    this.gameWizardDraft.updateStepIndex(payload.stepIndex);
  }

  /**
   * Clears the saved add-game wizard draft.
   *
   */
  @MessagePattern('games.draft.clear')
  clearDraft(): void {
    logger.debug('GamesController: games.draft.clear invoked');
    this.gameWizardDraft.clear();
  }
}
