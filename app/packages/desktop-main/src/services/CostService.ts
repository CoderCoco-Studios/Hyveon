import { Injectable } from '@nestjs/common';
import { estimateFargateHourlyCost, fargateHourlyCostRaw, type GameEstimate } from '@hyveon/shared';

// @spec RT-TASK-COST-001
/**
 * Produces the numbers that back the Costs page: static Fargate estimates
 * derived from each game's task-definition CPU/memory. The app makes no AWS
 * Cost Explorer API calls.
 */
@Injectable()
export class CostService {
  // @spec RT-TASK-COST-007
  /**
   * Translate a Fargate task's raw `cpu` (1024 = 1 vCPU) and `memory` (MiB)
   * into projected dollar costs. Pure arithmetic — no AWS calls — so it's
   * safe to run in a tight loop over every game.
   */
  estimateForSpec(cpuUnits: number, memoryMib: number): GameEstimate {
    const hourly = fargateHourlyCostRaw(cpuUnits, memoryMib);
    return {
      vcpu: cpuUnits / 1024,
      memoryGb: memoryMib / 1024,
      costPerHour: estimateFargateHourlyCost(cpuUnits, memoryMib),
      costPerDay24h: Math.round(hourly * 24 * 100) / 100,
      costPerMonth4hpd: Math.round(hourly * 4 * 30 * 100) / 100,
    };
  }
}
