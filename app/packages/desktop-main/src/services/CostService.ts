import { Injectable } from '@nestjs/common';
import { FARGATE_VCPU_PER_HOUR, FARGATE_GB_PER_HOUR } from '@hyveon/cloud-aws';

/** Per-game Fargate cost projection derived from its CPU/memory spec. */
export interface GameEstimate {
  vcpu: number;
  memoryGb: number;
  costPerHour: number;
  costPerDay24h: number;
  costPerMonth4hpd: number;
}

/** Aggregate of per-game estimates plus the cost if every game were running simultaneously. */
export interface CostEstimates {
  games: Record<string, GameEstimate>;
  totalPerHourIfAllOn: number;
}

/**
 * Produces the numbers that back the Costs page: static Fargate estimates
 * derived from each game's task-definition CPU/memory. The app makes no AWS
 * Cost Explorer API calls — see `openspec/changes/remove-cost-explorer-calls`.
 */
@Injectable()
export class CostService {
  /**
   * Translate a Fargate task's raw `cpu` (1024 = 1 vCPU) and `memory` (MiB)
   * into projected dollar costs. Pure arithmetic — no AWS calls — so it's
   * safe to run in a tight loop over every game.
   */
  estimateForSpec(cpuUnits: number, memoryMib: number): GameEstimate {
    const vcpu = cpuUnits / 1024;
    const memGb = memoryMib / 1024;
    const hourly = vcpu * FARGATE_VCPU_PER_HOUR + memGb * FARGATE_GB_PER_HOUR;
    return {
      vcpu,
      memoryGb: memGb,
      costPerHour: Math.round(hourly * 10000) / 10000,
      costPerDay24h: Math.round(hourly * 24 * 100) / 100,
      costPerMonth4hpd: Math.round(hourly * 4 * 30 * 100) / 100,
    };
  }
}
