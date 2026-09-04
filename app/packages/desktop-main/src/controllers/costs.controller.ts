import { Controller } from '@nestjs/common';
import { MessagePattern } from '@nestjs/microservices';
import { ConfigService } from '../services/ConfigService.js';
import { CostService } from '../services/CostService.js';
import { EcsService } from '../services/EcsService.js';
import { logger } from '../logger.js';

/**
 * Cost endpoints for the Electron main-process host. Every handler is bound to
 * an IPC channel via `@MessagePattern`. It delegates to the {@link ConfigService}, {@link CostService}, and
 * {@link EcsService} providers. The app makes no AWS Cost Explorer API
 * calls — see `openspec/changes/remove-cost-explorer-calls`.
 */
@Controller()
export class CostsController {
  constructor(
    private readonly config: ConfigService,
    private readonly costs: CostService,
    private readonly ecs: EcsService,
  ) {}

  /**
   * Estimates the hourly Fargate cost of each game from its task definition's
   * CPU/memory, plus the sum-if-everything-were-running. Reads the game list
   * from tfstate; falls back to `2048 cpu / 8192 MiB` if the task definition
   * can't be resolved. Returns zeros when tfstate is missing.
   */
  @MessagePattern('costs.estimate')
  async estimate() {
    logger.debug('CostsController: costs.estimate invoked');
    const outputs = await this.config.getStackOutputs();
    if (!outputs) {
      return { games: {}, totalPerHourIfAllOn: 0 };
    }

    const estimates: Record<string, ReturnType<CostService['estimateForSpec']>> = {};
    for (const game of outputs.gameNames) {
      const td = await this.ecs.getTaskDefinition(game);
      estimates[game] = this.costs.estimateForSpec(td?.cpu ?? 2048, td?.memory ?? 8192);
    }

    const totalPerHourIfAllOn = Object.values(estimates).reduce((sum, e) => sum + e.costPerHour, 0);

    return {
      games: estimates,
      totalPerHourIfAllOn: Math.round(totalPerHourIfAllOn * 10000) / 10000,
    };
  }
}
