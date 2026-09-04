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
   * Lists games merged from the declared view, the deployed view, and
   * per-game drift — see {@link mergeGameLists}.
   *
   * Drift is computed locally via the pure {@link computeDriftFromOutputs}
   * against the `declared`/`outputs` pair already fetched below, rather than
   * calling `DriftService.getDrift()`, which would redundantly re-fetch and
   * re-invalidate `DeploymentConfigService` — a second, racing S3 read of
   * `deployment-config.json` on every `games.list` call.
   *
   * Invalidates only the `DeploymentConfigService` cache (cheap, in-memory,
   * short TTL) — NOT {@link ConfigService}'s stack-outputs cache. That cache
   * is a genuinely expensive round-trip (Pulumi engine resolution,
   * passphrase, S3 backend), and this is a hot read path (Discord config,
   * Logs pages), so eagerly invalidating it here would pay that cost far
   * more often than a fresh deploy could plausibly have happened; it's
   * invalidated on write instead (`PulumiService.apply`/`.destroy`,
   * `GamesWriteService.successResult()`).
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
